import { provide } from "@agboss/core";
import { DATABASE_SETTINGS } from "@agboss/core/stores";
import { testUnit } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { InspectFailedAttemptTool } from "../../src/tools/inspect-failed-attempt.tool.js";

describe("InspectFailedAttemptTool", () => {
  it("runs in an isolated DI container against SQLite via Drizzle ORM", async () => {
    // the tool reads the ledger through the application's SQLite connection: an in-memory file of its own
    const runInspect = testUnit(InspectFailedAttemptTool, {
      services: [provide(DATABASE_SETTINGS, { kind: "sqlite", path: ":memory:" })],
    });
    const { output } = await runInspect({ releaseId: "rel-unit-01", failedAttemptNumber: 1 });

    expect(output).toMatchObject({
      releaseId: "rel-unit-01",
      failedAttemptNumber: 1,
      compensatedArtifactCount: 0,
      activeArtifactsRemaining: 0,
      allArtifactsCompensated: false,
    });
    expect(output.ledgerDiagnostic).toContain("--abi-compat=v2");
  });
});
