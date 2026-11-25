import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { Injectable } from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import { sql } from "drizzle-orm";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

/** The typed query builder of the release ledger, over one SQLite handle. */
export type LedgerDb = SqliteRemoteDatabase;

/** What a drizzle statement needs of a SQLite handle: the connection's, the effect's or a file's. */
interface LedgerStatement {
  all(...parameters: SQLInputValue[]): unknown;
  get(...parameters: SQLInputValue[]): unknown;
  run(...parameters: SQLInputValue[]): unknown;
}

interface LedgerHandle {
  prepare(querySql: string): LedgerStatement;
}

const RELEASE_LEDGER_DDL = readFileSync(new URL("../sql/0001-release-ledger.sql", import.meta.url), "utf8");

function toSqlInput(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value instanceof Uint8Array ? value : String(value);
}

function toValueRow(row: unknown): SQLOutputValue[] {
  return Array.isArray(row) ? (row as SQLOutputValue[]) : Object.values(row as Record<string, SQLOutputValue>);
}

/**
 * A drizzle database that runs every statement on `handle`. A statement of the connection may answer
 * a promise while another instance's `runOnce` holds the file, one of the effect's transaction never
 * does: both are awaited the same.
 */
export function ledgerDbOf(handle: LedgerHandle): LedgerDb {
  return drizzle(async (querySql, params, method) => {
    const statement = handle.prepare(querySql);
    const args = params.map(toSqlInput);
    if (method === "run") {
      await statement.run(...args);
      return { rows: [] };
    }
    if (method === "get") {
      const row = await statement.get(...args);
      return { rows: row === undefined ? [] : toValueRow(row) };
    }
    const rows = (await statement.all(...args)) as unknown[];
    return { rows: rows.map(toValueRow) };
  });
}

/**
 * The release ledger's own tables in the application's SQLite file — the one the `@DatabaseStorage`
 * opens, shared by every instance. A write is made only inside a fenced effect
 * (`Idempotency.runOnce`), through the effect's transaction (`effectDb()`): it commits with the
 * effect's stored result, and a worker whose lease was taken over is refused before it writes. A
 * read goes through the connection (`db()`), which waits for any open effect transaction.
 */
@Injectable({ deps: [SqliteConnection] })
export class LedgerDatabaseRepository {
  constructor(private readonly connection: SqliteConnection) {
    connection.ensureSchema("release-ledger", RELEASE_LEDGER_DDL);
  }

  get path(): string {
    return this.connection.path;
  }

  /** The effect's transaction: only inside the `execute` of a `runOnce`. */
  effectDb(): LedgerDb {
    return ledgerDbOf(this.connection.requireTransaction());
  }

  /** The connection itself, for reads and for the evidence's own writes (an observer is no step). */
  db(): LedgerDb {
    return ledgerDbOf(this.connection.database);
  }

  /** `work` in one transaction of the file, for a write made outside a step (the evidence observer's). */
  inHeldTransaction<TResult>(work: (db: LedgerDb) => Promise<TResult>): Promise<TResult> {
    return this.connection.held((handle) => work(ledgerDbOf(handle)));
  }

  async ping(): Promise<boolean> {
    await this.connection.ping();
    await this.db().run(sql`SELECT 1`);
    return true;
  }

  /** The ledger of a finished or running cluster, opened read-only by path (the verifier, `--verify-only`). */
  static async withSqliteFile<TResult>(
    sqlitePath: string,
    work: (db: LedgerDb) => Promise<TResult>,
  ): Promise<TResult> {
    const database = new DatabaseSync(sqlitePath, { timeout: 5000 });
    try {
      return await work(ledgerDbOf(database));
    } finally {
      database.close();
    }
  }
}
