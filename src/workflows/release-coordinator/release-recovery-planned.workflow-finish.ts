import { WorkflowFinish } from "@agboss/core";
import { RecoveryPlanDto } from "../../dto/recovery-plan.dto.js";

@WorkflowFinish({
  name: "release-recovery-planned-workflow-finish",
  description:
    "Finish reached after a release candidate failed the smoke gate, executed saga compensation, and produced an AI recovery plan for the next attempt",
  output: RecoveryPlanDto,
})
export class ReleaseRecoveryPlannedWorkflowFinish {}
