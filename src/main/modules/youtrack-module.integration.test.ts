// @vitest-environment node
/**
 * Integration tests for YouTrackModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> YouTrackModule handler
 *
 * Uses minimal operations to avoid full AppStartOperation pipeline.
 * HttpClient is a behavioral mock.
 *
 * The real config module fires config:updated during init (before activate).
 * Tests simulate this by having the MinimalActivateOperation emit the event first.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SILENT_LOGGER } from "../../services/logging";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Project, ProjectId, WorkspaceName } from "../../shared/api/types";
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
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../operations/delete-workspace";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../operations/set-metadata";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../operations/list-projects";
import {
  EVENT_CONFIG_UPDATED,
  INTENT_CONFIG_SET_VALUES,
  type ConfigUpdatedEvent,
  type ConfigSetValuesIntent,
} from "../operations/config-set-values";
import { createMockHttpClient } from "../../services/platform/http-client.state-mock";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../services/platform/filesystem.state-mock";
import { createYouTrackModule, parseYouTrackTemplateOutput } from "./youtrack-module";

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
    const pathStr = ctx.intent.payload.path?.toString() ?? "";
    const repoName =
      gitUrl.replace(/.*\//, "").replace(/\.git$/, "") || pathStr.replace(/.*\//, "") || "repo";
    return {
      id: "project-1" as Project["id"],
      name: repoName,
      path: pathStr || `/home/user/projects/${repoName}`,
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
  readonly failForPaths = new Set<string>();

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    this.dispatched.push(ctx.intent);
    if (this.failForPaths.has(ctx.intent.payload.workspacePath)) {
      const failedEvent: WorkspaceDeleteFailedEvent = {
        type: EVENT_WORKSPACE_DELETE_FAILED,
        payload: { workspacePath: ctx.intent.payload.workspacePath },
      };
      ctx.emit(failedEvent);
    } else {
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: "project-1" as Project["id"],
          workspaceName: "PROJ-123" as WorkspaceName,
          workspacePath: ctx.intent.payload.workspacePath,
          projectPath: "/home/user/projects/repo",
        },
      };
      ctx.emit(event);
    }
    return { started: true };
  }
}

/**
 * Minimal config-set operation that emits config:updated with the provided values.
 */
class MinimalConfigSetOperation implements Operation<ConfigSetValuesIntent, void> {
  readonly id = "config-set-values";

