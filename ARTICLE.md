# Ghost in the Machine: The Zombie AI Worker

*It lost its lease. Another worker took over. Then the zombie came back.*

> **The worker didn't survive. The workflow did.**

---

## The Ghost Every Distributed AI Engineer Eventually Meets

Imagine your team has built an AI-assisted release engineering pipeline. A coordinator decomposes a release into module build tasks (`auth-service`, `payment-engine`, `telemetry-collector`), distributes them across worker nodes, verifies an integration smoke gate, and—when a build fails—uses an LLM recovery agent to inspect the failure and synthesize corrected compiler flags.

In a single-process demo, everything looks effortless.

Then you deploy it across multiple worker nodes, and two very real "ghosts in the machine" appear:

1. **The Half-Committed Saga**: Three workers stage release artifacts to shared storage. Moments later, the integration smoke gate fails because `payment-engine` needs `--abi-compat=v2`. If your workflow simply errors out—or worse, asks an LLM to "clean up the failed files"—you end up with orphaned staging artifacts polluting the next release attempt.
2. **The Zombie Worker**: During the recovered Attempt 2, **Worker A** claims `payment-engine` under `leaseEpoch = 1`, completes Step 1 (`PrepareModuleCandidateAction`), writes its checkpoint, and stalls during Step 2 (`StageModuleArtifactAction`) due to an event-loop stall, GC pause, or container freeze. Its execution lease expires. **Worker B** reclaims the orphaned execution under `leaseEpoch = 2`, resumes from Worker A's Step 1 checkpoint, and commits the artifact.
   **Then Worker A wakes up.** Still believing it owns `leaseEpoch = 1`, the zombie worker tries to write its stale artifact and overwrite the workflow checkpoint.

