import { resolve } from "node:path";
import { DatabaseStorage, SqliteDriver, defineEnv, env, secret } from "@agboss/core";
import { hours } from "@agboss/core/units";

const databaseEnv = defineEnv({
  /** The one SQLite file every instance of the cluster shares (`:memory:` is one database per connection: single-instance runs only). */
  path: env("SQLITE_PATH", { default: resolve(process.cwd(), ".data/dev/cluster-state.sqlite") }),
  /** The HMAC key of the fenced effects' fingerprints: the same on every instance of the cluster. */
  idempotencySecret: secret("IDEMPOTENCY_KEY"),
});

/**
 * The cluster's storage: one SQLite file (`SQLITE_PATH`, WAL) for the framework's own rows — the
 * checkpoints, the leases and their fencing tokens, the child queue, the fenced effects' marks, the
 * audit log — and for the release ledger's tables, which the ledger writes through the very same
 * connection, inside the fenced effects' transactions.
 */
@DatabaseStorage({
  name: "release-ledger-database-storage",
  driver: SqliteDriver({ path: databaseEnv.path }),
  auditLogTtl: hours(24 * 7),
  ledgerEntriesTtl: hours(24),
  idempotencySecret: databaseEnv.idempotencySecret,
})
export class ReleaseLedgerDatabaseStorage {}
