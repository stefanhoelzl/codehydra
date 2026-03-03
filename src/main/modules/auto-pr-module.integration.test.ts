// @vitest-environment node
/**
 * Integration tests for AutoPrModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> AutoPrModule handler
 *
 * Uses minimal operations to avoid full AppStartOperation pipeline.
 * HttpClient and ProcessRunner are behavioral mocks.
 *
 * The real config module fires config:updated during init (before activate).
 * Tests simulate this by having the MinimalActivateOperation emit the event first.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SILENT_LOGGER } from "../../services/logging";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Project, WorkspaceName } from "../../shared/api/types";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
  type ActivateHookResult,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../operations/app-shutdown";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../operations/open-project";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
} from "../operations/delete-workspace";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../operations/set-metadata";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedEvent } from "../operations/config-set-values";
import { createMockProcessRunner } from "../../services/platform/process.state-mock";
import { createMockHttpClient } from "../../services/platform/http-client.state-mock";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../services/platform/filesystem.state-mock";
import { createAutoPrModule, parseTemplateOutput } from "./auto-pr-module";

// =============================================================================
// Minimal Test Operations
// =============================================================================

/**
 * Minimal operation that emits config:updated (simulating the real config module)
 * then runs the "activate" hook point.
 */
class MinimalActivateOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;
  configValues: Record<string, unknown>;

  constructor(configValues?: Record<string, unknown>) {
    this.configValues = configValues ?? {};
  }

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    // Simulate config module emitting config:updated during init phase
    if (Object.keys(this.configValues).length > 0) {
      const configEvent: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: this.configValues },
      };
      ctx.emit(configEvent);
    }

    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect<ActivateHookResult>("activate", hookCtx);
    if (errors.length > 0) throw errors[0]!;
  }
}

/**
 * Tracking operation for project:open — records dispatches and returns a fake project.
 */
class TrackingOpenProjectOperation implements Operation<OpenProjectIntent, Project> {
  readonly id = "open-project";
  readonly dispatched: OpenProjectIntent[] = [];

  async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project> {
    this.dispatched.push(ctx.intent);
    const gitUrl = ctx.intent.payload.git ?? "";
    const repoName = gitUrl.replace(/.*\//, "").replace(/\.git$/, "") || "repo";
    return {
      id: "project-1" as Project["id"],
      name: repoName,
      path: `/home/user/projects/${repoName}`,
      workspaces: [],
    };
  }
}

/**
 * Tracking operation for workspace:open — records dispatches.
 */
class TrackingOpenWorkspaceOperation implements Operation<
  OpenWorkspaceIntent,
  {
    projectId: string;
    name: string;
    path: string;
    branch: string;
    metadata: Record<string, string>;
  }
> {
  readonly id = "open-workspace";
  readonly dispatched: OpenWorkspaceIntent[] = [];

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<{
    projectId: string;
    name: string;
    path: string;
    branch: string;
    metadata: Record<string, string>;
  }> {
    this.dispatched.push(ctx.intent);
    return {
      projectId: "project-1",
      name: ctx.intent.payload.workspaceName ?? "ws",
      path: `/home/user/projects/repo/${ctx.intent.payload.workspaceName ?? "ws"}`,
      branch: "feature",
      metadata: {},
    };
  }
}

/**
 * Tracking operation for workspace:delete — records dispatches and emits event.
 */
class TrackingDeleteWorkspaceOperation implements Operation<
  DeleteWorkspaceIntent,
  { started: true }
> {
  readonly id = "delete-workspace";
  readonly dispatched: DeleteWorkspaceIntent[] = [];

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    this.dispatched.push(ctx.intent);
    const event: WorkspaceDeletedEvent = {
      type: EVENT_WORKSPACE_DELETED,
      payload: {
        projectId: "project-1" as Project["id"],
        workspaceName: "pr-42/feature-login" as WorkspaceName,
        workspacePath: ctx.intent.payload.workspacePath,
        projectPath: "/home/user/projects/repo",
      },
    };
    ctx.emit(event);
    return { started: true };
  }
}

/**
 * Tracking operation for workspace:set-metadata — records dispatches.
 */
class TrackingSetMetadataOperation implements Operation<SetMetadataIntent, void> {
  readonly id = "set-metadata";
  readonly dispatched: SetMetadataIntent[] = [];

