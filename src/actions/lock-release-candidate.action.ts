import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
  listOf,
  oneOf,
} from "@agboss/core";
import { LockedReleaseCandidateDto } from "../dto/locked-release-candidate.dto.js";
import { ModuleFailedDto } from "../dto/module-failed.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";
import { StagedModuleArtifactDto } from "../dto/staged-module-artifact.dto.js";
import { ReleaseCandidateService } from "../services/release-candidate.service.js";
import { CompensateReleaseCandidateAction } from "./compensate-release-candidate.action.js";

@Action({
  name: "lock-release-candidate-action",
  description:
    "Locks the staged module artifacts as a transactional release candidate in the shared SQLite ledger, registered with CompensateReleaseCandidateAction for saga rollback.",
  input: {
    releaseRequest: ReleaseRequestDto,
    moduleOutcomes: listOf(oneOf(StagedModuleArtifactDto, ModuleFailedDto)),
  },
  output: LockedReleaseCandidateDto,
  compensateWith: CompensateReleaseCandidateAction,
  deps: [ReleaseCandidateService, ExecutionContext],
})
export class LockReleaseCandidateAction
  implements ActionHandler<LockReleaseCandidateAction>
{
  constructor(
    private readonly candidates: ReleaseCandidateService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<LockReleaseCandidateAction>,
  ): Promise<OutputOf<LockReleaseCandidateAction>> {
    const req = input.releaseRequest.value;
    const failedModules = input.moduleOutcomes.filter(
      (item) => "reason" in item.value,
    );
    if (failedModules.length > 0) {
      throw new Error(
        `Cannot lock release candidate ${req.releaseId}: ${String(failedModules.length)} module(s) failed staging`,
      );
    }

    const locked = await this.candidates.lockReleaseCandidate({
      releaseId: req.releaseId,
      version: req.version,
      attemptNumber: req.attemptNumber,
      buildFlags: req.buildFlags,
      executionId: this.executionContext.executionId,
      idempotencyKey: this.executionContext.step.idempotencyKey,
    });

    return {
      candidateLockId: locked.candidateLockId,
      releaseId: req.releaseId,
      version: req.version,
      attemptNumber: req.attemptNumber,
      stagedModuleCount: locked.stagedModuleCount,
      participatingInstances: locked.participatingInstances,
      buildFlags: req.buildFlags,
      idempotencyKey: this.executionContext.step.idempotencyKey,
    };
  }
}
