import { resolve } from "node:path";
import { env } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  artifactDir: env("ARTIFACT_DIR", { default: resolve(process.cwd(), ".data/dev/artifacts") }),
};
