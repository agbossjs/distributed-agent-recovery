import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
} from "@agboss/core";
import { LockedReleaseCandidateDto } from "../dto/locked-release-candidate.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";
import { ReleaseGateFailedError } from "../errors/release-gate-failed.error.js";
import { ReleaseCandidateService } from "../services/release-candidate.service.js";

@Action({
  name: "verify-release-smoke-gate-action",
  description:
    "Executes the post-staging ABI and smoke verification gate across all staged module artifacts, throwing ReleaseGateFailedError to trigger saga compensation when verification fails.",
  input: {
    releaseRequest: ReleaseRequestDto,
    lockedCandidate: LockedReleaseCandidateDto,
  },
  deps: [ReleaseCandidateService, ExecutionContext],
})
export class VerifyReleaseSmokeGateAction
  implements ActionHandler<VerifyReleaseSmokeGateAction>
{
  constructor(
    private readonly candidates: ReleaseCandidateService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<VerifyReleaseSmokeGateAction>): Promise<void> {
    const req = input.releaseRequest.value;
    const locked = input.lockedCandidate.value;

    if (req.simulateIntegrationFailure) {
      const diagnostic =
        `ABI compatibility smoke check failed for ${req.releaseId} (attempt ${String(req.attemptNumber)}) ` +
        `with buildFlags="${req.buildFlags}": payment-engine requires --abi-compat=v2`;

      await this.candidates.recordSmokeGateFailure({
        releaseId: req.releaseId,
        attemptNumber: req.attemptNumber,
        candidateLockId: locked.candidateLockId,
        executionId: this.executionContext.executionId,
        idempotencyKey: this.executionContext.step.idempotencyKey,
        diagnostic,
      });

      throw new ReleaseGateFailedError(
        req.releaseId,
        req.attemptNumber,
        diagnostic,
      );
    }
  }
}
