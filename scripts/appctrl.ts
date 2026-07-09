/**
 * AppCtrl — a Playwright driver for a CodeHydra Electron app, in two guises.
 *
 * Executed (`npx tsx scripts/appctrl.ts`), it is an MCP server: agents get
 * appctrl_* tools for launching, screenshotting, and inspecting a running app.
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
 *
 * Usage:
 *   MCP:  registered in .mcp.json — agents get the tools automatically.
 *   Lib:  import { createDriver } from "../scripts/appctrl";
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { _electron, type Frame, type Page, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repo root — this file lives in <root>/scripts/. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The Electron binary used for unpackaged (dev) launches. */
export const DEV_ELECTRON = join(REPO_ROOT, "node_modules/electron/dist/electron");

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

/**
 * Every descendant pid of `root`, deepest last. Captured *before* the parent dies —
 * once it exits, the children are reparented and the tree is unrecoverable.
 *
 * Windows is excluded: `taskkill /T` walks the tree itself.
 */
function descendantPids(root: number): number[] {
  if (process.platform === "win32") return [];

  let listing: string;
  try {
    listing = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf-8" });
  } catch {
    return [];
  }

  const childrenOf = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = childrenOf.get(ppid) ?? [];
    siblings.push(pid);
    childrenOf.set(ppid, siblings);
  }

  const found: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/**
 * Kill the app's leftovers. Quitting CodeHydra does not reap its VSCodium reh-web
 * server, and that orphan holds the Electron process's inherited stdio pipes open —
 * which is enough to keep a Playwright worker (or an MCP server) from ever exiting.
 */
