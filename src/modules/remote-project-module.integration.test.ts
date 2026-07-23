/**
 * Integration tests for RemoteProjectModule.
 *
 * Tests hook handlers through the Dispatcher -- the same
 * infrastructure used by operations -- with frozen contexts and result/error
 * collection.
 */

import { describe, it, expect } from "vitest";
import type {
  CollectOptions,
  HookContext,
  HookOutput,
  HookResult,
  OperationSchemas,
  ResolvedHooks,
} from "../intents/lib/operation";
import type { IntentModule } from "../intents/lib/module";

import { SILENT_LOGGER } from "../boundaries/platform/logging";
import {
  createMockGitClient,
  gitClientMatchers,
} from "../boundaries/platform/git-client.state-mock";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { createFileSystemMock } from "../boundaries/platform/filesystem.state-mock";
import { createRemoteProjectModule } from "./remote-project-module";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import type { OpenProjectIntent, CloneProgressFrame } from "../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../intents/close-project";
import type { CloseHookInput, CloseProjectIntent } from "../intents/close-project";
import { Path } from "../utils/path/path";
import { extractRepoName } from "../utils/url-utils";
import type { ProjectId } from "../shared/api/types";
import type { schemas as openProjectSchemas } from "../intents/open-project";
import type { schemas as closeProjectSchemas } from "../intents/close-project";
import type { ProjectPath } from "../intents/contract";
import { projPath } from "../shared/test-fixtures";

// Pre-computed: generateProjectIdFromUrl("https://github.com/org/repo.git")
const URL_PROJECT_ID = "repo-4c06e3f1" as ProjectId;

expect.extend(gitClientMatchers);

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Build a ResolvedHooks view from a module's hook declarations for a given operation.
 * Mirrors the Dispatcher: awaits a plain handler, or drains a streaming
 * (async-generator) handler, forwarding yielded frames to options.onYield.
 */
function resolveHooksFromModule<S extends OperationSchemas>(
  module: IntentModule,
  operationId: string
): ResolvedHooks<S> {
  const opHooks = module.hooks?.[operationId] ?? {};
  return {
    collect: async <T>(
      hookPointId: string,
      ctx: HookContext,
      options?: CollectOptions
    ): Promise<HookResult<T>> => {
      const hookHandler = opHooks[hookPointId];
      if (!hookHandler) {
        return { results: [], errors: [], capabilities: {} };
      }
      try {
        const invoked = hookHandler.handler(ctx);
        let output: HookOutput<T> | void;
        if (typeof invoked === "object" && invoked !== null && Symbol.asyncIterator in invoked) {
          const gen = invoked as AsyncGenerator<unknown, HookOutput<T> | void, void>;
          let next = await gen.next();
          while (!next.done) {
            if (options?.onYield) await options.onYield(next.value);
            next = await gen.next();
          }
          output = next.value;
        } else {
          output = (await invoked) as HookOutput<T> | void;
        }
        // Unwrap HookOutput.result; filter out undefined/null to match Dispatcher
        // behavior (undefined/null = "not handled")
        const result = output?.result;
        const results: T[] = result !== undefined && result !== null ? [result] : [];
        return { results, errors: [], capabilities: {} };
      } catch (error) {
        return { results: [], errors: [error as Error], capabilities: {} };
      }
    },
  };
}

function createTestSetup() {
  const fs = createFileSystemMock();
  const gitClient = createMockGitClient();
  const pathProvider = createMockPathProvider();

  const module = createRemoteProjectModule({
    fs,
    gitClient,
    pathProvider,
    logger: SILENT_LOGGER,
  });

  const hookRegistry = {
    // Generic over the operation's bundle so each caller gets that operation's hook points
    // and result types — project:open and project:close have different ones.
    resolve: <S extends OperationSchemas>(operationId: string) =>
      resolveHooksFromModule<S>(module, operationId),
  };

  return { hookRegistry, fs, gitClient, pathProvider };
}

// =============================================================================
// Intent Helpers
// =============================================================================

function openProjectIntent(payload: { git?: string; path?: ProjectPath }): OpenProjectIntent {
  return {
    type: "project:open",
    payload,
  };
}

function resolveContext(intent: OpenProjectIntent): HookContext {
  return { intent };
}

