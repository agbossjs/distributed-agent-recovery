import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable } from "@agboss/core";
import { StaleLeaseFenceError } from "../errors/stale-lease-fence.error.js";
import type { AgbossCheckpointRow } from "../schemas/agboss-cluster.schema.js";
import type {
  LedgerArtifactRow, LedgerEventRow, LedgerSnapshot, NonAttemptStallDisposition,
  ProtectedWriteRejectionEvidence, StaleWriteRejectionReason, StallDisposition,
} from "../schemas/release-ledger.schema.js";

function parseJsonRecord(raw: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>) : null;
  } catch { return null; }
}

function readJsonFileRecord(filePath: string): Readonly<Record<string, unknown>> | null {
  if (!existsSync(filePath)) return null;
  try { return parseJsonRecord(readFileSync(filePath, "utf8")); } catch { return null; }
}

function verifyDiskRecordMatchesArtifact(
  disk: Readonly<Record<string, unknown>> | null, art: LedgerArtifactRow, label: string,
): string[] {
  if (disk === null) return [`${label} missing or unreadable at ${art.artifactPath}`];
  const checks: readonly [string, unknown][] = [
    ["artifactId", art.artifactId], ["releaseId", art.releaseId], ["version", art.version],
    ["attemptNumber", art.attemptNumber], ["logicalTaskId", art.logicalTaskId], ["moduleName", art.moduleName],
    ["executionId", art.executionId], ["preparedByInstanceId", art.preparedByInstanceId],
    ["committedByInstanceId", art.committedByInstanceId], ["leaseEpoch", art.leaseEpoch],
    ["idempotencyKey", art.idempotencyKey], ["candidateDigest", art.candidateDigest],
  ];
  return checks.flatMap(([f, v]) => (disk[f] === v ? [] : [`${label} field ${f} mismatch (${String(disk[f])} !== ${String(v)})`]));
}

@Injectable()
export class ProtectedWriteEvidenceService {
  static verifyArtifactOnDisk(snap: LedgerSnapshot, art: LedgerArtifactRow): readonly string[] {
    const issues = verifyDiskRecordMatchesArtifact(readJsonFileRecord(art.artifactPath), art, "Protected artifact");
    const stagingPath = resolve(snap.artifactDir, "staging", art.releaseId, `attempt-${String(art.attemptNumber)}`, `${art.moduleName}.artifact.json`);
    if (stagingPath !== art.artifactPath && existsSync(stagingPath)) {
      issues.push(...verifyDiskRecordMatchesArtifact(readJsonFileRecord(stagingPath), art, "Staged artifact"));
    }
    const lock = snap.candidateLocks.find((l) => l.attemptNumber === art.attemptNumber);
    if (art.status === "PROMOTED" && lock?.manifestPath !== null && lock?.manifestPath !== undefined && existsSync(lock.manifestPath)) {
      const manifest = readJsonFileRecord(lock.manifestPath);
      const modules = Array.isArray(manifest?.["modules"]) ? (manifest["modules"] as Readonly<Record<string, unknown>>[]) : [];
      const entry = modules.find((m) => m["logicalTaskId"] === art.logicalTaskId);
      if (
        entry === undefined || entry["artifactId"] !== art.artifactId || entry["committedByInstanceId"] !== art.committedByInstanceId ||
        entry["leaseEpoch"] !== art.leaseEpoch || entry["idempotencyKey"] !== art.idempotencyKey
      ) {
        issues.push(`Release manifest module entry mismatch for ${art.logicalTaskId}`);
      }
    }
    return issues;
  }

  static verifyCheckpointChain(snap: LedgerSnapshot, executionId: string): {
    readonly checkpoints: readonly AgbossCheckpointRow[]; readonly linear: boolean; readonly issues: readonly string[];
  } {
    if (snap.checkpoints.length === 0) return { checkpoints: [], linear: true, issues: [] };
    const cps = snap.checkpoints.filter((c) => c.threadId === executionId || c.threadId.endsWith(`/child/${executionId}`));
    const cpIds = new Set(cps.map((c) => c.checkpointId));
    const threads = new Set(cps.map((c) => c.threadId));
    const uniqueParents = new Set(cps.map((c) => c.parentCheckpointId ?? "__root__"));
    const roots = cps.filter((c) => c.parentCheckpointId === null);
    const connected = cps.every((c) => c.parentCheckpointId === null || cpIds.has(c.parentCheckpointId));
    const linear = cps.length >= 4 && threads.size === 1 && uniqueParents.size === cps.length && roots.length === 1 && connected;
    return { checkpoints: cps, linear, issues: linear ? [] : [`Invalid or branched checkpoint chain for ${executionId}`] };
  }

