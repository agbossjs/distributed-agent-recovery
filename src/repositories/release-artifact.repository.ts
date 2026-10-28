import { Injectable } from "@agboss/core";
import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import {
  releaseArtifactsTable,
  type ArtifactStatus,
  type LedgerArtifactRow,
  type LedgerSnapshot,
  type NewLedgerArtifactRow,
} from "../schemas/release-ledger.schema.js";
import { ClusterSnapshotRepository } from "./cluster-snapshot.repository.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "./ledger-database.repository.js";

@Injectable({ deps: [LedgerDatabaseRepository] })
export class ReleaseArtifactRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async findByIdempotencyKey(
    idempotencyKey: string,
    executor: LedgerDrizzleExecutor = this.database.db,
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
    executor: LedgerDrizzleExecutor = this.database.db,
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
    executor: LedgerDrizzleExecutor = this.database.db,
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
    executor: LedgerDrizzleExecutor = this.database.db,
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

  async hasActiveCommitAtMinEpoch(
    params: {
      readonly releaseId: string;
      readonly attemptNumber: number;
      readonly logicalTaskId: string;
      readonly minLeaseEpoch: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<boolean> {
    const rows = await executor
      .select({ artifactId: releaseArtifactsTable.artifactId })
      .from(releaseArtifactsTable)
      .where(
        and(
          eq(releaseArtifactsTable.releaseId, params.releaseId),
          eq(releaseArtifactsTable.attemptNumber, params.attemptNumber),
          eq(releaseArtifactsTable.logicalTaskId, params.logicalTaskId),
          inArray(releaseArtifactsTable.status, ["STAGED", "PROMOTED"]),
          gte(releaseArtifactsTable.leaseEpoch, params.minLeaseEpoch),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markCompensated(
    params: {
      readonly artifactId: string;
      readonly compensatedByKey: string;
      readonly updatedAt: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
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
    executor: LedgerDrizzleExecutor = this.database.db,
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

  static readSnapshotFromFile(params: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
    readonly releaseId?: string;
  }): Promise<LedgerSnapshot> {
    return ClusterSnapshotRepository.readFromFile(params);
  }
}
