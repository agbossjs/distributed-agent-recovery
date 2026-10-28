import {
  ApplicationContext,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  SqliteChildExecutionQueueRepository,
  SqliteConnection,
  type QueuedChildExecution,
} from "@agboss/core";
import { and, asc, count, desc, eq, isNotNull, lte, min, ne } from "drizzle-orm";
import {
  childExecutionQueueTable,
  executionLeasesTable,
  type ChildExecutionQueueRow,
} from "../schemas/agboss-cluster.schema.js";
import { faultInjectionStallsTable } from "../schemas/release-ledger.schema.js";
import {
  LedgerDatabaseRepository,
  type LedgerDrizzleExecutor,
} from "./ledger-database.repository.js";

function toQueuedChild(
  row: ChildExecutionQueueRow,
  instanceId: string,
  claimedAtMs: number,
): QueuedChildExecution {
  return {
    tenantId: row.tenantId,
    executionId: row.executionId,
    rootExecutionId: row.rootExecutionId,
    parentExecutionId: row.parentExecutionId,
    rootWorkflow: row.rootWorkflow,
    workflow: row.workflow,
    depth: row.depth,
    status: ExecutionRecordStatus.Running,
    run: row.run,
    queuedAt: new Date(row.queuedAt),
    instanceId,
    claimedAt: new Date(claimedAtMs),
    endedAt: row.endedAt === null ? undefined : new Date(row.endedAt),
    failure: row.failure ?? undefined,
  };
}

@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, LedgerDatabaseRepository] })
export class ClusterSqliteChildExecutionQueueRepository extends SqliteChildExecutionQueueRepository {
  constructor(
    sql: SqliteConnection,
    private readonly appClock: Clock,
    private readonly appContext: ApplicationContext,
    private readonly ledgerDatabase: LedgerDatabaseRepository,
  ) {
    super(sql, appClock, appContext);
  }

  override async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<
    QueuedChildExecution | undefined
  > {
    const env = this.appContext.environment as { readonly nodeRole?: string };
    if ((env.nodeRole ?? "hybrid") === "coordinator") {
      return undefined;
    }
    const now = this.appClock.now().getTime();
    const { instanceId } = this.appContext;

    return this.ledgerDatabase.inTransaction(async (tx) => {
      const hasLeases = await this.ledgerDatabase.hasTable("execution_leases", tx);
      if (hasLeases) {
        await this.requeueExpiredSiblingLeases(tx, instanceId, now);
      }
      const queuedRows = await tx
        .select()
        .from(childExecutionQueueTable)
        .where(eq(childExecutionQueueTable.status, ExecutionRecordStatus.Queued))
        .orderBy(desc(childExecutionQueueTable.depth), asc(childExecutionQueueTable.queuedAt));

      for (const candidate of queuedRows) {
        if (await this.canClaimCandidate(tx, candidate, hasLeases, instanceId, now)) {
          return this.markCandidateClaimed(tx, candidate, instanceId, now);
        }
      }
      return undefined;
    });
  }

  private async requeueExpiredSiblingLeases(
    tx: LedgerDrizzleExecutor,
    instanceId: string,
    now: number,
  ): Promise<void> {
    const q = childExecutionQueueTable;
    const l = executionLeasesTable;
    const expired = await tx
      .select({ tenantId: q.tenantId, executionId: q.executionId })
      .from(q)
      .innerJoin(l, and(eq(l.tenantId, q.tenantId), eq(l.rootExecutionId, q.executionId)))
      .where(
        and(
          eq(q.status, ExecutionRecordStatus.Running),
          isNotNull(q.instanceId),
          ne(q.instanceId, instanceId),
          eq(l.released, 0),
          lte(l.expiresAt, now),
        ),
      );
    for (const row of expired) {
      await tx
        .update(q)
        .set({ status: ExecutionRecordStatus.Queued, instanceId: null, claimedAt: null })
        .where(and(eq(q.tenantId, row.tenantId), eq(q.executionId, row.executionId), eq(q.status, ExecutionRecordStatus.Running)));
    }
  }

  private async canClaimCandidate(
    tx: LedgerDrizzleExecutor,
    candidate: ChildExecutionQueueRow,
    hasLeases: boolean,
    instanceId: string,
    now: number,
  ): Promise<boolean> {
    const s = faultInjectionStallsTable;
    const stalled = await tx
      .select({ id: s.executionId })
      .from(s)
      .where(and(eq(s.executionId, candidate.executionId), eq(s.stalledInstanceId, instanceId)))
      .limit(1);
    if (stalled.length > 0) {
      return false;
    }
    if (hasLeases) {
      const l = executionLeasesTable;
      const lease = (
        await tx
          .select()
          .from(l)
          .where(and(eq(l.tenantId, candidate.tenantId), eq(l.rootExecutionId, candidate.executionId)))
          .limit(1)
      )[0];
      if (lease !== undefined) {
        return !(lease.released === 0 && lease.expiresAt > now && lease.holderInstanceId !== instanceId);
      }
    }
    return !(await this.shouldYieldInitialSibling(tx, candidate.tenantId, candidate.parentExecutionId, instanceId, now));
  }

  private async shouldYieldInitialSibling(
    tx: LedgerDrizzleExecutor,
    tenantId: string,
    parentId: string,
    instanceId: string,
    now: number,
  ): Promise<boolean> {
    const env = this.appContext.environment as { readonly nodeRole?: string };
    if ((env.nodeRole ?? "hybrid") !== "worker") {
      return false;
    }
    const q = childExecutionQueueTable;
    const scope = and(eq(q.tenantId, tenantId), eq(q.parentExecutionId, parentId));
    const total = (await tx.select({ n: count() }).from(q).where(scope))[0]?.n ?? 0;
    if (total < 2) {
      return false;
    }
    const mine = (await tx.select({ n: count() }).from(q).where(and(scope, eq(q.instanceId, instanceId))))[0]?.n ?? 0;
    if (mine === 0) {
      return false;
    }
    const firstClaimedAt = (await tx.select({ ts: min(q.claimedAt) }).from(q).where(scope))[0]?.ts ?? null;
    const peerGraceMs = process.env["AGBOSS_REAL_CLOCK"] === "true" ? 35_000 : 2_000;
    if (firstClaimedAt !== null && now - firstClaimedAt >= peerGraceMs) {
      return false;
    }
    const peers = (await tx.select({ n: count() }).from(q).where(and(scope, isNotNull(q.instanceId), ne(q.instanceId, instanceId))))[0]?.n ?? 0;
    return peers === 0;
  }

  private async markCandidateClaimed(
    tx: LedgerDrizzleExecutor,
    candidate: ChildExecutionQueueRow,
    instanceId: string,
    now: number,
  ): Promise<QueuedChildExecution> {
    const q = childExecutionQueueTable;
    const claimTs = candidate.claimedAt !== null && candidate.claimedAt >= now ? candidate.claimedAt + 1 : now;
    await tx
      .update(q)
      .set({ status: ExecutionRecordStatus.Running, instanceId, claimedAt: claimTs })
      .where(and(eq(q.tenantId, candidate.tenantId), eq(q.executionId, candidate.executionId)));
    return toQueuedChild(candidate, instanceId, claimTs);
  }
}
