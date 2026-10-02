// @vitest-environment node
/**
 * WorkspacesRootModule: the root in use (`paths.workspaces` state), the Change
 * dialog that requests a move, and the app:start `migrations` hook that runs a
 * requested move on the starting screen.
 *
 * Runs against the behavioral filesystem, git and dialog mocks. The git mock
 * cannot see a copied directory, so the new clone is seeded as a repository up
 * front — standing in for "git sees the copy".
 */

import { describe, it, expect, vi } from "vitest";
import nodePath from "node:path";
import {
  createFileSystemMock,
  directory,
  file,
  symlink,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState } from "../../boundaries/platform/state.test-utils";
import { createMockPathProvider } from "../../boundaries/platform/path-provider.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { createAppBoundaryMock } from "../../boundaries/shell/app.state-mock";
import { createBehavioralDialogBoundary } from "../../boundaries/shell/dialog.test-utils";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../../boundaries/platform/paths";
import { createMockDialogManager } from "../presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { INTENT_APP_SHUTDOWN } from "../../intents/app-shutdown";
import {
  EVENT_AGENT_STATUS_UPDATED,
  type AgentStatusUpdatedEvent,
} from "../../intents/update-agent-status";
import type { HookContext } from "../../intents/lib/operation";
import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import type { ProjectId, WorkspaceName } from "../../intents/contract";
import { testPath, workspaceRefIn } from "../../shared/test-fixtures";
import type { Entry } from "../../boundaries/platform/filesystem.state-mock";
import { Path } from "../../utils/path/path";
import { generateProjectId } from "../local-project-module";
import {
  ADOPTIONS_CONVERTED_STATE_KEY,
  createWorkspacesRootModule,
  LEGACY_CURRENT_STATE_KEY,
  LEGACY_ROOT_CONFIG_KEY,
  PENDING_ROOT_STATE_KEY,
  ROOT_STATE_KEY,
} from "./module";
import { workspacesDirUnder } from "./workspaces-root";
import { projectRefFor } from "../../utils/ref";

const DATA = testPath("/data");
const NEW_ROOT = testPath("/devdrive/ch");
const LOCAL = testPath("/code/app");
const URL = "https://github.com/org/lib.git";
const OLD_CLONE = managedClonePath(new Path(DATA, "remotes"), URL);
const NEW_CLONE = managedClonePath(new Path(NEW_ROOT, "remotes"), URL);
const LOCAL_WT = new Path(workspacesDirUnder(DATA, LOCAL), "feat");
const LOCAL_DETACHED = new Path(workspacesDirUnder(DATA, LOCAL), "scratch");
const CLONE_WT = new Path(workspacesDirUnder(DATA, OLD_CLONE), "fix");

interface SetupOptions {
  /** The root in use (`paths.workspaces` state). */
  readonly inUse?: string | null;
  /** A requested move (`paths.workspaces-pending`). */
  readonly pending?: string | null;
  /** Earlier releases: the setting, and the root in use. */
  readonly legacyConfigured?: string | null;
  readonly legacyCurrent?: string | null;
  readonly entries?: Record<string, Entry>;
  readonly failRepair?: boolean;
  /** Seed the clone under the data root (default true). */
  readonly dataClone?: boolean;
  /** More worktrees of the local project, and its branches' config. */
  readonly localWorktrees?: readonly { name: string; path: string; branch: string | null }[];
  readonly localBranchConfigs?: Record<string, Record<string, string>>;
  /** Initial state.json values besides the root keys. */
  readonly state?: Record<string, unknown>;
}

/** The entries plus a directory entry for every ancestor, as a real tree has. */
function withParents(entries: Record<string, Entry>): Record<string, Entry> {
  const out = { ...entries };
  for (const key of Object.keys(entries)) {
    // Walk on strings: Path rejects a bare drive (`c:`), which is what the parent
    // of a Windows root would be. Stop below the root.
    let parent = nodePath.dirname(new Path(key).toNative());
    while (nodePath.dirname(parent) !== parent) {
      out[new Path(parent).toString()] ??= directory();
      parent = nodePath.dirname(parent);
    }
  }
  return out;
}

