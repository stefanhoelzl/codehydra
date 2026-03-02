/**
 * AppCtrl — MCP server for controlling a running CodeHydra instance.
 *
 * Provides AI agents with tools to launch, screenshot, interact with,
 * and inspect a CodeHydra Electron app via Playwright.
 *
 * Architecture: Playwright Electron
 * - _electron.launch() manages process lifecycle, page access, and dialog mocking
 * - electronApp.context().pages() exposes all views (UI + WebContentsViews)
 *
 * Usage:
 *   Registered in .mcp.json — agents get the tools automatically.
 *   Manual: npx tsx scripts/appctrl.ts (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { _electron, type Page, type ElectronApplication } from "playwright";
import { readFile, readdir, stat, access } from "node:fs/promises";
import { join } from "node:path";

// =============================================================================
// State
// =============================================================================

let electronApp: ElectronApplication | null = null;

interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
  source: string;
}

const consoleBuffer: ConsoleEntry[] = [];
const MAX_CONSOLE = 500;

const LOG_LEVELS = ["silly", "debug", "info", "warn", "error"] as const;

interface LogEntry {
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

// =============================================================================
// Helpers
// =============================================================================

function requireRunning(): void {
  if (!electronApp) {
    throw new Error("App not started. Call appctrl_start first.");
  }
}

/** Graceful async cleanup — for normal stop (appctrl_stop tool). */
async function killAppAsync(): Promise<void> {
  if (electronApp) {
    await electronApp.close().catch(() => {});
    electronApp = null;
  }
  consoleBuffer.length = 0;
}

