import { defineConfig } from "vitest/config";
import { agbossVitest } from "@agboss/core/testing/vitest";

// agbossVitest() loads AGBoss through vite, in the tests' module graph, and registers the workflow
// matchers (toFollowPath, toFinishWith, …) — no setupFiles entry of our own.
export default defineConfig({
  test: agbossVitest({
    include: ["tests/**/*.test.ts"],
    // synthetic keys for the tests only; the application fails closed without its own
    env: {
      OPENROUTER_API_KEY: "offline-test-openrouter-api-key",
      IDEMPOTENCY_KEY: "distributed-agent-recovery-offline-idempotency-key",
    },
    testTimeout: 30_000,
  }),
});
