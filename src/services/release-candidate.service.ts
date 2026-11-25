import { ApplicationContext, Clock, Idempotency, Injectable } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "../repositories/release-candidate.repository.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

const EFFECT_TTL = hours(24);

export interface LockedCandidate {
  readonly candidateLockId: string;
  readonly stagedModuleCount: number;
  readonly participatingInstances: string;
}

export interface PromotedCandidate {
  readonly promotedModuleCount: number;
  readonly participatingInstances: string;
  readonly manifestPath: string;
  readonly promotedAtMs: number;
}

/** The release candidate's own writes — lock, smoke-gate verdict, promotion — each a fenced effect. */
@Injectable({
  deps: [
    Clock,
    ApplicationContext,
    Idempotency,
    LedgerDatabaseRepository,
    ReleaseArtifactRepository,
    ReleaseCandidateRepository,
    LedgerEventRepository,
    ReleaseArtifactStoreService,
  ],
})
export class ReleaseCandidateService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly idempotency: Idempotency,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly candidateRepository: ReleaseCandidateRepository,
    private readonly eventRepository: LedgerEventRepository,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async lockReleaseCandidate(params: {
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly buildFlags: string;
    readonly executionId: string;
    readonly idempotencyKey: string;
  }): Promise<LockedCandidate> {
    const { result } = await this.idempotency.runOnce({
      name: "lock-release-candidate",
      ttl: EFFECT_TTL,
      execute: async (): Promise<LockedCandidate> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
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
        await this.bundleEvent(params, "LOCK_CANDIDATE", "APPLIED", { candidateLockId, stagedModuleCount: staged.length }, now, tx);
        return { candidateLockId, stagedModuleCount: staged.length, participatingInstances };
      },
    });
    return result;
  }

  async recordSmokeGateFailure(params: {
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
    readonly diagnostic: string;
  }): Promise<void> {
    await this.idempotency.runOnce({
      name: "record-smoke-gate-failure",
      ttl: EFFECT_TTL,
      execute: async (): Promise<{ readonly recorded: true }> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
        await this.candidateRepository.updateFailureDiagnostic(
          { candidateLockId: params.candidateLockId, diagnostic: params.diagnostic, updatedAt: now },
          tx,
        );
        await this.bundleEvent(params, "VERIFY_SMOKE_GATE", "FAILED_INJECTED", { diagnostic: params.diagnostic }, now, tx);
        return { recorded: true };
      },
    });
  }

  async promoteReleaseCandidate(params: {
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
  }): Promise<PromotedCandidate> {
    const { result } = await this.idempotency.runOnce({
      name: "promote-release-candidate",
      ttl: EFFECT_TTL,
      execute: async (): Promise<PromotedCandidate> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
        const active = await this.artifactRepository.findByAttemptAndStatuses(
          { releaseId: params.releaseId, attemptNumber: params.attemptNumber, statuses: ["STAGED", "PROMOTED"] },
          tx,
        );
        for (const art of active) {
          await this.artifactRepository.markPromoted(
            { artifactId: art.artifactId, artifactPath: this.artifacts.moduleManifestPath(art.releaseId, art.moduleName), updatedAt: now },
            tx,
          );
        }
        const participatingInstances = [
          ...new Set(active.flatMap((r) => [r.preparedByInstanceId, r.committedByInstanceId])),
        ].sort().join(",");
        const manifestPath = this.artifacts.releaseManifestPath(params.releaseId);
        await this.candidateRepository.markPromoted(
          { candidateLockId: params.candidateLockId, manifestPath, participatingInstances, updatedAt: now },
          tx,
        );
        await this.bundleEvent(params, "PROMOTE_RELEASE", "APPLIED", { manifestPath, promotedModuleCount: active.length }, now, tx);
        return { promotedModuleCount: active.length, participatingInstances, manifestPath, promotedAtMs: now };
      },
    });
    await this.writeManifests(params, result);
    return result;
  }

  /** The manifests are files: written after the effect from its receipt, the same content on a replay. */
  private async writeManifests(
    params: { readonly releaseId: string; readonly version: string; readonly attemptNumber: number },
    promoted: PromotedCandidate,
  ): Promise<void> {
    const active = await this.artifactRepository.findByAttemptAndStatuses({
      releaseId: params.releaseId,
      attemptNumber: params.attemptNumber,
      statuses: ["PROMOTED"],
    });
    this.artifacts.writePromotedManifests({
      releaseId: params.releaseId,
      version: params.version,
      attemptNumber: params.attemptNumber,
      promotedByInstanceId: this.applicationContext.instanceId,
      artifacts: active,
      promotedAtMs: promoted.promotedAtMs,
    });
  }

  private bundleEvent(
    params: { readonly releaseId: string; readonly attemptNumber: number; readonly executionId: string },
    operation: string,
    outcome: string,
    details: Readonly<Record<string, unknown>>,
    now: number,
    tx: ReturnType<LedgerDatabaseRepository["effectDb"]>,
  ): Promise<void> {
    return this.eventRepository.insert(
      {
        releaseId: params.releaseId,
        attemptNumber: params.attemptNumber,
        executionId: params.executionId,
        instanceId: this.applicationContext.instanceId,
        fencingToken: null,
        operation,
        outcome,
        details: JSON.stringify(details),
        recordedAt: now,
      },
      tx,
    );
  }
}
