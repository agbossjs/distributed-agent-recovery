import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { CompensatedReleaseCandidateDto } from "../dto/compensated-release-candidate.dto.js";
import { LockedReleaseCandidateDto } from "../dto/locked-release-candidate.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";
import { ReleaseInspectionService } from "../services/release-inspection.service.js";

@Action({
  name: "summarize-compensated-attempt-action",
  description:
    "Reads the post-compensation state from the SQLite release ledger and packages a CompensatedReleaseCandidateDto for the AI recovery planner agent.",
  input: {
    releaseRequest: ReleaseRequestDto,
    lockedCandidate: LockedReleaseCandidateDto,
  },
  output: CompensatedReleaseCandidateDto,
  deps: [ReleaseInspectionService, ExecutionContext],
})
export class SummarizeCompensatedAttemptAction
  implements ActionHandler<SummarizeCompensatedAttemptAction>
{
  constructor(
    private readonly ledger: ReleaseInspectionService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<SummarizeCompensatedAttemptAction>,
  ): Promise<OutputOf<SummarizeCompensatedAttemptAction>> {
    const req = input.releaseRequest;
    const locked = input.lockedCandidate;
    const inspection = await this.ledger.inspectFailedAttempt(
      req.releaseId,
      req.attemptNumber,
    );

    return {
      candidateLockId: locked.candidateLockId,
      releaseId: req.releaseId,
      version: req.version,
      failedAttemptNumber: req.attemptNumber,
      compensatedModuleCount: inspection.compensatedCount,
      failureDiagnostic: inspection.ledgerDiagnostic,
      compensationIdempotencyKey: this.executionContext.step.idempotencyKey,
    };
  }
}