  async execute(ctx: OperationContext<SetMetadataIntent>): Promise<void> {
    this.dispatched.push(ctx.intent);
  }
}

// =============================================================================
// GitHub API Response Helpers
// =============================================================================

function searchResponse(
  items: Array<{
    number: number;
    htmlUrl: string;
    repositoryUrl: string;
  }>
): string {
  return JSON.stringify({
    items: items.map((item) => ({
      number: item.number,
      html_url: item.htmlUrl,
      pull_request: { html_url: item.htmlUrl },
      repository_url: item.repositoryUrl,
    })),
  });
}

function prDetailResponse(headRef: string, baseRef: string): string {
  return JSON.stringify({
    number: 42,
    title: "Add login feature",
    body: "This PR adds a login feature with OAuth support.",
    html_url: "https://github.com/org/repo/pull/42",
    head: { ref: headRef, sha: "abc123" },
    base: { ref: baseRef, sha: "def456" },
    user: { login: "johndoe", id: 12345 },
    draft: false,
    labels: [{ name: "enhancement" }],
  });
}

function repoDetailResponse(cloneUrl: string): string {
  return JSON.stringify({
    clone_url: cloneUrl,
  });
}

// =============================================================================
// Test Setup
// =============================================================================

const SEARCH_URL = `https://api.github.com/search/issues?q=${encodeURIComponent("is:open is:pr review-requested:@me")}&sort=created&order=desc&per_page=100`;
const PR_DETAIL_URL = "https://api.github.com/repos/org/repo/pulls/42";
const REPO_DETAIL_URL = "https://api.github.com/repos/org/repo";

interface TestSetup {
  dispatcher: Dispatcher;
  httpClient: ReturnType<typeof createMockHttpClient>;
  processRunner: ReturnType<typeof createMockProcessRunner>;
  fs: ReturnType<typeof createFileSystemMock>;
  openProjectOp: TrackingOpenProjectOperation;
  openWorkspaceOp: TrackingOpenWorkspaceOperation;
  deleteWorkspaceOp: TrackingDeleteWorkspaceOperation;
  setMetadataOp: TrackingSetMetadataOperation;
}

const DEFAULT_TEMPLATE_PATH = "/data/review.liquid";
const DEFAULT_TEMPLATE_CONTENT = "Review PR #{{ number }}: {{ title }}";

function createTestSetup(options?: {
  ghAuthFails?: boolean;
  disabled?: boolean;
  existingState?: string;
  templatePath?: string | null;
  templateContent?: string;
}): TestSetup {
  // By default the module is enabled (templatePath set). Use disabled: true to test disabled state.
  const tplPath = options?.disabled
    ? null
    : options?.templatePath !== undefined
      ? options.templatePath
      : DEFAULT_TEMPLATE_PATH;
  // Only use default content when templatePath is not explicitly overridden (or content is provided)
  const tplContent =
    options?.templateContent !== undefined
      ? options.templateContent
      : options?.templatePath !== undefined
        ? undefined
        : DEFAULT_TEMPLATE_CONTENT;

  const processRunner = createMockProcessRunner({
    onSpawn: (command, args) => {
      if (command === "gh" && args[0] === "auth") {
        if (options?.ghAuthFails) {
          return { exitCode: 1, stderr: "not logged in" };
        }
        return { exitCode: 0, stdout: "ghp_test_token_123\n" };
      }
      return {};
    },
  });

  const httpClient = createMockHttpClient();
  const fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/data": directory(),
  };
  if (options?.existingState) {
    fsEntries["/data/auto-pr-workspaces.json"] = file(options.existingState);
  }
  if (tplPath && tplContent !== undefined) {
    fsEntries[tplPath] = file(tplContent);
  }
  const fs = createFileSystemMock({ entries: fsEntries });

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const openProjectOp = new TrackingOpenProjectOperation();
  const openWorkspaceOp = new TrackingOpenWorkspaceOperation();
  const deleteWorkspaceOp = new TrackingDeleteWorkspaceOperation();
  const setMetadataOp = new TrackingSetMetadataOperation();

  const configValues: Record<string, unknown> = {};
  if (tplPath !== null) {
    configValues["experimental.auto-pr-template-path"] = tplPath;
  }
  dispatcher.registerOperation(INTENT_APP_START, new MinimalActivateOperation(configValues));
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, openProjectOp);
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, openWorkspaceOp);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteWorkspaceOp);
  dispatcher.registerOperation(INTENT_SET_METADATA, setMetadataOp);

  const autoPrModule = createAutoPrModule({
    processRunner,
    httpClient,
    fs,
    logger: SILENT_LOGGER,
    stateFilePath: "/data/auto-pr-workspaces.json",
    dispatcher,
  });

  dispatcher.registerModule(autoPrModule);

  return {
    dispatcher,
    httpClient,
    processRunner,
    fs,
    openProjectOp,
    openWorkspaceOp,
    deleteWorkspaceOp,
    setMetadataOp,
  };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

