import { testUnit } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { DecomposeReleaseTasksAction } from "../../src/actions/decompose-release-tasks.action.js";
import { ReleaseRequestDto } from "../../src/dto/release-request.dto.js";

const request = (overrides: Partial<ReleaseRequestDto>): { readonly releaseRequest: ReleaseRequestDto } => ({
  releaseRequest: Object.assign(new ReleaseRequestDto(), {
    releaseId: "rel-unit-02",
    version: "2.0.0",
    attemptNumber: 2,
    modules: "auth-service, payment-engine",
    buildFlags: "--opt-level=3 --abi-compat=v2",
    simulateIntegrationFailure: false,
    stallTargetModule: "payment-engine",
    ...overrides,
  }),
});

describe("DecomposeReleaseTasksAction", () => {
  it("decomposes a release request into independent ModuleTaskDto items marking only the stall target", async () => {
    const runDecompose = testUnit(DecomposeReleaseTasksAction);
    const { output } = await runDecompose(request({}));

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

  it("marks no module for the drill when the request names none", async () => {
    const runDecompose = testUnit(DecomposeReleaseTasksAction);
    const { output } = await runDecompose(request({ stallTargetModule: "" }));

    expect(output.map((task) => task.simulateWorkerStall)).toEqual([false, false]);
  });
});
