import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStatus } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { runReleaseRecoveryPipeline } from "../../../scenarios/release-recovery-pipeline.js";
import { CompensateReleaseCandidateAction } from "../../../src/actions/compensate-release-candidate.action.js";
import { LockReleaseCandidateAction } from "../../../src/actions/lock-release-candidate.action.js";
import { ReleaseRecoveryPlannerAgent } from "../../../src/agents/release-recovery-planner/release-recovery-planner.agent.js";
import {
  DistributedAgentRecoveryApplication,
  ReleaseCoordinatorWorkflowStart,
  ReleaseRecoveryPlannedWorkflowFinish,
} from "../../../src/distributed-agent-recovery.application.js";
import { RecoveryPlanDto } from "../../../src/dto/recovery-plan.dto.js";
import { ReleaseInvariantVerifierService } from "../../../src/services/release-invariant-verifier.service.js";
import { ReleaseLedgerService } from "../../../src/services/release-ledger.service.js";
import { InspectFailedAttemptTool } from "../../../src/tools/inspect-failed-attempt.tool.js";

const appTest = testWith(DistributedAgentRecoveryApplication);

describe("ReleaseCoordinatorWorkflow", () => {
  appTest(
    "executes saga compensation on smoke-gate failure, removes staged files, and replans via ReleaseRecoveryPlannerAgent using InspectFailedAttemptTool",
    async ({ app, mockLlm }) => {
      mockLlm(ReleaseRecoveryPlannerAgent).thenReturn(
        callTool(InspectFailedAttemptTool, {
          releaseId: "rel-saga-test",
          failedAttemptNumber: 1,
        }),
        replyWith(RecoveryPlanDto, {
          releaseId: "rel-saga-test",
          version: "1.9.0",
          nextAttemptNumber: 2,
          rootCauseAnalysis:
            "All 3 staged artifacts were compensated; adding --abi-compat=v2",
          correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
          enableLeaseTakeoverDrill: true,
        }),
      );

      const execution = await app.execute(
        ReleaseCoordinatorWorkflowStart,
        {
          releaseId: "rel-saga-test",
          version: "1.9.0",
          attemptNumber: 1,
          modules: "auth-service,payment-engine,telemetry-collector",
          buildFlags: "--opt-level=3 --deterministic",
          simulateIntegrationFailure: true,
          stallTargetModule: "",
        },
        { record: true },
      );

      expect(execution.status).toBe(ExecutionStatus.Finished);
      expect(execution).toFinishWith(ReleaseRecoveryPlannedWorkflowFinish, {
        releaseId: "rel-saga-test",
        version: "1.9.0",
        nextAttemptNumber: 2,
        rootCauseAnalysis:
          "All 3 staged artifacts were compensated; adding --abi-compat=v2",
        correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
        enableLeaseTakeoverDrill: true,
      });
      expect(execution).toHaveCompensated(LockReleaseCandidateAction, {
        by: CompensateReleaseCandidateAction,
      });
      expect(execution).toHaveCalledTools([InspectFailedAttemptTool]);

      const snap = await app
        .resolve(ReleaseLedgerService)
        .getSnapshot("rel-saga-test");
      expect(snap.artifacts).toHaveLength(3);
      for (const art of snap.artifacts) {
        expect(art.status).toBe("COMPENSATED");
        expect(existsSync(art.artifactPath)).toBe(false);
      }
    },
  );

  it("completes the 12-step 2-attempt distributed release recovery pipeline and verifies all 8 invariants", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "agboss-full-pipeline-test-"));
    const sqlitePath = join(workDir, "cluster-state.sqlite");
    const artifactDir = join(workDir, "artifacts");

    try {
      const report = await runReleaseRecoveryPipeline({
        sqlitePath,
        artifactDir,
        keepStorageOnExit: true,
        liveModel: false,
      });

      expect(report.health.livenessStatus).toBe("healthy");
      expect(report.health.readinessStatus).toBe("healthy");
      expect(report.attempt1.status).toBe("finished");
      expect(report.attempt1.compensationsCount).toBe(1);
      expect(report.attempt1.toolCallsCount).toBe(1);
      expect(report.attempt2.status).toBe("finished");
      expect(report.attempt2.releaseSummary.status).toBe("PROMOTED");
      expect(report.attempt2.releaseSummary.promotedModuleCount).toBe(3);

      const invariants = await ReleaseInvariantVerifierService.verifyFromFile({
        sqlitePath,
        artifactDir,
        releaseId: "rel-2026.10.0",
      });
      expect(invariants.allVerified).toBe(true);
      expect(invariants.checks).toHaveLength(8);
      expect(invariants.protectedWriteVerification.outcome).toBe("STALE_WRITE_REJECTED");
      expect(invariants.protectedWriteVerification.fencingRejectionDemonstrated).toBe(true);
      expect(invariants.protectedWriteVerification.rejectedStaleWriteCount).toBe(1);
      expect(invariants.protectedWriteVerification.validOwnerAcceptedCount).toBe(2);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
