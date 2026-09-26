/**
 * AppCtrl — a Playwright driver for a CodeHydra Electron app, in two guises.
 *
 * Executed (`pnpm -s appctrl <command>`), it is a CLI: agents launch,
 * screenshot, and inspect a running app from the shell.
 *
 * Imported, it is a library: `createDriver()` hands back the same behavior as
 * plain functions, which is what the e2e suite drives. One implementation, two
 * front-ends — what you debug interactively is what CI runs.
 *
 * Architecture: Playwright Electron
 * - _electron.launch() manages process lifecycle, page access, and dialog mocking
 * - The app has a single WebContentsView (the UI page); workspaces are
 *   VSCodium iframes inside it. Workspace targeting resolves a Playwright
 *   Frame within the UI page (OOPIFs are fully scriptable through CDP).
 * - The CLI is stateless, the driver is not: `start` spawns a detached daemon
 *   that owns the driver, and every later command is an HTTP call to it on
 *   127.0.0.1. The daemon lives exactly as long as the app.
 *
 * Usage:
 *   CLI:  pnpm -s appctrl --help
 *   Lib:  import { createDriver } from "../scripts/appctrl.ts";
 */

import { _electron, type Frame, type Page, type ElectronApplication } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir, stat, access } from "node:fs/promises";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Repo root — this file lives in <root>/scripts/. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The Electron binary used for unpackaged (dev) launches. */
export const DEV_ELECTRON = join(REPO_ROOT, "node_modules/electron/dist/electron");

/**
 * Flags the driver prepends to every launch it makes.
 *
 * Never chime or toast at whoever is driving the app — a driven app is
 * unfocused by definition, which is exactly when notifications fire. Prepended,
 * not appended, so an explicit caller value wins (parseCliArgs: last wins).
 *
 * Exported so a caller that has to start the app *itself*, outside the driver,
 * can present the same app to the OS (see e2e/fixtures.ts `launchCommand`).
 */
export const DRIVER_APP_ARGS = ["--silent=true", "--notification=disabled"] as const;

// =============================================================================
// Shared types & pure helpers
// =============================================================================

export interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
  source: string;
}

const MAX_CONSOLE = 500;

const LOG_LEVELS = ["silly", "debug", "info", "warn", "error"] as const;

export interface LogEntry {
  timestamp: string;
  level: string;
  scope?: string;
  message: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string };
}

function formatLogEntry(entry: LogEntry): string {
  const ts = entry.timestamp.replace("T", " ").replace("Z", "");
  const scope = entry.scope ? ` [${entry.scope}]` : "";
  let line = `[${ts}] [${entry.level}]${scope} ${entry.message}`;
  if (entry.context && Object.keys(entry.context).length > 0) {
    const pairs = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    line += ` ${pairs}`;
  }
  if (entry.error) {
    line += `\n  Error: ${entry.error.message}`;
    if (entry.error.stack) line += `\n  ${entry.error.stack}`;
  }
  return line;
}

/** One row of the OS process table. */
interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Start time as the OS reports it: tells a recycled pid apart from the process it once was. */
  readonly started: string;
  readonly name: string;
}

