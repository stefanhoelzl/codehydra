/**
 * record-demo — drive a real CodeHydra app and screen-record the landing-page demo.
 *
 *   pnpm demo:record   (i.e. `node scripts/record-demo.ts`)
 *
 * Must run under bare `node`, NOT tsx: tsx's esbuild transform injects a `__name`
 * helper into functions, and those functions are serialized into the Electron /
 * page context by Playwright's evaluate() — where `__name` does not exist. Bare
 * node needs explicit .ts extensions on relative imports, hence the extensions
 * here and in e2e/fixtures.ts (both tsconfigs set allowImportingTsExtensions).
 *
 * It scaffolds a throwaway repo, launches the app under a headless Xvfb at 2x,
 * drives the whole story (orchestrator → fleet → hibernate → clone a second
 * project → previews + notifications → keep one, close the rest), records the
 * screen with ffmpeg x11grab, and cuts the dead time out of the result.
 *
 * The recording is Linux-only by design (x11grab). It never touches your real
 * CodeHydra data dir or your ~/.claude — it seeds an isolated root and an isolated
 * CLAUDE_CONFIG_DIR, so the video shows no personal account details.
 */
// MUST stay first: importing this sets _CH_ROOT_DIR / CLAUDE_CONFIG_DIR / DISPLAY
// as a side effect, and e2e/fixtures.ts (below) transitively evaluates e2e/env.ts,
// which reads them at module-eval time. ESM evaluates in import order.
import { APP_ROOT, CLAUDE_CONFIG_DIR, DISPLAY } from "./demo-env.ts";
import { createDriver, type AppDriver } from "./appctrl.ts";
import * as fixtures from "../e2e/fixtures.ts";
import { expect, type Frame, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Tunables ────────────────────────────────────────────────────────────────
const SCALE = 2;
// The app opens at 1200x800 (window-manager.ts), which is a cramped, zoomed-in
// viewport on camera. Resize to a roomier 16:10 after launch; render at 2x for a
// crisp downscale. Everything (Xvfb, grab, resize, delivery) derives from this.
const LOGICAL = { w: 1600, h: 1000 };
const DEVICE = { w: LOGICAL.w * SCALE, h: LOGICAL.h * SCALE };
const FPS = 30;

// Cut list: a "dead" wait (agent thinking, waiting on a beat) keeps KEEP seconds
// of motion at each end and drops the middle, with a short crossfade over each
// splice so the loop reads as an edit, not a glitch.
// KEEP is per cut END, so every cut contributes 2*KEEP of footage. With a dozen
// cuts that is the difference between a brisk edit and half a minute of frozen
// frames whenever the shot underneath happens to be a finished workspace.
const KEEP = 0.6;
const XFADE = 0.15;

/** Where the app's real bundles (vscodium, bin, claude) live. */
const BUNDLES_SOURCE =
  process.env.CH_DEMO_SOURCE_ROOT ?? join(homedir(), ".local", "share", "codehydra");
const REAL_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");

const OUTPUT = process.env.CH_DEMO_OUTPUT ?? join(REPO_ROOT, "site", "public", "demo.mp4");
/**
 * The landing page's <video poster> (and its no-video <img> fallback). Lifted from
 * the recording itself so it can never drift from the video, and so its aspect
 * ratio matches exactly — a poster of a different shape letterboxes before play.
 */
const POSTER = process.env.CH_DEMO_POSTER ?? join(REPO_ROOT, "site", "public", "screenshot.png");

/** The one workspace the user creates on camera; its agent orchestrates the fleet. */
const ORCHESTRATOR = "orchestrator";

/**
 * A deliberately GENERIC prompt — it never names an MCP tool. The agent infers
 * that "its own separate workspace" means spawn a workspace, "open in the browser
 * preview" means Simple Browser, and "hibernate this workspace" means hibernate.
 * That's the whole point: the CodeHydra integration is seamless, not scripted.
 */
const ORCHESTRATOR_PROMPT =
  "Restyle Nimbus three ways — clean minimal black-and-white, bold colourful gradient, " +
  "and warm retro. One workspace per style, then hibernate.";

/** A small public repo, cloned on camera to show a second (remote) project. */
const CLONE_URL = "sindresorhus/slugify";
/** Typed into the cloned project's workspace while the fleet is still working. */
const EXPLAIN_PROMPT = "Explain what this project does and how it is structured.";

/** The well-known project whose open PR / issue the auto-workspace sources pull. */
const AUTO_REPO = "cli/cli";
/** The two workspaces the sources produce are named with these prefixes. */
const AUTO_MATCH = (name: string): boolean => /^(pr|issue)-/.test(name);

/**
 * Two real auto-workspace sources, typed into settings on camera — the actual
 * use case, not a toy. Each `cmd` runs `gh` to fetch the newest open pull request
 * / issue of a well-known repo as a JSON array; the template renders one
 * workspace per item, cloning the repo (`git`) and handing its agent the task.
 * `gh` (both here and in the agents' own calls) authenticates via the session
 * keyring, which the app inherits — no token handling in the demo.
 *
 * No `focus`: like real background automation, the workspaces appear in the
 * sidebar (tagged `new`) without hijacking the view onto a slow-booting clone.
 */
function autoSourceYaml(): string {
  return [
    "name: pull-requests",
    `cmd: gh pr list --repo ${AUTO_REPO} --state open --limit 1 --json number,title,url`,
    "template:",
    '  name: "pr-{{ number }}"',
    `  git: https://github.com/${AUTO_REPO}.git`,
    `  prompt: "Review PR #{{ number }} of ${AUTO_REPO}: {{ title }} — {{ url }}"`,
    "  metadata:",
    "    tags:",
    '      review: { color: "#f1c40f" }',
    "---",
    "name: issues",
    `cmd: gh issue list --repo ${AUTO_REPO} --state open --limit 1 --json number,title,url`,
    "template:",
    '  name: "issue-{{ number }}"',
    `  git: https://github.com/${AUTO_REPO}.git`,
    `  prompt: "Investigate issue #{{ number }} of ${AUTO_REPO}: {{ title }} — {{ url }}"`,
    "  metadata:",
    "    tags:",
    '      issue: { color: "#e74c3c" }',
  ].join("\n");
}

/**
 * Sent to the winning variant's agent at the end, to keep it and clean up.
 *
 * The scope is spelled out on purpose. With a second project open and an
 * auto-created workspace in the first, "every other workspace" is genuinely
 * ambiguous — an agent that reads it carefully stops to ask which scope it
 * means (deleting a worktree discards its branch), and the recording then waits
 * out its timeout on an unanswered question.
 */
const KEEP_PROMPT =
  "Keep this design. Close all other workspaces in every open project — including " +
  "the hibernated one — without asking which. Their changes can be discarded.";

/** How many style variants the orchestrator is expected to spawn. */
const VARIANT_COUNT = 3;

const FFMPEG = ffmpegPath as unknown as string;

/**
 * Strings that must never appear on camera.
 *
 * The recording runs a REAL agent, so it copies real credentials in — and Claude
 * Code's session banner prints the account behind them ("Welcome back <name>!",
 * "<email>'s Organization"), while the shell prompt prints `user@host`. Both are
 * personal data on a public landing page.
 *
 * Read from the environment at run time and never written anywhere, so this
 * script stays free of personal data even though it guards against it.
 */
const IDENTITY_MARKERS: readonly string[] = ((): string[] => {
  const marks = new Set<string>();
  const user = userInfo().username;
  if (user.length > 2) marks.add(user);
  try {
    const real = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8")) as {
      oauthAccount?: Record<string, unknown>;
    };
    for (const value of Object.values(real.oauthAccount ?? {})) {
      // Names, email and org only — a display string long enough to identify.
      if (typeof value === "string" && value.length > 4 && !value.includes("-")) marks.add(value);
    }
  } catch {
    // No real config to learn from; the username guard still applies.
  }
  return [...marks];
})();

