import { HealthStatus, provide, type ValueProvider } from "@agboss/core";
import { describe, expect } from "vitest";
import { StorageProbeService } from "../../src/services/storage-probe.service.js";
import { clusterTest } from "../support/cluster-files.js";

type ProbeState = Awaited<ReturnType<StorageProbeService["ping"]>>;

/** The probe, as a test replaces it: the state it is told to report. */
const probeReporting = (state: ProbeState): ValueProvider<StorageProbeService> =>
  provide(StorageProbeService, { ping: () => Promise.resolve(state) } as StorageProbeService);

describe("ReleaseClusterHealthCheck", () => {
  clusterTest()("reports healthy liveness and readiness including release-cluster-health-check", async ({ app }) => {
    const liveness = await app.checkLiveness();
    const readiness = await app.checkReadiness();

    expect(liveness.status).toBe(HealthStatus.Healthy);
    expect(readiness.status).toBe(HealthStatus.Healthy);
    expect(readiness.components.map((c) => c.name)).toContain("release-cluster-health-check");
  });

  clusterTest({ services: [probeReporting("degraded")] })("propagates a degraded storage probe into readiness", async ({ app }) => {
    expect((await app.checkReadiness()).status).toBe(HealthStatus.Degraded);
  });

  clusterTest({ services: [probeReporting("unhealthy")] })("propagates an unhealthy storage probe into readiness", async ({ app }) => {
    expect((await app.checkReadiness()).status).toBe(HealthStatus.Unhealthy);
  });
});
