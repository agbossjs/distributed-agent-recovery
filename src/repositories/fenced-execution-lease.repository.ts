import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { LeaseFencingRepository } from "./lease-fencing.repository.js";
import { LedgerEventRepository } from "./ledger-event.repository.js";

@Injectable({
  deps: [
    SqliteConnection,
    Clock,
    ApplicationContext,
    LeaseFencingRepository,
    LedgerEventRepository,
  ],
})
export class FencedSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  constructor(
    sql: SqliteConnection,
    private readonly appClock: Clock,
    private readonly appContext: ApplicationContext,
    private readonly fencingRepository: LeaseFencingRepository,
    private readonly eventRepository: LedgerEventRepository,
  ) {
    super(sql, appClock, appContext);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (!(await this.isEligibleForExecution(tenantId, rootExecutionId))) {
      return undefined;
    }
    return super.acquire(tenantId, rootExecutionId, lease);
  }

  override async renew(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<boolean> {
    if (
      await this.fencingRepository.isInstanceStalledForExecution(
        executionLease.rootExecutionId,
        executionLease.holderInstanceId,
      )
    ) {
      const active = await this.fencingRepository.readActiveLease({
        tenantId: executionLease.tenantId,
        executionId: executionLease.rootExecutionId,
        fallbackInstanceId: executionLease.holderInstanceId,
        fallbackEpoch: executionLease.leaseEpoch,
      });
      if (
        active.leaseEpoch > executionLease.leaseEpoch ||
        active.holderInstanceId !== executionLease.holderInstanceId
      ) {
        await this.recordRuntimeFence(executionLease);
        return false;
      }
      throw new Error(
        `Simulated lease heartbeat partition for stalled execution ${executionLease.rootExecutionId}`,
      );
    }
    const renewed = await super.renew(executionLease, lease);
    if (!renewed) {
      await this.recordRuntimeFence(executionLease);
    }
    return renewed;
  }

  private async isEligibleForExecution(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<boolean> {
    const env = this.appContext.environment as { readonly nodeRole?: string };
    const role = env.nodeRole ?? "hybrid";
    if (role === "coordinator" || role === "worker") {
      const isChild = await this.fencingRepository.isExecutionQueuedChild(
        tenantId,
        rootExecutionId,
      );
      if ((role === "coordinator" && isChild) || (role === "worker" && !isChild)) {
        return false;
      }
    }
    return !(await this.fencingRepository.isInstanceStalledForExecution(
      rootExecutionId,
      this.appContext.instanceId,
    ));
  }

  private async recordRuntimeFence(staleLease: ExecutionLease): Promise<void> {
    await this.eventRepository.recordRuntimeFenceIfAbsent({
      tenantId: staleLease.tenantId,
      executionId: staleLease.rootExecutionId,
      staleInstanceId: staleLease.holderInstanceId,
      staleLeaseEpoch: staleLease.leaseEpoch,
      now: this.appClock.now().getTime(),
    });
  }
}