/** Whatever identity is currently legible in a workspace's visible terminal. */
async function visibleIdentity(frame: Frame): Promise<string[]> {
  // Short timeout, deliberately: `:visible` only matches the ACTIVE workspace's
  // terminal, so for any other workspace this locator never resolves and the
  // default action timeout (15s) is paid in full before the catch. Three
  // inactive variants was ~45s of frozen, uncut footage.
  const text = await frame
    .locator(".xterm-screen:visible")
    .first()
    .innerText({ timeout: 1_500 })
    .catch(() => "");
  return IDENTITY_MARKERS.filter((m) => text.includes(m));
}

/** Current Claude Code version, for the onboarding-skip seed (falls back safely). */
const CLAUDE_VERSION = ((): string => {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim().split(/\s+/)[0]!;
  } catch {
    return "99.0.0";
  }
})();

// ── Small utilities ───────────────────────────────────────────────────────────
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  // This IS the script's user-facing output.
  console.log(`[demo] ${msg}`);
}

// ── Seeding ───────────────────────────────────────────────────────────────────
/**
 * Build the isolated app root. Symlink the read-only bundles, copy the small
 * claude bundle, and seed config + a dark VSCodium theme. NEVER symlink
 * electron/: sharing that Chromium profile with a running app deadlocks the
 * storage service (blank workbench, no error).
 */
function seedRoot(): void {
  mkdirSync(APP_ROOT, { recursive: true });

  for (const name of ["vscodium", "bin"]) {
    const link = join(APP_ROOT, name);
    if (!existsSync(link)) {
      const target = join(BUNDLES_SOURCE, name);
      if (!existsSync(target)) throw new Error(`bundle not found: ${target}`);
      symlinkSync(target, link);
    }
  }

  const claudeDest = join(APP_ROOT, "claude");
  if (!existsSync(claudeDest) && existsSync(join(BUNDLES_SOURCE, "claude"))) {
    cpSync(join(BUNDLES_SOURCE, "claude"), claudeDest, { recursive: true });
  }

  writeFileSync(
    join(APP_ROOT, "config.json"),
    JSON.stringify(
      {
        agent: "claude",
        "telemetry.enabled": false,
        silent: true,
        // Note: a background shell now pins the workspace busy unless it is run
        // through the `ch-bg` wrapper (there is no config key for it any more),
        // so the scaffolded CLAUDE.md tells the agents to use it.
      },
      null,
      2
    )
  );

  // Note: the reh-web workbench ignores file-based user settings here, so the
  // dark theme is not seeded on disk. Instead the recording forces
  // prefers-color-scheme: dark at capture time (see emulateMedia below); the
  // sidekick extension's `window.autoDetectColorScheme` default then loads
  // Default Dark+, matching the dark app shell.
}

/**
 * Isolated CLAUDE_CONFIG_DIR: copy real credentials in (an empty dir is "Not
 * logged in"), and force bypassPermissions so no tool call ever prompts — a
 * permission dialog would read as idle. No project .claude/settings.json is
 * written anywhere, which is what keeps the folder-trust dialog from appearing.
 */
function seedClaudeConfig(): void {
  mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  if (!existsSync(REAL_CREDENTIALS)) {
    throw new Error(
      `Claude credentials not found at ${REAL_CREDENTIALS}. Log in with \`claude\` first.`
    );
  }
  cpSync(REAL_CREDENTIALS, join(CLAUDE_CONFIG_DIR, ".credentials.json"));
  writeFileSync(
    join(CLAUDE_CONFIG_DIR, "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2)
  );
  // Pre-seed .claude.json so a fresh config dir does not park the agent on
  // first-run onboarding (theme picker) or the one-time bypassPermissions
  // acknowledgement — either would block the creation prompt and read as idle.
  writeFileSync(
    join(CLAUDE_CONFIG_DIR, ".claude.json"),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        lastOnboardingVersion: CLAUDE_VERSION,
        // The other half of the banner gate: unseen release notes also force the
        // full panel open, independently of onboarding. Mark them seen.
        lastReleaseNotesSeen: CLAUDE_VERSION,
        bypassPermissionsModeAccepted: true,
        numStartups: 10,
        // Trust an ancestor of every worktree so the folder-trust dialog never
        // appears. Claude trusts a folder when it or an ancestor is trusted;
        // the worktrees live under <APP_ROOT>/projects.
        projects: { [APP_ROOT]: { hasTrustDialogAccepted: true } },
      },
      null,
      2
    )
  );
}

/** Wipe per-run state but keep the seeded bundles. Logs too, so the log-tail
 * evidence waits only ever see the current run. */
function cleanRun(): void {
  for (const entry of ["projects", "electron", "logs"]) {
    rmSync(join(APP_ROOT, entry), { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Wait until a line in the app's JSONL logs matches `pred`, or time out.
 *
 * The dispatcher logs every intent (`workspace:set-metadata`, `vscode:command`,
 * `vscode:show-message`), so an agent's MCP call leaves a durable trace here —
 * more stable than scraping the VSCodium DOM. `cleanRun()` clears old logs so a
 * match can only come from this run.
 */
async function waitForLog(pred: (line: string) => boolean, timeoutMs: number): Promise<boolean> {
  const dir = join(APP_ROOT, "logs");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (file === "electron.log" || !file.endsWith(".log")) continue;
        const contents = readFileSync(join(dir, file), "utf-8");
        for (const line of contents.split("\n")) {
          if (line && pred(line)) return true;
        }
      }
    }
    await sleep(1000);
  }
  return false;
}

/** Count log lines matching `pred` across the current run's JSONL logs. */
function countLog(pred: (line: string) => boolean): number {
  const dir = join(APP_ROOT, "logs");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const file of readdirSync(dir)) {
    if (file === "electron.log" || !file.endsWith(".log")) continue;
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      if (line && pred(line)) n++;
    }
  }
  return n;
}

/**
 * Distinct workspace names among the log lines matching `pred`.
 *
 * Counting raw matches conflates "every variant did it once" with "one variant
 * did it three times" — which is exactly how a run where one variant never
 * opened a preview still reported every preview open.
 */
function matchedWorkspaces(pred: (line: string) => boolean): Set<string> {
  const found = new Set<string>();
  const dir = join(APP_ROOT, "logs");
  if (!existsSync(dir)) return found;
  for (const file of readdirSync(dir)) {
    if (file === "electron.log" || !file.endsWith(".log")) continue;
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      if (!line || !pred(line)) continue;
      const name = /"workspace":"[^"]*\/workspaces\/([^"/]+)"/.exec(line)?.[1];
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

/** Wait until `n` *distinct* workspaces have matched `pred`, or time out. */
async function waitForWorkspaceCount(
  pred: (line: string) => boolean,
  n: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (matchedWorkspaces(pred).size >= n) return true;
    await sleep(1000);
  }
  return false;
}

/** Wait until at least `n` log lines match `pred`, or time out. */
async function waitForLogCount(
  pred: (line: string) => boolean,
  n: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countLog(pred) >= n) return true;
    await sleep(1000);
  }
  return false;
}

