import {
  Clock,
  IdempotencyRunEventOutcome,
  Observer,
  type ExecutionLeaseTakeoverEvent,
  type ExecutionObserver,
  type IdempotencyRunEvent,
  type StepHandedOverEvent,
} from "@agboss/core";
import { LedgerEventRepository } from "../repositories/ledger-event.repository.js";

/**
 * Mirrors what the framework's audit log says about the leases into the release ledger's own
 * timeline, so a verifier that has only the SQLite file (`--verify-only`, another machine) reads the
 * whole story in one place: who took a tree over and at which fencing token, which effect was refused
 * a stale writer, which step was handed over. The audit log itself (`app.auditLogOf`) stays the
 * framework's record; this is a copy for the ledger's reports.
 */
@Observer({ deps: [Clock, LedgerEventRepository] })
export class LeaseEvidenceObserver implements ExecutionObserver {
  constructor(
    private readonly clock: Clock,
    private readonly events: LedgerEventRepository,
  ) {}

  async onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): Promise<void> {
    await this.events.insert({
      executionId: event.leaseExecutionId,
      instanceId: event.holderInstanceId,
      fencingToken: event.token,
      operation: "LEASE_TAKEOVER",
      outcome: event.reason,
      details: JSON.stringify({
        previousHolderInstanceId: event.previousHolderInstanceId ?? null,
        previousToken: event.previousToken ?? null,
        scopeKey: event.scopeKey,
      }),
      recordedAt: this.clock.now().getTime(),
    });
  }

  async onIdempotencyRun(event: IdempotencyRunEvent): Promise<void> {
    if (event.outcome === IdempotencyRunEventOutcome.Joined) return;
    await this.events.insert({
      executionId: event.executionId,
      instanceId: event.holderInstanceId,
      fencingToken: event.token,
      operation: `FENCED_EFFECT:${event.name}`,
      outcome: event.outcome,
      details: JSON.stringify({
        observedToken: event.observedToken ?? null,
        writtenToken: event.writtenToken ?? null,
        idempotencyKey: event.step.idempotencyKey,
      }),
      recordedAt: this.clock.now().getTime(),
    });
  }

  async onStepHandedOver(event: StepHandedOverEvent): Promise<void> {
    await this.events.insert({
      executionId: event.executionId,
      instanceId: event.holderInstanceId,
      fencingToken: event.token,
      operation: "STEP_HANDED_OVER",
      outcome: event.reason,
      details: JSON.stringify({
        site: event.site,
        observedToken: event.observedToken ?? null,
        idempotencyKey: event.step.idempotencyKey,
      }),
      recordedAt: this.clock.now().getTime(),
    });
  }
}
