import {
  ChildPlacement,
  StepFailedError,
  Ttl,
  Workflow,
  onAction,
  onStart,
  toAction,
} from "@agboss/core";
import { MarkModuleFailedAction } from "../../actions/mark-module-failed.action.js";
import { PrepareModuleCandidateAction } from "../../actions/prepare-module-candidate.action.js";
import { StageModuleArtifactAction } from "../../actions/stage-module-artifact.action.js";
import { ModuleFailedWorkflowFinish } from "./module-failed.workflow-finish.js";
import { ModuleWorkerWorkflowFinish } from "./module-worker.workflow-finish.js";
import { ModuleWorkerWorkflowStart } from "./module-worker.workflow-start.js";

@Workflow({
  name: "module-worker-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  // work stealing: the coordinator queues each module task and a worker other than itself claims it
  placement: ChildPlacement.OtherWorker,
  flow: [
    onStart(ModuleWorkerWorkflowStart)
      .toAction(PrepareModuleCandidateAction)
      .onError(StepFailedError, toAction(MarkModuleFailedAction))
      .toAction(StageModuleArtifactAction)
      .onError(StepFailedError, toAction(MarkModuleFailedAction))
      .toFinish(ModuleWorkerWorkflowFinish),

    onAction(MarkModuleFailedAction)
      .toFinish(ModuleFailedWorkflowFinish),
  ],
})
export class ModuleWorkerWorkflow {}
