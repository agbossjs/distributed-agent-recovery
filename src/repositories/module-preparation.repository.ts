import { Injectable } from "@agboss/core";
import { modulePreparationsTable, type ModulePreparationRow } from "../schemas/release-ledger.schema.js";
import { LedgerDatabaseRepository, type LedgerDb } from "./ledger-database.repository.js";

/** What step 1 of a module task prepared, once per module task execution. */
@Injectable({ deps: [LedgerDatabaseRepository] })
export class ModulePreparationRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async insertIfAbsent(row: ModulePreparationRow, executor: LedgerDb = this.database.db()): Promise<void> {
    await executor.insert(modulePreparationsTable).values(row).onConflictDoNothing();
  }
}
