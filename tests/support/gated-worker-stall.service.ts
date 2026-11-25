import { ApplicationContext, Clock, Injectable } from "@agboss/core";
import { WorkerStallRepository } from "../../src/repositories/worker-stall.repository.js";
import { StallMode, WorkerStallService } from "../../src/services/worker-stall.service.js";

/** What a test holds of the frozen worker: it entered its stall, and it is let go. */
export const stallGate = (() => {
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  let reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    /** Resolves when a worker reached the drill's step and froze. */
    reached: (): Promise<void> => reached,
    /** Called by the frozen worker's step; resolves when the test lets it go. */
    hold: (): Promise<void> => {
      entered();
      return held;
    },
    /** Lets the frozen worker's step run on (the zombie wakes). */
    letGo: (): void => {
      release();
    },
    reset: (): void => {
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
})();

/**
 * The stall drill in a test: the first worker to reach the staging step is marked as stalled by the
 * real service (the same `worker_stalls` row) and then waits on `stallGate` — a process frozen
 * inside its step, as `SIGSTOP` would freeze it — until the test lets it go.
 */
@Injectable({ deps: [Clock, ApplicationContext, WorkerStallRepository] })
export class GatedWorkerStallService extends WorkerStallService {
  override mode(): StallMode {
    return StallMode.FreezeProcess;
  }

  protected override freeze(): Promise<void> {
    return stallGate.hold();
  }
}
