/**
 * First run, from an empty root: the wizard appears, the chosen agent's binary is
 * downloaded, and the app reaches its normal UI.
 *
 * This spec is the regression guard for the bug where `check-deps` ran before the
 * agent was chosen, so `missingBinaries` never contained opencode and the setup
 * "binary" hook reported `done` having downloaded nothing. The user landed in a
 * working-looking app whose agent binary did not exist.
 *
 * It also seeds the root the warm specs depend on: a real VSCodium download, real
 * VSIX installs, and a config.json holding the agent choice.
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDriver, type AppDriver } from "../scripts/appctrl";
import {
  DATA_ROOT,
  ROOT_DIR,
  expectNoErrorLogs,
  expectNoNativeDialogs,
  failFastOnSetupError,
  launchApp,
  resetToColdStart,
} from "./fixtures";

// A real VSCodium reh-web download, a ~150MB agent binary, and VSIX installs, all over
// the network. Generous on purpose: a cold runner on a bad day is slow, and
// failFastOnSetupError() means a genuinely broken setup no longer waits this out.
test.describe.configure({ timeout: 1_800_000 });

test("first run: pick OpenCode, download its binary, reach the app", async () => {
  resetToColdStart();
  expect(existsSync(join(DATA_ROOT, "config.json"))).toBe(false);

  const driver: AppDriver = createDriver();
  try {
    // No --agent: on a cold root the flag would be ignored for onboarding anyway,
    // because wasConfigured() keys off config.json's existence, not the value.
    await launchApp(driver);

    // --- The wizard ---
    const ui = driver.uiPage();
    await expect(ui.getByRole("dialog", { name: "Choose Agent" })).toBeVisible({ timeout: 60_000 });
    await expect(ui.getByRole("radio", { name: "Claude Code" })).toBeVisible();

    await ui.getByRole("radio", { name: "OpenCode" }).click();
    await ui.getByRole("button", { name: "Continue" }).click();

    // The picker must go away the moment it is answered. It used to stay on screen
    // for the whole of check-deps and app:setup, with the download running behind it.
    await expect(ui.getByRole("dialog", { name: "Choose Agent" })).toBeHidden({ timeout: 30_000 });

    // --- Setup ran, and actually downloaded ---
    // Race the wait against the app's own setup error: a failed setup parks the app on a
    // retry dialog, and without this the spec would idle out its entire timeout.
    const setupError = failFastOnSetupError(driver);
    try {
      await Promise.race([
        expect(ui.getByRole("navigation", { name: "Projects" })).toBeVisible({
          timeout: 1_500_000,
        }),
        setupError.promise,
      ]);
    } finally {
      setupError.stop();
    }

    const bundles = readdirSync(ROOT_DIR);
    expect(bundles, `root contents: ${bundles.join(", ")}`).toContain("vscodium");
    expect(
      bundles,
      "opencode was selected in the wizard, so its binary must have been downloaded"
    ).toContain("opencode");

    // --- The choice was persisted, so the warm specs skip the wizard ---
    const config = JSON.parse(readFileSync(join(DATA_ROOT, "config.json"), "utf-8")) as {
      agent?: string;
    };
    expect(config.agent).toBe("opencode");

    // Startup failures surface as a native error box, which would otherwise just hang.
    await expectNoNativeDialogs(driver);

    // Nothing behind the IPC boundary failed quietly on the way up. This run is the
    // one that downloads the VSCodium bundle and patches it, so it is where a patch
    // that no longer matches upstream shows up — packaged builds log that error and
    // start anyway (src/modules/ide-server-module/bundle-patches.ts).
    expectNoErrorLogs();
  } finally {
    await driver.stop();
  }
});