/** Sync cleanup — for signal handlers (SIGINT, SIGTERM, exit, uncaughtException). */
function killAppSync(): void {
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

async function findPage(target: string = "workspace"): Promise<Page> {
  requireRunning();
  const pages = electronApp!.context().pages();

  if (target === "ui") {
    const page = pages.find((p) => p.url().startsWith("file://"));
    if (!page) throw new Error("UI view not found");
    return page;
  }

  if (target === "workspace") {
    const workspaces = pages.filter(
      (p) =>
        p.url().includes("127.0.0.1") &&
        (p.url().includes("folder=") || p.url().includes("workspace="))
    );
    if (workspaces.length === 0) throw new Error("No workspace views found");
    // Prefer focused page
    for (const p of workspaces) {
      if (await p.evaluate(() => document.hasFocus())) return p;
    }
    return workspaces[0]!;
  }

  // URL substring match
  const page = pages.find((p) => p.url().includes(target));
  if (!page) throw new Error(`No view matching "${target}"`);
  return page;
}

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

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) ?? "null" }] };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// =============================================================================
// Server
// =============================================================================

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
      "CODE-SERVER: Workspace views run code-server, NOT VS Code extensions. " +
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
      flags: z
        .string()
        .optional()
        .describe(
          'Additional CLI flags for CodeHydra, e.g. "--log.output=file,console". ' +
            "Do NOT set log.level, log.format, or log.output — appctrl manages these."
        ),
    }),
  },
  async ({ headless = true, flags }) => {
    if (electronApp) {
      return errorResult(`App already running (PID ${electronApp.process().pid})`);
    }

    const cwd = process.cwd();

    // Verify build exists
    try {
      await access(join(cwd, "out/main/index.cjs"));
    } catch {
      return errorResult("Build not found at out/main/index.cjs. Run `pnpm build` first.");
    }

    // App flags go AFTER "." — processed by CodeHydra's config system.
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
      // Pass "." (project root) so app.getAppPath() returns the project root,
      // not out/main/ which would break asset path resolution.
      electronApp = await _electron.launch({
        executablePath: join(cwd, "node_modules/electron/dist/electron"),
        args: [".", ...appFlags],
        env: { ...process.env } as Record<string, string>,
        timeout: 60_000,
      });

      // Set default timeout and subscribe console for all views
      electronApp.context().setDefaultTimeout(2_000);
      for (const page of electronApp.context().pages()) {
        subscribePageConsole(page);
      }
      // Subscribe to new pages (WebContentsViews created after launch)
      electronApp.context().on("page", (page) => {
        subscribePageConsole(page);
      });
    } catch (err) {
      await killAppAsync();
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to start: ${message}`);
    }

    return textResult({ pid: electronApp.process().pid, headless });
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
    if (!electronApp) {
      return textResult({ stopped: false, reason: "App not running" });
    }

    await killAppAsync();
    return textResult({ stopped: true });
  }
);

// ── appctrl_screenshot ──────────────────────────────────────────────────

server.registerTool(
  "appctrl_screenshot",
  {
    description:
      "Capture a screenshot of a CodeHydra view. Returns the image directly. " +
      'Target: "ui" for sidebar, "workspace" (default) for active workspace, or a URL substring to match a specific view.',
    inputSchema: z.object({
      target: z
        .string()
        .optional()
        .describe('View to capture: "ui", "workspace" (default), or URL substring'),
    }),
  },
  async ({ target }) => {
    try {
      requireRunning();
      const page = await findPage(target);
      const buffer = await page.screenshot({ type: "png" });
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
      target: z.string().optional().describe('View: "ui", "workspace" (default), or URL substring'),
    }),
  },
  async ({ selector = "body", target }) => {
    try {
      requireRunning();
      const page = await findPage(target);
      const snapshot = await page.locator(selector).ariaSnapshot();
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
      requireRunning();
      const page = await findPage(target);
      await page.click(selector);
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
      target: z.string().optional().describe('View: "ui", "workspace" (default), or URL substring'),
    }),
  },
  async ({ text, selector, target }) => {
    try {
      requireRunning();
      const page = await findPage(target);
      if (selector) {
        await page.fill(selector, text);
      } else {
        await page.keyboard.type(text);
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
      "unlike dispatchEvent(new KeyboardEvent(...)) which does NOT work in code-server. " +
      "Key format: 'Enter', 'Escape', 'Tab', 'Control+p', 'Control+Shift+p', 'ArrowDown'. " +
      "Use this for code-server shortcuts (Ctrl+P for Quick Open, Ctrl+Shift+P for Command Palette).",
    inputSchema: z.object({
      key: z
        .string()
        .describe(
          "Key or combo to press: 'Enter', 'Escape', 'Control+p', 'Control+Shift+p', 'ArrowDown'"
        ),
      target: z.string().optional().describe('View: "ui", "workspace" (default), or URL substring'),
    }),
  },
  async ({ key, target }) => {
    try {
      requireRunning();
      const page = await findPage(target);
      await page.keyboard.press(key);
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
      "The UI view runs Svelte, workspace views run code-server. " +
      "Examples: " +
      "'document.querySelector(\".dialog\")?.textContent' " +
      "'document.querySelectorAll(\"vscode-button\").length' " +
      "'(() => { const el = document.querySelector(\"#my-id\"); return el?.value; })()'",
    inputSchema: z.object({
      code: z.string().describe("JavaScript code to evaluate in the view's renderer process"),
      target: z.string().optional().describe('View: "ui", "workspace" (default), or URL substring'),
    }),
  },
  async ({ code, target }) => {
    try {
      requireRunning();
      const page = await findPage(target);
      const result = await page.evaluate(code);
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
      if (!electronApp) {
        throw new Error("App not started. Call appctrl_start first.");
      }
      await electronApp.evaluate(({ dialog }, p) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: p });
      }, paths);
      return textResult({ mocked: true, paths });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
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
    let messages = [...consoleBuffer];
    if (level) {
      messages = messages.filter((m) => m.level === level);
    }
    if (clear) {
      consoleBuffer.length = 0;
    }
    return textResult(messages);
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
      const logsDir = join(process.cwd(), "app-data", "logs");
      const files = await readdir(logsDir).catch(() => [] as string[]);
      const logFiles = files.filter((f) => f.endsWith(".log"));

      if (logFiles.length === 0) {
        return errorResult("No log files found in " + logsDir);
      }

      // Find most recent by mtime
      const withStats = await Promise.all(
        logFiles.map(async (f) => ({
          name: f,
          mtime: (await stat(join(logsDir, f))).mtimeMs,
        }))
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

      // Filter
      let filtered = entries;
      if (scope) {
        filtered = filtered.filter((e) => e.scope === scope);
      }
      if (level) {
        const minPriority = LOG_LEVELS.indexOf(level as (typeof LOG_LEVELS)[number]);
        if (minPriority >= 0) {
          filtered = filtered.filter(
            (e) => LOG_LEVELS.indexOf(e.level as (typeof LOG_LEVELS)[number]) >= minPriority
          );
        }
      }

      // Order and limit
      if (order === "desc") {
        filtered.reverse();
      }
      const result = filtered.slice(0, limit);
      const formatted = result.map(formatLogEntry).join("\n");
      const header = `${result.length} of ${filtered.length} entries (file: ${latest.name})`;

      return { content: [{ type: "text" as const, text: `${header}\n\n${formatted}` }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

// ── appctrl_targets ─────────────────────────────────────────────────────

server.registerTool(
  "appctrl_targets",
  {
    description:
      "List all CDP targets (views) in the running CodeHydra instance. " +
      'UI view has a file:// URL, workspace views have code-server URLs with "folder=" or "workspace=" parameter.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      requireRunning();
      const pages = electronApp!.context().pages();
      const targets = pages.map((p) => ({
        url: p.url(),
        title: p.url().startsWith("file://")
          ? "UI (sidebar)"
          : p.url().includes("folder=") || p.url().includes("workspace=")
            ? "Workspace"
            : "Other",
      }));
      return textResult(targets);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
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
          "Each WebContentsView is a separate CDP target:",
          '- **UI (sidebar)**: `file://` URL — the Svelte app (target: "ui")',
          '- **Workspace**: `http://127.0.0.1:{port}/?workspace=...` — code-server (target: "workspace")',
          "- Only previously-visited workspaces have their URLs loaded",
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
          "- `acquireVsCodeApi` is NOT available — this is code-server, not a VS Code extension",
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
          '- Use `appctrl_targets` to see all views if "workspace" target fails',
        ].join("\n"),
      },
    ],
  })
);

// =============================================================================
// Startup
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGTERM", () => {
  killAppSync();
  process.exit(0);
});

process.on("SIGINT", () => {
  killAppSync();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`appctrl crashed: ${err.stack ?? err.message}\n`);
  killAppSync();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`appctrl unhandled rejection: ${msg}\n`);
  killAppSync();
  process.exit(1);
});

process.on("exit", () => {
  killAppSync();
});
