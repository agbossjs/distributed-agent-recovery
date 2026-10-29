import { ApplicationContext, Clock, ExecutionLeaseLostError, Injectable } from "@agboss/core";
import { StaleLeaseFenceError } from "../errors/stale-lease-fence.error.js";
import { LeaseFencingRepository } from "../repositories/lease-fencing.repository.js";
import { LedgerDatabaseRepository, type LedgerDrizzleExecutor } from "../repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import type {
  ProtectedWriteRejectionEvidence,
  StaleWriteRejectionReason,
  StallDisposition,
  StallStatus,
} from "../schemas/release-ledger.schema.js";

export interface FenceTaskScope {
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly executionId: string;
}

export interface CapturedStepLease {
  readonly instanceId: string;
  readonly leaseEpoch: number;
  readonly capturedCheckpointId: string | null;
  readonly checkpointThreadId: string | null;
}

export interface LedgerEventInput extends FenceTaskScope {
  readonly instanceId: string;
  readonly leaseEpoch: number;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly outcome: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly now: number;
}

export interface FenceCheckParams extends FenceTaskScope {
  readonly attemptedOperation: "STAGE_ARTIFACT";
  readonly targetArtifactId: string;
  readonly targetStagingArtifactPath: string;
  readonly candidateDigest: string;
  readonly capturedInstanceId: string;
  readonly capturedLeaseEpoch: number;
  readonly capturedCheckpointId: string | null;
  readonly checkpointThreadId: string | null;
  readonly idempotencyKey: string;
  readonly now: number;
}