const PROCESS_TABLE_QUERY =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.Ticks)`t$($_.Name)" }';

/**
 * The OS process table, or `[]` when it cannot be read.
 *
 * Windows goes through CIM: `tasklist` has no parent pid, and `wmic` is gone
 * from current Windows. It is the slow one (a PowerShell start, around a second).
 */
function processTable(): ProcessEntry[] {
  let listing: string;
  try {
    listing =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              // Encoded, so no quoting rule of Windows' command line can touch it.
              "-EncodedCommand",
              Buffer.from(PROCESS_TABLE_QUERY, "utf16le").toString("base64"),
            ],
            { encoding: "utf-8", timeout: 30_000, windowsHide: true }
          )
        : execFileSync("ps", ["-eo", "pid=,ppid=,lstart=,comm="], {
            encoding: "utf-8",
            env: { ...process.env, LC_ALL: "C" },
          });
  } catch {
    return [];
  }

  // Windows: tab-separated. Unix: `lstart` is always five fields ("Sat Sep 26 15:51:55 2026").
  const row =
    process.platform === "win32"
      ? /^(\d+)\t(\d+)\t(\d*)\t(.*)$/
      : /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
  const entries: ProcessEntry[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = row.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started: match[3]!,
      name: match[4]!.trim(),
    });
  }
  return entries;
}

/**
 * `root` and every process below it. Captured *before* the parent dies — once
 * it exits, the children are reparented (Unix) or keep a parent pid that no
 * longer exists (Windows), and the tree is unrecoverable. That is also why
 * `taskkill /T` after the fact is no substitute: it walks from a root that is gone.
 */
function processTree(root: number): ProcessEntry[] {
  const table = processTable();
  const childrenOf = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    // Windows' System Idle Process is its own parent.
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenOf.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenOf.set(entry.ppid, siblings);
  }

  const found = table.filter((entry) => entry.pid === root);
  const stack = [root];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      found.push(child);
      stack.push(child.pid);
    }
  }
  return found;
}

/** Whether a process with this pid exists (`kill(pid, 0)` works on Windows too). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Those of `captured` still running as the same process, not a recycled pid. */
function stillRunning(captured: readonly ProcessEntry[]): ProcessEntry[] {
  // The table read is slow on Windows; skip it when nothing is even alive.
  if (!captured.some((entry) => pidAlive(entry.pid))) return [];
  const now = new Map(processTable().map((entry) => [entry.pid, entry]));
  return captured.filter((entry) => now.get(entry.pid)?.started === entry.started);
}

/**
 * Kill whatever of the app's tree outlived it, and wait until it is gone.
 *
 * The app reaps its own children on a clean quit, so normally there is nothing
 * to do. This is the backstop for a quit that did not finish (a crash, a
 * shutdown past the timeout), and it matters most on Windows: a leftover
 * process sitting in a worktree keeps the next reset of the data root from
 * deleting it. So a kill is not done when it is sent — termination is
 * asynchronous there, and the handles go only once the process has.
 */
async function killLeftovers(captured: readonly ProcessEntry[]): Promise<void> {
  const leftovers = stillRunning(captured);
  if (leftovers.length === 0) return;

  const names = leftovers.map((entry) => `${entry.name} (${entry.pid})`).join(", ");
  process.stderr.write(`appctrl: killing processes the app left running: ${names}\n`);
  for (const entry of leftovers) {
    try {
      if (process.platform === "win32") {
        // /T as well: it also takes anything a leftover started after the snapshot.
        execFileSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(entry.pid, "SIGKILL");
      }
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + 10_000;
  let alive = leftovers;
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter((entry) => pidAlive(entry.pid));
  }
  if (alive.length > 0) {
    const pids = alive.map((entry) => entry.pid).join(", ");
    process.stderr.write(`appctrl: processes still running after kill: ${pids}\n`);
  }
}

/**
 * Resolved interaction target. The app has one page (the UI); workspaces are
 * VSCodium iframes inside it, addressed as Playwright Frames.
 */
export interface ResolvedTarget {
  /** The UI page (host of all frames). Keyboard input is page-level. */
  page: Page;
  /** Frame to run selectors/evaluate in. The UI's main frame for target "ui". */
  frame: Frame;
  /** True when the target is a workspace iframe (not the UI main frame). */
  isWorkspaceFrame: boolean;
}

export interface LaunchOptions {
  /**
   * Executable to launch. Defaults to the dev Electron binary. For a packaged
   * build, point this at the shipped binary (AppRun / CodeHydra.exe /
   * CodeHydra.app/Contents/MacOS/CodeHydra) and leave `appPath` unset.
   */
  executablePath?: string;
  /**
   * App directory, passed as the first argument. Dev launches only — a packaged
   * app resolves its own app path. Defaults to the repo root for dev launches.
   */
  appPath?: string | null;
  /**
   * Working directory of the launched process. In dev this decides `dataRoot`
   * (`<cwd>/app-data`), so point it at a temp dir to isolate a run.
   */
  cwd?: string;
  /**
   * App flags. Each MUST start with `--`: the app's parseCliArgs treats a bare
   * `--flag` followed by a non-`--` token as that flag's value, so a stray bare
   * argument would be silently swallowed as someone else's value.
   *
   * `--silent=true` and `--notification=disabled` are always prepended; pass
   * either explicitly to opt back in.
   */
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Launch timeout (ms). Default 60_000. */
  timeout?: number;
  /** Default timeout for Playwright actions (ms). Default 2_000. */
  actionTimeout?: number;
  /** Called for every console message, alongside the in-memory buffer. */
  onConsole?: (entry: ConsoleEntry) => void;
}

/** A native Electron dialog the app tried to show while under test. */
export interface NativeDialog {
  kind: "error-box" | "message-box";
  title?: string;
  content?: string;
}

export interface ReadLogsOptions {
  scope?: string;
  level?: string;
  limit?: number;
  order?: "asc" | "desc";
  /** Directory holding the JSONL logs. Defaults to `<cwd>/app-data/logs`. */
  logsDir?: string;
}

export interface WaitForOptions {
  target?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  /** Milliseconds. Defaults to the driver's action timeout. */
  timeout?: number;
}

export type AppDriver = ReturnType<typeof createDriver>;

/** Read + filter the most recent JSONL log file. Returns formatted lines plus a header. */
export async function readLogs(options: ReadLogsOptions = {}): Promise<string> {
  const {
    scope,
    level = "debug",
    limit = 50,
    order = "desc",
    logsDir = join(process.cwd(), "app-data", "logs"),
  } = options;

  const files = await readdir(logsDir).catch(() => [] as string[]);
  const logFiles = files.filter((f) => f.endsWith(".log"));
  if (logFiles.length === 0) throw new Error("No log files found in " + logsDir);

  // Find most recent by mtime
  const withStats = await Promise.all(
    logFiles.map(async (f) => ({ name: f, mtime: (await stat(join(logsDir, f))).mtimeMs }))
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  const latest = withStats[0]!;

  const content = await readFile(join(logsDir, latest.name), "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  // Parse JSONL — emit a synthetic error entry on parse failure
  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      entries.push({
        timestamp: "",
        level: "error",
        scope: "appctrl",
        message: `Failed to parse log line: ${line}`,
      });
    }
  }

  let filtered = entries;
  if (scope) filtered = filtered.filter((e) => e.scope === scope);
  if (level) {
    const minPriority = LOG_LEVELS.indexOf(level as (typeof LOG_LEVELS)[number]);
    if (minPriority >= 0) {
      filtered = filtered.filter(
        (e) => LOG_LEVELS.indexOf(e.level as (typeof LOG_LEVELS)[number]) >= minPriority
      );
    }
  }

  if (order === "desc") filtered.reverse();
  const result = filtered.slice(0, limit);
  const formatted = result.map(formatLogEntry).join("\n");
  const header = `${result.length} of ${filtered.length} entries (file: ${latest.name})`;
  return `${header}\n\n${formatted}`;
}

// =============================================================================
// Driver
// =============================================================================

/**
 * A single app instance and everything you can do to it. State lives in the
 * closure, so a Playwright worker can own one driver per app without the tools
 * and the tests fighting over a module-level singleton.
 */
export function createDriver() {
  let electronApp: ElectronApplication | null = null;
  const consoleBuffer: ConsoleEntry[] = [];
  let consoleSink: ((entry: ConsoleEntry) => void) | undefined;

  function subscribePageConsole(page: Page): void {
    page.on("console", (msg) => {
      const entry = { level: msg.type(), text: msg.text(), ts: Date.now(), source: page.url() };
      consoleBuffer.push(entry);
      if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
      consoleSink?.(entry);
    });
  }

  /** The running app, or throw. */
  function electron(): ElectronApplication {
    if (!electronApp) throw new Error("App not started.");
    return electronApp;
  }

  function isRunning(): boolean {
    return electronApp !== null;
  }

  function pid(): number | undefined {
    return electronApp?.process().pid;
  }

  async function launch(options: LaunchOptions = {}): Promise<{ pid: number | undefined }> {
    if (electronApp) throw new Error(`App already running (PID ${pid()})`);

    const {
      executablePath = DEV_ELECTRON,
      cwd = process.cwd(),
      args = [],
      env = process.env,
      timeout = 60_000,
      actionTimeout = 2_000,
    } = options;

    // Dev launches need the app path as argv[1]; packaged builds resolve their own.
    const isDev = executablePath === DEV_ELECTRON;
    const appPath = options.appPath === undefined && isDev ? REPO_ROOT : (options.appPath ?? null);

    for (const arg of args) {
      if (!arg.startsWith("--")) {
        throw new Error(
          `App flag ${JSON.stringify(arg)} must start with "--": a bare token is parsed as the ` +
            `previous flag's value (see parseCliArgs in config.ts).`
        );
      }
    }

    const appArgs = [...DRIVER_APP_ARGS, ...args];
    consoleSink = options.onConsole;

    if (appPath !== null) {
      try {
        await access(join(appPath, "out/main/index.cjs"));
      } catch {
        throw new Error(
          `Build not found at ${join(appPath, "out/main/index.cjs")}. Run \`pnpm build\` first.`
        );
      }
    }

    try {
      electronApp = await _electron.launch({
        executablePath,
        args: [...(appPath !== null ? [appPath] : []), ...appArgs],
        cwd,
        env: env as Record<string, string>,
        timeout,
      });

      electronApp.context().setDefaultTimeout(actionTimeout);
      for (const page of electronApp.context().pages()) subscribePageConsole(page);
      // Subscribe to new pages (WebContentsViews created after launch)
      electronApp.context().on("page", (page) => subscribePageConsole(page));
    } catch (err) {
      await stop();
      throw err;
    }

    return { pid: pid() };
  }

  /**
   * Graceful async cleanup — for normal stop.
   *
   * Quits through the app's own shutdown path (`app.quit()` → `before-quit` →
   * `app:shutdown`, which disposes the IDE server and agent servers). Killing the
   * Electron process instead orphans those children, and because they inherit its
   * stdio pipes, the pipes never close and the host process cannot exit — which is
   * how a Playwright worker ends up hanging in teardown.
   *
   * `killLeftovers` is the backstop for whatever the app does not take down.
   */
  async function stop(): Promise<void> {
    if (electronApp) {
      const app = electronApp;
      electronApp = null;

      // The app may already be gone — it quit on a fatal startup error, or it
      // crashed. Playwright's handle then throws from process(), and that
      // TypeError surfaces as the spec's failure, hiding whatever actually went
      // wrong. Nothing to tear down in that case.
      let proc: ReturnType<typeof app.process> | undefined;
      try {
        proc = app.process();
      } catch {
        proc = undefined;
      }
      if (proc?.pid === undefined) return;

      const appPid = proc.pid;

      // Snapshot the tree while the parent still owns it.
      const tree = processTree(appPid);

      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

      // Fire-and-forget: the main process exits mid-call, so this evaluate never
      // settles — neither resolving nor rejecting. Awaiting it hangs forever.
      void app
        .evaluate(({ app: electronAppApi }) => {
          electronAppApi.quit();
        })
        .catch(() => {
          // Main process already gone, or CDP is down.
        });

      const timedOut = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 15_000)
      );
      await Promise.race([exited, timedOut]);

      await killLeftovers(tree);

      // close() talks CDP to a process we just killed; it can hang rather than reject.
      await Promise.race([
        app.close().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);

      // Even reaped, the pipes can linger; nothing reads them after this point.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
    }
    consoleBuffer.length = 0;
  }

  /** Sync cleanup — for signal handlers (SIGINT, SIGTERM, exit, uncaughtException). */
  function killSync(): void {
    if (electronApp) {
      try {
        process.kill(electronApp.process().pid!, "SIGTERM");
      } catch {
        // already dead
      }
      electronApp = null;
    }
    consoleBuffer.length = 0;
  }

  function uiPage(): Page {
    const page = electron()
      .context()
      .pages()
      .find((p) => p.url().startsWith("file://"));
    if (!page) throw new Error("UI view not found");
    return page;
  }

  /**
   * The UI page is a WebContentsView created after `app.whenReady()`, so it does not
   * exist the instant launch() resolves. Playwright skips injecting its loader when we
   * supply an executablePath, which means we attach after ready rather than before it —
   * poll instead of assuming.
   */
  async function waitForUiPage(timeoutMs = 60_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return uiPage();
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  function isWorkspaceUrl(url: string): boolean {
    return url.includes("127.0.0.1") && (url.includes("folder=") || url.includes("workspace="));
  }

  /** True if the frame's <iframe> element carries the .active class. */
  async function isActiveFrame(frame: Frame): Promise<boolean> {
    try {
      const el = await frame.frameElement();
      const active = await el.evaluate((node) => (node as Element).classList.contains("active"));
      await el.dispose();
      return active;
    } catch {
      return false;
    }
  }

  async function findTarget(target: string = "workspace"): Promise<ResolvedTarget> {
    const page = uiPage();

    if (target === "ui") {
      return { page, frame: page.mainFrame(), isWorkspaceFrame: false };
    }

    if (target === "workspace") {
      const frames = page.frames().filter((f) => isWorkspaceUrl(f.url()));
      if (frames.length === 0) throw new Error("No workspace frames found");
      // Prefer the visible workspace (its <iframe> has the .active class)
      for (const f of frames) {
        if (await isActiveFrame(f)) return { page, frame: f, isWorkspaceFrame: true };
      }
      return { page, frame: frames[0]!, isWorkspaceFrame: true };
    }

    // URL substring match across all frames (main frame included)
    const frame = page.frames().find((f) => f.url().includes(target));
    if (!frame) throw new Error(`No view matching "${target}"`);
    return { page, frame, isWorkspaceFrame: frame !== page.mainFrame() };
  }

  /**
   * Route page-level keyboard input to a workspace frame by focusing its
   * iframe content first. No-op for the UI main frame.
   */
  async function focusTargetFrame(resolved: ResolvedTarget): Promise<void> {
    if (!resolved.isWorkspaceFrame) return;
    try {
      const el = await resolved.frame.frameElement();
      await el.evaluate((node) => (node as HTMLElement).focus());
      await el.dispose();
      await resolved.frame.evaluate(() => {
        window.focus();
      });
    } catch {
      // Best-effort: hidden frames can't take focus
    }
  }

  async function screenshot(target?: string): Promise<Buffer> {
    const resolved = await findTarget(target);
    if (resolved.isWorkspaceFrame) {
      // Screenshot the <iframe> element from the host page (clips the page
      // capture to the frame's box — frames have no direct screenshot API).
      const el = await resolved.frame.frameElement();
      const buffer = await el.screenshot({ type: "png" });
      await el.dispose();
      return buffer;
    }
    return resolved.page.screenshot({ type: "png" });
  }

  async function dom(selector: string = "body", target?: string): Promise<string> {
    const { frame } = await findTarget(target);
    return frame.locator(selector).ariaSnapshot();
  }

  async function click(selector: string, target?: string): Promise<void> {
    const { frame } = await findTarget(target);
    await frame.click(selector);
  }

  async function type(text: string, selector?: string, target?: string): Promise<void> {
    const resolved = await findTarget(target);
    if (selector) {
      await resolved.frame.fill(selector, text);
    } else {
      // Keyboard input is page-level; route it into workspace frames.
      await focusTargetFrame(resolved);
      await resolved.page.keyboard.type(text);
    }
  }

  async function key(keyCombo: string, target?: string): Promise<void> {
    const resolved = await findTarget(target);
    // Keyboard input is page-level; route it into workspace frames.
    await focusTargetFrame(resolved);
    await resolved.page.keyboard.press(keyCombo);
  }

  async function evaluate(code: string, target?: string): Promise<unknown> {
    const { frame } = await findTarget(target);
    return frame.evaluate(code);
  }

  /** Wait until the first element matching `selector` reaches `state` (default visible). */
  async function waitFor(selector: string, options: WaitForOptions = {}): Promise<void> {
    const { frame } = await findTarget(options.target);
    await frame
      .locator(selector)
      .first()
      .waitFor({
        ...(options.state !== undefined && { state: options.state }),
        ...(options.timeout !== undefined && { timeout: options.timeout }),
      });
  }

  /**
   * Expand the sidebar. It is 20px and overflow-clipped until hovered, and a
   * headless run has no cursor to hover with.
   */
  async function expandSidebar(): Promise<void> {
    const found = await uiPage().evaluate(() => {
      const nav = document.querySelector("nav.sidebar");
      nav?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      return nav !== null;
    });
    if (!found) throw new Error("nav.sidebar not found");
  }

  /** Mock Electron's folder picker so it auto-returns `paths`. */
  async function mockDialog(paths: string[]): Promise<void> {
    await electron().evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: p });
    }, paths);
  }

  /**
   * Replace Electron's blocking native dialogs with recorders.
   *
   * A real one — CodeHydra's own "Startup Failed" error box, say — blocks the main
   * process forever with no window to click, which in a headless run reads as a hang.
   * Recording them instead lets a test assert `nativeDialogs()` is empty and fail with
   * the actual error text.
   */
  async function silenceNativeDialogs(): Promise<void> {
    await electron().evaluate(({ dialog }) => {
      const store = globalThis as unknown as { __chNativeDialogs?: NativeDialog[] };
      store.__chNativeDialogs = [];
      const record = (entry: NativeDialog): void => void store.__chNativeDialogs?.push(entry);

      dialog.showErrorBox = (title: string, content: string): void =>
        record({ kind: "error-box", title, content });

      dialog.showMessageBoxSync = ((): number => {
        record({ kind: "message-box" });
        return 0;
      }) as typeof dialog.showMessageBoxSync;

      dialog.showMessageBox = ((): Promise<{ response: number; checkboxChecked: boolean }> => {
        record({ kind: "message-box" });
        return Promise.resolve({ response: 0, checkboxChecked: false });
      }) as typeof dialog.showMessageBox;
    });
  }

  /** Native dialogs the app tried to show since silenceNativeDialogs(). */
  async function nativeDialogs(): Promise<NativeDialog[]> {
    return electron().evaluate(() => {
      const store = globalThis as unknown as { __chNativeDialogs?: NativeDialog[] };
      return store.__chNativeDialogs ?? [];
    });
  }

  /** Emit powerMonitor "resume" in the main process (drives the app:resume intent). */
  async function resume(): Promise<void> {
    await electron().evaluate(({ powerMonitor }) => {
      powerMonitor.emit("resume");
    });
  }

  function consoleMessages(options: { level?: string; clear?: boolean } = {}): ConsoleEntry[] {
    let messages = [...consoleBuffer];
    if (options.level) messages = messages.filter((m) => m.level === options.level);
    if (options.clear) consoleBuffer.length = 0;
    return messages;
  }

  async function targets(): Promise<Array<{ url: string; title: string; active?: boolean }>> {
    const page = uiPage();
    const list: Array<{ url: string; title: string; active?: boolean }> = [
      { url: page.url(), title: "UI (single view; workspaces are iframes inside it)" },
    ];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const workspace = isWorkspaceUrl(frame.url());
      list.push({
        url: frame.url(),
        title: workspace ? "Workspace (iframe)" : "Other (iframe)",
        ...(workspace && { active: await isActiveFrame(frame) }),
      });
    }
    return list;
  }

  return {
    launch,
    stop,
    killSync,
    isRunning,
    pid,
    electron,
    uiPage,
    waitForUiPage,
    isWorkspaceUrl,
    isActiveFrame,
    findTarget,
    focusTargetFrame,
    screenshot,
    dom,
    click,
    type,
    key,
    evaluate,
    waitFor,
    expandSidebar,
    mockDialog,
    silenceNativeDialogs,
    nativeDialogs,
    resume,
    consoleMessages,
    targets,
    readLogs,
  };
}

