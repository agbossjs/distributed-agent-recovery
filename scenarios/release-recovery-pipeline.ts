import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, ExecutionStatus, HealthStatus, createApp } from "@agboss/core";
import {
  DistributedAgentRecoveryApplication,
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
  ReleaseRecoveryPlannedWorkflowFinish,
} from "../src/distributed-agent-recovery.application.js";
import type { RecoveryPlanDto } from "../src/dto/recovery-plan.dto.js";
import type { ReleaseSummaryDto } from "../src/dto/release-summary.dto.js";
import { ReleaseArtifactRepository } from "../src/repositories/release-artifact.repository.js";
import type { LedgerSnapshot } from "../src/schemas/release-ledger.schema.js";
import { spawnWorkerProcess, stopWorkerProcess } from "./cluster-worker-process.js";
import { FastClusterClock } from "./fast-cluster-clock.js";
import { createOfflineOpenRouterFetch, requireLiveApiKey } from "./offline-openrouter-fetch.js";

export interface ReleasePipelineOptions {
  readonly sqlitePath?: string;
  readonly artifactDir?: string;
  readonly keepStorageOnExit?: boolean;
  readonly liveModel?: boolean;
  readonly externalWorkers?: boolean;
  readonly spawnClusterWorkers?: boolean;
  readonly realClock?: boolean;
  readonly staleWorkerAttemptsWrite?: boolean;
  readonly releaseId?: string;
  readonly version?: string;
}

export interface ReleasePipelineReport {
  readonly mode: "live-openrouter" | "deterministic-offline";
  readonly clockMode: "real-30s-clock" | "fast-cluster-clock";
  readonly faultMode: "os-sigstop-natural-lease-expiry" | "simulated-lease-expiry";
  readonly workerTopology: "multi-process" | "in-process-cluster";
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
  readonly ledger: LedgerSnapshot;
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
  const openRouterKey = isLive ? requireLiveApiKey() : "offline-test-openrouter-api-key";
  const useExternal = options.externalWorkers === true || options.spawnClusterWorkers === true;
  const realClock = options.realClock === true || process.env["AGBOSS_REAL_CLOCK"] === "true";
  const osFreeze = realClock && useExternal && process.env["AGBOSS_OS_FREEZE"] !== "false";
  const skipStaleWriteAttempt =
    options.staleWorkerAttemptsWrite === false ||
    process.env["AGBOSS_SKIP_STALE_WRITE_ATTEMPT"] === "true";

  const buildEnv = (nodeRole: string): NodeJS.ProcessEnv => ({
    ...process.env,
    SQLITE_PATH: sqlitePath,
    ARTIFACT_DIR: artifactDir,
    AGBOSS_NODE_ROLE: nodeRole,
    OPENROUTER_API_KEY: openRouterKey,
    PII_PSEUDONYM_KEY: process.env["PII_PSEUDONYM_KEY"] ?? "distributed-agent-recovery-pseudonym-key-32b!",
    ...(isLive ? { AGBOSS_LIVE_DEMO: "true" } : {}),
    ...(realClock ? { AGBOSS_REAL_CLOCK: "true" } : { AGBOSS_FAST_SWEEP: "true" }),
    ...(osFreeze ? { AGBOSS_OS_FREEZE: "true" } : {}),
    ...(skipStaleWriteAttempt ? { AGBOSS_SKIP_STALE_WRITE_ATTEMPT: "true" } : {}),
  });

  const createNode = (role: string) =>
    createApp(DistributedAgentRecoveryApplication, {
      processEnv: buildEnv(role),
      ...(isLive ? {} : { providerFetch: createOfflineOpenRouterFetch() }),
      ...(realClock ? {} : { container: { overrides: new Map([[Clock, new FastClusterClock()]]) } }),
    });

  const coordinator = await createNode("coordinator");
  const spawnedWorkers =
    options.spawnClusterWorkers === true
      ? [await spawnWorkerProcess(buildEnv("worker")), await spawnWorkerProcess(buildEnv("worker"))]
      : [];
  const inProcessWorkers = useExternal ? [] : [await createNode("worker"), await createNode("worker")];

  try {
    const liveness = await coordinator.checkLiveness();
    const readiness = await coordinator.checkReadiness();
    if (liveness.status !== HealthStatus.Healthy || readiness.status !== HealthStatus.Healthy) {
      throw new Error(`Cluster health failed: liveness=${liveness.status}, readiness=${readiness.status}`);
    }

    const attempt1Result = await coordinator.execute(
      ReleaseCoordinatorWorkflowStart,
      {
        releaseId, version, attemptNumber: 1,
        modules: "auth-service,payment-engine,telemetry-collector",
        buildFlags: "--opt-level=3 --deterministic",
        simulateIntegrationFailure: true, stallTargetModule: "",
      },
      { record: true },
    );
    if (attempt1Result.status !== ExecutionStatus.Finished || attempt1Result.finish?.name !== "release-recovery-planned-workflow-finish") {
      throw new Error(`Attempt 1 failed: status=${attempt1Result.status}, finish=${String(attempt1Result.finish?.name)}`);
    }
    const recoveryPlan = attempt1Result.output as RecoveryPlanDto;

    const attempt2Result = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
      releaseId: recoveryPlan.releaseId,
      version: recoveryPlan.version,
      attemptNumber: recoveryPlan.nextAttemptNumber,
      modules: "auth-service,payment-engine,telemetry-collector",
      buildFlags: recoveryPlan.correctedBuildFlags,
      simulateIntegrationFailure: false,
      stallTargetModule: recoveryPlan.enableLeaseTakeoverDrill ? "payment-engine" : "",
    });
    if (attempt2Result.status !== ExecutionStatus.Finished || attempt2Result.finish?.name !== "release-coordinator-workflow-finish") {
      throw new Error(`Attempt 2 failed: status=${attempt2Result.status}, finish=${String(attempt2Result.finish?.name)}`);
    }

    const rec = attempt1Result.record;
    const trace = rec?.spend.trace ?? [];
    return {
      mode: isLive ? "live-openrouter" : "deterministic-offline",
      clockMode: realClock ? "real-30s-clock" : "fast-cluster-clock",
      faultMode: osFreeze ? "os-sigstop-natural-lease-expiry" : "simulated-lease-expiry",
      workerTopology: useExternal ? "multi-process" : "in-process-cluster",
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
        compensationsCount: rec?.compensations.length ?? 0,
        llmSpend: {
          calls: rec?.spend.calls ?? 0,
          inputTokens: trace.reduce((s, l) => s + l.inputTokens, 0),
          outputTokens: trace.reduce((s, l) => s + l.outputTokens, 0),
          totalUsd: rec?.spend.totalUsd ?? 0,
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
      ledger: await ReleaseArtifactRepository.readSnapshotFromFile({ sqlitePath, artifactDir, releaseId }),
    };
  } finally {
    await Promise.all([
      ...inProcessWorkers.map((w) => w.close()),
      coordinator.close(),
      ...spawnedWorkers.map((w) => stopWorkerProcess(w)),
    ]);
    if (tempRoot !== undefined && options.keepStorageOnExit !== true) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
