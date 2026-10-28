import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { LockedReleaseCandidateDto } from "../dto/locked-release-candidate.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";
import { ReleaseSummaryDto } from "../dto/release-summary.dto.js";
import { ReleaseCandidateService } from "../services/release-candidate.service.js";

@Action({
  name: "promote-release-artifacts-action",
  description:
    "Promotes all verified staged module artifacts into the final release manifest directory and marks the release candidate PROMOTED in the SQLite ledger.",
  input: {
    releaseRequest: ReleaseRequestDto,
    lockedCandidate: LockedReleaseCandidateDto,
  },
  output: ReleaseSummaryDto,
  deps: [ReleaseCandidateService, ExecutionContext],
})
export class PromoteReleaseArtifactsAction
  implements ActionHandler<PromoteReleaseArtifactsAction>
{
  constructor(
    private readonly candidates: ReleaseCandidateService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<PromoteReleaseArtifactsAction>,
  ): Promise<OutputOf<PromoteReleaseArtifactsAction>> {
    const req = input.releaseRequest.value;
    const locked = input.lockedCandidate.value;

    const promoted = await this.candidates.promoteReleaseCandidate({
      releaseId: req.releaseId,
      version: req.version,
      attemptNumber: req.attemptNumber,
      candidateLockId: locked.candidateLockId,
      executionId: this.executionContext.executionId,
      idempotencyKey: this.executionContext.step.idempotencyKey,
    });

    return {
      releaseId: req.releaseId,
      version: req.version,
      attemptNumber: req.attemptNumber,
      status: "PROMOTED",
      promotedModuleCount: promoted.promotedModuleCount,
      participatingInstances: promoted.participatingInstances,
      manifestPath: promoted.manifestPath,
    };
  }
}