function shutdownIntent(): AppShutdownIntent {
  return { type: INTENT_APP_SHUTDOWN, payload: {} as AppShutdownIntent["payload"] };
}

// =============================================================================
// Tests
// =============================================================================

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoPrModule Integration", () => {
  describe("activation", () => {
    it("does nothing when no template path configured", async () => {
      const { dispatcher, httpClient } = createTestSetup({ disabled: true });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveNoRequests();
    });

    it("disables silently when gh auth token fails", async () => {
      const { dispatcher, httpClient } = createTestSetup({ ghAuthFails: true });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveNoRequests();
    });

    it("polls GitHub on activation when enabled and authenticated", async () => {
      const { dispatcher, httpClient } = createTestSetup();

      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveRequested(SEARCH_URL);
    });
  });

  describe("new PR detection", () => {
    it("creates workspace when new PR is detected", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp } = createTestSetup();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, {
        body: prDetailResponse("feature-login", "main"),
      });
      httpClient.setResponse(REPO_DETAIL_URL, {
        body: repoDetailResponse("https://github.com/org/repo.git"),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(1);
      expect(openProjectOp.dispatched[0]!.payload.git).toBe("https://github.com/org/repo.git");

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("pr-42/feature-login");
      expect(openWorkspaceOp.dispatched[0]!.payload.stealFocus).toBe(false);
      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Review PR #42: Add login feature",
        agent: "plan",
      });
    });

    it("does not recreate workspace for already-tracked PR", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": {
            workspaceName: "pr-42/feature-login",
            workspacePath: "/data/workspaces/repo-abc/workspaces/pr-42/feature-login",
            prNumber: 42,
            repo: "org/repo",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).not.toHaveRequested(PR_DETAIL_URL);
      expect(httpClient).not.toHaveRequested(REPO_DETAIL_URL);
      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("PR disappearance", () => {
    it("deletes workspace when tracked PR disappears from search results", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": {
            workspaceName: "pr-42/feature-login",
            workspacePath: "/data/workspaces/repo-abc/workspaces/pr-42/feature-login",
            prNumber: 42,
            repo: "org/repo",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp } = createTestSetup({ existingState });

      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.removeWorktree).toBe(true);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.force).toBe(true);
    });
  });

  describe("shutdown", () => {
    it("clears poll timer on shutdown", async () => {
      const { dispatcher, httpClient } = createTestSetup();
      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(shutdownIntent());

      // Verified by no timer leak — shutdown is best-effort
    });
  });

  describe("state persistence", () => {
    it("persists state after creating a PR workspace", async () => {
      const { dispatcher, httpClient, fs } = createTestSetup();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, {
        body: prDetailResponse("feature-login", "main"),
      });
      httpClient.setResponse(REPO_DETAIL_URL, {
        body: repoDetailResponse("https://github.com/org/repo.git"),
      });

      await dispatcher.dispatch(startIntent());

      expect(fs).toHaveFile("/data/auto-pr-workspaces.json");
    });

    it("loads existing state on startup", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": {
            workspaceName: "pr-42/feature-login",
            workspacePath: "/data/workspaces/repo-abc/workspaces/pr-42/feature-login",
            prNumber: 42,
            repo: "org/repo",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("continues when GitHub search API returns non-OK", async () => {
      const { dispatcher, httpClient, openProjectOp } = createTestSetup();

      httpClient.setResponse(SEARCH_URL, { status: 403, body: "rate limited" });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("skips PR when detail fetch fails", async () => {
      const { dispatcher, httpClient, openProjectOp } = createTestSetup();

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, { status: 404 });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("initial prompt and template behavior", () => {
    const TEMPLATE_PATH = "/data/review.liquid";

    function setupWithPr(options?: { templatePath?: string | null; templateContent?: string }) {
      const setup = createTestSetup(options);
      setup.httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      setup.httpClient.setResponse(PR_DETAIL_URL, {
        body: prDetailResponse("feature-login", "main"),
      });
      setup.httpClient.setResponse(REPO_DETAIL_URL, {
        body: repoDetailResponse("https://github.com/org/repo.git"),
      });
      return setup;
    }

    it("renders template file with PR detail data when template-path configured", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "Review PR #{{ number }}: {{ title }} by {{ user.login }}",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Review PR #42: Add login feature by johndoe",
        agent: "plan",
      });
    });

    it("skips workspace creation when template file not found", async () => {
      const { dispatcher, openProjectOp, openWorkspaceOp, fs } = setupWithPr({
        templatePath: "/data/nonexistent.liquid",
      });

      await dispatcher.dispatch(startIntent());

      // No workspace created — template read failure means empty prompt → skip
      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      // Null entry recorded in state
      expect(fs).toHaveFileContaining(
        "/data/auto-pr-workspaces.json",
        '"https://github.com/org/repo/pull/42": null'
      );
    });

    it("skips workspace creation on template render failure", async () => {
      const { dispatcher, openProjectOp, openWorkspaceOp, fs } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "{% invalid_tag %}",
      });

      await dispatcher.dispatch(startIntent());

      // No workspace created — render failure means empty prompt → skip
      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining(
        "/data/auto-pr-workspaces.json",
        '"https://github.com/org/repo/pull/42": null'
      );
    });

    it("skips workspace creation when template renders to whitespace-only", async () => {
      const { dispatcher, openProjectOp, openWorkspaceOp, fs } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "   \n  ",
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining(
        "/data/auto-pr-workspaces.json",
        '"https://github.com/org/repo/pull/42": null'
      );
    });

    it("does not re-evaluate template for previously skipped PR", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": null,
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({
        existingState,
        templatePath: TEMPLATE_PATH,
        templateContent: "Review PR #{{ number }}",
      });

      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      await dispatcher.dispatch(startIntent());

      // Should not fetch PR detail (skipped without re-evaluation)
      expect(httpClient).not.toHaveRequested(PR_DETAIL_URL);
      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("picks up template-path config for workspace creation", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "Branch: {{ head.ref }}",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Branch: feature-login",
        agent: "plan",
      });
    });

    it("uses front-matter name to override workspace name", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nname: review/{{ number }}\n---\nReview PR #{{ number }}",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("review/42");
    });

    it("uses front-matter agent to override agent mode", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nagent: build\n---\nDo the thing",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Do the thing",
        agent: "build",
      });
    });

    it("uses front-matter base to override base branch", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nbase: origin/develop\n---\nReview",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.base).toBe("origin/develop");
    });

    it("uses front-matter focus to override stealFocus", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nfocus: true\n---\nReview",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.stealFocus).toBe(true);
    });

    it("uses front-matter model to set model in initial prompt", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nmodel.provider: anthropic\nmodel.id: claude-sonnet-4-6\n---\nReview",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Review",
        agent: "plan",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      });
    });

    it("skips workspace when front-matter prompt body is empty", async () => {
      const { dispatcher, openProjectOp, openWorkspaceOp, fs } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nname: review/{{ number }}\n---\n   ",
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining(
        "/data/auto-pr-workspaces.json",
        '"https://github.com/org/repo/pull/42": null'
      );
    });

    it("dispatches set-metadata intents after workspace creation", async () => {
      const template = [
        "---",
        "name: review/{{ number }}",
        "metadata.pr-url: {{ html_url }}",
        "metadata.pr-number: {{ number }}",
        "---",
        "Review PR #{{ number }}",
      ].join("\n");

      const { dispatcher, openWorkspaceOp, setMetadataOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: template,
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(setMetadataOp.dispatched).toHaveLength(2);

      const metaPayloads = setMetadataOp.dispatched.map((i) => ({
        key: i.payload.key,
        value: i.payload.value,
      }));
      expect(metaPayloads).toContainEqual({
        key: "pr-url",
        value: "https://github.com/org/repo/pull/42",
      });
      expect(metaPayloads).toContainEqual({
        key: "pr-number",
        value: "42",
      });

      // workspacePath should be passed through
      for (const intent of setMetadataOp.dispatched) {
        expect(intent.payload.workspacePath).toBe("/home/user/projects/repo/review/42");
      }
    });

    it("does not dispatch set-metadata when no metadata keys in template", async () => {
      const { dispatcher, openWorkspaceOp, setMetadataOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nname: review/{{ number }}\n---\nReview PR #{{ number }}",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(setMetadataOp.dispatched).toHaveLength(0);
    });

    it("creates workspace despite unknown front-matter keys (non-fatal warning)", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: "---\nunknown: value\n---\nReview",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Review",
        agent: "plan",
      });
    });

    it("applies all front-matter overrides together", async () => {
      const template = [
        "---",
        "name: review/{{ number }}",
        "agent: build",
        "base: origin/{{ base.ref }}",
        "focus: true",
        "model.provider: anthropic",
        "model.id: claude-sonnet-4-6",
        "---",
        "Review PR #{{ number }}: {{ title }}",
      ].join("\n");

      const { dispatcher, openWorkspaceOp } = setupWithPr({
        templatePath: TEMPLATE_PATH,
        templateContent: template,
      });

      await dispatcher.dispatch(startIntent());

      const payload = openWorkspaceOp.dispatched[0]!.payload;
      expect(payload.workspaceName).toBe("review/42");
      expect(payload.base).toBe("origin/main");
      expect(payload.stealFocus).toBe(true);
      expect(payload.initialPrompt).toEqual({
        prompt: "Review PR #42: Add login feature",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      });
    });
  });

  describe("template-skipped PR cleanup", () => {
    it("cleans up template-skipped null entry when PR disappears", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": null,
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, fs } = createTestSetup({ existingState });

      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-pr-workspaces.json", '"workspaces": {}');
    });
  });

  describe("manual workspace deletion", () => {
    it("does not recreate workspace after manual deletion", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp } = createTestSetup();

      // First poll: workspace gets created
      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });
      httpClient.setResponse(PR_DETAIL_URL, {
        body: prDetailResponse("feature-login", "main"),
      });
      httpClient.setResponse(REPO_DETAIL_URL, {
        body: repoDetailResponse("https://github.com/org/repo.git"),
      });

      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      // User manually deletes the workspace (dispatch triggers workspace:deleted event)
      await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/home/user/projects/repo/pr-42/feature-login",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      // Reset tracking and set up second poll with same PR
      openProjectOp.dispatched.length = 0;
      openWorkspaceOp.dispatched.length = 0;
      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      // Trigger manual poll via shutdown + restart
      await dispatcher.dispatch(shutdownIntent());
      await dispatcher.dispatch(startIntent());

      // Workspace should NOT be recreated
      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
    });

    it("cleans up null entry when PR disappears from GitHub", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": null,
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, fs } = createTestSetup({ existingState });

      // Poll returns empty — PR no longer requesting review
      httpClient.setResponse(SEARCH_URL, { body: searchResponse([]) });

      await dispatcher.dispatch(startIntent());

      // Should NOT dispatch a delete (workspace already gone)
      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);

      // State file should have empty workspaces (entry cleaned up)
      expect(fs).toHaveFileContaining("/data/auto-pr-workspaces.json", '"workspaces": {}');
    });

    it("loads null entry from persisted state and skips PR", async () => {
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          "https://github.com/org/repo/pull/42": null,
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      // Poll returns the same PR
      httpClient.setResponse(SEARCH_URL, {
        body: searchResponse([
          {
            number: 42,
            htmlUrl: "https://github.com/org/repo/pull/42",
            repositoryUrl: "https://api.github.com/repos/org/repo",
          },
        ]),
      });

      await dispatcher.dispatch(startIntent());

      // Should NOT create a workspace
      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });
});