function killTree(rootPid: number, descendants: number[]): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  for (const pid of [...descendants, rootPid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
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
   */
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Launch timeout (ms). Default 60_000. */
  timeout?: number;
  /** Default timeout for Playwright actions (ms). Default 2_000. */
  actionTimeout?: number;
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

export type AppDriver = ReturnType<typeof createDriver>;

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

  function subscribePageConsole(page: Page): void {
    page.on("console", (msg) => {
      consoleBuffer.push({
        level: msg.type(),
        text: msg.text(),
        ts: Date.now(),
        source: page.url(),
      });
      if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
    });
  }

  /** The running app, or throw. */
  function electron(): ElectronApplication {
    if (!electronApp) throw new Error("App not started. Call appctrl_start first.");
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
        args: [...(appPath !== null ? [appPath] : []), ...args],
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
   * SIGKILL remains the backstop if the app declines to leave.
   */
  async function stop(): Promise<void> {
    if (electronApp) {
      const app = electronApp;
      electronApp = null;
      const proc = app.process();
      const appPid = proc.pid!;

      // Snapshot the tree while the parent still owns it.
      const descendants = descendantPids(appPid);

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

      killTree(appPid, descendants);

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

  /** Read + filter the most recent JSONL log file. Returns formatted lines plus a header. */
  async function readLogs(options: ReadLogsOptions = {}): Promise<string> {
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
// MCP tool-result helpers
// =============================================================================

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) ?? "null" }] };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// MCP server (only constructed when this file is executed, not imported)
// =============================================================================

/**
 * Build the MCP server over a driver. The tool bodies are the driver's API with
 * JSON-shaped results wrapped around them — no behavior lives here.
 *
 * The SDK is imported statically (the repo bans inline dynamic import), but nothing
 * here runs on import: the server is only constructed, and the transport only
 * connected, behind the isMainModule() guard at the bottom of this file.
 */
function createServer(driver: AppDriver): McpServer {
  // Methods are closures, not `this`-bound, so destructuring is safe.
  const { findTarget, focusTargetFrame } = driver;

  const server = new McpServer(
    { name: "appctrl", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "AppCtrl controls a running CodeHydra instance for UI debugging. " +
        "IMPORTANT: CodeHydra uses shadow DOM web components — always use appctrl_dom " +
        "to inspect the accessibility tree before interacting. Use role= or text= selectors, " +
        "not CSS selectors for web components.\n\n" +
        "SIDEBAR: The sidebar is collapsed (20px) in headless mode. " +
        "BEFORE clicking any sidebar button, expand it with appctrl_evaluate:\n" +
        '  target: "ui", code: "(() => { document.querySelector(\'nav.sidebar\')' +
        "?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); " +
        "return 'expanded'; })()\"\n\n" +
        "IDE SERVER: Workspaces are VSCodium iframes inside the single UI view, NOT VS Code extensions. " +
        "acquireVsCodeApi is NOT available. dispatchEvent(new KeyboardEvent(...)) does NOT work. " +
        "Use appctrl_key for shortcuts (Control+p, Control+Shift+p, Enter, Escape) " +
        "and appctrl_type for text input.\n\n" +
        "PROJECTS: Do NOT open the user's real projects. Create a temporary git repo, " +
        "then use appctrl_dialog to mock the folder picker before clicking Open Project in the UI.",
    }
  );

  // =============================================================================
  // Tools
  // =============================================================================

  // ── appctrl_start ───────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_start",
    {
      description:
        "Launch CodeHydra with CDP enabled. " +
        "The app runs headless via Electron flags by default. " +
        "Use the flags parameter to pass additional CLI flags like --log.level=debug. " +
        "Requires `pnpm build` to be run first (the app is launched from `out/main/index.js`).",
      inputSchema: z.object({
        headless: z
          .boolean()
          .optional()
          .describe("Run headless via --ozone-platform=headless. Default: true"),
        packaged: z
          .string()
          .optional()
          .describe(
            "Path to a packaged CodeHydra binary to launch instead of the dev build " +
              "(e.g. dist/win-unpacked/CodeHydra.exe). Use to reproduce a CI failure locally."
          ),
        flags: z
          .string()
          .optional()
          .describe(
            'Additional CLI flags for CodeHydra, e.g. "--log.output=file,console". ' +
              "Do NOT set log.level, log.format, or log.output — appctrl manages these."
          ),
      }),
    },
    async ({ headless = true, packaged, flags }) => {
      // App flags go after the app path — processed by CodeHydra's config system.
      // Headless flags are applied via --electron.flags which the app reads
      // and applies via app.commandLine.appendSwitch() before app.whenReady().
      const appFlags: string[] = ["--log.format=json", "--log.level=silly"];
      if (headless) {
        appFlags.push("--electron.flags=--ozone-platform=headless --disable-gpu");
      }
      if (flags) {
        appFlags.push(...flags.split(/\s+/));
      }

      try {
        // A packaged build resolves its own app path; the dev build takes the repo root
        // so app.getAppPath() isn't out/main/ (which would break asset resolution).
        const { pid } = await driver.launch({
          ...(packaged !== undefined && { executablePath: packaged, appPath: null }),
          args: appFlags,
        });
        return textResult({ pid, headless, packaged: packaged ?? null });
      } catch (err) {
        return errorResult(`Failed to start: ${asMessage(err)}`);
      }
    }
  );

  // ── appctrl_stop ────────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_stop",
    {
      description: "Stop the running CodeHydra instance and disconnect Playwright.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!driver.isRunning()) {
        return textResult({ stopped: false, reason: "App not running" });
      }

      await driver.stop();
      return textResult({ stopped: true });
    }
  );

  // ── appctrl_screenshot ──────────────────────────────────────────────────

  server.registerTool(
    "appctrl_screenshot",
    {
      description:
        "Capture a screenshot of a CodeHydra view. Returns the image directly. " +
        'Target: "ui" for the whole window (sidebar + active workspace), ' +
        '"workspace" (default) for just the active workspace iframe, ' +
        "or a URL substring to match a specific frame.",
      inputSchema: z.object({
        target: z
          .string()
          .optional()
          .describe('View to capture: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ target }) => {
      try {
        const resolved = await findTarget(target);
        let buffer: Buffer;
        if (resolved.isWorkspaceFrame) {
          // Screenshot the <iframe> element from the host page (clips the page
          // capture to the frame's box — frames have no direct screenshot API).
          const el = await resolved.frame.frameElement();
          buffer = await el.screenshot({ type: "png" });
          await el.dispose();
        } else {
          buffer = await resolved.page.screenshot({ type: "png" });
        }
        const base64 = buffer.toString("base64");
        return {
          content: [{ type: "image" as const, data: base64, mimeType: "image/png" as const }],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_dom ─────────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_dom",
    {
      description:
        "Get the accessibility tree of a CodeHydra view as YAML. " +
        "Shows roles, names, and structure — use this to find the right selectors " +
        "before clicking or typing. Output maps directly to Playwright selectors " +
        "(e.g. a line '- button \"Create\"' means you can use selector 'role=button[name=\"Create\"]')." +
        "Use the selector parameter to scope to a subtree (e.g. '.dialog' to inspect only the dialog).",
      inputSchema: z.object({
        selector: z
          .string()
          .optional()
          .describe("CSS selector to scope the tree (e.g. '.dialog', 'body'). Default: 'body'"),
        target: z
          .string()
          .optional()
          .describe('View: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ selector = "body", target }) => {
      try {
        const { frame } = await findTarget(target);
        const snapshot = await frame.locator(selector).ariaSnapshot();
        return { content: [{ type: "text" as const, text: snapshot }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_click ───────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_click",
    {
      description:
        "Click an element in a CodeHydra view. " +
        "Accepts a CSS selector or Playwright selector (e.g. 'text=New Workspace', '.my-class', '#my-id'). " +
        "IMPORTANT: CodeHydra uses @vscode-elements web components (vscode-button, vscode-textfield, etc.) " +
        "which have shadow DOM. Standard selectors won't find their inner elements. " +
        'Prefer ARIA selectors: role=button[name="Create"], role=combobox, or text= selectors. ' +
        "Use appctrl_dom first to discover available selectors.",
      inputSchema: z.object({
        selector: z
          .string()
          .describe("CSS selector or Playwright selector (e.g. 'text=Submit', '.btn-primary')"),
        target: z
          .string()
          .optional()
          .describe('View to interact with: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ selector, target }) => {
      try {
        const { frame } = await findTarget(target);
        await frame.click(selector);
        return textResult({ clicked: selector });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_type ────────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_type",
    {
      description:
        "Type text into an element or the focused element. " +
        "If selector is provided, fills that element. Otherwise types into whatever is focused. " +
        "IMPORTANT: vscode-textfield and other @vscode-elements use shadow DOM — " +
        "the fill selector may not reach the inner <input>. " +
        "Prefer omitting the selector and typing into the already-focused element, " +
        "or use appctrl_evaluate to set values via JavaScript (e.g. el.value = '...').",
      inputSchema: z.object({
        text: z.string().describe("Text to type"),
        selector: z
          .string()
          .optional()
          .describe("CSS/Playwright selector to fill. If omitted, types into focused element."),
        target: z
          .string()
          .optional()
          .describe('View: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ text, selector, target }) => {
      try {
        const resolved = await findTarget(target);
        if (selector) {
          await resolved.frame.fill(selector, text);
        } else {
          // Keyboard input is page-level; route it into workspace frames.
          await focusTargetFrame(resolved);
          await resolved.page.keyboard.type(text);
        }
        return textResult({ typed: text });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_key ────────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_key",
    {
      description:
        "Press a keyboard shortcut or key in a CodeHydra view. " +
        "Uses Playwright's keyboard.press() which sends trusted CDP events — " +
        "unlike dispatchEvent(new KeyboardEvent(...)) which does NOT work in the IDE server. " +
        "Key format: 'Enter', 'Escape', 'Tab', 'Control+p', 'Control+Shift+p', 'ArrowDown'. " +
        "Use this for IDE-server shortcuts (Ctrl+P for Quick Open, Ctrl+Shift+P for Command Palette).",
      inputSchema: z.object({
        key: z
          .string()
          .describe(
            "Key or combo to press: 'Enter', 'Escape', 'Control+p', 'Control+Shift+p', 'ArrowDown'"
          ),
        target: z
          .string()
          .optional()
          .describe('View: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ key, target }) => {
      try {
        const resolved = await findTarget(target);
        // Keyboard input is page-level; route it into workspace frames.
        await focusTargetFrame(resolved);
        await resolved.page.keyboard.press(key);
        return textResult({ pressed: key });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_evaluate ────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_evaluate",
    {
      description:
        "Execute JavaScript in a CodeHydra view and return the result. " +
        "Best for reading state and inspecting the DOM — for clicking and typing, " +
        "prefer appctrl_click/appctrl_type with role= or text= selectors from appctrl_dom. " +
        "The code runs in the view's renderer process. " +
        "IMPORTANT: Your code MUST return a value — wrap in an IIFE or use an expression. " +
        "If nothing is returned, the result will be null. " +
        "NEVER use bare `return` statements — they cause SyntaxError. " +
        "Use an IIFE: (() => { ...; return result; })(). " +
        "NOTE: acquireVsCodeApi and VS Code extension APIs are NOT available. " +
        "The UI view runs Svelte, workspace views run VSCodium. " +
        "Examples: " +
        "'document.querySelector(\".dialog\")?.textContent' " +
        "'document.querySelectorAll(\"vscode-button\").length' " +
        "'(() => { const el = document.querySelector(\"#my-id\"); return el?.value; })()'",
      inputSchema: z.object({
        code: z.string().describe("JavaScript code to evaluate in the view's renderer process"),
        target: z
          .string()
          .optional()
          .describe('View: "ui", "workspace" (default), or URL substring'),
      }),
    },
    async ({ code, target }) => {
      try {
        const { frame } = await findTarget(target);
        const result = await frame.evaluate(code);
        return textResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── appctrl_dialog ──────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_dialog",
    {
      description:
        "Mock Electron's folder picker dialog to auto-return specified paths. " +
        "Call BEFORE triggering any action that opens a folder picker (e.g., Open Project). " +
        "The mock replaces dialog.showOpenDialog() — it will auto-return the specified paths " +
        "instead of showing the native OS dialog. Call again to update the mock paths.",
      inputSchema: z.object({
        paths: z.array(z.string()).describe("Folder paths the dialog should return"),
      }),
    },
    async ({ paths }) => {
      try {
        await driver.mockDialog(paths);
        return textResult({ mocked: true, paths });
      } catch (err) {
        return errorResult(asMessage(err));
      }
    }
  );

  // ── appctrl_resume ──────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_resume",
    {
      description:
        "Simulate a system wake by emitting Electron's powerMonitor 'resume' event " +
        "in the main process. This drives the same code path as waking the machine " +
        "from sleep (dispatches the app:resume intent). Use to test resume handling " +
        "without actually suspending the host.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await driver.resume();
        return textResult({ resumed: true });
      } catch (err) {
        return errorResult(asMessage(err));
      }
    }
  );

  // ── appctrl_console ─────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_console",
    {
      description:
        "Get buffered console messages from all views. " +
        "Captures console.log/warn/error/info/debug from renderer processes since app start. " +
        "Buffer holds the last 500 messages.",
      inputSchema: z.object({
        level: z
          .string()
          .optional()
          .describe('Filter by level: "error", "warning", "log", "info", "debug"'),
        clear: z.boolean().optional().describe("Clear the buffer after reading. Default: false"),
      }),
    },
    async ({ level, clear }) => {
      return textResult(
        driver.consoleMessages({
          ...(level !== undefined && { level }),
          ...(clear !== undefined && { clear }),
        })
      );
    }
  );

  // ── appctrl_logs ──────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_logs",
    {
      description:
        "Read and filter structured JSONL logs from the most recent CodeHydra session. " +
        "Log files are at ./app-data/logs/ in dev mode. " +
        "Supports filtering by scope (exact match) and minimum level " +
        "(silly < debug < info < warn < error). Returns formatted, human-readable log lines.",
      inputSchema: z.object({
        scope: z
          .string()
          .optional()
          .describe('Filter by logger scope (exact match, e.g. "git", "fs", "dispatcher", "app")'),
        level: z
          .string()
          .optional()
          .describe(
            "Minimum log level to include. Hierarchy: silly < debug < info < warn < error. " +
              'E.g. level="info" returns info, warn, and error entries.'
          ),
        limit: z.number().optional().describe("Maximum number of entries to return. Default: 50"),
        order: z
          .enum(["asc", "desc"])
          .optional()
          .describe('Sort order: "asc" (oldest first) or "desc" (newest first). Default: "desc"'),
      }),
    },
    async ({ scope, level = "debug", limit = 50, order = "desc" }) => {
      try {
        const text = await driver.readLogs({
          ...(scope !== undefined && { scope }),
          level,
          limit,
          order,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorResult(asMessage(err));
      }
    }
  );

  // ── appctrl_targets ─────────────────────────────────────────────────────

  server.registerTool(
    "appctrl_targets",
    {
      description:
        "List the UI view and all workspace iframes in the running CodeHydra instance. " +
        "The UI is the single page (file:// URL); workspaces are VSCodium iframes " +
        'inside it (URLs with "folder=" or "workspace=" parameter; `active` marks the visible one).',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(await driver.targets());
      } catch (err) {
        return errorResult(asMessage(err));
      }
    }
  );

  // =============================================================================
  // Resource
  // =============================================================================

  server.registerResource(
    "guide",
    "appctrl://guide",
    {
      title: "AppCtrl Debugging Guide",
      description: "Detailed guide for debugging CodeHydra with AppCtrl tools",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: [
            "# AppCtrl Debugging Guide",
            "",
            "## Views",
            "The app has a single WebContentsView (the UI page); workspaces are",
            "VSCodium iframes inside it, addressed as Playwright Frames:",
            '- **UI**: `file://` URL — the Svelte app, hosts everything (target: "ui")',
            '- **Workspace**: `http://127.0.0.1:{port}/?workspace=...` — a VSCodium iframe (target: "workspace" = the visible one)',
            "- All non-hibernated workspaces have mounted iframes; only the active one is visible",
            '- `appctrl_screenshot target="ui"` captures the whole window; target="workspace" clips to the active iframe',
            "",
            "## Typical Workflow",
            "1. `appctrl_start` — launches app (headless by default). Requires `pnpm build` first.",
            "2. `appctrl_screenshot` — see what's on screen",
            "3. `appctrl_dom` — inspect the accessibility tree to find selectors",
            "4. Interact with `appctrl_click` / `appctrl_type` using selectors from the tree",
            "5. Investigate issues with evaluate/console/logs",
            "6. Make code changes, `appctrl_stop` + `pnpm build` + `appctrl_start` to restart",
            "7. `appctrl_stop` when done",
            "",
            "## Shadow DOM — Critical for UI Interaction",
            "CodeHydra uses `@vscode-elements` web components for form controls:",
            "`vscode-button`, `vscode-textfield`, `vscode-checkbox`, `vscode-single-select`, etc.",
            "",
            "These have **shadow DOM** — standard CSS selectors and Playwright selectors",
            "CANNOT reach their internal elements. For example:",
            '- `vscode-textfield[placeholder="..."]` — WILL NOT WORK (shadow boundary)',
            '- `button:has-text("Create")` — WILL NOT WORK (inner <button> is in shadow DOM)',
            "",
            "### What Works",
            "1. **ARIA/role selectors** (pierce shadow DOM automatically):",
            '   - `role=button[name="Create"]`',
            "   - `role=combobox`",
            "   - `role=dialog`",
            "2. **Text selectors**: `text=Create`, `text=Cancel`",
            "3. **Class selectors on wrapper elements**: `.dialog`, `.sidebar`, `.dropdown-option`",
            "4. **appctrl_evaluate** as fallback for anything complex",
            "",
            "### Recommended Strategy",
            "1. `appctrl_screenshot` first — see the current state",
            "2. `appctrl_dom` — get the accessibility tree to find correct selectors",
            "3. Use `appctrl_click` with `role=` or `text=` selectors from the tree",
            "4. Use `appctrl_type` WITHOUT a selector (type into focused element) for text input",
            "5. Use `appctrl_evaluate` as fallback for complex interactions or when selectors fail",
            "",
            "## Sidebar Behavior",
            "The sidebar is 20px when collapsed (overflow clipped). It expands to 250px on hover.",
            "In headless mode, the sidebar stays collapsed since there's no mouse cursor.",
            "",
            "Expand before clicking sidebar buttons:",
            "```",
            "appctrl_evaluate({ target: \"ui\", code: \"(() => { document.querySelector('nav.sidebar')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); return 'expanded'; })()\" })",
            "```",
            "",
            "Collapse after interaction:",
            "```",
            "appctrl_evaluate({ target: \"ui\", code: \"(() => { document.querySelector('nav.sidebar')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: 100 })); return 'collapsed'; })()\" })",
            "```",
            "",
            "## Opening a Project",
            "1. Create a temp git repo: `git init /tmp/appctrl-test && cd /tmp/appctrl-test && git commit --allow-empty -m init`",
            '2. Mock the folder picker: `appctrl_dialog({ paths: ["/tmp/appctrl-test"] })`',
            "3. Click the Open Project button in the sidebar UI",
            "4. The dialog mock auto-returns the path — no native dialog appears",
            "",
            "IMPORTANT: Never open the user's real projects. Always create and use temporary git repos.",
            "",
            "## Code-Server (Workspace) Views",
            "- `acquireVsCodeApi` is NOT available — this is the IDE server, not a VS Code extension",
            "- `document.dispatchEvent(new KeyboardEvent(...))` does NOT work — these are untrusted events",
            "- Use Playwright keyboard instead: `appctrl_type` for text, `appctrl_key` for shortcuts",
            "- Ctrl+P (Quick Open), Ctrl+Shift+P (Command Palette) work via `appctrl_key`",
            "- To open a file: appctrl_key Ctrl+P → appctrl_type filename → appctrl_key Enter",
            "",
            "## Using appctrl_evaluate",
            "The code parameter runs in the browser. You MUST return a value.",
            "NEVER use bare `return` — it causes SyntaxError. Use an IIFE instead.",
            "",
            "**Good**: `(() => { const el = document.querySelector('#my-id'); return el?.value; })()`",
            "**Good**: `document.querySelector('.dialog')?.textContent ?? 'not found'`",
            "**Bad**: `return document.querySelector('#my-id').value` (bare return = SyntaxError!)",
            "**Bad**: `const el = document.querySelector('#my-id'); el.value;` (no return!)",
            "",
            "## Key UI Selectors",
            "| Element | Selector |",
            "|---------|----------|",
            "| Dialog | `role=dialog` or `.dialog` |",
            '| Dialog overlay | `[data-testid="dialog-overlay"]` |',
            '| Buttons | `text=Create`, `text=Cancel`, `role=button[name="..."]` |',
            "| Text fields | By label: `#workspace-name`, `#initial-prompt` |",
            "| Dropdowns | `role=combobox` |",
            "| Dropdown options | `role=option` or `.dropdown-option` |",
            "| Sidebar | `nav.sidebar` |",
            "| Project items | `.project-item` |",
            "",
            "## Tips",
            '- Use `appctrl_logs({ scope: "git", level: "info" })` to filter app logs',
            '- Use `appctrl_evaluate({ target: "ui", code: "..." })` to inspect sidebar state',
            "- Console errors often reveal the root cause",
            '- Use `appctrl_targets` to see the UI page + workspace iframes if "workspace" target fails',
          ].join("\n"),
        },
      ],
    })
  );

  return server;
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Only start the MCP server when this file is *executed*. When it is imported
 * (by the e2e suite), nothing here runs: no stdio transport, and — importantly —
 * no process-level signal handlers, which would otherwise hijack the lifecycle of
 * whatever test runner is hosting us.
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
  const driver = createDriver();
  const server = createServer(driver);

  await server.connect(new StdioServerTransport());

  process.on("SIGTERM", () => {
    driver.killSync();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    driver.killSync();
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`appctrl crashed: ${err.stack ?? err.message}\n`);
    driver.killSync();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`appctrl unhandled rejection: ${msg}\n`);
    driver.killSync();
    process.exit(1);
  });

  process.on("exit", () => {
    driver.killSync();
  });
}
