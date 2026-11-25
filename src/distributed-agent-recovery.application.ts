import { Application } from "@agboss/core";
import { hours, seconds } from "@agboss/core/units";
import { ReleaseAppDailyBudget } from "./budgets/release-app-daily.budget.js";
import { ReleaseExecutionBudget } from "./budgets/release-execution.budget.js";
import { ReleaseTenantDailyBudget } from "./budgets/release-tenant-daily.budget.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { ReleaseClusterHealthCheck } from "./health-checks/release-cluster.health-check.js";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";
import { LeaseEvidenceObserver } from "./observers/lease-evidence.observer.js";
import { ReleaseLedgerDatabaseStorage } from "./storages/release-ledger.database-storage.js";
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
  version: "1.1.0",
  environment: AppEnvironment,
  storage: ReleaseLedgerDatabaseStorage, // one SQLite file for every instance: leases, queue, checkpoints, the ledger
  modelProvider: OpenRouterModelProvider, // every model of the application: explicit, no default
  workflows: [ReleaseCoordinatorWorkflow, ModuleWorkerWorkflow],
  budgets: [
    ReleaseAppDailyBudget,
    ReleaseTenantDailyBudget,
    ReleaseExecutionBudget,
  ],
  healthChecks: [ReleaseClusterHealthCheck],
  observers: [LeaseEvidenceObserver],
  providers: [OpenRouterModelProvider], // the ledger's repositories and services are created on demand, as the dependencies of the components that use them
  retention: { executionRecords: hours(24 * 30), pauseRecords: hours(24) },
  executionLimits: { maxConcurrentSteps: 1, shutdownTimeout: seconds(15), childClaimTimeout: seconds(120) },
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
