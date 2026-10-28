import {
  ChildPlacement,
  Workflow,
  listOf,
  oneOf,
  start,
  toAction,
} from "@agboss/core";
import { CompensateReleaseCandidateAction } from "../../actions/compensate-release-candidate.action.js";
import { DecomposeReleaseTasksAction } from "../../actions/decompose-release-tasks.action.js";
import { LockReleaseCandidateAction } from "../../actions/lock-release-candidate.action.js";
import { PromoteReleaseArtifactsAction } from "../../actions/promote-release-artifacts.action.js";
import { SummarizeCompensatedAttemptAction } from "../../actions/summarize-compensated-attempt.action.js";
import { VerifyReleaseSmokeGateAction } from "../../actions/verify-release-smoke-gate.action.js";
import { ReleaseRecoveryPlannerAgent } from "../../agents/release-recovery-planner/release-recovery-planner.agent.js";
import { CompensatedReleaseCandidateDto } from "../../dto/compensated-release-candidate.dto.js";
import { LockedReleaseCandidateDto } from "../../dto/locked-release-candidate.dto.js";
import { ModuleFailedDto } from "../../dto/module-failed.dto.js";
import { ModuleTaskDto } from "../../dto/module-task.dto.js";
import { RecoveryPlanDto } from "../../dto/recovery-plan.dto.js";
import { ReleaseRequestDto } from "../../dto/release-request.dto.js";
import { ReleaseSummaryDto } from "../../dto/release-summary.dto.js";
import { StagedModuleArtifactDto } from "../../dto/staged-module-artifact.dto.js";
import { ReleaseGateFailedError } from "../../errors/release-gate-failed.error.js";
import { ModuleWorkerWorkflow } from "../module-worker/module-worker.workflow.js";
import { ReleaseCoordinatorWorkflowFinish } from "./release-coordinator.workflow-finish.js";
import { ReleaseCoordinatorWorkflowStart } from "./release-coordinator.workflow-start.js";
import { ReleaseRecoveryPlannedWorkflowFinish } from "./release-recovery-planned.workflow-finish.js";

@Workflow({
  name: "release-coordinator-workflow",
  version: "1.0.0",
  flow: [
    start(ReleaseCoordinatorWorkflowStart)
      .returns(ReleaseRequestDto)
      .toAction(DecomposeReleaseTasksAction)
      .returns(listOf(ModuleTaskDto))
      .toParallelWorkflows(ModuleWorkerWorkflow, {
        maxConcurrency: 4,
        maxItems: 8,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(oneOf(StagedModuleArtifactDto, ModuleFailedDto)))
      .toAction(LockReleaseCandidateAction)
      .returns(LockedReleaseCandidateDto)
      .toAction(VerifyReleaseSmokeGateAction)
      .onError(
        ReleaseGateFailedError,
        toAction(CompensateReleaseCandidateAction)
          .toAction(SummarizeCompensatedAttemptAction)
          .returns(CompensatedReleaseCandidateDto)
          .toAgent(ReleaseRecoveryPlannerAgent)
          .returns(RecoveryPlanDto)
          .toFinish(ReleaseRecoveryPlannedWorkflowFinish),
      )
      .toAction(PromoteReleaseArtifactsAction)
      .returns(ReleaseSummaryDto)
      .toFinish(ReleaseCoordinatorWorkflowFinish),
  ],
})
export class ReleaseCoordinatorWorkflow {}
