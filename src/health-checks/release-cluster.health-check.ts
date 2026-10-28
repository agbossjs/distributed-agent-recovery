import {
  HealthCheck,
  HealthCheckResult,
  type HealthCheckHandler,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { StorageProbeService } from "../services/storage-probe.service.js";

@HealthCheck({
  name: "release-cluster-health-check",
  timeout: seconds(2),
  deps: [StorageProbeService],
})
export class ReleaseClusterHealthCheck implements HealthCheckHandler {
  constructor(private readonly storageProbeService: StorageProbeService) {}

  async check(): Promise<HealthCheckResult> {
    const state = await this.storageProbeService.ping();
    if (state === "healthy") {
      return HealthCheckResult.healthy();
    }
    if (state === "degraded") {
      return HealthCheckResult.degraded({
        reason: "SQLite WAL checkpoint latency above threshold",
      });
    }
    return HealthCheckResult.unhealthy({
      reason: "Shared SQLite release ledger unreachable",
    });
  }
}