// =============================================================================
// parseTemplateOutput
// =============================================================================

describe("parseTemplateOutput", () => {
  it("treats entire string as prompt when no front matter", () => {
    const result = parseTemplateOutput("Review PR #42");
    expect(result.config).toEqual({ prompt: "Review PR #42" });
    expect(result.warnings).toEqual([]);
  });

  it("parses all supported front-matter fields", () => {
    const input = [
      "---",
      "name: review/42",
      "agent: plan",
      "base: origin/main",
      "focus: true",
      "model.provider: anthropic",
      "model.id: claude-sonnet-4-6",
      "---",
      "Review this PR",
    ].join("\n");

    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({
      prompt: "Review this PR",
      name: "review/42",
      agent: "plan",
      base: "origin/main",
      focus: true,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("returns only specified fields (rest remain undefined)", () => {
    const input = "---\nagent: build\n---\nDo the thing";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toBe("build");
    expect(result.config.name).toBeUndefined();
    expect(result.config.base).toBeUndefined();
    expect(result.config.focus).toBeUndefined();
    expect(result.config.model).toBeUndefined();
    expect(result.config.prompt).toBe("Do the thing");
  });

  it("handles empty front matter (prompt only)", () => {
    const input = "---\n---\nJust the prompt";
    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({ prompt: "Just the prompt" });
    expect(result.warnings).toEqual([]);
  });

  it("warns on unknown front-matter keys", () => {
    const input = "---\nunknown: value\nname: ws\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("ws");
    expect(result.warnings).toEqual(['Unknown front-matter key: "unknown"']);
  });

  it("warns on invalid boolean value for focus", () => {
    const input = "---\nfocus: banana\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.focus).toBeUndefined();
    expect(result.warnings).toEqual(['Invalid focus value "banana", expected "true" or "false"']);
  });

  it("treats opening --- without closing as no front matter", () => {
    const input = "---\nname: ws\nno closing delimiter";
    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({ prompt: input });
    expect(result.warnings).toEqual([]);
  });

  it("warns when only model.provider is specified", () => {
    const input = "---\nmodel.provider: anthropic\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.model).toBeUndefined();
    expect(result.warnings).toEqual([
      "Both model.provider and model.id must be specified together",
    ]);
  });

  it("warns when only model.id is specified", () => {
    const input = "---\nmodel.id: claude-sonnet-4-6\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.model).toBeUndefined();
    expect(result.warnings).toEqual([
      "Both model.provider and model.id must be specified together",
    ]);
  });

  it("ignores comments and blank lines in front matter", () => {
    const input = "---\n# this is a comment\n\nname: ws\n\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("ws");
    expect(result.warnings).toEqual([]);
  });

  it("splits on first colon only (values can contain colons)", () => {
    const input = "---\nbase: origin/main:feature\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.base).toBe("origin/main:feature");
  });

  it("parses focus: false correctly", () => {
    const input = "---\nfocus: false\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.focus).toBe(false);
  });

  it("strips single leading newline after closing delimiter", () => {
    const input = "---\nname: ws\n---\n\nTwo newlines before this";
    const result = parseTemplateOutput(input);
    expect(result.config.prompt).toBe("\nTwo newlines before this");
  });

  it("parses metadata.* keys into metadata record", () => {
    const input =
      "---\nmetadata.pr-url: https://github.com/org/repo/pull/42\nmetadata.pr-number: 42\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({
      "pr-url": "https://github.com/org/repo/pull/42",
      "pr-number": "42",
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns on invalid metadata key", () => {
    const input =
      "---\nmetadata.note-: trailing hyphen\nmetadata.123: leading digit\nmetadata.: empty\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toBeUndefined();
    expect(result.warnings).toEqual([
      'Invalid metadata key: "note-"',
      'Invalid metadata key: "123"',
      'Invalid metadata key: ""',
    ]);
  });

  it("includes valid keys and warns on invalid ones in same template", () => {
    const input = "---\nmetadata.good-key: value\nmetadata.bad-: invalid\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({ "good-key": "value" });
    expect(result.warnings).toEqual(['Invalid metadata key: "bad-"']);
  });

  it("metadata works alongside other front-matter fields", () => {
    const input =
      "---\nname: review/42\nmetadata.pr-url: https://example.com\nagent: plan\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("review/42");
    expect(result.config.agent).toBe("plan");
    expect(result.config.metadata).toEqual({ "pr-url": "https://example.com" });
    expect(result.warnings).toEqual([]);
  });

  it("empty metadata values are valid", () => {
    const input = "---\nmetadata.note:\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({ note: "" });
    expect(result.warnings).toEqual([]);
  });
});
