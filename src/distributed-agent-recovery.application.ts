import {
  Application,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "@agboss/core";
import { OpenRouterModelProvider } from "@agboss/core/models";
import { hours, seconds } from "@agboss/core/units";
import { ReleaseAppDailyBudget } from "./budgets/release-app-daily.budget.js";
import { ReleaseExecutionBudget } from "./budgets/release-execution.budget.js";
import { ReleaseTenantDailyBudget } from "./budgets/release-tenant-daily.budget.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { ReleaseClusterHealthCheck } from "./health-checks/release-cluster.health-check.js";
import { ClusterSqliteChildExecutionQueueRepository } from "./repositories/cluster-child-execution-queue.repository.js";
import { FencedSqliteExecutionLeaseRepository } from "./repositories/fenced-execution-lease.repository.js";
import { LeaseFencingRepository } from "./repositories/lease-fencing.repository.js";
import { LedgerDatabaseRepository } from "./repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "./repositories/ledger-event.repository.js";
import { ReleaseArtifactRepository } from "./repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "./repositories/release-candidate.repository.js";
import { LeaseFencingService } from "./services/lease-fencing.service.js";
import { ReleaseArtifactStoreService } from "./services/release-artifact-store.service.js";
import { ReleaseCandidateService } from "./services/release-candidate.service.js";
import { ReleaseCompensationService } from "./services/release-compensation.service.js";
import { ReleaseInvariantVerifierService } from "./services/release-invariant-verifier.service.js";
import { ReleaseLedgerService } from "./services/release-ledger.service.js";
import { StorageProbeService } from "./services/storage-probe.service.js";
import { ModuleFailedWorkflowFinish } from "./workflows/module-worker/module-failed.workflow-finish.js";
import { ModuleWorkerWorkflowFinish } from "./workflows/module-worker/module-worker.workflow-finish.js";
import { ModuleWorkerWorkflowStart } from "./workflows/module-worker/module-worker.workflow-start.js";
import { ModuleWorkerWorkflow } from "./workflows/module-worker/module-worker.workflow.js";
import { ReleaseCoordinatorWorkflowFinish } from "./workflows/release-coordinator/release-coordinator.workflow-finish.js";
import { ReleaseCoordinatorWorkflowStart } from "./workflows/release-coordinator/release-coordinator.workflow-start.js";
import { ReleaseCoordinatorWorkflow } from "./workflows/release-coordinator/release-coordinator.workflow.js";
import { ReleaseRecoveryPlannedWorkflowFinish } from "./workflows/release-coordinator/release-recovery-planned.workflow-finish.js";

@Application({
  name: "distributed-agent-recovery-application",
  version: "1.0.0",
  environment: AppEnvironment,
  pseudonymKey: "piiPseudonymKey",
  workflows: [ReleaseCoordinatorWorkflow, ModuleWorkerWorkflow],
  budgets: [
    ReleaseAppDailyBudget,
    ReleaseTenantDailyBudget,
    ReleaseExecutionBudget,
  ],
  healthChecks: [ReleaseClusterHealthCheck],
  maxConcurrentSteps: 4,
  providers: [
    OpenRouterModelProvider,
    SqliteConnection,
    LedgerDatabaseRepository,
    ReleaseArtifactRepository,
    ReleaseCandidateRepository,
    LeaseFencingRepository,
    LedgerEventRepository,
    LeaseFencingService,
    ReleaseArtifactStoreService,
    ReleaseLedgerService,
    ReleaseCandidateService,
    ReleaseCompensationService,
    ReleaseInvariantVerifierService,
    StorageProbeService,
    SqliteCheckpointSaver,
    SqlitePausedExecutionRepository,
    SqliteCostLedgerRepository,
    SqliteExecutionRecordRepository,
    FencedSqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    SqliteExecutionHistoryRepository,
    ClusterSqliteChildExecutionQueueRepository,
  ],
  executionRecordRetention: hours(24 * 30),
  pauseRecordRetention: hours(24),
  shutdownTimeout: seconds(15),
})
export class DistributedAgentRecoveryApplication {}

export {
  ModuleFailedWorkflowFinish,
  ModuleWorkerWorkflow,
  ModuleWorkerWorkflowFinish,
  ModuleWorkerWorkflowStart,
  ReleaseCoordinatorWorkflow,
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
  ReleaseRecoveryPlannedWorkflowFinish,
};
