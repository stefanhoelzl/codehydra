/**
 * Launching the app under test, and the per-spec lifecycle helper.
 *
 * The driver comes from `scripts/appctrl.ts` — the same module the appctrl MCP
 * server exposes to agents, so what you debug interactively is what CI runs.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDriver, type AppDriver } from "../scripts/appctrl";
import {
  DATA_ROOT,
  REPO_ROOT,
  ROOT_DIR,
  mode,
  freePort,
  packagedExecutable,
  resetDataState,
  resetRoot,
  type Agent,
} from "./env";

export interface LaunchAppOptions {
  /**
   * Passed as `--agent=`. CLI beats config.json (config.ts precedence), and because
   * config.json exists on a warm root, `wasConfigured()` is true and the wizard is
   * skipped. Omit on a cold root — there the flag is ignored for onboarding and the
   * picker appears regardless.
   */
  agent?: Agent;
  extraArgs?: string[];
}

/** Build the app flags. Every one is `--key=value` or a bare `--flag`; never a loose token. */
async function appFlags(options: LaunchAppOptions): Promise<string[]> {
  const flags = [
    "--log.format=json",
    "--log.level=debug",
    "--log.output=file",
    // ide-server.port is a hardcoded 25448 in prod. Pin a free one so a running
    // dev instance doesn't collide, and so workers could go parallel later.
    `--ide-server.port=${await freePort()}`,
    "--telemetry.enabled=false",
    "--update.notification=false",
  ];

  if (options.agent) flags.push(`--agent=${options.agent}`);

  // Extracting an AppImage as a non-root user strips setuid from chrome-sandbox,
  // and ubuntu-24.04 restricts unprivileged user namespaces. This is the one place
  // CI deviates from a real user's launch.
  if (mode() === "packaged" && process.platform === "linux") flags.push("--no-sandbox");

  if (process.env.CH_E2E_HEADLESS) {
    // Opt-in for local runs without any display at all.
    flags.push("--electron.flags=--ozone-platform=headless --disable-gpu");
  } else if (process.platform === "linux") {
    // Pin X11 so the app honors DISPLAY (xvfb's). Ozone otherwise auto-detects, and on a
    // Wayland desktop it takes the Wayland socket and throws a real window on the
    // developer's screen, ignoring xvfb entirely.
    flags.push("--electron.flags=--ozone-platform=x11");
  }

  flags.push(...(options.extraArgs ?? []));
  return flags;
}

/**
 * When the app under test was launched. `expectNoErrorLogs` reads only entries
 * from here on, so one spec's failure doesn't resurface in every later one (the
 * logs directory outlives a single app).
 */
let launchedAt = 0;

export async function launchApp(driver: AppDriver, options: LaunchAppOptions = {}): Promise<void> {
  const args = await appFlags(options);
  // Before launch, not after: the app logs from its very first tick.
  launchedAt = Date.now();
  await driver.launch({
    ...(mode() === "packaged" && { executablePath: packagedExecutable(), appPath: null }),
    cwd: REPO_ROOT,
    args,
    // _CH_ROOT_DIR moves dataRoot and bundlesRoot together, whatever the build flavor.
    env: { ...process.env, _CH_ROOT_DIR: ROOT_DIR },
    timeout: 120_000,
    actionTimeout: 15_000,
  });

  // A native error box (e.g. the app's own "Startup Failed") blocks the main process
  // with no window to click, which in a headless run looks exactly like a hang. Record
  // them instead, so a spec can fail with the real message.
  await driver.silenceNativeDialogs();

  // The UI is a WebContentsView created after app.whenReady(), so it does not exist
  // the moment launch() resolves. Every caller wants it; wait here rather than in each.
  await driver.waitForUiPage(120_000);
}

/**
 * Reject as soon as the app logs a fatal `app:setup` failure.
 *
 * Without this a broken setup is indistinguishable from a slow one: the app parks on
 * its retry dialog and the spec waits out its whole timeout. Race this against whatever
 * you were waiting for, and the failure arrives in seconds carrying the app's own message.
 */
