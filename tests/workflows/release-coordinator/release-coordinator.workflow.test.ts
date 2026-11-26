import { existsSync } from "node:fs";
import { ApplicationContext, ExecutionStatus } from "@agboss/core";
import { callTool, replyWith } from "@agboss/core/testing";
import { describe, expect } from "vitest";
import { CompensateReleaseCandidateAction } from "../../../src/actions/compensate-release-candidate.action.js";
import { LockReleaseCandidateAction } from "../../../src/actions/lock-release-candidate.action.js";
import { ReleaseRecoveryPlannerAgent } from "../../../src/agents/release-recovery-planner/release-recovery-planner.agent.js";
import {
  ReleaseCoordinatorWorkflowFinish,
  ReleaseCoordinatorWorkflowStart,
  ReleaseRecoveryPlannedWorkflowFinish,
} from "../../../src/distributed-agent-recovery.application.js";
import { RecoveryPlanDto } from "../../../src/dto/recovery-plan.dto.js";
import { ReleaseInspectionService } from "../../../src/services/release-inspection.service.js";
import { ReleaseInvariantVerifierService } from "../../../src/services/release-invariant-verifier.service.js";
import { InspectFailedAttemptTool } from "../../../src/tools/inspect-failed-attempt.tool.js";
import { clusterTest } from "../../support/cluster-files.js";
import { untilSettled } from "../../support/until-settled.js";


const MODULES = "auth-service,payment-engine,telemetry-collector";

describe("ReleaseCoordinatorWorkflow", () => {
  // a coordinator and two workers on one SQLite file: the module tasks are queued by the first and claimed by the others
  clusterTest({ instances: 3 })(
    "executes saga compensation on smoke-gate failure, removes staged files, and replans via ReleaseRecoveryPlannerAgent using InspectFailedAttemptTool",
    async ({ app, apps, clock, mockModel }) => {
      await Promise.all(apps.map((instance) => instance.ready()));
      mockModel(ReleaseRecoveryPlannerAgent).thenReturn(
        callTool(InspectFailedAttemptTool, { releaseId: "rel-saga-test", failedAttemptNumber: 1 }),
        replyWith(RecoveryPlanDto, {
          releaseId: "rel-saga-test",
          version: "1.9.0",
          nextAttemptNumber: 2,
          rootCauseAnalysis: "All 3 staged artifacts were compensated; adding --abi-compat=v2",
          correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
          enableLeaseTakeoverDrill: true,
        }),
      );

      const execution = await untilSettled(
        app.execute(ReleaseCoordinatorWorkflowStart, {
          releaseId: "rel-saga-test",
          version: "1.9.0",
          attemptNumber: 1,
          modules: MODULES,
          buildFlags: "--opt-level=3 --deterministic",
          simulateIntegrationFailure: true,
          stallTargetModule: "",
        }),
        clock,
      );

      expect(execution.status).toBe(ExecutionStatus.Finished);
      expect(execution).toFinishWith(ReleaseRecoveryPlannedWorkflowFinish, {
        releaseId: "rel-saga-test",
        version: "1.9.0",
        nextAttemptNumber: 2,
        rootCauseAnalysis: "All 3 staged artifacts were compensated; adding --abi-compat=v2",
        correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
        enableLeaseTakeoverDrill: true,
      });
      expect(execution).toHaveCompensated(LockReleaseCandidateAction, { by: CompensateReleaseCandidateAction });
      expect(execution).toHaveCalledTools([InspectFailedAttemptTool]);

      const snap = await app.resolve(ReleaseInspectionService).getSnapshot("rel-saga-test");
      expect(snap.artifacts).toHaveLength(3);
      for (const art of snap.artifacts) {
        expect(art.status).toBe("COMPENSATED");
        expect(existsSync(art.artifactPath)).toBe(false);
      }
    },
  );

  clusterTest({ instances: 3 })(
    "recovers in two attempts across the workers: attempt 1 is compensated and replanned, attempt 2 is promoted, and the verifier's invariants hold",
    async ({ app, apps, clock, mockModel }) => {
      await Promise.all(apps.map((instance) => instance.ready()));
      mockModel(ReleaseRecoveryPlannerAgent).thenReturn(
        callTool(InspectFailedAttemptTool, { releaseId: "rel-two-attempts", failedAttemptNumber: 1 }),
        replyWith(RecoveryPlanDto, {
          releaseId: "rel-two-attempts",
          version: "2.4.0",
          nextAttemptNumber: 2,
          rootCauseAnalysis: "Compensated; --abi-compat=v2 is missing",
          correctedBuildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
          enableLeaseTakeoverDrill: false,
        }),
      );
      const request = {
        releaseId: "rel-two-attempts",
        version: "2.4.0",
        modules: MODULES,
        stallTargetModule: "",
      };

      const first = await untilSettled(
        app.execute(ReleaseCoordinatorWorkflowStart, {
          ...request,
          attemptNumber: 1,
          buildFlags: "--opt-level=3 --deterministic",
          simulateIntegrationFailure: true,
        }),
        clock,
      );
      expect(first.status).toBe(ExecutionStatus.Finished);

      const second = await untilSettled(
        app.execute(ReleaseCoordinatorWorkflowStart, {
          ...request,
          attemptNumber: 2,
          buildFlags: "--opt-level=3 --deterministic --abi-compat=v2",
          simulateIntegrationFailure: false,
        }),
        clock,
      );
      expect(second).toFinishWith(ReleaseCoordinatorWorkflowFinish, {
        releaseId: "rel-two-attempts",
        version: "2.4.0",
        attemptNumber: 2,
        status: "PROMOTED",
        promotedModuleCount: 3,
        participatingInstances: expect.any(String) as string,
        manifestPath: expect.any(String) as string,
      });

      // the module tasks were stolen by the workers: the coordinator launched them and ran none
      const snap = await app.resolve(ReleaseInspectionService).getSnapshot("rel-two-attempts");
      const workers = snap.artifacts.flatMap((art) => [art.preparedByInstanceId, art.committedByInstanceId]);
      expect(workers.length).toBeGreaterThan(0);
      expect(workers).not.toContain(app.resolve(ApplicationContext).instanceId);

      // invariants 1-5 of the verifier; the sixth (two workers took part) depends on how the workers
      // share the tasks — a test's tasks are too quick for the second worker to get one — and the
      // takeover drill's (7, 8) is the module worker test's
      const report = ReleaseInvariantVerifierService.verifySnapshot(
        snap,
        "rel-two-attempts",
        ["auth-service", "payment-engine", "telemetry-collector"],
        false,
      );
      expect(report.checks.filter((check) => check.number <= 5).map((check) => check.status)).toEqual(
        Array.from({ length: 5 }, () => "VERIFIED"),
      );
    },
  );
});
