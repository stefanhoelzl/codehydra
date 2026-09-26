/**
 * `codehydra --download-binaries` from an empty root: it fetches the IDE server
 * and both agents' binaries, then exits without opening a window. Then the app
 * starts on that root and reaches its normal UI.
 *
 * It also seeds the root the warm specs depend on: the downloads, the VSIX
 * installs the first start makes, and a config.json holding the agent choice
 * (so the warm specs skip the wizard).
 *
 * The first-run wizard's own ordering (the chosen agent is checked after it is
 * chosen) is covered by app-start.integration.test.ts (#7).
 */
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_ROOT,
  ROOT_DIR,
  expectNoNativeDialogs,
  failFastOnSetupError,
  launchApp,
  launchCommand,
  resetToColdStart,
  useApp,
} from "./fixtures";

// A real VSCodium reh-web download and two ~200MB agent binaries, all over the
// network. Generous on purpose: a cold runner on a bad day is slow.
test.describe.configure({ timeout: 1_800_000 });

// `cold`: the fixture hands back a driver but leaves the reset and the launch to us.
// Teardown (stop, then "the main process logged no errors") is the fixture's.
const app = useApp({ cold: true });

/** Run the app with `--download-binaries` to completion. */
async function runDownloadBinaries(): Promise<{ code: number | null; output: string }> {
  const { exe, argv, cwd, env } = await launchCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...argv, "--download-binaries"], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** The version directories under `<root>/<name>` that hold `executable`. */
function downloadedVersions(name: string, executable: string): string[] {
  const dir = join(ROOT_DIR, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((version) => existsSync(join(dir, version, executable)));
}

test("--download-binaries fetches every binary, and the app starts on it", async () => {
  resetToColdStart();

  const { code, output } = await runDownloadBinaries();
  expect(code, output).toBe(0);

  const exe = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);
  expect(readdirSync(ROOT_DIR), output).toContain("vscodium");
  expect(downloadedVersions("claude", exe("claude")), output).toHaveLength(1);
  expect(downloadedVersions("opencode", exe("opencode")), output).toHaveLength(1);
  // Nothing but binaries: it must not have started the app.
  expect(existsSync(join(DATA_ROOT, "projects")), output).toBe(false);

  // --- Seed the agent choice, then start the app on the seeded root ---
  writeFileSync(join(DATA_ROOT, "config.json"), `${JSON.stringify({ agent: "opencode" })}\n`);

  const driver = app();
  await launchApp(driver, { agent: "opencode" });

  // The first start still installs the bundled VSIXes; no download may be needed.
  const ui = driver.uiPage();
  const setupError = failFastOnSetupError(driver);
  try {
    await Promise.race([
      expect(ui.getByRole("navigation", { name: "Projects" })).toBeVisible({ timeout: 600_000 }),
      setupError.promise,
    ]);
  } finally {
    setupError.stop();
  }

  // Startup failures surface as a native error box, which would otherwise just hang.
  await expectNoNativeDialogs(driver);
});
