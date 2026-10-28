import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { Injectable, SqliteConnection } from "@agboss/core";
import { and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { drizzle, type SqliteRemoteDatabase, type SqliteRemoteResult } from "drizzle-orm/sqlite-proxy";
import { sqliteMasterTable } from "../schemas/agboss-cluster.schema.js";

export type LedgerDrizzleExecutor = BaseSQLiteDatabase<"async", SqliteRemoteResult, Record<string, never>>;

interface RecordedRead {
  readonly querySql: string;
  readonly sqlParams: readonly SQLInputValue[];
  readonly method: "all" | "get" | "values";
  readonly fingerprint: string;
}

interface BufferedWrite {
  readonly querySql: string;
  readonly sqlParams: readonly SQLInputValue[];
}

const RELEASE_LEDGER_DDL = readFileSync(new URL("../sql/0001-release-ledger.sql", import.meta.url), "utf8");
const initializedConnections = new WeakMap<SqliteConnection, SqliteRemoteDatabase>();
const processQueues = new Map<string, Promise<unknown>>();

function toSqlInput(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value instanceof Uint8Array ? value : String(value);
}

function toValueRow(row: Record<string, SQLOutputValue>): SQLOutputValue[] {
  return Array.isArray(row) ? row : Object.values(row);
}

function fingerprintRows(rows: unknown): string {
  return JSON.stringify(rows, (_key, val: unknown) => (typeof val === "bigint" ? val.toString() : val));
}

function executeSelect(
  database: DatabaseSync,
  querySql: string,
  sqlParams: readonly SQLInputValue[],
  method: "all" | "get" | "values",
): { rows: unknown[] } {
  const stmt = database.prepare(querySql);
  stmt.setReturnArrays(true);
  if (method === "get") {
    const row = stmt.get(...sqlParams);
    return row === undefined ? { rows: [] } : { rows: toValueRow(row) };
  }
  return { rows: stmt.all(...sqlParams).map(toValueRow) };
}

function createDirectDrizzle(database: DatabaseSync): SqliteRemoteDatabase {
  return drizzle((querySql, params, method) => {
    const sqlParams = params.map(toSqlInput);
    if (method === "run") {
      database.prepare(querySql).run(...sqlParams);
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve(executeSelect(database, querySql, sqlParams, method));
  });
}

function commitAtomicSnapshot(
  database: DatabaseSync,
  reads: readonly RecordedRead[],
  writes: readonly BufferedWrite[],
): boolean {
  if (writes.length === 0 && reads.length <= 1) {
    return true;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const read of reads) {
      const fresh = executeSelect(database, read.querySql, read.sqlParams, read.method);
      if (fingerprintRows(fresh.rows) !== read.fingerprint) {
        database.exec("ROLLBACK");
        return false;
      }
    }
    for (const write of writes) {
      database.prepare(write.querySql).run(...write.sqlParams);
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

@Injectable({ deps: [SqliteConnection] })
export class LedgerDatabaseRepository {
  constructor(private readonly connection: SqliteConnection) {
    this.ensureInitialized();
  }

  get path(): string {
    return this.connection.path;
  }

  get db(): SqliteRemoteDatabase {
    return this.ensureInitialized();
  }

  async hasTable(tableName: string, executor: LedgerDrizzleExecutor = this.db): Promise<boolean> {
    const rows = await executor
      .select({ name: sqliteMasterTable.name })
      .from(sqliteMasterTable)
      .where(and(eq(sqliteMasterTable.type, "table"), eq(sqliteMasterTable.name, tableName)))
      .limit(1);
    return rows.length > 0;
  }

  async inTransaction<TResult>(work: (tx: LedgerDrizzleExecutor) => Promise<TResult>): Promise<TResult> {
    this.ensureInitialized();
    const key = this.connection.path;
    const prev = processQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.runOptimisticImmediate(work), () => this.runOptimisticImmediate(work));
    processQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async ping(): Promise<boolean> {
    await this.db.run(sql`SELECT 1`);
    return true;
  }

  static async withSqliteFile<TResult>(
    sqlitePath: string,
    work: (db: LedgerDrizzleExecutor) => Promise<TResult>,
  ): Promise<TResult> {
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA busy_timeout = 5000;");
    try {
      return await work(createDirectDrizzle(database));
    } finally {
      database.close();
    }
  }

  private async runOptimisticImmediate<TResult>(work: (tx: LedgerDrizzleExecutor) => Promise<TResult>): Promise<TResult> {
    const database = this.connection.database;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reads: RecordedRead[] = [];
      const writes: BufferedWrite[] = [];
      const txDb = drizzle((querySql, params, method) => {
        const sqlParams = params.map(toSqlInput);
        if (method === "run") {
          writes.push({ querySql, sqlParams });
          return Promise.resolve({ rows: [] });
        }
        const res = executeSelect(database, querySql, sqlParams, method);
        reads.push({ querySql, sqlParams, method, fingerprint: fingerprintRows(res.rows) });
        return Promise.resolve(res);
      });
      const result = await work(txDb);
      if (commitAtomicSnapshot(database, reads, writes)) {
        return result;
      }
    }
    throw new Error(`SQLite optimistic transaction exceeded retry budget on ${this.connection.path}`);
  }

  private ensureInitialized(): SqliteRemoteDatabase {
    const existing = initializedConnections.get(this.connection);
    if (existing !== undefined) {
      return existing;
    }
    this.connection.database.exec("PRAGMA busy_timeout = 5000;");
    this.connection.database.exec(RELEASE_LEDGER_DDL);
    const created = createDirectDrizzle(this.connection.database);
    initializedConnections.set(this.connection, created);
    return created;
  }
}