/** Evidence predicates for the beats (dispatcher / extension log lines). */
const BEAT = {
  hibernate: (l: string): boolean =>
    l.includes('"message":"dispatch"') && l.includes('"intent":"workspace:hibernate"'),
  // Both spellings count: agents reach the preview either through the sidekick
  // API (`simpleBrowser.api.open`, which honours "beside") or through VS Code's
  // own `simpleBrowser.show`. Matching only the latter under-counted every agent
  // that used the API, which is most of them.
  simpleBrowser: (l: string): boolean =>
    l.includes('"Command received"') &&
    (l.includes('"command":"simpleBrowser.show"') ||
      l.includes('"command":"simpleBrowser.api.open"')),
  notification: (l: string): boolean =>
    l.includes('"message":"dispatch"') && l.includes('"intent":"vscode:show-message"'),
};

/**
 * The demo project's workspaces directory, pinned once the orchestrator exists.
 *
 * A second project gets cloned mid-demo, so the counts must be scoped to the
 * Nimbus project — otherwise that project's workspace is mistaken for a variant.
 */
let demoWorkspacesDir: string | null = null;

function pinDemoProject(): void {
  const projects = join(APP_ROOT, "projects");
  if (!existsSync(projects)) return;
  for (const hash of readdirSync(projects)) {
    const wsDir = join(projects, hash, "workspaces");
    if (existsSync(wsDir) && readdirSync(wsDir).includes(ORCHESTRATOR)) {
      demoWorkspacesDir = wsDir;
      return;
    }
  }
}

/** Worktree directory names under a workspaces dir (excluding the .code-workspace files). */
function worktreeDirs(wsDir: string): string[] {
  if (!existsSync(wsDir)) return [];
  return readdirSync(wsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Every workspace worktree in the demo project, the orchestrator included. */
function allWorkspaces(): string[] {
  return demoWorkspacesDir ? worktreeDirs(demoWorkspacesDir) : [];
}

/**
 * Every workspace across ALL projects (demo + the cloned slugify + the gh-cloned
 * cli/cli). The gh auto-workspaces live in their own project, and cleanup must
 * close workspaces in every project — both need a project-wide count, not the
 * demo-scoped one.
 */
function allWorkspacesGlobal(): string[] {
  const root = join(APP_ROOT, "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((hash) => worktreeDirs(join(root, hash, "workspaces")));
}

/** The variant workspaces the orchestrator spawned (everything but itself). */
function discoverChildren(): string[] {
  return allWorkspaces().filter((name) => name !== ORCHESTRATOR);
}

/** Wait until at least `n` child workspaces exist; returns their names. */
async function waitForChildren(n: number, timeoutMs: number): Promise<string[]> {
  const start = Date.now();
  let children = discoverChildren();
  while (children.length < n && Date.now() - start < timeoutMs) {
    await sleep(1500);
    children = discoverChildren();
  }
  return children;
}

/** A throwaway git repo the agent has something visual to work on. */
function scaffoldRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ch-demo-repo-"));
  // A page that looks good in both light and dark. The recording emulates a dark
  // color scheme (to keep VSCodium dark), which also reaches the Simple Browser's
  // webview — so the served page must render well dark, or the preview looks broken.
  writeFileSync(
    join(repo, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Nimbus</title>
  <style>
    :root { color-scheme: light dark; --bg:#ffffff; --fg:#0f1729; --muted:#5b6472;
            --card:#f7f8fa; --border:#e6e8ec; --accent:#4f7cff; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0e1320; --fg:#e8ecf4; --muted:#98a2b3; --card:#161d2e;
              --border:#26304a; --accent:#7aa2ff; }
    }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; background: var(--bg);
           color: var(--fg); }
    header { padding: 3rem 3rem 1.5rem; }
    .brand { display: inline-flex; align-items: center; gap: 0.6rem;
             font-weight: 650; font-size: 1.1rem; color: var(--accent); }
    .brand .dot { width: 0.8rem; height: 0.8rem; border-radius: 50%;
                  background: var(--accent); }
    h1 { margin: 1.2rem 0 0; font-size: 2.6rem; letter-spacing: -0.02em; }
    p.lede { color: var(--muted); font-size: 1.2rem; margin: 0.75rem 0 0;
             max-width: 34rem; }
    main { padding: 1rem 3rem 3rem; display: grid; gap: 1rem;
           grid-template-columns: repeat(2, minmax(0, 18rem)); }
    .card { border: 1px solid var(--border); background: var(--card);
            border-radius: 14px; padding: 1.4rem 1.5rem; }
    .card h2 { margin: 0 0 0.4rem; font-size: 1.1rem; }
    .card p { margin: 0; color: var(--muted); }
    .value { font-size: 2rem; font-weight: 650; margin: 0.2rem 0 0; color: var(--fg); }
  </style>
</head>
<body>
  <header>
    <span class="brand"><span class="dot"></span>Nimbus</span>
    <h1>Good afternoon.</h1>
    <p class="lede">A tiny weather board built to show CodeHydra running real agents.</p>
  </header>
  <main>
    <div class="card"><h2>Temperature</h2><p class="value">21&deg;</p><p>Partly cloudy</p></div>
    <div class="card"><h2>Wind</h2><p class="value">8 km/h</p><p>Gentle breeze</p></div>
  </main>
  <script src="app.js"></script>
</body>
</html>
`
  );
  writeFileSync(join(repo, "app.js"), "console.log('Nimbus ready');\n");

  // The repo's own conventions carry the "how", so the prompt typed on camera only
  // has to say WHAT to do. Claude Code loads CLAUDE.md as project instructions.
  writeFileSync(
    join(repo, "CLAUDE.md"),
    `# Nimbus

A tiny weather board: \`index.html\`, \`app.js\`, and \`server.mjs\` (a zero-dependency
static server that prints the URL it serves on).

## Restyling the page

When asked to restyle Nimbus in a given visual style:

- As your very first action, give this workspace a short display title — a few
  words naming the style — so the workspace list shows it instead of the branch
  name.
- Change styling only — leave the markup and copy intact.
- Use fixed colours. Never \`prefers-color-scheme\`, so the look does not change
  with system dark mode.
- Start the preview with \`ch-bg node server.mjs\` in the background from your own
  shell. The \`ch-bg\` wrapper is what stops a long-running server from holding the
  workspace busy, so the workspace can report finished. Do not open a separate
  terminal tab for it.
- Open the served URL in the browser preview **beside your own session**, so the
  session and the live preview sit side by side and are both visible at once.
  The preview must end up in its own editor group next to your session. Do NOT
  use the plain "Simple Browser: Show" command — it reuses whichever editor group
  is active, which leaves the preview stacked on top of your session and hides
  one behind the other. Open it to the side instead. Afterwards check that your
  session and the preview really are side by side, and move the preview into its
  own group beside you if it is not.
- Leave nothing else open: no extra editor tabs, and no terminal panel at the
  bottom. Just your session and the preview, side by side.
- As your very last action, show a notification describing the style you applied.
  Do not wait for it to be dismissed.

## Coordinating several variants

When asked for several variants, first say in two or three sentences which variants
you are about to create and what each one will do. Then create one workspace per
variant and give each the style it should apply. Do not edit files, start servers,
or open previews yourself — the spawned workspaces do all of that. Once they are
all underway, hibernate yourself.
`
  );
  // Must send a Content-Type: without one the webview will not render the HTML
  // (it arrives as an untyped blob and the Simple Browser shows a blank page).
  writeFileSync(
    join(repo, "server.mjs"),
    `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

// Resolve files against this script's directory, not the process CWD — the agent
// may launch the server from anywhere.
const ROOT = dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(ROOT, path));
    res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    // Fall back to the page for anything unmatched, so the preview always renders.
    try {
      const body = await readFile(join(ROOT, 'index.html'));
      res.setHeader('Content-Type', TYPES['.html']);
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(\`Serving on http://127.0.0.1:\${server.address().port}\`);
});
`
  );
  const git = (...args: string[]): void =>
    void execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "Demo");
  git("add", ".");
  git("commit", "-m", "init");
  return repo;
}

// ── Xvfb + ffmpeg ─────────────────────────────────────────────────────────────
async function startXvfb(): Promise<ChildProcess> {
  const num = DISPLAY.replace(":", "");
  const socket = `/tmp/.X11-unix/X${num}`;
  const lock = `/tmp/.X${num}-lock`;

  // A stale Xvfb from a crashed run leaves its socket behind. Reusing it would
  // silently record at the old screen size, so terminate the owner (only if it
  // really is Xvfb) and clear the lock before starting a fresh one.
  if (existsSync(lock)) {
    try {
      const pid = Number(readFileSync(lock, "utf-8").trim());
      if (pid > 0 && readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "Xvfb") {
        process.kill(pid, "SIGTERM");
        await sleep(500);
      }
    } catch {
      // No such process / unreadable — fall through and clear the lock.
    }
    rmSync(lock, { force: true });
    rmSync(socket, { force: true });
  }

  const proc = spawn(
    "Xvfb",
    [DISPLAY, "-screen", "0", `${DEVICE.w}x${DEVICE.h}x24`, "-nolisten", "tcp"],
    { stdio: "ignore" }
  );
  for (let i = 0; i < 50; i++) {
    if (existsSync(socket)) return proc;
    await sleep(100);
  }
  throw new Error(`Xvfb did not come up on ${DISPLAY}`);
}

function startRecording(rawPath: string): ChildProcess {
  return spawn(
    FFMPEG,
    [
      "-y",
      "-f",
      "x11grab",
      "-draw_mouse",
      "1",
      "-framerate",
      String(FPS),
      "-video_size",
      `${DEVICE.w}x${DEVICE.h}`,
      "-i",
      DISPLAY,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      rawPath,
    ],
    { stdio: ["pipe", "ignore", "ignore"] }
  );
}

/** Ask ffmpeg to finish (writes the moov atom); resolve when it exits. */
function stopRecording(ffmpeg: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    ffmpeg.on("exit", () => resolve());
    ffmpeg.stdin?.write("q");
    ffmpeg.stdin?.end();
  });
}

