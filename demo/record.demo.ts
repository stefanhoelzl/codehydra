/**
 * The landing-page demo, as a Playwright spec: `pnpm demo:record` films it into
 * `site/public/demo.mp4` (+ the `screenshot.png` poster); `pnpm demo:smoke`
 * (`DEMO_FILM=0`, CI) drives and asserts the same story without filming.
 *
 * The story — you run many agents at once, and automation keeps them working —
 * in chapters, each staying in one place so it is easy to follow:
 *
 * 1. You clone a repository from GitHub, beside a project already open.
 * 2. An agent fans out: a workspace and agent per look it was asked to try.
 * 3. An agent waiting on CI hibernates with a wakeup script, which wakes it.
 * 4. A plugin's automation turns open pull requests into review workspaces.
 * 5. The fan-out agent lines the looks up and asks which to keep; it keeps
 *    your pick and deletes the rest, itself included.
 *
 * The app and the `claude` CLI are real; the model is a script (`agents.ts`)
 * and GitHub is staged (`scaffold.ts`), so every run tells the same story with
 * no account, key or network. Every beat is asserted: a beat that does not
 * happen fails the run instead of being filmed missing.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedClonePath, projectDirName } from "../src/boundaries/platform/paths";
import { expandGitUrl } from "../src/utils/url-utils";
import type { AppDriver } from "../scripts/appctrl.ts";
import { CONFIG_FILE, DATA_ROOT, HOME_ROOT, REPO_ROOT } from "../e2e/env.ts";
import {
  baseBranchField,
  nameField,
  useApp,
  waitForWorkspaceFrame,
  workspaceRow,
} from "../e2e/fixtures.ts";
import {
  API_WORKSPACES,
  PICK,
  PICK_INDEX,
  PROMPTS,
  SITE_WORKSPACES,
  startAgents,
  type DemoAgents,
} from "./agents.ts";
import { LOGICAL, SCALE, sleep, startFilm, type Box, type Film } from "./film.ts";
import {
  API,
  OWN_PR,
  PULL_REQUESTS,
  SITE,
  STYLES,
  gitHubEnv,
  githubState,
  reviewsPlugin,
  scaffoldGitHub,
  slug,
  writeFakeGh,
} from "./scaffold.ts";

const FILMING = process.env.DEMO_FILM !== "0";
const DISPLAY = process.env.DEMO_DISPLAY ?? ":99";
const OUTPUT = process.env.DEMO_OUTPUT ?? join(REPO_ROOT, "site", "public", "demo.mp4");
const POSTER = process.env.DEMO_POSTER ?? join(REPO_ROOT, "site", "public", "screenshot.png");

/** The recorder's own files: "GitHub", the stand-in gh, Claude's config, the grab. */
const WORK = join(DATA_ROOT, "demo");
const FAKE_BIN = join(WORK, "bin");
const GITHUB = join(WORK, "github");
const GITHUB_STATE = join(WORK, "github-state");
/** Where the app keeps its clones; the e2e reset leaves it, so a run clears it. */
const REMOTES = join(DATA_ROOT, "remotes");

const VARIANTS = Object.keys(STYLES);
const REVIEWS = PULL_REQUESTS.map((pr) => `pr-${pr.number}`);

let film: Film;
let agents: DemoAgents;
let github: ReturnType<typeof githubState>;

/** A project's workspaces directory, once the app has cloned `repo`. */
function workspacesOf(repo: string): string {
  const clone = managedClonePath(REMOTES, expandGitUrl(slug(repo)));
  return join(DATA_ROOT, "projects", projectDirName(clone.toString()), "workspaces");
}

// Before useApp: the app's environment points at the mock, "GitHub" and the display.
test.beforeAll(async () => {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(REMOTES, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  scaffoldGitHub(GITHUB);
  github = githubState(GITHUB_STATE);
  writeFakeGh(FAKE_BIN, GITHUB_STATE);
  // A first run on an empty root would otherwise stop on the agent picker.
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(HOME_ROOT, { recursive: true });
    writeFileSync(CONFIG_FILE, `${JSON.stringify({ agent: "claude" })}\n`);
  }
  film = await startFilm({ display: DISPLAY, workDir: WORK, filming: FILMING });
  agents = await startAgents({
    configDir: join(WORK, "claude-config"),
    requestLog: join(WORK, "requests.log"),
    trusted: [
      ...SITE_WORKSPACES.map((name) => join(workspacesOf(SITE), name)),
      ...API_WORKSPACES.map((name) => join(workspacesOf(API), name)),
    ],
    extraEnv: {
      DISPLAY,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      ...gitHubEnv(GITHUB),
      // Claude Code's own opt-out for its project-onboarding panel.
      IS_DEMO: "1",
    },
  });
});

