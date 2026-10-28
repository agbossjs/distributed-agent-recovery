import { ApplicationContext, Clock, ExecutionLeaseLostError, Injectable } from "@agboss/core";
import { StaleLeaseFenceError } from "../errors/stale-lease-fence.error.js";
import { LeaseFencingRepository } from "../repositories/lease-fencing.repository.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "../repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";

export interface FenceTaskScope {
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly executionId: string;
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
  readonly capturedInstanceId: string;
  readonly capturedLeaseEpoch: number;
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
  }): Promise<{ readonly instanceId: string; readonly leaseEpoch: number }> {
    const instanceId = this.applicationContext.instanceId;
    const now = this.clock.now().getTime();
    return this.ledgerDatabase.inTransaction(async (tx) => {
      const lease = await this.fencingRepository.readActiveLease({ executionId: params.executionId, fallbackInstanceId: instanceId }, tx);
      await this.fencingRepository.upsertFencingToken({ ...params, leaseEpoch: lease.leaseEpoch, holderInstanceId: instanceId, updatedAt: now }, tx);
      return { instanceId, leaseEpoch: lease.leaseEpoch };
    });
  }

  async initiateWorkerStallAndExpireLease(
    params: FenceTaskScope & {
      readonly instanceId: string;
      readonly leaseEpoch: number;
      readonly idempotencyKey: string;
      readonly skipSyntheticLeaseExpiry?: boolean;
    },
  ): Promise<void> {
    const now = this.clock.now().getTime();
    await this.ledgerDatabase.inTransaction(async (tx) => {
      await this.fencingRepository.recordStallAndExpireLease({ ...params, now }, tx);
      await this.appendEvent(
        {
          ...params, operation: "WORKER_STALLED_LEASE_EXPIRED", outcome: "STALLED", now,
          details: {
            stalledInstanceId: params.instanceId, stalledLeaseEpoch: params.leaseEpoch,
            stalledPid: process.pid, naturalWallClockExpiry: params.skipSyntheticLeaseExpiry === true,
          },
        },
        tx,
      );
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
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly logicalTaskId: string;
    readonly minLeaseEpoch: number;
  }): Promise<boolean> {
    return this.artifactRepository.hasActiveCommitAtMinEpoch(params);
  }

  hasZombieFullyFenced(executionId: string): Promise<boolean> {
    return this.eventRepository.hasDistinctOperations(executionId, [
      "ZOMBIE_WRITE_REJECTED",
      "RUNTIME_LEASE_FENCED",
    ]);
  }

  async checkAndAdvanceFence(
    params: FenceCheckParams,
    tx: LedgerDrizzleExecutor,
  ): Promise<StaleLeaseFenceError | undefined> {
    const currentLease = await this.fencingRepository.readActiveLease(
      { executionId: params.executionId, fallbackInstanceId: this.applicationContext.instanceId },
      tx,
    );
    const tokenRow = await this.fencingRepository.findFencingToken(params.executionId, "default", tx);
    const tokenEpoch = tokenRow?.highestLeaseEpoch ?? 1;
    const activeLeaseEpoch = Math.max(currentLease.leaseEpoch, tokenEpoch);
    const activeHolder =
      tokenRow !== undefined && tokenEpoch > currentLease.leaseEpoch
        ? tokenRow.currentHolderInstanceId
        : currentLease.holderInstanceId;

    if (
      params.capturedLeaseEpoch < activeLeaseEpoch ||
      (activeHolder !== params.capturedInstanceId && params.capturedLeaseEpoch <= activeLeaseEpoch)
    ) {
      await this.fencingRepository.markStallFenced(
        { executionId: params.executionId, instanceId: params.capturedInstanceId, leaseEpoch: params.capturedLeaseEpoch, updatedAt: params.now },
        tx,
      );
      await this.appendEvent(
        {
          releaseId: params.releaseId, attemptNumber: params.attemptNumber,
          logicalTaskId: params.logicalTaskId, moduleName: params.moduleName,
          executionId: params.executionId, instanceId: params.capturedInstanceId,
          leaseEpoch: params.capturedLeaseEpoch, idempotencyKey: params.idempotencyKey,
          operation: "ZOMBIE_WRITE_REJECTED", outcome: "REJECTED_STALE_LEASE",
          details: { activeHolderInstanceId: activeHolder, activeLeaseEpoch }, now: params.now,
        },
        tx,
      );
      return new StaleLeaseFenceError({
        logicalTaskId: params.logicalTaskId, executionId: params.executionId,
        staleInstanceId: params.capturedInstanceId, staleLeaseEpoch: params.capturedLeaseEpoch,
        activeHolderInstanceId: activeHolder, activeLeaseEpoch,
      });
    }

    await this.fencingRepository.upsertFencingToken(
      {
        executionId: params.executionId, logicalTaskId: params.logicalTaskId,
        releaseId: params.releaseId, attemptNumber: params.attemptNumber,
        leaseEpoch: params.capturedLeaseEpoch, holderInstanceId: params.capturedInstanceId,
        updatedAt: params.now,
      },
      tx,
    );
    return undefined;
  }

  async appendEvent(p: LedgerEventInput, executor?: LedgerDrizzleExecutor): Promise<void> {
    await this.eventRepository.insert(
      {
        releaseId: p.releaseId, attemptNumber: p.attemptNumber, logicalTaskId: p.logicalTaskId,
        moduleName: p.moduleName, executionId: p.executionId, instanceId: p.instanceId,
        leaseEpoch: p.leaseEpoch, idempotencyKey: p.idempotencyKey, operation: p.operation,
        outcome: p.outcome, details: JSON.stringify(p.details), recordedAt: p.now,
      },
      executor,
    );
  }
}
