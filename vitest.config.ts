import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["@agboss/core/testing/setup"],
    testTimeout: 30_000,
  },
});