export function failFastOnSetupError(driver: AppDriver): {
  readonly promise: Promise<never>;
  stop: () => void;
} {
  void driver;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const promise = new Promise<never>((_resolve, reject) => {
    const poll = (): void => {
      if (stopped) return;
      const error = readSetupError();
      if (error !== null) {
        reject(new Error(`app:setup failed: ${error}`));
        return;
      }
      timer = setTimeout(poll, 2_000);
    };
    poll();
  });

  return {
    promise,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** The app's fatal setup error from its JSONL log, or null. */
function readSetupError(): string | null {
  const logsDir = join(DATA_ROOT, "logs");
  if (!existsSync(logsDir)) return null;

  const files = readdirSync(logsDir).filter((f) => f.endsWith(".log") && f !== "electron.log");
  for (const file of files) {
    const contents = readFileSync(join(logsDir, file), "utf-8");
    for (const line of contents.split("\n")) {
      if (!line.includes('"intent":"app:setup"') || !line.includes('"level":"error"')) continue;
      try {
        const entry = JSON.parse(line) as { context?: { error?: string } };
        return entry.context?.error ?? "unknown error";
      } catch {
        return line.slice(0, 300);
      }
    }
  }
  return null;
}

/** Fail with the app's own error text if it tried to raise a native dialog. */
export async function expectNoNativeDialogs(driver: AppDriver): Promise<void> {
  const dialogs = await driver.nativeDialogs();
  expect(dialogs, `the app raised native dialog(s): ${JSON.stringify(dialogs)}`).toEqual([]);
}

/** One entry of the app's JSONL log. */
interface LogEntry {
  readonly timestamp?: string;
  readonly level?: string;
  readonly scope?: string;
  readonly message?: string;
  readonly context?: Record<string, unknown>;
}

/** Every log entry the main process wrote since `since` (ms epoch). */
function mainProcessLog(since: number): LogEntry[] {
  const logsDir = join(DATA_ROOT, "logs");
  if (!existsSync(logsDir)) return [];

  const entries: LogEntry[] = [];
  // electron.log is Electron's own stream, not ours.
  for (const file of readdirSync(logsDir).filter(
    (f) => f.endsWith(".log") && f !== "electron.log"
  )) {
    for (const line of readFileSync(join(logsDir, file), "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue; // not a JSONL line (the file is written with --log.format=json)
      }
      // Scope to this spec's launch: the logs dir outlives a single app, so
      // without this a failure would resurface in every later spec.
      const at = entry.timestamp === undefined ? NaN : Date.parse(entry.timestamp);
      if (Number.isNaN(at) || at >= since) entries.push(entry);
    }
  }
  return entries;
}

/** Render an entry the way a human would want to read it in a failure. */
function formatEntry(entry: LogEntry): string {
  const scope = entry.scope === undefined ? "" : `[${entry.scope}] `;
  const context =
    entry.context === undefined || Object.keys(entry.context).length === 0
      ? ""
      : ` ${JSON.stringify(entry.context)}`;
  return `${scope}${entry.message ?? "(no message)"}${context}`;
}

/**
 * Fail if the **main process** logged at error level.
 *
 * The renderer has its own console check (see the specs); this covers everything
 * behind the IPC boundary, which is where the interesting failures hide: a broken
 * bundle patch, a failed git op, a dead server. All of those log and carry on, so
 * without this the app looks fine and the spec passes.
 *
 * This is what makes a stale bundle patch a red build. Packaged builds
 * deliberately do not throw when a patch stops matching (that would take down
 * every workspace over one broken feature) — they log at error level and start.
 * The e2e run is packaged, so this assertion is the thing that notices.
 *
 * Strict on purpose: the suite currently produces zero error entries, so there is
 * no allow-list to erode. If a legitimate error appears, silence it at the source
 * or downgrade it — do not add an exception here.
 */
export function expectNoErrorLogs(): void {
  const errors = mainProcessLog(launchedAt).filter((e) => e.level === "error");

  expect(
    errors.map(formatEntry),
    "the app logged error(s) in the main process — it kept running, but something it " +
      "depends on is broken"
  ).toEqual([]);
}

export interface AppHandle {
  (): AppDriver;
}

/**
 * One app launch per spec file, torn down after. `workers: 1` keeps this serial —
 * a packaged Electron app plus a VSCodium server plus an opencode server is not
 * something to run several of at once.
 *
 * `cold: true` skips the reset and the launch entirely; the cold-start spec drives
 * both itself, because it needs to assert on what happens during startup.
 */
export function useApp(options: LaunchAppOptions & { cold?: boolean } = {}): AppHandle {
  let driver: AppDriver;

  // No parameters: Playwright requires the first hook argument to be a destructuring
  // pattern, and `{}` trips eslint's no-empty-pattern. test.info() reaches the same
  // TestInfo without taking one.
  test.beforeAll(async () => {
    driver = createDriver();
    if (options.cold) return;
    // The warm projects are named after the agent they exercise.
    const agent = options.agent ?? (test.info().project.name as Agent);
    // Warm start: keep config.json (agent choice), bundles, and installed VSIXes.
    resetDataState({ keepConfig: true });
    await launchApp(driver, { ...options, agent });
  });

  test.afterAll(async () => {
    await driver?.stop();

    // After stop, so the shutdown path is covered too. Every spec gets this for
    // free: an error logged behind the IPC boundary fails the spec even when every
    // assertion in it passed. `cold: true` never launched, so there is nothing to
    // read — the cold-start spec asserts this itself.
    if (!options.cold) expectNoErrorLogs();
  });

  return () => driver;
}

/** Cold start: an empty root, so the wizard and the downloads both run for real. */
export function resetToColdStart(): void {
  resetRoot();
}

// =============================================================================
// UI helpers
// =============================================================================

/**
 * The sidebar is 20px wide with its overflow clipped, and expands to 250px on
 * hover. Its buttons are therefore not clickable until it expands — Playwright's
 * auto-hover doesn't help, because the ancestor is what clips them.
 */
export async function expandSidebar(ui: Page): Promise<void> {
  await ui.locator("nav.sidebar").dispatchEvent("mouseenter");
  await expect(ui.getByRole("button", { name: "Settings" })).toBeVisible();
}

export async function collapseSidebar(ui: Page): Promise<void> {
  await ui.locator("nav.sidebar").dispatchEvent("mouseleave");
}

/** The workspace-name field. Its placeholder also contains "select branch", so match exactly. */
export function nameField(ui: Page): Locator {
  return ui.getByRole("combobox", { name: "Enter name or select branch...", exact: true });
}

/** The base-branch field. */
export function baseBranchField(ui: Page): Locator {
  return ui.getByRole("combobox", { name: "Select branch...", exact: true });
}

/** Mock the native folder picker, then open `repoPath` as a project. */
export async function openProject(driver: AppDriver, repoPath: string): Promise<void> {
  const ui = driver.uiPage();
  await driver.mockDialog([repoPath]);
  await ui.getByRole("button", { name: "Open project folder" }).click();
  // The name field is disabled until a project is selected.
  await expect(nameField(ui)).toBeEnabled();
}

/**
 * Create a workspace, and wait until it is the active one.
 *
 * Waiting for the sidebar row is not enough: activation lands afterwards, and when the
 * new workspace's iframe takes over the main area it unmounts the creation panel. A
 * caller that immediately opens the panel again races that teardown.
 */
export async function createWorkspace(driver: AppDriver, name: string): Promise<void> {
  const ui = driver.uiPage();
  const panel = ui.getByRole("region", { name: "New workspace" });
  if (!(await panel.isVisible())) {
    await expandSidebar(ui);
    await ui.getByRole("button", { name: "New workspace" }).click();
    await expect(panel).toBeVisible();
    await collapseSidebar(ui);
  }

  // The form stays disabled until the repo's branches have loaded into the base-branch
  // field. With opencode this takes noticeably longer than with claude.
  await expect(baseBranchField(ui)).not.toHaveValue("", { timeout: 60_000 });

  // fill() focuses and dispatches `input` in one step. click()+type() races the
  // dropdown opening, and any keystroke that lands before focus settles is lost —
  // leaving the name empty and the Create button disabled.
  const field = nameField(ui);
  await field.fill(name);
  await expect(field).toHaveValue(name);

  // Close the suggestion listbox only if it is open; it overlays Create. Escape
  // calls stopPropagation() *only* when the listbox is open — press it otherwise and
  // the event bubbles up and dismisses the whole creation panel.
  if ((await field.getAttribute("aria-expanded")) === "true") {
    await ui.keyboard.press("Escape");
    await expect(field).toHaveAttribute("aria-expanded", "false");
  }

  // `<vscode-button disabled>` is a custom element: Playwright's actionability check
  // reports it "enabled" and clicks into the void. Assert the attribute itself.
  // Generous timeout: with opencode the form stays disabled until the agent's
  // launch options (permission modes) have loaded.
  const create = panel.getByRole("button", { name: "Create" });
  await expect(create).not.toHaveAttribute("disabled", /.*/, { timeout: 60_000 });
  await create.click();

  // Creating a worktree, booting the IDE server, and (for opencode) waiting on a
  // 30s agent health check all happen before the row settles.
  await expect(workspaceRow(ui, name)).toBeVisible({ timeout: 180_000 });
  await waitForWorkspaceFrame(driver, name);
}

/**
 * Matches a project by name, case-insensitively: the app case-folds paths on Windows, so
 * a temp dir named `codehydra-test-GS7nxA` renders as `codehydra-test-gs7nxa`.
 */
export function projectNamePattern(name: string): RegExp {
  return new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** The sidebar row button for a workspace, e.g. `alpha in my-project - No agents running`. */
export function workspaceRow(ui: Page, name: string): Locator {
  return ui.getByRole("button", { name: new RegExp(`^${name} in `) });
}

/** Remove a workspace through the sidebar, confirming the dialog. */
export async function removeWorkspace(ui: Page, name: string): Promise<void> {
  await expandSidebar(ui);
  // The project's <li> also *contains* this workspace's row, so the filter matches
  // both. The workspace's own <li> is the deeper (later) one.
  const row = ui
    .getByRole("listitem")
    .filter({ has: workspaceRow(ui, name) })
    .last();
  await row.getByRole("button", { name: "Remove workspace" }).click();

  const dialog = ui.getByRole("dialog", { name: "Remove Workspace" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`Remove workspace "${name}"?`)).toBeVisible();
  // `<vscode-button>` is a custom element with shadow DOM. On Windows a click can land on
  // the host without the inner button seeing it: Playwright reports success, the app never
  // dispatches workspace:delete, and the dialog just sits there. Retry until the dialog
  // actually closes — that is the only evidence the click was received, and re-clicking
  // Remove while the dialog is still open is idempotent.
  const removeButton = dialog.getByRole("button", { name: "Remove", exact: true });
  for (let attempt = 1; ; attempt++) {
    await removeButton.click();
    try {
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  await expect(workspaceRow(ui, name)).toBeHidden({ timeout: 60_000 });
  await collapseSidebar(ui);
}

/** Wait for a workspace iframe to attach and become the active target. */
export async function waitForWorkspaceFrame(driver: AppDriver, name: string): Promise<void> {
  await expect
    .poll(async () => (await driver.findTarget("workspace").catch(() => null))?.frame.url() ?? "", {
      timeout: 120_000,
    })
    .toContain(`${name}.code-workspace`);
}

/** `<dataRoot>/projects/<hash>/workspaces` for the single open project. */
export function workspacesDir(): string {
  const projects = join(DATA_ROOT, "projects");
  const entries = readdirSync(projects);
  if (entries.length !== 1) {
    throw new Error(`expected exactly one project dir, found: ${entries.join(", ") || "none"}`);
  }
  return join(projects, entries[0]!, "workspaces");
}

export { DATA_ROOT, ROOT_DIR, mode };
