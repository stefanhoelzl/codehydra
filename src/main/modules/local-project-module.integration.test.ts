// @vitest-environment node
/**
 * Integration tests for LocalProjectModule.
 *
 * Tests verify hook handlers through Dispatcher operations that collect
 * individual hook points, validating the full hook pipeline including
 * self-selection behavior.
 *
 * Test plan items covered:
 * #1: resolve validates local path and returns projectPath
 * #2: resolve skips for git URL payloads
 * #3: resolve propagates validation errors
 * #4: register generates ID and persists new local projects
 * #5: register registers remote project (saves with remoteUrl from context)
 * #6: register skips save when project config already exists
 * #7: close resolve returns config for known project path
 * #8: close resolve returns empty for unknown project path
 * #9: close removes from state and config
 * #10: close removes remote project from state and config
 * #11: start returns all project paths including remote
 * #12: start returns empty when no projects saved
 * #13: start does NOT populate internal state — project:open register handles that
 * #14: resolve returns alreadyOpen when path is in internal state
 * #15: register returns alreadyOpen for duplicate path
 * #16: close resolve returns remoteUrl from config
 * #17: close with removeLocalRepo force-deletes config dir for remote projects
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import { createLocalProjectModule, type LocalProjectModuleDeps } from "./local-project-module";
import {
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  type ResolveHookResult,
  type RegisterHookResult,
  type RegisterHookInput,
} from "../operations/open-project";
import type { OpenProjectIntent } from "../operations/open-project";
import {
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  type CloseResolveHookResult,
  type CloseHookResult,
  type CloseHookInput,
} from "../operations/close-project";
import type { CloseProjectIntent } from "../operations/close-project";
import {
  APP_READY_OPERATION_ID,
  INTENT_APP_READY,
  type LoadProjectsResult,
} from "../operations/app-ready";
import type { AppReadyIntent } from "../operations/app-ready";
import { Path } from "../../services/platform/path";
import type { ProjectId } from "../../shared/api/types";
import type {
  HookContext,
  HookResult,
  Operation,
  OperationContext,
} from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { CURRENT_PROJECT_VERSION } from "../../services/project/types";
import { projectDirName } from "../../services/platform/paths";
import nodePath from "path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/local-project";
const PROJECT_ID = "local-project-40b89393" as ProjectId;
const PROJECTS_DIR = "/test/app-data/projects";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(fsOverrides?: Parameters<typeof createFileSystemMock>[0]): {
  deps: LocalProjectModuleDeps;
  fs: ReturnType<typeof createFileSystemMock>;
  gitWorktreeProvider: LocalProjectModuleDeps["gitWorktreeProvider"];
} {
  const fs = createFileSystemMock({
    entries: {
      [PROJECTS_DIR]: directory(),
      ...(fsOverrides?.entries ?? {}),
    },
  });

  const gitWorktreeProvider = {
    validateRepository: vi.fn().mockResolvedValue(undefined),
  };

  return {
    deps: {
      projectsDir: PROJECTS_DIR,
      fs,
      gitWorktreeProvider,
    },
    fs,
    gitWorktreeProvider,
  };
}

// =============================================================================
// Collect Operation
// =============================================================================

/**
 * A test operation that collects a specified hook point and returns the full
 * HookResult. The hook point and context are set via mutable fields before
 * dispatching.
 */
class CollectOperation<TIntent extends Intent> implements Operation<TIntent, HookResult> {
  readonly id: string;
  hookPoint = "";
  hookContext: HookContext = { intent: { type: "", payload: {} } };

  constructor(id: string) {
    this.id = id;
  }

  async execute(ctx: OperationContext<TIntent>): Promise<HookResult> {
    return ctx.hooks.collect(this.hookPoint, this.hookContext);
  }
}

/**
 * A wrapper around a CollectOperation + Dispatcher that provides the same
 * collect() API as ResolvedHooks, for minimal test disruption.
 */
interface TestHooks {
  collect<T>(hookPoint: string, ctx: HookContext): Promise<HookResult<T>>;
}