  async execute(ctx: OperationContext<ConfigSetValuesIntent>): Promise<void> {
    const event: ConfigUpdatedEvent = {
      type: EVENT_CONFIG_UPDATED,
      payload: { values: ctx.intent.payload.values },
    };
    ctx.emit(event);
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

/**
 * Tracking operation for project:list — returns configurable projects with workspace metadata.
 */
class TrackingListProjectsOperation implements Operation<ListProjectsIntent, Project[]> {
  readonly id = "list-projects";
  projects: Project[] = [];

  async execute(): Promise<Project[]> {
    return this.projects;
  }
}

// =============================================================================
// YouTrack API Response Helpers
// =============================================================================

const BASE_URL = "https://youtrack.example.com";
const DEFAULT_QUERY = "for:me State: {In Progress}";

function issuesResponse(
  issues: Array<{
    id: string;
    idReadable: string;
    summary: string;
    description?: string;
  }>
): string {
  return JSON.stringify(
    issues.map((issue) => ({
      id: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      description: issue.description ?? "",
      reporter: { login: "johndoe", fullName: "John Doe" },
      created: 1709000000000,
      updated: 1709100000000,
      resolved: null,
      project: { id: "0-1", name: "My Project", shortName: "PROJ" },
      customFields: [],
    }))
  );
}

// =============================================================================
// Test Setup
// =============================================================================

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";
const ISSUES_URL = `${BASE_URL}/api/issues?query=${encodeURIComponent(DEFAULT_QUERY)}&fields=${encodeURIComponent(YOUTRACK_FIELDS)}`;

interface TestSetup {
  dispatcher: Dispatcher;
  httpClient: ReturnType<typeof createMockHttpClient>;
  fs: ReturnType<typeof createFileSystemMock>;
  openProjectOp: TrackingOpenProjectOperation;
  openWorkspaceOp: TrackingOpenWorkspaceOperation;
  deleteWorkspaceOp: TrackingDeleteWorkspaceOperation;
  setMetadataOp: TrackingSetMetadataOperation;
  listProjectsOp: TrackingListProjectsOperation;
}

const DEFAULT_TEMPLATE_PATH = "/data/youtrack.liquid";
const DEFAULT_TEMPLATE_CONTENT =
  "---\ngit: https://github.com/org/repo.git\nname: {{ idReadable }}\n---\nFix {{ idReadable }}: {{ summary }}";

function createTestSetup(options?: {
  disabled?: boolean;
  partialConfig?: {
    baseUrl?: string | null;
    token?: string | null;
    templatePath?: string | null;
    query?: string | null;
  };
  existingState?: string;
  templatePath?: string | null;
  templateContent?: string;
}): TestSetup {
  // Build config values
  const isDisabled = options?.disabled;
  const partial = options?.partialConfig;

  const baseUrl = partial ? (partial.baseUrl ?? null) : isDisabled ? null : BASE_URL;
  const token = partial ? (partial.token ?? null) : isDisabled ? null : "perm:test-token";
  const tplPath = partial
    ? (partial.templatePath ?? null)
    : isDisabled
      ? null
      : options?.templatePath !== undefined
        ? options.templatePath
        : DEFAULT_TEMPLATE_PATH;
  const query = partial ? (partial.query ?? null) : isDisabled ? null : DEFAULT_QUERY;

  const tplContent =
    options?.templateContent !== undefined
      ? options.templateContent
      : options?.templatePath !== undefined
        ? undefined
        : DEFAULT_TEMPLATE_CONTENT;

  const httpClient = createMockHttpClient();

  const fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/data": directory(),
  };
  if (options?.existingState) {
    fsEntries["/data/youtrack-workspaces.json"] = file(options.existingState);
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
  const listProjectsOp = new TrackingListProjectsOperation();

  const configValues: Record<string, unknown> = {};
  if (baseUrl !== null) configValues["experimental.youtrack.base-url"] = baseUrl;
  if (token !== null) configValues["experimental.youtrack.token"] = token;
  if (tplPath !== null) configValues["experimental.youtrack.template-path"] = tplPath;
  if (query !== null) configValues["experimental.youtrack.query"] = query;

  dispatcher.registerOperation(INTENT_APP_START, new MinimalActivateOperation(configValues));
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new MinimalConfigSetOperation());
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, openProjectOp);
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, openWorkspaceOp);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteWorkspaceOp);
  dispatcher.registerOperation(INTENT_SET_METADATA, setMetadataOp);
  dispatcher.registerOperation(INTENT_LIST_PROJECTS, listProjectsOp);

  const youtrackModule = createYouTrackModule({
    httpClient,
    fs,
    logger: SILENT_LOGGER,
    stateFilePath: "/data/youtrack-workspaces.json",
    dispatcher,
  });

  dispatcher.registerModule(youtrackModule);

  return {
    dispatcher,
    httpClient,
    fs,
    openProjectOp,
    openWorkspaceOp,
    deleteWorkspaceOp,
    setMetadataOp,
    listProjectsOp,
  };
}

