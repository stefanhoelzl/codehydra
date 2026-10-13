/**
 * The landing-page demo (`demo/record.demo.ts`), run as a Playwright spec so it
 * shares the e2e fixtures and their module rules — Playwright's transform
 * resolves the repo's extensionless imports, where bare `node` did not.
 *
 * `pnpm demo:record` films it; `pnpm demo:smoke` (CI) drives it without filming.
 * Both run the dev build (`pnpm build`) and own their root, separate from the
 * e2e suite's, so the bundles a first run downloads are kept for the next.
 */
import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set before any spec imports e2e/env.ts, which reads them at load. This file is
// evaluated again in every worker, so they hold there too.
process.env._CHDEV_ROOT_DIR ||= join(realpathSync(tmpdir()), "codehydra-demo");
process.env.CH_E2E_MODE ||= "dev";
// On a Wayland desktop either of these lets Electron skip the demo's own Xvfb:
// the window is never mapped there and the grab is black.
delete process.env.WAYLAND_DISPLAY;
delete process.env.XDG_SESSION_TYPE;

export default defineConfig({
  testDir: "./demo",
  testMatch: "*.demo.ts",
  outputDir: "./demo/.output",
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "claude" }],
});