const app = useApp({
  agent: "claude",
  extraArgs: [
    // Last wins: replaces the fixtures' own `--ozone-platform=x11`, keeping it.
    `--electron.flags=--ozone-platform=x11 --force-device-scale-factor=${SCALE}`,
    "--sidebar.mode=docked",
    // Automations and wakeup scripts react within seconds, not a minute.
    "--poll.interval=3",
    "--silent=true",
    "--notification=disabled",
  ],
  env: () => agents.env,
});

test.afterAll(async () => {
  try {
    // The app runs on the film's display: quit it first, or it loses its X
    // connection mid-run and leaves processes behind. A no-op when useApp's own
    // teardown already stopped it.
    await app().stop();
  } finally {
    await film?.close();
    await agents?.stop();
  }
});

test("the landing-page demo", async () => {
  test.setTimeout(30 * 60_000);
  const driver = app();
  const ui = driver.uiPage();

  // A first start on a fresh root downloads the IDE server first.
  await ui
    .getByRole("button", { name: "Open project folder" })
    .waitFor({ state: "visible", timeout: 600_000 });
  // Headless Xvfb reports a light scheme. The shell follows nativeTheme and the
  // IDE frames follow prefers-color-scheme, so set both.
  await driver.electron().evaluate(
    ({ BaseWindow, nativeTheme }, size) => {
      nativeTheme.themeSource = "dark";
      BaseWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: size.w, height: size.h });
    },
    { w: LOGICAL.w, h: LOGICAL.h }
  );
  await ui.emulateMedia({ colorScheme: "dark" });
  // The project already in use when the story starts.
  await clone(ui, API);
  await cloned(ui, API);
  // Read each poll, so it can go in now; it finds nothing until the pull
  // requests are "opened".
  const pluginFile = join(HOME_ROOT, "plugins", "reviews.yaml");
  mkdirSync(join(HOME_ROOT, "plugins"), { recursive: true });
  writeFileSync(pluginFile, reviewsPlugin());

  film.start();

  // ── 1. Clone ─────────────────────────────────────────────────────────────
  await film.chapter("Clone a repository from GitHub");
  film.caption(`${API} is open — clone ${SITE} beside it`);
  await sleep(1200);
  await clone(ui, SITE);
  await film.timed(() => cloned(ui, SITE), 1.5);
  await sleep(1500);

  // ── 2. Fan out ───────────────────────────────────────────────────────────
  await film.chapter("One agent, three ideas");
  film.caption(`One task, one workspace, one agent: restyle, in ${SITE}`);
  await createWorkspace(driver, "restyle", PROMPTS.restyle);
  await expect(row(ui, "restyle", "1 agent busy")).toBeVisible({ timeout: 60_000 });
  film.caption("restyle's agent creates a workspace per look, each with an agent of its own");
  agents.open("spawn");
  for (const name of VARIANTS) {
    await film.timed(() => expect(workspaceRow(ui, name)).toBeVisible({ timeout: 120_000 }), 1.5);
  }
  // Each variant's first act is to title itself; hold while the rows change.
  await film.timed(
    () => Promise.all(VARIANTS.map((name) => within(agents.served(name, 0, 0), 120_000, name))),
    1.5
  );
  await sleep(3500);

  // ── 3. Automation ────────────────────────────────────────────────────────
  // The plugin is on the card: it belongs to no workspace on screen.
  await film.chapter("Automate the routine", { detail: reviewsPlugin() });
  film.caption(`A plugin opens a review workspace and agent per pull request on ${API}`);
  film.spotlight(await projectBox(ui, VARIANTS.at(-1)!));
  await sleep(1500);
  github.openPullRequests();
  for (const name of REVIEWS) {
    await film.timed(() => expect(workspaceRow(ui, name)).toBeVisible({ timeout: 60_000 }), 1.5);
  }
  await sleep(1500);
  film.caption("Each review agent turns green when it is done");
  for (const name of REVIEWS) {
    await film.timed(
      () => expect(row(ui, name, "1 agent idle")).toBeVisible({ timeout: 180_000 }),
      1
    );
  }
  await sleep(2500);

  // ── 4. Hibernate until CI passes ─────────────────────────────────────────
  await film.chapter("Sleep until CI is green", {
    setup: () => shortcutMode(driver, ["Enter"], 300),
  });
  film.caption(`${API} has a flaky test: hand it to an agent in flaky-test`);
  await selectProject(ui, API);
  await createWorkspace(driver, "flaky-test", PROMPTS.flaky);
  film.caption(`flaky-test's agent fixes the test and opens PR #${OWN_PR}`);
  await film.timed(
    () => within(agents.served("flaky-test", 0, 2), 120_000, "flaky-test commit"),
    2
  );
  film.caption(`Waiting on CI, flaky-test hibernates — a wakeup script watches PR #${OWN_PR}`);
  agents.open("hibernate");
  await expect(row(ui, "flaky-test", "Hibernated")).toBeVisible({ timeout: 60_000 });
  // Hibernating moves the view on to an idle agent; flaky-test is a row now.
  film.spotlight(await rowBox(ui, "flaky-test"));
  await parkPointer(ui);
  await sleep(4500);
  github.passCi();
  await film.timed(
    () => expect(row(ui, "flaky-test", "1 agent busy")).toBeVisible({ timeout: 60_000 }),
    0.6
  );
  film.caption("CI passed: the script wakes flaky-test, whose agent finishes up");
  await film.timed(
    () => expect(row(ui, "flaky-test", "1 agent idle")).toBeVisible({ timeout: 120_000 }),
    1
  );
  await sleep(3000);

  // ── 5. Pick one ──────────────────────────────────────────────────────────
  await film.chapter("Pick the winner", {
    setup: async () => {
      for (const name of VARIANTS) {
        await expect(row(ui, name, "1 agent idle")).toBeVisible({ timeout: 180_000 });
      }
      await switchTo(driver, "restyle");
    },
  });
  film.caption("restyle's agent lines up the three looks and asks which one to keep");
  agents.open("compare");
  const terminal = await agentTerminal(driver, "restyle");
  await film.timed(
    () => expect(terminal).toContainText("Which look should Nimbus keep?", { timeout: 120_000 }),
    1
  );
  await sleep(4000);
  await terminal.click();
  await parkPointer(ui);
  for (let i = 0; i < PICK_INDEX; i++) {
    await ui.keyboard.press("ArrowDown");
    await sleep(700);
  }
  await sleep(800);
  await ui.keyboard.press("Enter");
  film.caption(`restyle keeps ${PICK} and deletes the rest — itself included`);
  for (const name of VARIANTS.filter((name) => name !== PICK)) {
    await film.timed(() => expect(workspaceRow(ui, name)).toBeHidden({ timeout: 120_000 }), 1.5);
  }
  await waitForWorkspaceFrame(driver, PICK, 60_000);
  await film.timed(() => expect(workspaceRow(ui, "restyle")).toBeHidden({ timeout: 120_000 }), 1.5);
  film.caption("CodeHydra — many agents, one window");
  await sleep(1500);
  film.markPoster();
  await sleep(4000);

  expect(agents.unexpected, "requests the scripts could not answer").toEqual([]);
  await film.stop();
  film.encode(OUTPUT, POSTER);
});