function setup(options: SetupOptions = {}) {
  const records = new Path(DATA, "projects");
  const fs = createFileSystemMock({
    entries: withParents({
      [new Path(records, projectDirName(LOCAL.toString()), "config.json").toString()]: file(
        JSON.stringify({ path: LOCAL.toString() })
      ),
      [new Path(records, managedProjectDirName(URL), "config.json").toString()]: file(
        JSON.stringify({ remoteUrl: URL })
      ),
      ...(options.dataClone === false
        ? {}
        : { [new Path(OLD_CLONE, ".git", "HEAD").toString()]: file("ref: refs/heads/main") }),
      [new Path(
        DATA,
        "screenshots",
        generateProjectId(OLD_CLONE.toString(), "linux"),
        "fix.png"
      ).toString()]: file("png"),
      ...(options.entries ?? {}),
    }),
  });

  const worktrees = [{ name: "fix", path: CLONE_WT.toString(), branch: "fix" }];
  const gitClient = createMockGitClient({
    repositories: {
      [LOCAL.toString()]: {
        branches: [
          "main",
          "feat",
          ...(options.localWorktrees ?? []).flatMap((wt) => wt.branch ?? []),
        ],
        currentBranch: "main",
        worktrees: [
          { name: "feat", path: LOCAL_WT.toString(), branch: "feat" },
          { name: "scratch", path: LOCAL_DETACHED.toString(), branch: null },
          ...(options.localWorktrees ?? []),
        ],
        ...(options.localBranchConfigs && { branchConfigs: options.localBranchConfigs }),
      },
      [OLD_CLONE.toString()]: { branches: ["main", "fix"], currentBranch: "main", worktrees },
      [NEW_CLONE.toString()]: { branches: ["main", "fix"], currentBranch: "main", worktrees },
    },
  });
  const repair = vi.spyOn(gitClient, "repairWorktrees");
  if (options.failRepair) repair.mockRejectedValue(new Error("repair failed"));

  const dialogs = createMockDialogManager();
  const notifications = createMockNotificationManager();
  const dispatch = vi.spyOn(notifications.dispatcher, "dispatch");
  const state = createMockState({
    values: {
      [ROOT_STATE_KEY]: options.inUse ?? null,
      [PENDING_ROOT_STATE_KEY]: options.pending ?? null,
      [LEGACY_CURRENT_STATE_KEY]: options.legacyCurrent ?? null,
      ...options.state,
    },
  });
  const config = createMockConfig({
    defaults: { [LEGACY_ROOT_CONFIG_KEY]: options.legacyConfigured ?? null },
  });
  const picker = createBehavioralDialogBoundary();
  const app = createAppBoundaryMock({ platform: "linux" });

  const { module, root, settingsRow } = createWorkspacesRootModule({
    config,
    stateService: state,
    pathProvider: createMockPathProvider({
      dataRootDir: DATA,
      bundlesRootDir: testPath("/bundles"),
    }),
    fs,
    gitClient,
    ui: dialogs.ui,
    dialog: picker,
    app,
    dispatcher: notifications.dispatcher,
    platform: "linux",
    logger: SILENT_LOGGER,
  });

  const handler = module.hooks![APP_START_OPERATION_ID]!["migrations"]!.handler;
  const migrations = (): Promise<unknown> => handler({} as HookContext) as Promise<unknown>;

  return {
    fs,
    gitClient,
    repair,
    dialogs,
    notifications,
    dispatch,
    state,
    config,
    picker,
    app,
    module,
    root,
    settingsRow,
    migrations,
  };
}

function buttonState(cfg: DialogConfig, id: string): { disabled: boolean } | undefined {
  for (const section of cfg.sections) {
    if (section.type !== "group") continue;
    for (const item of section.items) {
      if (item.type === "button" && item.id === id) return { disabled: item.disabled === true };
    }
  }
  return undefined;
}

