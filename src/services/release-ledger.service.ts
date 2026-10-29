import { Clock, Injectable } from "@agboss/core";
import { LedgerDatabaseRepository, type LedgerDrizzleExecutor } from "../repositories/ledger-database.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "../repositories/release-candidate.repository.js";
import type { LedgerSnapshot } from "../schemas/release-ledger.schema.js";
import { LeaseFencingService } from "./lease-fencing.service.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

export interface StageModuleParams {
  readonly releaseId: string;
  readonly version: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly preparedByInstanceId: string;
  readonly candidateDigest: string;
  readonly executionId: string;
  readonly capturedInstanceId: string;
  readonly capturedLeaseEpoch: number;
  readonly capturedCheckpointId?: string | null;
  readonly checkpointThreadId?: string | null;
  readonly idempotencyKey: string;
}

export interface StagedModuleOutcome {
  readonly artifactId: string;
  readonly artifactPath: string;
  readonly committedByInstanceId: string;
  readonly leaseEpoch: number;
  readonly deduplicated: boolean;
}

export interface PrepareModuleParams {
  readonly releaseId: string;
  readonly version: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly buildFlags: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
}

@Injectable({
  deps: [Clock, LedgerDatabaseRepository, ReleaseArtifactRepository, ReleaseCandidateRepository, LeaseFencingService, ReleaseArtifactStoreService],
})
export class ReleaseLedgerService {
  constructor(
    private readonly clock: Clock,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly candidateRepository: ReleaseCandidateRepository,
    private readonly fencing: LeaseFencingService,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async recordModulePreparation(params: PrepareModuleParams): Promise<{
    readonly preparedByInstanceId: string;
    readonly preparedUnderLeaseEpoch: number;
    readonly candidateDigest: string;
  }> {
    const captured = await this.fencing.captureStepLease(params);
    const now = this.clock.now().getTime();
    const candidateDigest = `sha256:${params.releaseId}:a${String(params.attemptNumber)}:${params.moduleName}:${params.buildFlags.replace(/\s+/gu, "_")}`;
    await this.fencing.appendEvent({
      releaseId: params.releaseId, attemptNumber: params.attemptNumber, logicalTaskId: params.logicalTaskId,
      moduleName: params.moduleName, executionId: params.executionId, instanceId: captured.instanceId,
      leaseEpoch: captured.leaseEpoch, idempotencyKey: params.idempotencyKey,
      operation: "PREPARE_MODULE", outcome: "APPLIED", details: { buildFlags: params.buildFlags, candidateDigest }, now,
    });
    return { preparedByInstanceId: captured.instanceId, preparedUnderLeaseEpoch: captured.leaseEpoch, candidateDigest };
  }

  async stageModuleArtifact(params: StageModuleParams): Promise<StagedModuleOutcome> {
    const now = this.clock.now().getTime();
    const artifactId = `art:${params.releaseId}:a${String(params.attemptNumber)}:${params.moduleName}`;
    const artifactPath = this.artifacts.resolveStagedArtifactPath(params);
    const capturedCheckpointId = params.capturedCheckpointId ?? null;
    const checkpointThreadId = params.checkpointThreadId ?? null;

    const outcome = await this.ledgerDatabase.inTransaction(async (tx) => {
      const fencedError = await this.fencing.checkAndAdvanceFence({
        ...params, attemptedOperation: "STAGE_ARTIFACT", targetArtifactId: artifactId,
        targetStagingArtifactPath: artifactPath, capturedCheckpointId, checkpointThreadId, now,
      }, tx);
      if (fencedError !== undefined) return { fencedError, result: undefined };

      const existing = await this.artifactRepository.findByIdempotencyKey(params.idempotencyKey, tx);
      if (existing !== undefined && existing.status !== "COMPENSATED") {
        return {
          fencedError: undefined,
          result: {
            artifactId: existing.artifactId, artifactPath: existing.artifactPath,
            committedByInstanceId: existing.committedByInstanceId, leaseEpoch: existing.leaseEpoch, deduplicated: true,
          },
        };
      }

      if (params.capturedLeaseEpoch > 1) {
        await this.fencing.appendEvent({
          releaseId: params.releaseId, attemptNumber: params.attemptNumber, logicalTaskId: params.logicalTaskId,
          moduleName: params.moduleName, executionId: params.executionId, instanceId: params.capturedInstanceId,
          leaseEpoch: params.capturedLeaseEpoch, idempotencyKey: params.idempotencyKey,
          operation: "LEASE_TAKEOVER_COMPLETED", outcome: "APPLIED",
          details: { preparedByInstanceId: params.preparedByInstanceId, takenOverByInstanceId: params.capturedInstanceId, capturedCheckpointId, checkpointThreadId },
          now,
        }, tx);
      }
      return {
        fencedError: undefined,
        result: await this.insertStagedArtifactRow(params, artifactId, artifactPath, capturedCheckpointId, checkpointThreadId, now, tx),
      };
    });

    if (outcome.fencedError !== undefined) throw outcome.fencedError;
    if (!outcome.result.deduplicated) {
      this.artifacts.writeStagedArtifact({
        artifactId, releaseId: params.releaseId, version: params.version, attemptNumber: params.attemptNumber,
        logicalTaskId: params.logicalTaskId, moduleName: params.moduleName, executionId: params.executionId,
        preparedByInstanceId: params.preparedByInstanceId, committedByInstanceId: params.capturedInstanceId,
        leaseEpoch: params.capturedLeaseEpoch, idempotencyKey: params.idempotencyKey,
        candidateDigest: params.candidateDigest, stagedAtMs: now,
      });
    }
    return outcome.result;
  }

  async inspectFailedAttempt(releaseId: string, attemptNumber: number): Promise<{
    readonly compensatedCount: number;
    readonly activeRemainingCount: number;
    readonly allCompensated: boolean;
    readonly ledgerDiagnostic: string;
  }> {
    const compensatedCount = await this.artifactRepository.countByAttemptAndStatuses({ releaseId, attemptNumber, statuses: ["COMPENSATED"] });
    const activeRemainingCount = await this.artifactRepository.countByAttemptAndStatuses({ releaseId, attemptNumber, statuses: ["STAGED", "PROMOTED"] });
    const diag = await this.candidateRepository.findFailureDiagnostic(releaseId, attemptNumber);
    return {
      compensatedCount, activeRemainingCount, allCompensated: compensatedCount > 0 && activeRemainingCount === 0,
      ledgerDiagnostic: diag ?? "ABI symbol mismatch in payment-engine; append --abi-compat=v2 to buildFlags on retry",
    };
  }

  getSnapshot(releaseId?: string): Promise<LedgerSnapshot> {
    return ReleaseArtifactRepository.readSnapshotFromFile({
      sqlitePath: this.ledgerDatabase.path, artifactDir: this.artifacts.artifactDir(),
      ...(releaseId === undefined ? {} : { releaseId }),
    });
  }

  private async insertStagedArtifactRow(
    params: StageModuleParams, artifactId: string, artifactPath: string,
    capturedCheckpointId: string | null, checkpointThreadId: string | null, now: number, tx: LedgerDrizzleExecutor,
  ): Promise<StagedModuleOutcome> {
    await this.artifactRepository.insert({
      artifactId, releaseId: params.releaseId, version: params.version, attemptNumber: params.attemptNumber,
      logicalTaskId: params.logicalTaskId, moduleName: params.moduleName, executionId: params.executionId,
      preparedByInstanceId: params.preparedByInstanceId, committedByInstanceId: params.capturedInstanceId,
      leaseEpoch: params.capturedLeaseEpoch, idempotencyKey: params.idempotencyKey, status: "STAGED",
      artifactPath, candidateDigest: params.candidateDigest, compensatedByKey: null, createdAt: now, updatedAt: now,
    }, tx);
    await this.fencing.appendEvent({
      releaseId: params.releaseId, attemptNumber: params.attemptNumber, logicalTaskId: params.logicalTaskId,
      moduleName: params.moduleName, executionId: params.executionId, instanceId: params.capturedInstanceId,
      leaseEpoch: params.capturedLeaseEpoch, idempotencyKey: params.idempotencyKey, operation: "STAGE_ARTIFACT",
      outcome: "APPLIED",
      details: { artifactId, artifactPath, leaseEpoch: params.capturedLeaseEpoch, candidateDigest: params.candidateDigest, capturedCheckpointId, checkpointThreadId },
      now,
    }, tx);
    return { artifactId, artifactPath, committedByInstanceId: params.capturedInstanceId, leaseEpoch: params.capturedLeaseEpoch, deduplicated: false };
  }
}
