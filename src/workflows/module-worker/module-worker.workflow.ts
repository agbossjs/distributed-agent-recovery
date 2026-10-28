import {
  StepFailedError,
  Workflow,
  action,
  start,
  toAction,
} from "@agboss/core";
import { MarkModuleFailedAction } from "../../actions/mark-module-failed.action.js";
import { PrepareModuleCandidateAction } from "../../actions/prepare-module-candidate.action.js";
import { StageModuleArtifactAction } from "../../actions/stage-module-artifact.action.js";
import { ModuleFailedDto } from "../../dto/module-failed.dto.js";
import { ModuleTaskDto } from "../../dto/module-task.dto.js";
import { PreparedModuleCandidateDto } from "../../dto/prepared-module-candidate.dto.js";
import { StagedModuleArtifactDto } from "../../dto/staged-module-artifact.dto.js";
import { ModuleFailedWorkflowFinish } from "./module-failed.workflow-finish.js";
import { ModuleWorkerWorkflowFinish } from "./module-worker.workflow-finish.js";
import { ModuleWorkerWorkflowStart } from "./module-worker.workflow-start.js";

@Workflow({
  name: "module-worker-workflow",
  version: "1.0.0",
  flow: [
    start(ModuleWorkerWorkflowStart)
      .returns(ModuleTaskDto)
      .toAction(PrepareModuleCandidateAction)
      .onError(StepFailedError, toAction(MarkModuleFailedAction))
      .returns(PreparedModuleCandidateDto)
      .toAction(StageModuleArtifactAction)
      .onError(StepFailedError, toAction(MarkModuleFailedAction))
      .returns(StagedModuleArtifactDto)
      .toFinish(ModuleWorkerWorkflowFinish),

    action(MarkModuleFailedAction)
      .returns(ModuleFailedDto)
      .toFinish(ModuleFailedWorkflowFinish),
  ],
})
export class ModuleWorkerWorkflow {}
