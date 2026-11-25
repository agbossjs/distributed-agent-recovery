import { Injectable } from "@agboss/core";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  releaseArtifactsTable,
  type ArtifactStatus,
  type LedgerArtifactRow,
  type NewLedgerArtifactRow,
} from "../schemas/release-ledger.schema.js";
import {
  LedgerDatabaseRepository,
  type LedgerDb,
} from "./ledger-database.repository.js";

@Injectable({ deps: [LedgerDatabaseRepository] })
export class ReleaseArtifactRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async findByIdempotencyKey(
    idempotencyKey: string,
    executor: LedgerDb = this.database.db(),
  ): Promise<LedgerArtifactRow | undefined> {
    const rows = await executor
      .select()
      .from(releaseArtifactsTable)
      .where(eq(releaseArtifactsTable.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0];
  }

  async insert(
    row: NewLedgerArtifactRow,
    executor: LedgerDb = this.database.db(),
  ): Promise<void> {
    await executor.insert(releaseArtifactsTable).values(row);
  }

  async findByAttemptAndStatuses(
    params: {
      readonly releaseId: string;
      readonly attemptNumber: number;
      readonly statuses: readonly ArtifactStatus[];
      readonly orderByCreatedDesc?: boolean;
    },
    executor: LedgerDb = this.database.db(),
  ): Promise<LedgerArtifactRow[]> {
    return executor
      .select()
      .from(releaseArtifactsTable)
      .where(
        and(
          eq(releaseArtifactsTable.releaseId, params.releaseId),
          eq(releaseArtifactsTable.attemptNumber, params.attemptNumber),
          inArray(releaseArtifactsTable.status, [...params.statuses]),
        ),
      )
      .orderBy(
        params.orderByCreatedDesc === true
          ? desc(releaseArtifactsTable.createdAt)
          : asc(releaseArtifactsTable.moduleName),
      );
  }

  async countByAttemptAndStatuses(
    params: {
      readonly releaseId: string;
      readonly attemptNumber: number;
      readonly statuses: readonly ArtifactStatus[];
    },
    executor: LedgerDb = this.database.db(),
  ): Promise<number> {
    const rows = await executor
      .select({ total: count() })
      .from(releaseArtifactsTable)
      .where(
        and(
          eq(releaseArtifactsTable.releaseId, params.releaseId),
          eq(releaseArtifactsTable.attemptNumber, params.attemptNumber),
          inArray(releaseArtifactsTable.status, [...params.statuses]),
        ),
      );
    return rows[0]?.total ?? 0;
  }

  async markCompensated(
    params: {
      readonly artifactId: string;
      readonly compensatedByKey: string;
      readonly updatedAt: number;
    },
    executor: LedgerDb = this.database.db(),
  ): Promise<void> {
    await executor
      .update(releaseArtifactsTable)
      .set({
        status: "COMPENSATED",
        compensatedByKey: params.compensatedByKey,
        updatedAt: params.updatedAt,
      })
      .where(eq(releaseArtifactsTable.artifactId, params.artifactId));
  }

  async markPromoted(
    params: {
      readonly artifactId: string;
      readonly artifactPath: string;
      readonly updatedAt: number;
    },
    executor: LedgerDb = this.database.db(),
  ): Promise<void> {
    await executor
      .update(releaseArtifactsTable)
      .set({
        status: "PROMOTED",
        artifactPath: params.artifactPath,
        updatedAt: params.updatedAt,
      })
      .where(eq(releaseArtifactsTable.artifactId, params.artifactId));
  }
}
