// @vitest-environment node
/**
 * WorkspacesRootModule: the `paths.workspaces` setting, the root in use, and the
 * app:start `migrations` hook that settles a change on the starting screen.
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
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState } from "../../boundaries/platform/state.test-utils";
import { createMockPathProvider } from "../../boundaries/platform/path-provider.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../../boundaries/platform/paths";
import { createMockDialogManager } from "../presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { INTENT_APP_SHUTDOWN } from "../../intents/app-shutdown";
import type { HookContext } from "../../intents/lib/operation";
import type { DialogConfig } from "../../shared/dialog-types";
import { testPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import { generateProjectId } from "../local-project-module";
import { createWorkspacesRootModule, CURRENT_ROOT_STATE_KEY, WORKSPACES_ROOT_KEY } from "./module";
import { workspacesDirUnder, type ProjectMove } from "./workspaces-root";

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
  readonly configured?: string | null;
  readonly current?: string | null;
  readonly entries?: Record<string, ReturnType<typeof directory> | ReturnType<typeof file>>;
  readonly failRepair?: boolean;
}

/** The entries plus a directory entry for every ancestor, as a real tree has. */
function withParents(
  entries: Record<string, ReturnType<typeof directory> | ReturnType<typeof file>>
): Record<string, ReturnType<typeof directory> | ReturnType<typeof file>> {
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
      [new Path(OLD_CLONE, ".git", "HEAD").toString()]: file("ref: refs/heads/main"),
      [new Path(
        DATA,
        "screenshots",
        generateProjectId(OLD_CLONE.toString()),
        "fix.png"
      ).toString()]: file("png"),
      ...(options.entries ?? {}),
    }),
  });

  const worktrees = [{ name: "fix", path: CLONE_WT.toString(), branch: "fix" }];
  const gitClient = createMockGitClient({
    repositories: {
      [LOCAL.toString()]: {
        branches: ["main", "feat"],
        currentBranch: "main",
        worktrees: [
          { name: "feat", path: LOCAL_WT.toString(), branch: "feat" },
          { name: "scratch", path: LOCAL_DETACHED.toString(), branch: null },
        ],
      },
      [OLD_CLONE.toString()]: { branches: ["main", "fix"], currentBranch: "main", worktrees },
      [NEW_CLONE.toString()]: { branches: ["main", "fix"], currentBranch: "main", worktrees },
    },
  });
  const repair = vi.spyOn(gitClient, "repairWorktrees");
  if (options.failRepair) repair.mockRejectedValue(new Error("repair failed"));

  const adopt = vi.fn(async () => undefined);
  const moves: ProjectMove[][] = [];
  const dialogs = createMockDialogManager();
  const notifications = createMockNotificationManager();
  const dispatch = vi.spyOn(notifications.dispatcher, "dispatch");
  const state = createMockState({ values: { [CURRENT_ROOT_STATE_KEY]: options.current ?? null } });
  const config = createMockConfig();

  const { module, root } = createWorkspacesRootModule({
    config,
    stateService: state,
    pathProvider: createMockPathProvider({
      dataRootDir: DATA,
      bundlesRootDir: testPath("/bundles"),
    }),
    fs,
    gitClient,
    adopt,
    ui: dialogs.ui,
    dispatcher: notifications.dispatcher,
    moveListeners: () => [
      async (m) => {
        moves.push([...m]);
      },
    ],
    logger: SILENT_LOGGER,
  });
  if (options.configured !== undefined && options.configured !== null) {
    void config.set(WORKSPACES_ROOT_KEY, options.configured);
  }

  const handler = module.hooks![APP_START_OPERATION_ID]!["migrations"]!.handler;
  const migrations = (): Promise<unknown> => handler({} as HookContext) as Promise<unknown>;

  return {
    fs,
    gitClient,
    repair,
    adopt,
    moves,
    dialogs,
    notifications,
    dispatch,
    state,
    config,
    root,
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
async function press(dialogs: ReturnType<typeof createMockDialogManager>, id: string) {
  for (let i = 0; i < 500; i++) {
    const handle = dialogs.lastHandle;
    if (handle && buttonState(handle.config, id)) {
      handle.emitAction(id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`No "${id}" button appeared`);
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

function exists(fs: ReturnType<typeof createFileSystemMock>, path: Path): boolean {
  return fs.$.entries.has(path.toString());
}

describe("WorkspacesRootModule", () => {
  describe("the root in use", () => {
    it("is the data root by default", () => {
      const { root } = setup();
      expect(root.current().equals(DATA)).toBe(true);
      expect(root.remotesDir().equals(new Path(DATA, "remotes"))).toBe(true);
      expect(root.workspacesDir(LOCAL).equals(workspacesDirUnder(DATA, LOCAL))).toBe(true);
    });

    it("follows the recorded root, not the setting", () => {
      const { root } = setup({ configured: NEW_ROOT.toNative() });
      expect(root.current().equals(DATA)).toBe(true);
    });
  });

  describe("the setting", () => {
    it("accepts an absolute folder, the data root, or nothing", () => {
      const { config } = setup();
      const def = config.getDefinitions().get(WORKSPACES_ROOT_KEY)!;
      expect(def.validate(NEW_ROOT.toNative())).toBe(NEW_ROOT.toNative());
      expect(def.validate(DATA.toNative())).toBe(DATA.toNative());
      expect(def.validate(null)).toBeNull();
    });

    it("rejects a relative path and folders inside the app's own", () => {
      const { config } = setup();
      const def = config.getDefinitions().get(WORKSPACES_ROOT_KEY)!;
      expect(def.validate("relative/dir")).toBeUndefined();
      expect(def.validate(new Path(DATA, "projects").toNative())).toBeUndefined();
      expect(def.validate(testPath("/bundles/x").toNative())).toBeUndefined();
    });
  });

  describe("migrations hook", () => {
    it("does nothing while the setting matches the root in use", async () => {
      const { migrations, dialogs } = setup();
      await migrations();
      expect(dialogs.handles).toHaveLength(0);
    });

    it("migrates: moves the clone, keeps workspaces in place, switches", async () => {
      const s = setup({ configured: NEW_ROOT.toNative() });
      const done = s.migrations();
      expect((await waitForButton(s.dialogs, "migrate")).disabled).toBe(false);
      await press(s.dialogs, "migrate");
      await done;

      // The clone moved.
      expect(exists(s.fs, new Path(NEW_CLONE, ".git", "HEAD"))).toBe(true);
      expect(exists(s.fs, OLD_CLONE)).toBe(false);
      // Its worktrees were reconnected to the copy.
      expect(s.repair).toHaveBeenCalledWith(NEW_CLONE, [CLONE_WT]);
      // Existing worktrees stay where they are, adopted; a detached one cannot be.
      expect(s.adopt).toHaveBeenCalledWith(LOCAL, LOCAL_WT, "feat");
      expect(s.adopt).toHaveBeenCalledWith(NEW_CLONE, CLONE_WT, "fix");
      expect(s.adopt).toHaveBeenCalledTimes(2);
      // The new root is in use.
      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
      // Path-keyed state and screenshots follow the clone.
      expect(s.moves).toEqual([[{ from: OLD_CLONE.toString(), to: NEW_CLONE.toString() }]]);
      expect(
        exists(
          s.fs,
          new Path(DATA, "screenshots", generateProjectId(NEW_CLONE.toString()), "fix.png")
        )
      ).toBe(true);
      // The detached worktree is reported, not silently dropped.
      await s.notifications.settle();
      expect(s.notifications.lastNotification?.opened.message).toContain(LOCAL_DETACHED.toString());
      expect(s.dialogs.lastHandle!.closed).toBe(true);
    });

    it("offers Migrate only for an empty folder", async () => {
      const s = setup({
        configured: NEW_ROOT.toNative(),
        entries: { [new Path(NEW_ROOT, "something").toString()]: file("x") },
      });
      const done = s.migrations();
      expect((await waitForButton(s.dialogs, "migrate")).disabled).toBe(true);
      await press(s.dialogs, "adopt");
      await done;
    });

    it("uses the folder as is: switches, moves nothing", async () => {
      const s = setup({ configured: NEW_ROOT.toNative() });
      const done = s.migrations();
      await press(s.dialogs, "adopt");
      await done;

      expect(s.root.current().equals(NEW_ROOT)).toBe(true);
      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);
      expect(s.adopt).not.toHaveBeenCalled();
      expect(s.repair).not.toHaveBeenCalled();
    });

    it("quits without returning", async () => {
      const s = setup({ configured: NEW_ROOT.toNative() });
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
    });

    it("refuses a folder inside a project, and can continue with the current one", async () => {
      const inside = new Path(LOCAL, "sub").toNative();
      const s = setup({ configured: inside });
      const done = s.migrations();
      await waitForButton(s.dialogs, "continue");
      expect(buttonState(s.dialogs.lastHandle!.config, "migrate")).toBeUndefined();
      await press(s.dialogs, "continue");
      await done;

      expect(s.root.current().equals(DATA)).toBe(true);
    });

    it("undoes a failed migration and keeps the current root", async () => {
      const s = setup({ configured: NEW_ROOT.toNative(), failRepair: true });
      const done = s.migrations();
      await press(s.dialogs, "migrate");
      await waitForButton(s.dialogs, "retry");

      // The partial copy is gone, nothing was adopted, the old clone is intact.
      expect(exists(s.fs, NEW_CLONE)).toBe(false);
      expect(s.adopt).not.toHaveBeenCalled();
      expect(exists(s.fs, new Path(OLD_CLONE, ".git", "HEAD"))).toBe(true);

      await press(s.dialogs, "continue");
      await done;
      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.moves).toEqual([]);
    });

    it("migrates back to the data root", async () => {
      const s = setup({
        current: NEW_ROOT.toNative(),
        entries: {
          [new Path(NEW_CLONE, ".git", "HEAD").toString()]: file("ref: refs/heads/main"),
        },
      });
      // The setting was cleared: the data root is wanted again.
      const done = s.migrations();
      await press(s.dialogs, "adopt");
      await done;

      expect(s.root.current().equals(DATA)).toBe(true);
      expect(s.state.getEffective()[CURRENT_ROOT_STATE_KEY]).toBeNull();
    });
  });
});
