import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { PreparedModuleCandidateDto } from "../dto/prepared-module-candidate.dto.js";
import { StagedModuleArtifactDto } from "../dto/staged-module-artifact.dto.js";
import { ReleaseLedgerService } from "../services/release-ledger.service.js";
import { WorkerStallService } from "../services/worker-stall.service.js";

/**
 * Step 2 of a module task: stages the module's artifact in the shared ledger. The write is a fenced
 * effect (`ReleaseLedgerService.stageModuleArtifact`): it commits only for the holder of the child
 * execution's lease. In the zombie drill the first worker to get here freezes (or dies) before the
 * write; once its lease ran out another worker takes the child over, runs this step again from the
 * step-1 checkpoint and commits under the next fencing token — and the frozen worker, woken, is
 * refused at the write.
 */
@Action({
  name: "stage-module-artifact-action",
  description:
    "Stages the compiled module artifact in the shared SQLite release ledger through a lease-fenced effect.",
  input: {
    preparedCandidate: PreparedModuleCandidateDto,
  },
  output: StagedModuleArtifactDto,
  deps: [ReleaseLedgerService, WorkerStallService, ExecutionContext],
})
export class StageModuleArtifactAction
  implements ActionHandler<StageModuleArtifactAction>
{
  constructor(
    private readonly ledger: ReleaseLedgerService,
    private readonly stalls: WorkerStallService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<StageModuleArtifactAction>,
  ): Promise<OutputOf<StageModuleArtifactAction>> {
    const candidate = input.preparedCandidate;
    const executionId = this.executionContext.executionId;
    const idempotencyKey = this.executionContext.step.idempotencyKey;

    if (candidate.simulateWorkerStall && !(await this.stalls.hasStalled(executionId))) {
      await this.stalls.stall({
        executionId,
        logicalTaskId: candidate.logicalTaskId,
        releaseId: candidate.releaseId,
        attemptNumber: candidate.attemptNumber,
      });
    }

    const staged = await this.ledger.stageModuleArtifact({
      releaseId: candidate.releaseId,
      version: candidate.version,
      attemptNumber: candidate.attemptNumber,
      logicalTaskId: candidate.logicalTaskId,
      moduleName: candidate.moduleName,
      preparedByInstanceId: candidate.preparedByInstanceId,
      candidateDigest: candidate.candidateDigest,
      executionId,
      idempotencyKey,
    });

    return {
      logicalTaskId: candidate.logicalTaskId,
      releaseId: candidate.releaseId,
      version: candidate.version,
      attemptNumber: candidate.attemptNumber,
      moduleName: candidate.moduleName,
      executionId,
      preparedByInstanceId: candidate.preparedByInstanceId,
      committedByInstanceId: staged.committedByInstanceId,
      fencingToken: staged.fencingToken,
      idempotencyKey,
      artifactId: staged.artifactId,
      artifactPath: staged.artifactPath,
      status: "STAGED",
    };
  }
}