// =============================================================================
// CLI: files, daemon protocol
// =============================================================================

/**
 * Everything the CLI keeps on disk lives in the dev data root the launched app
 * uses too (`<cwd>/app-data`, gitignored) — so each worktree has its own daemon,
 * and parallel workspaces never find each other's app.
 */
const DATA_DIR = join(process.cwd(), "app-data");
const STATE_FILE = join(DATA_DIR, "appctrl.json");
const CONSOLE_FILE = join(DATA_DIR, "appctrl-console.jsonl");
const DAEMON_LOG = join(DATA_DIR, "appctrl-daemon.log");
const SCREENSHOT_DIR = join(DATA_DIR, "screenshots");

/** How long a daemon waits for its `start` request before giving up. */
const DAEMON_IDLE_TIMEOUT_MS = 120_000;

/** Where a running daemon listens. Written by the daemon, read by the CLI. */
interface DaemonState {
  port: number;
  pid: number;
}

/** Status the daemon reports about the app it owns. */
interface AppStatus {
  pid: number | undefined;
  headless: boolean;
  packaged: string | null;
}

/** Request bodies, per daemon command. The CLI parses and validates; the daemon trusts. */
interface DaemonRequests {
  start: { headless: boolean; packaged?: string; flags: string[] };
  stop: Record<string, never>;
  status: Record<string, never>;
  screenshot: { target?: string };
  dom: { selector?: string; target?: string };
  click: { selector: string; target?: string };
  type: { text: string; selector?: string; target?: string };
  key: { key: string; target?: string };
  eval: { code: string; target?: string };
  "wait-for": { selector: string } & WaitForOptions;
  "expand-sidebar": Record<string, never>;
  dialog: { paths: string[] };
  resume: Record<string, never>;
  targets: Record<string, never>;
}

