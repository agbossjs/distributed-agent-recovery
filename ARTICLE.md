---
title: "Ghost in the Machine: The Zombie AI Worker"
published: false
description: "Recovering distributed AI workflows from failed integrations and zombie workers using AGBoss, Saga compensation, checkpoint takeover, and two-layer lease fencing."
tags: devchallenge, hf26challenge, ai, opensource
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 4: Ghost in the Machine](https://dev.to/challenges/hacktoberfest-week4-2026-10-26).*

# Ghost in the Machine: The Zombie AI Worker

*It lost its lease. Another worker took over. Then the zombie came back.*

> **The worker didn't survive. The workflow did.**

---

## What I Built

Imagine your team has built an AI-assisted release engineering pipeline. A coordinator decomposes a release into module build tasks (`auth-service`, `payment-engine`, `telemetry-collector`), distributes them across a pool of worker processes, verifies an integration smoke gate, and—when a build fails—uses an LLM recovery agent to inspect the failure and synthesize corrected compiler flags.

In a single-process notebook, everything looks effortless.

Then you deploy across multiple worker processes or containers, and two classic distributed-systems ghosts appear:

1. **The Half-Committed Saga**: Multiple workers concurrently stage release artifacts to shared storage. Moments later, the integration smoke gate fails because `payment-engine` requires `--abi-compat=v2`. If your workflow simply aborts—or worse, asks an LLM to "clean up the failed files via tool calls"—orphaned staging files corrupt the next release attempt.
2. **The Zombie Worker**: During Attempt 2, **Worker A** claims `payment-engine` under `leaseEpoch = 1`, completes Step 1 (`PrepareModuleCandidateAction`), commits its LangGraph checkpoint, and freezes mid-Step 2 (`StageModuleArtifactAction`) due to an OS stall, GC pause, or container freeze. Its 30-second execution lease expires. **Worker B** reclaims the orphaned execution under `leaseEpoch = 2`, resumes directly from Worker A's Step 1 checkpoint, and commits Step 2.  
   **Then Worker A wakes up.** Still holding `leaseEpoch = 1` in memory, the zombie worker attempts to write its stale artifact and overwrite the workflow checkpoint.

To solve both failure modes cleanly—and prove every guarantee experimentally—I built [**`agbossjs/distributed-agent-recovery`**](https://github.com/agbossjs/distributed-agent-recovery), an open-source distributed recovery showcase powered by [**AGBoss**](https://github.com/agbossjs/agboss) (`@agboss/core@0.1.0` and `@agboss/cli@0.1.0`, documentation at [agboss.dev](https://agboss.dev)).

The showcase pairs **deterministic distributed systems guarantees** (lease ownership, checkpoint continuation, monotonic fencing tokens, and LIFO Saga compensation) with **typed LLM recovery planning** (`ReleaseRecoveryPlannerAgent` running `openai/gpt-4o-mini`), verified across real OS worker processes (`SIGSTOP`/`SIGCONT`), a 4-container Docker Compose cluster (including hard `exit 137` container death), and a single-node Kubernetes (`kind`) deployment.

**What makes this a genuine AI application (and why the boundary matters):**  
Asking an LLM to delete orphaned staging files or track lease ownership via prompt instructions is non-deterministic and brittle—that belongs to deterministic workflow infrastructure. Conversely, diagnosing an unstructured build/integration smoke-gate failure and synthesizing corrected compiler flags across modules is an unstructured reasoning task where an LLM agent shines. Once deterministic Saga compensation rolls back Attempt 1's staged files, `ReleaseRecoveryPlannerAgent` (`openai/gpt-4o-mini`, governed by `@Budget` cost guardrails) autonomously invokes `InspectFailedAttemptTool` against the SQLite ledger to confirm cleanup succeeded, diagnoses the ABI mismatch (`payment-engine requires --abi-compat=v2`), and emits a schema-validated `RecoveryPlanDto` that drives Attempt 2.

---

## Demo

![Zombie Worker Recovery Demo](https://raw.githubusercontent.com/agbossjs/distributed-agent-recovery/main/docs/assets/zombie-worker-demo.gif)

- **GitHub Repository**: [github.com/agbossjs/distributed-agent-recovery](https://github.com/agbossjs/distributed-agent-recovery)
- **AGBoss Framework**: [github.com/agbossjs/agboss](https://github.com/agbossjs/agboss)
- **Architecture & Docs Walkthrough**: [agboss.dev/examples/distributed-agent-recovery/](https://agboss.dev/examples/distributed-agent-recovery/)
- **Recorded Live LLM + Real-Clock `SIGSTOP` Evidence**: [`docs/evidence/live-real-clock-cluster-run.json`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/docs/evidence/live-real-clock-cluster-run.json) · [`docs/evidence/live-real-clock-cluster-runtime.log`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/docs/evidence/live-real-clock-cluster-runtime.log)

### Real-Clock POSIX `SIGSTOP` + Live `openai/gpt-4o-mini` Experiment

For fast offline reproducibility ($0 cost), `npm test` and `npm run demo` use a deterministic offline OpenRouter transport. To prove the central claim under real operating-system conditions and live LLM inference, we ran the compiled multi-process cluster with untouched 30-second AGBoss lease sweeps, real POSIX `SIGSTOP`/`SIGCONT` process freezing, and live OpenRouter (`openai/gpt-4o-mini`):

```bash
npm run build
AGBOSS_LOG_WORKERS=true OPENROUTER_API_KEY="sk-or-..." \
  node dist/src/demo.js --cluster --live --real-clock
```

Here is what actually happened on the machine (recorded verbatim in [`docs/evidence/live-real-clock-cluster-run.json`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/docs/evidence/live-real-clock-cluster-run.json)):

1. **Independent OS Processes**: Coordinator `PID 2768` spawned two standalone worker processes:
   - Worker Alpha: `PID 2772` (`instanceId = 2cfa9c79-b0c0-43d4-b1e5-3124f9f77098`)
   - Worker Beta: `PID 2783` (`instanceId = bfa0c7de-86c6-4cc6-9536-5b55124bb544`)
2. **Attempt 1 (`executionId = 2be7d7f8-c575-4846-b261-c1ef4aea5e93`)**:
   - Both workers staged `.artifact.json` files concurrently (`PID 2772` handled `auth-service`; `PID 2783` handled `payment-engine` and `telemetry-collector`).
   - `VerifyReleaseSmokeGateAction` threw `ReleaseGateFailedError` (missing `--abi-compat=v2`).
   - AGBoss triggered `CompensateReleaseCandidateAction`, deleting all 3 staged Attempt 1 files and marking the SQLite ledger rows `COMPENSATED`.
   - Live `ReleaseRecoveryPlannerAgent` (`openai/gpt-4o-mini`, served by `OpenAI` via OpenRouter: `2` API calls, `1,705` input tokens, `178` output tokens, **`$0.00036255` total cost**) invoked `InspectFailedAttemptTool` against SQLite to verify `allArtifactsCompensated === true` and returned `RecoveryPlanDto` with `correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2"`.
3. **Attempt 2 (`executionId = bbd3d722-6ab2-4493-94c1-177e49035dd9`) & Real `SIGSTOP` Zombie Freeze**:
   - Worker `PID 2783` (`bfa0c7de-...`) claimed child workflow `f9907abf-19fd-498b-8397-49152e25345f` (`rel-2026.10.0:payment-engine`) under `leaseEpoch = 1`, completed Step 1 (`PrepareModuleCandidateAction`), saved its checkpoint, and received **`SIGSTOP`**, freezing the OS process mid-Step 2.
   - After the real 30-second lease TTL expired, surviving Worker `PID 2772` (`2cfa9c79-...`) reclaimed the **exact same `executionId`** under `leaseEpoch = 2`:
     ```text
     [worker:2772] 04:15:23 WARN  execution f9907abf-19fd-498b-8397-49152e25345f is recovered:
       it continues from its last checkpoint [execution.recovered]
     ```
   - Worker `PID 2772` skipped Step 1 (already checkpointed), committed Step 2 under `leaseEpoch = 2` with the preserved step idempotency key `f9907abf-19fd-498b-8397-49152e25345f:stage-module-artifact-action:1`, and later sent `SIGCONT` to wake the frozen worker.
   - When Zombie Worker `PID 2783` resumed with stale `leaseEpoch = 1`, its external artifact write was rejected by `LeaseFencingService` (`ZOMBIE_WRITE_REJECTED`), and its subsequent checkpoint write was rejected by AGBoss's `LeasedCheckpointSaver` (`ExecutionLeaseLostError` / `execution.lease-lost`).

---

## Code

Repository: [**github.com/agbossjs/distributed-agent-recovery**](https://github.com/agbossjs/distributed-agent-recovery) (verified CI run: [Actions Run #40633290740](https://github.com/agbossjs/distributed-agent-recovery/actions/runs/40633290740)).

Requires **Node.js `>= 22.13.0`** (uses built-in `node:sqlite`). By default, tests and demos run **100% offline ($0 cost)** using a deterministic OpenRouter transport stub:

```bash
git clone https://github.com/agbossjs/distributed-agent-recovery.git
cd distributed-agent-recovery

npm ci
npm run check
npm test
npm run demo:cluster
npm run verify
```

Optional live LLM (`openai/gpt-4o-mini`), real-clock POSIX `SIGSTOP`, and Docker Compose runs:

```bash
# Live OpenRouter inference (ReleaseRecoveryPlannerAgent + InspectFailedAttemptTool):
OPENROUTER_API_KEY="sk-or-v1-..." npm run demo:live

# Real 30s lease TTL + POSIX SIGSTOP/SIGCONT OS worker freeze:
npm run build
node dist/src/demo.js --cluster --real-clock

# 4-container Docker Compose cluster (auto-cleans containers & volume on exit):
npm run demo:compose
```

---

## How I Built It

### 1. Declarative Workflow Graph, Saga Rollback & Typed AI Replanning

[**AGBoss**](https://agboss.dev) builds on LangGraph with compile-time static verification (`agboss check`). Before a single token is spent, `agboss check` verifies DTO transitions between steps, prompt template variables, DI bindings, static model declarations, and worst-case execution concurrency.

In [`src/workflows/release-coordinator/release-coordinator.workflow.ts`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/workflows/release-coordinator/release-coordinator.workflow.ts), parallel distributed fan-out, saga-backed candidate locking, error routing, and AI recovery planning live in one declarative graph:

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

### 2. Precise Guarantee Boundaries: What AGBoss Guarantees vs. What the Application Enforces

In distributed systems, overclaiming is as dangerous as under-engineering. A clean recovery architecture requires an explicit contract between the **workflow runtime** and the **application's side-effect layer**:

- **What AGBoss Guarantees**:
  - Orchestrating reverse-order (`LIFO`) `@Action({ compensateWith })` steps and explicit `.onError(...)` compensation routes before invoking downstream recovery agents.
  - Managing distributed child workflow queueing (`ChildPlacement.AnyInstance`), 30-second execution lease ownership (`execution_leases`), and expired-lease reclamation across worker instances.
  - Resuming a reclaimed `executionId` from its last committed LangGraph checkpoint and fencing stale checkpoint writes via `LeasedCheckpointSaver.putWrites()` (`ExecutionLeaseLostError`).
  - Providing deterministic per-step idempotency keys (`<executionId>:<nodeId>:<visitNumber>`).
- **What the Application & SQLite Ledger Enforce**:
  - AGBoss cannot magically roll back arbitrary external filesystems or third-party APIs on its own—the application's [`CompensateReleaseCandidateAction`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/actions/compensate-release-candidate.action.ts) and [`ReleaseCompensationService`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/services/release-compensation.service.ts) perform the physical `.artifact.json` cleanup and transactional `COMPENSATED` state transition using `step.idempotencyKey`.
  - Before `ReleaseRecoveryPlannerAgent` plans Attempt 2, it does not blindly assume cleanup succeeded: it calls [`InspectFailedAttemptTool`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/tools/inspect-failed-attempt.tool.ts) to query the SQLite ledger and verify `allArtifactsCompensated === true`.

### 3. Why Two-Layer Zombie Fencing Matters at the Side-Effect Boundary

AGBoss's runtime `LeaseFence` validates and renews leases whenever a step finishes and writes its checkpoint (`LeasedCheckpointSaver.putWrites`). However, an `@Action` performs external I/O *inside* its `execute()` method—**before** returning control to LangGraph's checkpoint saver.

Therefore, [`StageModuleArtifactAction`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/actions/stage-module-artifact.action.ts) captures the worker's active `(instanceId, leaseEpoch)` at step entry and passes it as a monotonic fencing token into [`LeaseFencingService.checkAndAdvanceFence()`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/services/lease-fencing.service.ts):

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

This creates a true **two-layer fence**:
1. **Layer 1 (Application External Side-Effect Fence)**: Rejects the zombie's filesystem/ledger commit inside SQLite (`1 < 2`) and throws `StaleLeaseFenceError`.
2. **Layer 2 (AGBoss Runtime Checkpoint Fence)**: When the zombie worker exits the step, `LeasedCheckpointSaver.putWrites()` attempts `ExecutionLeaseRepository.renew({ leaseEpoch: 1 })`, which returns `false` and throws `ExecutionLeaseLostError` (`code: "execution.lease-lost"`), preventing any split-brain checkpoint branch.

### 4. Independent Verification Against AGBoss's Internal Tables (Not Just App Event Logs)

Checking only that an application log contains `"ZOMBIE_WRITE_REJECTED"` is not a sufficient proof of runtime correctness. Both our Vitest suite ([`module-worker.workflow.test.ts`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/tests/workflows/module-worker/module-worker.workflow.test.ts)) and [`ReleaseInvariantVerifierService`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/services/release-invariant-verifier.service.ts) (`INV-1` through `INV-8`) directly inspect **AGBoss's own internal SQLite tables** via [`ClusterSnapshotRepository`](https://github.com/agbossjs/distributed-agent-recovery/blob/main/src/repositories/cluster-snapshot.repository.ts):

- **`execution_leases`**: Confirms `execution_id = f9907abf-19fd-498b-8397-49152e25345f` advanced to `lease_epoch = 2`, is owned by replacement worker `2cfa9c79-...` (not stalled worker `bfa0c7de-...`), and finished cleanly with `released = 1`.
- **`checkpoints`**: Traverses every LangGraph checkpoint row (`6` checkpoints for the recovered child execution) and verifies that `parent_checkpoint_id` forms a **single strictly linear unbranched chain**—proving `LeasedCheckpointSaver` blocked the zombie worker from writing a competing checkpoint fork.
- **`child_execution_queue`**: Confirms `0` unclaimed or orphaned child execution rows remain.

*(Note: reading `@agboss/core@0.1.0`'s internal SQLite tables directly in `ClusterSnapshotRepository` is a verification-only diagnostic technique for proving runtime invariants, not a recommended application integration API.)*

All 8 invariants run automatically on every push in GitHub Actions across **three CI environments**:
1. **Node 24 Real-Clock POSIX `SIGSTOP`/`SIGCONT` Multi-Process Gate** (`node dist/src/demo.js --cluster --real-clock`).
2. **4-Container Docker Compose & Hard Worker-Crash (`exit 137`) Gate** (verifying both zombie stall takeover and abrupt container death mid-step).
3. **Single-Node Kubernetes (`kind`) Gate** (`Deployment/agboss-worker` with `replicas: 2` + `Job/agboss-release-coordinator`).

### 5. Guarantee Boundaries & Trade-offs

- **At-Least-Once Execution with Idempotent Effects & Fencing (Not "Exactly-Once")**: Lease takeover replays unfinished steps *at-least-once* from the last committed checkpoint. Duplicate external commits are prevented not by claiming "exactly-once process execution," but by combining deterministic per-step idempotency keys (`<executionId>:<nodeId>:<visitNumber>`) with monotonic `leaseEpoch` fencing in the application ledger.
- **Reversible Compensation vs. Hard-Kill Lease Recovery**: Saga compensation only undoes *reversible* operations (such as deleting staged candidate files prior to final promotion) when an active workflow hits a downstream error (`ReleaseGateFailedError`); irreversible external effects must still be gated behind final promotion or an outbox. Moreover, a hard-killed worker (`SIGKILL` / `exit 137`) does not run in-process compensation when it dies—instead, its lease expires and a surviving worker resumes the child execution from its last checkpoint.
- **Fixed Worker Pool Failover (No Autoscaler Claimed)**: Work is distributed and recovered across a fixed pool of worker processes/containers (`ChildPlacement.AnyInstance`). Dynamic horizontal autoscaling (e.g., HPA/KEDA scaling pods on queue depth) is orthogonal and not claimed here.
- **Single-Host Shared SQLite `WAL` vs. Multi-Host Distributed Storage**: Sharing a SQLite database in `WAL` mode across OS processes, Docker Compose containers, or single-node `kind` pods gives anyone a zero-dependency distributed sandbox relying on single-host kernel file locks. Multi-node clusters across separate hosts require network-backed storage repositories (such as PostgreSQL) implementing the same monotonic `leaseEpoch` fencing contract.
- **Cooperative External I/O Fencing**: Neither Node.js nor LangGraph can pre-empt an in-flight userland syscall mid-step without killing the process; any external store mutated *inside* an `@Action` must validate the monotonic `leaseEpoch` fencing token or `step.idempotencyKey`.

---

## Why Does Open Innovation Matter?

Today's open-source AI ecosystem has hundreds of libraries for prompt chaining, yet surprisingly few open, inspectable references for what happens when distributed AI workflows meet real infrastructure failures—stalled containers, expired leases, half-committed side effects, and split-brain retries.

Keeping workflow engines like [**AGBoss**](https://github.com/agbossjs/agboss) (`Apache-2.0`), LangGraph checkpoint contracts, and reproducible fault-injection benchmarks (`SIGSTOP`, container `exit 137`, independent SQLite state verifiers) open source lets engineers audit the exact failure boundaries instead of trusting black-box "durable AI" marketing claims. Anyone can clone the repo, freeze a live worker process with `SIGSTOP`, inspect the `execution_leases` and `checkpoints` tables firsthand, and build safer AI systems on top of proven distributed systems primitives.
