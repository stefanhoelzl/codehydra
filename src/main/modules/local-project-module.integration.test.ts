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
 * #5: register skips when remoteUrl is present
 * #6: register skips save when project config already exists
 * #7: close resolve finds project by ID in internal state
 * #8: close resolve returns empty for unknown project ID
 * #9: close removes from state and persistent store
 * #10: close skips when remoteUrl is present
 * #11: activate returns all project paths from store
 * #12: activate returns empty when no projects saved
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

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/test/local-project";
const PROJECT_ID = generateProjectId(PROJECT_PATH);

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(): {
  deps: LocalProjectModuleDeps;
  projectStore: LocalProjectModuleDeps["projectStore"];
  globalProvider: LocalProjectModuleDeps["globalProvider"];
} {
  const projectStore = {
    loadAllProjects: vi.fn().mockResolvedValue([] as readonly string[]),
    saveProject: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    getProjectConfig: vi.fn().mockResolvedValue(undefined),
  };

  const globalProvider = {
    validateRepository: vi.fn().mockResolvedValue(undefined),
  };

  return { deps: { projectStore, globalProvider }, projectStore, globalProvider };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  openHooks: ResolvedHooks;
  closeHooks: ResolvedHooks;
  startHooks: ResolvedHooks;
  projectStore: LocalProjectModuleDeps["projectStore"];
  globalProvider: LocalProjectModuleDeps["globalProvider"];
}

function createTestSetup(): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const { deps, projectStore, globalProvider } = createMockDeps();

  const module = createLocalProjectModule(deps);
  wireModules([module], hookRegistry, dispatcher);

  return {
    openHooks: hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID),
    closeHooks: hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID),
    startHooks: hookRegistry.resolve(APP_START_OPERATION_ID),
    projectStore,
    globalProvider,
  };
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
  });

  // ---------------------------------------------------------------------------
  // project:open → register
  // ---------------------------------------------------------------------------

  describe("project:open register", () => {
    it("generates ID and persists new local projects (#4)", async () => {
      const { openHooks, projectStore } = createTestSetup();

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };

      const { results, errors } = await openHooks.collect<RegisterHookResult>("register", ctx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectId).toBe(PROJECT_ID);
      expect(projectStore.saveProject).toHaveBeenCalledWith(new Path(PROJECT_PATH).toString());
    });

    it("skips when remoteUrl is present (#5)", async () => {
      const { openHooks, projectStore } = createTestSetup();

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
      };

      const { results, errors } = await openHooks.collect<RegisterHookResult>("register", ctx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
      expect(projectStore.saveProject).not.toHaveBeenCalled();
    });

    it("skips save when config already exists (#6)", async () => {
      const { openHooks, projectStore } = createTestSetup();
      vi.mocked(projectStore.getProjectConfig).mockResolvedValue({
        version: 1,
        path: new Path(PROJECT_PATH).toString(),
      });

      const ctx: RegisterHookInput = {
        intent: openLocalIntent(PROJECT_PATH),
        projectPath: new Path(PROJECT_PATH).toString(),
      };

      const { results, errors } = await openHooks.collect<RegisterHookResult>("register", ctx);

      expect(errors).toHaveLength(0);
      expect(results[0]!.projectId).toBe(PROJECT_ID);
      expect(projectStore.saveProject).not.toHaveBeenCalled();
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
        "resolve",
        { intent: closeIntent(PROJECT_ID) }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPath).toBe(new Path(PROJECT_PATH).toString());
    });

    it("returns empty for unknown project ID (#8)", async () => {
      const { closeHooks } = createTestSetup();

      const { results, errors } = await closeHooks.collect<CloseResolveHookResult>("resolve", {
        intent: closeIntent("unknown-00000000" as ProjectId),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // project:close → close
  // ---------------------------------------------------------------------------

  describe("project:close close", () => {
    it("removes from state and persistent store (#9)", async () => {
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
      expect(setup.projectStore.removeProject).toHaveBeenCalledWith(
        new Path(PROJECT_PATH).toString()
      );

      // Verify it's gone from internal state (close resolve should return empty)
      const { results: resolveResults } = await setup.closeHooks.collect<CloseResolveHookResult>(
        "resolve",
        { intent: closeIntent(PROJECT_ID) }
      );
      expect(resolveResults[0]).toEqual({});
    });

    it("skips when remoteUrl is present (#10)", async () => {
      const { closeHooks, projectStore } = createTestSetup();

      const closeCtx: CloseHookInput = {
        intent: closeIntent(PROJECT_ID),
        projectPath: new Path(PROJECT_PATH).toString(),
        remoteUrl: "https://github.com/user/repo.git",
        removeLocalRepo: false,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results[0]).toEqual({});
      expect(projectStore.removeProject).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // app:start → activate
  // ---------------------------------------------------------------------------

  describe("app:start activate", () => {
    it("returns all project paths from store (#11)", async () => {
      const { startHooks, projectStore } = createTestSetup();
      vi.mocked(projectStore.loadAllProjects).mockResolvedValue([
        "/projects/alpha",
        "/projects/beta",
      ]);

      const { results, errors } = await startHooks.collect<ActivateHookResult>("activate", {
        intent: appStartIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual(["/projects/alpha", "/projects/beta"]);
    });

    it("returns empty when no projects saved (#12)", async () => {
      const { startHooks, projectStore } = createTestSetup();
      vi.mocked(projectStore.loadAllProjects).mockResolvedValue([]);

      const { results, errors } = await startHooks.collect<ActivateHookResult>("activate", {
        intent: appStartIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([]);
    });
  });
});
