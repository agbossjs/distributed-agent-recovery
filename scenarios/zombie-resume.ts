import { LedgerSnapshotRepository } from "../src/repositories/ledger-snapshot.repository.js";
import type { LedgerSnapshot, WorkerStallRow } from "../src/schemas/release-ledger.schema.js";
import { StallMode } from "../src/services/worker-stall.service.js";

export interface ZombieOutcome {
  readonly stalledInstanceId: string;
  readonly stalledPid: number;
  readonly mode: string;
  readonly resumedWithSigcont: boolean;
  /** What the stalled worker did after it woke: refused at its write, handed over, or nothing seen in time. */
  readonly observed: "refused-at-write" | "handed-over" | "none";
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function stallOf(snapshot: LedgerSnapshot): WorkerStallRow | undefined {
  return snapshot.stalls.find((row) => row.attemptNumber === 2);
}

function observedOf(snapshot: LedgerSnapshot, stall: WorkerStallRow): ZombieOutcome["observed"] {
  const own = snapshot.events.filter(
    (event) => event.executionId === stall.executionId && event.instanceId === stall.stalledInstanceId,
  );
  if (own.some((event) => event.operation === "FENCED_EFFECT:stage-module-artifact" && event.outcome === "refused")) {
    return "refused-at-write";
  }
  return own.some((event) => event.operation === "STEP_HANDED_OVER") ? "handed-over" : "none";
}

/**
 * After the replacement worker committed the module: wakes the frozen worker (`SIGCONT`, a process of
 * this machine) and waits until the ledger shows what the zombie did — its stale write refused, or
 * its step handed over. A thread-blocked zombie wakes on its own; a crashed one never does.
 */
export async function wakeZombieAndAwaitFence(params: {
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly releaseId: string;
  readonly timeoutMs?: number;
}): Promise<ZombieOutcome | undefined> {
  const read = (): Promise<LedgerSnapshot> =>
    LedgerSnapshotRepository.readFromFile({ ...params, releaseId: params.releaseId });
  const stall = stallOf(await read());
  if (stall === undefined) return undefined;
  let resumed = false;
  if (stall.mode === StallMode.FreezeProcess) {
    try {
      process.kill(stall.stalledPid, "SIGCONT");
      resumed = true;
    } catch {
      // another PID namespace, or the process exited
    }
  }
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  for (;;) {
    const observed = observedOf(await read(), stall);
    if (observed !== "none" || stall.mode === StallMode.CrashProcess || Date.now() >= deadline) {
      return {
        stalledInstanceId: stall.stalledInstanceId,
        stalledPid: stall.stalledPid,
        mode: stall.mode,
        resumedWithSigcont: resumed,
        observed,
      };
    }
    await sleep(250);
  }
}
