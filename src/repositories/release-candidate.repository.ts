import { Injectable } from "@agboss/core";
import { and, eq } from "drizzle-orm";
import {
  releaseCandidateLocksTable,
  type LedgerCandidateLockRow,
  type NewLedgerCandidateLockRow,
} from "../schemas/release-ledger.schema.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "./ledger-database.repository.js";

@Injectable({ deps: [LedgerDatabaseRepository] })
export class ReleaseCandidateRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async findById(
    candidateLockId: string,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<LedgerCandidateLockRow | undefined> {
    const rows = await executor
      .select()
      .from(releaseCandidateLocksTable)
      .where(eq(releaseCandidateLocksTable.candidateLockId, candidateLockId))
      .limit(1);
    return rows[0];
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<LedgerCandidateLockRow | undefined> {
    const rows = await executor
      .select()
      .from(releaseCandidateLocksTable)
      .where(eq(releaseCandidateLocksTable.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0];
  }

  async findFailureDiagnostic(
    releaseId: string,
    attemptNumber: number,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<string | null> {
    const rows = await executor
      .select({ failureDiagnostic: releaseCandidateLocksTable.failureDiagnostic })
      .from(releaseCandidateLocksTable)
      .where(
        and(
          eq(releaseCandidateLocksTable.releaseId, releaseId),
          eq(releaseCandidateLocksTable.attemptNumber, attemptNumber),
        ),
      )
      .limit(1);
    return rows[0]?.failureDiagnostic ?? null;
  }

  async insert(
    row: NewLedgerCandidateLockRow,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    await executor.insert(releaseCandidateLocksTable).values(row);
  }

  async updateFailureDiagnostic(
    params: {
      readonly candidateLockId: string;
      readonly diagnostic: string;
      readonly updatedAt: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    await executor
      .update(releaseCandidateLocksTable)
      .set({
        failureDiagnostic: params.diagnostic,
        updatedAt: params.updatedAt,
      })
      .where(eq(releaseCandidateLocksTable.candidateLockId, params.candidateLockId));
  }

  async markCompensated(
    params: {
      readonly candidateLockId: string;
      readonly compensatedByKey: string;
      readonly updatedAt: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    await executor
      .update(releaseCandidateLocksTable)
      .set({
        status: "COMPENSATED",
        compensatedByKey: params.compensatedByKey,
        updatedAt: params.updatedAt,
      })
      .where(eq(releaseCandidateLocksTable.candidateLockId, params.candidateLockId));
  }

  async markPromoted(
    params: {
      readonly candidateLockId: string;
      readonly manifestPath: string;
      readonly participatingInstances: string;
      readonly updatedAt: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    await executor
      .update(releaseCandidateLocksTable)
      .set({
        status: "PROMOTED",
        manifestPath: params.manifestPath,
        participatingInstances: params.participatingInstances,
        updatedAt: params.updatedAt,
      })
      .where(eq(releaseCandidateLocksTable.candidateLockId, params.candidateLockId));
  }
}
