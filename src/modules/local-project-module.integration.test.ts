// @vitest-environment node
/**
 * Integration tests for LocalProjectModule: the git project type's
 * contributions, run together with the real project store they hand records to.
 *
 * Covered: prepare (git init offer), resolve (validation, type "git" + config,
 * remoteUrl from the record), restore (a saved git project → its open
 * payload), close resolve/close (directories), managed clones' records, and
 * projectRefs. The store's own behavior is in project-store-module.integration.test.ts.
 */

import { gitProjectRef } from "./git-project-ref";
import { describe, it, expect, vi } from "vitest";

import {
  createLocalProjectModule,
  loadAllProjects,
  type LocalProjectModuleDeps,
} from "./local-project-module";
import { createProjectStoreModule, type ProjectStoreModule } from "./project-store-module";
import {
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  type ProjectTypeConfig,
} from "../intents/open-project";
import type { OpenProjectIntent } from "../intents/open-project";
import type { schemas as openProjectSchemas } from "../intents/open-project";
import {
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  type CloseHookInput,
  type CloseResolveHookInput,
} from "../intents/close-project";
import type { CloseProjectIntent } from "../intents/close-project";
import type { schemas as closeProjectSchemas } from "../intents/close-project";
import type { schemas as appReadySchemas } from "../intents/app-ready";
import { APP_READY_OPERATION_ID } from "../intents/app-ready";
import type { AppReadyIntent } from "../intents/app-ready";
import { Path } from "../utils/path/path";
import type {
  HookContext,
  ResolvedHooks,
  HookResult,
  HookOutput,
  OperationSchemas,
} from "../intents/lib/operation";
import type { IntentModule } from "../intents/lib/module";
import { createFileSystemMock, directory } from "../boundaries/platform/filesystem.state-mock";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "./presentation/notification-manager.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../boundaries/platform/paths";
import nodePath from "path";
import { projPath, testPath } from "../shared/test-fixtures";
import type { ProjectPath } from "../intents/contract";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = projPath("/test/local-project");
const PROJECTS_DIR = testPath("/test/app-data/projects").toNative();
const REMOTES_DIR = testPath("/test/app-data/remotes").toNative();
const REPO_URL = "https://github.com/user/repo.git";
/** Where the remote project module clones REPO_URL to — the managed project's path. */
const MANAGED_PATH = projPath(managedClonePath(REMOTES_DIR, REPO_URL).toString());
const MANAGED_RECORD = nodePath.join(PROJECTS_DIR, managedProjectDirName(REPO_URL), "config.json");

type MockFs = ReturnType<typeof createFileSystemMock>;

// =============================================================================
// Test Setup
// =============================================================================

/**
 * A ResolvedHooks running every given module's handler for a hook point, the way
 * the dispatcher does. Handlers that return no result contribute none.
 */
function hooksOf<S extends OperationSchemas>(
  modules: readonly IntentModule[],
  operationId: string
): ResolvedHooks<S> {
  return {
    collect: async <T>(hookPointId: string, ctx: HookContext): Promise<HookResult<T>> => {
      const results: T[] = [];
      const errors: Error[] = [];
      for (const module of modules) {
        const hookHandler = module.hooks?.[operationId]?.[hookPointId];
        if (!hookHandler) continue;
        try {
          const output = await hookHandler.handler(ctx);
          const result = (output as HookOutput<T> | undefined)?.result;
          if (result !== undefined && result !== null) results.push(result);
        } catch (error) {
          errors.push(error as Error);
        }
      }
      return { results, errors, capabilities: {} };
    },
  };
}

interface TestSetup {
  module: ReturnType<typeof createLocalProjectModule>;
  store: ProjectStoreModule;
  /** Only the git module's handlers. */
  openHooks: ResolvedHooks<typeof openProjectSchemas>;
  closeHooks: ResolvedHooks<typeof closeProjectSchemas>;
  readyHooks: ResolvedHooks<typeof appReadySchemas>;
  /** The store's and the git module's handlers together, as the app runs them. */
  both: {
    open: ResolvedHooks<typeof openProjectSchemas>;
    close: ResolvedHooks<typeof closeProjectSchemas>;
  };
  fs: MockFs;
  gitWorktreeProvider: LocalProjectModuleDeps["gitWorktreeProvider"];
  dialogManager: ReturnType<typeof createMockDialogManager>;
  gitClient: LocalProjectModuleDeps["gitClient"];
  notifications: ReturnType<typeof createMockNotificationManager>;
}

