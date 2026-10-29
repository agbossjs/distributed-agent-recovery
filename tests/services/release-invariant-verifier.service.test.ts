import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerSnapshot, StallDisposition, StallStatus } from "../../src/schemas/release-ledger.schema.js";
import { ProtectedWriteEvidenceService } from "../../src/services/protected-write-evidence.service.js";
import { ReleaseInvariantVerifierService } from "../../src/services/release-invariant-verifier.service.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function buildInvariantSnapshot(params: {
  readonly stripEvents?: boolean;
  readonly stallDisposition?: StallDisposition | null;
  readonly stallStatus?: StallStatus | null;
}): LedgerSnapshot {
  const workDir = mkdtempSync(join(tmpdir(), "agboss-inv-verifier-"));
  tempDirs.push(workDir);
  const artifactDir = join(workDir, "artifacts");
  const releaseId = "rel-inv-01";
  const moduleName = "payment-engine";
  const logicalTaskId = `${releaseId}:${moduleName}`;
  const executionId = "exec-child-inv-1";
  const workerA = "worker-a-stale";
  const workerB = "worker-b-owner";
  const artifactId = `art:${releaseId}:a1:${moduleName}`;
  const idempotencyKey = `${executionId}:stage-module-artifact-action:1`;
  const digest = `sha256:${releaseId}:a1:${moduleName}:--abi-compat=v2`;
  const threadId = `root-exec/child/${executionId}`;
  const stagingPath = join(artifactDir, "staging", releaseId, "attempt-1", `${moduleName}.artifact.json`);
  const promotedPath = join(artifactDir, "releases", releaseId, `${moduleName}.manifest.json`);
  const releaseManifestPath = join(artifactDir, "releases", releaseId, "release-manifest.json");
  mkdirSync(dirname(stagingPath), { recursive: true });
  mkdirSync(dirname(promotedPath), { recursive: true });

  const diskPayload = {
    artifactId, releaseId, version: "1.0.0", attemptNumber: 1, logicalTaskId, moduleName,
    executionId, preparedByInstanceId: workerA, committedByInstanceId: workerB,
    leaseEpoch: 2, idempotencyKey, candidateDigest: digest,
  };
  writeFileSync(stagingPath, JSON.stringify(diskPayload, null, 2), "utf8");
  writeFileSync(promotedPath, JSON.stringify({ ...diskPayload, status: "PROMOTED" }, null, 2), "utf8");
  writeFileSync(releaseManifestPath, JSON.stringify({
    releaseId, version: "1.0.0", attemptNumber: 1, status: "PROMOTED",
    modules: [{
      moduleName, logicalTaskId, artifactId, preparedByInstanceId: workerA,
      committedByInstanceId: workerB, leaseEpoch: 2, idempotencyKey, moduleManifestPath: promotedPath,
    }],
  }, null, 2), "utf8");

  return {
    sqlitePath: join(workDir, "cluster.sqlite"), artifactDir,
    artifacts: [{
      artifactId, releaseId, version: "1.0.0", attemptNumber: 1, logicalTaskId, moduleName,
      executionId, preparedByInstanceId: workerA, committedByInstanceId: workerB, leaseEpoch: 2,
      idempotencyKey, status: "PROMOTED", artifactPath: promotedPath, candidateDigest: digest,
      compensatedByKey: null, createdAt: 100, updatedAt: 200,
    }],
    candidateLocks: [{
      candidateLockId: `lock:${releaseId}:a1`, releaseId, version: "1.0.0", attemptNumber: 1,
      status: "PROMOTED", stagedModuleCount: 1, participatingInstances: `${workerA},${workerB}`,
      buildFlags: "--abi-compat=v2", idempotencyKey: "lock-key-1", compensatedByKey: null,
      failureDiagnostic: null, manifestPath: releaseManifestPath, createdAt: 150, updatedAt: 200,
    }],
    fencingTokens: [{
      tenantId: "default", executionId, logicalTaskId, releaseId, attemptNumber: 1,
      highestLeaseEpoch: 2, currentHolderInstanceId: workerB, updatedAt: 180,
    }],
    stalls: params.stallStatus === null || params.stallStatus === undefined ? [] : [{
      executionId, logicalTaskId, releaseId, attemptNumber: 1,
      stalledInstanceId: workerA, stalledLeaseEpoch: 1, status: params.stallStatus, createdAt: 110, updatedAt: 190,
    }],
    events: params.stripEvents === true ? [] : [
      { eventId: 1, releaseId, attemptNumber: 1, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: 1, idempotencyKey: `${executionId}:prepare:1`, operation: "PREPARE_MODULE", outcome: "APPLIED", details: "{}", recordedAt: 100 },
      { eventId: 2, releaseId, attemptNumber: 1, logicalTaskId, moduleName, executionId, instanceId: workerA, leaseEpoch: 1, idempotencyKey, operation: "WORKER_STALLED_LEASE_EXPIRED", outcome: "STALLED", details: JSON.stringify(params.stallDisposition === null || params.stallDisposition === undefined ? {} : { stallDisposition: params.stallDisposition, targetArtifactId: artifactId, capturedCheckpointId: "cp-2", checkpointThreadId: threadId }), recordedAt: 110 },
      { eventId: 3, releaseId, attemptNumber: 1, logicalTaskId, moduleName, executionId, instanceId: workerB, leaseEpoch: 2, idempotencyKey, operation: "LEASE_TAKEOVER_COMPLETED", outcome: "APPLIED", details: "{}", recordedAt: 140 },
      { eventId: 4, releaseId, attemptNumber: 1, logicalTaskId, moduleName, executionId, instanceId: workerB, leaseEpoch: 2, idempotencyKey, operation: "STAGE_ARTIFACT", outcome: "APPLIED", details: JSON.stringify({ artifactId, capturedCheckpointId: "cp-2", checkpointThreadId: threadId }), recordedAt: 150 },
    ],
    executionLeases: [{ tenantId: "default", rootExecutionId: executionId, holderInstanceId: workerB, leaseEpoch: 2, expiresAt: 999999, released: 1 }],
    childQueue: [{ tenantId: "default", executionId, rootExecutionId: "root-exec", parentExecutionId: "root-exec", rootWorkflow: "release-coordinator-workflow", workflow: "module-worker-workflow", depth: 1, status: "finished", run: "{}", queuedAt: 90, instanceId: workerB, claimedAt: 130, endedAt: 170, failure: null }],
    checkpoints: [
      { threadId, checkpointNs: "", checkpointId: "cp-1", parentCheckpointId: null, tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-2", parentCheckpointId: "cp-1", tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-3", parentCheckpointId: "cp-2", tenantId: "default" },
      { threadId, checkpointNs: "", checkpointId: "cp-4", parentCheckpointId: "cp-3", tenantId: "default" },
    ],
  };
}