For the **DEV Community Hacktoberfest Open-Source AI Challenge**, we built an open-source showcase repository—[**`agbossjs/distributed-agent-recovery`**](https://github.com/agbossjs/distributed-agent-recovery)—using [**AGBoss**](https://github.com/agbossjs/agboss) (`@agboss/core@0.1.0` and `@agboss/cli@0.1.0`, docs at [agboss.dev](https://agboss.dev)) to solve both problems deterministically and prove every invariant with real multi-process execution.

---

## Why AGBoss?

[**AGBoss**](https://agboss.dev) is a declarative TypeScript framework built on LangGraph for production AI-agent applications. Instead of wiring ad-hoc prompt loops and custom queue scripts, AGBoss gives you:

- **Statically verified workflows (`agboss check`)**: Compile-time verification of workflow graphs, DTO transitions, prompt variables, DI bindings, static model configurations, and worst-case execution concurrency before a single token is spent.
- **Distributed child execution (`ChildPlacement.AnyInstance`)**: Fan out `.toParallelWorkflows(...)` across worker instances polling a shared queue, with automatic lease renewal and stalled-execution reclamation.
- **Checkpoint continuation & lease fencing (`LeasedCheckpointSaver`)**: When a worker's lease expires, another instance reclaims the **exact same `executionId`** and continues from its last committed checkpoint while fencing the stale lease holder with `ExecutionLeaseLostError`.
- **Declarative Saga Compensation (`@Action({ compensateWith })`)**: Deterministic reverse-order rollback of committed side effects when a downstream workflow step fails.
- **Typed AI Agents & Tools (`@Agent`, `@Tool`, `@Budget`)**: Strict separation between LLM decision-making and deterministic infrastructure guarantees.

---

## Architecture of the 12-Step Recovery Scenario

Our showcase pipeline (`ReleaseCoordinatorWorkflow` + `ModuleWorkerWorkflow`) executes a reproducible 12-step story across a Coordinator and multiple Worker instances sharing a SQLite WAL database and filesystem volume:

1. **Decompose**: `DecomposeReleaseTasksAction` splits release `rel-2026.10.0` (`v2.4.0`) into three module tasks: `auth-service`, `payment-engine`, and `telemetry-collector`.
2. **Distribute (`ChildPlacement.AnyInstance`)**: `.toParallelWorkflows(ModuleWorkerWorkflow, { maxConcurrency: 4, maxItems: 8, placement: ChildPlacement.AnyInstance })` dispatches child workflows across available worker instances.
3. **Stage Real Artifacts**: Workers execute Step 1 (`PrepareModuleCandidateAction`) and Step 2 (`StageModuleArtifactAction`), writing `.artifact.json` manifests to disk and recording rows in the shared SQLite ledger.
4. **Injected Integration Failure**: `LockReleaseCandidateAction` locks the candidate (registering `CompensateReleaseCandidateAction`), and `VerifyReleaseSmokeGateAction` throws `ReleaseGateFailedError` because Attempt 1's build flags (`--opt-level=3 --deterministic`) lack `--abi-compat=v2`.
5. **Deterministic Saga Compensation**: AGBoss automatically triggers `CompensateReleaseCandidateAction` before routing the error. Every staged `.artifact.json` file from Attempt 1 is deleted from disk and marked `COMPENSATED` in SQLite.
6. **AI Recovery Planning (`ReleaseRecoveryPlannerAgent`)**: The workflow routes `ReleaseGateFailedError` to `SummarizeCompensatedAttemptAction` and then to `ReleaseRecoveryPlannerAgent` (`model: "openai/gpt-4o-mini"`). The agent calls `InspectFailedAttemptTool` to verify that `allArtifactsCompensated === true` in the SQLite ledger, diagnoses the ABI error, and outputs a typed `RecoveryPlanDto` (`nextAttemptNumber: 2`, `correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2"`, `enableLeaseTakeoverDrill: true`).
7. **Attempt 2 Redistribution**: The coordinator starts Attempt 2 with the AI-generated recovery plan and distributes the module tasks across the worker cluster.
8. **Worker Stall & Lease Expiration**: Worker A claims `rel-2026.10.0:payment-engine` (`leaseEpoch = 1`), finishes Step 1 (`PrepareModuleCandidateAction`), commits its LangGraph checkpoint, and stalls inside Step 2 (`StageModuleArtifactAction`) past the execution lease TTL.
9. **Same-Task Takeover From Checkpoint**: Worker B's background sweep detects the expired lease, acquires `leaseEpoch = 2` for the **same `childExecutionId`**, logs `execution.recovered`, loads Worker A's Step 1 checkpoint (skipping Step 1!), and commits Step 2 (`StageModuleArtifactAction`) using the preserved deterministic step idempotency key.
10. **The Zombie Returns**: Worker A wakes up from its stall still holding `capturedLeaseEpoch = 1` and attempts to write its stale artifact and checkpoint.
11. **Two-Layer Lease Fencing**:
    - **Layer 1 (External SQLite Ledger)**: `LeaseFencingService.checkAndAdvanceFence()` compares `capturedLeaseEpoch (1) < activeLeaseEpoch (2)`, rejects the write, logs `ZOMBIE_WRITE_REJECTED`, and throws `StaleLeaseFenceError`.
    - **Layer 2 (AGBoss Runtime Checkpoint Saver)**: When Worker A exits the action, `LeasedCheckpointSaver.putWrites()` attempts `renew(leaseEpoch = 1)`, which returns `false` (logging `RUNTIME_LEASE_FENCED`) and throws `ExecutionLeaseLostError` (`code: "execution.lease-lost"`).
12. **Promotion & 8-Invariant Verification**: `PromoteReleaseArtifactsAction` writes the final `release-manifest.json`, and `ReleaseInvariantVerifierService` verifies all 8 cluster, filesystem, saga, and fencing invariants via Drizzle ORM over the shared SQLite database.

---

## Proving Same-Task Takeover (Not Just Starting a Different Task)

A common shortcut in distributed systems demos is showing Worker A losing its lease on Task 1 and then showing Worker B succeeding on Task 2. **That does not prove Task 1 was recovered.**

Our dedicated takeover test ([`tests/workflows/module-worker/module-worker.workflow.test.ts`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/tests/workflows/module-worker/module-worker.workflow.test.ts)) proves that **the exact same child execution** (`task-001`) is recovered across instances:

- **Logical Task ID**: `task-001` (and `rel-2026.10.0:payment-engine` in the full release pipeline)
- **Child Execution ID**: Identical on Worker A (Step 1) and Worker B (Step 2).
- **Step 2 Idempotency Key (`<executionId>:stage-module-artifact-action:1`)**: Derived deterministically by AGBoss from `(executionId, nodeId, visitNumber)`, remaining identical across the stall and takeover.
- **Monotonic Lease Epoch (`1 -> 2`)**: Incremented in `execution_leases` when Worker B reclaims the expired lease.

---

## Inside the Code: Declarative Workflows, Sagas & Two-Layer Fencing

### 1. The Coordinator Workflow with Saga Compensation & Error Routing

In [`src/workflows/release-coordinator/release-coordinator.workflow.ts`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/workflows/release-coordinator/release-coordinator.workflow.ts), the entire pipeline—parallel distributed fan-out, saga-protected candidate locking, smoke-gate failure routing, and AI recovery planning—is declared in a single statically verified `@Workflow`:

```typescript
@Workflow({
  name: "release-coordinator-workflow",
  version: "1.0.0",
  flow: [
    start(ReleaseCoordinatorWorkflowStart)
      .returns(ReleaseRequestDto)
      .toAction(DecomposeReleaseTasksAction)
      .returns(listOf(ModuleTaskDto))
      .toParallelWorkflows(ModuleWorkerWorkflow, {
        maxConcurrency: 4,
        maxItems: 8,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(oneOf(StagedModuleArtifactDto, ModuleFailedDto)))
      .toAction(LockReleaseCandidateAction)
      .returns(LockedReleaseCandidateDto)
      .toAction(VerifyReleaseSmokeGateAction)
      .onError(
        ReleaseGateFailedError,
        toAction(CompensateReleaseCandidateAction)
          .toAction(SummarizeCompensatedAttemptAction)
          .returns(CompensatedReleaseCandidateDto)
          .toAgent(ReleaseRecoveryPlannerAgent)
          .returns(RecoveryPlanDto)
          .toFinish(ReleaseRecoveryPlannedWorkflowFinish),
      )
      .toAction(PromoteReleaseArtifactsAction)
      .returns(ReleaseSummaryDto)
      .toFinish(ReleaseCoordinatorWorkflowFinish),
  ],
})
export class ReleaseCoordinatorWorkflow {}
```

When `VerifyReleaseSmokeGateAction` throws `ReleaseGateFailedError`, AGBoss runs `CompensateReleaseCandidateAction` before routing to `SummarizeCompensatedAttemptAction` and `ReleaseRecoveryPlannerAgent`. By the time the LLM agent runs, the filesystem and SQLite ledger are already guaranteed to be clean.

### 2. Why Two-Layer Fencing Matters at the Side-Effect Boundary

AGBoss's runtime `LeaseFence` fences checkpoint writes via `LeasedCheckpointSaver.putWrites()` when a step completes. Because an `@Action` performs external I/O *inside* its `execute()` method—before returning to the checkpoint saver—[`StageModuleArtifactAction`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/actions/stage-module-artifact.action.ts) captures the active `leaseEpoch` at step entry and validates it inside [`LeaseFencingService.checkAndAdvanceFence()`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/services/lease-fencing.service.ts):

```typescript
if (
  params.capturedLeaseEpoch < activeLeaseEpoch ||
  (activeHolder !== params.capturedInstanceId &&
    params.capturedLeaseEpoch <= activeLeaseEpoch)
) {
  await this.appendEvent(
    {
      ...params,
      operation: "ZOMBIE_WRITE_REJECTED",
      outcome: "REJECTED_STALE_LEASE",
      details: { activeHolderInstanceId: activeHolder, activeLeaseEpoch },
    },
    tx,
  );
  return new StaleLeaseFenceError({ ... });
}
```

When the zombie worker catches `StaleLeaseFenceError` and returns from the step, AGBoss's `LeasedCheckpointSaver` immediately performs Layer 2 fencing by attempting `renew(leaseEpoch = 1)`, which fails and throws `ExecutionLeaseLostError` (`execution.lease-lost`).

---

## Try It Yourself in 60 Seconds

```bash
git clone https://github.com/agbossjs/distributed-agent-recovery.git
cd distributed-agent-recovery
npm install

# 1. Static verification of the AGBoss application graph, DTOs, prompts, types, and ESLint rules
npm run check

# 2. Automated Vitest unit & workflow test suite (@agboss/core/testing, 100% offline)
npm test

# 3. Full 12-step demo + 8-invariant verification (offline deterministic mode)
npm run demo
npm run verify

# 4. Multi-process OS cluster demo (Coordinator + 2 independent worker/main.ts processes)
npm run demo:cluster
```

Have an OpenRouter API key? Run with the live `openai/gpt-4o-mini` agent:

```bash
OPENROUTER_API_KEY="sk-or-v1-..." npm run demo:live
```

Or run the multi-container cluster with Docker Compose:

```bash
npm run demo:compose
```

---

## Links & Resources

- **Showcase Repository**: [github.com/agbossjs/distributed-agent-recovery](https://github.com/agbossjs/distributed-agent-recovery)
- **AGBoss Framework**: [github.com/agbossjs/agboss](https://github.com/agbossjs/agboss)
- **AGBoss Documentation**: [agboss.dev](https://agboss.dev)
- **AGBoss Examples**: [github.com/agbossjs/agboss-examples](https://github.com/agbossjs/agboss-examples)
