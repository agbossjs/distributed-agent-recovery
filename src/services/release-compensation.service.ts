import { ApplicationContext, Clock, Idempotency, Injectable } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "../repositories/release-candidate.repository.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

export interface CompensationReceipt {
  readonly compensatedModuleCount: number;
  readonly failureDiagnostic: string;
  /** The staged files the undo removed, newest first. */
  readonly removedPaths: readonly string[];
}

/**
 * The saga's undo of a locked release candidate: every staged artifact of the failed attempt is marked
 * COMPENSATED (newest first) and the candidate with them — in one fenced effect, so a worker or a
 * resumed side path that runs it twice compensates once. The staged files are removed after the
 * effect, from its receipt: removing a file twice is a no-op.
 */
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
export class ReleaseCompensationService {
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

  async compensateReleaseCandidate(params: {
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
    readonly compensationIdempotencyKey: string;
  }): Promise<CompensationReceipt> {
    const { result } = await this.idempotency.runOnce({
      name: "compensate-release-candidate",
      ttl: hours(24),
      execute: async (): Promise<CompensationReceipt> => {
        const tx = this.ledgerDatabase.effectDb();
        const now = this.clock.now().getTime();
        const instanceId = this.applicationContext.instanceId;
        const lockRow = await this.candidateRepository.findById(params.candidateLockId, tx);
        const failureDiagnostic =
          lockRow?.failureDiagnostic ?? "ABI mismatch detected in staged modules; requires --abi-compat=v2";
        const active = await this.artifactRepository.findByAttemptAndStatuses(
          { releaseId: params.releaseId, attemptNumber: params.attemptNumber, statuses: ["STAGED"], orderByCreatedDesc: true },
          tx,
        );
        for (const art of active) {
          await this.artifactRepository.markCompensated(
            { artifactId: art.artifactId, compensatedByKey: params.compensationIdempotencyKey, updatedAt: now },
            tx,
          );
          await this.eventRepository.insert(
            {
              releaseId: params.releaseId, attemptNumber: params.attemptNumber, executionId: params.executionId,
              instanceId, fencingToken: null, operation: "COMPENSATE_ARTIFACT", outcome: "COMPENSATED",
              details: JSON.stringify({ artifactId: art.artifactId, moduleName: art.moduleName }), recordedAt: now,
            },
            tx,
          );
        }
        await this.candidateRepository.markCompensated(
          { candidateLockId: params.candidateLockId, compensatedByKey: params.compensationIdempotencyKey, updatedAt: now },
          tx,
        );
        await this.eventRepository.insert(
          {
            releaseId: params.releaseId, attemptNumber: params.attemptNumber, executionId: params.executionId,
            instanceId, fencingToken: null, operation: "COMPENSATE_CANDIDATE", outcome: "COMPENSATED",
            details: JSON.stringify({ compensatedModuleCount: active.length }), recordedAt: now,
          },
          tx,
        );
        return {
          compensatedModuleCount: active.length,
          failureDiagnostic,
          removedPaths: active.map((art) => art.artifactPath),
        };
      },
    });
    for (const path of result.removedPaths) {
      this.artifacts.removeArtifactFile(path);
    }
    return result;
  }
}
