import { existsSync } from "node:fs";
import { Injectable } from "@agboss/core";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import type {
  LedgerArtifactRow, LedgerSnapshot, NonAttemptStallDisposition, ProtectedWriteOutcome,
  ProtectedWriteRejectionEvidence, ProtectedWriteVerificationSummary, TaskProtectedWriteVerification,
} from "../schemas/release-ledger.schema.js";
import { ProtectedWriteEvidenceService } from "./protected-write-evidence.service.js";

export type { ProtectedWriteOutcome, ProtectedWriteVerificationSummary, TaskProtectedWriteVerification };

function resolveLogicalTaskId(releaseId: string, moduleName: string): string {
  return moduleName.startsWith("task-") ? moduleName : `${releaseId}:${moduleName}`;
}

@Injectable()
export class ProtectedWriteVerifierService {
  static async verifyFromFile(params: {
    readonly sqlitePath: string; readonly artifactDir: string;
    readonly releaseId?: string; readonly attemptNumber?: number; readonly expectedModules?: readonly string[];
  }): Promise<ProtectedWriteVerificationSummary> {
    if (!existsSync(params.sqlitePath)) throw new Error(`SQLite database not found at ${params.sqlitePath}`);
    const releaseId = params.releaseId ?? "rel-2026.10.0";
    const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
      sqlitePath: params.sqlitePath, artifactDir: params.artifactDir, releaseId,
    });
    const attemptNumber = params.attemptNumber ?? snap.artifacts.reduce((m, a) => Math.max(m, a.attemptNumber), 1);
    const expectedModules = params.expectedModules ?? [...new Set(
      snap.artifacts.filter((a) => a.attemptNumber === attemptNumber).map((a) => a.moduleName),
    )].sort();
    return ProtectedWriteVerifierService.verifyAttempt(snap, { releaseId, attemptNumber, expectedModules });
  }

  static verifyAttempt(
    snap: LedgerSnapshot,
    params: { readonly releaseId: string; readonly attemptNumber: number; readonly expectedModules: readonly string[] },
  ): ProtectedWriteVerificationSummary {
    const modules = [...params.expectedModules].sort();
    const expectedTaskIds = new Set(modules.map((m) => resolveLogicalTaskId(params.releaseId, m)));
    const hasOrphanFenceEvents = snap.events.some(
      (e) =>
        e.attemptNumber === params.attemptNumber &&
        (e.operation === "ZOMBIE_WRITE_REJECTED" || e.operation === "WORKER_STALLED_LEASE_EXPIRED") &&
        !expectedTaskIds.has(e.logicalTaskId),
    );
    const tasks = modules.map((m) => verifySingleTask(snap, params.releaseId, params.attemptNumber, m, hasOrphanFenceEvents));
    const rejected = tasks.filter((t) => t.outcome === "STALE_WRITE_REJECTED").length;
    const unattempted = tasks.filter((t) => t.outcome === "STALE_WRITE_NOT_ATTEMPTED").length;
    const valid = tasks.filter((t) => t.outcome === "VALID_OWNER_ACCEPTED").length;
    const inconsistent = tasks.filter((t) => t.outcome === "MISSING_OR_INCONSISTENT_EVIDENCE").length;
    const outcome: ProtectedWriteOutcome =
      tasks.length === 0 || inconsistent > 0
        ? "MISSING_OR_INCONSISTENT_EVIDENCE"
        : rejected > 0 ? "STALE_WRITE_REJECTED" : unattempted > 0 ? "STALE_WRITE_NOT_ATTEMPTED" : "VALID_OWNER_ACCEPTED";
    return {
      releaseId: params.releaseId, attemptNumber: params.attemptNumber, outcome,
      fencingRejectionDemonstrated: outcome === "STALE_WRITE_REJECTED",
      rejectedStaleWriteCount: rejected, unattemptedStaleWorkerCount: unattempted,
      validOwnerAcceptedCount: valid, inconsistentTaskCount: inconsistent, tasks,
    };
  }
}

