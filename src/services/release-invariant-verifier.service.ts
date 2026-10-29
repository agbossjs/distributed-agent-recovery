import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable } from "@agboss/core";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import type {
  LedgerArtifactRow, LedgerSnapshot, ProtectedWriteVerificationSummary, TaskProtectedWriteVerification,
} from "../schemas/release-ledger.schema.js";
import { ProtectedWriteVerifierService } from "./protected-write-verifier.service.js";

export interface InvariantCheckResult {
  readonly id: string; readonly number: number; readonly description: string;
  readonly status: "VERIFIED" | "FAILED"; readonly evidence: Readonly<Record<string, unknown>>;
}

export interface InvariantVerificationOptions {
  readonly expectLeaseTakeover?: boolean; readonly requireStaleWriteRejection?: boolean; readonly targetAttemptNumber?: number;
}

export interface InvariantVerificationReport {
  readonly releaseId: string;
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly allVerified: boolean;
  readonly protectedWriteVerification: ProtectedWriteVerificationSummary;
  readonly checks: readonly InvariantCheckResult[];
}

const DEFAULT_MODULES = ["auth-service", "payment-engine", "telemetry-collector"] as const;

@Injectable()
export class ReleaseInvariantVerifierService {
  static async verifyFromFile(params: InvariantVerificationOptions & {
    readonly sqlitePath: string; readonly artifactDir: string;
    readonly releaseId?: string; readonly expectedModules?: readonly string[];
  }): Promise<InvariantVerificationReport> {
    const releaseId = params.releaseId ?? "rel-2026.10.0";
    const expected = [...(params.expectedModules ?? DEFAULT_MODULES)].sort();
    if (!existsSync(params.sqlitePath)) throw new Error(`SQLite database not found at ${params.sqlitePath}`);
    const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
      sqlitePath: params.sqlitePath, artifactDir: params.artifactDir, releaseId,
    });
    return ReleaseInvariantVerifierService.verifySnapshot(snap, releaseId, expected, params);
  }

  static verifySnapshot(
    snap: LedgerSnapshot, releaseId: string, expected: readonly string[], options: InvariantVerificationOptions = {},
  ): InvariantVerificationReport {
    const targetAttempt = options.targetAttemptNumber ?? 2;
    const promoted = snap.artifacts.filter((a) => a.attemptNumber === targetAttempt && a.status === "PROMOTED");
    const attempt1 = snap.artifacts.filter((a) => a.attemptNumber === 1);
    const pwSummary = ProtectedWriteVerifierService.verifyAttempt(snap, {
      releaseId, attemptNumber: targetAttempt, expectedModules: expected,
    });
    const checks: InvariantCheckResult[] = [
      checkModulesCompleted(promoted, expected),
      checkFinalArtifactsExist(snap, promoted, expected, targetAttempt),
      checkNoFailedAttemptActive(snap.artifactDir, releaseId, attempt1, expected, targetAttempt),
      checkSagaCompensations(snap, attempt1, expected, targetAttempt),
      checkNoDuplicateCommits(snap.artifacts, promoted, expected),
      checkMultiInstanceParticipation(snap.artifacts),
      ...checkZombieFencingAndTakeover(pwSummary, options),
    ];
    return {
      releaseId, sqlitePath: snap.sqlitePath, artifactDir: snap.artifactDir,
      allVerified: checks.every((c) => c.status === "VERIFIED"),
      protectedWriteVerification: pwSummary, checks,
    };
  }
}

function check(
  number: number, id: string, description: string, ok: boolean, evidence: Readonly<Record<string, unknown>>,
): InvariantCheckResult {
  return { id, number, description, status: ok ? "VERIFIED" : "FAILED", evidence };
}

function checkModulesCompleted(promoted: readonly LedgerArtifactRow[], expected: readonly string[]): InvariantCheckResult {
  const names = promoted.map((a) => a.moduleName).sort();
  const ok = names.length === expected.length && names.every((m, i) => m === expected[i]);
  return check(1, "INV-1-ALL-MODULES-COMPLETED", "Every expected module was completed", ok, { expected, promoted: names });
}

