import { WorkflowStart } from "@agboss/core";
import { ModuleTaskDto } from "../../dto/module-task.dto.js";

@WorkflowStart({
  name: "module-worker-workflow-start",
  description: "Starts distributed module preparation and staging on any available worker instance",
  input: ModuleTaskDto,
})
export class ModuleWorkerWorkflowStart {}
