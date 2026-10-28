import { testAction, testTool } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { DecomposeReleaseTasksAction } from "../../src/actions/decompose-release-tasks.action.js";
import { environment as testEnvironment } from "../../src/environments/test.environment.js";
import { InspectFailedAttemptTool } from "../../src/tools/inspect-failed-attempt.tool.js";
import { ReleaseCoordinatorWorkflowStart } from "../../src/workflows/release-coordinator/release-coordinator.workflow-start.js";

describe("InspectFailedAttemptTool & DecomposeReleaseTasksAction (unit runners)", () => {
  it("runs InspectFailedAttemptTool in an isolated DI container against SQLite via Drizzle ORM", async () => {
    const runInspect = testTool(InspectFailedAttemptTool, {
      environment: { ...testEnvironment, sqlitePath: ":memory:" },
    });
    const { output } = await runInspect({
      releaseId: "rel-unit-01",
      failedAttemptNumber: 1,
    });

    expect(output).toMatchObject({
      releaseId: "rel-unit-01",
      failedAttemptNumber: 1,
      compensatedArtifactCount: 0,
      activeArtifactsRemaining: 0,
      allArtifactsCompensated: false,
    });
    expect(output.ledgerDiagnostic).toContain("--abi-compat=v2");
  });

  it("decomposes a release request into independent ModuleTaskDto items marking only the stall target", async () => {
    const runDecompose = testAction(DecomposeReleaseTasksAction);
    const { output } = await runDecompose({
      releaseRequest: {
        producer: ReleaseCoordinatorWorkflowStart,
        value: {
          releaseId: "rel-unit-02",
          version: "2.0.0",
          attemptNumber: 2,
          modules: "auth-service, payment-engine",
          buildFlags: "--opt-level=3 --abi-compat=v2",
          simulateIntegrationFailure: false,
          stallTargetModule: "payment-engine",
        },
      },
    });

    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      logicalTaskId: "rel-unit-02:auth-service",
      simulateWorkerStall: false,
    });
    expect(output[1]).toMatchObject({
      logicalTaskId: "rel-unit-02:payment-engine",
      simulateWorkerStall: true,
    });
  });
});
