import { WorkflowFinish } from "@agboss/core";
import { ReleaseSummaryDto } from "../../dto/release-summary.dto.js";

@WorkflowFinish({
  name: "release-coordinator-workflow-finish",
  description: "Successfully verified and promoted software release candidate",
  output: ReleaseSummaryDto,
})
export class ReleaseCoordinatorWorkflowFinish {}
