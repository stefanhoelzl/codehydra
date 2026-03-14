// @vitest-environment node
/**
 * Integration tests for AutoWorkspaceModule through the Dispatcher.
 *
 * Uses mock AutoWorkspaceSource implementations to test the orchestrator
 * independently of GitHub/YouTrack API specifics.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SILENT_LOGGER } from "../../../services/logging";
import { HookRegistry } from "../../intents/infrastructure/hook-registry";
import { Dispatcher } from "../../intents/infrastructure/dispatcher";

import type {
  Operation,
  OperationContext,
  HookContext,
} from "../../intents/infrastructure/operation";
import type { Project, ProjectId, WorkspaceName } from "../../../shared/api/types";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
  type StartHookResult,
} from "../../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../../operations/app-shutdown";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../operations/open-project";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../../operations/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../operations/resolve-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
  type GetProjectBasesResult,
} from "../../operations/get-project-bases";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../operations/set-metadata";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../operations/list-projects";
import {
  EVENT_CONFIG_UPDATED,
  INTENT_CONFIG_SET_VALUES,
  type ConfigUpdatedEvent,
  type ConfigSetValuesIntent,
} from "../../operations/config-set-values";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../../services/platform/filesystem.state-mock";
import { createAutoWorkspaceModule } from "./module";
import type { AutoWorkspaceSource, PollItem, PollResult } from "./source";
import type { ConfigKeyDefinition } from "../../../services/config/config-definition";

// =============================================================================
// Minimal Test Operations
// =============================================================================

class MinimalActivateOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;
  configValues: Record<string, unknown>;

  constructor(configValues?: Record<string, unknown>) {
    this.configValues = configValues ?? {};
  }

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    if (Object.keys(this.configValues).length > 0) {
      const configEvent: ConfigUpdatedEvent = {
        type: EVENT_CONFIG_UPDATED,
        payload: { values: this.configValues },
      };
      ctx.emit(configEvent);
    }

    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect<StartHookResult>("start", hookCtx);
    if (errors.length > 0) throw errors[0]!;
  }
}

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
          workspaceName: "auto-ws" as WorkspaceName,
          workspacePath: ctx.intent.payload.workspacePath,
          projectPath: "/home/user/projects/repo",
        },
      };
      ctx.emit(event);
    }
    return { started: true };
  }
}

class TrackingSetMetadataOperation implements Operation<SetMetadataIntent, void> {
  readonly id = "set-metadata";
  readonly dispatched: SetMetadataIntent[] = [];
  readonly failForPaths = new Set<string>();

  async execute(ctx: OperationContext<SetMetadataIntent>): Promise<void> {
    this.dispatched.push(ctx.intent);
    if (this.failForPaths.has(ctx.intent.payload.workspacePath)) {
      throw new Error(`Workspace not found: ${ctx.intent.payload.workspacePath}`);
    }
  }
}

class TrackingListProjectsOperation implements Operation<ListProjectsIntent, Project[]> {
  readonly id = "list-projects";
  projects: Project[] = [];

  async execute(): Promise<Project[]> {
    return this.projects;
  }
}

class TrackingResolveWorkspaceOperation implements Operation<
  ResolveWorkspaceIntent,
  { projectPath: string; workspaceName: WorkspaceName }
> {
  readonly id = "resolve-workspace";
  readonly dispatched: ResolveWorkspaceIntent[] = [];
  projectPath = "/home/user/projects/repo";

  async execute(
    ctx: OperationContext<ResolveWorkspaceIntent>
  ): Promise<{ projectPath: string; workspaceName: WorkspaceName }> {
    this.dispatched.push(ctx.intent);
    return { projectPath: this.projectPath, workspaceName: "auto-ws" as WorkspaceName };
  }
}

class TrackingGetProjectBasesOperation implements Operation<
  GetProjectBasesIntent,
  GetProjectBasesResult
> {
  readonly id = "get-project-bases";
  readonly dispatched: GetProjectBasesIntent[] = [];
  shouldFail = false;

  async execute(ctx: OperationContext<GetProjectBasesIntent>): Promise<GetProjectBasesResult> {
    this.dispatched.push(ctx.intent);
    if (this.shouldFail) throw new Error("fetch failed");
    return {
      bases: [],
      projectPath: ctx.intent.payload.projectPath,
      projectId: "project-1" as ProjectId,
    };
  }
}

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

// =============================================================================
// Mock Source
// =============================================================================

function createMockSource(
  name: string,
  options?: {
    isConfigured?: boolean;
    initializeFails?: boolean;
    configKeys?: ConfigKeyDefinition<unknown>[];
    fetchBasesBeforeDelete?: boolean;
  }
): AutoWorkspaceSource & {
  pollResult: PollResult;
  onConfigUpdatedCalls: Record<string, unknown>[];
  initializeCalled: boolean;
  disposeCalled: boolean;
  _isConfigured: boolean;
} {
  const mock = {
    name,
    fetchBasesBeforeDelete: options?.fetchBasesBeforeDelete ?? false,
    pollResult: { activeKeys: new Set<string>(), newItems: [] as PollItem[] } as PollResult,
    onConfigUpdatedCalls: [] as Record<string, unknown>[],
    initializeCalled: false,
    disposeCalled: false,
    _isConfigured: options?.isConfigured ?? true,

    configDefinitions(): ConfigKeyDefinition<unknown>[] {
      return options?.configKeys ?? [];
    },

    onConfigUpdated(values: Record<string, unknown>): void {
      mock.onConfigUpdatedCalls.push(values);
    },

    isConfigured(): boolean {
      return mock._isConfigured;
    },

    async initialize(): Promise<boolean> {
      mock.initializeCalled = true;
      return !options?.initializeFails;
    },

    async poll(): Promise<PollResult> {
      return mock.pollResult;
    },

    dispose(): void {
      mock.disposeCalled = true;
    },
  };
  return mock;
}

// =============================================================================
// Test Setup
// =============================================================================

const DEFAULT_TEMPLATE_PATH = "/data/template.liquid";
const DEFAULT_TEMPLATE =
  "---\ngit: https://github.com/org/repo.git\nname: {{ id }}\n---\nWork on {{ id }}";

function trackedProject(workspacePath: string): Project {
  return {
    id: "project-1" as ProjectId,
    name: "repo",
    path: "/home/user/projects/repo",
    workspaces: [
      {
        projectId: "project-1" as ProjectId,
        name: "auto-ws" as WorkspaceName,
        branch: "feature",
        path: workspacePath,
        metadata: {
          source: "test-source",
          "auto-workspace.tracked": "true",
        },
      },
    ],
  };
}

interface TestSetup {
  dispatcher: Dispatcher;
  fs: ReturnType<typeof createFileSystemMock>;
  source: ReturnType<typeof createMockSource>;
  openProjectOp: TrackingOpenProjectOperation;
  openWorkspaceOp: TrackingOpenWorkspaceOperation;
  deleteWorkspaceOp: TrackingDeleteWorkspaceOperation;
  setMetadataOp: TrackingSetMetadataOperation;
  listProjectsOp: TrackingListProjectsOperation;
  resolveWorkspaceOp: TrackingResolveWorkspaceOperation;
  getProjectBasesOp: TrackingGetProjectBasesOperation;
}

function createTestSetup(options?: {
  disabled?: boolean;
  sourceOptions?: Parameters<typeof createMockSource>[1];
  existingState?: string;
  templatePath?: string | null;
  templateContent?: string;
  sourceName?: string;
}): TestSetup {
  const sourceName = options?.sourceName ?? "test-source";
  const tplPath = options?.disabled
    ? null
    : options?.templatePath !== undefined
      ? options.templatePath
      : DEFAULT_TEMPLATE_PATH;
  const tplContent =
    options?.templateContent !== undefined
      ? options.templateContent
      : options?.templatePath !== undefined
        ? undefined
        : DEFAULT_TEMPLATE;

  const source = createMockSource(sourceName, options?.sourceOptions);

  const fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/data": directory(),
  };
  if (options?.existingState) {
    fsEntries["/data/auto-workspaces.json"] = file(options.existingState);
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
  const resolveWorkspaceOp = new TrackingResolveWorkspaceOperation();
  const getProjectBasesOp = new TrackingGetProjectBasesOperation();

  const configValues: Record<string, unknown> = {};
  if (tplPath !== null) {
    configValues[`experimental.${sourceName}.template-path`] = tplPath;
  }

  dispatcher.registerOperation(INTENT_APP_START, new MinimalActivateOperation(configValues));
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new MinimalConfigSetOperation());
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, openProjectOp);
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, openWorkspaceOp);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteWorkspaceOp);
  dispatcher.registerOperation(INTENT_SET_METADATA, setMetadataOp);
  dispatcher.registerOperation(INTENT_LIST_PROJECTS, listProjectsOp);
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, resolveWorkspaceOp);
  dispatcher.registerOperation(INTENT_GET_PROJECT_BASES, getProjectBasesOp);

  const module = createAutoWorkspaceModule({
    fs,
    logger: SILENT_LOGGER,
    stateFilePath: "/data/auto-workspaces.json",
    dispatcher,
    sources: [source],
  });

  dispatcher.registerModule(module);

  return {
    dispatcher,
    fs,
    source,
    openProjectOp,
    openWorkspaceOp,
    deleteWorkspaceOp,
    setMetadataOp,
    listProjectsOp,
    resolveWorkspaceOp,
    getProjectBasesOp,
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

describe("AutoWorkspaceModule Integration", () => {
  describe("activation", () => {
    it("does nothing when no template path configured", async () => {
      const { dispatcher, source } = createTestSetup({ disabled: true });

      await dispatcher.dispatch(startIntent());

      expect(source.initializeCalled).toBe(false);
    });

    it("does not activate when source is not configured", async () => {
      const { dispatcher, source } = createTestSetup({
        sourceOptions: { isConfigured: false },
      });

      await dispatcher.dispatch(startIntent());

      expect(source.initializeCalled).toBe(false);
    });

    it("does not activate when source initialization fails", async () => {
      const { dispatcher, source, openProjectOp } = createTestSetup({
        sourceOptions: { initializeFails: true },
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(source.initializeCalled).toBe(true);
      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("polls on activation when enabled", async () => {
      const { dispatcher, source, openProjectOp } = createTestSetup();

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(source.initializeCalled).toBe(true);
      expect(openProjectOp.dispatched).toHaveLength(1);
    });
  });

  describe("workspace creation", () => {
    it("creates workspace when new item is detected", async () => {
      const { dispatcher, source, openProjectOp, openWorkspaceOp } = createTestSetup();

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(1);
      expect(openProjectOp.dispatched[0]!.payload.git).toBe("https://github.com/org/repo.git");

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("item-1");
      expect(openWorkspaceOp.dispatched[0]!.payload.initialPrompt).toEqual({
        prompt: "Work on item-1",
        agent: "plan",
      });
    });

    it("sets source, url, and tracked metadata on created workspace", async () => {
      const { dispatcher, source, setMetadataOp } = createTestSetup();

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      const metaPayloads = setMetadataOp.dispatched.map((i) => ({
        key: i.payload.key,
        value: i.payload.value,
      }));
      expect(metaPayloads).toContainEqual({ key: "source", value: "test-source" });
      expect(metaPayloads).toContainEqual({ key: "url", value: "https://example.com/1" });
      expect(metaPayloads).toContainEqual({ key: "auto-workspace.tracked", value: "true" });
    });

    it("does not recreate workspace for already-tracked item", async () => {
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: "/home/user/projects/repo/item-1",
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, openProjectOp } = createTestSetup({ existingState });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [], // source sees item-1 in trackedKeys and doesn't include it
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });

    it("dismisses item when template resolves to empty", async () => {
      const { dispatcher, source, openProjectOp, fs } = createTestSetup({
        templateContent: "   \n  ",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"test-source/item-1": null');
    });

    it("dismisses item when no project/git in template", async () => {
      const { dispatcher, source, openProjectOp, fs } = createTestSetup({
        templateContent: "---\nname: ws\n---\nDo stuff",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"test-source/item-1": null');
    });

    it("dismisses item when no name in template", async () => {
      const { dispatcher, source, openProjectOp, fs } = createTestSetup({
        templateContent: "---\ngit: https://github.com/org/repo.git\n---\nDo stuff",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"test-source/item-1": null');
    });

    it("uses project front-matter key for local path projects", async () => {
      const { dispatcher, source, openProjectOp } = createTestSetup({
        templateContent: "---\nproject: /home/user/my-repo\nname: ws-{{ id }}\n---\nFix {{ id }}",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(1);
      expect(openProjectOp.dispatched[0]!.payload.path?.toString()).toBe("/home/user/my-repo");
      expect(openProjectOp.dispatched[0]!.payload.git).toBeUndefined();
    });

    it("project key takes precedence over git key", async () => {
      const { dispatcher, source, openProjectOp } = createTestSetup({
        templateContent:
          "---\nproject: /home/user/my-repo\ngit: https://github.com/org/repo.git\nname: ws\n---\nFix it",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched[0]!.payload.path?.toString()).toBe("/home/user/my-repo");
      expect(openProjectOp.dispatched[0]!.payload.git).toBeUndefined();
    });

    it("applies all front-matter overrides together", async () => {
      const template = [
        "---",
        "git: https://github.com/org/repo.git",
        "name: ws/{{ id }}",
        "agent: build",
        "base: origin/develop",
        "focus: true",
        "model.provider: anthropic",
        "model.id: claude-sonnet-4-6",
        "---",
        "Work on {{ id }}",
      ].join("\n");

      const { dispatcher, source, openWorkspaceOp } = createTestSetup({
        templateContent: template,
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      const payload = openWorkspaceOp.dispatched[0]!.payload;
      expect(payload.workspaceName).toBe("ws/item-1");
      expect(payload.base).toBe("origin/develop");
      expect(payload.stealFocus).toBe(true);
      expect(payload.initialPrompt).toEqual({
        prompt: "Work on item-1",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      });
    });

    it("dispatches template metadata alongside auto metadata", async () => {
      const template = [
        "---",
        "git: https://github.com/org/repo.git",
        "name: ws/{{ id }}",
        "metadata.custom-key: custom-value",
        "---",
        "Work on {{ id }}",
      ].join("\n");

      const { dispatcher, source, setMetadataOp } = createTestSetup({
        templateContent: template,
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      const metaPayloads = setMetadataOp.dispatched.map((i) => ({
        key: i.payload.key,
        value: i.payload.value,
      }));
      expect(metaPayloads).toContainEqual({ key: "source", value: "test-source" });
      expect(metaPayloads).toContainEqual({ key: "url", value: "https://example.com/1" });
      expect(metaPayloads).toContainEqual({ key: "custom-key", value: "custom-value" });
    });
  });

  describe("item disappearance", () => {
    it("deletes workspace when tracked item disappears", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, listProjectsOp } = createTestSetup({
        existingState,
      });

      listProjectsOp.projects = [trackedProject(wsPath)];
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.workspacePath).toBe(wsPath);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.removeWorktree).toBe(true);
    });

    it("removes state entry on successful auto-deletion", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, fs, listProjectsOp } = createTestSetup({ existingState });

      listProjectsOp.projects = [trackedProject(wsPath)];
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"entries": {}');
    });

    it("cleans up null entry when item disappears", async () => {
      const existingState = JSON.stringify({
        version: 1,
        entries: { "test-source/item-1": null },
      });

      const { dispatcher, source, deleteWorkspaceOp, fs } = createTestSetup({ existingState });

      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"entries": {}');
    });

    it("tags workspace and clears tracked metadata when auto-deletion fails", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, setMetadataOp, listProjectsOp } =
        createTestSetup({ existingState });

      listProjectsOp.projects = [trackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);

      const trackedDispatch = setMetadataOp.dispatched.find(
        (i) => i.payload.key === "auto-workspace.tracked" && i.payload.value === null
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
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, fs, listProjectsOp } = createTestSetup({
        existingState,
      });

      listProjectsOp.projects = [trackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"workspaceName":"item-1"');
    });

    it("does not retry deletion on subsequent polls after failure", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, listProjectsOp, setMetadataOp } =
        createTestSetup({ existingState });

      listProjectsOp.projects = [trackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      // First poll: deletion attempted and fails
      await dispatcher.dispatch(startIntent());
      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);

      const trackedDispatch = setMetadataOp.dispatched.find(
        (i) => i.payload.key === "auto-workspace.tracked" && i.payload.value === null
      );
      expect(trackedDispatch).toBeDefined();

      // Second poll: workspace still in state but not tracked
      deleteWorkspaceOp.dispatched.length = 0;
      listProjectsOp.projects = [];

      await dispatcher.dispatch(shutdownIntent());
      await dispatcher.dispatch(startIntent());

      // Should NOT retry deletion
      expect(deleteWorkspaceOp.dispatched).toHaveLength(0);
    });

    it("dismisses state entry when set-metadata fails after delete failure (workspace gone)", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, setMetadataOp, listProjectsOp, fs } =
        createTestSetup({ existingState });

      listProjectsOp.projects = [trackedProject(wsPath)];
      deleteWorkspaceOp.failForPaths.add(wsPath);
      setMetadataOp.failForPaths.add(wsPath);
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      // Both set-metadata dispatches were attempted
      expect(setMetadataOp.dispatched.length).toBeGreaterThanOrEqual(2);

      // State entry should be dismissed (null) so module stops retrying on restart
      await vi.waitFor(() => {
        expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"test-source/item-1": null');
      });
    });
  });

  describe("fetch bases before delete", () => {
    it("fetches bases before auto-delete when source has fetchBasesBeforeDelete: true", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const {
        dispatcher,
        source,
        deleteWorkspaceOp,
        listProjectsOp,
        resolveWorkspaceOp,
        getProjectBasesOp,
      } = createTestSetup({
        existingState,
        sourceOptions: { fetchBasesBeforeDelete: true },
      });

      listProjectsOp.projects = [trackedProject(wsPath)];
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(resolveWorkspaceOp.dispatched).toHaveLength(1);
      expect(resolveWorkspaceOp.dispatched[0]!.payload.workspacePath).toBe(wsPath);

      expect(getProjectBasesOp.dispatched).toHaveLength(1);
      expect(getProjectBasesOp.dispatched[0]!.payload.projectPath).toBe("/home/user/projects/repo");
      expect(getProjectBasesOp.dispatched[0]!.payload.refresh).toBe(true);
      expect(getProjectBasesOp.dispatched[0]!.payload.wait).toBe(true);

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
    });

    it("does not fetch bases when source has fetchBasesBeforeDelete: false", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const {
        dispatcher,
        source,
        deleteWorkspaceOp,
        listProjectsOp,
        resolveWorkspaceOp,
        getProjectBasesOp,
      } = createTestSetup({ existingState });

      listProjectsOp.projects = [trackedProject(wsPath)];
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(resolveWorkspaceOp.dispatched).toHaveLength(0);
      expect(getProjectBasesOp.dispatched).toHaveLength(0);
      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
    });

    it("proceeds with delete when fetch bases fails", async () => {
      const wsPath = "/home/user/projects/repo/item-1";
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: wsPath,
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, deleteWorkspaceOp, listProjectsOp, getProjectBasesOp } =
        createTestSetup({
          existingState,
          sourceOptions: { fetchBasesBeforeDelete: true },
        });

      listProjectsOp.projects = [trackedProject(wsPath)];
      getProjectBasesOp.shouldFail = true;
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());

      expect(deleteWorkspaceOp.dispatched).toHaveLength(1);
      expect(deleteWorkspaceOp.dispatched[0]!.payload.workspacePath).toBe(wsPath);
    });
  });

  describe("manual workspace deletion", () => {
    it("does not recreate workspace after manual deletion", async () => {
      const { dispatcher, source, openProjectOp, openWorkspaceOp } = createTestSetup();

      // First poll: workspace gets created
      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      // User manually deletes the workspace
      await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/home/user/projects/repo/item-1",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      // Reset tracking and set up second poll with same item
      openProjectOp.dispatched.length = 0;
      openWorkspaceOp.dispatched.length = 0;
      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [], // Source won't include it since it's still tracked (null entry)
      };

      await dispatcher.dispatch(shutdownIntent());
      await dispatcher.dispatch(startIntent());

      // Workspace should NOT be recreated
      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
    });
  });

  describe("state persistence", () => {
    it("persists state after creating a workspace", async () => {
      const { dispatcher, source, fs } = createTestSetup();

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(fs).toHaveFile("/data/auto-workspaces.json");
    });

    it("loads existing state on startup", async () => {
      const existingState = JSON.stringify({
        version: 1,
        entries: {
          "test-source/item-1": {
            workspacePath: "/home/user/projects/repo/item-1",
            workspaceName: "item-1",
            createdAt: "2026-02-27T10:00:00Z",
          },
        },
      });

      const { dispatcher, source, openProjectOp } = createTestSetup({ existingState });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("clears poll timer and disposes active sources on shutdown", async () => {
      const { dispatcher, source } = createTestSetup();
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());
      expect(source.disposeCalled).toBe(false);

      await dispatcher.dispatch(shutdownIntent());
      expect(source.disposeCalled).toBe(true);
    });
  });

  describe("config toggling", () => {
    it("activates source when template path becomes non-null at runtime", async () => {
      const { dispatcher, source, fs } = createTestSetup({ disabled: true });

      await dispatcher.dispatch(startIntent());
      expect(source.initializeCalled).toBe(false);

      // Make template file available
      fs.$.setEntry(DEFAULT_TEMPLATE_PATH, file(DEFAULT_TEMPLATE));

      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: {
          values: { "experimental.test-source.template-path": DEFAULT_TEMPLATE_PATH },
        },
      } as ConfigSetValuesIntent);

      await vi.waitFor(() => {
        expect(source.initializeCalled).toBe(true);
      });
    });

    it("deactivates source when template path becomes null at runtime", async () => {
      const { dispatcher, source } = createTestSetup();
      source.pollResult = { activeKeys: new Set(), newItems: [] };

      await dispatcher.dispatch(startIntent());
      expect(source.initializeCalled).toBe(true);

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: {
          values: { "experimental.test-source.template-path": null },
        },
      } as ConfigSetValuesIntent);

      expect(source.disposeCalled).toBe(true);
    });
  });

  describe("error handling", () => {
    it("skips workspace when template file not found", async () => {
      const { dispatcher, source, openProjectOp, fs } = createTestSetup({
        templatePath: "/data/nonexistent.liquid",
      });

      source.pollResult = {
        activeKeys: new Set(["item-1"]),
        newItems: [{ key: "item-1", url: "https://example.com/1", data: { id: "item-1" } }],
      };

      await dispatcher.dispatch(startIntent());

      expect(openProjectOp.dispatched).toHaveLength(0);
      expect(fs).toHaveFileContaining("/data/auto-workspaces.json", '"test-source/item-1": null');
    });
  });
});
