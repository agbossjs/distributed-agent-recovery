import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExecutionLeaseLostError } from "@agboss/core";
import { afterEach, describe, expect, it } from "vitest";
import { StaleLeaseFenceError } from "../../src/errors/stale-lease-fence.error.js";
import type {
  LedgerSnapshot,
  ProtectedWriteRejectionEvidence,
  StallDisposition,
  StallStatus,
} from "../../src/schemas/release-ledger.schema.js";
import { ProtectedWriteVerifierService } from "../../src/services/protected-write-verifier.service.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  readonly stallDisposition?: StallDisposition | null;
  readonly stallStatus?: StallStatus | null;
  readonly includeRejection?: boolean;
  readonly rejectionOverrides?: Partial<ProtectedWriteRejectionEvidence>;
  readonly diskCommittedBy?: string;
  readonly diskLeaseEpoch?: number;
}

function buildSnapshotFixture(opts: FixtureOptions = {}): LedgerSnapshot {
  const workDir = mkdtempSync(join(tmpdir(), "agboss-pw-verifier-"));
  tempDirs.push(workDir);
  const artifactDir = join(workDir, "artifacts");
  const releaseId = "rel-verify-01";
  const moduleName = "payment-engine";
  const logicalTaskId = `${releaseId}:${moduleName}`;
  const executionId = "exec-child-001";
  const workerA = "worker-a-stale";
  const workerB = "worker-b-owner";
  const artifactId = `art:${releaseId}:a2:${moduleName}`;
  const idempotencyKey = `${executionId}:stage-module-artifact-action:1`;
  const digest = `sha256:${releaseId}:a2:${moduleName}:--abi-compat=v2`;
  const threadId = `root-exec/child/${executionId}`;
  const stagingPath = join(artifactDir, "staging", releaseId, "attempt-2", `${moduleName}.artifact.json`);
  const promotedPath = join(artifactDir, "releases", releaseId, `${moduleName}.manifest.json`);
  const releaseManifestPath = join(artifactDir, "releases", releaseId, "release-manifest.json");
  mkdirSync(dirname(stagingPath), { recursive: true });
  mkdirSync(dirname(promotedPath), { recursive: true });

  const diskPayload = {
    artifactId, releaseId, version: "2.4.0", attemptNumber: 2, logicalTaskId, moduleName,
    executionId, preparedByInstanceId: workerA, committedByInstanceId: opts.diskCommittedBy ?? workerB,
    leaseEpoch: opts.diskLeaseEpoch ?? 2, idempotencyKey, candidateDigest: digest,
  };
  writeFileSync(stagingPath, JSON.stringify(diskPayload, null, 2), "utf8");
  writeFileSync(promotedPath, JSON.stringify({ ...diskPayload, status: "PROMOTED" }, null, 2), "utf8");
  writeFileSync(releaseManifestPath, JSON.stringify({
    releaseId, version: "2.4.0", attemptNumber: 2, status: "PROMOTED",
    modules: [{
      moduleName, logicalTaskId, artifactId, preparedByInstanceId: workerA,
      committedByInstanceId: workerB, leaseEpoch: 2, idempotencyKey, moduleManifestPath: promotedPath,
    }],
  }, null, 2), "utf8");

  const disposition = opts.stallDisposition === undefined ? "RESUME_AND_ATTEMPT_WRITE" : opts.stallDisposition;
  const includeRej = opts.includeRejection ?? true;
  const stallStatus: StallStatus | null =
    opts.stallStatus === undefined ? (includeRej ? "FENCED" : "STALLED") : opts.stallStatus;
  const baseRej: ProtectedWriteRejectionEvidence = {
    attemptedOperation: "STAGE_ARTIFACT", targetArtifactId: artifactId,
    targetStagingArtifactPath: stagingPath, candidateDigest: digest,
    workerInstanceId: workerA, executionId, releaseId, attemptNumber: 2, logicalTaskId, moduleName, idempotencyKey,
    capturedToken: { holderInstanceId: workerA, leaseEpoch: 1 },
    observedToken: { holderInstanceId: workerB, leaseEpoch: 2 },
    rejectionReason: "STALE_LEASE_EPOCH", errorCode: StaleLeaseFenceError.code,
    capturedCheckpointId: "cp-03", observedHeadCheckpointId: "cp-04", checkpointThreadId: threadId,
    activeHolderInstanceId: workerB, activeLeaseEpoch: 2, ...opts.rejectionOverrides,
  };

  return {
    sqlitePath: join(workDir, "cluster.sqlite"), artifactDir,
    artifacts: [{
      artifactId, releaseId, version: "2.4.0", attemptNumber: 2, logicalTaskId, moduleName,
      executionId, preparedByInstanceId: workerA, committedByInstanceId: workerB, leaseEpoch: 2,
      idempotencyKey, status: "PROMOTED", artifactPath: promotedPath, candidateDigest: digest,
      compensatedByKey: null, createdAt: 100, updatedAt: 200,
    }],
    candidateLocks: [{
      candidateLockId: `lock:${releaseId}:a2`, releaseId, version: "2.4.0", attemptNumber: 2,
      status: "PROMOTED", stagedModuleCount: 1, participatingInstances: `${workerA},${workerB}`,
      buildFlags: "--abi-compat=v2", idempotencyKey: "lock-key-2", compensatedByKey: null,
      failureDiagnostic: null, manifestPath: releaseManifestPath, createdAt: 150, updatedAt: 200,
    }],
    fencingTokens: [{
      tenantId: "default", executionId, logicalTaskId, releaseId, attemptNumber: 2,
      highestLeaseEpoch: 2, currentHolderInstanceId: workerB, updatedAt: 180,
    }],
    stalls: stallStatus === null ? [] : [{
      executionId, logicalTaskId, releaseId, attemptNumber: 2,
      stalledInstanceId: workerA, stalledLeaseEpoch: 1, status: stallStatus, createdAt: 110, updatedAt: 190,
    }],
    events: [
      { eventId: 1, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: 1, idempotencyKey: `${executionId}:prepare:1`, operation: "PREPARE_MODULE", outcome: "APPLIED", details: "{}", recordedAt: 100 },
      { eventId: 2, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: 1, idempotencyKey, operation: "WORKER_STALLED_LEASE_EXPIRED", outcome: "STALLED", details: JSON.stringify(disposition === null ? {} : { stallDisposition: disposition, targetArtifactId: artifactId, capturedCheckpointId: "cp-03", checkpointThreadId: threadId }), recordedAt: 110 },
      { eventId: 3, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerB, leaseEpoch: 2, idempotencyKey, operation: "LEASE_TAKEOVER_COMPLETED", outcome: "APPLIED", details: "{}", recordedAt: 140 },
      { eventId: 4, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerB, leaseEpoch: 2, idempotencyKey, operation: "STAGE_ARTIFACT", outcome: "APPLIED", details: JSON.stringify({ artifactId, capturedCheckpointId: "cp-03", checkpointThreadId: threadId }), recordedAt: 150 },
      ...(includeRej ? [
        { eventId: 5, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: baseRej.capturedToken.leaseEpoch, idempotencyKey, operation: "ZOMBIE_WRITE_REJECTED", outcome: "REJECTED_STALE_LEASE", details: JSON.stringify(baseRej), recordedAt: 160 },
        { eventId: 6, releaseId, attemptNumber: 2, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: 1, idempotencyKey: `fence:${executionId}:epoch-1`, operation: "RUNTIME_LEASE_FENCED", outcome: "REJECTED_BY_AGBOSS_LEASE_FENCE", details: JSON.stringify({ errorCode: ExecutionLeaseLostError.code }), recordedAt: 165 },
      ] : []),
    ],
    executionLeases: [{ tenantId: "default", rootExecutionId: executionId, holderInstanceId: workerB, leaseEpoch: 2, expiresAt: 999999, released: 1 }],
    childQueue: [{ tenantId: "default", executionId, rootExecutionId: "root-exec", parentExecutionId: "root-exec", rootWorkflow: "release-coordinator-workflow", workflow: "module-worker-workflow", depth: 1, status: "finished", run: "{}", queuedAt: 90, instanceId: workerB, claimedAt: 130, endedAt: 170, failure: null }],
    checkpoints: [
      { threadId, checkpointNs: "", checkpointId: "cp-01", parentCheckpointId: null, tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-02", parentCheckpointId: "cp-01", tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-03", parentCheckpointId: "cp-02", tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-04", parentCheckpointId: "cp-03", tenantId: "default" },
    ],
  };
}

describe("ProtectedWriteVerifierService — Rejection Evidence & Missing/Inconsistent Evidence (Case D)", () => {
  it("verifies both STALE_LEASE_EPOCH and LEASE_HOLDER_MISMATCH rejection evidence when properly correlated", () => {
    const epochSnap = buildSnapshotFixture();
    const holderSnap = buildSnapshotFixture({
      rejectionOverrides: {
        capturedToken: { holderInstanceId: "worker-a-stale", leaseEpoch: 2 },
        observedToken: { holderInstanceId: "worker-b-owner", leaseEpoch: 2 },
        rejectionReason: "LEASE_HOLDER_MISMATCH",
      },
    });
    for (const snap of [epochSnap, holderSnap]) {
      const res = ProtectedWriteVerifierService.verifyAttempt(snap, {
        releaseId: "rel-verify-01", attemptNumber: 2, expectedModules: ["payment-engine"],
      });
      expect(res.outcome).toBe("STALE_WRITE_REJECTED");
      expect(res.fencingRejectionDemonstrated).toBe(true);
    }
  });

  it("Case D2: does not infer no-attempt when ZOMBIE_WRITE_REJECTED is missing without explicit non-attempt instrumentation", () => {
    const snap = buildSnapshotFixture({ includeRejection: false, stallDisposition: "RESUME_AND_ATTEMPT_WRITE", stallStatus: "STALLED" });
    const res = ProtectedWriteVerifierService.verifyAttempt(snap, {
      releaseId: "rel-verify-01", attemptNumber: 2, expectedModules: ["payment-engine"],
    });
    expect(res.outcome).toBe("MISSING_OR_INCONSISTENT_EVIDENCE");
    expect(res.fencingRejectionDemonstrated).toBe(false);
  });

  it("Case D3: rejects uncorrelatable checkpoint/artifact identifiers or inconsistent fencing tokens", () => {
    const badCheckpoint = buildSnapshotFixture({ rejectionOverrides: { capturedCheckpointId: "missing-cp" } });
    const badArtifact = buildSnapshotFixture({ rejectionOverrides: { targetArtifactId: "art:rel-verify-01:a2:wrong" } });
    const badToken = buildSnapshotFixture({
      rejectionOverrides: { capturedToken: { holderInstanceId: "worker-a-stale", leaseEpoch: 3 }, rejectionReason: "STALE_LEASE_EPOCH" },
    });
    for (const snap of [badCheckpoint, badArtifact, badToken]) {
      const res = ProtectedWriteVerifierService.verifyAttempt(snap, {
        releaseId: "rel-verify-01", attemptNumber: 2, expectedModules: ["payment-engine"],
      });
      expect(res.outcome).toBe("MISSING_OR_INCONSISTENT_EVIDENCE");
      expect(res.fencingRejectionDemonstrated).toBe(false);
    }
  });

  it("Case D4 & D5: detects stale on-disk artifact corruption and flags contradictory fabricated rejection events", () => {
    const tamperedDisk = buildSnapshotFixture({ diskCommittedBy: "worker-a-stale", diskLeaseEpoch: 1 });
    const fabricatedRej = buildSnapshotFixture({
      includeRejection: true, stallDisposition: "TERMINATED_BEFORE_WRITE", stallStatus: "TERMINATED_BEFORE_WRITE",
    });
    const r1 = ProtectedWriteVerifierService.verifyAttempt(tamperedDisk, {
      releaseId: "rel-verify-01", attemptNumber: 2, expectedModules: ["payment-engine"],
    });
    expect(r1.outcome).toBe("MISSING_OR_INCONSISTENT_EVIDENCE");
    expect(r1.tasks[0]?.protectedArtifactVerifiedOnDisk).toBe(false);

    const r2 = ProtectedWriteVerifierService.verifyAttempt(fabricatedRej, {
      releaseId: "rel-verify-01", attemptNumber: 2, expectedModules: ["payment-engine"],
    });
    expect(r2.outcome).toBe("MISSING_OR_INCONSISTENT_EVIDENCE");
    expect(r2.fencingRejectionDemonstrated).toBe(false);
  });
});