function youtrackTrackedProject(workspacePath: string): Project {
  return {
    id: "project-1" as ProjectId,
    name: "repo",
    path: "/home/user/projects/repo",
    workspaces: [
      {
        projectId: "project-1" as ProjectId,
        name: "PROJ-123" as WorkspaceName,
        branch: "feature",
        path: workspacePath,
        metadata: {
          source: "youtrack",
          "youtrack.tracked": "true",
        },
      },
    ],
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

describe("YouTrackModule Integration", () => {
  describe("activation", () => {
    it("does nothing when no config keys are set", async () => {
      const { dispatcher, httpClient } = createTestSetup({ disabled: true });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveNoRequests();
    });

    it("does nothing when only some config keys are set", async () => {
      const { dispatcher, httpClient } = createTestSetup({
        partialConfig: {
          baseUrl: BASE_URL,
          token: "perm:test-token",
          templatePath: null,
          query: DEFAULT_QUERY,
        },
      });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveNoRequests();
    });

    it("polls YouTrack on activation when fully configured", async () => {
      const { dispatcher, httpClient } = createTestSetup();

      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(httpClient).toHaveRequested(ISSUES_URL);
    });
  });

  describe("new issue detection", () => {
    it("creates workspace when new issue is detected", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp } = createTestSetup();

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(1);
      expect(openProjectOp.dispatched[0]!.payload.git).toBe("https://github.com/org/repo.git");

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("PROJ-123");
      expect(openWorkspaceOp.dispatched[0]!.payload.stealFocus).toBe(false);
      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Fix PROJ-123: Fix the bug",
        agent: "plan",
      });
    });

    it("uses project front-matter key for local path projects", async () => {
      const { dispatcher, httpClient, openProjectOp } = createTestSetup({
        templateContent:
          "---\nproject: /home/user/my-repo\nname: {{ idReadable }}\n---\nFix {{ summary }}",
      });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(1);
      expect(openProjectOp.dispatched[0]!.payload.path?.toString()).toBe("/home/user/my-repo");
      expect(openProjectOp.dispatched[0]!.payload.git).toBeUndefined();
    });

    it("project key takes precedence over git key", async () => {
      const { dispatcher, httpClient, openProjectOp } = createTestSetup({
        templateContent:
          "---\nproject: /home/user/my-repo\ngit: https://github.com/org/repo.git\nname: {{ idReadable }}\n---\nFix {{ summary }}",
      });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched[0]!.payload.path?.toString()).toBe("/home/user/my-repo");
      expect(openProjectOp.dispatched[0]!.payload.git).toBeUndefined();
    });

    it("skips issue when neither project nor git key is present", async () => {
      const { dispatcher, httpClient, openProjectOp, fs } = createTestSetup({
        templateContent: "---\nname: {{ idReadable }}\n---\nFix {{ summary }}",
      });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      // Should be dismissed as null
      expect(fs).toHaveFileContaining(
        "/data/youtrack-workspaces.json",
        `"${BASE_URL}/api/issues/2-123": null`
      );
    });

    it("does not recreate workspace for already-tracked issue", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: "/home/user/projects/repo/PROJ-123",
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("auto-sets source, url, and tracked metadata on created workspaces", async () => {
      const { dispatcher, httpClient, setMetadataOp } = createTestSetup();

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      const metaPayloads = setMetadataOp.dispatched.map((i) => ({
        key: i.payload.key,
        value: i.payload.value,
      }));
      expect(metaPayloads).toContainEqual({ key: "source", value: "youtrack" });
      expect(metaPayloads).toContainEqual({
        key: "url",
        value: `${BASE_URL}/issue/PROJ-123`,
      });
      expect(metaPayloads).toContainEqual({ key: "youtrack.tracked", value: "true" });
    });
  });

  describe("issue disappearance", () => {
    it("deletes workspace when tracked issue disappears from query results", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const wsPath = "/home/user/projects/repo/PROJ-123";
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: wsPath,
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, listProjectsOp } = createTestSetup({
        existingState,
      });

      listProjectsOp.projects = [youtrackTrackedProject(wsPath)];
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.removeWorktree).toBe(true);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.force).toBe(false);
    });

    it("tags workspace and clears tracked metadata when auto-deletion fails", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const wsPath = "/home/user/projects/repo/PROJ-123";
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: wsPath,
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, setMetadataOp, listProjectsOp } =
        createTestSetup({ existingState });

      listProjectsOp.projects = [youtrackTrackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);

      const trackedDispatch = setMetadataOp.dispatched.find(
        (i) => i.payload.key === "youtrack.tracked" && i.payload.value === null
      );
      expect(trackedDispatch).toBeDefined();
      expect(trackedDispatch!.payload.workspacePath).toBe(wsPath);

      const tagDispatch = setMetadataOp.dispatched.find(
        (i) => i.payload.key === "tags.deletion-failed"
      );
      expect(tagDispatch).toBeDefined();
      expect(tagDispatch!.payload.workspacePath).toBe(wsPath);
      expect(tagDispatch!.payload.value).toBe(JSON.stringify({ color: "#e74c3c" }));
    });

    it("keeps state entry when deletion fails", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const wsPath = "/home/user/projects/repo/PROJ-123";
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: wsPath,
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, fs, listProjectsOp } = createTestSetup({
        existingState,
      });

      listProjectsOp.projects = [youtrackTrackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      // State entry should still exist (not removed)
      expect(fs).toHaveFileContaining(
        "/data/youtrack-workspaces.json",
        '"workspaceName":"PROJ-123"'
      );
    });

    it("does not retry deletion on subsequent polls after failure", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const wsPath = "/home/user/projects/repo/PROJ-123";
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: wsPath,
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, listProjectsOp, setMetadataOp } =
        createTestSetup({ existingState });

      listProjectsOp.projects = [youtrackTrackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      // First poll: deletion attempted and fails
      await dispatcher.dispatch(startIntent());
      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);

      // youtrack.tracked should have been set to null
      const trackedDispatch = setMetadataOp.dispatched.find(
        (i) => i.payload.key === "youtrack.tracked" && i.payload.value === null
      );
      expect(trackedDispatch).toBeDefined();

      // Second poll: listing no longer has tracked metadata
      deleteWorkspaceOp.dispatched.length = 0;
      listProjectsOp.projects = [];
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(shutdownIntent());
      await dispatcher.dispatch(startIntent());

      // Should NOT retry deletion (workspace not tracked)
      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);
    });

    it("removes state entry on successful auto-deletion", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const wsPath = "/home/user/projects/repo/PROJ-123";
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: wsPath,
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, fs, listProjectsOp } = createTestSetup({
        existingState,
      });

      listProjectsOp.projects = [youtrackTrackedProject(wsPath)];
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
      // Entry should be fully removed (not set to null)
      expect(fs).toHaveFileContaining("/data/youtrack-workspaces.json", '"workspaces": {}');
    });

    it("cleans up null entry when issue disappears", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const existingState = JSON.stringify({
        version: 1,
        workspaces: { [stateKey]: null },
      });

      const { dispatcher, httpClient, deleteWorkspaceOp, fs } = createTestSetup({ existingState });

      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/youtrack-workspaces.json", '"workspaces": {}');
    });
  });

  describe("shutdown", () => {
    it("clears poll timer on shutdown", async () => {
      const { dispatcher, httpClient } = createTestSetup();
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());
      await dispatcher.dispatch(shutdownIntent());

      // Verified by no timer leak — shutdown is best-effort
    });
  });

  describe("state persistence", () => {
    it("persists state after creating a workspace", async () => {
      const { dispatcher, httpClient, fs } = createTestSetup();

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(fs).toHaveFile("/data/youtrack-workspaces.json");
    });

    it("loads existing state on startup", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const existingState = JSON.stringify({
        version: 1,
        workspaces: {
          [stateKey]: {
            workspaceName: "PROJ-123",
            workspacePath: "/home/user/projects/repo/PROJ-123",
            issueId: "2-123",
            idReadable: "PROJ-123",
            projectPath: "/home/user/projects/repo",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("continues when YouTrack API returns non-OK", async () => {
      const { dispatcher, httpClient, openProjectOp } = createTestSetup();

      httpClient.setResponse(ISSUES_URL, { status: 403, body: "Forbidden" });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("skips workspace when template file not found", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp, fs } = createTestSetup({
        templatePath: "/data/nonexistent.liquid",
      });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining(
        "/data/youtrack-workspaces.json",
        `"${BASE_URL}/api/issues/2-123": null`
      );
    });

    it("skips workspace when template renders to whitespace-only", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp, fs } = createTestSetup({
        templateContent: "   \n  ",
      });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining(
        "/data/youtrack-workspaces.json",
        `"${BASE_URL}/api/issues/2-123": null`
      );
    });
  });

  describe("template and front-matter", () => {
    function setupWithIssue(options?: { templateContent?: string }) {
      const setup = createTestSetup(options);
      setup.httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });
      return setup;
    }

    it("uses front-matter agent to override agent mode", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithIssue({
        templateContent:
          "---\ngit: https://github.com/org/repo.git\nagent: build\n---\nFix {{ summary }}",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Fix Fix the bug",
        agent: "build",
      });
    });

    it("uses front-matter base to override base branch", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithIssue({
        templateContent:
          "---\ngit: https://github.com/org/repo.git\nbase: origin/develop\n---\nFix it",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.base).toBe("origin/develop");
    });

    it("uses front-matter focus to override stealFocus", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithIssue({
        templateContent: "---\ngit: https://github.com/org/repo.git\nfocus: true\n---\nFix it",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.stealFocus).toBe(true);
    });

    it("uses front-matter model to set model in initial prompt", async () => {
      const { dispatcher, openWorkspaceOp } = setupWithIssue({
        templateContent:
          "---\ngit: https://github.com/org/repo.git\nmodel.provider: anthropic\nmodel.id: claude-sonnet-4-6\n---\nFix it",
      });

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Fix it",
        agent: "plan",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      });
    });

    it("dispatches template metadata along with auto metadata", async () => {
      const template = [
        "---",
        "git: https://github.com/org/repo.git",
        "name: {{ idReadable }}",
        "metadata.custom-key: custom-value",
        "---",
        "Fix {{ summary }}",
      ].join("\n");

      const { dispatcher, setMetadataOp } = setupWithIssue({ templateContent: template });

      await dispatcher.dispatch(startIntent());

      const metaPayloads = setMetadataOp.dispatched.map((i) => ({
        key: i.payload.key,
        value: i.payload.value,
      }));
      // Auto metadata
      expect(metaPayloads).toContainEqual({ key: "source", value: "youtrack" });
      expect(metaPayloads).toContainEqual({
        key: "url",
        value: `${BASE_URL}/issue/PROJ-123`,
      });
      // Template metadata
      expect(metaPayloads).toContainEqual({ key: "custom-key", value: "custom-value" });
    });

    it("does not re-evaluate template for previously skipped issue", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const existingState = JSON.stringify({
        version: 1,
        workspaces: { [stateKey]: null },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("applies all front-matter overrides together", async () => {
      const template = [
        "---",
        "git: https://github.com/org/repo.git",
        "name: yt/{{ idReadable }}",
        "agent: build",
        "base: origin/develop",
        "focus: true",
        "model.provider: anthropic",
        "model.id: claude-sonnet-4-6",
        "---",
        "Fix {{ idReadable }}: {{ summary }}",
      ].join("\n");

      const { dispatcher, openWorkspaceOp } = setupWithIssue({ templateContent: template });

      await dispatcher.dispatch(startIntent());

      const payload = openWorkspaceOp.dispatched[0]!.payload;
      expect(payload.workspaceName).toBe("yt/PROJ-123");
      expect(payload.base).toBe("origin/develop");
      expect(payload.stealFocus).toBe(true);
      expect(payload.initialPrompt).toEqual({
        prompt: "Fix PROJ-123: Fix the bug",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      });
    });
  });

  describe("manual workspace deletion", () => {
    it("does not recreate workspace after manual deletion", async () => {
      const { dispatcher, httpClient, openProjectOp, openWorkspaceOp } = createTestSetup();

      // First poll: workspace gets created
      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      // User manually deletes the workspace (dispatch triggers workspace:deleted event)
      await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/home/user/projects/repo/PROJ-123",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      // Reset tracking and set up second poll with same issue
      openProjectOp.dispatched.length = 0;
      openWorkspaceOp.dispatched.length = 0;
      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      // Trigger manual poll via shutdown + restart
      await dispatcher.dispatch(shutdownIntent());
      await dispatcher.dispatch(startIntent());

      // Workspace should NOT be recreated
      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
    });

    it("loads null entry from persisted state and skips issue", async () => {
      const stateKey = `${BASE_URL}/api/issues/2-123`;
      const existingState = JSON.stringify({
        version: 1,
        workspaces: { [stateKey]: null },
      });

      const { dispatcher, httpClient, openProjectOp } = createTestSetup({ existingState });

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("config toggling", () => {
    it("activates when all four keys become non-null at runtime", async () => {
      // Start with only 3 keys set
      const { dispatcher, httpClient, fs } = createTestSetup({
        partialConfig: {
          baseUrl: BASE_URL,
          token: "perm:test-token",
          templatePath: null,
          query: DEFAULT_QUERY,
        },
      });

      // Ensure template file exists for when module tries to read it
      fs.$.setEntry(DEFAULT_TEMPLATE_PATH, file(DEFAULT_TEMPLATE_CONTENT));

      await dispatcher.dispatch(startIntent());
      expect(httpClient).toHaveNoRequests();

      // Now set the 4th key at runtime via config:set-values dispatch
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "experimental.youtrack.template-path": DEFAULT_TEMPLATE_PATH } },
      } as ConfigSetValuesIntent);

      // Allow async activate to complete
      await vi.waitFor(() => {
        expect(httpClient).toHaveRequested(ISSUES_URL);
      });
    });

    it("deactivates when a config key becomes null at runtime", async () => {
      const { dispatcher, httpClient } = createTestSetup();
      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      await dispatcher.dispatch(startIntent());
      expect(httpClient).toHaveRequested(ISSUES_URL);

      // Set one key to null → deactivates
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "experimental.youtrack.token": null } },
      } as ConfigSetValuesIntent);

      // Module should be deactivated (no further polls)
    });
  });
});

