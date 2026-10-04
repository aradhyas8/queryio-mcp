import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    // Tests share one Postgres database; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
