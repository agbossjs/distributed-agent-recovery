import { Injectable } from "@agboss/core";
import { and, eq } from "drizzle-orm";
import { childExecutionQueueTable, executionLeasesTable } from "../schemas/agboss-cluster.schema.js";
import {
  faultInjectionStallsTable,
  fencingTokensTable,
  type FencingTokenRow,
} from "../schemas/release-ledger.schema.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "./ledger-database.repository.js";

export interface UpsertFencingTokenInput {
  readonly executionId: string;
  readonly logicalTaskId: string;
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly leaseEpoch: number;
  readonly holderInstanceId: string;
  readonly updatedAt: number;
}

export interface RecordStallInput {
  readonly executionId: string;
  readonly logicalTaskId: string;
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly instanceId: string;
  readonly leaseEpoch: number;
  readonly now: number;
  readonly skipSyntheticLeaseExpiry?: boolean;
}

@Injectable({ deps: [LedgerDatabaseRepository] })
export class LeaseFencingRepository {
  constructor(private readonly database: LedgerDatabaseRepository) {}

  async readActiveLease(
    params: {
      readonly tenantId?: string;
      readonly executionId: string;
      readonly fallbackInstanceId: string;
      readonly fallbackEpoch?: number;
    },
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<{ readonly holderInstanceId: string; readonly leaseEpoch: number }> {
    const fallback = {
      holderInstanceId: params.fallbackInstanceId,
      leaseEpoch: params.fallbackEpoch ?? 1,
    };
    if (!(await this.database.hasTable("execution_leases", executor))) {
      return fallback;
    }
    const l = executionLeasesTable;
    const rows = await executor
      .select({ holderInstanceId: l.holderInstanceId, leaseEpoch: l.leaseEpoch })
      .from(l)
      .where(and(eq(l.tenantId, params.tenantId ?? "default"), eq(l.rootExecutionId, params.executionId)))
      .limit(1);
    return rows[0] ?? fallback;
  }

  async findFencingToken(
    executionId: string,
    tenantId = "default",
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<FencingTokenRow | undefined> {
    const t = fencingTokensTable;
    const rows = await executor
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.executionId, executionId)))
      .limit(1);
    return rows[0];
  }

  async upsertFencingToken(
    params: UpsertFencingTokenInput,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    const existing = await this.findFencingToken(params.executionId, "default", executor);
    if (existing !== undefined && params.leaseEpoch < existing.highestLeaseEpoch) {
      return;
    }
    const values = {
      tenantId: "default",
      executionId: params.executionId,
      logicalTaskId: params.logicalTaskId,
      releaseId: params.releaseId,
      attemptNumber: params.attemptNumber,
      highestLeaseEpoch: params.leaseEpoch,
      currentHolderInstanceId: params.holderInstanceId,
      updatedAt: params.updatedAt,
    };
    await executor
      .insert(fencingTokensTable)
      .values(values)
      .onConflictDoUpdate({
        target: [fencingTokensTable.tenantId, fencingTokensTable.executionId],
        set: values,
      });
  }

  async recordStallAndExpireLease(
    params: RecordStallInput,
    executor: LedgerDrizzleExecutor,
  ): Promise<void> {
    const s = faultInjectionStallsTable;
    await executor
      .insert(s)
      .values({
        executionId: params.executionId,
        logicalTaskId: params.logicalTaskId,
        releaseId: params.releaseId,
        attemptNumber: params.attemptNumber,
        stalledInstanceId: params.instanceId,
        stalledLeaseEpoch: params.leaseEpoch,
        status: "STALLED",
        createdAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [s.executionId, s.stalledInstanceId, s.stalledLeaseEpoch],
        set: { status: "STALLED", updatedAt: params.now },
      });

    if (params.skipSyntheticLeaseExpiry !== true && (await this.database.hasTable("execution_leases", executor))) {
      const l = executionLeasesTable;
      await executor
        .update(l)
        .set({ expiresAt: 0 })
        .where(
          and(
            eq(l.tenantId, "default"),
            eq(l.rootExecutionId, params.executionId),
            eq(l.holderInstanceId, params.instanceId),
            eq(l.leaseEpoch, params.leaseEpoch),
          ),
        );
    }
  }

  async markStallFenced(
    params: {
      readonly executionId: string;
      readonly instanceId: string;
      readonly leaseEpoch: number;
      readonly updatedAt: number;
    },
    executor: LedgerDrizzleExecutor,
  ): Promise<void> {
    const s = faultInjectionStallsTable;
    await executor
      .update(s)
      .set({ status: "FENCED", updatedAt: params.updatedAt })
      .where(
        and(
          eq(s.executionId, params.executionId),
          eq(s.stalledInstanceId, params.instanceId),
          eq(s.stalledLeaseEpoch, params.leaseEpoch),
        ),
      );
  }

  async hasStallForExecution(executionId: string): Promise<boolean> {
    const s = faultInjectionStallsTable;
    const rows = await this.database.db.select({ id: s.executionId }).from(s).where(eq(s.executionId, executionId)).limit(1);
    return rows.length > 0;
  }

  async isInstanceStalledForExecution(executionId: string, instanceId: string): Promise<boolean> {
    const s = faultInjectionStallsTable;
    const rows = await this.database.db
      .select({ id: s.executionId })
      .from(s)
      .where(and(eq(s.executionId, executionId), eq(s.stalledInstanceId, instanceId)))
      .limit(1);
    return rows.length > 0;
  }

  async isExecutionQueuedChild(tenantId: string, executionId: string): Promise<boolean> {
    if (!(await this.database.hasTable("child_execution_queue"))) {
      return false;
    }
    const q = childExecutionQueueTable;
    const rows = await this.database.db
      .select({ id: q.executionId })
      .from(q)
      .where(and(eq(q.tenantId, tenantId), eq(q.executionId, executionId)))
      .limit(1);
    return rows.length > 0;
  }
}
