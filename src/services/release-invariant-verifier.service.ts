import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable } from "@agboss/core";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import type { LedgerArtifactRow, LedgerSnapshot } from "../schemas/release-ledger.schema.js";

export interface InvariantCheckResult {
  readonly id: string;
  readonly number: number;
  readonly description: string;
  readonly status: "VERIFIED" | "FAILED";
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface InvariantVerificationReport {
  readonly releaseId: string;
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly allVerified: boolean;
  readonly checks: readonly InvariantCheckResult[];
}

const DEFAULT_MODULES = ["auth-service", "payment-engine", "telemetry-collector"] as const;

@Injectable()
export class ReleaseInvariantVerifierService {
  static async verifyFromFile(params: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
    readonly releaseId?: string;
    readonly expectedModules?: readonly string[];
  }): Promise<InvariantVerificationReport> {
    const releaseId = params.releaseId ?? "rel-2026.10.0";
    const expected = [...(params.expectedModules ?? DEFAULT_MODULES)].sort();
    if (!existsSync(params.sqlitePath)) {
      throw new Error(`SQLite database not found at ${params.sqlitePath}`);
    }
    const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
      sqlitePath: params.sqlitePath,
      artifactDir: params.artifactDir,
      releaseId,
    });
    return ReleaseInvariantVerifierService.verifySnapshot(snap, releaseId, expected);
  }

  static verifySnapshot(
    snap: LedgerSnapshot,
    releaseId: string,
    expected: readonly string[],
  ): InvariantVerificationReport {
    const promoted = snap.artifacts.filter((a) => a.attemptNumber === 2 && a.status === "PROMOTED");
    const attempt1 = snap.artifacts.filter((a) => a.attemptNumber === 1);
    const checks: InvariantCheckResult[] = [
      checkModulesCompleted(promoted, expected),
      checkFinalArtifactsExist(snap, promoted, expected),
      checkNoFailedAttemptActive(snap.artifactDir, releaseId, attempt1, expected),
      checkSagaCompensations(snap, attempt1, expected),
      checkNoDuplicateCommits(snap.artifacts, promoted, expected),
      checkMultiInstanceParticipation(snap.artifacts),
      ...checkZombieFencingAndTakeover(snap, promoted),
    ];
    return {
      releaseId,
      sqlitePath: snap.sqlitePath,
      artifactDir: snap.artifactDir,
      allVerified: checks.every((c) => c.status === "VERIFIED"),
      checks,
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
  snap: LedgerSnapshot, promoted: readonly LedgerArtifactRow[], expected: readonly string[],
): InvariantCheckResult {
  const manifestPath = snap.candidateLocks.find((l) => l.attemptNumber === 2)?.manifestPath ?? null;
  const manifestExists = manifestPath !== null && existsSync(manifestPath);
  const manifestCount =
    manifestExists && manifestPath !== null
      ? ((JSON.parse(readFileSync(manifestPath, "utf8")) as { modules?: unknown[] }).modules?.length ?? 0)
      : 0;
  const filesExist = promoted.length === expected.length && promoted.every((a) => existsSync(a.artifactPath));
  return check(2, "INV-2-FINAL-ARTIFACTS-EXIST", "Required final artifacts exist", manifestExists && manifestCount === expected.length && filesExist, {
    releaseManifestPath: manifestPath, manifestCount,
  });
}

function checkNoFailedAttemptActive(
  artifactDir: string, releaseId: string, attempt1: readonly LedgerArtifactRow[], expected: readonly string[],
): InvariantCheckResult {
  const activeDb = attempt1.filter((a) => a.status === "STAGED" || a.status === "PROMOTED");
  const stagingDir = resolve(artifactDir, "staging", releaseId, "attempt-1");
  const remainingFiles = expected.filter((m) => existsSync(resolve(stagingDir, `${m}.artifact.json`)));
  const ok = attempt1.length === expected.length && activeDb.length === 0 && remainingFiles.length === 0;
  return check(3, "INV-3-NO-FAILED-ATTEMPT-ARTIFACTS-ACTIVE", "No artifacts from the failed attempt remain active", ok, {
    attempt1Recorded: attempt1.length, activeInDb: activeDb.length, remainingFiles,
  });
}

function checkSagaCompensations(
  snap: LedgerSnapshot, attempt1: readonly LedgerArtifactRow[], expected: readonly string[],
): InvariantCheckResult {
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
  for (const a of all) {
    if (a.status === "STAGED" || a.status === "PROMOTED") {
      const k = `a${String(a.attemptNumber)}:${a.logicalTaskId}`;
      activeCounts.set(k, (activeCounts.get(k) ?? 0) + 1);
    }
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
  snap: LedgerSnapshot, promoted: readonly LedgerArtifactRow[],
): readonly [InvariantCheckResult, InvariantCheckResult] {
  const stall = snap.events.find((e) => e.operation === "WORKER_STALLED_LEASE_EXPIRED");
  const zombieRej = snap.events.find((e) => e.operation === "ZOMBIE_WRITE_REJECTED");
  const runtimeFence = snap.events.find((e) => e.operation === "RUNTIME_LEASE_FENCED");
  const takeover = snap.events.find((e) => e.operation === "LEASE_TAKEOVER_COMPLETED");

  const agbossLease = snap.executionLeases.find((l) => l.rootExecutionId === stall?.executionId);
  const childCps = stall === undefined ? [] : snap.checkpoints.filter(
    (c) => c.threadId === stall.executionId || c.threadId.endsWith(`/child/${stall.executionId}`),
  );
  const linearCpChain = childCps.length >= 4 && new Set(childCps.map((c) => c.parentCheckpointId ?? "__root__")).size === childCps.length;
  const leaseFenced = agbossLease !== undefined && agbossLease.leaseEpoch >= 2 && agbossLease.holderInstanceId !== stall?.instanceId && agbossLease.released === 1;
  const orphanedQueue = snap.childQueue.filter((q) => q.executionId === stall?.executionId && q.status !== "finished");

  const expectHardCrash = process.env["AGBOSS_CRASH_WORKER_ON_STALL"] === "true";
  const zombieFenced = expectHardCrash
    ? zombieRej === undefined
    : zombieRej !== undefined && runtimeFence !== undefined && stall?.instanceId === zombieRej.instanceId;
  const inv7Ok = stall !== undefined && stall.leaseEpoch === 1 && zombieFenced && leaseFenced && linearCpChain;
  const rec = promoted.find((a) => a.logicalTaskId === stall?.logicalTaskId);
  const inv8Ok = stall !== undefined && takeover !== undefined && rec !== undefined &&
    rec.executionId === stall.executionId && rec.preparedByInstanceId === stall.instanceId &&
    rec.committedByInstanceId !== rec.preparedByInstanceId && rec.leaseEpoch >= 2 &&
    agbossLease?.holderInstanceId === rec.committedByInstanceId && agbossLease.leaseEpoch === rec.leaseEpoch && orphanedQueue.length === 0;

  return [
    check(7, "INV-7-ZOMBIE-WORKER-FENCED", "Zombie worker fenced at both external ledger and AGBoss LeasedCheckpointSaver/execution_leases tables", inv7Ok, {
      stalledInstanceId: stall?.instanceId ?? null, executionId: stall?.executionId ?? null,
      agbossExecutionLeaseEpoch: agbossLease?.leaseEpoch ?? null, agbossExecutionLeaseHolder: agbossLease?.holderInstanceId ?? null,
      agbossExecutionLeaseReleased: agbossLease?.released ?? null, agbossCheckpointCount: childCps.length,
      agbossLinearCheckpointChainNoZombieFork: linearCpChain,
    }),
    check(8, "INV-8-ORIGINAL-LOGICAL-TASK-COMPLETED-AFTER-TAKEOVER", "Original child execution recovered on replacement instance and verified in AGBoss execution_leases & child_execution_queue", inv8Ok, {
      logicalTaskId: stall?.logicalTaskId ?? null, preservedExecutionId: rec?.executionId ?? null,
      preparedBy: rec?.preparedByInstanceId ?? null, takenOverBy: rec?.committedByInstanceId ?? null,
      committedLeaseEpoch: rec?.leaseEpoch ?? null, agbossLeaseHolderMatchesCommitter: agbossLease?.holderInstanceId === rec?.committedByInstanceId,
      orphanedChildQueueRows: orphanedQueue.length,
    }),
  ];
}
