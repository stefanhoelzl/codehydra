/**
 * Integration tests for RemoteProjectModule.
 *
 * Tests hook handlers through HookRegistry.resolve().collect() -- the same
 * infrastructure used by operations -- with frozen contexts and result/error
 * collection.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import { SILENT_LOGGER } from "../../services/logging";
import { createMockGitClient, gitClientMatchers } from "../../services/git/git-client.state-mock";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";
import { createFileSystemMock } from "../../services/platform/filesystem.state-mock";
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
import { generateProjectIdFromUrl, extractRepoName } from "../../services/project/url-utils";

expect.extend(gitClientMatchers);

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup() {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const fs = createFileSystemMock();
  const gitClient = createMockGitClient();
  const pathProvider = createMockPathProvider();

  const module = createRemoteProjectModule({
    fs,
    gitClient,
    pathProvider,
    logger: SILENT_LOGGER,
  });

  wireModules([module], hookRegistry, dispatcher);

  return { hookRegistry, fs, gitClient, pathProvider };
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
      const { hookRegistry, gitClient } = createTestSetup();

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
    });

    it("returns existing path when clone directory exists (readdir succeeds)", async () => {
      const { hookRegistry, fs, gitClient, pathProvider } = createTestSetup();

      const url = "https://github.com/org/repo.git";
      const urlProjectId = generateProjectIdFromUrl(url);
      const repoName = extractRepoName(url);
      const projectDir = new Path(pathProvider.remotesDir.toString(), urlProjectId);
      const gitPath = new Path(projectDir.toString(), repoName);

      // Pre-populate filesystem so readdir succeeds
      fs.$.setEntry(gitPath.toString(), { type: "directory" });

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: url });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result).toBeDefined();
      expect(result!.projectPath).toBe(gitPath.toString());
      expect(result!.remoteUrl).toBe(url);

      // No clone should have happened
      expect(gitClient.$.repositories.size).toBe(0);
    });

    it("returns undefined for local path (no git URL)", async () => {
      const { hookRegistry } = createTestSetup();

      const hooks = hookRegistry.resolve(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ path: new Path("/local/project") });

      const { results, errors } = await hooks.collect<ResolveHookResult | undefined>("resolve", {
        intent,
      });

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(0);
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
    it("deletes clone directory when removeLocalRepo=true and remoteUrl in context", async () => {
      const { hookRegistry, fs } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";

      // Pre-populate clone directory
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntnt = closeProjectIntent({ projectId: "test-id", removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: true,
        remoteUrl: "https://github.com/org/repo.git",
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      // Clone dir (parent of projectPath) should be deleted
      expect(fs.$.entries.has(new Path("/test/app-data/remotes/abc12345").toString())).toBe(false);
    });

    it("no-op when removeLocalRepo=false", async () => {
      const { hookRegistry, fs } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntnt = closeProjectIntent({ projectId: "test-id", removeLocalRepo: false });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: false,
        remoteUrl: "https://github.com/org/repo.git",
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      // Directory should still exist
      expect(fs.$.entries.has(new Path("/test/app-data/remotes/abc12345").toString())).toBe(true);
    });

    it("no-op when no remoteUrl in context (local project)", async () => {
      const { hookRegistry } = createTestSetup();

      const projectPath = "/home/user/projects/local";

      const closeHooks = hookRegistry.resolve(CLOSE_PROJECT_OPERATION_ID);
      const closeIntnt = closeProjectIntent({ projectId: "test-id", removeLocalRepo: true });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: true,
        // No remoteUrl — local project
      };
      const { results, errors } = await closeHooks.collect<CloseHookResult>("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });
});
