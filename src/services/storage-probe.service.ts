import { Injectable } from "@agboss/core";
import { LedgerDatabaseRepository } from "../repositories/ledger-database.repository.js";

@Injectable({ deps: [LedgerDatabaseRepository] })
export class StorageProbeService {
  constructor(private readonly ledgerDatabase: LedgerDatabaseRepository) {}

  async ping(): Promise<"healthy" | "degraded" | "unhealthy"> {
    try {
      const ok = await this.ledgerDatabase.ping();
      return ok ? "healthy" : "unhealthy";
    } catch {
      return "unhealthy";
    }
  }
}
