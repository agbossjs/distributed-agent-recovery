import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Clock,
  ExecutionLeaseLostError,
  ExecutionStatus,
  createApp,
} from "@agboss/core";
import { describe, expect, it } from "vitest";
import { FastClusterClock } from "../../../scenarios/fast-cluster-clock.js";
import { createOfflineOpenRouterFetch } from "../../../scenarios/offline-openrouter-fetch.js";
import {
  DistributedAgentRecoveryApplication,
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
} from "../../../src/distributed-agent-recovery.application.js";
import { ReleaseArtifactRepository } from "../../../src/repositories/release-artifact.repository.js";

describe("ModuleWorkerWorkflow — Same-Task Takeover & Two-Layer Zombie Fencing", () => {
  it("recovers the exact same child execution on a second worker instance and fences the zombie worker at both SQLite ledger and AGBoss LeasedCheckpointSaver boundaries", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "agboss-takeover-test-"));
    const sqlitePath = join(workDir, "takeover.sqlite");
    const artifactDir = join(workDir, "artifacts");
    const clock = new FastClusterClock();

    const makeNode = (role: string) =>
      createApp(DistributedAgentRecoveryApplication, {
        processEnv: {
          ...process.env,
          SQLITE_PATH: sqlitePath,
          ARTIFACT_DIR: artifactDir,
          AGBOSS_NODE_ROLE: role,
          OPENROUTER_API_KEY: "offline-test-openrouter-api-key",
          PII_PSEUDONYM_KEY: "distributed-agent-recovery-pseudonym-key-32b!",
        },
        providerFetch: createOfflineOpenRouterFetch(),
        container: { overrides: new Map([[Clock, clock]]) },
      });

    const coordinator = await makeNode("coordinator");
    const workerA = await makeNode("worker");
    const workerB = await makeNode("worker");

    try {
      const exec = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
        releaseId: "rel-spike-001",
        version: "1.0.0",
        attemptNumber: 1,
        modules: "task-001",
        buildFlags: "--opt-level=2",
        simulateIntegrationFailure: false,
        stallTargetModule: "task-001",
      });

      expect(exec.status).toBe(ExecutionStatus.Finished);
      expect(exec).toFinishWith(ReleaseCoordinatorWorkflowFinish, {
        releaseId: "rel-spike-001",
        version: "1.0.0",
        attemptNumber: 1,
        status: "PROMOTED",
        promotedModuleCount: 1,
        participatingInstances: expect.any(String) as string,
        manifestPath: expect.any(String) as string,
      });

      const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
        sqlitePath,
        artifactDir,
        releaseId: "rel-spike-001",
      });
      expect(snap.artifacts).toHaveLength(1);

      const committed = snap.artifacts[0];
      if (committed === undefined) {
        throw new Error("Expected committed artifact for task-001");
      }

      // Step 1 happened on Worker A under leaseEpoch=1; Step 2 takeover completed on Worker B under leaseEpoch=2
      expect(committed.logicalTaskId).toBe("task-001");
      expect(committed.preparedByInstanceId).not.toBe(
        committed.committedByInstanceId,
      );
      expect(committed.leaseEpoch).toBe(2);
      expect(committed.idempotencyKey).toBe(
        `${committed.executionId}:stage-module-artifact-action:1`,
      );
      expect(existsSync(committed.artifactPath)).toBe(true);

      const ops = snap.events.map((e) => e.operation);
      expect(ops).toContain("PREPARE_MODULE");
      expect(ops).toContain("WORKER_STALLED_LEASE_EXPIRED");
      expect(ops).toContain("LEASE_TAKEOVER_COMPLETED");
      expect(ops).toContain("STAGE_ARTIFACT");
      expect(ops).toContain("ZOMBIE_WRITE_REJECTED");
      expect(ops).toContain("RUNTIME_LEASE_FENCED");

      const runtimeFence = snap.events.find(
        (e) => e.operation === "RUNTIME_LEASE_FENCED",
      );
      const details = JSON.parse(runtimeFence?.details ?? "{}") as {
        errorCode?: string;
      };
      expect(details.errorCode).toBe(ExecutionLeaseLostError.code);

      // Independent verification directly against AGBoss's own core SQLite tables
      // (`execution_leases`, `checkpoints`, `child_execution_queue`) without relying on `ledger_events`:
      const agbossLeaseRow = snap.executionLeases.find(
        (row) => row.rootExecutionId === committed.executionId,
      );
      expect(agbossLeaseRow).toBeDefined();
      expect(agbossLeaseRow?.leaseEpoch).toBe(2);
      expect(agbossLeaseRow?.holderInstanceId).toBe(committed.committedByInstanceId);
      expect(agbossLeaseRow?.holderInstanceId).not.toBe(committed.preparedByInstanceId);
      expect(agbossLeaseRow?.released).toBe(1);

      const childCheckpoints = snap.checkpoints.filter(
        (c) =>
          c.threadId === committed.executionId ||
          c.threadId.endsWith(`/child/${committed.executionId}`),
      );
      expect(childCheckpoints.length).toBeGreaterThanOrEqual(4);
      const uniqueParentCheckpoints = new Set(
        childCheckpoints.map((c) => c.parentCheckpointId ?? "__root__"),
      );
      // Unbranched linear parent_checkpoint_id chain proves LeasedCheckpointSaver fenced
      // the zombie worker's stale putWrites() without creating a split-brain checkpoint fork.
      expect(uniqueParentCheckpoints.size).toBe(childCheckpoints.length);

      const stuckQueueRows = snap.childQueue.filter(
        (q) => q.executionId === committed.executionId && q.status !== "finished",
      );
      expect(stuckQueueRows).toHaveLength(0);
    } finally {
      await Promise.all([
        workerA.close(),
        workerB.close(),
        coordinator.close(),
      ]);
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