function verifySingleTask(
  snap: LedgerSnapshot, releaseId: string, attemptNumber: number, moduleName: string, hasOrphanFenceEvents: boolean,
): TaskProtectedWriteVerification {
  const logicalTaskId = resolveLogicalTaskId(releaseId, moduleName);
  const active = snap.artifacts.filter(
    (a) => a.releaseId === releaseId && a.attemptNumber === attemptNumber && a.logicalTaskId === logicalTaskId && (a.status === "STAGED" || a.status === "PROMOTED"),
  );
  const art = active[0];
  if (active.length !== 1 || art === undefined) {
    return buildFailedTask(logicalTaskId, moduleName, [`Expected 1 active artifact for ${logicalTaskId}, found ${String(active.length)}`]);
  }
  const diskIssues = ProtectedWriteEvidenceService.verifyArtifactOnDisk(snap, art);
  const cpCheck = ProtectedWriteEvidenceService.verifyCheckpointChain(snap, art.executionId);
  const agbossLease = snap.executionLeases.find((l) => l.rootExecutionId === art.executionId);
  const orphanedQueue = snap.childQueue.filter((q) => q.executionId === art.executionId && q.status !== "finished").length;
  const issues: string[] = [...diskIssues, ...cpCheck.issues];
  if (hasOrphanFenceEvents) issues.push("Uncorrelated stall or rejection events exist outside expected logical tasks");
  issues.push(...verifyCommonLedgerState(snap, art, agbossLease, orphanedQueue));

  const cl = classifyTaskEvents(snap, art, cpCheck.checkpoints, issues);
  return {
    logicalTaskId, moduleName, executionId: art.executionId, artifactId: art.artifactId,
    preparedByInstanceId: art.preparedByInstanceId, committedByInstanceId: art.committedByInstanceId,
    committedLeaseEpoch: art.leaseEpoch, checkpointCount: cpCheck.checkpoints.length, linearCheckpointChain: cpCheck.linear,
    agbossExecutionLeaseEpoch: agbossLease?.leaseEpoch ?? null, agbossExecutionLeaseHolder: agbossLease?.holderInstanceId ?? null,
    agbossExecutionLeaseReleased: agbossLease?.released ?? null, orphanedChildQueueRows: orphanedQueue,
    outcome: cl.outcome, fencingRejectionDemonstrated: cl.outcome === "STALE_WRITE_REJECTED",
    protectedArtifactVerifiedOnDisk: diskIssues.length === 0, nonAttemptDisposition: cl.nonAttemptDisposition,
    rejectionEvidence: cl.rejectionEvidence, issues: cl.issues,
  };
}

function verifyCommonLedgerState(
  snap: LedgerSnapshot, art: LedgerArtifactRow,
  agbossLease: LedgerSnapshot["executionLeases"][number] | undefined, orphanedQueue: number,
): string[] {
  const issues: string[] = [];
  const token = snap.fencingTokens.find((t) => t.executionId === art.executionId);
  if (token === undefined || token.currentHolderInstanceId !== art.committedByInstanceId || token.highestLeaseEpoch !== art.leaseEpoch) {
    issues.push("fencing_tokens row missing or inconsistent with committed artifact");
  }
  if (snap.executionLeases.length > 0 && (agbossLease === undefined || agbossLease.holderInstanceId !== art.committedByInstanceId || agbossLease.leaseEpoch !== art.leaseEpoch || agbossLease.released !== 1)) {
    issues.push("AGBoss execution_leases row missing, unreleased, or inconsistent with committed artifact");
  }
  if (orphanedQueue > 0) issues.push(`Found ${String(orphanedQueue)} unfinished child_execution_queue rows`);
  return issues;
}