// =============================================================================
// parseYouTrackTemplateOutput
// =============================================================================

describe("parseYouTrackTemplateOutput", () => {
  it("treats entire string as prompt when no front matter", () => {
    const result = parseYouTrackTemplateOutput("Fix the bug");
    expect(result.config).toEqual({ prompt: "Fix the bug" });
    expect(result.warnings).toEqual([]);
  });

  it("parses project key", () => {
    const input = "---\nproject: /home/user/repo\n---\nFix it";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config.project).toBe("/home/user/repo");
  });

  it("parses git key", () => {
    const input = "---\ngit: https://github.com/org/repo.git\n---\nFix it";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config.git).toBe("https://github.com/org/repo.git");
  });

  it("parses all supported front-matter fields", () => {
    const input = [
      "---",
      "name: PROJ-123",
      "agent: plan",
      "base: origin/main",
      "focus: true",
      "model.provider: anthropic",
      "model.id: claude-sonnet-4-6",
      "project: /home/user/repo",
      "git: https://github.com/org/repo.git",
      "---",
      "Fix this issue",
    ].join("\n");

    const result = parseYouTrackTemplateOutput(input);
    expect(result.config).toEqual({
      prompt: "Fix this issue",
      name: "PROJ-123",
      agent: "plan",
      base: "origin/main",
      focus: true,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      project: "/home/user/repo",
      git: "https://github.com/org/repo.git",
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns on unknown front-matter keys", () => {
    const input = "---\nunknown: value\nname: ws\n---\nprompt";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config.name).toBe("ws");
    expect(result.warnings).toEqual(['Unknown front-matter key: "unknown"']);
  });

  it("parses metadata.* keys into metadata record", () => {
    const input =
      "---\nmetadata.issue-url: https://example.com\nmetadata.priority: high\n---\nprompt";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config.metadata).toEqual({
      "issue-url": "https://example.com",
      priority: "high",
    });
    expect(result.warnings).toEqual([]);
  });

  it("handles empty front matter (prompt only)", () => {
    const input = "---\n---\nJust the prompt";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config).toEqual({ prompt: "Just the prompt" });
    expect(result.warnings).toEqual([]);
  });

  it("treats opening --- without closing as no front matter", () => {
    const input = "---\nname: ws\nno closing delimiter";
    const result = parseYouTrackTemplateOutput(input);
    expect(result.config).toEqual({ prompt: input });
    expect(result.warnings).toEqual([]);
  });
});
