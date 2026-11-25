import { Injectable } from "@agboss/core";
import { eq } from "drizzle-orm";
import { ledgerEventsTable, modulePreparationsTable, type NewLedgerEventRow } from "../schemas/release-ledger.schema.js";
import { LedgerDatabaseRepository, type LedgerDb } from "./ledger-database.repository.js";

/** The ledger's evidence timeline: the steps' own events and the lease events the observer mirrors. */
@Injectable({ deps: [LedgerDatabaseRepository] })
export class LedgerEventRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async insert(row: NewLedgerEventRow, executor: LedgerDb = this.database.db()): Promise<void> {
    await executor.insert(ledgerEventsTable).values(row);
  }

  /** The release and attempt a module task execution belongs to, once its step 1 prepared it. */
  async findTaskOfExecution(
    executionId: string,
    executor: LedgerDb = this.database.db(),
  ): Promise<{ readonly releaseId: string; readonly attemptNumber: number } | undefined> {
    const rows = await executor
      .select({
        releaseId: modulePreparationsTable.releaseId,
        attemptNumber: modulePreparationsTable.attemptNumber,
      })
      .from(modulePreparationsTable)
      .where(eq(modulePreparationsTable.executionId, executionId))
      .limit(1);
    return rows[0];
  }
}
