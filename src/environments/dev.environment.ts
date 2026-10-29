import { resolve } from "node:path";
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

process.env.PII_PSEUDONYM_KEY ??= "distributed-agent-recovery-pseudonym-key-32b!";
process.env.OPENROUTER_API_KEY ??=
  process.env.OPEN_ROUTER_KEY ?? "offline-test-openrouter-api-key";

const defaultDataDir = resolve(process.cwd(), ".data/dev");

export const environment: AppEnvironment = {
  sqlitePath: env("SQLITE_PATH", {
    default: resolve(defaultDataDir, "cluster-state.sqlite"),
  }),
  artifactDir: env("ARTIFACT_DIR", {
    default: resolve(defaultDataDir, "artifacts"),
  }),
  nodeRole: env("AGBOSS_NODE_ROLE", {
    default: "hybrid",
  }),
  crashWorkerOnStall: env.flag("AGBOSS_CRASH_WORKER_ON_STALL", {
    default: false,
  }),
  skipStaleWriteAttempt: env.flag("AGBOSS_SKIP_STALE_WRITE_ATTEMPT", {
    default: false,
  }),
  osFreeze: env.flag("AGBOSS_OS_FREEZE", {
    default: false,
  }),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
};
