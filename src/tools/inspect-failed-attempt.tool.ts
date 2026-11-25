import { Tool, type ToolHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { FailedAttemptInspectionDto } from "../dto/failed-attempt-inspection.dto.js";
import { FailedAttemptQueryDto } from "../dto/failed-attempt-query.dto.js";
import { ReleaseInspectionService } from "../services/release-inspection.service.js";

@Tool({
  name: "inspect-failed-attempt-tool",
  description:
    "Inspects the shared SQLite release ledger for a failed release attempt to verify that all staged artifacts were compensated and retrieve the exact failure diagnostic.",
  input: FailedAttemptQueryDto,
  output: FailedAttemptInspectionDto,
  timeout: seconds(5),
  deps: [ReleaseInspectionService],
})
export class InspectFailedAttemptTool
  implements ToolHandler<FailedAttemptQueryDto, FailedAttemptInspectionDto>
{
  constructor(private readonly ledger: ReleaseInspectionService) {}

  async execute(input: FailedAttemptQueryDto): Promise<FailedAttemptInspectionDto> {
    const inspection = await this.ledger.inspectFailedAttempt(
      input.releaseId,
      input.failedAttemptNumber,
    );
    return {
      releaseId: input.releaseId,
      failedAttemptNumber: input.failedAttemptNumber,
      compensatedArtifactCount: inspection.compensatedCount,
      activeArtifactsRemaining: inspection.activeRemainingCount,
      allArtifactsCompensated: inspection.allCompensated,
      ledgerDiagnostic: inspection.ledgerDiagnostic,
    };
  }
}
