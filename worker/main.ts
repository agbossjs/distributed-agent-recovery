import { writeFileSync } from "node:fs";
import { HealthStatus, createApp } from "@agboss/core";
import "../src/scripts/offline-keys.js";
import { DistributedAgentRecoveryApplication } from "../src/distributed-agent-recovery.application.js";

// a worker is an instance like any other: it reads SQLITE_PATH and ARTIFACT_DIR from its process, and
// claims the module tasks a coordinator queues, and takes over the ones a frozen worker left behind
const app = await createApp(DistributedAgentRecoveryApplication);

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