function classifyTaskEvents(
  snap: LedgerSnapshot, art: LedgerArtifactRow, childCps: LedgerSnapshot["checkpoints"], baseIssues: readonly string[],
): {
  readonly outcome: ProtectedWriteOutcome; readonly nonAttemptDisposition: NonAttemptStallDisposition | null;
  readonly rejectionEvidence: ProtectedWriteRejectionEvidence | null; readonly issues: readonly string[];
} {
  const issues = [...baseIssues];
  const taskEvents = snap.events.filter((e) => e.attemptNumber === art.attemptNumber && (e.logicalTaskId === art.logicalTaskId || e.executionId === art.executionId));
  if (taskEvents.some((e) => e.executionId !== art.executionId || e.logicalTaskId !== art.logicalTaskId)) {
    issues.push("Conflicting executionId/logicalTaskId across task ledger_events");
  }
  const prepares = taskEvents.filter((e) => e.operation === "PREPARE_MODULE");
  const stages = taskEvents.filter((e) => e.operation === "STAGE_ARTIFACT");
  const stalls = taskEvents.filter((e) => e.operation === "WORKER_STALLED_LEASE_EXPIRED");
  const takeovers = taskEvents.filter((e) => e.operation === "LEASE_TAKEOVER_COMPLETED");
  const rejections = taskEvents.filter((e) => e.operation === "ZOMBIE_WRITE_REJECTED");
  const runtimeFences = taskEvents.filter((e) => e.operation === "RUNTIME_LEASE_FENCED");
  const stallRows = (snap.stalls ?? []).filter((s) => s.executionId === art.executionId || (s.attemptNumber === art.attemptNumber && s.logicalTaskId === art.logicalTaskId));

  if (prepares.length !== 1 || prepares[0]?.instanceId !== art.preparedByInstanceId || prepares[0].leaseEpoch !== 1) issues.push("Missing or inconsistent PREPARE_MODULE event");
  if (stages.length !== 1 || stages[0]?.instanceId !== art.committedByInstanceId || stages[0].leaseEpoch !== art.leaseEpoch || stages[0].idempotencyKey !== art.idempotencyKey) {
    issues.push("Missing or inconsistent STAGE_ARTIFACT commit event");
  }

  const takeoverContext = art.leaseEpoch > 1 || art.preparedByInstanceId !== art.committedByInstanceId || stalls.length > 0 || stallRows.length > 0 || takeovers.length > 0 || rejections.length > 0;
  if (!takeoverContext) {
    if (runtimeFences.length > 0) issues.push("Unexpected RUNTIME_LEASE_FENCED event on valid-owner execution");
    return { outcome: issues.length === 0 ? "VALID_OWNER_ACCEPTED" : "MISSING_OR_INCONSISTENT_EVIDENCE", nonAttemptDisposition: null, rejectionEvidence: null, issues };
  }
  return classifyTakeoverTask(snap, art, childCps, prepares[0]?.eventId, stages[0], stalls, stallRows, takeovers, rejections, runtimeFences, issues);
}