function checkFinalArtifactsExist(
  snap: LedgerSnapshot, promoted: readonly LedgerArtifactRow[], expected: readonly string[], targetAttempt: number,
): InvariantCheckResult {
  const manifestPath = snap.candidateLocks.find((l) => l.attemptNumber === targetAttempt)?.manifestPath ?? null;
  const manifestExists = manifestPath !== null && existsSync(manifestPath);
  const manifestCount = manifestExists && manifestPath !== null
    ? ((JSON.parse(readFileSync(manifestPath, "utf8")) as { modules?: unknown[] }).modules?.length ?? 0)
    : 0;
  const filesExist = promoted.length === expected.length && promoted.every((a) => existsSync(a.artifactPath));
  return check(2, "INV-2-FINAL-ARTIFACTS-EXIST", "Required final artifacts exist", manifestExists && manifestCount === expected.length && filesExist, {
    releaseManifestPath: manifestPath, manifestCount,
  });
}

function checkNoFailedAttemptActive(
  artifactDir: string, releaseId: string, attempt1: readonly LedgerArtifactRow[], expected: readonly string[], targetAttempt: number,
): InvariantCheckResult {
  if (targetAttempt === 1) return check(3, "INV-3-NO-FAILED-ATTEMPT-ARTIFACTS-ACTIVE", "Single-attempt run has no prior failed attempt artifacts", true, { singleAttemptRun: true });
  const activeDb = attempt1.filter((a) => a.status === "STAGED" || a.status === "PROMOTED");
  const stagingDir = resolve(artifactDir, "staging", releaseId, "attempt-1");
  const remainingFiles = expected.filter((m) => existsSync(resolve(stagingDir, `${m}.artifact.json`)));
  const ok = attempt1.length === expected.length && activeDb.length === 0 && remainingFiles.length === 0;
  return check(3, "INV-3-NO-FAILED-ATTEMPT-ARTIFACTS-ACTIVE", "No artifacts from the failed attempt remain active", ok, {
    attempt1Recorded: attempt1.length, activeInDb: activeDb.length, remainingFiles,
  });
}

function checkSagaCompensations(
  snap: LedgerSnapshot, attempt1: readonly LedgerArtifactRow[], expected: readonly string[], targetAttempt: number,
): InvariantCheckResult {
  if (targetAttempt === 1) return check(4, "INV-4-SAGA-COMPENSATIONS-RECORDED-AND-APPLIED", "Single-attempt run required no prior saga compensation", true, { singleAttemptRun: true });
  const lock1 = snap.candidateLocks.find((l) => l.attemptNumber === 1);
  const compArts = attempt1.filter((a) => a.status === "COMPENSATED" && a.compensatedByKey !== null);
  const compEvents = snap.events.filter((e) => e.attemptNumber === 1 && e.outcome === "COMPENSATED");
  const ok = lock1?.status === "COMPENSATED" && compArts.length === expected.length && compEvents.length === expected.length + 1;
  return check(4, "INV-4-SAGA-COMPENSATIONS-RECORDED-AND-APPLIED", "Compensations were actually recorded and applied", ok, {
    lockStatus: lock1?.status ?? "MISSING", compensatedArtifacts: compArts.length,
  });
}

function checkNoDuplicateCommits(
  all: readonly LedgerArtifactRow[], promoted: readonly LedgerArtifactRow[], expected: readonly string[],
): InvariantCheckResult {
  const activeCounts = new Map<string, number>();
  for (const a of all.filter((r) => r.status === "STAGED" || r.status === "PROMOTED")) {
    const k = `a${String(a.attemptNumber)}:${a.logicalTaskId}`;
    activeCounts.set(k, (activeCounts.get(k) ?? 0) + 1);
  }
  const dupes = [...activeCounts.entries()].filter(([, cnt]) => cnt > 1);
  const uniqueKeys = new Set(all.map((a) => a.idempotencyKey));
  const ok = dupes.length === 0 && uniqueKeys.size === all.length && promoted.length === expected.length;
  return check(5, "INV-5-NO-DUPLICATE-EXTERNAL-COMMITS", "No duplicate externally committed logical operation exists", ok, {
    totalRows: all.length, uniqueIdempotencyKeys: uniqueKeys.size, duplicates: dupes,
  });
}

function checkMultiInstanceParticipation(all: readonly LedgerArtifactRow[]): InvariantCheckResult {
  const instances = [...new Set(all.flatMap((a) => [a.preparedByInstanceId, a.committedByInstanceId]))];
  return check(6, "INV-6-MULTI-INSTANCE-PARTICIPATION", "At least two distinct instances participated in distributed execution", instances.length >= 2, {
    distinctWorkerCount: instances.length, workerInstanceIds: instances,
  });
}