// ── Cut list ──────────────────────────────────────────────────────────────────
/** Recording start (ms), set when ffmpeg is spawned; cut times are relative to it. */
let recordStartMs = 0;
/** Spans (seconds) to drop from the final cut. */
const cutSpans: Array<{ start: number; end: number }> = [];

/**
 * Run a "dead" wait and record the span to cut. Keeps KEEP seconds of motion at
 * each end (the agent visibly starting and finishing) and marks the middle for
 * removal. Short waits (< 2*KEEP + a margin) are left whole.
 */
async function timed<T>(fn: () => Promise<T>): Promise<T> {
  const startS = (Date.now() - recordStartMs) / 1000;
  const result = await fn();
  const endS = (Date.now() - recordStartMs) / 1000;
  if (endS - startS > 2 * KEEP + 1) cutSpans.push({ start: startS + KEEP, end: endS - KEEP });
  return result;
}

/**
 * Like `timed`, but keeps `tailS` seconds at the end instead of the usual KEEP.
 *
 * For a wait that ends in something worth watching: the cut stops early enough
 * that the lead-up is on camera, rather than the result appearing straight out
 * of a splice.
 */
async function timedTail<T>(fn: () => Promise<T>, tailS: number): Promise<T> {
  const startS = (Date.now() - recordStartMs) / 1000;
  const result = await fn();
  const endS = (Date.now() - recordStartMs) / 1000;
  if (endS - startS > KEEP + tailS + 1) cutSpans.push({ start: startS + KEEP, end: endS - tailS });
  return result;
}

/** On-screen captions: each shows from its (mapped) time until the next one. */
const captions: Array<{ rawS: number; text: string }> = [];

/** Show a caption from now until the next caption (narrates the current beat). */
function caption(text: string): void {
  if (recordStartMs > 0) captions.push({ rawS: (Date.now() - recordStartMs) / 1000, text });
  log(`caption: ${text}`);
}

/**
 * Map a raw-capture time to its position in the cut + crossfaded timeline.
 * Each splice overlaps its neighbour by XFADE, so cut-time is not a plain sum of
 * kept durations. A time inside a cut span maps to the next kept moment.
 */
function rawToCut(rawS: number, segments: Array<{ start: number; end: number }>): number | null {
  let cutStart = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    if (rawS < seg.start) return cutStart;
    if (rawS <= seg.end) return cutStart + (rawS - seg.start);
    cutStart += seg.end - seg.start - (k < segments.length - 1 ? XFADE : 0);
  }
  return null;
}

/** Format seconds as an ASS timestamp (H:MM:SS.cc). */
function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/**
 * Write an ASS subtitle file for the captions, timed to the cut timeline, or
 * return null if there is nothing to show. Bold white on a translucent box,
 * bottom-centre. Rendered by ffmpeg-static's libass `ass` filter (it has no
 * `drawtext`); DejaVu Sans is resolved via fontconfig.
 */
function buildCaptionFile(
  segments: Array<{ start: number; end: number }>,
  totalCut: number
): string | null {
  const events = captions
    .map((c) => ({ t: rawToCut(c.rawS, segments), text: c.text }))
    .filter((e): e is { t: number; text: string } => e.t !== null)
    .sort((a, b) => a.t - b.t);
  if (events.length === 0) return null;

  const dialogue = events
    .map((e, i) => {
      const end = i + 1 < events.length ? events[i + 1]!.t : totalCut;
      if (end - e.t < 0.5) return null; // too brief to read; drop
      return `Dialogue: 0,${assTime(e.t)},${assTime(end)},Cap,,0,0,0,,${e.text}`;
    })
    .filter((d): d is string => d !== null);

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${LOGICAL.w}\nPlayResY: ${LOGICAL.h}\nWrapStyle: 2\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Cap, DejaVu Sans, 30, &H00FFFFFF, &H00000000, &HB0000000, -1, 3, 6, 0, 2, 80, 80, 46, 1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const assPath = join(APP_ROOT, "captions.ass");
  writeFileSync(assPath, header + dialogue.join("\n") + "\n");
  return assPath;
}

