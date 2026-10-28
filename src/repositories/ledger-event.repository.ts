import { ExecutionLeaseLostError, Injectable } from "@agboss/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ledgerEventsTable, type NewLedgerEventRow } from "../schemas/release-ledger.schema.js";
import { LeaseFencingRepository } from "./lease-fencing.repository.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "./ledger-database.repository.js";

@Injectable({ deps: [LedgerDatabaseRepository, LeaseFencingRepository] })
export class LedgerEventRepository {
  constructor(
    private readonly database: LedgerDatabaseRepository,
    private readonly fencingRepository: LeaseFencingRepository,
  ) {}

  async insert(
    row: NewLedgerEventRow,
    executor: LedgerDrizzleExecutor = this.database.db,
  ): Promise<void> {
    await executor.insert(ledgerEventsTable).values(row);
  }

  async hasDistinctOperations(
    executionId: string,
    operations: readonly string[],
  ): Promise<boolean> {
    const rows = await this.database.db
      .selectDistinct({ operation: ledgerEventsTable.operation })
      .from(ledgerEventsTable)
      .where(
        and(
          eq(ledgerEventsTable.executionId, executionId),
          inArray(ledgerEventsTable.operation, [...operations]),
        ),
      );
    return rows.length >= operations.length;
  }

  async findStalledWorkerPid(executionId: string): Promise<number | undefined> {
    const rows = await this.database.db
      .select({ details: ledgerEventsTable.details })
      .from(ledgerEventsTable)
      .where(
        and(
          eq(ledgerEventsTable.executionId, executionId),
          eq(ledgerEventsTable.operation, "WORKER_STALLED_LEASE_EXPIRED"),
        ),
      )
      .orderBy(desc(ledgerEventsTable.eventId))
      .limit(1);
    const raw = rows[0]?.details;
    if (raw === undefined) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { stalledPid?: unknown };
    return typeof parsed.stalledPid === "number" ? parsed.stalledPid : undefined;
  }

  async hasRuntimeFenceEvent(
    params: {
      readonly executionId: string;
      readonly instanceId: string;
      readonly leaseEpoch: number;
    },
    executor: LedgerDrizzleExecutor,
  ): Promise<boolean> {
    const rows = await executor
      .select({ eventId: ledgerEventsTable.eventId })
      .from(ledgerEventsTable)
      .where(
        and(
          eq(ledgerEventsTable.executionId, params.executionId),
          eq(ledgerEventsTable.instanceId, params.instanceId),
          eq(ledgerEventsTable.leaseEpoch, params.leaseEpoch),
          eq(ledgerEventsTable.operation, "RUNTIME_LEASE_FENCED"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async recordRuntimeFenceIfAbsent(params: {
    readonly tenantId?: string;
    readonly executionId: string;
    readonly staleInstanceId: string;
    readonly staleLeaseEpoch: number;
    readonly now: number;
  }): Promise<void> {
    const tenantId = params.tenantId ?? "default";
    await this.database.inTransaction(async (tx) => {
      if (
        await this.hasRuntimeFenceEvent(
          {
            executionId: params.executionId,
            instanceId: params.staleInstanceId,
            leaseEpoch: params.staleLeaseEpoch,
          },
          tx,
        )
      ) {
        return;
      }
      const tokenRow = await this.fencingRepository.findFencingToken(params.executionId, tenantId, tx);
      const activeLease = await this.fencingRepository.readActiveLease(
        {
          tenantId,
          executionId: params.executionId,
          fallbackInstanceId: tokenRow?.currentHolderInstanceId ?? "replacement-worker",
          fallbackEpoch: tokenRow?.highestLeaseEpoch ?? params.staleLeaseEpoch + 1,
        },
        tx,
      );
      const logicalTaskId = tokenRow?.logicalTaskId ?? params.executionId;
      await this.insert(
        {
          releaseId: tokenRow?.releaseId ?? "unknown-release",
          attemptNumber: tokenRow?.attemptNumber ?? 1,
          logicalTaskId,
          moduleName: logicalTaskId.split(":").at(-1) ?? logicalTaskId,
          executionId: params.executionId,
          instanceId: params.staleInstanceId,
          leaseEpoch: params.staleLeaseEpoch,
          idempotencyKey: `fence:${params.executionId}:epoch-${String(params.staleLeaseEpoch)}`,
          operation: "RUNTIME_LEASE_FENCED",
          outcome: "REJECTED_BY_AGBOSS_LEASE_FENCE",
          details: JSON.stringify({
            errorCode: ExecutionLeaseLostError.code,
            staleInstanceId: params.staleInstanceId,
            staleLeaseEpoch: params.staleLeaseEpoch,
            activeHolderInstanceId: activeLease.holderInstanceId,
            activeLeaseEpoch: activeLease.leaseEpoch,
          }),
          recordedAt: params.now,
        },
        tx,
      );
    });
  }
}
