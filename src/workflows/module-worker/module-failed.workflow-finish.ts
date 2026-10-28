import { WorkflowFinish } from "@agboss/core";
import { ModuleFailedDto } from "../../dto/module-failed.dto.js";

@WorkflowFinish({
  name: "module-failed-workflow-finish",
  description: "Soft-failure finish for an unrecoverable child module task",
  output: ModuleFailedDto,
})
export class ModuleFailedWorkflowFinish {}