type DaemonCommand = keyof DaemonRequests;

type DaemonHandlers = {
  [K in DaemonCommand]: (params: DaemonRequests[K]) => Promise<unknown>;
};

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running daemon, or null. A state file whose pid is dead is a crashed daemon. */
function readDaemonState(): DaemonState | null {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as DaemonState;
    return isAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function requireDaemon(): DaemonState {
  const state = readDaemonState();
  if (!state) throw new Error("App not running. Start it with `pnpm -s appctrl start`.");
  return state;
}

async function callDaemon<K extends DaemonCommand>(
  state: DaemonState,
  command: K,
  params: DaemonRequests[K]
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${state.port}/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `daemon answered HTTP ${response.status}`);
  return body.result;
}

/** Call the running daemon, or fail with a hint to start one. */
function send<K extends DaemonCommand>(command: K, params: DaemonRequests[K]): Promise<unknown> {
  return callDaemon(requireDaemon(), command, params);
}

/**
 * Spawn a detached daemon and wait for it to publish its port. Its stdio goes to
 * a log file, not to us — an inherited pipe would hold the caller's shell open
 * for as long as the app runs.
 */
async function spawnDaemon(): Promise<DaemonState> {
  mkdirSync(DATA_DIR, { recursive: true });
  rmSync(STATE_FILE, { force: true });

  const log = openSync(DAEMON_LOG, "w");
  // Same node, same loader flags (tsx's --import): the daemon is this file again.
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "__daemon"],
    { detached: true, stdio: ["ignore", log, log], windowsHide: true }
  );
  closeSync(log);
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    if (state && state.pid === child.pid) return state;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`appctrl daemon failed to start — see ${DAEMON_LOG}`);
}

