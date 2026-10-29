import {
  Action,
  type ActionHandler,
  ApplicationContext,
  Clock,
  ExecutionContext,
  ExecutionLeaseLostError,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { PreparedModuleCandidateDto } from "../dto/prepared-module-candidate.dto.js";
import { StagedModuleArtifactDto } from "../dto/staged-module-artifact.dto.js";
import { StaleLeaseFenceError } from "../errors/stale-lease-fence.error.js";
import type { StallDisposition } from "../schemas/release-ledger.schema.js";
import { type CapturedStepLease, LeaseFencingService } from "../services/lease-fencing.service.js";
import { ReleaseLedgerService } from "../services/release-ledger.service.js";

@Action({
  name: "stage-module-artifact-action",
  description:
    "Stages the compiled module artifact to disk and commits a lease-fenced record to the shared SQLite release ledger.",
  input: { preparedCandidate: PreparedModuleCandidateDto },
  output: StagedModuleArtifactDto,
  deps: [ReleaseLedgerService, LeaseFencingService, ExecutionContext, Clock, ApplicationContext],
})
export class StageModuleArtifactAction implements ActionHandler<StageModuleArtifactAction> {
  constructor(
    private readonly ledger: ReleaseLedgerService,
    private readonly fencing: LeaseFencingService,
    private readonly executionContext: ExecutionContext,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {}

  async execute(input: InputOf<StageModuleArtifactAction>): Promise<OutputOf<StageModuleArtifactAction>> {
    const candidate = input.preparedCandidate.value;
    const executionId = this.executionContext.executionId;
    const idempotencyKey = this.executionContext.step.idempotencyKey;
    const alreadyStalled = await this.fencing.hasStalledWorkerForExecution(executionId);
    const stallDisposition = this.resolveStallDisposition();
    const capturedLease = await this.fencing.captureStepLease({
      executionId, logicalTaskId: candidate.logicalTaskId,
      releaseId: candidate.releaseId, attemptNumber: candidate.attemptNumber,
    });

    if (candidate.simulateWorkerStall && !alreadyStalled) {
      return this.runStalledZombiePath(candidate, executionId, idempotencyKey, capturedLease, stallDisposition);
    }

    const staged = await this.ledger.stageModuleArtifact({
      releaseId: candidate.releaseId, version: candidate.version,
      attemptNumber: candidate.attemptNumber, logicalTaskId: candidate.logicalTaskId,
      moduleName: candidate.moduleName, preparedByInstanceId: candidate.preparedByInstanceId,
      candidateDigest: candidate.candidateDigest, executionId,
      capturedInstanceId: capturedLease.instanceId, capturedLeaseEpoch: capturedLease.leaseEpoch,
      capturedCheckpointId: capturedLease.capturedCheckpointId, checkpointThreadId: capturedLease.checkpointThreadId,
      idempotencyKey,
    });

    if (candidate.simulateWorkerStall && alreadyStalled && stallDisposition === "RESUME_AND_ATTEMPT_WRITE") {
      await this.fencing.resumeFrozenStalledWorker(executionId);
      await this.waitUntil(() => this.fencing.hasZombieFullyFenced(executionId), 600);
    }

    return this.toStagedDto(candidate, executionId, idempotencyKey, staged.committedByInstanceId, staged.leaseEpoch, staged.artifactId, staged.artifactPath);
  }

  private resolveStallDisposition(): StallDisposition {
    const env = this.applicationContext.environment;
    if (env.crashWorkerOnStall) return "TERMINATED_BEFORE_WRITE";
    if (env.skipStaleWriteAttempt) return "SUSPENDED_BEFORE_WRITE";
    return "RESUME_AND_ATTEMPT_WRITE";
  }

  private async runStalledZombiePath(
    candidate: PreparedModuleCandidateDto, executionId: string, idempotencyKey: string,
    capturedLease: CapturedStepLease, stallDisposition: StallDisposition,
  ): Promise<StagedModuleArtifactDto> {
    const osFreeze = this.applicationContext.environment.osFreeze;
    if (osFreeze) await this.clock.sleep(seconds(0.5));
    await this.fencing.initiateWorkerStallAndExpireLease({
      releaseId: candidate.releaseId, attemptNumber: candidate.attemptNumber,
      logicalTaskId: candidate.logicalTaskId, moduleName: candidate.moduleName,
      executionId, instanceId: capturedLease.instanceId, leaseEpoch: capturedLease.leaseEpoch,
      idempotencyKey, stallDisposition,
      targetArtifactId: `art:${candidate.releaseId}:a${String(candidate.attemptNumber)}:${candidate.moduleName}`,
      capturedCheckpointId: capturedLease.capturedCheckpointId, checkpointThreadId: capturedLease.checkpointThreadId,
      skipSyntheticLeaseExpiry: osFreeze,
    });

    if (stallDisposition === "TERMINATED_BEFORE_WRITE") process.exit(137);
    if (stallDisposition === "SUSPENDED_BEFORE_WRITE") {
      return this.suspendWithoutProtectedWriteAttempt(candidate, executionId, capturedLease.leaseEpoch, osFreeze);
    }
    if (osFreeze) {
      process.kill(process.pid, "SIGSTOP");
      await this.clock.sleep(seconds(0.05));
    }

    await this.waitForReplacementCommit(candidate, capturedLease.leaseEpoch + 1);
    return this.attemptStaleProtectedWrite(candidate, executionId, idempotencyKey, capturedLease);
  }

  private async suspendWithoutProtectedWriteAttempt(
    candidate: PreparedModuleCandidateDto, executionId: string, staleEpoch: number, osFreeze: boolean,
  ): Promise<never> {
    if (osFreeze) {
      process.kill(process.pid, "SIGSTOP");
      throw new ExecutionLeaseLostError(executionId);
    }
    await this.waitUntil(
      async () =>
        this.executionContext.signal.aborted ||
        (await this.fencing.hasReplacementWorkerCommitted({
          releaseId: candidate.releaseId, attemptNumber: candidate.attemptNumber,
          logicalTaskId: candidate.logicalTaskId, minLeaseEpoch: staleEpoch + 1,
        })),
      3_600,
    );
    throw new ExecutionLeaseLostError(executionId);
  }

  private async attemptStaleProtectedWrite(
    candidate: PreparedModuleCandidateDto, executionId: string, idempotencyKey: string, capturedLease: CapturedStepLease,
  ): Promise<StagedModuleArtifactDto> {
    try {
      const staged = await this.ledger.stageModuleArtifact({
        releaseId: candidate.releaseId, version: candidate.version,
        attemptNumber: candidate.attemptNumber, logicalTaskId: candidate.logicalTaskId,
        moduleName: candidate.moduleName, preparedByInstanceId: candidate.preparedByInstanceId,
        candidateDigest: candidate.candidateDigest, executionId,
        capturedInstanceId: capturedLease.instanceId, capturedLeaseEpoch: capturedLease.leaseEpoch,
        capturedCheckpointId: capturedLease.capturedCheckpointId, checkpointThreadId: capturedLease.checkpointThreadId,
        idempotencyKey,
      });
      return this.toStagedDto(candidate, executionId, idempotencyKey, staged.committedByInstanceId, staged.leaseEpoch, staged.artifactId, staged.artifactPath);
    } catch (error) {
      if (!(error instanceof StaleLeaseFenceError)) throw error;
      await this.fencing.observeAbortedLeaseSignal({
        executionId, staleInstanceId: capturedLease.instanceId,
        staleLeaseEpoch: capturedLease.leaseEpoch, signal: this.executionContext.signal,
      });
      return this.toStagedDto(candidate, executionId, idempotencyKey, capturedLease.instanceId, capturedLease.leaseEpoch, `stale:${candidate.releaseId}:${candidate.moduleName}`, "fenced-by-ledger");
    }
  }

  private waitForReplacementCommit(candidate: PreparedModuleCandidateDto, minLeaseEpoch: number): Promise<void> {
    return this.waitUntil(
      () => this.fencing.hasReplacementWorkerCommitted({
        releaseId: candidate.releaseId, attemptNumber: candidate.attemptNumber,
        logicalTaskId: candidate.logicalTaskId, minLeaseEpoch,
      }),
      3_600,
    );
  }

  private async waitUntil(predicate: () => Promise<boolean>, maxTicks: number): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if (await predicate()) return;
      await this.clock.sleep(seconds(0.025));
    }
  }

  private toStagedDto(
    candidate: PreparedModuleCandidateDto, executionId: string, idempotencyKey: string,
    committedByInstanceId: string, leaseEpoch: number, artifactId: string, artifactPath: string,
  ): StagedModuleArtifactDto {
    return {
      logicalTaskId: candidate.logicalTaskId, releaseId: candidate.releaseId,
      version: candidate.version, attemptNumber: candidate.attemptNumber,
      moduleName: candidate.moduleName, executionId,
      preparedByInstanceId: candidate.preparedByInstanceId, committedByInstanceId,
      leaseEpoch, idempotencyKey, artifactId, artifactPath, status: "STAGED",
    };
  }
}