function createTestSetup(fsOverrides?: Parameters<typeof createFileSystemMock>[0]): TestSetup {
  const fs = createFileSystemMock({
    entries: {
      [PROJECTS_DIR]: directory(),
      ...(fsOverrides?.entries ?? {}),
    },
  });
  const gitWorktreeProvider = { validateRepository: vi.fn().mockResolvedValue(undefined) };
  const dialogManager = createMockDialogManager();
  const notifications = createMockNotificationManager();
  const gitClient = {
    isRepositoryRoot: vi.fn().mockResolvedValue(true),
    init: vi.fn().mockResolvedValue(undefined),
  };

  const store = createProjectStoreModule({
    projectsDir: PROJECTS_DIR,
    fs,
    platform: "linux",
    logger: SILENT_LOGGER,
  });
  const module = createLocalProjectModule({
    projectsDir: PROJECTS_DIR,
    remotesDir: () => REMOTES_DIR,
    fs,
    store,
    gitWorktreeProvider,
    ui: dialogManager.ui,
    dispatcher: notifications.dispatcher,
    gitClient,
    logger: SILENT_LOGGER,
  });

  return {
    module,
    store,
    openHooks: hooksOf([module], OPEN_PROJECT_OPERATION_ID),
    closeHooks: hooksOf([module], CLOSE_PROJECT_OPERATION_ID),
    readyHooks: hooksOf([module], APP_READY_OPERATION_ID),
    both: {
      open: hooksOf([store, module], OPEN_PROJECT_OPERATION_ID),
      close: hooksOf([store, module], CLOSE_PROJECT_OPERATION_ID),
    },
    fs,
    gitWorktreeProvider,
    dialogManager,
    gitClient,
    notifications,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Write a legacy (pre-type) git record to the mock filesystem, under the path-named dir. */
function writeConfig(fs: MockFs, projectPath: ProjectPath, remoteUrl?: string): void {
  const configDir = nodePath.join(PROJECTS_DIR, projectDirName(new Path(projectPath).toString()));
  const config = {
    path: projPath(new Path(projectPath).toString()),
    ...(remoteUrl !== undefined && { remoteUrl }),
  };
  fs.$.setEntry(configDir, { type: "directory" });
  fs.$.setEntry(nodePath.join(configDir, "config.json"), {
    type: "file",
    content: JSON.stringify(config, null, 2),
  });
}

function writeManagedRecord(fs: MockFs, content: unknown): void {
  fs.$.setEntry(nodePath.dirname(MANAGED_RECORD), { type: "directory" });
  fs.$.setEntry(MANAGED_RECORD, { type: "file", content: JSON.stringify(content) });
}

function readJson(fs: MockFs, file: string): unknown {
  const entry = fs.$.entries.get(new Path(file).toString());
  return entry?.type === "file" ? JSON.parse(String(entry.content)) : undefined;
}

function openLocalIntent(path: string): OpenProjectIntent {
  return { type: INTENT_OPEN_PROJECT, payload: { path: projPath(new Path(path).toString()) } };
}

function openGitIntent(url: string): OpenProjectIntent {
  return { type: INTENT_OPEN_PROJECT, payload: { git: url } };
}

function closeIntent(projectPath: ProjectPath): CloseProjectIntent {
  return { type: INTENT_CLOSE_PROJECT, payload: { projectRef: gitProjectRef(projectPath) } };
}

function closeResolveCtx(projectPath: ProjectPath): CloseResolveHookInput {
  return { intent: closeIntent(projectPath), projectRef: gitProjectRef(projectPath), projectPath };
}

function closeInput(
  options: { remoteUrl?: string; removeLocalRepo: boolean },
  projectPath: ProjectPath = PROJECT_PATH
): CloseHookInput {
  return {
    intent: closeIntent(projectPath),
    projectRef: gitProjectRef(projectPath),
    projectPath: projPath(new Path(projectPath).toString()),
    ...(options.remoteUrl !== undefined && { remoteUrl: options.remoteUrl }),
    removeLocalRepo: options.removeLocalRepo,
  };
}

function appReadyIntent(): AppReadyIntent {
  return { type: "app:ready", payload: {} as AppReadyIntent["payload"] };
}

/**
 * Open a project the way project:open does: the git module's resolve, then the
 * store's register with what resolve reported.
 */
async function open(setup: TestSetup, path: ProjectPath): Promise<void> {
  const { results, errors } = await setup.openHooks.collect("resolve", {
    intent: openLocalIntent(path),
  });
  if (errors.length > 0) throw errors[0];
  const resolved = results[0]!;
  const projectPath = resolved.projectPath!;
  const register = await setup.both.open.collect("register", {
    intent: openLocalIntent(path),
    projectPath,
    projectRef: gitProjectRef(projectPath, resolved.remoteUrl),
    ...(resolved.remoteUrl !== undefined && { remoteUrl: resolved.remoteUrl }),
    ...(resolved.type !== undefined && { type: resolved.type }),
    ...(resolved.config !== undefined && { config: resolved.config }),
  });
  if (register.errors.length > 0) throw register.errors[0];
}

/** Restore one saved project through the git module. */
function restore(
  setup: TestSetup,
  type: string,
  config: ProjectTypeConfig
): ReturnType<TestSetup["readyHooks"]["collect"]> {
  return setup.readyHooks.collect("restore", { intent: appReadyIntent(), type, config });
}

// =============================================================================
// Tests
// =============================================================================

describe("LocalProjectModule Integration", () => {
  // ---------------------------------------------------------------------------
  // project:open → resolve
  // ---------------------------------------------------------------------------

  describe("project:open resolve", () => {
    it("validates a local path and reports it as a git project", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([
        {
          projectPath: projPath(new Path(PROJECT_PATH).toString()),
          type: "git",
          config: { path: new Path(PROJECT_PATH).toString() },
          identifier: new Path(PROJECT_PATH).toString(),
        },
      ]);
      expect(gitWorktreeProvider.validateRepository).toHaveBeenCalledWith(new Path(PROJECT_PATH));
    });

    it("skips for git URL payloads", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect("resolve", {
        intent: openGitIntent(REPO_URL),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(gitWorktreeProvider.validateRepository).not.toHaveBeenCalled();
    });

    it("propagates validation errors", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();
      vi.mocked(gitWorktreeProvider.validateRepository).mockRejectedValue(
        new Error("Not a git repository")
      );

      const { results, errors } = await openHooks.collect("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(results).toHaveLength(0);
      expect(errors[0]!.message).toBe("Not a git repository");
    });

    it("returns remoteUrl and the record's own config from a saved project", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH, REPO_URL);

      const { results, errors } = await setup.openHooks.collect("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([
        {
          projectPath: projPath(new Path(PROJECT_PATH).toString()),
          remoteUrl: REPO_URL,
          type: "git",
          config: { path: new Path(PROJECT_PATH).toString(), remoteUrl: REPO_URL },
          identifier: "github.com/user/repo",
        },
      ]);
    });

    it("returns alreadyOpen, with remoteUrl, when the project is open", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH, REPO_URL);
      await open(setup, PROJECT_PATH);
      vi.mocked(setup.gitWorktreeProvider.validateRepository).mockClear();

      const { results, errors } = await setup.openHooks.collect("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results[0]).toMatchObject({ alreadyOpen: true, remoteUrl: REPO_URL });
      expect(setup.gitWorktreeProvider.validateRepository).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // open → record, through the store
  // ---------------------------------------------------------------------------

  describe("records of opened projects", () => {
    it("stores a local project as type git with its path", async () => {
      const setup = createTestSetup();

      await open(setup, PROJECT_PATH);

      const record = nodePath.join(PROJECTS_DIR, projectDirName(PROJECT_PATH), "config.json");
      expect(readJson(setup.fs, record)).toEqual({
        type: "git",
        config: { path: new Path(PROJECT_PATH).toString() },
        color: 0,
      });
    });

    it("rewrites a legacy record in place, keeping its remoteUrl", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH, REPO_URL);

      await open(setup, PROJECT_PATH);

      const record = nodePath.join(PROJECTS_DIR, projectDirName(PROJECT_PATH), "config.json");
      expect(readJson(setup.fs, record)).toEqual({
        type: "git",
        config: { path: new Path(PROJECT_PATH).toString(), remoteUrl: REPO_URL },
        color: 0,
      });
      expect(readJson(setup.fs, MANAGED_RECORD)).toBeUndefined();
    });

    it("reopens a managed clone by path into its URL-named record", async () => {
      const setup = createTestSetup();
      writeManagedRecord(setup.fs, { remoteUrl: REPO_URL });

      await open(setup, MANAGED_PATH);

      expect(readJson(setup.fs, MANAGED_RECORD)).toEqual({
        type: "git",
        config: { remoteUrl: REPO_URL },
        color: 0,
      });
      const pathRecord = nodePath.join(PROJECTS_DIR, projectDirName(MANAGED_PATH), "config.json");
      expect(setup.fs.$.entries.has(new Path(pathRecord).toString())).toBe(false);
      expect(setup.store.projectColor(gitProjectRef(MANAGED_PATH, REPO_URL))).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // app:ready → restore
  // ---------------------------------------------------------------------------

  describe("app:ready restore", () => {
    it("reopens a local git project by its path", async () => {
      const setup = createTestSetup();

      const { results, errors } = await restore(setup, "git", {
        path: new Path(PROJECT_PATH).toString(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{ payload: { path: new Path(PROJECT_PATH).toString() } }]);
    });

    it("reopens a managed project at the path its URL derives", async () => {
      const setup = createTestSetup();

      const { results } = await restore(setup, "git", { remoteUrl: REPO_URL });

      expect(results).toEqual([{ payload: { path: MANAGED_PATH } }]);
    });

    it("restores every legacy record the store loads", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH);
      writeManagedRecord(setup.fs, { remoteUrl: REPO_URL });

      const paths: string[] = [];
      for (const record of await setup.store.records()) {
        const { results } = await restore(setup, record.type, record.config);
        const path = results[0]?.payload?.path;
        if (path !== undefined) paths.push(path);
      }

      expect(paths.sort()).toEqual([new Path(PROJECT_PATH).toString(), MANAGED_PATH].sort());
    });

    it("leaves projects of other types alone", async () => {
      const setup = createTestSetup();

      const { results } = await restore(setup, "other", { path: "/somewhere" });

      expect(results).toEqual([{}]);
    });

    it("skips a git record with neither a path nor a URL", async () => {
      const setup = createTestSetup();

      const { results, errors } = await restore(setup, "git", {});

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
    });
  });

  // ---------------------------------------------------------------------------
  // project:close → resolve
  // ---------------------------------------------------------------------------

  describe("project:close resolve", () => {
    it("returns nothing for a local project", async () => {
      const setup = createTestSetup();
      await open(setup, PROJECT_PATH);

      const { results, errors } = await setup.closeHooks.collect(
        "resolve",
        closeResolveCtx(PROJECT_PATH)
      );

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
    });

    it("returns nothing for an unknown project path", async () => {
      const { closeHooks } = createTestSetup();

      const { results } = await closeHooks.collect(
        "resolve",
        closeResolveCtx(projPath("/unknown/project"))
      );

      expect(results).toEqual([{}]);
    });

    it("returns remoteUrl from the record", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH, REPO_URL);

      const { results } = await setup.closeHooks.collect("resolve", closeResolveCtx(PROJECT_PATH));

      expect(results[0]!.remoteUrl).toBe(REPO_URL);
    });

    it("knows a managed project by the path its URL derives", async () => {
      const setup = createTestSetup();
      writeManagedRecord(setup.fs, { type: "git", config: { remoteUrl: REPO_URL } });

      const { results } = await setup.closeHooks.collect("resolve", closeResolveCtx(MANAGED_PATH));

      expect(results).toEqual([{ remoteUrl: REPO_URL }]);
    });
  });

  // ---------------------------------------------------------------------------
  // project:close → close
  // ---------------------------------------------------------------------------

  describe("project:close close", () => {
    it("removes the record and the empty project directory, with the store", async () => {
      const setup = createTestSetup();
      await open(setup, PROJECT_PATH);

      const { errors } = await setup.both.close.collect(
        "close",
        closeInput({ removeLocalRepo: false })
      );

      expect(errors).toHaveLength(0);
      const configDir = nodePath.join(PROJECTS_DIR, projectDirName(PROJECT_PATH));
      expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(false);
      expect(setup.store.isOpen(PROJECT_PATH)).toBe(false);
    });

    it("keeps a workspaces directory still holding worktrees", async () => {
      const setup = createTestSetup();
      await open(setup, PROJECT_PATH);
      const worktree = nodePath.join(
        PROJECTS_DIR,
        projectDirName(PROJECT_PATH),
        "workspaces",
        "feature"
      );
      setup.fs.$.setEntry(worktree, { type: "directory" });

      await setup.both.close.collect("close", closeInput({ removeLocalRepo: false }));

      expect(setup.fs.$.entries.has(new Path(worktree).toString())).toBe(true);
    });

    it("force-deletes the project directories for a remote project with removeLocalRepo", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH, REPO_URL);
      await open(setup, PROJECT_PATH);
      const worktree = nodePath.join(
        PROJECTS_DIR,
        projectDirName(PROJECT_PATH),
        "workspaces",
        "feature"
      );
      setup.fs.$.setEntry(worktree, { type: "directory" });

      const { errors } = await setup.both.close.collect(
        "close",
        closeInput({ remoteUrl: REPO_URL, removeLocalRepo: true })
      );

      expect(errors).toHaveLength(0);
      const configDir = nodePath.join(PROJECTS_DIR, projectDirName(PROJECT_PATH));
      expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(false);
    });

    it("deletes the project's own directory for a local project with removeLocalRepo", async () => {
      const setup = createTestSetup({
        entries: { [new Path(PROJECT_PATH).toNative()]: directory() },
      });
      await open(setup, PROJECT_PATH);

      const { errors } = await setup.both.close.collect(
        "close",
        closeInput({ removeLocalRepo: true })
      );

      expect(errors).toHaveLength(0);
      expect(setup.fs.$.entries.has(new Path(PROJECT_PATH).toString())).toBe(false);
      const configDir = nodePath.join(PROJECTS_DIR, projectDirName(PROJECT_PATH));
      expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(false);
    });

    it("leaves the directory alone for a local project without removeLocalRepo", async () => {
      const setup = createTestSetup({
        entries: { [new Path(PROJECT_PATH).toNative()]: directory() },
      });
      await open(setup, PROJECT_PATH);

      await setup.both.close.collect("close", closeInput({ removeLocalRepo: false }));

      expect(setup.fs.$.entries.has(new Path(PROJECT_PATH).toString())).toBe(true);
    });

    it("reports a failed directory removal instead of failing the close", async () => {
      const setup = createTestSetup({
        entries: { [new Path(PROJECT_PATH).toNative()]: directory() },
      });
      const projectPathStr = new Path(PROJECT_PATH).toString();
      setup.fs.rm = vi.fn().mockImplementation(async (target: string) => {
        if (new Path(target).toString() === projectPathStr) {
          throw new Error("EACCES: permission denied");
        }
      });

      const { errors } = await setup.closeHooks.collect(
        "close",
        closeInput({ removeLocalRepo: true })
      );

      // The close still succeeds — by now the project is out of state and its
      // workspaces are gone, so throwing would only leave the app inconsistent.
      expect(errors).toHaveLength(0);
      await setup.notifications.settle();
      const notification = setup.notifications.lastNotification;
      expect(notification?.opened).toMatchObject({ type: "error", dismissible: true });
      expect(notification?.opened.message).toContain(projectPathStr);
      expect(notification?.opened.message).toContain("EACCES");
    });

    it("removes both directories when a managed project is closed", async () => {
      const setup = createTestSetup();
      writeManagedRecord(setup.fs, { remoteUrl: REPO_URL });
      await open(setup, MANAGED_PATH);
      const worktreesDir = nodePath.join(PROJECTS_DIR, projectDirName(MANAGED_PATH), "workspaces");
      setup.fs.$.setEntry(worktreesDir, { type: "directory" });

      await setup.both.close.collect(
        "close",
        closeInput({ remoteUrl: REPO_URL, removeLocalRepo: false }, MANAGED_PATH)
      );

      expect(setup.fs.$.entries.has(new Path(nodePath.dirname(MANAGED_RECORD)).toString())).toBe(
        false
      );
      expect(setup.fs.$.entries.has(new Path(worktreesDir).toString())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // What other modules read of git records
  // ---------------------------------------------------------------------------

  describe("git records for other modules", () => {
    it("names each recorded project by its ref: a checkout by path, a clone by origin", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH);
      writeManagedRecord(setup.fs, { type: "git", config: { remoteUrl: REPO_URL } });

      const refs = await setup.module.projectRefs();

      expect(Object.fromEntries(refs)).toEqual({
        [new Path(PROJECT_PATH).toString()]: gitProjectRef(PROJECT_PATH),
        [new Path(MANAGED_PATH).toString()]: gitProjectRef(MANAGED_PATH, REPO_URL),
      });
    });

    it("lists only git projects, legacy and new alike, with their paths", async () => {
      const setup = createTestSetup();
      writeConfig(setup.fs, PROJECT_PATH);
      writeManagedRecord(setup.fs, { type: "git", config: { remoteUrl: REPO_URL }, color: 3 });
      setup.fs.$.setEntry(nodePath.join(PROJECTS_DIR, "other"), { type: "directory" });
      setup.fs.$.setEntry(nodePath.join(PROJECTS_DIR, "other", "config.json"), {
        type: "file",
        content: JSON.stringify({ type: "other", config: { path: "/elsewhere" } }),
      });

      const projects = await loadAllProjects(setup.fs, {
        projectsDir: PROJECTS_DIR,
        remotesDir: REMOTES_DIR,
      });

      expect(projects).toHaveLength(2);
      expect(projects).toEqual(
        expect.arrayContaining([
          { path: new Path(PROJECT_PATH).toString() },
          { path: MANAGED_PATH, remoteUrl: REPO_URL, color: 3 },
        ])
      );
    });
  });

  // ---------------------------------------------------------------------------
  // project:open → prepare
  // ---------------------------------------------------------------------------

  describe("project:open prepare", () => {
    it("skips for git URL payloads", async () => {
      const { openHooks, gitClient } = createTestSetup();

      const { results, errors } = await openHooks.collect("prepare", {
        intent: openGitIntent(REPO_URL),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(gitClient.isRepositoryRoot).not.toHaveBeenCalled();
    });

    it("skips when directory is already a git repo", async () => {
      const { openHooks, dialogManager, gitClient } = createTestSetup();
      vi.mocked(gitClient.isRepositoryRoot).mockResolvedValue(true);

      const { results, errors } = await openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(dialogManager.manager.open).not.toHaveBeenCalled();
    });

    it("skips when project is already open", async () => {
      const setup = createTestSetup();
      await open(setup, PROJECT_PATH);
      vi.mocked(setup.gitClient.isRepositoryRoot).mockClear();

      const { results, errors } = await setup.openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(setup.gitClient.isRepositoryRoot).not.toHaveBeenCalled();
    });

    it("shows dialog and inits repo when user confirms", async () => {
      const { openHooks, dialogManager, gitClient } = createTestSetup();
      vi.mocked(gitClient.isRepositoryRoot).mockResolvedValue(false);

      const preparePromise = openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      await vi.waitFor(() => expect(dialogManager.lastHandle).not.toBeNull());
      dialogManager.lastHandle!.emitEvent({
        dialogId: dialogManager.lastHandle!.id,
        actionId: "init",
      });

      const { results, errors } = await preparePromise;

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(gitClient.init).toHaveBeenCalledWith(new Path(PROJECT_PATH), {
        initialCommit: "Initial commit",
      });
      expect(dialogManager.lastHandle!.closed).toBe(true);
    });

    it("returns canceled when user clicks cancel", async () => {
      const { openHooks, dialogManager, gitClient } = createTestSetup();
      vi.mocked(gitClient.isRepositoryRoot).mockResolvedValue(false);

      const preparePromise = openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      await vi.waitFor(() => expect(dialogManager.lastHandle).not.toBeNull());
      dialogManager.lastHandle!.emitEvent({
        dialogId: dialogManager.lastHandle!.id,
        actionId: "cancel",
      });

      const { results, errors } = await preparePromise;

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{ canceled: true }]);
      expect(gitClient.init).not.toHaveBeenCalled();
      expect(dialogManager.lastHandle!.closed).toBe(true);
    });

    it("returns canceled on Escape (dismiss), same as Cancel", async () => {
      const { openHooks, dialogManager, gitClient } = createTestSetup();
      vi.mocked(gitClient.isRepositoryRoot).mockResolvedValue(false);

      const preparePromise = openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      await vi.waitFor(() => expect(dialogManager.lastHandle).not.toBeNull());
      dialogManager.lastHandle!.emitDismiss();

      const { results, errors } = await preparePromise;

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{ canceled: true }]);
      expect(gitClient.init).not.toHaveBeenCalled();
      expect(dialogManager.lastHandle!.closed).toBe(true);
    });

    it("lets resolve handle the error when isRepositoryRoot throws", async () => {
      const { openHooks, dialogManager, gitClient } = createTestSetup();
      vi.mocked(gitClient.isRepositoryRoot).mockRejectedValue(new Error("Path not found"));

      const { results, errors } = await openHooks.collect("prepare", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toEqual([{}]);
      expect(dialogManager.manager.open).not.toHaveBeenCalled();
    });
  });
});
