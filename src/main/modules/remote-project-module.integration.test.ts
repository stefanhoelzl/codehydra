/**
 * Integration tests for RemoteProjectModule.
 *
 * Tests hook handlers through HookRegistry.resolve().collect() — the same
 * infrastructure used by operations — with frozen contexts and result/error
 * collection.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import { SILENT_LOGGER } from "../../services/logging";
import { createMockGitClient, gitClientMatchers } from "../../services/git/git-client.state-mock";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";
import { createRemoteProjectModule } from "./remote-project-module";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import type {
  ResolveHookResult,
  RegisterHookResult,
  RegisterHookInput,
  OpenProjectIntent,
} from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import type {
  CloseResolveHookResult,
  CloseHookInput,
  CloseHookResult,
  CloseProjectIntent,
} from "../operations/close-project";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import type { ActivateHookResult } from "../operations/app-start";
import { Path } from "../../services/platform/path";
import { generateProjectId } from "../../shared/api/id-utils";
import type { ProjectConfig } from "../../services/project/types";

expect.extend(gitClientMatchers);

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup() {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const projectStore = {
    findByRemoteUrl: vi
      .fn<(url: string) => Promise<string | undefined>>()
      .mockResolvedValue(undefined),
    saveProject: vi
      .fn<(path: string, options?: { remoteUrl?: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
    removeProject: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
    deleteProjectDirectory: vi
      .fn<(path: string, options?: { isClonedProject?: boolean }) => Promise<void>>()
      .mockResolvedValue(undefined),
    loadAllProjectConfigs: vi.fn<() => Promise<readonly ProjectConfig[]>>().mockResolvedValue([]),
  };

  const gitClient = createMockGitClient();
  const pathProvider = createMockPathProvider();

  const module = createRemoteProjectModule({
    projectStore,
    gitClient,
    pathProvider,
    logger: SILENT_LOGGER,
  });

  wireModules([module], hookRegistry, dispatcher);

  return { hookRegistry, projectStore, gitClient, pathProvider };
}

// =============================================================================
// Intent Helpers
// =============================================================================

function openProjectIntent(payload: { git?: string; path?: Path }): OpenProjectIntent {
  return {
    type: "project:open",
    payload,
  };
}

function closeProjectIntent(payload: {
  projectId: string;
  removeLocalRepo?: boolean;
}): CloseProjectIntent {
  return {
    type: "project:close",
    payload: payload as CloseProjectIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("RemoteProjectModule Integration", () => {
  // ---------------------------------------------------------------------------
  // open-project / resolve
  // ---------------------------------------------------------------------------

  describe("open-project / resolve", () => {
    it("clones new repo when URL provided and no existing clone", async () => {
      const { hookRegistry, projectStore, gitClient } = createTestSetup();

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result).toBeDefined();
      const projectPath = result.projectPath;
      expect(projectPath).toContain("repo");
      expect(result.remoteUrl).toBe("https://github.com/org/repo.git");

      // Verify clone was called
      expect(gitClient).toHaveClonedRepository(projectPath!);

      // Verify project was saved with remoteUrl
      expect(projectStore.saveProject).toHaveBeenCalledWith(projectPath, {
        remoteUrl: "https://github.com/org/repo.git",
      });
    });

    it("returns existing path when URL already cloned", async () => {
      const { hookRegistry, projectStore, gitClient } = createTestSetup();

      const existingPath = "/test/app-data/remotes/existing/repo";
      projectStore.findByRemoteUrl.mockResolvedValue(existingPath);

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result).toBeDefined();
      expect(result!.projectPath).toBe(existingPath);
      expect(result!.remoteUrl).toBe("https://github.com/org/repo.git");

      // No clone should have happened
      expect(gitClient.$.repositories.size).toBe(0);
      expect(projectStore.saveProject).not.toHaveBeenCalled();
    });

    it("returns undefined for local path (no git URL)", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ path: new Path("/local/project") });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toBeUndefined();

      expect(projectStore.findByRemoteUrl).not.toHaveBeenCalled();
      expect(projectStore.saveProject).not.toHaveBeenCalled();
    });

    it("propagates clone error", async () => {
      const { hookRegistry, gitClient } = createTestSetup();

      // Make clone fail by pre-populating the target path
      // We need a different approach — override the clone method
      const originalClone = gitClient.clone.bind(gitClient);
      (gitClient as { clone: typeof gitClient.clone }).clone = async () => {
        throw new Error("Network error: connection refused");
      };

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Network error: connection refused");
      expect(results).toHaveLength(0);

      // Restore
      (gitClient as { clone: typeof gitClient.clone }).clone = originalClone;
    });
  });

  // ---------------------------------------------------------------------------
  // open-project / register
  // ---------------------------------------------------------------------------

  describe("open-project / register", () => {
    it("adds to internal state and returns projectId + remoteUrl when remoteUrl present", async () => {
      const { hookRegistry } = createTestSetup();

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const projectPath = "/test/app-data/remotes/abc12345/repo";
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const registerCtx: RegisterHookInput = {
        intent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
      };
      const { results, errors } = await hooks.collect<RegisterHookResult | undefined>(
        "register",
        registerCtx
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result).toBeDefined();
      expect(result!.projectId).toBe(generateProjectId(projectPath));
      expect(result!.remoteUrl).toBe("https://github.com/org/repo.git");
    });

    it("returns undefined when no remoteUrl (local project)", async () => {
      const { hookRegistry } = createTestSetup();

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ path: new Path("/local/project") });

      const registerCtx: RegisterHookInput = {
        intent,
        projectPath: "/local/project",
      };
      const { results, errors } = await hooks.collect<RegisterHookResult | undefined>(
        "register",
        registerCtx
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // close-project / resolve
  // ---------------------------------------------------------------------------

  describe("close-project / resolve", () => {
    it("returns projectPath + remoteUrl for tracked remote project", async () => {
      const { hookRegistry } = createTestSetup();

      // First register a remote project via open-project/register
      const projectPath = "/test/app-data/remotes/abc12345/repo";
      const projectId = generateProjectId(projectPath);
      const openHooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const openIntent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const registerCtx: RegisterHookInput = {
        intent: openIntent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
      };
      await openHooks.collect<RegisterHookResult | undefined>("register", registerCtx);

      // Now resolve via close-project
      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId });

      const { results, errors } = await closeHooks.collect<CloseResolveHookResult | undefined>(
        "resolve-project",
        { intent: closeIntent }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result).toBeDefined();
      expect(result!.projectPath).toBe(new Path(projectPath).toString());
      expect(result!.remoteUrl).toBe("https://github.com/org/repo.git");
    });

    it("returns undefined for unknown/non-remote projectId", async () => {
      const { hookRegistry } = createTestSetup();

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "unknown-12345678" });

      const { results, errors } = await closeHooks.collect<CloseResolveHookResult | undefined>(
        "resolve-project",
        { intent: closeIntent }
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // close-project / close
  // ---------------------------------------------------------------------------

  describe("close-project / close", () => {
    it("removes from state + store when remoteUrl present, removeLocalRepo=false", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      // Register a remote project first
      const projectPath = "/test/app-data/remotes/abc12345/repo";
      const projectId = generateProjectId(projectPath);
      const openHooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const openIntent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const registerCtx: RegisterHookInput = {
        intent: openIntent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
      };
      await openHooks.collect<RegisterHookResult | undefined>("register", registerCtx);

      // Close it
      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId, removeLocalRepo: false });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
        removeLocalRepo: false,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      expect(projectStore.removeProject).toHaveBeenCalledWith(projectPath);
      expect(projectStore.deleteProjectDirectory).not.toHaveBeenCalled();

      // Verify state is empty — resolve should return undefined now
      const resolveResult = await closeHooks.collect<CloseResolveHookResult | undefined>(
        "resolve-project",
        { intent: closeIntent }
      );
      expect(resolveResult.results[0]).toBeUndefined();
    });

    it("removes from state + store + deletes directory when removeLocalRepo=true", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      // Register a remote project first
      const projectPath = "/test/app-data/remotes/abc12345/repo";
      const projectId = generateProjectId(projectPath);
      const openHooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const openIntent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const registerCtx: RegisterHookInput = {
        intent: openIntent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
      };
      await openHooks.collect<RegisterHookResult | undefined>("register", registerCtx);

      // Close with removeLocalRepo=true
      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId, removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        remoteUrl: "https://github.com/org/repo.git",
        removeLocalRepo: true,
      };
      const { errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(projectStore.removeProject).toHaveBeenCalledWith(projectPath);
      expect(projectStore.deleteProjectDirectory).toHaveBeenCalledWith(projectPath, {
        isClonedProject: true,
      });
    });

    it("no-op when remoteUrl absent", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "local-12345678" });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath: "/local/project",
        removeLocalRepo: false,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      expect(projectStore.removeProject).not.toHaveBeenCalled();
      expect(projectStore.deleteProjectDirectory).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // app-start / activate
  // ---------------------------------------------------------------------------

  describe("app-start / activate", () => {
    it("loads remote project configs, populates state, returns their paths", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const remoteConfig: ProjectConfig = {
        version: 2,
        path: "/test/app-data/remotes/abc12345/repo",
        remoteUrl: "https://github.com/org/repo.git",
      };

      projectStore.loadAllProjectConfigs.mockResolvedValue([remoteConfig]);

      const hooks = hookRegistry.resolve(APP_START_OPERATION_ID);
      const intent = { type: "app:start" as const, payload: {} };

      const { results, errors } = await hooks.collect<ActivateHookResult>("activate", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([remoteConfig.path]);

      // Verify the state was populated — close-project/resolve should find it
      const projectId = generateProjectId(remoteConfig.path);
      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId });

      const { results: resolveResults } = await closeHooks.collect<
        CloseResolveHookResult | undefined
      >("resolve-project", { intent: closeIntent });

      expect(resolveResults[0]).toBeDefined();
      expect(resolveResults[0]!.remoteUrl).toBe("https://github.com/org/repo.git");
    });

    it("ignores local project configs (no remoteUrl)", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const localConfig: ProjectConfig = {
        version: 2,
        path: "/home/user/projects/local",
      };

      projectStore.loadAllProjectConfigs.mockResolvedValue([localConfig]);

      const hooks = hookRegistry.resolve(APP_START_OPERATION_ID);
      const intent = { type: "app:start" as const, payload: {} };

      const { results, errors } = await hooks.collect<ActivateHookResult>("activate", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([]);
    });

    it("returns empty when no saved projects", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      projectStore.loadAllProjectConfigs.mockResolvedValue([]);

      const hooks = hookRegistry.resolve(APP_START_OPERATION_ID);
      const intent = { type: "app:start" as const, payload: {} };

      const { results, errors } = await hooks.collect<ActivateHookResult>("activate", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]!.projectPaths).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("activate -> register -> close: state populated, updated, then emptied", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      // 1. activate: load existing remote project
      const existingConfig: ProjectConfig = {
        version: 2,
        path: "/test/app-data/remotes/existing-id/existing-repo",
        remoteUrl: "https://github.com/org/existing.git",
      };
      projectStore.loadAllProjectConfigs.mockResolvedValue([existingConfig]);

      const appStartHooks = hookRegistry.resolve(APP_START_OPERATION_ID);
      const startIntent = { type: "app:start" as const, payload: {} };
      await appStartHooks.collect<ActivateHookResult>("activate", { intent: startIntent });

      // 2. register: add a new remote project
      const newProjectPath = "/test/app-data/remotes/new-id/new-repo";
      const openHooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const openIntent = openProjectIntent({ git: "https://github.com/org/new.git" });

      const registerCtx: RegisterHookInput = {
        intent: openIntent,
        projectPath: newProjectPath,
        remoteUrl: "https://github.com/org/new.git",
      };
      await openHooks.collect<RegisterHookResult | undefined>("register", registerCtx);

      // Verify both are resolvable via close-project/resolve
      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);

      const existingId = generateProjectId(existingConfig.path);
      const { results: existingResolve } = await closeHooks.collect<
        CloseResolveHookResult | undefined
      >("resolve-project", { intent: closeProjectIntent({ projectId: existingId }) });
      expect(existingResolve[0]).toBeDefined();
      expect(existingResolve[0]!.remoteUrl).toBe("https://github.com/org/existing.git");

      const newId = generateProjectId(newProjectPath);
      const { results: newResolve } = await closeHooks.collect<CloseResolveHookResult | undefined>(
        "resolve-project",
        { intent: closeProjectIntent({ projectId: newId }) }
      );
      expect(newResolve[0]).toBeDefined();
      expect(newResolve[0]!.remoteUrl).toBe("https://github.com/org/new.git");

      // 3. close: remove the new project
      const closeCtx: CloseHookInput = {
        intent: closeProjectIntent({ projectId: newId }),
        projectPath: newProjectPath,
        remoteUrl: "https://github.com/org/new.git",
        removeLocalRepo: false,
      };
      await closeHooks.collect<CloseHookResult>("close", closeCtx);

      // New project no longer resolvable
      const { results: afterClose } = await closeHooks.collect<CloseResolveHookResult | undefined>(
        "resolve-project",
        { intent: closeProjectIntent({ projectId: newId }) }
      );
      expect(afterClose[0]).toBeUndefined();

      // Existing project still resolvable
      const { results: existingStillThere } = await closeHooks.collect<
        CloseResolveHookResult | undefined
      >("resolve-project", { intent: closeProjectIntent({ projectId: existingId }) });
      expect(existingStillThere[0]).toBeDefined();
    });
  });
});