function classifyTakeoverTask(
  snap: LedgerSnapshot, art: LedgerArtifactRow, childCps: LedgerSnapshot["checkpoints"], prepareEventId: number | undefined,
  stageEvent: LedgerSnapshot["events"][number] | undefined, stalls: LedgerSnapshot["events"],
  stallRows: NonNullable<LedgerSnapshot["stalls"]>, takeovers: LedgerSnapshot["events"],
  rejections: LedgerSnapshot["events"], runtimeFences: LedgerSnapshot["events"], issues: string[],
): {
  readonly outcome: ProtectedWriteOutcome; readonly nonAttemptDisposition: NonAttemptStallDisposition | null;
  readonly rejectionEvidence: ProtectedWriteRejectionEvidence | null; readonly issues: readonly string[];
} {
  if (art.leaseEpoch < 2 || art.preparedByInstanceId === art.committedByInstanceId) issues.push("Takeover context missing higher leaseEpoch or distinct committer");
  if (takeovers.length !== 1 || takeovers[0]?.instanceId !== art.committedByInstanceId || takeovers[0].leaseEpoch !== art.leaseEpoch) issues.push("Missing or inconsistent LEASE_TAKEOVER_COMPLETED event");
  const peerHalt = stalls.length === 0 && stallRows.length === 0 && rejections.length === 0 && runtimeFences.length === 0
    ? ProtectedWriteEvidenceService.resolvePeerProcessHalt(snap, art, prepareEventId)
    : null;
  if (peerHalt !== null) {
    return { outcome: issues.length === 0 ? "STALE_WRITE_NOT_ATTEMPTED" : "MISSING_OR_INCONSISTENT_EVIDENCE", nonAttemptDisposition: peerHalt, rejectionEvidence: null, issues };
  }
  if (stalls.length !== 1 || stalls[0]?.instanceId !== art.preparedByInstanceId || stalls[0].leaseEpoch !== 1) issues.push("Missing or inconsistent WORKER_STALLED_LEASE_EXPIRED event");
  if (snap.stalls === undefined || stallRows.length !== 1 || stallRows[0]?.stalledInstanceId !== art.preparedByInstanceId || stallRows[0].stalledLeaseEpoch !== 1) {
    issues.push("Missing or inconsistent fault_injection_stalls instrumentation row");
  }
  const stallInfo = stalls[0] === undefined ? { disposition: null, issues: ["Missing stall event"] } : ProtectedWriteEvidenceService.parseStallDisposition(stalls[0], childCps, art);
  issues.push(...stallInfo.issues);

  if (rejections.length > 0) {
    if (rejections.length !== 1) issues.push("Multiple ZOMBIE_WRITE_REJECTED events recorded for single stall");
    if (stallInfo.disposition !== "RESUME_AND_ATTEMPT_WRITE" || stallRows[0]?.status !== "FENCED") issues.push("Rejection event contradicts stall disposition or unfenced stall status");
    if (stalls[0] !== undefined && rejections[0] !== undefined && rejections[0].eventId <= stalls[0].eventId) issues.push("Rejection event ordered before stall event");
    if (!runtimeFences.some((e) => e.instanceId === art.preparedByInstanceId && e.leaseEpoch === 1)) issues.push("Missing correlated RUNTIME_LEASE_FENCED event for resumed zombie worker");
    const parsed = rejections[0] === undefined ? { evidence: null, issues: ["Missing rejection"] } : ProtectedWriteEvidenceService.parseRejectionEvidence(rejections[0], art, childCps, stageEvent);
    issues.push(...parsed.issues);
    return { outcome: issues.length === 0 && parsed.evidence !== null ? "STALE_WRITE_REJECTED" : "MISSING_OR_INCONSISTENT_EVIDENCE", nonAttemptDisposition: null, rejectionEvidence: parsed.evidence, issues };
  }

  const nonAttempt = stallInfo.disposition === "TERMINATED_BEFORE_WRITE" || stallInfo.disposition === "SUSPENDED_BEFORE_WRITE" ? stallInfo.disposition : null;
  if (nonAttempt === null || stallRows[0]?.status !== nonAttempt) {
    issues.push("Missing ZOMBIE_WRITE_REJECTED without explicit pre-write non-attempt instrumentation");
  }
  return { outcome: issues.length === 0 && nonAttempt !== null ? "STALE_WRITE_NOT_ATTEMPTED" : "MISSING_OR_INCONSISTENT_EVIDENCE", nonAttemptDisposition: nonAttempt, rejectionEvidence: null, issues };
}

function buildFailedTask(logicalTaskId: string, moduleName: string, issues: readonly string[]): TaskProtectedWriteVerification {
  return {
    logicalTaskId, moduleName, executionId: null, artifactId: null, preparedByInstanceId: null,
    committedByInstanceId: null, committedLeaseEpoch: null, checkpointCount: 0, linearCheckpointChain: false,
    agbossExecutionLeaseEpoch: null, agbossExecutionLeaseHolder: null, agbossExecutionLeaseReleased: null,
    orphanedChildQueueRows: 0, outcome: "MISSING_OR_INCONSISTENT_EVIDENCE", fencingRejectionDemonstrated: false,
    protectedArtifactVerifiedOnDisk: false, nonAttemptDisposition: null, rejectionEvidence: null, issues,
  };
}