/** Console entries the daemon persisted, oldest first. Readable after the app is gone. */
function readConsoleFile(level?: string): ConsoleEntry[] {
  let content: string;
  try {
    content = readFileSync(CONSOLE_FILE, "utf-8");
  } catch {
    return [];
  }
  const entries: ConsoleEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as ConsoleEntry);
    } catch {
      // A line torn by a crash mid-write; the rest is still worth reading.
    }
  }
  const filtered = level ? entries.filter((e) => e.level === level) : entries;
  return filtered.slice(-MAX_CONSOLE);
}

// =============================================================================
// CLI: daemon
// =============================================================================

/**
 * The long-lived half: owns one driver, serves the CLI over HTTP on 127.0.0.1,
 * and exits with the app — on `stop`, on a crash, or when the app is quit from
 * its own UI — so there is never a daemon without an app to go stale.
 */
function runDaemon(): void {
  const driver = createDriver();
  let status: AppStatus | null = null;
  let stopping = false;

  function exit(code: number): never {
    driver.killSync();
    // Only our own state file: a successor may already have replaced it.
    if (readDaemonState()?.pid === process.pid) {
      rmSync(STATE_FILE, { force: true });
    }
    process.exit(code);
  }

  const handlers: DaemonHandlers = {
    start: async ({ headless, packaged, flags }) => {
      if (driver.isRunning()) throw new Error(`App already running (PID ${driver.pid()})`);

      // App flags go after the app path — processed by CodeHydra's config system.
      // Headless flags are applied via --electron.flags which the app reads
      // and applies via app.commandLine.appendSwitch() before app.whenReady().
      const appFlags = ["--log.format=json", "--log.level=silly"];
      if (headless) appFlags.push("--electron.flags=--ozone-platform=headless --disable-gpu");
      appFlags.push(...flags);

      writeFileSync(CONSOLE_FILE, "");
      // A packaged build resolves its own app path; the dev build takes the repo root
      // so app.getAppPath() isn't out/main/ (which would break asset resolution).
      const { pid } = await driver.launch({
        ...(packaged !== undefined && { executablePath: packaged, appPath: null }),
        args: appFlags,
        onConsole: (entry) => appendFileSync(CONSOLE_FILE, JSON.stringify(entry) + "\n"),
      });
      driver
        .electron()
        .process()
        .once("exit", () => {
          if (!stopping) exit(0);
        });
      // Every other command needs the UI page; return once there is one.
      await driver.waitForUiPage();

      status = { pid, headless, packaged: packaged ?? null };
      return status;
    },
    stop: async () => {
      stopping = true;
      await driver.stop();
      return null;
    },
    status: async () => status,
    screenshot: async ({ target = "workspace" }) => {
      const buffer = await driver.screenshot(target);
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const slug = target.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "view";
      const file = join(SCREENSHOT_DIR, `${stamp}-${slug}.png`);
      writeFileSync(file, buffer);
      return file;
    },
    dom: ({ selector, target }) => driver.dom(selector, target),
    click: ({ selector, target }) => driver.click(selector, target),
    type: ({ text, selector, target }) => driver.type(text, selector, target),
    key: ({ key, target }) => driver.key(key, target),
    eval: ({ code, target }) => driver.evaluate(code, target),
    "wait-for": ({ selector, ...options }) => driver.waitFor(selector, options),
    "expand-sidebar": () => driver.expandSidebar(),
    dialog: ({ paths }) => driver.mockDialog(paths),
    resume: () => driver.resume(),
    targets: () => driver.targets(),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = "";
    req.setEncoding("utf-8");
    for await (const chunk of req) body += chunk as string;

    const command = (req.url ?? "/").slice(1);
    const reply = (code: number, payload: unknown, then?: () => void): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload), then);
    };

    if (!Object.hasOwn(handlers, command)) {
      reply(404, { error: `Unknown command: ${command}` });
      return;
    }
    const handler = handlers[command as DaemonCommand] as (params: unknown) => Promise<unknown>;

    try {
      const result = await handler(body ? (JSON.parse(body) as unknown) : {});
      // A daemon without an app has nothing left to serve.
      reply(200, { result: result ?? null }, driver.isRunning() ? undefined : () => exit(0));
    } catch (err) {
      reply(500, { error: asMessage(err) }, driver.isRunning() ? undefined : () => exit(1));
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid } satisfies DaemonState));
  });

  // The CLI that spawned us died before sending `start`.
  setTimeout(() => {
    if (!driver.isRunning()) exit(1);
  }, DAEMON_IDLE_TIMEOUT_MS).unref();

  process.on("SIGTERM", () => exit(0));
  process.on("SIGINT", () => exit(0));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`appctrl daemon crashed: ${err.stack ?? err.message}\n`);
    exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`appctrl daemon unhandled rejection: ${msg}\n`);
    exit(1);
  });
}

