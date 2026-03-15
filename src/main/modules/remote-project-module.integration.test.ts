/**
 * Integration tests for RemoteProjectModule.
 *
 * Tests hook handlers through Dispatcher operations that collect individual
 * hook points, with frozen contexts and result/error collection.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { SILENT_LOGGER, createMockLogger } from "../../services/logging";
import { createMockGitClient, gitClientMatchers } from "../../services/git/git-client.state-mock";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";
import { createFileSystemMock } from "../../services/platform/filesystem.state-mock";
import { createRemoteProjectModule } from "./remote-project-module";
import { OPEN_PROJECT_OPERATION_ID, INTENT_OPEN_PROJECT } from "../operations/open-project";
import type {
  ResolveHookResult,
  ResolveHookInput,
  OpenProjectIntent,
  CloneProgressReporter,
} from "../operations/open-project";
import { CLOSE_PROJECT_OPERATION_ID, INTENT_CLOSE_PROJECT } from "../operations/close-project";
import type {
  CloseHookInput,
  CloseHookResult,
  CloseProjectIntent,
} from "../operations/close-project";
import type {
  HookContext,
  HookResult,
  Operation,
  OperationContext,
} from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { Path } from "../../services/platform/path";
import { extractRepoName } from "../../services/project/url-utils";
import type { ProjectId } from "../../shared/api/types";

// Pre-computed: generateProjectIdFromUrl("https://github.com/org/repo.git")
const URL_PROJECT_ID = "repo-4c06e3f1" as ProjectId;

expect.extend(gitClientMatchers);

const noopReport: CloneProgressReporter = () => {};

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

function createTestSetup() {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const fs = createFileSystemMock();
  const gitClient = createMockGitClient();
  const pathProvider = createMockPathProvider();

  const openOp = new CollectOperation<OpenProjectIntent>(OPEN_PROJECT_OPERATION_ID);
  const closeOp = new CollectOperation<CloseProjectIntent>(CLOSE_PROJECT_OPERATION_ID);

  dispatcher.registerOperation(INTENT_OPEN_PROJECT, openOp);
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, closeOp);

  const module = createRemoteProjectModule({
    fs,
    gitClient,
    pathProvider,
    logger: SILENT_LOGGER,
  });

  dispatcher.registerModule(module);

  const openHooks = createTestHooks(dispatcher, INTENT_OPEN_PROJECT, openOp);
  const closeHooks = createTestHooks(dispatcher, INTENT_CLOSE_PROJECT, closeOp);

  return { openHooks, closeHooks, fs, gitClient, pathProvider };
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

function resolveContext(
  intent: OpenProjectIntent,
  report: CloneProgressReporter = noopReport
): ResolveHookInput {
  return { intent, report };
}

function closeProjectIntent(payload: {
  projectPath: string;
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
      const { openHooks, gitClient } = createTestSetup();

      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await openHooks.collect<ResolveHookResult | undefined>(
        "resolve",
        resolveContext(intent)
      );

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
      const { openHooks, fs, gitClient, pathProvider } = createTestSetup();

      const url = "https://github.com/org/repo.git";
      const repoName = extractRepoName(url);
      const projectDir = new Path(pathProvider.dataPath("remotes"), URL_PROJECT_ID);
      const gitPath = new Path(projectDir.toString(), repoName);

      // Pre-populate filesystem so readdir succeeds
      fs.$.setEntry(gitPath.toString(), { type: "directory" });

      const intent = openProjectIntent({ git: url });

      const { results, errors } = await openHooks.collect<ResolveHookResult | undefined>(
        "resolve",
        resolveContext(intent)
      );

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
      const { openHooks } = createTestSetup();

      const intent = openProjectIntent({ path: new Path("/local/project") });

      const { results, errors } = await openHooks.collect<ResolveHookResult | undefined>(
        "resolve",
        resolveContext(intent)
      );

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(0);
    });

    it("propagates clone error", async () => {
      const { openHooks, gitClient } = createTestSetup();

      const originalClone = gitClient.clone.bind(gitClient);
      (gitClient as { clone: typeof gitClient.clone }).clone = async () => {
        throw new Error("Network error: connection refused");
      };

      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      const { results, errors } = await openHooks.collect<ResolveHookResult | undefined>(
        "resolve",
        resolveContext(intent)
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Network error: connection refused");
      expect(results).toHaveLength(0);

      // Restore
      (gitClient as { clone: typeof gitClient.clone }).clone = originalClone;
    });

    it("reports clone progress via report callback", async () => {
      const { openHooks, gitClient } = createTestSetup();

      const progressEvents: Array<{ stage: string; progress: number; name: string }> = [];
      const report: CloneProgressReporter = (stage, progress, name) => {
        progressEvents.push({ stage, progress, name });
      };

      // Override mock clone to invoke onProgress
      const originalClone = gitClient.clone.bind(gitClient);
      (gitClient as { clone: typeof gitClient.clone }).clone = async (
        url,
        targetPath,
        onProgress
      ) => {
        onProgress?.({ stage: "receiving", progress: 50 });
        onProgress?.({ stage: "resolving", progress: 100 });
        return originalClone(url, targetPath);
      };

      const intent = openProjectIntent({ git: "https://github.com/org/repo.git" });

      await openHooks.collect<ResolveHookResult | undefined>(
        "resolve",
        resolveContext(intent, report)
      );

      expect(progressEvents).toEqual([
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
      const { closeHooks, fs } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";

      // Pre-populate clone directory
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeIntnt = closeProjectIntent({
        projectPath: "/test/project",
        removeLocalRepo: true,
      });

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
      const { closeHooks, fs } = createTestSetup();

      const projectPath = "/test/app-data/remotes/abc12345/repo";
      fs.$.setEntry("/test/app-data/remotes/abc12345", { type: "directory" });
      fs.$.setEntry(projectPath, { type: "directory" });

      const closeIntnt = closeProjectIntent({
        projectPath: "/test/project",
        removeLocalRepo: false,
      });

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
      const { closeHooks } = createTestSetup();

      const projectPath = "/home/user/projects/local";

      const closeIntnt = closeProjectIntent({
        projectPath: "/test/project",
        removeLocalRepo: true,
      });

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