/** A workspace's sidebar row whose status starts with `status`. */
function row(ui: Page, name: string, status: string): ReturnType<Page["getByRole"]> {
  return ui.getByRole("button", { name: new RegExp(`^${name} in \\S+ - ${status}`) });
}

/** Start cloning `repo` "from GitHub" from the New workspace form. */
async function clone(ui: Page, repo: string): Promise<void> {
  await ui.getByRole("button", { name: "Clone from Git" }).click();
  const url = ui.getByRole("textbox", { name: "Repository URL" });
  await expect(url).toBeVisible();
  await url.pressSequentially(slug(repo), { delay: 70 });
  await sleep(500);
  await ui.getByRole("button", { name: "Clone", exact: true }).click();
  await parkPointer(ui);
}

/** Wait until the clone of `repo` is done and selected in the form. */
async function cloned(ui: Page, repo: string): Promise<void> {
  await expect(projectField(ui)).toHaveValue(repo, { timeout: 120_000 });
  await expect(nameField(ui)).toBeEnabled();
}

/** A workspace's sidebar row, padded, for a spotlight. */
async function rowBox(ui: Page, name: string): Promise<Box> {
  const box = await workspaceRow(ui, name).boundingBox();
  if (!box) throw new Error(`no row for ${name}`);
  return { x: box.x, y: box.y - 3, width: box.width, height: box.height + 6 };
}

/**
 * The sidebar below `lastRowAbove` — the next project's part of the list,
 * including rows that appear there later.
 */