// =============================================================================
// CLI: commands
// =============================================================================

type OptionValues = Record<string, string | boolean | undefined>;

interface Invocation {
  values: OptionValues;
  positionals: string[];
}

interface CliCommand {
  usage: string;
  summary: string;
  options?: Record<string, { type: "string" | "boolean"; short?: string }>;
  /** Returns what to print on stdout, if anything. */
  run: (invocation: Invocation) => Promise<string | undefined>;
}

const TARGET_OPTION = { target: { type: "string", short: "t" } } as const;

const TARGET_HELP =
  '--target, -t   View: "workspace" (default, the visible workspace iframe), "ui" (the whole\n' +
  "               window), or a URL substring matching a frame (see `targets`)";

class UsageError extends Error {}

function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function positional(invocation: Invocation, index: number, name: string): string {
  const value = invocation.positionals[index];
  if (value === undefined) throw new UsageError(`missing <${name}>`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function targetOf(values: OptionValues): { target?: string } {
  const target = stringOption(values, "target");
  return target === undefined ? {} : { target };
}

const COMMANDS: Record<string, CliCommand> = {
  start: {
    usage: "start [--headed] [--packaged <exe>] [-- <app flag>…]",
    summary:
      "Launch CodeHydra (headless unless --headed) and return once its UI is up. Needs\n" +
      "`pnpm build` first. --packaged launches a packaged binary instead of the dev build\n" +
      "(e.g. dist/linux-unpacked/codehydra) to reproduce a CI failure. App flags follow `--`\n" +
      "(e.g. -- --agent=opencode); log.level and log.format are managed by appctrl.\n" +
      "Prints {pid, headless, packaged}.",
    options: { headed: { type: "boolean" }, packaged: { type: "string" } },
    run: async ({ values, positionals }) => {
      if (readDaemonState()) {
        throw new Error("App already running — `pnpm -s appctrl stop` it first.");
      }
      const packaged = stringOption(values, "packaged");
      const state = await spawnDaemon();
      const result = await callDaemon(state, "start", {
        headless: values["headed"] !== true,
        ...(packaged !== undefined && { packaged: resolve(packaged) }),
        flags: positionals,
      });
      return json(result);
    },
  },
  stop: {
    usage: "stop",
    summary: "Quit the app through its own shutdown path. The daemon exits with it.",
    run: async () => {
      const state = readDaemonState();
      if (!state) {
        process.stderr.write("App not running.\n");
        return undefined;
      }
      await callDaemon(state, "stop", {});
      return undefined;
    },
  },
  status: {
    usage: "status",
    summary:
      "Whether an app is running in this worktree: {running, daemonPid, port, pid, headless, packaged}.",
    run: async () => {
      const state = readDaemonState();
      if (!state) return json({ running: false });
      const app = (await callDaemon(state, "status", {})) as AppStatus | null;
      return json({ running: app !== null, daemonPid: state.pid, port: state.port, ...app });
    },
  },
  screenshot: {
    usage: "screenshot [--target <view>]",
    summary: "Capture a PNG into ./app-data/screenshots/ and print its path — then Read it.",
    options: TARGET_OPTION,
    run: async ({ values }) => String(await send("screenshot", targetOf(values))),
  },
  dom: {
    usage: "dom [<selector>] [--target <view>]",
    summary:
      "Print the accessibility tree as YAML, scoped to <selector> (default body). A line\n" +
      '`- button "Create"` means the selector `role=button[name="Create"]` works.',
    options: TARGET_OPTION,
    run: async ({ values, positionals }) => {
      const selector = positionals[0];
      return String(
        await send("dom", { ...(selector !== undefined && { selector }), ...targetOf(values) })
      );
    },
  },
  click: {
    usage: "click <selector> [--target <view>]",
    summary:
      "Click an element. Prefer role= and text= selectors: @vscode-elements components\n" +
      "have shadow DOM that CSS selectors cannot reach.",
    options: TARGET_OPTION,
    run: async (inv) => {
      await send("click", { selector: positional(inv, 0, "selector"), ...targetOf(inv.values) });
      return undefined;
    },
  },
  type: {
    usage: "type <text> [--selector <selector>] [--target <view>]",
    summary:
      "Type into the focused element, or fill <selector>. Filling rarely reaches the inner\n" +
      "<input> of a vscode-textfield — prefer focusing it and typing without --selector.",
    options: { ...TARGET_OPTION, selector: { type: "string", short: "s" } },
    run: async (inv) => {
      const selector = stringOption(inv.values, "selector");
      await send("type", {
        text: positional(inv, 0, "text"),
        ...(selector !== undefined && { selector }),
        ...targetOf(inv.values),
      });
      return undefined;
    },
  },
  key: {
    usage: "key <combo> [--target <view>]",
    summary:
      "Press a key or shortcut as a trusted input event: Enter, Escape, ArrowDown, Control+p,\n" +
      "Control+Shift+p. Synthetic KeyboardEvents do not work in the IDE; this does.",
    options: TARGET_OPTION,
    run: async (inv) => {
      await send("key", { key: positional(inv, 0, "combo"), ...targetOf(inv.values) });
      return undefined;
    },
  },
  eval: {
    usage: "eval <code | -> [--target <view>]",
    summary:
      "Evaluate a JavaScript expression in the view's renderer and print the result as JSON.\n" +
      "`-` reads the code from stdin (no shell quoting). It must be an expression — wrap\n" +
      "statements in an IIFE: (() => { …; return x; })(). A bare `return` is a SyntaxError.",
    options: TARGET_OPTION,
    run: async (inv) => {
      const arg = positional(inv, 0, "code");
      const code = arg === "-" ? readFileSync(0, "utf-8") : arg;
      return json(await send("eval", { code, ...targetOf(inv.values) }));
    },
  },
  "wait-for": {
    usage: "wait-for <selector> [--state <state>] [--timeout <ms>] [--target <view>]",
    summary:
      "Block until the first match of <selector> is visible (or --state attached, detached,\n" +
      "hidden). --timeout defaults to 10000.",
    options: {
      ...TARGET_OPTION,
      state: { type: "string" },
      timeout: { type: "string" },
    },
    run: async (inv) => {
      const state = stringOption(inv.values, "state");
      if (state !== undefined && !["attached", "detached", "visible", "hidden"].includes(state)) {
        throw new UsageError(`--state must be attached, detached, visible or hidden`);
      }
      const timeout = Number(stringOption(inv.values, "timeout") ?? "10000");
      if (!Number.isFinite(timeout) || timeout < 0) {
        throw new UsageError("--timeout must be milliseconds");
      }
      await send("wait-for", {
        selector: positional(inv, 0, "selector"),
        timeout,
        ...(state !== undefined && { state: state as NonNullable<WaitForOptions["state"]> }),
        ...targetOf(inv.values),
      });
      return undefined;
    },
  },
  "expand-sidebar": {
    usage: "expand-sidebar",
    summary:
      "Expand the sidebar. It is 20px and clipped until hovered, and headless has no\n" +
      "cursor — do this before clicking anything in it.",
    run: async () => {
      await send("expand-sidebar", {});
      return undefined;
    },
  },
  dialog: {
    usage: "dialog <path>…",
    summary:
      "Make Electron's folder picker return <path>… instead of opening. Run it before the\n" +
      "action that opens the picker (e.g. Open Project); again to change the paths.",
    run: async ({ positionals }) => {
      if (positionals.length === 0) throw new UsageError("missing <path>");
      await send("dialog", { paths: positionals.map((p) => resolve(p)) });
      return undefined;
    },
  },
  resume: {
    usage: "resume",
    summary:
      "Emit powerMonitor 'resume' in the main process — the app:resume path a wake from\n" +
      "sleep takes, without suspending the host.",
    run: async () => {
      await send("resume", {});
      return undefined;
    },
  },
  targets: {
    usage: "targets",
    summary:
      "List the UI page and every workspace iframe (`active` marks the visible one), as JSON.",
    run: async () => json(await send("targets", {})),
  },
  console: {
    usage: "console [--level <level>] [--clear]",
    summary:
      "Print renderer console messages since `start` as JSON (last 500), filtered to one\n" +
      "level (error, warning, log, info, debug). Works after the app is gone, crash included.\n" +
      "--clear empties the log after reading.",
    options: { level: { type: "string" }, clear: { type: "boolean" } },
    run: async ({ values }) => {
      const messages = readConsoleFile(stringOption(values, "level"));
      if (values["clear"] === true && existsSync(CONSOLE_FILE)) writeFileSync(CONSOLE_FILE, "");
      return json(messages);
    },
  },
  logs: {
    usage: "logs [--scope <scope>] [--level <level>] [--limit <n>] [--order asc|desc]",
    summary:
      "Print the most recent app log (./app-data/logs), newest first. --scope matches a\n" +
      "logger exactly (git, fs, dispatcher, app, …); --level is a minimum (silly < debug <\n" +
      "info < warn < error, default debug); --limit defaults to 50. Needs no running app.",
    options: {
      scope: { type: "string" },
      level: { type: "string" },
      limit: { type: "string" },
      order: { type: "string" },
    },
    run: async ({ values }) => {
      const order = stringOption(values, "order") ?? "desc";
      if (order !== "asc" && order !== "desc") throw new UsageError("--order must be asc or desc");
      const limit = Number(stringOption(values, "limit") ?? "50");
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a count");
      const scope = stringOption(values, "scope");
      return readLogs({
        ...(scope !== undefined && { scope }),
        level: stringOption(values, "level") ?? "debug",
        limit,
        order,
        logsDir: join(DATA_DIR, "logs"),
      });
    },
  },
  guide: {
    usage: "guide",
    summary: "Print the debugging guide: views, selectors, shadow DOM, the sidebar, recipes.",
    run: async () => GUIDE,
  },
};

const GUIDE = `# AppCtrl Debugging Guide

Every command below is \`pnpm -s appctrl <command>\`; \`--help\` after any command
explains its flags.

## Views
The app has a single WebContentsView (the UI page); workspaces are VSCodium
iframes inside it, addressed as Playwright frames:
- **UI**: \`file://\` URL — the Svelte app, hosts everything (\`--target ui\`)
- **Workspace**: \`http://127.0.0.1:{port}/?workspace=...\` — a VSCodium iframe
  (\`--target workspace\`, the default, is the visible one)
- Every non-hibernated workspace has a mounted iframe; only the active one is visible
- \`screenshot --target ui\` captures the whole window; the default clips to the active iframe

## Typical workflow
1. \`start\` — launches the app headless. Needs \`pnpm build\` first.
2. \`screenshot\` — see what is on screen (Read the printed path)
3. \`dom\` — the accessibility tree, to find selectors
4. \`click\` / \`type\` / \`key\` with selectors from the tree
5. Investigate with \`eval\`, \`console\`, \`logs\`
6. After a code change: \`stop\`, \`pnpm build\`, \`start\`
7. \`stop\` when done

## Shadow DOM — critical for UI interaction
CodeHydra uses \`@vscode-elements\` web components for form controls:
\`vscode-button\`, \`vscode-textfield\`, \`vscode-checkbox\`, \`vscode-single-select\`, …

They have **shadow DOM** — CSS selectors cannot reach their internals:
- \`vscode-textfield[placeholder="..."]\` — WILL NOT WORK (shadow boundary)
- \`button:has-text("Create")\` — WILL NOT WORK (the inner <button> is in shadow DOM)

What works:
1. **ARIA/role selectors** (pierce shadow DOM): \`role=button[name="Create"]\`,
   \`role=combobox\`, \`role=dialog\`
2. **Text selectors**: \`text=Create\`, \`text=Cancel\`
3. **Class selectors on wrapper elements**: \`.dialog\`, \`.sidebar\`, \`.dropdown-option\`
4. **eval** as the fallback for anything complex

For text input, focus the field and \`type\` without \`--selector\`.

## Sidebar
The sidebar is 20px when collapsed (overflow clipped) and expands to 250px on hover.
Headless there is no cursor, so it stays collapsed. Run \`expand-sidebar\` before
clicking anything in it. To collapse it again:

    pnpm -s appctrl eval --target ui "document.querySelector('nav.sidebar')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: 100 })) ?? null"

## Opening a project
1. Create a temp git repo:
   \`git init /tmp/appctrl-test && git -C /tmp/appctrl-test commit --allow-empty -m init\`
2. Mock the folder picker: \`dialog /tmp/appctrl-test\`
3. \`expand-sidebar\`, then click Open Project
4. The mock returns the path — no native dialog appears

IMPORTANT: never open the user's real projects. Always use temporary git repos.

## Workspace (IDE) views
- \`acquireVsCodeApi\` is NOT available — this is the IDE server, not a VS Code extension
- \`document.dispatchEvent(new KeyboardEvent(...))\` does NOT work — untrusted events
- Use \`type\` for text and \`key\` for shortcuts: Control+p (Quick Open),
  Control+Shift+p (Command Palette)
- To open a file: \`key Control+p\`, \`type <filename>\`, \`key Enter\`

## eval
The code is an expression, and its value is printed as JSON. NEVER use a bare
\`return\` — it is a SyntaxError. Wrap statements in an IIFE. Use \`eval -\` with a
heredoc to avoid shell quoting:

    pnpm -s appctrl eval --target ui - <<'JS'
    (() => { const el = document.querySelector('#my-id'); return el?.value; })()
    JS

**Good**: \`document.querySelector('.dialog')?.textContent ?? 'not found'\`
**Bad**: \`return document.querySelector('#my-id').value\` (bare return)
**Bad**: \`const el = document.querySelector('#my-id'); el.value;\` (not an expression)

## Key UI selectors
| Element          | Selector                                                |
|------------------|---------------------------------------------------------|
| Dialog           | \`role=dialog\` or \`.dialog\`                              |
| Dialog overlay   | \`[data-testid="dialog-overlay"]\`                        |
| Buttons          | \`text=Create\`, \`text=Cancel\`, \`role=button[name="..."]\` |
| Text fields      | By id: \`#workspace-name\`, \`#initial-prompt\`             |
| Dropdowns        | \`role=combobox\`                                         |
| Dropdown options | \`role=option\` or \`.dropdown-option\`                     |
| Sidebar          | \`nav.sidebar\`                                           |
| Project items    | \`.project-item\`                                         |

## Tips
- \`wait-for <selector>\` after an action instead of polling with \`dom\`
- \`logs --scope git --level info\` filters the app log
- Console errors often reveal the root cause: \`console --level error\`
- \`targets\` lists the UI page and workspace iframes if \`--target workspace\` fails
- The app, its logs, the console log and screenshots all live in ./app-data of this
  worktree; the daemon's own output is ./app-data/appctrl-daemon.log
`;

function firstSentence(text: string): string {
  return text.replace(/\n/g, " ").split(/(?<=\.)\s/)[0]!;
}

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${name.padEnd(width)}  ${firstSentence(command.summary)}`
  );
  return (
    "Usage: pnpm -s appctrl <command> [args]\n\n" +
    "Drive a CodeHydra app for UI debugging. One app per worktree.\n\n" +
    `Commands:\n${lines.join("\n")}\n\n` +
    "Run `pnpm -s appctrl <command> --help` for a command's flags, `guide` for the full guide."
  );
}

function commandHelp(command: CliCommand): string {
  const targeted = command.options !== undefined && "target" in command.options;
  return (
    `Usage: pnpm -s appctrl ${command.usage}\n\n${command.summary}` +
    (targeted ? `\n\n${TARGET_HELP}` : "")
  );
}

/** Exit codes: 0 ok, 1 failed, 2 usage. */
async function runCli(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === "__daemon") {
    runDaemon();
    return -1;
  }
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(usage() + "\n");
    return name === undefined ? 2 : 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`appctrl: unknown command "${name}"\n\n${usage()}\n`);
    return 2;
  }

  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
    if (values["help"] === true) {
      process.stdout.write(commandHelp(command) + "\n");
      return 0;
    }
    const output = await command.run({ values: values as OptionValues, positionals });
    if (output !== undefined) process.stdout.write(output.endsWith("\n") ? output : output + "\n");
    return 0;
  } catch (err) {
    const usageFailure =
      err instanceof UsageError ||
      (err instanceof Error && (err as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS"));
    process.stderr.write(`appctrl ${name}: ${asMessage(err)}\n`);
    if (usageFailure) process.stderr.write(`\n${commandHelp(command)}\n`);
    return usageFailure ? 2 : 1;
  }
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Only run the CLI when this file is *executed*. When it is imported (by the
 * e2e suite), nothing here runs — in particular no process-level signal
 * handlers, which would otherwise hijack the lifecycle of whatever test runner
 * is hosting us.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2));
  // The daemon keeps running on its server; everything else is done.
  if (code >= 0) process.exit(code);
}
