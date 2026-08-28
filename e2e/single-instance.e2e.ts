/**
 * A second launch is refused, silently, and leaves the running instance intact.
 *
 * Everything about the wiring — that before-ready bails, that the reactivation
 * subscription presents the window — is covered by fast tests with behavioural
 * mocks. What only a real launch can prove is the assumption the whole design
 * rests on: that Electron keys its single-instance lock on the `userData`
 * directory electron-lifecycle relocates into the data root. If it did not, the
 * lock would be machine-wide and every data root — e2e runs under
 * `_CH_ROOT_DIR`, `pnpm dev` worktrees — would contend with the installed app.
 *
 * The second process is started from the driver's own launch recipe, which
 * gives it a free `--ide-server.port` of its own — so nothing but the lock can
 * stop it. Without the lock it would start completely, and the
 * state.json assertion below is what would catch the damage: its shutdown would
 * withdraw the *running* instance's CLI connection details, breaking `ch` in
 * every workspace of a perfectly healthy app.
 *
 * Runs in both modes: `launchCommand()` resolves the packaged binary under
 * `pnpm test:e2e` and `node_modules`' Electron under `pnpm test:e2e:dev`. The
 * lock is claimed in before-ready and is indifferent to which one started the
 * process.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, launchCommand, useApp, waitForConnectionDetails } from "./fixtures";

const STATE_FILE = join(DATA_ROOT, "state.json");

interface PluginState {
  readonly port: number;
  readonly token: string | null;
}

/**
 * The CLI connection details `ch` resolves an instance by. StateService writes
 * dot-separated keys flat, so these are `state["plugin.port"]`, not a nested
 * `plugin` object.
 */
function readPluginState(): PluginState {
  expect(existsSync(STATE_FILE), `expected ${STATE_FILE} to exist`).toBe(true);
  const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Record<string, unknown>;
  const port = state["plugin.port"];
  const token = state["plugin.token"];
  return {
    port: typeof port === "number" ? port : 0,
    token: typeof token === "string" ? token : null,
  };
}

const app = useApp();

test("a second launch exits quietly and leaves the first instance untouched", async () => {
  // The UI is up two hook points before `start`, where the plugin server binds
  // and publishes. Reading state.json without this races startup.
  await waitForConnectionDetails();

  // Sanity: the running instance published connection details for `ch`.
  const before = readPluginState();
  expect(before.port).toBeGreaterThan(0);
  expect(before.token).not.toBeNull();

  // The driver's own launch recipe for whichever mode is running, so this
  // second process is the same app the first one is — and stays that way when
  // the flags in fixtures change. Its own free ide-server.port comes from
  // appFlags(), which means nothing but the lock can stop it.
  const { exe, argv, cwd, env } = await launchCommand();
  const second = spawnSync(exe, argv, {
    cwd,
    env,
    encoding: "utf-8",
    // A refused launch returns in well under a second; this is only here so a
    // second instance that *wasn't* refused gets killed instead of outliving
    // the run. Distinguished from a spawn failure below — without that, "the
    // lock didn't stop it" reports as the very misleading "failed to spawn".
    timeout: 30_000,
  });

  const timedOut = (second.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  expect(
    timedOut,
    "the second launch was still running after 30s — the single-instance lock did not refuse it"
  ).toBe(false);
  expect(second.error, `second launch failed to spawn: ${String(second.error)}`).toBeUndefined();
  // 0, not a failure code: nothing went wrong. The user asked for CodeHydra and
  // CodeHydra is in front of them.
  expect(second.status, `second launch stderr:\n${second.stderr}`).toBe(0);
  // Silently: no "Startup Failed" box, no diagnostic report.
  expect(second.stderr).not.toContain("already in use");
  expect(second.stdout).not.toContain("Startup Failed");

  // The running instance still owns state.json. A second instance that reached
  // app:shutdown would have reset these to 0 / null on its way out.
  expect(readPluginState()).toEqual(before);

  // And it is still a working app, not just a healthy-looking file.
  const driver = app();
  await expect(driver.uiPage().locator("body")).toBeVisible();
});