function closeProjectIntent(payload: {
  projectPath: ProjectPath;
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

      const hooks = hookRegistry.resolve<typeof openProjectSchemas>(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await hooks.collect("resolve", resolveContext(intent));

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
      const repoName = extractRepoName(url);
      const projectDir = new Path(pathProvider.dataPath("remotes"), URL_PROJECT_ID);
      const gitPath = new Path(projectDir.toString(), repoName);

      // Pre-populate filesystem so readdir succeeds
      fs.$.setEntry(gitPath.toString(), { type: "directory" });

      const hooks = hookRegistry.resolve<typeof openProjectSchemas>(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: url });

      const { results, errors } = await hooks.collect("resolve", resolveContext(intent));

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

      const hooks = hookRegistry.resolve<typeof openProjectSchemas>(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ path: projPath(new Path("/local/project").toString()) });

      const { results, errors } = await hooks.collect("resolve", resolveContext(intent));

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(0);
    });

    it("propagates clone error", async () => {
      const { hookRegistry, gitClient } = createTestSetup();

      const originalClone = gitClient.clone.bind(gitClient);
      (gitClient as { clone: typeof gitClient.clone }).clone = async () => {
        throw new Error("Network error: connection refused");
      };

      const hooks = hookRegistry.resolve<typeof openProjectSchemas>(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await hooks.collect("resolve", resolveContext(intent));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Network error: connection refused");
      expect(results).toHaveLength(0);

      // Restore
      (gitClient as { clone: typeof gitClient.clone }).clone = originalClone;
    });

    it("streams clone progress frames via onYield", async () => {
      const { hookRegistry, gitClient } = createTestSetup();

      const progressFrames: CloneProgressFrame[] = [];

      // Override mock clone to invoke onProgress
      const originalClone = gitClient.clone.bind(gitClient);
      (gitClient as { clone: typeof gitClient.clone }).clone = async (
        url: string,
        targetPath: Path,
        onProgress?: (event: { stage: string; progress: number }) => void
      ) => {
        onProgress?.({ stage: "receiving", progress: 50 });
        onProgress?.({ stage: "resolving", progress: 100 });
        return originalClone(url, targetPath);
      };

      const hooks = hookRegistry.resolve<typeof openProjectSchemas>(OPEN_PROJECT_OPERATION_ID);
      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      await hooks.collect("resolve", resolveContext(intent), {
        onYield: (frame) => {
          progressFrames.push(frame as CloneProgressFrame);
        },
      });

      expect(progressFrames).toEqual([
        { stage: "receiving", progress: 0.5, name: "repo" },
        { stage: "resolving", progress: 1, name: "repo" },
      ]);

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

      const projectPath = projPath("/test/app-data/remotes/abc12345/repo");

      // Pre-populate clone directory
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeHooks = hookRegistry.resolve<typeof closeProjectSchemas>(
        CLOSE_PROJECT_OPERATION_ID
      );
      const closeIntnt = closeProjectIntent({
        projectPath: projPath("/test/project"),
        removeLocalRepo: true,
      });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: true,
        remoteUrl: "https://github.com/org/repo.git",
      };
      const { results, errors } = await closeHooks.collect("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);

      // Clone dir (parent of projectPath) should be deleted
      expect(fs.$.entries.has(new Path("/test/app-data/remotes/abc12345").toString())).toBe(false);
    });

    it("no-op when removeLocalRepo=false", async () => {
      const { hookRegistry, fs } = createTestSetup();

      const projectPath = projPath("/test/app-data/remotes/abc12345/repo");
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeHooks = hookRegistry.resolve<typeof closeProjectSchemas>(
        CLOSE_PROJECT_OPERATION_ID
      );
      const closeIntnt = closeProjectIntent({
        projectPath: projPath("/test/project"),
        removeLocalRepo: false,
      });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: false,
        remoteUrl: "https://github.com/org/repo.git",
      };
      const { results, errors } = await closeHooks.collect("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});

      // Directory should still exist
      expect(fs.$.entries.has(new Path("/test/app-data/remotes/abc12345").toString())).toBe(true);
    });

    it("no-op when no remoteUrl in context (local project)", async () => {
      const { hookRegistry } = createTestSetup();

      const projectPath = projPath("/home/user/projects/local");

      const closeHooks = hookRegistry.resolve<typeof closeProjectSchemas>(
        CLOSE_PROJECT_OPERATION_ID
      );
      const closeIntnt = closeProjectIntent({
        projectPath: projPath("/test/project"),
        removeLocalRepo: true,
      });

      const closeCtx: CloseHookInput = {
        intent: closeIntnt,
        projectPath,
        removeLocalRepo: true,
        // No remoteUrl — local project
      };
      const { results, errors } = await closeHooks.collect("close", closeCtx);

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });
});