function createTestHooks<TIntent extends Intent>(
  dispatcher: Dispatcher,
  intentType: string,
  collectOp: CollectOperation<TIntent>
): TestHooks {
  return {
    async collect<T>(hookPoint: string, ctx: HookContext): Promise<HookResult<T>> {
      collectOp.hookPoint = hookPoint;
      collectOp.hookContext = ctx;
      return (await dispatcher.dispatch({
        type: intentType,
        payload: (ctx.intent as Intent).payload,
      } as TIntent)) as HookResult<T>;
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  openHooks: TestHooks;
  closeHooks: TestHooks;
  readyHooks: TestHooks;
  fs: ReturnType<typeof createFileSystemMock>;
  gitWorktreeProvider: LocalProjectModuleDeps["gitWorktreeProvider"];
}

function createTestSetup(fsOverrides?: Parameters<typeof createFileSystemMock>[0]): TestSetup {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  const { deps, fs, gitWorktreeProvider } = createMockDeps(fsOverrides);

  const openOp = new CollectOperation<OpenProjectIntent>(OPEN_PROJECT_OPERATION_ID);
  const closeOp = new CollectOperation<CloseProjectIntent>(CLOSE_PROJECT_OPERATION_ID);
  const readyOp = new CollectOperation<AppReadyIntent>(APP_READY_OPERATION_ID);

  dispatcher.registerOperation(INTENT_OPEN_PROJECT, openOp);
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, closeOp);
  dispatcher.registerOperation(INTENT_APP_READY, readyOp);

  const module = createLocalProjectModule(deps);
  dispatcher.registerModule(module);

  return {
    openHooks: createTestHooks(dispatcher, INTENT_OPEN_PROJECT, openOp),
    closeHooks: createTestHooks(dispatcher, INTENT_CLOSE_PROJECT, closeOp),
    readyHooks: createTestHooks(dispatcher, INTENT_APP_READY, readyOp),
    fs,
    gitWorktreeProvider,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Write a project config to the mock filesystem */
function writeConfig(
  fs: ReturnType<typeof createFileSystemMock>,
  projectPath: string,
  remoteUrl?: string
): void {
  const dirName = projectDirName(new Path(projectPath).toString());
  const configDir = nodePath.join(PROJECTS_DIR, dirName);
  const configPath = nodePath.join(configDir, "config.json");

  const config = {
    version: CURRENT_PROJECT_VERSION,
    path: new Path(projectPath).toString(),
    ...(remoteUrl !== undefined && { remoteUrl }),
  };

  fs.$.setEntry(configDir, { type: "directory" });
  fs.$.setEntry(configPath, { type: "file", content: JSON.stringify(config, null, 2) });
}

// =============================================================================
// Intent Helpers
// =============================================================================

function openLocalIntent(path: string): OpenProjectIntent {
  return {
    type: INTENT_OPEN_PROJECT,
    payload: { path: new Path(path) },
  };
}

function openGitIntent(url: string): OpenProjectIntent {
  return {
    type: INTENT_OPEN_PROJECT,
    payload: { git: url },
  };
}

function closeIntent(projectPath: string): CloseProjectIntent {
  return {
    type: INTENT_CLOSE_PROJECT,
    payload: { projectPath },
  };
}

function appReadyIntent(): AppReadyIntent {
  return {
    type: "app:ready",
    payload: {} as AppReadyIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("LocalProjectModule Integration", () => {
  // ---------------------------------------------------------------------------
  // project:open → resolve
  // ---------------------------------------------------------------------------

  describe("project:open resolve", () => {
    it("validates local path and returns projectPath (#1)", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ projectPath: new Path(PROJECT_PATH).toString() });
      expect(gitWorktreeProvider.validateRepository).toHaveBeenCalledWith(new Path(PROJECT_PATH));
    });

    it("skips for git URL payloads (#2)", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openGitIntent("https://github.com/user/repo.git"),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
      expect(gitWorktreeProvider.validateRepository).not.toHaveBeenCalled();
    });

    it("propagates validation errors (#3)", async () => {
      const { openHooks, gitWorktreeProvider } = createTestSetup();
      vi.mocked(gitWorktreeProvider.validateRepository).mockRejectedValue(
        new Error("Not a git repository")
      );

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(results).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Not a git repository");
    });

    it("returns remoteUrl from persisted config on startup (#18)", async () => {
      const setup = createTestSetup();

      // Pre-populate config with remoteUrl (simulates saved remote project)
      writeConfig(setup.fs, PROJECT_PATH, "https://github.com/user/repo.git");

      // Resolve with local path only (no git URL) — like app startup
      const { results, errors } = await setup.openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      });
    });

    it("returns remoteUrl with alreadyOpen when project is in state (#19)", async () => {
      const setup = createTestSetup();

      // Pre-populate config with remoteUrl
      writeConfig(setup.fs, PROJECT_PATH, "https://github.com/user/repo.git");

      // Register so project is in internal state
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Resolve again — should return alreadyOpen AND remoteUrl
      const { results, errors } = await setup.openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectPath: new Path(PROJECT_PATH).toString(),
        alreadyOpen: true,
        remoteUrl: "https://github.com/user/repo.git",
      });
      expect(setup.gitWorktreeProvider.validateRepository).not.toHaveBeenCalled();
    });

    it("returns alreadyOpen when path is in internal state (#14)", async () => {
      const setup = createTestSetup();

      // Register a project so it's in internal state
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Resolve again — should return alreadyOpen and skip validation
      const { results, errors } = await setup.openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectPath: new Path(PROJECT_PATH).toString(),
        alreadyOpen: true,
      });
      expect(setup.gitWorktreeProvider.validateRepository).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // project:open → register
  // ---------------------------------------------------------------------------

  describe("project:open register", () => {
    it("generates ID and persists new local projects (#4)", async () => {
      const { openHooks, fs } = createTestSetup();

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };

      const { results, errors } = await openHooks.collect<RegisterHookResult>("register", ctx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectId).toBe(PROJECT_ID);

      // Verify config was written to filesystem
      const dirName = projectDirName(new Path(PROJECT_PATH).toString());
      const configPath = nodePath.join(PROJECTS_DIR, dirName, "config.json");
      const entry = fs.$.entries.get(new Path(configPath).toString());
      expect(entry).toBeDefined();
      expect(entry!.type).toBe("file");
      const config = JSON.parse((entry as { content: string }).content);
      expect(config.path).toBe(new Path(PROJECT_PATH).toString());
      expect(config.remoteUrl).toBeUndefined();
    });

    it("saves with remoteUrl when provided in context (#5)", async () => {
      const { openHooks, fs } = createTestSetup();

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };

      const { results, errors } = await openHooks.collect<RegisterHookResult>("register", ctx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectId).toBe(PROJECT_ID);
      expect(results[0]!.name).toBe(new Path(PROJECT_PATH).basename);

      // Verify config includes remoteUrl
      const dirName = projectDirName(new Path(PROJECT_PATH).toString());
      const configPath = nodePath.join(PROJECTS_DIR, dirName, "config.json");
      const entry = fs.$.entries.get(new Path(configPath).toString());
      expect(entry).toBeDefined();
      const config = JSON.parse((entry as { content: string }).content);
      expect(config.remoteUrl).toBe("https://github.com/user/repo.git");
    });

    it("skips save when config already exists (#6)", async () => {
      const setup = createTestSetup();

      // Pre-populate config in filesystem
      writeConfig(setup.fs, PROJECT_PATH);

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };

      const { results, errors } = await setup.openHooks.collect<RegisterHookResult>(
        "register",
        ctx
      );

      expect(errors).toHaveLength(0);
      expect(results[0]!.projectId).toBe(PROJECT_ID);
    });

    it("returns alreadyOpen for duplicate path (#15)", async () => {
      const { openHooks, fs } = createTestSetup();

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };

      // First registration — should persist
      const { results: first, errors: firstErrors } = await openHooks.collect<RegisterHookResult>(
        "register",
        ctx
      );

      expect(firstErrors).toHaveLength(0);
      expect(first[0]!.projectId).toBe(PROJECT_ID);
      expect(first[0]!.alreadyOpen).toBeUndefined();

      // Verify config was written
      const dirName = projectDirName(new Path(PROJECT_PATH).toString());
      const configPath = nodePath.join(PROJECTS_DIR, dirName, "config.json");
      expect(fs.$.entries.has(new Path(configPath).toString())).toBe(true);

      // Second registration — should return alreadyOpen without re-persisting
      const { results: second, errors: secondErrors } = await openHooks.collect<RegisterHookResult>(
        "register",
        ctx
      );

      expect(secondErrors).toHaveLength(0);
      expect(second[0]!.projectId).toBe(PROJECT_ID);
      expect(second[0]!.name).toBe(new Path(PROJECT_PATH).basename);
      expect(second[0]!.alreadyOpen).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // project:close → resolve
  // ---------------------------------------------------------------------------

  describe("project:close resolve", () => {
    it("returns config for known project path (#7)", async () => {
      const setup = createTestSetup();

      // Register a project so config is written to disk
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Now resolve by projectPath - should return config data (empty for local projects without remoteUrl)
      const { results, errors } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_PATH) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      // Local project has no remoteUrl, so result is empty
      expect(results[0]).toEqual({});
    });

    it("returns empty for unknown project path (#8)", async () => {
      const { closeHooks } = createTestSetup();

      const { results, errors } = await closeHooks.collect<CloseResolveHookResult>("resolve", {
        intent: closeIntent("/unknown/project"),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });

    it("returns remoteUrl from config (#16)", async () => {
      const setup = createTestSetup();

      // Pre-populate config with remoteUrl
      writeConfig(setup.fs, PROJECT_PATH, "https://github.com/user/repo.git");

      // Register project so it's in internal state
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Resolve — should include remoteUrl from config
      const { results, errors } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_PATH) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.remoteUrl).toBe("https://github.com/user/repo.git");
    });
  });

  // ---------------------------------------------------------------------------
  // project:close → close
  // ---------------------------------------------------------------------------

  describe("project:close close", () => {
    it("removes from state and config (#9)", async () => {
      const setup = createTestSetup();

      // Register a project first
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Close the project
      const closeCtx: CloseHookInput = {
        intent: closeIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        removeLocalRepo: false,
      };
      const { errors } = await setup.closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);

      // Verify it's gone from internal state (close resolve should return empty)
      const { results: resolveResults } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_PATH) }
      );
      expect(resolveResults[0]).toEqual({});
    });

    it("closes remote project — removes from state (#10)", async () => {
      const setup = createTestSetup();

      // Pre-populate config with remoteUrl
      writeConfig(setup.fs, PROJECT_PATH, "https://github.com/user/repo.git");

      // Register a remote project first so it's in internal state
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Close with remoteUrl present
      const closeCtx: CloseHookInput = {
        intent: closeIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
        removeLocalRepo: false,
      };
      const { errors } = await setup.closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);

      // Verify it's gone from internal state
      const { results: resolveResults } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_PATH) }
      );
      expect(resolveResults[0]).toEqual({});
    });

    it("force-deletes config dir for remote project with removeLocalRepo (#17)", async () => {
      const setup = createTestSetup();

      // Pre-populate config with remoteUrl
      writeConfig(setup.fs, PROJECT_PATH, "https://github.com/user/repo.git");

      // Register project
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Close with removeLocalRepo=true and remoteUrl
      const closeCtx: CloseHookInput = {
        intent: closeIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
        removeLocalRepo: true,
      };
      const { errors } = await setup.closeHooks.collect<CloseHookResult>("close", closeCtx);
      expect(errors).toHaveLength(0);

      // Verify config dir was force-deleted (recursive rm)
      const dirName = projectDirName(new Path(PROJECT_PATH).toString());
      const configDir = nodePath.join(PROJECTS_DIR, dirName);
      expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // app:ready → load-projects
  // ---------------------------------------------------------------------------

  describe("app:ready load-projects", () => {
    it("returns all project paths including remote (#11)", async () => {
      const localPath = "/projects/alpha";
      const remotePath = "/remotes/repo";
      const setup = createTestSetup();

      // Pre-populate configs
      writeConfig(setup.fs, localPath);
      writeConfig(setup.fs, remotePath, "https://github.com/org/repo.git");

      const { results, errors } = await setup.readyHooks.collect<LoadProjectsResult>(
        "load-projects",
        {
          intent: appReadyIntent(),
        }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toContain(new Path(localPath).toString());
      expect(results[0]!.projectPaths).toContain(new Path(remotePath).toString());
    });

    it("returns empty when no projects saved (#12)", async () => {
      const { readyHooks } = createTestSetup();

      const { results, errors } = await readyHooks.collect<LoadProjectsResult>("load-projects", {
        intent: appReadyIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([]);
    });

    it("does not populate internal state — project:open register handles that (#13)", async () => {
      const setup = createTestSetup();

      // Pre-populate config
      writeConfig(setup.fs, PROJECT_PATH);

      await setup.readyHooks.collect<LoadProjectsResult>("load-projects", {
        intent: appReadyIntent(),
      });

      // load-projects should NOT populate internal state — resolve reads config from disk,
      // so it returns {} for a local project (no remoteUrl)
      const { results, errors } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_PATH) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      // Local project config has no remoteUrl, so result is empty
      expect(results[0]).toEqual({});
    });
  });
});
