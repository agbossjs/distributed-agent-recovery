import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

// a folder of its own for a test run that sets no ARTIFACT_DIR (the instance tests set one per test)
const fallbackTestDir = mkdtempSync(join(tmpdir(), "agboss-recovery-test-"));

export const environment: AppEnvironment = {
  artifactDir: env("ARTIFACT_DIR", { default: join(fallbackTestDir, "artifacts") }),
};
