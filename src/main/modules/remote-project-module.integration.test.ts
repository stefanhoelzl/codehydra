/**
 * Integration tests for RemoteProjectModule.
 *
 * Tests hook handlers through HookRegistry.resolve().collect() -- the same
 * infrastructure used by operations -- with frozen contexts and result/error
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
import type { ResolveHookResult, OpenProjectIntent } from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import type {
  CloseHookInput,
  CloseHookResult,
  CloseProjectIntent,
} from "../operations/close-project";
import { Path } from "../../services/platform/path";
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
    getProjectConfig: vi
      .fn<(path: string) => Promise<ProjectConfig | undefined>>()
      .mockResolvedValue(undefined),
    deleteProjectDirectory: vi
      .fn<(path: string, options?: { isClonedProject?: boolean }) => Promise<void>>()
      .mockResolvedValue(undefined),
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
      expect(results).toHaveLength(0);

      expect(projectStore.findByRemoteUrl).not.toHaveBeenCalled();
      expect(projectStore.saveProject).not.toHaveBeenCalled();
    });

    it("propagates clone error", async () => {
      const { hookRegistry, gitClient } = createTestSetup();

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
  // close-project / close
  // ---------------------------------------------------------------------------

  describe("close-project / close", () => {
    it("deletes directory when removeLocalRepo=true and config has remoteUrl", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";

      // Config lookup returns a remote project
      projectStore.getProjectConfig.mockResolvedValue({
        version: 2,
        path: projectPath,
        remoteUrl: "https://github.com/org/repo.git",
      });

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "test-id", removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        removeLocalRepo: true,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      expect(projectStore.getProjectConfig).toHaveBeenCalledWith(projectPath);
      expect(projectStore.deleteProjectDirectory).toHaveBeenCalledWith(projectPath, {
        isClonedProject: true,
      });
    });

    it("no-op when removeLocalRepo=false", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "test-id", removeLocalRepo: false });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        removeLocalRepo: false,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      // Should not even check config when removeLocalRepo is false
      expect(projectStore.getProjectConfig).not.toHaveBeenCalled();
      expect(projectStore.deleteProjectDirectory).not.toHaveBeenCalled();
    });

    it("no-op when config has no remoteUrl (local project)", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const projectPath = "/home/user/projects/local";

      // Config exists but has no remoteUrl
      projectStore.getProjectConfig.mockResolvedValue({
        version: 2,
        path: projectPath,
      });

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "test-id", removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        removeLocalRepo: true,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      expect(projectStore.getProjectConfig).toHaveBeenCalledWith(projectPath);
      expect(projectStore.deleteProjectDirectory).not.toHaveBeenCalled();
    });

    it("no-op when getProjectConfig returns undefined", async () => {
      const { hookRegistry, projectStore } = createTestSetup();

      const projectPath = "/unknown/project";

      // getProjectConfig returns undefined (default mock behavior)

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntent = closeProjectIntent({ projectId: "test-id", removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntent,
        projectPath,
        removeLocalRepo: true,
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      expect(projectStore.getProjectConfig).toHaveBeenCalledWith(projectPath);
      expect(projectStore.deleteProjectDirectory).not.toHaveBeenCalled();
    });
  });
});
