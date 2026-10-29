import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, ExecutionLeaseLostError, ExecutionStatus, createApp } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { FastClusterClock } from "../../../scenarios/fast-cluster-clock.js";
import { createOfflineOpenRouterFetch } from "../../../scenarios/offline-openrouter-fetch.js";
import {
  DistributedAgentRecoveryApplication,
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
} from "../../../src/distributed-agent-recovery.application.js";
import { StaleLeaseFenceError } from "../../../src/errors/stale-lease-fence.error.js";
import { ReleaseArtifactRepository } from "../../../src/repositories/release-artifact.repository.js";
import { ProtectedWriteVerifierService } from "../../../src/services/protected-write-verifier.service.js";
import { ReleaseInvariantVerifierService } from "../../../src/services/release-invariant-verifier.service.js";

async function withClusterHarness(
  extraEnv: Readonly<Record<string, string>>,
  run: (ctx: {
    readonly sqlitePath: string; readonly artifactDir: string;
    readonly coordinator: Awaited<ReturnType<typeof createApp>>;
  }) => Promise<void>,
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "agboss-takeover-test-"));
  const sqlitePath = join(workDir, "takeover.sqlite");
  const artifactDir = join(workDir, "artifacts");
  const clock = new FastClusterClock();
  const makeNode = (role: string) =>
    createApp(DistributedAgentRecoveryApplication, {
      processEnv: {
        ...process.env, SQLITE_PATH: sqlitePath, ARTIFACT_DIR: artifactDir, AGBOSS_NODE_ROLE: role,
        OPENROUTER_API_KEY: "offline-test-openrouter-api-key",
        PII_PSEUDONYM_KEY: "distributed-agent-recovery-pseudonym-key-32b!", ...extraEnv,
      },
      providerFetch: createOfflineOpenRouterFetch(),
      container: { overrides: new Map([[Clock, clock]]) },
    });
  const coordinator = await makeNode("coordinator");
  const workerA = await makeNode("worker");
  const workerB = await makeNode("worker");
  try {
    await run({ sqlitePath, artifactDir, coordinator });
  } finally {
    await Promise.all([workerA.close(), workerB.close(), coordinator.close()]);
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe("ModuleWorkerWorkflow — Same-Task Takeover & Stale-Write Rejection Verification", () => {
  it("Case A: rejects a resumed stale worker's protected write with correlated token, checkpoint, and artifact evidence", async () => {
    await withClusterHarness({}, async ({ sqlitePath, artifactDir, coordinator }) => {
      const exec = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
        releaseId: "rel-spike-001", version: "1.0.0", attemptNumber: 1,
        modules: "task-001", buildFlags: "--opt-level=2",
        simulateIntegrationFailure: false, stallTargetModule: "task-001",
      });

      expect(exec.status).toBe(ExecutionStatus.Finished);
      expect(exec).toFinishWith(ReleaseCoordinatorWorkflowFinish, {
        releaseId: "rel-spike-001", version: "1.0.0", attemptNumber: 1,
        status: "PROMOTED", promotedModuleCount: 1,
        participatingInstances: expect.any(String) as string,
        manifestPath: expect.any(String) as string,
      });

      const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
        sqlitePath, artifactDir, releaseId: "rel-spike-001",
      });
      expect(snap.artifacts).toHaveLength(1);
      const committed = snap.artifacts[0];
      if (committed === undefined) throw new Error("Expected committed artifact for task-001");

      expect(committed.logicalTaskId).toBe("task-001");
      expect(committed.preparedByInstanceId).not.toBe(committed.committedByInstanceId);
      expect(committed.leaseEpoch).toBe(2);
      expect(committed.idempotencyKey).toBe(`${committed.executionId}:stage-module-artifact-action:1`);
      expect(existsSync(committed.artifactPath)).toBe(true);

      const ops = snap.events.map((e) => e.operation);
      expect(ops).toEqual(expect.arrayContaining([
        "PREPARE_MODULE", "WORKER_STALLED_LEASE_EXPIRED", "LEASE_TAKEOVER_COMPLETED",
        "STAGE_ARTIFACT", "ZOMBIE_WRITE_REJECTED", "RUNTIME_LEASE_FENCED",
      ]));

      const runtimeFence = snap.events.find((e) => e.operation === "RUNTIME_LEASE_FENCED");
      const rfDetails = JSON.parse(runtimeFence?.details ?? "{}") as { errorCode?: string };
      expect(rfDetails.errorCode).toBe(ExecutionLeaseLostError.code);

      const summary = await ProtectedWriteVerifierService.verifyFromFile({
        sqlitePath, artifactDir, releaseId: "rel-spike-001", attemptNumber: 1, expectedModules: ["task-001"],
      });
      expect(summary.outcome).toBe("STALE_WRITE_REJECTED");
      expect(summary.fencingRejectionDemonstrated).toBe(true);

      const taskReport = summary.tasks[0];
      expect(taskReport?.protectedArtifactVerifiedOnDisk).toBe(true);
      expect(taskReport?.rejectionEvidence).toMatchObject({
        attemptedOperation: "STAGE_ARTIFACT",
        targetArtifactId: committed.artifactId,
        workerInstanceId: committed.preparedByInstanceId,
        executionId: committed.executionId,
        logicalTaskId: committed.logicalTaskId,
        idempotencyKey: committed.idempotencyKey,
        capturedToken: { holderInstanceId: committed.preparedByInstanceId, leaseEpoch: 1 },
        observedToken: { holderInstanceId: committed.committedByInstanceId, leaseEpoch: 2 },
        rejectionReason: "STALE_LEASE_EPOCH",
        errorCode: StaleLeaseFenceError.code,
      });
      expect(taskReport?.rejectionEvidence?.capturedCheckpointId).toEqual(expect.any(String));

      const diskManifest = JSON.parse(readFileSync(committed.artifactPath, "utf8")) as Record<string, unknown>;
      expect(diskManifest["committedByInstanceId"]).toBe(committed.committedByInstanceId);
      expect(diskManifest["leaseEpoch"]).toBe(2);

      const report = await ReleaseInvariantVerifierService.verifyFromFile({
        sqlitePath, artifactDir, releaseId: "rel-spike-001",
        expectedModules: ["task-001"], targetAttemptNumber: 1, requireStaleWriteRejection: true,
      });
      expect(report.allVerified).toBe(true);
      expect(report.protectedWriteVerification.fencingRejectionDemonstrated).toBe(true);
    });
  });

  it("Case B: distinguishes a stale worker that never attempts a protected write without fabricating rejection events", async () => {
    await withClusterHarness(
      { AGBOSS_SKIP_STALE_WRITE_ATTEMPT: "true" },
      async ({ sqlitePath, artifactDir, coordinator }) => {
        const exec = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
          releaseId: "rel-no-attempt-001", version: "1.0.0", attemptNumber: 1,
          modules: "task-001", buildFlags: "--opt-level=2",
          simulateIntegrationFailure: false, stallTargetModule: "task-001",
        });

        expect(exec.status).toBe(ExecutionStatus.Finished);
        const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
          sqlitePath, artifactDir, releaseId: "rel-no-attempt-001",
        });
        expect(snap.events.filter((e) => e.operation === "ZOMBIE_WRITE_REJECTED")).toHaveLength(0);

        const summary = ProtectedWriteVerifierService.verifyAttempt(snap, {
          releaseId: "rel-no-attempt-001", attemptNumber: 1, expectedModules: ["task-001"],
        });
        expect(summary.outcome).toBe("STALE_WRITE_NOT_ATTEMPTED");
        expect(summary.fencingRejectionDemonstrated).toBe(false);
        expect(summary.tasks[0]?.nonAttemptDisposition).toBe("SUSPENDED_BEFORE_WRITE");
        expect(summary.tasks[0]?.rejectionEvidence).toBeNull();
        expect(summary.tasks[0]?.protectedArtifactVerifiedOnDisk).toBe(true);

        const takeoverReport = ReleaseInvariantVerifierService.verifySnapshot(
          snap, "rel-no-attempt-001", ["task-001"], { targetAttemptNumber: 1 },
        );
        expect(takeoverReport.allVerified).toBe(true);
        expect(takeoverReport.protectedWriteVerification.outcome).toBe("STALE_WRITE_NOT_ATTEMPTED");
        expect(takeoverReport.protectedWriteVerification.fencingRejectionDemonstrated).toBe(false);

        const strictFenceReport = ReleaseInvariantVerifierService.verifySnapshot(
          snap, "rel-no-attempt-001", ["task-001"],
          { targetAttemptNumber: 1, requireStaleWriteRejection: true },
        );
        expect(strictFenceReport.allVerified).toBe(false);
      },
    );
  });

  it("Case C: accepts a valid owner's protected write with no false stale-write rejection", async () => {
    await withClusterHarness({}, async ({ sqlitePath, artifactDir, coordinator }) => {
      const exec = await coordinator.execute(ReleaseCoordinatorWorkflowStart, {
        releaseId: "rel-valid-owner-001", version: "1.0.0", attemptNumber: 1,
        modules: "auth-service,payment-engine", buildFlags: "--opt-level=2",
        simulateIntegrationFailure: false, stallTargetModule: "",
      });

      expect(exec.status).toBe(ExecutionStatus.Finished);
      const snap = await ReleaseArtifactRepository.readSnapshotFromFile({
        sqlitePath, artifactDir, releaseId: "rel-valid-owner-001",
      });
      expect(snap.events.filter((e) => e.operation === "ZOMBIE_WRITE_REJECTED")).toHaveLength(0);

      const summary = ProtectedWriteVerifierService.verifyAttempt(snap, {
        releaseId: "rel-valid-owner-001", attemptNumber: 1,
        expectedModules: ["auth-service", "payment-engine"],
      });
      expect(summary.outcome).toBe("VALID_OWNER_ACCEPTED");
      expect(summary.fencingRejectionDemonstrated).toBe(false);
      expect(summary.validOwnerAcceptedCount).toBe(2);

      const validReport = ReleaseInvariantVerifierService.verifySnapshot(
        snap, "rel-valid-owner-001", ["auth-service", "payment-engine"],
        { targetAttemptNumber: 1, expectLeaseTakeover: false },
      );
      expect(validReport.protectedWriteVerification.outcome).toBe("VALID_OWNER_ACCEPTED");
      expect(validReport.protectedWriteVerification.fencingRejectionDemonstrated).toBe(false);
      expect(validReport.checks.find((c) => c.number === 7)?.status).toBe("VERIFIED");
    });
  });
});
