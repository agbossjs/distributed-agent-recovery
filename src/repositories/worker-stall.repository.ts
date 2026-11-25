import { Injectable } from "@agboss/core";
import { eq } from "drizzle-orm";
import { workerStallsTable, type WorkerStallRow } from "../schemas/release-ledger.schema.js";
import { LedgerDatabaseRepository, type LedgerDb } from "./ledger-database.repository.js";

/** The stall drill's marks: which worker froze (or died) inside which module task. */
@Injectable({ deps: [LedgerDatabaseRepository] })
export class WorkerStallRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async find(executionId: string, executor: LedgerDb = this.database.db()): Promise<WorkerStallRow | undefined> {
    const rows = await executor
      .select()
      .from(workerStallsTable)
      .where(eq(workerStallsTable.executionId, executionId))
      .limit(1);
    return rows[0];
  }

  async insertIfAbsent(row: WorkerStallRow, executor: LedgerDb = this.database.db()): Promise<void> {
    await executor.insert(workerStallsTable).values(row).onConflictDoNothing();
  }
}
