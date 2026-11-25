import { spawnSync } from "node:child_process";
import { ApplicationContext, Clock, Injectable } from "@agboss/core";
import { WorkerStallRepository } from "../repositories/worker-stall.repository.js";

/** How the drill takes a worker out of the cluster, chosen by the process that runs it. */
export enum StallMode {
  /** No drill: `stall()` returns at once. */
  Off = "off",
  /** `SIGSTOP`: the process freezes inside its step, its lease runs out, `SIGCONT` wakes the zombie. */
  FreezeProcess = "os-sigstop",
  /**
   * The thread blocks for `AGBOSS_BLOCK_SECONDS` (default 90) inside the step — a stop-the-world pause
   * of the whole process, no timer runs, no lease is renewed — and wakes by itself: a zombie that
   * needs no one to send it `SIGCONT` (a container, a pod).
   */
  BlockThread = "block-thread",
  /** Exit code 137 inside the step: a worker that never comes back. */
  CrashProcess = "crash-exit-137",
}

export interface StallTarget {
  readonly executionId: string;
  readonly logicalTaskId: string;
  readonly releaseId: string;
  readonly attemptNumber: number;
}

/**
 * The stall drill (the only fault the showcase injects itself): the first worker to reach the
 * staging step of the target module freezes (or dies) inside it, after step 1 was checkpointed and
 * before the step's write. The mark it leaves tells the replacement worker, which runs the same step
 * again, not to stall a second time. Which fault is chosen by the process's environment
 * (`AGBOSS_OS_FREEZE=true`, `AGBOSS_BLOCK_WORKER_ON_STALL=true`, `AGBOSS_CRASH_WORKER_ON_STALL=true`);
 * the unit tests replace this service.
 */
@Injectable({ deps: [Clock, ApplicationContext, WorkerStallRepository] })
export class WorkerStallService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly stalls: WorkerStallRepository,
  ) {}

  mode(): StallMode {
    if (process.env["AGBOSS_CRASH_WORKER_ON_STALL"] === "true") return StallMode.CrashProcess;
    if (process.env["AGBOSS_OS_FREEZE"] === "true") return StallMode.FreezeProcess;
    if (process.env["AGBOSS_BLOCK_WORKER_ON_STALL"] === "true") return StallMode.BlockThread;
    return StallMode.Off;
  }

  async hasStalled(executionId: string): Promise<boolean> {
    return (await this.stalls.find(executionId)) !== undefined;
  }

  /** Marks the stall, then takes this worker out of the cluster. Returns when it is back (or at once when the drill is off). */
  async stall(target: StallTarget): Promise<void> {
    const mode = this.mode();
    if (mode === StallMode.Off) return;
    await this.stalls.insertIfAbsent({
      ...target,
      stalledInstanceId: this.applicationContext.instanceId,
      stalledPid: process.pid,
      mode,
      createdAt: this.clock.now().getTime(),
    });
    await this.freeze(mode);
  }

  /** What the fault does to the process; a test replaces it with a wait on a gate it holds. */
  protected freeze(mode: StallMode): Promise<void> {
    if (mode === StallMode.CrashProcess) process.exit(137);
    if (mode === StallMode.BlockThread) {
      const seconds = Number(process.env["AGBOSS_BLOCK_SECONDS"] ?? "90");
      // A synchronous child that sleeps: this thread blocks (a stop-the-world pause) without reading the clock itself.
      spawnSync(process.execPath, ["-e", `setTimeout(() => undefined, ${String(Math.round(seconds * 1000))})`], { stdio: "ignore" });
      return Promise.resolve();
    }
    process.kill(process.pid, "SIGSTOP");
    return Promise.resolve();
  }
}