  static parseStallDisposition(
    stallEvent: LedgerEventRow, childCps: readonly AgbossCheckpointRow[], art: LedgerArtifactRow,
  ): { readonly disposition: StallDisposition | null; readonly issues: readonly string[] } {
    const d = parseJsonRecord(stallEvent.details);
    const disp = d?.["stallDisposition"];
    const valid = disp === "RESUME_AND_ATTEMPT_WRITE" || disp === "TERMINATED_BEFORE_WRITE" || disp === "SUSPENDED_BEFORE_WRITE";
    if (d === null || !valid) return { disposition: null, issues: ["Missing or invalid stallDisposition on stall event"] };
    const issues: string[] = [];
    if (d["targetArtifactId"] !== art.artifactId) issues.push("Stall event targetArtifactId does not match final artifact");
    const cpId = d["capturedCheckpointId"];
    if (childCps.length > 0 && (typeof cpId !== "string" || !childCps.some((c) => c.checkpointId === cpId))) {
      issues.push("Stall event capturedCheckpointId cannot be correlated to checkpoints table");
    }
    return { disposition: disp, issues };
  }

  static resolvePeerProcessHalt(
    snap: LedgerSnapshot, art: LedgerArtifactRow, prepareEventId: number | undefined,
  ): NonAttemptStallDisposition | null {
    if (prepareEventId === undefined || snap.stalls === undefined) return null;
    const peerRow = snap.stalls.find(
      (s) => s.releaseId === art.releaseId && s.attemptNumber === art.attemptNumber &&
        s.stalledInstanceId === art.preparedByInstanceId &&
        (s.status === "TERMINATED_BEFORE_WRITE" || s.status === "SUSPENDED_BEFORE_WRITE"),
    );
    if (peerRow === undefined) return null;
    const peerEvent = snap.events.find(
      (e) => e.executionId === peerRow.executionId && e.instanceId === art.preparedByInstanceId && e.operation === "WORKER_STALLED_LEASE_EXPIRED",
    );
    const d = peerEvent === undefined ? null : parseJsonRecord(peerEvent.details);
    const disp = d?.["stallDisposition"];
    const wholeProcessHalted =
      disp === "TERMINATED_BEFORE_WRITE" || (disp === "SUSPENDED_BEFORE_WRITE" && d?.["naturalWallClockExpiry"] === true);
    if (peerEvent === undefined || !wholeProcessHalted || disp !== peerRow.status || prepareEventId >= peerEvent.eventId) return null;
    return snap.events.some((e) => e.instanceId === art.preparedByInstanceId && e.eventId > peerEvent.eventId) ? null : disp;
  }

  static parseRejectionEvidence(
    rej: LedgerEventRow, art: LedgerArtifactRow, childCps: readonly AgbossCheckpointRow[], stageEvent: LedgerEventRow | undefined,
  ): { readonly evidence: ProtectedWriteRejectionEvidence | null; readonly issues: readonly string[] } {
    const d = parseJsonRecord(rej.details);
    if (d === null) return { evidence: null, issues: ["Malformed JSON details on ZOMBIE_WRITE_REJECTED"] };
    const cap = parseJsonRecord(JSON.stringify(d["capturedToken"] ?? null));
    const obs = parseJsonRecord(JSON.stringify(d["observedToken"] ?? null));
    const reason = d["rejectionReason"];
    const issues = [...validateRejectionHeaderAndTokens(rej, art, d, cap, obs, reason), ...validateRejectionCheckpointLink(d, childCps, stageEvent)];
    if (issues.length > 0 || cap === null || obs === null) return { evidence: null, issues };
    return {
      evidence: {
        attemptedOperation: "STAGE_ARTIFACT", targetArtifactId: String(d["targetArtifactId"]),
        targetStagingArtifactPath: String(d["targetStagingArtifactPath"]), candidateDigest: String(d["candidateDigest"]),
        workerInstanceId: String(d["workerInstanceId"]), executionId: String(d["executionId"]),
        releaseId: String(d["releaseId"]), attemptNumber: Number(d["attemptNumber"]),
        logicalTaskId: String(d["logicalTaskId"]), moduleName: String(d["moduleName"]), idempotencyKey: String(d["idempotencyKey"]),
        capturedToken: { holderInstanceId: String(cap["holderInstanceId"]), leaseEpoch: Number(cap["leaseEpoch"]) },
        observedToken: { holderInstanceId: String(obs["holderInstanceId"]), leaseEpoch: Number(obs["leaseEpoch"]) },
        rejectionReason: reason as StaleWriteRejectionReason, errorCode: String(d["errorCode"]),
        capturedCheckpointId: typeof d["capturedCheckpointId"] === "string" ? d["capturedCheckpointId"] : null,
        observedHeadCheckpointId: typeof d["observedHeadCheckpointId"] === "string" ? d["observedHeadCheckpointId"] : null,
        checkpointThreadId: typeof d["checkpointThreadId"] === "string" ? d["checkpointThreadId"] : null,
        activeHolderInstanceId: String(obs["holderInstanceId"]), activeLeaseEpoch: Number(obs["leaseEpoch"]),
      },
      issues: [],
    };
  }
}