@Injectable({
  deps: [Clock, ApplicationContext, LedgerDatabaseRepository, LeaseFencingRepository, LedgerEventRepository, ReleaseArtifactRepository],
})
export class LeaseFencingService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly fencingRepository: LeaseFencingRepository,
    private readonly eventRepository: LedgerEventRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
  ) {}

  async captureStepLease(params: {
    readonly executionId: string;
    readonly logicalTaskId: string;
    readonly releaseId: string;
    readonly attemptNumber: number;
  }): Promise<CapturedStepLease> {
    const instanceId = this.applicationContext.instanceId;
    const now = this.clock.now().getTime();
    return this.ledgerDatabase.inTransaction(async (tx) => {
      const lease = await this.fencingRepository.readActiveLease({ executionId: params.executionId, fallbackInstanceId: instanceId }, tx);
      const cp = await this.fencingRepository.readHeadCheckpoint(params.executionId, tx);
      await this.fencingRepository.upsertFencingToken({ ...params, leaseEpoch: lease.leaseEpoch, holderInstanceId: instanceId, updatedAt: now }, tx);
      return { instanceId, leaseEpoch: lease.leaseEpoch, capturedCheckpointId: cp.checkpointId, checkpointThreadId: cp.threadId };
    });
  }

  async initiateWorkerStallAndExpireLease(
    params: FenceTaskScope & {
      readonly instanceId: string;
      readonly leaseEpoch: number;
      readonly idempotencyKey: string;
      readonly stallDisposition: StallDisposition;
      readonly targetArtifactId: string;
      readonly capturedCheckpointId: string | null;
      readonly checkpointThreadId: string | null;
      readonly skipSyntheticLeaseExpiry?: boolean;
    },
  ): Promise<void> {
    const now = this.clock.now().getTime();
    const status: StallStatus = params.stallDisposition === "RESUME_AND_ATTEMPT_WRITE" ? "STALLED" : params.stallDisposition;
    await this.ledgerDatabase.inTransaction(async (tx) => {
      await this.fencingRepository.recordStallAndExpireLease({ ...params, status, now }, tx);
      await this.appendEvent({
        ...params, operation: "WORKER_STALLED_LEASE_EXPIRED", outcome: "STALLED", now,
        details: {
          stalledInstanceId: params.instanceId, stalledLeaseEpoch: params.leaseEpoch,
          stalledPid: process.pid, naturalWallClockExpiry: params.skipSyntheticLeaseExpiry === true,
          stallDisposition: params.stallDisposition, targetArtifactId: params.targetArtifactId,
          capturedCheckpointId: params.capturedCheckpointId, checkpointThreadId: params.checkpointThreadId,
        },
      }, tx);
    });
  }

  async resumeFrozenStalledWorker(executionId: string): Promise<void> {
    if (process.env["AGBOSS_OS_FREEZE"] !== "true") return;
    const stalledPid = await this.eventRepository.findStalledWorkerPid(executionId);
    if (stalledPid !== undefined && stalledPid !== process.pid) {
      try { process.kill(stalledPid, "SIGCONT"); } catch { /* another PID namespace or exited */ }
    }
  }

  async observeAbortedLeaseSignal(params: {
    readonly executionId: string;
    readonly staleInstanceId: string;
    readonly staleLeaseEpoch: number;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (params.signal.aborted && params.signal.reason instanceof ExecutionLeaseLostError) {
      await this.eventRepository.recordRuntimeFenceIfAbsent({
        executionId: params.executionId, staleInstanceId: params.staleInstanceId,
        staleLeaseEpoch: params.staleLeaseEpoch, now: this.clock.now().getTime(),
      });
    }
  }

  hasStalledWorkerForExecution(executionId: string): Promise<boolean> {
    return this.fencingRepository.hasStallForExecution(executionId);
  }

  hasReplacementWorkerCommitted(params: {
    readonly releaseId: string; readonly attemptNumber: number; readonly logicalTaskId: string; readonly minLeaseEpoch: number;
  }): Promise<boolean> {
    return this.artifactRepository.hasActiveCommitAtMinEpoch(params);
  }

  hasZombieFullyFenced(executionId: string): Promise<boolean> {
    return this.eventRepository.hasDistinctOperations(executionId, ["ZOMBIE_WRITE_REJECTED", "RUNTIME_LEASE_FENCED"]);
  }

  async checkAndAdvanceFence(params: FenceCheckParams, tx: LedgerDrizzleExecutor): Promise<StaleLeaseFenceError | undefined> {
    const currentLease = await this.fencingRepository.readActiveLease({ executionId: params.executionId, fallbackInstanceId: this.applicationContext.instanceId }, tx);
    const tokenRow = await this.fencingRepository.findFencingToken(params.executionId, "default", tx);
    const tokenEpoch = tokenRow?.highestLeaseEpoch ?? 1;
    const activeLeaseEpoch = Math.max(currentLease.leaseEpoch, tokenEpoch);
    const activeHolder = tokenRow !== undefined && tokenEpoch > currentLease.leaseEpoch ? tokenRow.currentHolderInstanceId : currentLease.holderInstanceId;
    const epochStale = params.capturedLeaseEpoch < activeLeaseEpoch;
    if (epochStale || (activeHolder !== params.capturedInstanceId && params.capturedLeaseEpoch <= activeLeaseEpoch)) {
      return this.recordRejectionAtBoundary(params, activeHolder, activeLeaseEpoch, epochStale ? "STALE_LEASE_EPOCH" : "LEASE_HOLDER_MISMATCH", tx);
    }
    await this.fencingRepository.upsertFencingToken({
      executionId: params.executionId, logicalTaskId: params.logicalTaskId, releaseId: params.releaseId,
      attemptNumber: params.attemptNumber, leaseEpoch: params.capturedLeaseEpoch, holderInstanceId: params.capturedInstanceId, updatedAt: params.now,
    }, tx);
    return undefined;
  }

  async appendEvent(p: LedgerEventInput, executor?: LedgerDrizzleExecutor): Promise<void> {
    await this.eventRepository.insert({
      releaseId: p.releaseId, attemptNumber: p.attemptNumber, logicalTaskId: p.logicalTaskId,
      moduleName: p.moduleName, executionId: p.executionId, instanceId: p.instanceId,
      leaseEpoch: p.leaseEpoch, idempotencyKey: p.idempotencyKey, operation: p.operation,
      outcome: p.outcome, details: JSON.stringify(p.details), recordedAt: p.now,
    }, executor);
  }

  private async recordRejectionAtBoundary(
    p: FenceCheckParams, activeHolder: string, activeLeaseEpoch: number,
    rejectionReason: StaleWriteRejectionReason, tx: LedgerDrizzleExecutor,
  ): Promise<StaleLeaseFenceError> {
    const headCp = await this.fencingRepository.readHeadCheckpoint(p.executionId, tx);
    await this.fencingRepository.markStallFenced({ executionId: p.executionId, instanceId: p.capturedInstanceId, leaseEpoch: p.capturedLeaseEpoch, updatedAt: p.now }, tx);
    const evidence: ProtectedWriteRejectionEvidence = {
      attemptedOperation: p.attemptedOperation, targetArtifactId: p.targetArtifactId, targetStagingArtifactPath: p.targetStagingArtifactPath,
      candidateDigest: p.candidateDigest, workerInstanceId: p.capturedInstanceId, executionId: p.executionId, releaseId: p.releaseId,
      attemptNumber: p.attemptNumber, logicalTaskId: p.logicalTaskId, moduleName: p.moduleName, idempotencyKey: p.idempotencyKey,
      capturedToken: { holderInstanceId: p.capturedInstanceId, leaseEpoch: p.capturedLeaseEpoch },
      observedToken: { holderInstanceId: activeHolder, leaseEpoch: activeLeaseEpoch },
      rejectionReason, errorCode: StaleLeaseFenceError.code, capturedCheckpointId: p.capturedCheckpointId,
      observedHeadCheckpointId: headCp.checkpointId, checkpointThreadId: headCp.threadId ?? p.checkpointThreadId,
      activeHolderInstanceId: activeHolder, activeLeaseEpoch,
    };
    await this.appendEvent({
      releaseId: p.releaseId, attemptNumber: p.attemptNumber, logicalTaskId: p.logicalTaskId, moduleName: p.moduleName,
      executionId: p.executionId, instanceId: p.capturedInstanceId, leaseEpoch: p.capturedLeaseEpoch, idempotencyKey: p.idempotencyKey,
      operation: "ZOMBIE_WRITE_REJECTED", outcome: "REJECTED_STALE_LEASE", details: { ...evidence }, now: p.now,
    }, tx);
    return new StaleLeaseFenceError({
      attemptedOperation: p.attemptedOperation, targetArtifactId: p.targetArtifactId, logicalTaskId: p.logicalTaskId,
      executionId: p.executionId, staleInstanceId: p.capturedInstanceId, staleLeaseEpoch: p.capturedLeaseEpoch,
      activeHolderInstanceId: activeHolder, activeLeaseEpoch, rejectionReason,
      capturedCheckpointId: p.capturedCheckpointId, observedHeadCheckpointId: headCp.checkpointId,
    });
  }
}
