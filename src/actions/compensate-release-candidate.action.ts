import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
} from "@agboss/core";
import { LockedReleaseCandidateDto } from "../dto/locked-release-candidate.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";
import { ReleaseCompensationService } from "../services/release-compensation.service.js";

@Action({
  name: "compensate-release-candidate-action",
  description:
    "Saga compensation handler that removes staged module artifact files from disk and marks the release candidate and all its staged artifacts as COMPENSATED in the shared SQLite ledger.",
  input: {
    releaseRequest: ReleaseRequestDto,
    lockedCandidate: LockedReleaseCandidateDto,
  },
  deps: [ReleaseCompensationService, ExecutionContext],
})
export class CompensateReleaseCandidateAction
  implements ActionHandler<CompensateReleaseCandidateAction>
{
  constructor(
    private readonly compensation: ReleaseCompensationService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<CompensateReleaseCandidateAction>): Promise<void> {
    const req = input.releaseRequest.value;
    const locked = input.lockedCandidate.value;

    await this.compensation.compensateReleaseCandidate({
      releaseId: req.releaseId,
      attemptNumber: req.attemptNumber,
      candidateLockId: locked.candidateLockId,
      executionId: this.executionContext.executionId,
      compensationIdempotencyKey: this.executionContext.step.idempotencyKey,
    });
  }
}
