import { HealthStatus } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { describe, expect } from "vitest";
import { DistributedAgentRecoveryApplication } from "../../src/distributed-agent-recovery.application.js";

const appTest = testWith(DistributedAgentRecoveryApplication);

describe("ReleaseClusterHealthCheck", () => {
  appTest(
    "reports healthy liveness and readiness including release-cluster-health-check",
    async ({ app }) => {
      const liveness = await app.checkLiveness();
      const readiness = await app.checkReadiness();

      expect(liveness.status).toBe(HealthStatus.Healthy);
      expect(readiness.status).toBe(HealthStatus.Healthy);
      expect(readiness.components.map((c) => c.name)).toContain(
        "release-cluster-health-check",
      );
    },
  );
});
