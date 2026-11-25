import { ApplicationContext, Clock, Idempotency, IdempotencyRunStatus, Injectable } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";
import { ModulePreparationRepository } from "../repositories/module-preparation.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

/** The ledger's effects live as long as a late zombie can still reach them: far above the lease. */
const EFFECT_TTL = hours(24);

export interface PrepareModuleParams {
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly buildFlags: string;
  readonly executionId: string;
}

export interface PreparedModuleOutcome {
  readonly preparedByInstanceId: string;
  readonly candidateDigest: string;
}

export interface StageModuleParams {
  readonly releaseId: string;
  readonly version: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly preparedByInstanceId: string;
  readonly candidateDigest: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
}

export interface StagedModuleOutcome {
  readonly artifactId: string;
  readonly artifactPath: string;
  readonly committedByInstanceId: string;
  /** The fencing token the write was committed under (the replacement's, after a takeover). */
  readonly fencingToken: number;
  readonly replayed: boolean;
}

/** What one effect stores: only receipts, never documents. */
interface StagedReceipt {
  readonly artifactId: string;
  readonly artifactPath: string;
  readonly committedByInstanceId: string;
  readonly stagedAtMs: number;
}

/**
 * Every write of a module task is a fenced effect (`Idempotency.runOnce`, #500): the ledger's rows
 * and the effect's stored result commit in one SQLite transaction, checked against the step's lease
 * — a worker whose lease was taken over is refused before it writes (`ExecutionError.Fenced`), and
 * a step run again after a crash replays the stored receipt. The ledger keeps no fencing table of
 * its own. Files are written after the effect from its receipt, the same content for a replay.
 */
@Injectable({
  deps: [
    Clock,
    ApplicationContext,
    Idempotency,
    LedgerDatabaseRepository,
    ReleaseArtifactRepository,
    ModulePreparationRepository,
    LedgerEventRepository,
    ReleaseArtifactStoreService,
  ],
})
export class ReleaseLedgerService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly idempotency: Idempotency,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly preparationRepository: ModulePreparationRepository,
    private readonly eventRepository: LedgerEventRepository,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async recordModulePreparation(params: PrepareModuleParams): Promise<PreparedModuleOutcome> {
    const { result } = await this.idempotency.runOnce({
      name: "prepare-module",
      ttl: EFFECT_TTL,
      execute: async (): Promise<PreparedModuleOutcome> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
        const preparedByInstanceId = this.applicationContext.instanceId;
        const candidateDigest = `sha256:${params.releaseId}:a${String(params.attemptNumber)}:${params.moduleName}:${params.buildFlags.replace(/\s+/gu, "_")}`;
        await this.preparationRepository.insertIfAbsent(
          {
            executionId: params.executionId,
            releaseId: params.releaseId,
            attemptNumber: params.attemptNumber,
            logicalTaskId: params.logicalTaskId,
            moduleName: params.moduleName,
            preparedByInstanceId,
            candidateDigest,
            createdAt: now,
          },
          tx,
        );
        await this.eventRepository.insert(
          {
            releaseId: params.releaseId,
            attemptNumber: params.attemptNumber,
            executionId: params.executionId,
            instanceId: preparedByInstanceId,
            fencingToken: null,
            operation: "PREPARE_MODULE",
            outcome: "APPLIED",
            details: JSON.stringify({ moduleName: params.moduleName, buildFlags: params.buildFlags, candidateDigest }),
            recordedAt: now,
          },
          tx,
        );
        return { preparedByInstanceId, candidateDigest };
      },
    });
    return result;
  }

  async stageModuleArtifact(params: StageModuleParams): Promise<StagedModuleOutcome> {
    const outcome = await this.idempotency.runOnce({
      name: "stage-module-artifact",
      ttl: EFFECT_TTL,
      execute: async (): Promise<StagedReceipt> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
        const committedByInstanceId = this.applicationContext.instanceId;
        const artifactId = `art:${params.releaseId}:a${String(params.attemptNumber)}:${params.moduleName}`;
        const artifactPath = this.artifacts.stagedArtifactPath(params);
        await this.artifactRepository.insert(
          {
            artifactId,
            releaseId: params.releaseId,
            version: params.version,
            attemptNumber: params.attemptNumber,
            logicalTaskId: params.logicalTaskId,
            moduleName: params.moduleName,
            executionId: params.executionId,
            preparedByInstanceId: params.preparedByInstanceId,
            committedByInstanceId,
            idempotencyKey: params.idempotencyKey,
            status: "STAGED",
            artifactPath,
            candidateDigest: params.candidateDigest,
            compensatedByKey: null,
            createdAt: now,
            updatedAt: now,
          },
          tx,
        );
        await this.eventRepository.insert(
          {
            releaseId: params.releaseId,
            attemptNumber: params.attemptNumber,
            executionId: params.executionId,
            instanceId: committedByInstanceId,
            fencingToken: null,
            operation: "STAGE_ARTIFACT",
            outcome: "APPLIED",
            details: JSON.stringify({ artifactId, artifactPath, preparedByInstanceId: params.preparedByInstanceId }),
            recordedAt: now,
          },
          tx,
        );
        return { artifactId, artifactPath, committedByInstanceId, stagedAtMs: now };
      },
    });
    const receipt = outcome.result;
    this.artifacts.writeStagedArtifact({
      ...params,
      artifactId: receipt.artifactId,
      committedByInstanceId: receipt.committedByInstanceId,
      fencingToken: outcome.token,
      stagedAtMs: receipt.stagedAtMs,
    });
    return {
      artifactId: receipt.artifactId,
      artifactPath: receipt.artifactPath,
      committedByInstanceId: receipt.committedByInstanceId,
      fencingToken: outcome.token,
      replayed: outcome.status !== IdempotencyRunStatus.Ran,
    };
  }
}
