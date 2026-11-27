import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable } from "@agboss/core";
import { LedgerSnapshotRepository } from "../repositories/ledger-snapshot.repository.js";
import type {
  LedgerArtifactRow,
  LedgerEventRow,
  LedgerSnapshot,
  WorkerStallRow,
} from "../schemas/release-ledger.schema.js";
import { StallMode } from "./worker-stall.service.js";

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
const STAGE_EFFECT = "FENCED_EFFECT:stage-module-artifact";

/**
 * The eight invariants of a recovered release, read from the ledger's SQLite file alone: the
 * artifacts, the candidate locks, the stall drill's mark and the evidence timeline (the ledger's
 * own events and the lease events the `LeaseEvidenceObserver` copies from the framework's audit log).
 */
@Injectable()
export class ReleaseInvariantVerifierService {
  static async verifyFromFile(params: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
    readonly releaseId?: string;
    readonly expectedModules?: readonly string[];
    /** False for a run without the stall drill: invariants 7 and 8 are about it and are left out. */
    readonly takeoverDrill?: boolean;
  }): Promise<InvariantVerificationReport> {
    const releaseId = params.releaseId ?? "rel-2026.10.0";
    const expected = [...(params.expectedModules ?? DEFAULT_MODULES)].sort();
    if (!existsSync(params.sqlitePath)) {
      throw new Error(`SQLite database not found at ${params.sqlitePath}`);
    }
    const snap = await LedgerSnapshotRepository.readFromFile({ ...params, releaseId });
    return ReleaseInvariantVerifierService.verifySnapshot(snap, releaseId, expected, params.takeoverDrill ?? true);
  }

  static verifySnapshot(
    snap: LedgerSnapshot,
    releaseId: string,
    expected: readonly string[],
    takeoverDrill = true,
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
      ...(takeoverDrill ? checkZombieFencingAndTakeover(snap, promoted) : []),
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
    lockStatus: lock1?.status ?? "MISSING", compensatedArtifacts: compArts.length, compensationEvents: compEvents.length,
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

/** What the evidence timeline says about the stalled execution's leases, per instance. */
interface StallEvidence {
  readonly takeover: LedgerEventRow | undefined;
  readonly refusedAtWrite: LedgerEventRow | undefined;
  readonly handedOver: LedgerEventRow | undefined;
  readonly replacementWrite: LedgerEventRow | undefined;
}

function evidenceOf(snap: LedgerSnapshot, stall: WorkerStallRow): StallEvidence {
  const own = snap.events.filter((e) => e.executionId === stall.executionId);
  const byStalled = own.filter((e) => e.instanceId === stall.stalledInstanceId);
  return {
    takeover: own.find((e) => e.operation === "LEASE_TAKEOVER" && e.instanceId !== stall.stalledInstanceId),
    refusedAtWrite: byStalled.find((e) => e.operation === STAGE_EFFECT && e.outcome === "refused"),
    handedOver: byStalled.find((e) => e.operation === "STEP_HANDED_OVER"),
    replacementWrite: own.find(
      (e) => e.operation === STAGE_EFFECT && e.outcome === "ran" && e.instanceId !== stall.stalledInstanceId,
    ),
  };
}

function checkZombieFencingAndTakeover(
  snap: LedgerSnapshot, promoted: readonly LedgerArtifactRow[],
): readonly [InvariantCheckResult, InvariantCheckResult] {
  const stall = snap.stalls.find((s) => s.attemptNumber === 2);
  const evidence = stall === undefined ? undefined : evidenceOf(snap, stall);
  const hardCrash = stall?.mode === StallMode.CrashProcess;
  const rec = promoted.find((a) => a.logicalTaskId === stall?.logicalTaskId);
  const replacementToken = evidence?.replacementWrite?.fencingToken ?? null;
  const takeoverToken = evidence?.takeover?.fencingToken ?? null;
  // the takeover event names whoever took the lease over (a child's own lease is first taken over by the
  // instance that reclaims it, then claimed by the worker that runs it, at a higher token): the instance
  // that resumed the task is the one whose fenced write ran under the replacement token

  // a zombie that woke is refused at its protected write (layer 1: the fenced effect) or stopped by the
  // lease's own fence before it got there (layer 2: the hand-over); one that died never writes at all
  const zombieFenced = hardCrash
    ? evidence?.refusedAtWrite === undefined && evidence?.handedOver === undefined
    : evidence?.refusedAtWrite !== undefined || evidence?.handedOver !== undefined;
  const staleWriteCommitted = stall !== undefined && promoted.some(
    (a) => a.logicalTaskId === stall.logicalTaskId && a.committedByInstanceId === stall.stalledInstanceId,
  );
  const inv7Ok = stall !== undefined && evidence?.takeover !== undefined && zombieFenced && !staleWriteCommitted &&
    (takeoverToken ?? 0) >= 2;
  const inv8Ok = stall !== undefined && rec !== undefined && evidence?.takeover !== undefined &&
    rec.executionId === stall.executionId && rec.preparedByInstanceId === stall.stalledInstanceId &&
    rec.committedByInstanceId !== rec.preparedByInstanceId &&
    evidence.replacementWrite !== undefined && rec.committedByInstanceId === evidence.replacementWrite.instanceId &&
    (replacementToken ?? 0) >= 2;

  return [
    check(7, "INV-7-ZOMBIE-WORKER-FENCED", "Zombie worker fenced: its lease was taken over at a higher fencing token and its stale write never committed", inv7Ok, {
      stallMode: stall?.mode ?? null,
      stalledInstanceId: stall?.stalledInstanceId ?? null,
      executionId: stall?.executionId ?? null,
      takeoverFencingToken: takeoverToken,
      layer1RefusedAtFencedWrite: evidence?.refusedAtWrite !== undefined,
      layer1ObservedToken: evidence?.refusedAtWrite === undefined ? null : evidence.refusedAtWrite.details,
      layer2StepHandedOver: evidence?.handedOver?.outcome ?? null,
      staleWriteCommitted,
    }),
    check(8, "INV-8-ORIGINAL-LOGICAL-TASK-COMPLETED-AFTER-TAKEOVER", "Original child execution resumed from its checkpoint on the replacement worker and committed once", inv8Ok, {
      logicalTaskId: stall?.logicalTaskId ?? null,
      preservedExecutionId: rec?.executionId ?? null,
      preparedBy: rec?.preparedByInstanceId ?? null,
      takenOverBy: rec?.committedByInstanceId ?? null,
      replacementFencingToken: replacementToken,
      replacementWriterMatchesCommitter: evidence?.replacementWrite?.instanceId === rec?.committedByInstanceId,
    }),
  ];
}
