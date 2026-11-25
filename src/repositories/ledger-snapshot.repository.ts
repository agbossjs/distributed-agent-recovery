import { asc, eq } from "drizzle-orm";
import {
  ledgerEventsTable,
  modulePreparationsTable,
  releaseArtifactsTable,
  releaseCandidateLocksTable,
  workerStallsTable,
  type LedgerSnapshot,
} from "../schemas/release-ledger.schema.js";
import { LedgerDatabaseRepository, type LedgerDb } from "./ledger-database.repository.js";

export interface LedgerSnapshotQuery {
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly releaseId?: string;
}

/** Reads the whole release ledger of one release, for the verifier and the report. */
export class LedgerSnapshotRepository {
  /** From a SQLite file opened by path: a finished or running cluster's, `--verify-only`. */
  static readFromFile(params: LedgerSnapshotQuery): Promise<LedgerSnapshot> {
    return LedgerDatabaseRepository.withSqliteFile(params.sqlitePath, (db) =>
      LedgerSnapshotRepository.read(db, params),
    );
  }

  /** Through a database the caller already holds (an application's own connection, `:memory:` included). */
  static async read(db: LedgerDb, params: LedgerSnapshotQuery): Promise<LedgerSnapshot> {
    const id = params.releaseId;
    {
      const preparations = await db
        .select()
        .from(modulePreparationsTable)
        .where(id === undefined ? undefined : eq(modulePreparationsTable.releaseId, id))
        .orderBy(asc(modulePreparationsTable.attemptNumber), asc(modulePreparationsTable.moduleName));
      const executionIds = new Set(preparations.map((row) => row.executionId));
      return {
        sqlitePath: params.sqlitePath,
        artifactDir: params.artifactDir,
        artifacts: await db
          .select()
          .from(releaseArtifactsTable)
          .where(id === undefined ? undefined : eq(releaseArtifactsTable.releaseId, id))
          .orderBy(asc(releaseArtifactsTable.attemptNumber), asc(releaseArtifactsTable.moduleName)),
        candidateLocks: await db
          .select()
          .from(releaseCandidateLocksTable)
          .where(id === undefined ? undefined : eq(releaseCandidateLocksTable.releaseId, id))
          .orderBy(asc(releaseCandidateLocksTable.attemptNumber)),
        preparations,
        stalls: (await db.select().from(workerStallsTable).orderBy(asc(workerStallsTable.createdAt))).filter(
          (row) => id === undefined || row.releaseId === id,
        ),
        events: (await db.select().from(ledgerEventsTable).orderBy(asc(ledgerEventsTable.eventId))).filter(
          (row) =>
            id === undefined ||
            row.releaseId === id ||
            (row.releaseId === null && executionIds.has(row.executionId)),
        ),
      };
    }
  }
}
