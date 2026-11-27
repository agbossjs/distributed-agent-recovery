import { resolve } from "node:path";
import { defineEnv, env } from "@agboss/core";

/**
 * The application's own process variables: declared here, resolved when the application starts. The
 * ledger's SQLite file, the model provider's key and base URL are not here: the `@DatabaseStorage`
 * and the `@ModelProvider` each declare their own references.
 */
export const appEnv = defineEnv({
  /** Where the staged and promoted artifact files go (shared by every instance of one machine). */
  artifactDir: env("ARTIFACT_DIR", { default: resolve(process.cwd(), ".data/dev/artifacts") }),
});
