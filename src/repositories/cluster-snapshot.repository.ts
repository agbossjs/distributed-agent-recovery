import { and, asc, eq, inArray } from "drizzle-orm";
import {
  checkpointsTable,
  childExecutionQueueTable,
  executionLeasesTable,
  sqliteMasterTable,
} from "../schemas/agboss-cluster.schema.js";
import {
  faultInjectionStallsTable,
  fencingTokensTable,
  ledgerEventsTable,
  releaseArtifactsTable,
  releaseCandidateLocksTable,
  type LedgerSnapshot,
} from "../schemas/release-ledger.schema.js";
import { LedgerDatabaseRepository } from "./ledger-database.repository.js";

export class ClusterSnapshotRepository {
  static async readFromFile(params: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
    readonly releaseId?: string;
  }): Promise<LedgerSnapshot> {
    return LedgerDatabaseRepository.withSqliteFile(params.sqlitePath, async (db) => {
      const existingTables = new Set(
        (
          await db
            .select({ name: sqliteMasterTable.name })
            .from(sqliteMasterTable)
            .where(
              and(
                eq(sqliteMasterTable.type, "table"),
                inArray(sqliteMasterTable.name, [
                  "execution_leases",
                  "child_execution_queue",
                  "checkpoints",
                ]),
              ),
            )
        ).map((row) => row.name),
      );
      const id = params.releaseId;
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
        fencingTokens: await db
          .select()
          .from(fencingTokensTable)
          .where(id === undefined ? undefined : eq(fencingTokensTable.releaseId, id))
          .orderBy(asc(fencingTokensTable.attemptNumber), asc(fencingTokensTable.logicalTaskId)),
        stalls: await db
          .select()
          .from(faultInjectionStallsTable)
          .where(id === undefined ? undefined : eq(faultInjectionStallsTable.releaseId, id))
          .orderBy(
            asc(faultInjectionStallsTable.attemptNumber),
            asc(faultInjectionStallsTable.logicalTaskId),
          ),
        events: await db
          .select()
          .from(ledgerEventsTable)
          .where(id === undefined ? undefined : eq(ledgerEventsTable.releaseId, id))
          .orderBy(asc(ledgerEventsTable.eventId)),
        executionLeases: existingTables.has("execution_leases")
          ? await db
              .select()
              .from(executionLeasesTable)
              .orderBy(asc(executionLeasesTable.rootExecutionId))
          : [],
        childQueue: existingTables.has("child_execution_queue")
          ? await db
              .select()
              .from(childExecutionQueueTable)
              .orderBy(asc(childExecutionQueueTable.executionId))
          : [],
        checkpoints: existingTables.has("checkpoints")
          ? await db
              .select()
              .from(checkpointsTable)
              .orderBy(asc(checkpointsTable.threadId), asc(checkpointsTable.checkpointId))
          : [],
      };
    });
  }
}
