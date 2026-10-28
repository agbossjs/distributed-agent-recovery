import {
  Action,
  type ActionHandler,
  Clock,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { PreparedModuleCandidateDto } from "../dto/prepared-module-candidate.dto.js";
import { StagedModuleArtifactDto } from "../dto/staged-module-artifact.dto.js";
import { StaleLeaseFenceError } from "../errors/stale-lease-fence.error.js";
import { LeaseFencingService } from "../services/lease-fencing.service.js";
import { ReleaseLedgerService } from "../services/release-ledger.service.js";

@Action({
  name: "stage-module-artifact-action",
  description:
    "Stages the compiled module artifact to disk and commits a lease-fenced record to the shared SQLite release ledger.",
  input: {
    preparedCandidate: PreparedModuleCandidateDto,
  },
  output: StagedModuleArtifactDto,
  deps: [ReleaseLedgerService, LeaseFencingService, ExecutionContext, Clock],
})
export class StageModuleArtifactAction
  implements ActionHandler<StageModuleArtifactAction>
{
  constructor(
    private readonly ledger: ReleaseLedgerService,
    private readonly fencing: LeaseFencingService,
    private readonly executionContext: ExecutionContext,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: InputOf<StageModuleArtifactAction>,
  ): Promise<OutputOf<StageModuleArtifactAction>> {
    const candidate = input.preparedCandidate.value;
    const executionId = this.executionContext.executionId;
    const idempotencyKey = this.executionContext.step.idempotencyKey;
    const alreadyStalled = await this.fencing.hasStalledWorkerForExecution(executionId);
    const capturedLease = await this.fencing.captureStepLease({
      executionId,
      logicalTaskId: candidate.logicalTaskId,
      releaseId: candidate.releaseId,
      attemptNumber: candidate.attemptNumber,
    });

    if (candidate.simulateWorkerStall && !alreadyStalled) {
      return this.runStalledZombiePath(candidate, executionId, idempotencyKey, capturedLease);
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
      capturedInstanceId: capturedLease.instanceId,
      capturedLeaseEpoch: capturedLease.leaseEpoch,
      idempotencyKey,
    });

    if (candidate.simulateWorkerStall && alreadyStalled) {
      await this.fencing.resumeFrozenStalledWorker(executionId);
      await this.waitUntil(() => this.fencing.hasZombieFullyFenced(executionId), 600);
    }

    return this.toStagedDto(
      candidate, executionId, idempotencyKey,
      staged.committedByInstanceId, staged.leaseEpoch, staged.artifactId, staged.artifactPath,
    );
  }

  private async runStalledZombiePath(
    candidate: PreparedModuleCandidateDto,
    executionId: string,
    idempotencyKey: string,
    capturedLease: { readonly instanceId: string; readonly leaseEpoch: number },
  ): Promise<StagedModuleArtifactDto> {
    const osFreeze = process.env["AGBOSS_OS_FREEZE"] === "true";
    if (osFreeze) {
      await this.clock.sleep(seconds(0.5));
    }
    await this.fencing.initiateWorkerStallAndExpireLease({
      releaseId: candidate.releaseId,
      attemptNumber: candidate.attemptNumber,
      logicalTaskId: candidate.logicalTaskId,
      moduleName: candidate.moduleName,
      executionId,
      instanceId: capturedLease.instanceId,
      leaseEpoch: capturedLease.leaseEpoch,
      idempotencyKey,
      skipSyntheticLeaseExpiry: osFreeze,
    });
    if (osFreeze) {
      process.kill(process.pid, "SIGSTOP");
      await this.clock.sleep(seconds(0.05));
    }

    await this.waitUntil(
      () =>
        this.fencing.hasReplacementWorkerCommitted({
          releaseId: candidate.releaseId,
          attemptNumber: candidate.attemptNumber,
          logicalTaskId: candidate.logicalTaskId,
          minLeaseEpoch: capturedLease.leaseEpoch + 1,
        }),
      3_600,
    );

    try {
      const staged = await this.ledger.stageModuleArtifact({
        releaseId: candidate.releaseId,
        version: candidate.version,
        attemptNumber: candidate.attemptNumber,
        logicalTaskId: candidate.logicalTaskId,
        moduleName: candidate.moduleName,
        preparedByInstanceId: candidate.preparedByInstanceId,
        candidateDigest: candidate.candidateDigest,
        executionId,
        capturedInstanceId: capturedLease.instanceId,
        capturedLeaseEpoch: capturedLease.leaseEpoch,
        idempotencyKey,
      });
      return this.toStagedDto(
        candidate, executionId, idempotencyKey,
        staged.committedByInstanceId, staged.leaseEpoch, staged.artifactId, staged.artifactPath,
      );
    } catch (error) {
      if (!(error instanceof StaleLeaseFenceError)) {
        throw error;
      }
      await this.fencing.observeAbortedLeaseSignal({
        executionId,
        staleInstanceId: capturedLease.instanceId,
        staleLeaseEpoch: capturedLease.leaseEpoch,
        signal: this.executionContext.signal,
      });
      // Return after ledger fencing so AGBoss's LeasedCheckpointSaver also
      // fences the zombie's checkpoint write with ExecutionLeaseLostError.
      return this.toStagedDto(
        candidate, executionId, idempotencyKey,
        capturedLease.instanceId, capturedLease.leaseEpoch,
        `stale:${candidate.releaseId}:${candidate.moduleName}`, "fenced-by-ledger",
      );
    }
  }

  private async waitUntil(predicate: () => Promise<boolean>, maxTicks: number): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if (await predicate()) {
        return;
      }
      await this.clock.sleep(seconds(0.025));
    }
  }

  private toStagedDto(
    candidate: PreparedModuleCandidateDto,
    executionId: string,
    idempotencyKey: string,
    committedByInstanceId: string,
    leaseEpoch: number,
    artifactId: string,
    artifactPath: string,
  ): StagedModuleArtifactDto {
    return {
      logicalTaskId: candidate.logicalTaskId,
      releaseId: candidate.releaseId,
      version: candidate.version,
      attemptNumber: candidate.attemptNumber,
      moduleName: candidate.moduleName,
      executionId,
      preparedByInstanceId: candidate.preparedByInstanceId,
      committedByInstanceId,
      leaseEpoch,
      idempotencyKey,
      artifactId,
      artifactPath,
      status: "STAGED",
    };
  }
}