function validateRejectionHeaderAndTokens(
  rej: LedgerEventRow, art: LedgerArtifactRow, d: Readonly<Record<string, unknown>>,
  cap: Readonly<Record<string, unknown>> | null, obs: Readonly<Record<string, unknown>> | null, reason: unknown,
): string[] {
  const issues: string[] = [];
  if (rej.outcome !== "REJECTED_STALE_LEASE" || rej.executionId !== art.executionId || rej.logicalTaskId !== art.logicalTaskId || rej.idempotencyKey !== art.idempotencyKey) {
    issues.push("Rejection event row header does not correlate with committed artifact");
  }
  if (rej.instanceId !== art.preparedByInstanceId || rej.instanceId === art.committedByInstanceId || rej.leaseEpoch > art.leaseEpoch) {
    issues.push("Rejection event worker identity or epoch inconsistent with ownership takeover");
  }
  if (
    d["attemptedOperation"] !== "STAGE_ARTIFACT" || d["targetArtifactId"] !== art.artifactId ||
    typeof d["targetStagingArtifactPath"] !== "string" || d["targetStagingArtifactPath"].length === 0 ||
    typeof d["candidateDigest"] !== "string" || d["candidateDigest"].length === 0 ||
    d["workerInstanceId"] !== rej.instanceId || d["executionId"] !== art.executionId ||
    d["logicalTaskId"] !== art.logicalTaskId || d["idempotencyKey"] !== art.idempotencyKey || d["errorCode"] !== StaleLeaseFenceError.code
  ) {
    issues.push("Rejection structured payload missing operation, target artifact, or correlation identifiers");
  }
  const capHolder = cap?.["holderInstanceId"];
  const capEpoch = cap?.["leaseEpoch"];
  const obsHolder = obs?.["holderInstanceId"];
  const obsEpoch = obs?.["leaseEpoch"];
  if (capHolder !== rej.instanceId || capEpoch !== rej.leaseEpoch || obsHolder !== art.committedByInstanceId || typeof obsEpoch !== "number" || obsEpoch < art.leaseEpoch) {
    issues.push("Rejection capturedToken/observedToken mismatch against stale worker and committed owner");
  } else if (reason === "STALE_LEASE_EPOCH" ? Number(capEpoch) >= obsEpoch : reason !== "LEASE_HOLDER_MISMATCH" || capHolder === obsHolder || Number(capEpoch) !== obsEpoch) {
    issues.push(`Rejection reason ${String(reason)} inconsistent with captured vs observed token`);
  }
  return issues;
}

function validateRejectionCheckpointLink(
  d: Readonly<Record<string, unknown>>, childCps: readonly AgbossCheckpointRow[], stageEvent: LedgerEventRow | undefined,
): string[] {
  if (childCps.length === 0) return [];
  const issues: string[] = [];
  const capCp = d["capturedCheckpointId"];
  const obsCp = d["observedHeadCheckpointId"];
  if (typeof capCp !== "string" || !childCps.some((c) => c.checkpointId === capCp) || d["checkpointThreadId"] !== childCps[0]?.threadId) {
    issues.push("Rejection capturedCheckpointId/checkpointThreadId cannot be correlated to checkpoints table");
  }
  if (obsCp !== null && obsCp !== undefined && (typeof obsCp !== "string" || !childCps.some((c) => c.checkpointId === obsCp))) {
    issues.push("Rejection observedHeadCheckpointId not found in checkpoints table");
  }
  const stageDetails = stageEvent === undefined ? null : parseJsonRecord(stageEvent.details);
  if (stageDetails?.["capturedCheckpointId"] !== undefined && stageDetails["capturedCheckpointId"] !== capCp) {
    issues.push("Replacement commit checkpoint does not match stale worker Step 1 checkpoint");
  }
  return issues;
}