describe("ReleaseInvariantVerifierService — INV-7 & INV-8 Fencing vs Non-Attempt Distinction", () => {
  it("Case B (hard crash exit 137): classifies TERMINATED_BEFORE_WRITE as STALE_WRITE_NOT_ATTEMPTED and fails requireStaleWriteRejection", () => {
    const snap = buildInvariantSnapshot({
      stallDisposition: "TERMINATED_BEFORE_WRITE",
      stallStatus: "TERMINATED_BEFORE_WRITE",
    });

    const defaultReport = ReleaseInvariantVerifierService.verifySnapshot(
      snap, "rel-inv-01", ["payment-engine"], { targetAttemptNumber: 1 },
    );
    expect(defaultReport.allVerified).toBe(true);
    expect(defaultReport.protectedWriteVerification.outcome).toBe("STALE_WRITE_NOT_ATTEMPTED");
    expect(defaultReport.protectedWriteVerification.fencingRejectionDemonstrated).toBe(false);
    expect(defaultReport.protectedWriteVerification.tasks[0]?.nonAttemptDisposition).toBe("TERMINATED_BEFORE_WRITE");

    const strictReport = ReleaseInvariantVerifierService.verifySnapshot(
      snap, "rel-inv-01", ["payment-engine"],
      { targetAttemptNumber: 1, requireStaleWriteRejection: true },
    );
    expect(strictReport.allVerified).toBe(false);
    expect(strictReport.checks.find((c) => c.number === 7)?.status).toBe("FAILED");
  });

  it("Case D1: never reports a clean final artifact, leaseEpoch=2, and linear checkpoints alone as proof of fencing", () => {
    const prevEnv = process.env["AGBOSS_CRASH_WORKER_ON_STALL"];
    process.env["AGBOSS_CRASH_WORKER_ON_STALL"] = "true";
    try {
      const snap = buildInvariantSnapshot({ stripEvents: true, stallStatus: null });
      const report = ReleaseInvariantVerifierService.verifySnapshot(
        snap, "rel-inv-01", ["payment-engine"], { targetAttemptNumber: 1 },
      );
      expect(report.allVerified).toBe(false);
      expect(report.protectedWriteVerification.outcome).toBe("MISSING_OR_INCONSISTENT_EVIDENCE");
      expect(report.protectedWriteVerification.fencingRejectionDemonstrated).toBe(false);
      expect(report.checks.find((c) => c.number === 7)?.status).toBe("FAILED");
    } finally {
      if (prevEnv === undefined) delete process.env["AGBOSS_CRASH_WORKER_ON_STALL"];
      else process.env["AGBOSS_CRASH_WORKER_ON_STALL"] = prevEnv;
    }
  });

  it("correlates co-located sibling task takeover on a crashed worker process only when zero post-crash events exist", () => {
    const base = buildInvariantSnapshot({
      stallDisposition: "TERMINATED_BEFORE_WRITE",
      stallStatus: "TERMINATED_BEFORE_WRITE",
    });
    const baseArt = base.artifacts[0];
    if (baseArt === undefined) throw new Error("Expected base artifact");
    const siblingArt = { ...baseArt, artifactId: "art:rel-inv-01:a1:telemetry", logicalTaskId: "rel-inv-01:telemetry", moduleName: "telemetry", executionId: "exec-sibling-1" };
    expect(ProtectedWriteEvidenceService.resolvePeerProcessHalt(base, siblingArt, 1)).toBe("TERMINATED_BEFORE_WRITE");
    expect(ProtectedWriteEvidenceService.resolvePeerProcessHalt(base, siblingArt, 5)).toBeNull();

    const postCrashEvent = base.events[0];
    if (postCrashEvent === undefined) throw new Error("Expected event");
    const contradicted: LedgerSnapshot = { ...base, events: [...base.events, { ...postCrashEvent, eventId: 99 }] };
    expect(ProtectedWriteEvidenceService.resolvePeerProcessHalt(contradicted, siblingArt, 1)).toBeNull();
  });
});