/** Raw-capture time (seconds) of the frame to lift the landing-page poster from. */
let posterAtRawS: number | null = null;

/**
 * Mark "now" as the poster frame. Only call from a beat that is never cut — the
 * frame has to survive into the final video, or the poster shows something the
 * viewer never sees.
 */
function markPoster(): void {
  if (recordStartMs > 0) posterAtRawS = (Date.now() - recordStartMs) / 1000;
}

/** Kept segments = [0, total] minus the merged, clamped cut spans (dropping slivers). */
function keptSegments(total: number): Array<{ start: number; end: number }> {
  const cuts = cutSpans
    .map((c) => ({ start: Math.max(0, c.start), end: Math.min(total, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const kept: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < total) kept.push({ start: cursor, end: total });
  // Slivers shorter than a crossfade can't be faded; drop them.
  return kept.filter((s) => s.end - s.start > XFADE + 0.1);
}

/**
 * Lift one frame out of the raw grab and downscale it exactly as the video is
 * downscaled, so the poster is pixel-for-pixel a frame of the delivered mp4.
 * Taken from the raw capture rather than the cut result to avoid mapping a
 * timestamp through the cut list; the marked beat is never inside a cut span.
 */
function extractPoster(rawPath: string, posterPath: string, atRawS: number): void {
  mkdirSync(join(posterPath, ".."), { recursive: true });
  execFileSync(
    FFMPEG,
    [
      "-y",
      // Input seek: ffmpeg still decodes from the preceding keyframe, so this is
      // both fast and frame-accurate for a transcode.
      "-ss",
      atRawS.toFixed(3),
      "-i",
      rawPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-vf",
      `scale=${LOGICAL.w}:${LOGICAL.h}:flags=lanczos`,
      "-compression_level",
      "100",
      posterPath,
    ],
    { stdio: "ignore" }
  );
}

/**
 * Downscale the 2x grab to the delivery size, dropping the cut spans and
 * crossfading each splice. With no cuts this is a plain scale+encode.
 */
function encodeFinal(rawPath: string, outPath: string, total: number): void {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const segments = keptSegments(total);
  const scale = `scale=${LOGICAL.w}:${LOGICAL.h}:flags=lanczos`;

  // Print the edit, so pacing is diagnosable from the run log instead of by
  // frame-differencing the result afterwards. A long kept segment over a static
  // shot is the signature of the video dragging.
  log(
    `cut to ${segments.length} segment(s): ` +
      segments.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(" ")
  );

  // Total cut duration accounts for the XFADE overlap at each splice.
  const totalCut =
    segments.reduce((sum, s) => sum + (s.end - s.start), 0) -
    XFADE * Math.max(0, segments.length - 1);
  const captionFile = buildCaptionFile(segments, totalCut);
  // libass path in a filter graph: escape the single colon-free /tmp path is fine,
  // but wrap defensively so a stray char can't break the graph.
  const assFilter = captionFile ? `,ass='${captionFile}'` : "";

  if (segments.length <= 1) {
    execFileSync(
      FFMPEG,
      [
        "-y",
        "-i",
        rawPath,
        "-vf",
        `${scale}${assFilter}`,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { stdio: "ignore" }
    );
    return;
  }

  // Trim + scale each kept segment, then xfade-chain them together.
  const parts: string[] = [];
  segments.forEach((s, i) => {
    // Normalize framerate / SAR / format on each segment: xfade rejects inputs
    // whose frame timing or pixel format differ, which trimmed spans otherwise do.
    parts.push(
      `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},` +
        `setpts=PTS-STARTPTS,fps=${FPS},${scale},setsar=1,format=yuv420p[v${i}]`
    );
  });
  let cur = "v0";
  let curDur = segments[0]!.end - segments[0]!.start;
  segments.slice(1).forEach((s, idx) => {
    const i = idx + 1;
    const next = `x${i}`;
    const offset = (curDur - XFADE).toFixed(3);
    parts.push(`[${cur}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset}[${next}]`);
    cur = next;
    curDur += s.end - s.start - XFADE;
  });
  // Burn captions onto the assembled result.
  if (assFilter) {
    parts.push(`[${cur}]ass='${captionFile}'[capped]`);
    cur = "capped";
  }

  execFileSync(
    FFMPEG,
    [
      "-y",
      "-i",
      rawPath,
      "-filter_complex",
      parts.join(";"),
      "-map",
      `[${cur}]`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stdio: "ignore" }
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
/** Create a workspace with a pre-filled creation prompt; wait until it is active. */
async function createWorkspaceWithPrompt(
  driver: AppDriver,
  name: string,
  prompt: string
): Promise<void> {
  const ui = driver.uiPage() as Page;
  const panel = ui.getByRole("region", { name: "New workspace" });
  if (!(await panel.isVisible())) {
    await fixtures.expandSidebar(ui);
    await ui.getByRole("button", { name: "New workspace" }).click();
    await expect(panel).toBeVisible();
    await hideSidebar(ui);
  }
  await expect(fixtures.baseBranchField(ui)).not.toHaveValue("", { timeout: 60_000 });

  // Type the fields (not fill/paste) so the entry is visible on camera and the
  // form lingers before the workspace is created.
  const field = fixtures.nameField(ui);
  await field.click();
  await field.pressSequentially(name, { delay: 55 });
  await expect(field).toHaveValue(name);
  if ((await field.getAttribute("aria-expanded")) === "true") {
    await ui.keyboard.press("Escape");
    await expect(field).toHaveAttribute("aria-expanded", "false");
  }

  const promptBox = ui.getByRole("textbox", { name: "Prompt" });
  await promptBox.click();
  await promptBox.pressSequentially(prompt, { delay: 6 });
  await sleep(1200);

  const create = panel.getByRole("button", { name: "Create" });
  await expect(create).not.toHaveAttribute("disabled", /.*/, { timeout: 60_000 });
  await create.click();

  // Uncut, all of it. Creating the worktree and booting its IDE is CodeHydra
  // working, not an agent thinking — the rule for the cut list is that agent
  // waits go and app activity stays. (It was one big cut only because the
  // agent's account banner had to be kept off screen; `IS_DEMO` handles that.)
  await expect(fixtures.workspaceRow(ui, name)).toBeVisible({ timeout: 180_000 });
  await sleep(1500); // the new row lands, and the view switches into it
  await fixtures.waitForWorkspaceFrame(driver, name);
  await sleep(1500); // the workspace, up and ready
}

/**
 * Clone a public repo as a second project, on camera, while the fleet is working.
 * Shows CodeHydra holding more than one project and cloning straight from git.
 */
async function cloneProjectBeat(driver: AppDriver, url: string): Promise<void> {
  const ui = driver.uiPage() as Page;
  const panel = ui.getByRole("region", { name: "New workspace" });
  if (!(await panel.isVisible())) {
    await fixtures.expandSidebar(ui);
    await ui.getByRole("button", { name: "New workspace" }).click();
    await expect(panel).toBeVisible();
  }
  // No hideSidebar here: the creation panel maps to a non-"workspace" UI mode, so
  // main holds the sidebar open for as long as the panel is up. Asking it to
  // collapse can only spin until the timeout and warn.

  await ui.getByRole("button", { name: "Clone from Git" }).click();
  const urlField = ui.getByRole("textbox", { name: "Repository URL" });
  await urlField.click();
  await urlField.pressSequentially(url, { delay: 55 });
  await sleep(900);
  await ui.getByRole("button", { name: "Clone", exact: true }).click();
  // Uncut: cloning is CodeHydra doing the work, not an agent thinking, and the
  // progress it shows is part of the point.
  await expect(fixtures.baseBranchField(ui)).not.toHaveValue("", { timeout: 180_000 });
}

/**
 * Drive CodeHydra's hold-Alt shortcut gesture: hold Alt, tap X, tap `keys`, release.
 *
 * This must be synthesized from the MAIN process. Shortcut mode is detected in
 * `before-input-event`, and Playwright's keyboard goes through CDP, which never
 * reaches it — the shortcut module logs nothing at all for a `page.keyboard`
 * press. `webContents.sendInputEvent` does pass through it.
 *
 * `pauseMs` is generous on purpose: the hint overlay is the point of filming
 * this, so each step has to linger long enough to read.
 */
async function shortcutMode(driver: AppDriver, keys: string[], pauseMs = 1400): Promise<void> {
  const app = driver.electron();
  const send = (keyCode: string, type: "keyDown" | "keyUp", alt: boolean): Promise<void> =>
    app.evaluate(
      ({ webContents }, arg) => {
        const view = webContents.getAllWebContents().find((w) => w.getType() === "window");
        view?.sendInputEvent({
          type: arg.type,
          keyCode: arg.keyCode,
          modifiers: arg.alt ? ["alt"] : [],
        });
      },
      { keyCode, type, alt }
    );

  await send("Alt", "keyDown", true);
  await sleep(250);
  await send("x", "keyDown", true);
  await send("x", "keyUp", true);
  await sleep(pauseMs); // hold on the hint overlay
  for (const key of keys) {
    await send(key, "keyDown", true);
    await send(key, "keyUp", true);
    await sleep(pauseMs);
  }
  // Releasing Alt is what exits shortcut mode.
  await send("Alt", "keyUp", false);
  await sleep(600);
}

/**
 * Open settings, type the two real auto-workspace sources, save, and wait for the
 * workspaces they produce (one for the newest open PR, one for the newest issue).
 *
 * `auto-workspace.sources` is `applies: "live"` and re-read on a 60s heartbeat, so
 * no restart — but the workspaces can take a minute to appear (heartbeat + the
 * repo clone). That wait is cut; it stops two seconds early so the first appears
 * on camera rather than out of a splice.
 */
async function autoWorkspaceBeat(driver: AppDriver): Promise<boolean> {
  const ui = driver.uiPage() as Page;

  // Alt+X then S opens settings — shortcut mode, and its hint overlay, on camera.
  await shortcutMode(driver, ["s"]);
  // Caption only once the dialog is up, so it lands on the auto-workspace content
  // (the sources being configured), not on the previous beat's workspace.
  caption("Auto-workspaces: turn open PRs and issues into working agents");

  // The only textarea in the dialog; addressed by its config key rather than by
  // position so a new multiline setting cannot silently steal the beat.
  const field = ui.locator('textarea[id="auto-workspace.sources"]');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.click();
  await field.pressSequentially(autoSourceYaml(), { delay: 14 });
  await sleep(1200); // let the finished source sit on screen before saving

  await ui.getByRole("button", { name: "Save", exact: true }).click();
  await hideSidebar(ui);
  await sleep(1000); // a beat after the dialog closes...

  // ...then cut the wait entirely: the sources poll, clone the shared repo once,
  // and create both workspaces (in their own cli/cli project — scan all projects)
  // with nothing on screen worth watching meanwhile.
  const created = await timed(() =>
    waitUntil(() => allWorkspacesGlobal().filter(AUTO_MATCH).length >= 2, 200_000)
  );
  const names = allWorkspacesGlobal().filter(AUTO_MATCH);
  if (names.length === 0) return false;
  if (!created) log(`WARNING: only ${names.length}/2 auto-workspaces appeared`);

  // Switch to each created workspace and hold 2s — the tagged PR/issue row in the
  // sidebar, then its agent already working on the GitHub item. The IDE boot is
  // cut (big cli/cli clone); only the dwell on each is kept.
  for (const name of names) {
    await fixtures.expandSidebar(ui);
    await fixtures.workspaceRow(ui, name).click();
    await hideSidebar(ui);
    await timed(() => fixtures.waitForWorkspaceFrame(driver, name).catch(() => {}));
    await sleep(2000);
  }
  return true;
}

/**
 * Wait until the agent has produced output and then gone quiet, or the cap.
 *
 * Idle is detected by terminal-text stability rather than a specific string:
 * Claude's busy line is a random gerund ("Flambéing…", "Cooking…") with a live
 * token counter, so the pane keeps changing while it works and stops when done.
 * Matching a fixed "esc to interrupt" string samples unreliably between renders.
 */
async function waitForAgentIdle(frame: Frame, capMs: number): Promise<void> {
  const start = Date.now();
  let sawWork = false;
  let previous = "";
  let stablePolls = 0;
  while (Date.now() - start < capMs) {
    await sleep(1500);
    const text = await frame
      .locator(".xterm-screen")
      .innerText()
      .catch(() => "");
    if (/●|Write\(|Edit\(|Bash\(|Read\(/.test(text)) sawWork = true;
    if (text === previous) {
      // 4 stable polls (~6s) after real work means the agent has stopped.
      if (sawWork && ++stablePolls >= 4) return;
    } else {
      stablePolls = 0;
      previous = text;
    }
  }
}

/** The workspace iframe whose URL names `name` (active or not). */
function workspaceFrame(driver: AppDriver, name: string): Frame | undefined {
  return driver
    .uiPage()
    .frames()
    .find((f) => f.url().includes(`${name}.code-workspace`));
}

/**
 * Collapse the sidebar, and keep asking until it actually is.
 *
 * The sidebar's expansion is main-owned (`mode !== "workspace"`), and hover only
 * *requests* it: an enter arms a 150ms timer that latches `isHovering` and emits
 * the hover event, and a leave is ignored outright unless that latch is already
 * set. A single leave dispatched inside those 150ms is therefore swallowed, the
 * arming timer fires straight after, and the sidebar latches open with nothing
 * left to close it — which is exactly how it ended up overlaying the workspace
 * for the whole compare section. Retrying makes the race irrelevant: whichever
 * leave lands after the latch is the one that collapses it.
 */
async function hideSidebar(ui: Page): Promise<void> {
  // The real cursor is left hovering the sidebar after a click, and that hover
  // alone keeps it expanded on camera. Park the pointer in the content area.
  await ui.mouse.move(Math.round(LOGICAL.w * 0.55), Math.round(LOGICAL.h * 0.5));
  const nav = ui.locator("nav.sidebar");
  // Capped low: when the sidebar is held open by the UI mode (the creation panel
  // does this), retrying cannot win, and every extra second is dead footage.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    // The mouseleave must carry a positive clientX: under Xvfb the window sits at
    // the screen's left edge, and Sidebar.svelte treats a clientX<=0 leave as an
    // "edge pin" and re-expands (fixtures.collapseSidebar dispatches clientX=0).
    await nav.dispatchEvent("mouseleave", { clientX: 600, clientY: 400 });
    // Read the class main actually applied, not a proxy control's visibility.
    if (!(await nav.evaluate((el) => el.classList.contains("expanded")))) return;
    await sleep(250);
  }
  log("warning: sidebar did not collapse");
}

/**
 * Whether the preview really sits *beside* the session rather than stacked behind
 * it. The log cannot tell the two apart: `simpleBrowser.show` opens in whichever
 * group is active, so it records an identical "Command received" line whether the
 * result is a side-by-side split or a tab hidden behind the terminal. Only the
 * layout knows, so ask the layout — the preview must live in a different editor
 * group than the agent session.
 */
async function hasSplitPreview(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => {
      const groups = [...document.querySelectorAll(".editor-group-container")];
      const groupWith = (label: string): number =>
        groups.findIndex((g) => g.querySelector(`.tab[aria-label*="${label}"]`) !== null);
      const preview = groupWith("Simple Browser");
      const session = groupWith("Claude");
      return groups.length >= 2 && preview !== -1 && session !== -1 && preview !== session;
    })
    .catch(() => false);
}

/** Click a workspace's sidebar row and wait until its iframe is the active one. */
async function switchToWorkspace(driver: AppDriver, name: string): Promise<void> {
  const ui = driver.uiPage() as Page;
  await fixtures.expandSidebar(ui);
  await fixtures.workspaceRow(ui, name).click();
  await hideSidebar(ui);
  await fixtures.waitForWorkspaceFrame(driver, name);
}

/**
 * Dismiss whatever modal is covering the workspace.
 *
 * Two kinds show up: the agent's info notification (OK), and VS Code's "terminate
 * running processes?" prompt when a terminal with a live dev server is closed —
 * answer Cancel there, so the preview's server keeps running.
 */
async function dismissModal(driver: AppDriver, name: string): Promise<void> {
  const frame = workspaceFrame(driver, name);
  if (!frame) return;
  for (const label of ["Cancel", "OK"]) {
    const button = frame.getByRole("button", { name: label, exact: true }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await sleep(400);
    }
  }
}

/** Type a follow-up prompt into a workspace's agent terminal and submit it. */
async function typeInTerminal(driver: AppDriver, name: string, text: string): Promise<void> {
  const frame = workspaceFrame(driver, name);
  // In the split layout the dev-server ("node") terminal is the active tab, so the
  // agent's own tab must be activated first — otherwise the text is typed into the
  // server's terminal. Click near its left edge: a centre/right click can hit the
  // tab's close button and pop VS Code's "terminate running processes?" prompt.
  await frame
    ?.locator('.tab[aria-label*="Claude"]')
    .first()
    .click({ position: { x: 24, y: 12 } })
    .catch(() => {});
  await sleep(600);
  // Only the active group's xterm is visible; `.first()` alone can pick a hidden one.
  await frame
    ?.locator(".xterm-screen:visible")
    .first()
    .click()
    .catch(() => {});
  await sleep(400);
  await driver.uiPage().keyboard.type(text, { delay: 32 });
  await sleep(600);
  await driver.uiPage().keyboard.press("Enter");
  // Confirm the prompt actually landed in the agent's terminal.
  const landed = await frame
    ?.locator(".xterm-screen:visible")
    .first()
    .innerText()
    .then((t) => t.includes("Keep this design"))
    .catch(() => false);
  if (!landed) log("warning: follow-up prompt may not have reached the agent terminal");
}

/** Poll until `cond()` is true, or time out. */
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(1500);
  }
  return cond();
}

async function main(): Promise<void> {
  log("seeding isolated root + claude config");
  seedRoot();
  seedClaudeConfig();
  cleanRun();

  const repo = scaffoldRepo();
  log(`scaffolded demo repo: ${repo}`);

  const xvfb = await startXvfb();
  log(`Xvfb up on ${DISPLAY} (${DEVICE.w}x${DEVICE.h})`);

  const driver = createDriver();
  const rawPath = join(APP_ROOT, "raw.mp4");
  let ffmpeg: ChildProcess | undefined;
  let totalDuration = 0;

  try {
    const port = await freePort();
    await driver.launch({
      cwd: REPO_ROOT,
      args: [
        "--log.format=json",
        "--log.level=debug",
        "--log.output=file",
        `--ide-server.port=${port}`,
        "--telemetry.enabled=false",
        "--update.notification=false",
        "--electron.flags=--ozone-platform=x11 --force-device-scale-factor=2",
      ],
      env: process.env,
      timeout: 120_000,
      actionTimeout: 15_000,
    });
    await driver.silenceNativeDialogs();
    await driver.waitForUiPage(120_000);

    // Force dark mode for capture. Under headless Xvfb the renderer reports
    // prefers-color-scheme: light even though the app shell is dark, so VSCodium
    // (which auto-detects the scheme) renders light. Emulating dark at the page
    // level covers the workspace OOPIFs too, so the whole UI is consistently dark.
    await driver.uiPage().emulateMedia({ colorScheme: "dark" });

    // The window opens at a fixed 1200x800; enlarge it (main-process API) so the
    // capture is a roomier, less zoomed-in viewport. DIP units, so at scale 2
    // this fills the DEVICE-sized Xvfb screen.
    await driver.electron().evaluate(
      ({ BaseWindow }, size) => {
        const win = BaseWindow.getAllWindows()[0];
        if (win) win.setBounds({ x: 0, y: 0, width: size.w, height: size.h });
      },
      { w: LOGICAL.w, h: LOGICAL.h }
    );
    log("app UI up");

    await fixtures.openProject(driver, repo);
    log("project opened");

    log("recording started");
    ffmpeg = startRecording(rawPath);
    recordStartMs = Date.now();
    await sleep(500);

    const ui = driver.uiPage() as Page;

    // Type one generic prompt into the orchestrator workspace and let its agent
    // decide to spawn a fleet.
    caption("Create a workspace and give its agent a task");
    await createWorkspaceWithPrompt(driver, ORCHESTRATOR, ORCHESTRATOR_PROMPT);
    await hideSidebar(ui);
    pinDemoProject();
    log("orchestrator created; delegating");

    // The fleet materialising is the whole point of the demo, so it is filmed in
    // full. Only the orchestrator's thinking time before the first workspace
    // appears is cut, and even that stops two seconds short so the first one
    // arrives on camera rather than out of a splice.
    caption("The agent spawns a workspace per idea, each with its own agent");
    await timedTail(() => waitUntil(() => discoverChildren().length >= 1, 150_000), 2.0);
    // Sidebar open through the spawn and a little past it: the rows appear
    // (created in the background, so the main view stays on the orchestrator),
    // their status dots flip to busy, and — as each agent's first action is to
    // title its own workspace (see the scaffolded CLAUDE.md) — their labels turn
    // from branch names into readable titles, all on camera.
    await fixtures.expandSidebar(ui);
    const children = await waitForChildren(VARIANT_COUNT, 150_000);
    await sleep(6000); // hold while the agents title themselves
    await hideSidebar(ui);
    log(`fleet spawned: ${children.join(", ")}`);

    // The orchestrator parks itself once the fleet is underway (hibernation beat).
    if (await timed(() => waitForLog(BEAT.hibernate, 120_000)))
      log("beat: orchestrator hibernated");

    // Show a variant working before moving on, then clone a second project from
    // git and ask its agent to explain the codebase.
    const gradient = children.find((n) => /gradient/.test(n)) ?? children[0]!;
    await switchToWorkspace(driver, gradient);
    await sleep(2500);
    caption("Clone a second project straight from GitHub");
    await cloneProjectBeat(driver, CLONE_URL);
    log(`cloned second project: ${CLONE_URL}`);
    caption("Ask its agent to explain the codebase");
    await createWorkspaceWithPrompt(driver, "explain", EXPLAIN_PROMPT);
    await hideSidebar(ui);
    log("second project: asked its agent to explain the codebase");
    await sleep(3000);

    // Auto-workspaces: sources are shell commands that print JSON, typed into
    // settings on camera. Here they poll GitHub with `gh` — the newest open PR to
    // review and the newest issue to investigate — each becoming a workspace whose
    // agent is already on the task. (Captioned inside the beat, once the settings
    // dialog is up.)
    log(
      (await autoWorkspaceBeat(driver))
        ? "beat: auto-workspace sources created PR + issue workspaces"
        : "WARNING: the auto-workspace sources produced no workspace"
    );

    // Each variant opens its live preview, then shows a NON-blocking notification
    // over it (the agent does not wait — it finishes and goes green). Wait for the
    // previews, the notifications, then every agent to be idle (green dots).
    // Per distinct workspace, not per log line — and the result is honoured, so a
    // timeout can no longer masquerade as the beat having happened.
    log(
      (await timed(() => waitForWorkspaceCount(BEAT.simpleBrowser, VARIANT_COUNT, 200_000)))
        ? "beat: all previews opened"
        : `WARNING: only ${matchedWorkspaces(BEAT.simpleBrowser).size}/${VARIANT_COUNT} variants opened a preview`
    );
    // The show-message dispatch carries no workspace in its context, so this one
    // can only be counted in aggregate — but the result is still honoured.
    log(
      (await timed(() => waitForLogCount(BEAT.notification, VARIANT_COUNT, 150_000)))
        ? "beat: all notifications shown"
        : `WARNING: only ${countLog(BEAT.notification)}/${VARIANT_COUNT} notifications shown`
    );
    // The names captured when the fleet spawned, NOT a fresh discover: the
    // auto-workspace beat has since added a workspace to this same project, and
    // re-deriving here would parade it through the compare loop as a style variant.
    const variants = children;
    for (const name of variants) {
      const frame = workspaceFrame(driver, name);
      if (frame) await timed(() => waitForAgentIdle(frame, 120_000));
    }
    log("all variants idle (green)");

    // The layout is final now, so this is the moment to check what the camera will
    // actually show: a preview beside each session, not one hidden behind it.
    // Wrapped: these are inspections, not footage. Whatever they cost, the cut
    // list should drop it rather than hold on a frozen workspace.
    const splitOk = new Set<string>();
    await timed(async () => {
      for (const name of variants) {
        const frame = workspaceFrame(driver, name);
        if (frame && (await hasSplitPreview(frame))) splitOk.add(name);
        else log(`WARNING: "${name}" has no preview beside its session (stacked or missing)`);
        // The fleet workspaces were created by the orchestrator, not by
        // createWorkspaceWithPrompt, so they never passed through its identity
        // gate. By now their own output should have pushed the banner away.
        if (frame && (await visibleIdentity(frame)).length > 0)
          log(`WARNING: "${name}" shows account identity on screen`);
      }
    });

    /**
     * The variant to end on and to lift the poster from. A stacked variant makes
     * a poor closing shot and a worse still, so a working split outranks the
     * preferred style; the gradient wins among equals because it reads best.
     */
    const feature =
      [...variants].sort(
        (a, b) =>
          (splitOk.has(a) ? 0 : 2) +
          (/gradient/.test(a) ? 0 : 1) -
          ((splitOk.has(b) ? 0 : 2) + (/gradient/.test(b) ? 0 : 1))
      )[0] ?? variants[0]!;

    // Compare: switch through each variant. Its notification (modal) is still up
    // over the preview; hold on it, confirm (OK), then reveal the clean preview.
    caption("Each variant previews its result — compare them side by side");
    for (const name of variants) {
      await switchToWorkspace(driver, name);
      await ui.mouse.move(Math.round(LOGICAL.w * 0.85), Math.round(LOGICAL.h * 0.25));
      // Long enough to read the notification and take in the design, no longer —
      // these are finished workspaces, so every extra second is a still frame.
      await sleep(1700); // notification over the split (terminal + live preview)
      await dismissModal(driver, name);
      await ui.mouse.move(Math.round(LOGICAL.w * 0.85), Math.round(LOGICAL.h * 0.25));
      await sleep(1500); // clean split: terminal beside the live design
      // Poster material: the featured variant with the sidebar open, so the still
      // shows the titled workspace list alongside the live result. These sleeps
      // are never wrapped in timed(), so this frame survives into the video.
      if (name === feature) {
        await fixtures.expandSidebar(ui);
        await sleep(1600); // sidebar settled and readable
        markPoster();
        await sleep(600);
        await hideSidebar(ui);
      }
    }

    // Tell the featured variant's agent, in plain language, to keep it and close
    // the rest — an agent cleaning up the other workspaces.
    caption("Pick one — its agent closes every other workspace");
    const winner = feature;
    await switchToWorkspace(driver, winner);
    await dismissModal(driver, winner);
    await typeInTerminal(driver, winner, KEEP_PROMPT);
    log(`asked "${winner}" to keep its design and close the others`);
    // The agent deletes the others over MCP (worktree removal in the main
    // process), so no VS Code close-prompt appears — just wait for them to go.
    // Everything across every project must go — the hibernated orchestrator, the
    // slugify "explain" workspace, and the two gh workspaces — leaving only the
    // winner. (Project-global, not demo-scoped: the others live in other projects.)
    const closed = await timed(() => waitUntil(() => allWorkspacesGlobal().length <= 1, 180_000));
    log(closed ? `cleanup done — only "${winner}" remains` : "WARNING: cleanup did not complete");

    // End on the surviving design.
    await ui.mouse.move(Math.round(LOGICAL.w * 0.85), Math.round(LOGICAL.h * 0.25));
    await sleep(3000);
  } finally {
    if (recordStartMs > 0) totalDuration = (Date.now() - recordStartMs) / 1000;
    if (ffmpeg) await stopRecording(ffmpeg);
    await driver.stop().catch(() => {});
    xvfb.kill();
  }

  log(`encoding final mp4 (${cutSpans.length} cut spans, ${totalDuration.toFixed(1)}s raw)`);
  encodeFinal(rawPath, OUTPUT, totalDuration);
  log(`done → ${OUTPUT}`);

  if (posterAtRawS === null) {
    log("WARNING: no poster frame marked; leaving the existing poster in place");
  } else {
    extractPoster(rawPath, POSTER, posterAtRawS);
    log(`poster → ${POSTER} (raw t=${posterAtRawS.toFixed(1)}s)`);
  }
}

await main();
