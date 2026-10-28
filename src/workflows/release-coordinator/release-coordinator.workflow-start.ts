import { WorkflowStart } from "@agboss/core";
import { ReleaseRequestDto } from "../../dto/release-request.dto.js";

@WorkflowStart({
  name: "release-coordinator-workflow-start",
  description:
    "Starts distributed release orchestration with concurrent module workers, saga compensation, and AI recovery planning",
  input: ReleaseRequestDto,
})
export class ReleaseCoordinatorWorkflowStart {}
