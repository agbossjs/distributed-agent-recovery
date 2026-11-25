import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provide } from "@agboss/core";
import { DATABASE_SETTINGS } from "@agboss/core/stores";
import { testWith, type TestWithOptions } from "@agboss/core/testing";
import { DistributedAgentRecoveryApplication } from "../../src/distributed-agent-recovery.application.js";

const folder = mkdtempSync(join(tmpdir(), "distributed-agent-recovery-"));
let count = 0;

/**
 * `testWith` for a cluster test: a SQLite file of its own, shared by the test's instances (SQLite's
 * `:memory:` is one database per connection, and a test's ids start again at `execution-1`, so a file
 * shared with another test would hold other trees under the same ids). The path is the storage's
 * settings, given to the test as a service (more services come after it): one `clusterTest(…)` call per test.
 */
export function clusterTest(options: TestWithOptions = {}): ReturnType<typeof testWith> {
  count += 1;
  const sqlitePath = join(folder, `test-${String(count)}.sqlite`);
  return testWith(DistributedAgentRecoveryApplication, {
    ...options,
    services: [provide(DATABASE_SETTINGS, { kind: "sqlite", path: sqlitePath }), ...(options.services ?? [])],
  });
}
