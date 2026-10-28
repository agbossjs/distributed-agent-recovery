import { WorkflowFinish } from "@agboss/core";
import { StagedModuleArtifactDto } from "../../dto/staged-module-artifact.dto.js";

@WorkflowFinish({
  name: "module-worker-workflow-finish",
  description: "Successfully staged module artifact with lease fencing proof",
  output: StagedModuleArtifactDto,
})
export class ModuleWorkerWorkflowFinish {}
