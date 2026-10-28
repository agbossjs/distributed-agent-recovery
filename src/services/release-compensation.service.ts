import { ApplicationContext, Clock, Injectable } from "@agboss/core";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";
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
export class ReleaseCompensationService {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly candidateRepository: ReleaseCandidateRepository,
    private readonly fencing: LeaseFencingService,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async compensateReleaseCandidate(params: {
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly candidateLockId: string;
    readonly executionId: string;
    readonly compensationIdempotencyKey: string;
  }): Promise<{
    readonly compensatedModuleCount: number;
    readonly failureDiagnostic: string;
    readonly deduplicated: boolean;
  }> {
    const instanceId = this.applicationContext.instanceId;
    const now = this.clock.now().getTime();

    return this.ledgerDatabase.inTransaction(async (tx) => {
      const lockRow = await this.candidateRepository.findById(params.candidateLockId, tx);
      const failureDiagnostic =
        lockRow?.failureDiagnostic ??
        "ABI mismatch detected in staged modules; requires --abi-compat=v2";
      if (lockRow?.status === "COMPENSATED") {
        const cnt = await this.artifactRepository.countByAttemptAndStatuses(
          { releaseId: params.releaseId, attemptNumber: params.attemptNumber, statuses: ["COMPENSATED"] },
          tx,
        );
        return { compensatedModuleCount: cnt, failureDiagnostic, deduplicated: true };
      }

      const active = await this.artifactRepository.findByAttemptAndStatuses(
        {
          releaseId: params.releaseId,
          attemptNumber: params.attemptNumber,
          statuses: ["STAGED"],
          orderByCreatedDesc: true,
        },
        tx,
      );
      for (const art of active) {
        this.artifacts.removeArtifactFile(art.artifactPath);
        await this.artifactRepository.markCompensated(
          {
            artifactId: art.artifactId,
            compensatedByKey: params.compensationIdempotencyKey,
            updatedAt: now,
          },
          tx,
        );
        await this.fencing.appendEvent(
          {
            releaseId: params.releaseId,
            attemptNumber: params.attemptNumber,
            logicalTaskId: art.logicalTaskId,
            moduleName: art.moduleName,
            executionId: params.executionId,
            instanceId,
            leaseEpoch: 1,
            idempotencyKey: `${params.compensationIdempotencyKey}:${art.moduleName}`,
            operation: "COMPENSATE_ARTIFACT",
            outcome: "COMPENSATED",
            details: { artifactId: art.artifactId },
            now,
          },
          tx,
        );
      }

      await this.candidateRepository.markCompensated(
        {
          candidateLockId: params.candidateLockId,
          compensatedByKey: params.compensationIdempotencyKey,
          updatedAt: now,
        },
        tx,
      );
      await this.fencing.appendEvent(
        {
          releaseId: params.releaseId,
          attemptNumber: params.attemptNumber,
          logicalTaskId: `${params.releaseId}:candidate-lock`,
          moduleName: "release-bundle",
          executionId: params.executionId,
          instanceId,
          leaseEpoch: 1,
          idempotencyKey: params.compensationIdempotencyKey,
          operation: "COMPENSATE_CANDIDATE",
          outcome: "COMPENSATED",
          details: { compensatedModuleCount: active.length },
          now,
        },
        tx,
      );
      return { compensatedModuleCount: active.length, failureDiagnostic, deduplicated: false };
    });
  }
}