function checkZombieFencingAndTakeover(
  pw: ProtectedWriteVerificationSummary, options: InvariantVerificationOptions,
): readonly [InvariantCheckResult, InvariantCheckResult] {
  const expectTakeover = options.expectLeaseTakeover !== false;
  const requireRejection = options.requireStaleWriteRejection === true;
  const focal: TaskProtectedWriteVerification | undefined =
    pw.tasks.find((t) => t.outcome === "MISSING_OR_INCONSISTENT_EVIDENCE") ??
    pw.tasks.find((t) => t.outcome === "STALE_WRITE_REJECTED") ??
    pw.tasks.find((t) => t.outcome !== "VALID_OWNER_ACCEPTED") ?? pw.tasks[0];
  const inv7Ok =
    pw.outcome === "STALE_WRITE_REJECTED" ||
    (pw.outcome === "STALE_WRITE_NOT_ATTEMPTED" && !requireRejection) ||
    (pw.outcome === "VALID_OWNER_ACCEPTED" && !expectTakeover && !requireRejection);
  const inv7Desc =
    pw.outcome === "STALE_WRITE_REJECTED"
      ? "Stale worker attempted protected write after lease loss and was explicitly rejected at both external ledger and AGBoss LeasedCheckpointSaver boundaries"
      : pw.outcome === "STALE_WRITE_NOT_ATTEMPTED"
        ? "Stale worker never reached the protected-write boundary after lease loss; takeover succeeded with no fabricated rejection event (fencing rejection not demonstrated)"
        : pw.outcome === "VALID_OWNER_ACCEPTED"
          ? "Valid lease owners completed all protected writes with no lease loss and no false stale-write rejection"
          : "Protected-write fencing evidence is missing, inconsistent, or cannot be correlated with checkpoints and final artifacts";
  const inv8Ok =
    pw.inconsistentTaskCount === 0 &&
    (expectTakeover
      ? focal !== undefined && (focal.outcome === "STALE_WRITE_REJECTED" || focal.outcome === "STALE_WRITE_NOT_ATTEMPTED")
      : pw.outcome === "VALID_OWNER_ACCEPTED");
  return [
    check(7, "INV-7-ZOMBIE-WORKER-FENCED", inv7Desc, inv7Ok, {
      protectedWriteOutcome: pw.outcome, fencingRejectionDemonstrated: pw.fencingRejectionDemonstrated,
      nonAttemptDisposition: focal?.nonAttemptDisposition ?? null, stalledInstanceId: focal?.preparedByInstanceId ?? null,
      executionId: focal?.executionId ?? null, attemptedOperation: focal?.rejectionEvidence?.attemptedOperation ?? null,
      rejectionReason: focal?.rejectionEvidence?.rejectionReason ?? null, capturedToken: focal?.rejectionEvidence?.capturedToken ?? null,
      observedToken: focal?.rejectionEvidence?.observedToken ?? null, capturedCheckpointId: focal?.rejectionEvidence?.capturedCheckpointId ?? null,
      targetArtifactId: focal?.rejectionEvidence?.targetArtifactId ?? focal?.artifactId ?? null,
      protectedArtifactVerifiedOnDisk: focal?.protectedArtifactVerifiedOnDisk ?? false,
      agbossExecutionLeaseEpoch: focal?.agbossExecutionLeaseEpoch ?? null, agbossExecutionLeaseHolder: focal?.agbossExecutionLeaseHolder ?? null,
      agbossExecutionLeaseReleased: focal?.agbossExecutionLeaseReleased ?? null, agbossCheckpointCount: focal?.checkpointCount ?? 0,
      agbossLinearCheckpointChainNoZombieFork: focal?.linearCheckpointChain ?? false, issues: focal?.issues ?? [],
    }),
    check(8, "INV-8-ORIGINAL-LOGICAL-TASK-COMPLETED-AFTER-TAKEOVER", "Original child execution recovered on replacement instance and verified in AGBoss execution_leases & child_execution_queue", inv8Ok, {
      logicalTaskId: focal?.logicalTaskId ?? null, preservedExecutionId: focal?.executionId ?? null,
      preparedBy: focal?.preparedByInstanceId ?? null, takenOverBy: focal?.committedByInstanceId ?? null,
      committedLeaseEpoch: focal?.committedLeaseEpoch ?? null,
      agbossLeaseHolderMatchesCommitter: focal !== undefined && focal.agbossExecutionLeaseHolder === focal.committedByInstanceId,
      orphanedChildQueueRows: focal?.orphanedChildQueueRows ?? 0,
    }),
  ];
}
