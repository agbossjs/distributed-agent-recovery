import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

process.env.PII_PSEUDONYM_KEY ??= "distributed-agent-recovery-pseudonym-key-32b!";
process.env.OPENROUTER_API_KEY ??=
  process.env.OPEN_ROUTER_KEY ?? "offline-test-openrouter-api-key";

const fallbackTestDir = mkdtempSync(join(tmpdir(), "agboss-recovery-test-"));

export const environment: AppEnvironment = {
  sqlitePath: env("SQLITE_PATH", {
    default: join(fallbackTestDir, "cluster-state.sqlite"),
  }),
  artifactDir: env("ARTIFACT_DIR", {
    default: join(fallbackTestDir, "artifacts"),
  }),
  nodeRole: env("AGBOSS_NODE_ROLE", {
    default: "hybrid",
  }),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
};
