// @vitest-environment node
/**
 * Integration tests for LocalProjectModule.
 *
 * Tests verify hook handlers through HookRegistry.resolve().collect(),
 * validating the full hook pipeline including self-selection behavior.
 *
 * Test plan items covered:
 * #1: resolve validates local path and returns projectPath
 * #2: resolve skips for git URL payloads
 * #3: resolve propagates validation errors
 * #4: register generates ID and persists new local projects
 * #5: register registers remote project (saves with remoteUrl from context)
 * #6: register skips save when project config already exists
 * #7: close resolve finds project by ID in internal state
 * #8: close resolve returns empty for unknown project ID
 * #9: close removes from state and config
 * #10: close removes remote project from state and config
 * #11: activate returns all project paths including remote
 * #12: activate returns empty when no projects saved
 * #13: activate does NOT populate internal state — project:open register handles that
 * #14: resolve returns alreadyOpen when path is in internal state
 * #15: register returns alreadyOpen for duplicate path
 * #16: close resolve returns remoteUrl from config
 * #17: close with removeLocalRepo force-deletes config dir for remote projects
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
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
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import { generateProjectId } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import type { ProjectId } from "../../shared/api/types";
import type { ResolvedHooks } from "../intents/infrastructure/operation";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { CURRENT_PROJECT_VERSION } from "../../services/project/types";
import { projectDirName } from "../../services/platform/paths";
import nodePath from "path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/local-project";
const PROJECT_ID = generateProjectId(PROJECT_PATH);
const PROJECTS_DIR = "/test/app-data/projects";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(fsOverrides?: Parameters<typeof createFileSystemMock>[0]): {
  deps: LocalProjectModuleDeps;
  fs: ReturnType<typeof createFileSystemMock>;
  globalProvider: LocalProjectModuleDeps["globalProvider"];
} {
  const fs = createFileSystemMock({
    entries: {
      [PROJECTS_DIR]: directory(),
      ...(fsOverrides?.entries ?? {}),
    },
  });

  const globalProvider = {
    validateRepository: vi.fn().mockResolvedValue(undefined),
  };

  return {
    deps: {
      projectsDir: PROJECTS_DIR,
      fs,
      globalProvider,
    },
    fs,
    globalProvider,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  openHooks: ResolvedHooks;
  closeHooks: ResolvedHooks;
  startHooks: ResolvedHooks;
  fs: ReturnType<typeof createFileSystemMock>;
  globalProvider: LocalProjectModuleDeps["globalProvider"];
}

function createTestSetup(fsOverrides?: Parameters<typeof createFileSystemMock>[0]): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const { deps, fs, globalProvider } = createMockDeps(fsOverrides);

  const module = createLocalProjectModule(deps);
  wireModules([module], hookRegistry, dispatcher);

  return {
    openHooks: hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID),
    closeHooks: hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID),
    startHooks: hookRegistry.resolve(APP_START_OPERATION_ID),
    fs,
    globalProvider,
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

function closeIntent(projectId: ProjectId): CloseProjectIntent {
  return {
    type: INTENT_CLOSE_PROJECT,
    payload: { projectId },
  };
}

function appStartIntent(): AppStartIntent {
  return {
    type: "app:start",
    payload: {} as AppStartIntent["payload"],
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
      const { openHooks, globalProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ projectPath: new Path(PROJECT_PATH).toString() });
      expect(globalProvider.validateRepository).toHaveBeenCalledWith(new Path(PROJECT_PATH));
    });

    it("skips for git URL payloads (#2)", async () => {
      const { openHooks, globalProvider } = createTestSetup();

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openGitIntent("https://github.com/user/repo.git"),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
      expect(globalProvider.validateRepository).not.toHaveBeenCalled();
    });

    it("propagates validation errors (#3)", async () => {
      const { openHooks, globalProvider } = createTestSetup();
      vi.mocked(globalProvider.validateRepository).mockRejectedValue(
        new Error("Not a git repository")
      );

      const { results, errors } = await openHooks.collect<ResolveHookResult>("resolve", {
        intent: openLocalIntent(PROJECT_PATH),
      });

      expect(results).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Not a git repository");
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
      expect(setup.globalProvider.validateRepository).not.toHaveBeenCalled();
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
    it("finds project by ID in internal state (#7)", async () => {
      const setup = createTestSetup();

      // First, register a project so it's in internal state
      const registerCtx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };
      await setup.openHooks.collect<RegisterHookResult>("register", registerCtx);

      // Now resolve by projectId
      const { results, errors } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve-project",
        { intent: closeIntent(PROJECT_ID) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPath).toBe(new Path(PROJECT_PATH).toString());
    });

    it("returns empty for unknown project ID (#8)", async () => {
      const { closeHooks } = createTestSetup();

      const { results, errors } = await closeHooks.collect<CloseResolveHookResult>(
        "resolve-project",
        {
          intent: closeIntent("unknown-00000000" as ProjectId),
        }
      );

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
        "resolve-project",
        { intent: closeIntent(PROJECT_ID) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPath).toBe(new Path(PROJECT_PATH).toString());
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
        intent: closeIntent(PROJECT_ID),
        projectPath: new Path(PROJECT_PATH).toString(),
        removeLocalRepo: false,
      };
      const { errors } = await setup.closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);

      // Verify it's gone from internal state (close resolve should return empty)
      const { results: resolveResults } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve-project",
        { intent: closeIntent(PROJECT_ID) }
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
        intent: closeIntent(PROJECT_ID),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
        removeLocalRepo: false,
      };
      const { errors } = await setup.closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);

      // Verify it's gone from internal state
      const { results: resolveResults } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve-project",
        { intent: closeIntent(PROJECT_ID) }
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
        intent: closeIntent(PROJECT_ID),
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
  // app:start → activate
  // ---------------------------------------------------------------------------

  describe("app:start activate", () => {
    it("returns all project paths including remote (#11)", async () => {
      const localPath = "/projects/alpha";
      const remotePath = "/remotes/repo";
      const setup = createTestSetup();

      // Pre-populate configs
      writeConfig(setup.fs, localPath);
      writeConfig(setup.fs, remotePath, "https://github.com/org/repo.git");

      const { results, errors } = await setup.startHooks.collect<ActivateHookResult>("activate", {
        intent: appStartIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toContain(new Path(localPath).toString());
      expect(results[0]!.projectPaths).toContain(new Path(remotePath).toString());
    });

    it("returns empty when no projects saved (#12)", async () => {
      const { startHooks } = createTestSetup();

      const { results, errors } = await startHooks.collect<ActivateHookResult>("activate", {
        intent: appStartIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([]);
    });

    it("does not populate internal state — project:open register handles that (#13)", async () => {
      const setup = createTestSetup();

      // Pre-populate config
      writeConfig(setup.fs, PROJECT_PATH);

      await setup.startHooks.collect<ActivateHookResult>("activate", {
        intent: appStartIntent(),
      });

      // activate should NOT populate state — close-resolve should return empty
      const { results, errors } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve-project",
        { intent: closeIntent(PROJECT_ID) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });
});
