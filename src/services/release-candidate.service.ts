import { ApplicationContext, Clock, Injectable } from "@agboss/core";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "../repositories/ledger-database.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "../repositories/release-candidate.repository.js";
import { LeaseFencingService } from "./lease-fencing.service.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

@Injectable({
  deps: [
    Clock,
    ApplicationContext,
    LedgerDatabaseRepository,
    ReleaseArtifactRepository,
    ReleaseCandidateRepository,
    LeaseFencingService,
    ReleaseArtifactStoreService,
  ],
})
export class ReleaseCandidateService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly candidateRepository: ReleaseCandidateRepository,
    private readonly fencing: LeaseFencingService,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async lockReleaseCandidate(params: {
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly buildFlags: string;
    readonly executionId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly candidateLockId: string;
    readonly stagedModuleCount: number;
    readonly participatingInstances: string;
  }> {
    const instanceId = this.applicationContext.instanceId;
    const now = this.clock.now().getTime();

    return this.ledgerDatabase.inTransaction(async (tx) => {
      const existing = await this.candidateRepository.findByIdempotencyKey(params.idempotencyKey, tx);
      if (existing !== undefined) {
        return {
          candidateLockId: existing.candidateLockId,
          stagedModuleCount: existing.stagedModuleCount,
          participatingInstances: existing.participatingInstances,
        };
      }
      const staged = await this.artifactRepository.findByAttemptAndStatuses(
        { releaseId: params.releaseId, attemptNumber: params.attemptNumber, statuses: ["STAGED"] },
        tx,
      );
      const participatingInstances = [
        ...new Set(staged.flatMap((r) => [r.preparedByInstanceId, r.committedByInstanceId])),
      ].sort().join(",");
      const candidateLockId = `lock:${params.releaseId}:a${String(params.attemptNumber)}`;

      await this.candidateRepository.insert(
        {
          candidateLockId, releaseId: params.releaseId, version: params.version,
          attemptNumber: params.attemptNumber, status: "LOCKED", stagedModuleCount: staged.length,
          participatingInstances, buildFlags: params.buildFlags, idempotencyKey: params.idempotencyKey,
          compensatedByKey: null, failureDiagnostic: null, manifestPath: null,
          createdAt: now, updatedAt: now,
        },
        tx,
      );
      await this.recordBundleEvent(
        params.releaseId, params.attemptNumber, "candidate-lock", params.executionId,
        instanceId, params.idempotencyKey, "LOCK_CANDIDATE", "APPLIED",
        { candidateLockId, stagedModuleCount: staged.length }, now, tx,
      );
      return { candidateLockId, stagedModuleCount: staged.length, participatingInstances };
    });
  }

  async recordSmokeGateFailure(params: {
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
    readonly idempotencyKey: string;
    readonly diagnostic: string;
  }): Promise<void> {
    const now = this.clock.now().getTime();
    await this.ledgerDatabase.inTransaction(async (tx) => {
      await this.candidateRepository.updateFailureDiagnostic(
        { candidateLockId: params.candidateLockId, diagnostic: params.diagnostic, updatedAt: now },
        tx,
      );
      await this.recordBundleEvent(
        params.releaseId, params.attemptNumber, "smoke-gate", params.executionId,
        this.applicationContext.instanceId, params.idempotencyKey, "VERIFY_SMOKE_GATE",
        "FAILED_INJECTED", { diagnostic: params.diagnostic }, now, tx,
      );
    });
  }

  async promoteReleaseCandidate(params: {
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly promotedModuleCount: number;
    readonly participatingInstances: string;
    readonly manifestPath: string;
  }> {
    const instanceId = this.applicationContext.instanceId;
    const now = this.clock.now().getTime();

    return this.ledgerDatabase.inTransaction(async (tx) => {
      const lockRow = await this.candidateRepository.findById(params.candidateLockId, tx);
      if (lockRow?.status === "PROMOTED" && lockRow.manifestPath !== null) {
        return {
          promotedModuleCount: lockRow.stagedModuleCount,
          participatingInstances: lockRow.participatingInstances,
          manifestPath: lockRow.manifestPath,
        };
      }

      const active = await this.artifactRepository.findByAttemptAndStatuses(
        { releaseId: params.releaseId, attemptNumber: params.attemptNumber, statuses: ["STAGED", "PROMOTED"] },
        tx,
      );
      const { manifestPath, promotedModules } = this.artifacts.writePromotedManifests({
        releaseId: params.releaseId, version: params.version, attemptNumber: params.attemptNumber,
        promotedByInstanceId: instanceId, artifacts: active, promotedAtMs: now,
      });

      for (const mod of promotedModules) {
        await this.artifactRepository.markPromoted(
          { artifactId: mod.artifactId, artifactPath: mod.moduleManifestPath, updatedAt: now },
          tx,
        );
      }
      const participatingInstances = [
        ...new Set(active.flatMap((r) => [r.preparedByInstanceId, r.committedByInstanceId])),
      ].sort().join(",");

      await this.candidateRepository.markPromoted(
        { candidateLockId: params.candidateLockId, manifestPath, participatingInstances, updatedAt: now },
        tx,
      );
      await this.recordBundleEvent(
        params.releaseId, params.attemptNumber, "release-promotion", params.executionId,
        instanceId, params.idempotencyKey, "PROMOTE_RELEASE", "APPLIED",
        { manifestPath, promotedModuleCount: promotedModules.length }, now, tx,
      );
      return { promotedModuleCount: promotedModules.length, participatingInstances, manifestPath };
    });
  }

  private recordBundleEvent(
    releaseId: string, attemptNumber: number, suffix: string, executionId: string,
    instanceId: string, idempotencyKey: string, operation: string, outcome: string,
    details: Readonly<Record<string, unknown>>, now: number, tx: LedgerDrizzleExecutor,
  ): Promise<void> {
    return this.fencing.appendEvent(
      {
        releaseId, attemptNumber, logicalTaskId: `${releaseId}:${suffix}`,
        moduleName: "release-bundle", executionId, instanceId, leaseEpoch: 1,
        idempotencyKey, operation, outcome, details, now,
      },
      tx,
    );
  }
}