async function projectBox(ui: Page, lastRowAbove: string): Promise<Box> {
  const above = await rowBox(ui, lastRowAbove);
  const top = above.y + above.height;
  return { x: 0, y: top, width: above.x + above.width, height: LOGICAL.h * 0.75 - top };
}

/** The New workspace form's project field. */
function projectField(ui: Page): ReturnType<Page["locator"]> {
  return ui.locator("#project-input");
}

/** Pick `project` in the New workspace form, on camera. */
async function selectProject(ui: Page, project: string): Promise<void> {
  const field = projectField(ui);
  await expect(field).toBeVisible();
  await field.click();
  await sleep(600);
  await ui.getByRole("option", { name: project, exact: true }).click();
  await expect(field).toHaveValue(project);
  await parkPointer(ui);
  await sleep(600);
}

/** Reject if `promise` has not settled within `ms`. */
async function within(promise: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill the New workspace form on camera and create. Typed, not filled, so the
 * entry is visible; the prompt goes to the new workspace's agent.
 */
async function createWorkspace(driver: AppDriver, name: string, prompt: string): Promise<void> {
  const ui = driver.uiPage();
  const panel = ui.getByRole("region", { name: "New workspace" });
  await expect(panel).toBeVisible();
  await expect(baseBranchField(ui)).not.toHaveValue("", { timeout: 60_000 });
  const field = nameField(ui);
  await field.click();
  await field.pressSequentially(name, { delay: 55 });
  await expect(field).toHaveValue(name);
  // Escape only when the suggestions are open: otherwise it closes the form.
  if ((await field.getAttribute("aria-expanded")) === "true") {
    await ui.keyboard.press("Escape");
    await expect(field).toHaveAttribute("aria-expanded", "false");
  }
  const promptBox = ui.getByRole("textbox", { name: "Prompt" });
  await promptBox.click();
  await promptBox.pressSequentially(prompt, { delay: 12 });
  await sleep(700);
  const create = panel.getByRole("button", { name: "Create" });
  await expect(create).not.toHaveAttribute("disabled", /.*/, { timeout: 60_000 });
  await create.click();
  await parkPointer(ui);
  await expect(workspaceRow(ui, name)).toBeVisible({ timeout: 120_000 });
  await waitForWorkspaceFrame(driver, name);
  await sleep(1200);
}

/** Click a workspace's row and wait until it is the one shown. */
async function switchTo(driver: AppDriver, name: string): Promise<void> {
  await workspaceRow(driver.uiPage(), name).click();
  await parkPointer(driver.uiPage());
  await waitForWorkspaceFrame(driver, name, 60_000);
  await sleep(600);
}

/**
 * Rest the pointer in the docked sidebar's empty middle, below the rows and
 * above the notification cards. Left where a click put it, it hovers whatever
 * comes under it next — a row, or the workspace frame itself — and that
 * tooltip shows on camera.
 */
async function parkPointer(ui: Page): Promise<void> {
  await ui.mouse.move(125, Math.round(LOGICAL.h * 0.62));
}

/**
 * Hold Alt, tap X, tap `keys` (Electron accelerator names: `Right`, not
 * `ArrowRight`), release — CodeHydra's shortcut mode.
 *
 * Synthesized from the MAIN process: shortcut mode is detected in
 * `before-input-event`, which Playwright's CDP keyboard never reaches, and
 * `webContents.sendInputEvent` does.
 */
async function shortcutMode(
  driver: AppDriver,
  keys: readonly string[],
  pauseMs = 1100
): Promise<void> {
  const send = (keyCode: string, type: "keyDown" | "keyUp", alt: boolean): Promise<void> =>
    driver.electron().evaluate(
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
  await sleep(200);
  await send("x", "keyDown", true);
  await send("x", "keyUp", true);
  await sleep(pauseMs); // the hint overlay, on camera
  for (const key of keys) {
    await send(key, "keyDown", true);
    await send(key, "keyUp", true);
    await sleep(pauseMs);
  }
  await send("Alt", "keyUp", false);
  await sleep(400);
}

/** The agent terminal of a workspace, its tab brought to the front. */
async function agentTerminal(
  driver: AppDriver,
  name: string
): Promise<ReturnType<Page["locator"]>> {
  const frame = driver
    .uiPage()
    .frames()
    .find((f) => f.url().includes(`${name}.code-workspace`));
  if (!frame) throw new Error(`no frame for ${name}`);
  return frame.locator(".xterm-screen:visible").first();
}
