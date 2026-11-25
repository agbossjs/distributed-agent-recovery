import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStatus, HealthStatus, createApp, type App } from "@agboss/core";
import {
  DistributedAgentRecoveryApplication,
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
  ReleaseRecoveryPlannedWorkflowFinish,
} from "../src/distributed-agent-recovery.application.js";
import type { RecoveryPlanDto } from "../src/dto/recovery-plan.dto.js";
import type { ReleaseSummaryDto } from "../src/dto/release-summary.dto.js";
import { LedgerSnapshotRepository } from "../src/repositories/ledger-snapshot.repository.js";
import type { LedgerSnapshot } from "../src/schemas/release-ledger.schema.js";
import { spawnWorkerProcess, stopWorkerProcess } from "./cluster-worker-process.js";
import { requireLiveApiKey, startOfflineOpenRouterServer } from "./offline-openrouter-fetch.js";
import { wakeZombieAndAwaitFence, type ZombieOutcome } from "./zombie-resume.js";

export interface ReleasePipelineOptions {
  readonly sqlitePath?: string;
  readonly artifactDir?: string;
  readonly keepStorageOnExit?: boolean;
  readonly liveModel?: boolean;
  /** Workers already running (containers, pods) on the same storage: none are started here. */
  readonly externalWorkers?: boolean;
  /** Two worker OS processes, one frozen by the zombie drill; else two more instances in this process. */
  readonly spawnClusterWorkers?: boolean;
  readonly releaseId?: string;
  readonly version?: string;
}

export interface ReleasePipelineReport {
  readonly mode: "live-openrouter" | "deterministic-offline";
  readonly clockMode: "real-30s-clock";
  readonly faultMode: "os-sigstop-natural-lease-expiry" | "thread-block-natural-lease-expiry" | "process-crash-exit-137" | "none";
  readonly workerTopology: "multi-process" | "in-process-cluster";
  readonly takeoverDrill: boolean;
  readonly workerPids: readonly number[];
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly health: {
    readonly livenessStatus: string;
    readonly readinessStatus: string;
    readonly healthCheckComponents: readonly string[];
  };
  readonly attempt1: {
    readonly executionId: string;
    readonly status: string;
    readonly finish: string;
    readonly toolCallsCount: number;
    readonly compensationsCount: number;
    readonly llmSpend: {
      readonly calls: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalUsd: number;
      readonly servedBy: readonly string[];
    };
    readonly recoveryPlan: RecoveryPlanDto;
  };
  readonly attempt2: {
    readonly executionId: string;
    readonly status: string;
    readonly finish: string;
    readonly releaseSummary: ReleaseSummaryDto;
  };
  readonly zombie: ZombieOutcome | undefined;
  readonly ledger: LedgerSnapshot;
}

const MODULES = "auth-service,payment-engine,telemetry-collector";

/** Which fault the worker processes inject, by the drill's environment flags. */
function faultModeOf(env: NodeJS.ProcessEnv): ReleasePipelineReport["faultMode"] {
  if (env["AGBOSS_CRASH_WORKER_ON_STALL"] === "true") return "process-crash-exit-137";
  if (env["AGBOSS_BLOCK_WORKER_ON_STALL"] === "true") return "thread-block-natural-lease-expiry";
  if (env["AGBOSS_OS_FREEZE"] === "true") return "os-sigstop-natural-lease-expiry";
  return "none";
}