/** Wait until the open dialog offers `id`, then press it. */
async function press(
  dialogs: ReturnType<typeof createMockDialogManager>,
  id: string,
  data?: Record<string, string>
) {
  await waitForButton(dialogs, id);
  dialogs.lastHandle!.emitAction(id, data);
}

async function waitForButton(dialogs: ReturnType<typeof createMockDialogManager>, id: string) {
  for (let i = 0; i < 500; i++) {
    const handle = dialogs.lastHandle;
    const found = handle ? buttonState(handle.config, id) : undefined;
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`No "${id}" button appeared`);
}

/** Wait until the open dialog's config satisfies `check`. */
async function waitFor(
  dialogs: ReturnType<typeof createMockDialogManager>,
  check: (cfg: DialogConfig) => boolean
): Promise<DialogConfig> {
  for (let i = 0; i < 500; i++) {
    const handle = dialogs.lastHandle;
    if (handle && check(handle.config)) return handle.config;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The dialog never reached the expected state");
}

/** Every input section, top level or inside a group. */
function inputs(cfg: DialogConfig): Extract<DialogSection, { type: "input" }>[] {
  const out: Extract<DialogSection, { type: "input" }>[] = [];
  for (const section of cfg.sections) {
    if (section.type === "input") out.push(section);
    if (section.type === "group") {
      for (const item of section.items) if (item.type === "input") out.push(item);
    }
  }
  return out;
}

function folderField(cfg: DialogConfig): Extract<DialogSection, { type: "input" }> | undefined {
  return inputs(cfg).find((input) => input.id === "folder");
}

function texts(cfg: DialogConfig): string[] {
  return cfg.sections.flatMap((section) => (section.type === "text" ? [section.content] : []));
}

function exists(fs: ReturnType<typeof createFileSystemMock>, path: Path): boolean {
  return fs.$.entries.has(path.toString());
}

/** Branches of a repository carrying the external tag. */
async function externalTags(
  gitClient: ReturnType<typeof createMockGitClient>,
  repo: Path
): Promise<string[]> {
  const entries = await gitClient.getGitConfig(repo, { regex: "\\.codehydra\\.tags\\.external$" });
  return [...entries.keys()];
}

/** An agent status report for a workspace of the local project. */
function agentStatus(name: string, status: "busy" | "idle"): AgentStatusUpdatedEvent {
  return {
    type: EVENT_AGENT_STATUS_UPDATED,
    payload: {
      projectId: "app-1234" as ProjectId,
      projectRef: projectRefFor(LOCAL_WT.dirname.toString()),
      workspaceName: name as WorkspaceName,
      workspaceRef: workspaceRefIn(LOCAL_WT.dirname.toString(), name),
      active: false,
      status: {
        status,
        counts: { idle: status === "idle" ? 1 : 0, busy: status === "busy" ? 1 : 0 },
      },
    },
  } as AgentStatusUpdatedEvent;
}

describe("WorkspacesRootModule", () => {
  describe("the root in use", () => {
    it("is the data root by default", () => {
      const { root } = setup();
      expect(root.current().equals(DATA)).toBe(true);
      expect(root.remotesDir().equals(new Path(DATA, "remotes"))).toBe(true);
      expect(root.workspacesDir(LOCAL).equals(workspacesDirUnder(DATA, LOCAL))).toBe(true);
    });

    it("follows the recorded root, not a request", () => {
      const { root } = setup({ inUse: NEW_ROOT.toNative(), pending: DATA.toNative() });
      expect(root.current().equals(NEW_ROOT)).toBe(true);
    });
  });

  describe("migrations hook", () => {
    it("does nothing without a request", async () => {
      const { migrations, dialogs, state } = setup();
      await migrations();
      expect(dialogs.handles).toHaveLength(0);
      expect(state.getEffective()[ROOT_STATE_KEY]).toBeNull();
    });

    it("migrates without asking: moves the clone, keeps workspaces in place, switches", async () => {
      const s = setup({ pending: NEW_ROOT.toNative() });
      await s.migrations();

      // The clone moved.
      expect(exists(s.fs, new Path(NEW_CLONE, ".git", "HEAD"))).toBe(true);
      expect(exists(s.fs, OLD_CLONE)).toBe(false);
      // Its worktrees were reconnected to the copy.
      expect(s.repair).toHaveBeenCalledWith(NEW_CLONE, [CLONE_WT]);
      // Existing worktrees stay where they are, and are not tagged as external.
      expect(await externalTags(s.gitClient, LOCAL)).toEqual([]);
      expect(await externalTags(s.gitClient, NEW_CLONE)).toEqual([]);
      // The new root is in use and the request is settled.
      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
      // Screenshots follow the clone.
      expect(
        exists(
          s.fs,
          new Path(DATA, "screenshots", generateProjectId(NEW_CLONE.toString(), "linux"), "fix.png")
        )
      ).toBe(true);
      // Their directories are recorded, so every worktree there — the detached
      // one, or one whose agent checks out another branch — stays a workspace.
      expect(s.root.previousWorkspacesDirs().map((dir) => dir.toString())).toEqual([
        workspacesDirUnder(DATA, LOCAL).toString(),
        workspacesDirUnder(DATA, OLD_CLONE).toString(),
      ]);
      await s.notifications.settle();
      expect(s.notifications.lastNotification).toBeNull();
      expect(s.dialogs.handles).toHaveLength(1);
      expect(buttonState(s.dialogs.lastHandle!.config, "retry")).toBeUndefined();
      expect(s.dialogs.lastHandle!.closed).toBe(true);
    });

    it("refuses a folder that is not empty, and can continue with the current one", async () => {
      const s = setup({
        pending: NEW_ROOT.toNative(),
        entries: { [new Path(NEW_ROOT, "something").toString()]: file("x") },
      });
      const done = s.migrations();
      await waitForButton(s.dialogs, "continue");
      expect(texts(s.dialogs.lastHandle!.config).join("\n")).toContain("It is not empty.");
      await press(s.dialogs, "continue");
      await done;

      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);
    });

    it("refuses a folder inside a project", async () => {
      const s = setup({ pending: new Path(LOCAL, "sub").toNative() });
      const done = s.migrations();
      await waitForButton(s.dialogs, "continue");
      expect(texts(s.dialogs.lastHandle!.config).join("\n")).toContain("inside the project");
      await press(s.dialogs, "continue");
      await done;

      expect(s.root.current().equals(DATA)).toBe(true);
    });

    it("checks again on Retry", async () => {
      const blocker = new Path(NEW_ROOT, "something");
      const s = setup({
        pending: NEW_ROOT.toNative(),
        entries: { [blocker.toString()]: file("x") },
      });
      const done = s.migrations();
      await waitForButton(s.dialogs, "retry");
      await s.fs.unlink(blocker);
      await press(s.dialogs, "retry");
      await done;

      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
    });

    it("quits without returning, and keeps the request", async () => {
      const s = setup({ pending: new Path(LOCAL, "sub").toNative() });
      let settled = false;
      void s.migrations().then(() => {
        settled = true;
      });
      await press(s.dialogs, "quit");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(s.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_APP_SHUTDOWN })
      );
      expect(settled).toBe(false);
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).not.toBeNull();
    });

    it("undoes a failed migration and keeps the current root", async () => {
      const s = setup({ pending: NEW_ROOT.toNative(), failRepair: true });
      const done = s.migrations();
      await waitForButton(s.dialogs, "retry");

      // The partial copy is gone, nothing was recorded, the old clone is intact.
      expect(exists(s.fs, NEW_CLONE)).toBe(false);
      expect(s.root.previousWorkspacesDirs()).toEqual([]);
      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);

      await press(s.dialogs, "continue");
      await done;
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
    });

    it("records a folder reached through a symlink as git will report it", async () => {
      const link = testPath("/links/devdrive");
      const s = setup({
        pending: link.toNative(),
        entries: {
          [NEW_ROOT.toString()]: directory(),
          [link.toString()]: symlink(NEW_ROOT.toString()),
        },
      });
      await s.migrations();

      // Worktrees created under the root must lie inside it once git names them.
      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
    });

    it("drops a request that names the folder in use through a symlink", async () => {
      const link = testPath("/links/data");
      const s = setup({
        pending: link.toNative(),
        entries: { [link.toString()]: symlink(DATA.toString()) },
      });

      await s.migrations();

      expect(s.dialogs.handles).toHaveLength(0);
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
    });

    it("migrates back to the data root, as the Windows data-root move requests", async () => {
      // NEW_ROOT stands in for the old data root, still holding the source code.
      const s = setup({
        inUse: NEW_ROOT.toNative(),
        pending: DATA.toNative(),
        dataClone: false,
        entries: {
          [new Path(NEW_CLONE, ".git", "HEAD").toString()]: file("ref: refs/heads/main"),
        },
      });
      await s.migrations();

      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);
      expect(exists(s.fs, NEW_CLONE)).toBe(false);
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[ROOT_STATE_KEY]).toBeNull();
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
    });
  });

  describe("the keys of earlier releases", () => {
    it("carry the root in use over", async () => {
      const s = setup({
        legacyConfigured: NEW_ROOT.toNative(),
        legacyCurrent: NEW_ROOT.toNative(),
      });
      await s.migrations();

      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
      expect(s.dialogs.handles).toHaveLength(0);
      expect(s.state.getEffective()[LEGACY_CURRENT_STATE_KEY]).toBeNull();
    });

    it("turn a setting that was never applied into a migration", async () => {
      const s = setup({ legacyConfigured: NEW_ROOT.toNative() });
      await s.migrations();

      expect(exists(s.fs, new Path(NEW_CLONE, ".git", "HEAD"))).toBe(true);
      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
    });

    it("move the source code the Windows data-root move left behind", async () => {
      // An earlier release recorded the old data root as in use; the setting was unset.
      const s = setup({
        legacyCurrent: NEW_ROOT.toNative(),
        dataClone: false,
        entries: {
          [new Path(NEW_CLONE, ".git", "HEAD").toString()]: file("ref: refs/heads/main"),
        },
      });
      await s.migrations();

      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);
      expect(s.root.current().equals(DATA)).toBe(true);
    });
  });

  describe("Change dialog", () => {
    /** Open it from the settings row. */
    function open(s: ReturnType<typeof setup>) {
      s.settingsRow.action.run();
      return s.dialogs.lastHandle!;
    }

    it("shows the root in use in the settings row", () => {
      expect(setup().settingsRow.value()).toContain("app data folder");
      expect(setup({ inUse: NEW_ROOT.toNative() }).settingsRow.value()).toBe(NEW_ROOT.toNative());
    });

    it("requests a migration and restarts", async () => {
      const s = setup();
      const handle = open(s);
      expect(folderField(handle.config)?.value).toBe("");

      await press(s.dialogs, "migrate", { folder: NEW_ROOT.toNative() });
      await press(s.dialogs, "confirm");
      await vi.waitFor(() => expect(s.app).toHaveRelaunchCount(1));

      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBe(NEW_ROOT.toNative());
      // Nothing moved yet: the next start does that.
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);
    });

    it("fills the field from the folder picker", async () => {
      const s = setup();
      open(s);
      s.picker._setNextOpenDialogResponse({ canceled: false, filePaths: [NEW_ROOT.toString()] });
      await press(s.dialogs, "browse", { folder: "" });

      const cfg = await waitFor(s.dialogs, (c) => folderField(c)?.value === NEW_ROOT.toNative());
      expect(buttonState(cfg, "migrate")).toBeDefined();
    });

    it.each([
      ["a relative path", "relative/dir", "absolute path"],
      ["a folder inside the app's own", new Path(DATA, "projects").toNative(), "app's own"],
      ["the folder in use", DATA.toNative(), "in use"],
      ["a folder inside a project", new Path(LOCAL, "sub").toNative(), "inside the project"],
    ])("refuses %s", async (_name, folder, reason) => {
      const s = setup();
      open(s);
      await press(s.dialogs, "migrate", { folder });

      const cfg = await waitFor(s.dialogs, (c) => folderField(c)?.error !== undefined);
      expect(folderField(cfg)!.error).toContain(reason);
      expect(buttonState(cfg, "confirm")).toBeUndefined();
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
    });

    it("refuses a folder that is not empty", async () => {
      const s = setup({ entries: { [new Path(NEW_ROOT, "x").toString()]: file("x") } });
      open(s);
      await press(s.dialogs, "migrate", { folder: NEW_ROOT.toNative() });

      const cfg = await waitFor(s.dialogs, (c) => folderField(c)?.error !== undefined);
      expect(folderField(cfg)!.error).toContain("not empty");
    });

    it("warns about agents still working", async () => {
      const s = setup();
      const handler = s.module.events![EVENT_AGENT_STATUS_UPDATED]!.handler;
      await handler(agentStatus("feat", "busy"));
      await handler(agentStatus("other", "busy"));
      await handler(agentStatus("other", "idle"));
      open(s);
      await press(s.dialogs, "migrate", { folder: NEW_ROOT.toNative() });

      const cfg = await waitFor(s.dialogs, (c) => buttonState(c, "confirm") !== undefined);
      const warning = cfg.sections.find(
        (section) => section.type === "text" && section.style === "warning"
      );
      expect(warning).toMatchObject({ content: expect.stringContaining("feat") });
      expect(texts(cfg).join("\n")).not.toContain("other");
    });

    it("goes back to the folder, and cancels without requesting anything", async () => {
      const s = setup();
      open(s);
      await press(s.dialogs, "migrate", { folder: NEW_ROOT.toNative() });
      await press(s.dialogs, "back");
      const cfg = await waitFor(s.dialogs, (c) => folderField(c) !== undefined);
      expect(folderField(cfg)!.value).toBe(NEW_ROOT.toNative());

      await press(s.dialogs, "cancel");
      expect(s.dialogs.lastHandle!.closed).toBe(true);
      expect(s.state.getEffective()[PENDING_ROOT_STATE_KEY]).toBeNull();
      expect(s.app).toHaveRelaunchCount(0);
    });
  });

  describe("adoptions an earlier migration wrote", () => {
    // A worktree an old migration left under the Roaming data root, tagged external.
    const ROAMING = testPath("/roaming");
    const OLD_DIR = new Path(ROAMING, "projects", "app-1234abcd", "workspaces");
    const MIGRATED = new Path(OLD_DIR, "twin");
    // One the user adopted from the add-project picker.
    const HANDMADE = testPath("/code/app-extra");
    const TAG = { "codehydra.tags.external": '{"color":"#8b949e"}' };

    const tagged = (options: SetupOptions = {}) =>
      setup({
        localWorktrees: [
          // Its agent has since checked out another branch: the tag sits on "twin".
          { name: "twin", path: MIGRATED.toString(), branch: "twin" },
          { name: "app-extra", path: HANDMADE.toString(), branch: "extra" },
        ],
        localBranchConfigs: { twin: TAG, extra: TAG },
        ...options,
      });

    it("records their directory and removes their tag", async () => {
      const s = tagged();
      await s.migrations();

      expect(s.root.previousWorkspacesDirs().map((dir) => dir.toString())).toEqual([
        OLD_DIR.toString(),
      ]);
      // The user's own adoption is not a migration's: it keeps its tag.
      expect(await externalTags(s.gitClient, LOCAL)).toEqual([
        "branch.extra.codehydra.tags.external",
      ]);
      expect(s.dialogs.handles).toHaveLength(0);
    });

    it("converts once", async () => {
      const s = tagged({ state: { [ADOPTIONS_CONVERTED_STATE_KEY]: true } });
      await s.migrations();

      expect(s.root.previousWorkspacesDirs()).toEqual([]);
      expect(await externalTags(s.gitClient, LOCAL)).toHaveLength(2);
    });

    it("marks the conversion done when there is nothing to convert", async () => {
      const s = setup();
      await s.migrations();

      expect(s.state.getEffective()[ADOPTIONS_CONVERTED_STATE_KEY]).toBe(true);
    });
  });
});
