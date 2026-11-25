import {
  Ttl,
  Workflow,
  onStart,
  toAction,
  toWorkflow,
} from "@agboss/core";
import { CompensateReleaseCandidateAction } from "../../actions/compensate-release-candidate.action.js";
import { DecomposeReleaseTasksAction } from "../../actions/decompose-release-tasks.action.js";
import { LockReleaseCandidateAction } from "../../actions/lock-release-candidate.action.js";
import { PromoteReleaseArtifactsAction } from "../../actions/promote-release-artifacts.action.js";
import { SummarizeCompensatedAttemptAction } from "../../actions/summarize-compensated-attempt.action.js";
import { VerifyReleaseSmokeGateAction } from "../../actions/verify-release-smoke-gate.action.js";
import { ReleaseRecoveryPlannerAgent } from "../../agents/release-recovery-planner/release-recovery-planner.agent.js";
import { ReleaseGateFailedError } from "../../errors/release-gate-failed.error.js";
import { ModuleWorkerWorkflow } from "../module-worker/module-worker.workflow.js";
import { ReleaseCoordinatorWorkflowFinish } from "./release-coordinator.workflow-finish.js";
import { ReleaseCoordinatorWorkflowStart } from "./release-coordinator.workflow-start.js";
import { ReleaseRecoveryPlannedWorkflowFinish } from "./release-recovery-planned.workflow-finish.js";

@Workflow({
  name: "release-coordinator-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ReleaseCoordinatorWorkflowStart)
      .toAction(DecomposeReleaseTasksAction)
      .forEachItem(toWorkflow(ModuleWorkerWorkflow), { maxConcurrency: 4, takeFirst: 8 })
      .join()
      .toAction(LockReleaseCandidateAction)
      .toAction(VerifyReleaseSmokeGateAction)
      .onError(
        ReleaseGateFailedError,
        toAction(CompensateReleaseCandidateAction)
          .toAction(SummarizeCompensatedAttemptAction)
          .toAgent(ReleaseRecoveryPlannerAgent)
          .toFinish(ReleaseRecoveryPlannedWorkflowFinish),
      )
      .toAction(PromoteReleaseArtifactsAction)
      .toFinish(ReleaseCoordinatorWorkflowFinish),
  ],
  executionLimits: { maxSteps: 12 },
})
export class ReleaseCoordinatorWorkflow {}