export async function runReleaseRecoveryPipeline(
  options: ReleasePipelineOptions = {},
): Promise<ReleasePipelineReport> {
  const tempRoot =
    options.sqlitePath === undefined && options.artifactDir === undefined
      ? mkdtempSync(join(tmpdir(), "agboss-release-recovery-"))
      : undefined;
  const sqlitePath = options.sqlitePath ?? join(tempRoot ?? tmpdir(), "cluster-state.sqlite");
  const artifactDir = options.artifactDir ?? join(tempRoot ?? tmpdir(), "artifacts");
  const releaseId = options.releaseId ?? "rel-2026.10.0";
  const version = options.version ?? "2.4.0";
  const isLive = options.liveModel === true;
  const spawnWorkers = options.spawnClusterWorkers === true;
  const useExternal = options.externalWorkers === true || spawnWorkers;

  // a drill needs workers that are processes of their own: a frozen worker must not freeze the demo
  const workerFaultEnv: NodeJS.ProcessEnv =
    useExternal && process.env["AGBOSS_CRASH_WORKER_ON_STALL"] !== "true" && process.env["AGBOSS_BLOCK_WORKER_ON_STALL"] !== "true"
      ? { AGBOSS_OS_FREEZE: process.env["AGBOSS_OS_FREEZE"] === "false" ? "false" : "true" }
      : {};
  const faultMode = faultModeOf({ ...process.env, ...workerFaultEnv });
  const takeoverDrill = useExternal && faultMode !== "none";

  const offlineModel = isLive ? undefined : await startOfflineOpenRouterServer();
  const apiKey = isLive ? requireLiveApiKey() : "offline-test-openrouter-api-key";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SQLITE_PATH: sqlitePath,
    ARTIFACT_DIR: artifactDir,
    OPENROUTER_API_KEY: apiKey,
    IDEMPOTENCY_KEY: process.env["IDEMPOTENCY_KEY"] ?? "distributed-agent-recovery-offline-idempotency-key",
    ...(offlineModel === undefined ? {} : { OPENROUTER_BASE_URL: offlineModel.baseUrl }),
  };
  // an application instance reads its settings from the process when it starts
  Object.assign(process.env, baseEnv);

  const startNode = (): Promise<App<DistributedAgentRecoveryApplication>> =>
    createApp(DistributedAgentRecoveryApplication);

  const coordinator = await startNode();
  const spawnedWorkers = spawnWorkers
    ? [await spawnWorkerProcess({ ...baseEnv, ...workerFaultEnv }), await spawnWorkerProcess({ ...baseEnv, ...workerFaultEnv })]
    : [];
  const inProcessWorkers: App<DistributedAgentRecoveryApplication>[] = [];
  if (!useExternal) {
    inProcessWorkers.push(await startNode(), await startNode());
  }

  try {
    const liveness = await coordinator.checkLiveness();
    const readiness = await coordinator.checkReadiness();
    if (liveness.status !== HealthStatus.Healthy || readiness.status !== HealthStatus.Healthy) {
      throw new Error(`Cluster health failed: liveness=${liveness.status}, readiness=${readiness.status}`);
    }

    const attempt1Result = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
      releaseId,
      version,
      attemptNumber: 1,
      modules: MODULES,
      buildFlags: "--opt-level=3 --deterministic",
      simulateIntegrationFailure: true,
      stallTargetModule: "",
    });
    if (attempt1Result.status !== ExecutionStatus.Finished || attempt1Result.finish?.name !== "release-recovery-planned-workflow-finish") {
      throw new Error(`Attempt 1 failed: status=${attempt1Result.status}, finish=${String(attempt1Result.finish?.name)}`);
    }
    const recoveryPlan = attempt1Result.output as RecoveryPlanDto;

    const attempt2Result = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
      releaseId: recoveryPlan.releaseId,
      version: recoveryPlan.version,
      attemptNumber: recoveryPlan.nextAttemptNumber,
      modules: MODULES,
      buildFlags: recoveryPlan.correctedBuildFlags,
      simulateIntegrationFailure: false,
      stallTargetModule: takeoverDrill && recoveryPlan.enableLeaseTakeoverDrill ? "payment-engine" : "",
    });
    if (attempt2Result.status !== ExecutionStatus.Finished || attempt2Result.finish?.name !== "release-coordinator-workflow-finish") {
      throw new Error(`Attempt 2 failed: status=${attempt2Result.status}, finish=${String(attempt2Result.finish?.name)}`);
    }

    // the replacement worker committed: now the zombie wakes and meets its fence
    const zombie = takeoverDrill
      ? await wakeZombieAndAwaitFence({ sqlitePath, artifactDir, releaseId })
      : undefined;

    const trace = attempt1Result.spend.trace;
    return {
      mode: isLive ? "live-openrouter" : "deterministic-offline",
      clockMode: "real-30s-clock",
      faultMode: takeoverDrill ? faultMode : "none",
      workerTopology: useExternal ? "multi-process" : "in-process-cluster",
      takeoverDrill,
      workerPids: spawnedWorkers.flatMap((w) => (w.pid === undefined ? [] : [w.pid])),
      sqlitePath,
      artifactDir,
      health: {
        livenessStatus: liveness.status,
        readinessStatus: readiness.status,
        healthCheckComponents: readiness.components.map((c) => c.name),
      },
      attempt1: {
        executionId: attempt1Result.executionId,
        status: attempt1Result.status,
        finish: ReleaseRecoveryPlannedWorkflowFinish.name,
        toolCallsCount: attempt1Result.toolCalls.length,
        compensationsCount: attempt1Result.compensations.length,
        llmSpend: {
          calls: attempt1Result.spend.calls,
          inputTokens: trace.reduce((s, l) => s + l.inputTokens, 0),
          outputTokens: trace.reduce((s, l) => s + l.outputTokens, 0),
          totalUsd: attempt1Result.spend.totalUsd,
          servedBy: [...new Set(trace.flatMap((l) => (l.servedBy === undefined ? [] : [l.servedBy])))],
        },
        recoveryPlan,
      },
      attempt2: {
        executionId: attempt2Result.executionId,
        status: attempt2Result.status,
        finish: ReleaseCoordinatorWorkflowFinish.name,
        releaseSummary: attempt2Result.output as ReleaseSummaryDto,
      },
      zombie,
      ledger: await LedgerSnapshotRepository.readFromFile({ sqlitePath, artifactDir, releaseId }),
    };
  } finally {
    await Promise.all([
      ...inProcessWorkers.map((w) => w.close()),
      coordinator.close(),
      ...spawnedWorkers.map((w) => stopWorkerProcess(w)),
    ]);
    await offlineModel?.close();
    if (tempRoot !== undefined && options.keepStorageOnExit !== true) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
