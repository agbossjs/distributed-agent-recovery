import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Clock, HealthStatus, createApp } from "@agboss/core";
import { FastClusterClock } from "../scenarios/fast-cluster-clock.js";
import {
  createOfflineOpenRouterFetch,
  isLiveDemoRequested,
  requireLiveApiKey,
} from "../scenarios/offline-openrouter-fetch.js";
import { DistributedAgentRecoveryApplication } from "../src/distributed-agent-recovery.application.js";

const isLive = isLiveDemoRequested();
const openRouterKey = isLive
  ? requireLiveApiKey()
  : "offline-test-openrouter-api-key";
const useFastSweep =
  process.env["AGBOSS_FAST_SWEEP"] === "true" &&
  process.env["AGBOSS_REAL_CLOCK"] !== "true";

if (process.env["SQLITE_PATH"] !== undefined) {
  mkdirSync(dirname(process.env["SQLITE_PATH"]), { recursive: true });
}
if (process.env["ARTIFACT_DIR"] !== undefined) {
  mkdirSync(process.env["ARTIFACT_DIR"], { recursive: true });
}

const app = await createApp(DistributedAgentRecoveryApplication, {
  processEnv: {
    ...process.env,
    AGBOSS_NODE_ROLE: "worker",
    OPENROUTER_API_KEY: openRouterKey,
    PII_PSEUDONYM_KEY:
      process.env["PII_PSEUDONYM_KEY"] ??
      "distributed-agent-recovery-pseudonym-key-32b!",
  },
  ...(isLive ? {} : { providerFetch: createOfflineOpenRouterFetch() }),
  ...(useFastSweep
    ? { container: { overrides: new Map([[Clock, new FastClusterClock()]]) } }
    : {}),
});

const readiness = await app.checkReadiness();
if (readiness.status !== HealthStatus.Healthy) {
  throw new Error(`Worker failed readiness check: ${JSON.stringify(readiness)}`);
}

if (process.env["WORKER_READY_FILE"] !== undefined) {
  writeFileSync(process.env["WORKER_READY_FILE"], "ready\n", "utf8");
}
process.stdout.write(`WORKER_READY status=${readiness.status} pid=${String(process.pid)}\n`);

const keepAlive = setInterval(() => undefined, 5_000);
const shutdown = async (): Promise<void> => {
  clearInterval(keepAlive);
  setTimeout(() => process.exit(0), 3_000).unref();
  await app.close();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
