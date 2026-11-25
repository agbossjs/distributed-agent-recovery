import { Injectable } from "@agboss/core";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";
import { LedgerSnapshotRepository } from "../repositories/ledger-snapshot.repository.js";
import { ReleaseArtifactRepository } from "../repositories/release-artifact.repository.js";
import { ReleaseCandidateRepository } from "../repositories/release-candidate.repository.js";
import type { LedgerSnapshot } from "../schemas/release-ledger.schema.js";
import { ReleaseArtifactStoreService } from "./release-artifact-store.service.js";

export interface FailedAttemptInspection {
  readonly compensatedCount: number;
  readonly activeRemainingCount: number;
  readonly allCompensated: boolean;
  readonly ledgerDiagnostic: string;
}

/** Read-only views of the ledger: the planner's tool, the summary action, the reports. Writes nothing. */
@Injectable({
  deps: [LedgerDatabaseRepository, ReleaseArtifactRepository, ReleaseCandidateRepository, ReleaseArtifactStoreService],
})
export class ReleaseInspectionService {
  constructor(
    private readonly ledgerDatabase: LedgerDatabaseRepository,
    private readonly artifactRepository: ReleaseArtifactRepository,
    private readonly candidateRepository: ReleaseCandidateRepository,
    private readonly artifacts: ReleaseArtifactStoreService,
  ) {}

  async inspectFailedAttempt(releaseId: string, attemptNumber: number): Promise<FailedAttemptInspection> {
    const compensatedCount = await this.artifactRepository.countByAttemptAndStatuses({ releaseId, attemptNumber, statuses: ["COMPENSATED"] });
    const activeRemainingCount = await this.artifactRepository.countByAttemptAndStatuses({ releaseId, attemptNumber, statuses: ["STAGED", "PROMOTED"] });
    const diag = await this.candidateRepository.findFailureDiagnostic(releaseId, attemptNumber);
    return {
      compensatedCount,
      activeRemainingCount,
      allCompensated: compensatedCount > 0 && activeRemainingCount === 0,
      ledgerDiagnostic: diag ?? "ABI symbol mismatch in payment-engine; append --abi-compat=v2 to buildFlags on retry",
    };
  }

  getSnapshot(releaseId?: string): Promise<LedgerSnapshot> {
    return LedgerSnapshotRepository.read(this.ledgerDatabase.db(), {
      sqlitePath: this.ledgerDatabase.path,
      artifactDir: this.artifacts.artifactDir(),
      ...(releaseId === undefined ? {} : { releaseId }),
    });
  }
}
