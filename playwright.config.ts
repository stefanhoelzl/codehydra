import { defineConfig } from "@playwright/test";
import { ROOT_DIR } from "./e2e/env";

// Children inherit this; env.ts already resolved it deterministically so every
// worker and project agrees on which root download-binaries seeded.
process.env._CH_ROOT_DIR = ROOT_DIR;

const WARM_SPECS = "**/!(download-binaries).e2e.ts";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.output",

  // A packaged app + IDE server + agent server is heavy, and prod pins
  // ide-server.port to a constant. Serial.
  workers: 1,
  fullyParallel: false,

  // Zero retries: a green run means it actually worked. Network downloads and
  // server boots are the flaky parts, and we would rather see them fail.
  retries: 0,

  timeout: 120_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    // Runs against an empty root: `--download-binaries`, then a first start.
    // Leaves the root warm.
    { name: "download-binaries", testMatch: "**/download-binaries.e2e.ts" },

    // Same three specs, once per agent. `--agent=` flips the agent on the warm
    // root without rewriting config.json.
    { name: "opencode", testMatch: WARM_SPECS, dependencies: ["download-binaries"] },
    { name: "claude", testMatch: WARM_SPECS, dependencies: ["download-binaries"] },
  ],
});
