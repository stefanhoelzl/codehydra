// @vitest-environment node
/**
 * Integration tests for PresentationModule (Phases A+B of the UI-state
 * architecture).
 *
 * Phase A (ui:event intake):
 * - zod validation, invalid events dropped with a warning
 * - log events routed to the LoggingService (replacement for api:log:*)
 * - app:shutdown removes the ui:event listener
 *
 * Phase B (ui:state shadow snapshots):
 * - hand-written expected snapshots driven through domain events; the
 *   expectations deliberately do NOT share any translation code with the
 *   presenter, so a shared bug cannot hide in both.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import { createMockLogging } from "../boundaries/platform/logging";
import { createBehavioralIpcBoundary } from "../boundaries/shell/ipc.test-utils";
import type { PathProvider } from "../boundaries/platform/path-provider";
import { Path } from "../utils/path/path";
import { ApiIpcChannels } from "../shared/ipc";
import type { UiState } from "../shared/ui-state";
import type { Project, ProjectId, Workspace, WorkspaceName } from "../shared/api/types";
import type { WorkspacePath } from "../shared/ipc";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { EVENT_PROJECT_OPENED } from "../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
} from "../intents/open-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
} from "../intents/delete-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import { EVENT_METADATA_CHANGED } from "../intents/set-metadata";
import { createPresentationModule } from "./presentation-module";

// =============================================================================
// Test setup helpers
// =============================================================================

const PROJECT_ID = "alpha-12345678" as ProjectId;
const PROJECT_PATH = "/projects/alpha";

function createDeps() {
  return {
    ipcLayer: createBehavioralIpcBoundary(),
    loggingService: createMockLogging(),
    viewManager: { sendToUI: vi.fn<(channel: string, ...args: unknown[]) => void>() },
    windowManager: {
      getTheme: vi.fn(() => "dark" as const),
      onThemeChange: vi.fn<(callback: (theme: "dark" | "light") => void) => () => void>(() =>
        vi.fn()
      ),
    },
    fileSystem: {
      readFileBuffer: vi.fn<() => Promise<Buffer>>(() =>
        Promise.reject(new Error("no screenshot"))
      ),
    },
    pathProvider: {
      dataPath: (subpath: string) => new Path(`/data/${subpath}`),
    } as unknown as PathProvider,
  };
}
type Deps = ReturnType<typeof createDeps>;

async function emit(module: IntentModule, type: string, payload: unknown): Promise<void> {
  const declaration = module.events?.[type];
  if (!declaration) throw new Error(`No handler for event ${type}`);
  await declaration.handler({ type, payload } as DomainEvent);
}

/** Flush the microtask coalescer (one macrotask is enough). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshots(deps: Deps): UiState[] {
  return deps.viewManager.sendToUI.mock.calls
    .filter(([channel]) => channel === ApiIpcChannels.UI_STATE)
    .map(([, snapshot]) => snapshot as UiState);
}

function lastSnapshot(deps: Deps): UiState {
  const all = snapshots(deps);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

function makeWorkspace(
  name: string,
  options?: { url?: string; metadata?: Record<string, string> }
): Workspace {
  return {
    projectId: PROJECT_ID,
    name: name as WorkspaceName,
    branch: name,
    metadata: options?.metadata ?? {},
    path: `${PROJECT_PATH}/.worktrees/${name}`,
    ...(options?.url !== undefined && { url: options.url }),
  };
}

function makeProject(workspaces: Workspace[], options?: { remoteUrl?: string }): Project {
  return {
    id: PROJECT_ID,
    name: "alpha",
    path: PROJECT_PATH,
    workspaces,
    ...(options?.remoteUrl !== undefined && { remoteUrl: options.remoteUrl }),
  };
}

async function startModule(deps: Deps): Promise<IntentModule> {
  const module = createPresentationModule(deps);
  await emit(module, EVENT_APP_STARTED, {});
  await flush();
  return module;
}

function switchedPayload(workspace: Workspace): unknown {
  return {
    projectId: PROJECT_ID,
    projectName: "alpha",
    projectPath: PROJECT_PATH,
    workspaceName: workspace.name,
    path: workspace.path,
  };
}

// =============================================================================
// Phase A - ui:event intake
// =============================================================================

describe("PresentationModule - ui:event intake", () => {
  it("registers a listener on the ui:event channel", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(1);
  });

  it("debug-logs valid events", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "switch-workspace" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "panel-visibility", open: true });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "hover", region: "sidebar" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "close-project", projectId: "p-1234" });

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "switch-workspace" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "panel-visibility" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "hover" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "close-project" });
    expect(logger?.warn).not.toHaveBeenCalled();
  });

  it("drops events with an unknown kind and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "not-a-real-event" });

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledTimes(1);
    expect(logger?.debug).not.toHaveBeenCalled();
  });

  it("drops events with invalid payload fields and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "panel-visibility", open: "yes" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "hover", region: "main" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, "not an object");

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledTimes(3);
    expect(logger?.debug).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Phase A - log routing
// =============================================================================

describe("PresentationModule - log routing", () => {
  it("delegates log events to the correct logger method", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "info",
      logger: "ui",
      message: "test message",
      context: { key: "value" },
    });

    expect(deps.loggingService.createLogger).toHaveBeenCalledWith("ui");
    const logger = deps.loggingService.getLogger("ui");
    expect(logger?.info).toHaveBeenCalledWith("test message", { key: "value" });
  });

  it("falls back to 'ui' logger for invalid logger names", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "warn",
      logger: "invalid-name",
      message: "fallback test",
    });

    const logger = deps.loggingService.getLogger("ui");
    expect(logger?.warn).toHaveBeenCalledWith("fallback test", undefined);
  });

  it("accepts 'api' as a valid renderer logger name", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "debug",
      logger: "api",
      message: "api log",
    });

    expect(deps.loggingService.createLogger).toHaveBeenCalledWith("api");
  });

  it("swallows errors from the logging service", () => {
    const deps = createDeps();
    createPresentationModule(deps);
    deps.loggingService.createLogger = vi.fn(() => {
      throw new Error("logging broke");
    });

    expect(() => {
      deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
        kind: "log",
        level: "error",
        logger: "ui",
        message: "should not crash",
      });
    }).not.toThrow();
  });
});

// =============================================================================
// Phase B - ui:state snapshots
// =============================================================================

describe("PresentationModule - ui:state snapshots", () => {
  it("does not push before app:started", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);

    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });
    await flush();

    expect(snapshots(deps)).toHaveLength(0);
  });

  it("pushes the ground-state snapshot (creation panel) at app:started and debug-logs it", async () => {
    const deps = createDeps();
    await startModule(deps);

    expect(snapshots(deps)).toEqual([
      { sidebar: { projects: [] }, frames: {}, main: { kind: "creation" }, theme: "dark" },
    ]);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.debug).toHaveBeenCalledWith("ui:state push", {
      snapshot: JSON.stringify(snapshots(deps)[0]),
    });
  });

  it("includes pre-start events in the first snapshot (witnesses genesis)", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));

    await emit(module, EVENT_APP_STARTED, {});
    await flush();

    expect(lastSnapshot(deps)).toEqual({
      sidebar: {
        projects: [
          {
            id: PROJECT_ID,
            path: PROJECT_PATH,
            name: "alpha",
            title: PROJECT_PATH,
            workspaces: [
              {
                key: `${PROJECT_ID}/main`,
                path: `${PROJECT_PATH}/.worktrees/main`,
                name: "main",
                status: "ready",
                hibernated: false,
                agent: { type: "none" },
                tags: [],
                active: true,
              },
            ],
          },
        ],
      },
      frames: { [`${PROJECT_ID}/main`]: "http://127.0.0.1:1/main" },
      main: { kind: "workspace", frameKey: `${PROJECT_ID}/main` },
      theme: "dark",
    });
  });

  it("sorts projects and workspaces in AaBbCc display order", async () => {
    const deps = createDeps();
    const module = await startModule(deps);

    const project: Project = {
      id: PROJECT_ID,
      name: "alpha",
      path: PROJECT_PATH,
      workspaces: [makeWorkspace("beta"), makeWorkspace("Alpha"), makeWorkspace("apple")],
    };
    await emit(module, EVENT_PROJECT_OPENED, { project });
    await flush();

    const names = lastSnapshot(deps).sidebar.projects[0]!.workspaces.map((w) => w.name);
    expect(names).toEqual(["Alpha", "apple", "beta"]);
  });

  it("uses the remote URL as project title for cloned projects", async () => {
    const deps = createDeps();
    const module = await startModule(deps);

    await emit(module, EVENT_PROJECT_OPENED, {
      project: makeProject([], { remoteUrl: "https://github.com/x/alpha.git" }),
    });
    await flush();

    expect(lastSnapshot(deps).sidebar.projects[0]!.title).toBe("https://github.com/x/alpha.git");
  });

  it("coalesces multiple synchronous mutations into one push", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const before = snapshots(deps).length;

    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    // Fire both without yielding between them.
    void emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    void emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();

    expect(snapshots(deps).length).toBe(before + 1);
  });

  it("shows the creation panel whenever no workspace is active (ground state)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);

    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });
    await flush();

    // A project is open but nothing is active: the panel is the main view.
    expect(lastSnapshot(deps).main).toEqual({ kind: "creation" });
  });

  it("accepts panel-visibility events but ignores them (panel state is derived)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();
    const before = snapshots(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "panel-visibility", open: true });
    await flush();

    // No push, no change: the event no longer feeds the view-model.
    expect(snapshots(deps)).toEqual(before);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).not.toHaveBeenCalled();
  });

  it("workspace:loading inserts a creating placeholder and activates it (leaving the panel)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });

    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
      base: "main",
    });
    await flush();

    const snapshot = lastSnapshot(deps);
    expect(snapshot.sidebar.projects[0]!.workspaces).toEqual([
      {
        key: `${PROJECT_ID}/feat`,
        // Placeholder rows carry the renderer-compatible synthetic path.
        path: `__pending__/${PROJECT_PATH}/feat`,
        name: "feat",
        status: "creating",
        hibernated: false,
        agent: { type: "none" },
        tags: [],
        active: true,
      },
    ]);
    // No runtime yet: the placeholder has no frame, mirroring today's blank pane.
    expect(snapshot.frames).toEqual({});
    expect(snapshot.main).toEqual({ kind: "workspace", frameKey: `${PROJECT_ID}/feat` });
  });

  it("workspace:created swaps the creating placeholder in place (same key)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });
    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
    });

    await emit(module, EVENT_WORKSPACE_CREATED, {
      projectId: PROJECT_ID,
      workspaceName: "feat" as WorkspaceName,
      workspacePath: `${PROJECT_PATH}/.worktrees/feat`,
      projectPath: PROJECT_PATH,
      branch: "feat",
      metadata: { base: "main" },
      workspaceUrl: "http://127.0.0.1:1/feat",
    });
    await flush();

    const snapshot = lastSnapshot(deps);
    expect(snapshot.sidebar.projects[0]!.workspaces).toEqual([
      {
        key: `${PROJECT_ID}/feat`,
        path: `${PROJECT_PATH}/.worktrees/feat`,
        name: "feat",
        status: "ready",
        hibernated: false,
        agent: { type: "none" },
        tags: [],
        active: true,
      },
    ]);
    expect(snapshot.frames).toEqual({ [`${PROJECT_ID}/feat`]: "http://127.0.0.1:1/feat" });
    expect(snapshot.main).toEqual({ kind: "workspace", frameKey: `${PROJECT_ID}/feat` });
  });

  it("workspace:loading is name-guarded against existing workspaces", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("Feat")]) });

    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
    });
    await flush();

    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces).toHaveLength(1);
  });

  it("workspace:create-failed rolls back the placeholder and clears active", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });
    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
    });

    await emit(module, EVENT_WORKSPACE_CREATE_FAILED, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
      error: "boom",
    });
    await flush();

    const snapshot = lastSnapshot(deps);
    expect(snapshot.sidebar.projects[0]!.workspaces).toEqual([]);
    expect(snapshot.main).toEqual({ kind: "creation" });
  });

  it("deletion progress drives deleting / delete-failed / removal", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat", { url: "http://127.0.0.1:1/feat" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    const progressBase = {
      workspacePath: workspace.path as WorkspacePath,
      workspaceName: workspace.name,
      projectId: PROJECT_ID,
      keepBranch: false,
      operations: [],
    };

    await emit(module, EVENT_WORKSPACE_DELETION_PROGRESS, {
      ...progressBase,
      completed: false,
      hasErrors: false,
    });
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.status).toBe("deleting");

    await emit(module, EVENT_WORKSPACE_DELETION_PROGRESS, {
      ...progressBase,
      completed: true,
      hasErrors: true,
    });
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.status).toBe("delete-failed");

    await emit(module, EVENT_WORKSPACE_DELETED, {
      projectId: PROJECT_ID,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      projectPath: PROJECT_PATH,
    });
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces).toEqual([]);
  });

  it("agent status updates land inline on the row", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat");
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    await emit(module, EVENT_AGENT_STATUS_UPDATED, {
      workspace: {
        path: workspace.path,
        projectId: PROJECT_ID,
        name: workspace.name,
        active: false,
      },
      status: { status: "busy", counts: { idle: 1, busy: 2 } },
    });
    await flush();

    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.agent).toEqual({
      type: "busy",
      counts: { idle: 1, busy: 2, total: 3 },
    });
  });

  it("hibernation metadata flips the row, unmounts the frame, and shows the hibernated screen", async () => {
    const deps = createDeps();
    deps.fileSystem.readFileBuffer = vi.fn(() => Promise.resolve(Buffer.from("PNG")));
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat", { url: "http://127.0.0.1:1/feat" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));

    await emit(module, EVENT_METADATA_CHANGED, {
      projectId: PROJECT_ID,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      key: "hibernated",
      value: "true",
    });
    await flush();

    // First push after the flip: screenshot still loading.
    const loading = snapshots(deps).find((s) => s.main.kind === "hibernated");
    expect(loading?.main).toEqual({ kind: "hibernated", screenshot: null });
    expect(loading?.frames).toEqual({});
    expect(loading?.sidebar.projects[0]!.workspaces[0]!.hibernated).toBe(true);

    // The async read completes and triggers a re-push with the data URL.
    await flush();
    expect(lastSnapshot(deps).main).toEqual({
      kind: "hibernated",
      screenshot: `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`,
    });
    expect(deps.fileSystem.readFileBuffer).toHaveBeenCalledWith(
      new Path(`/data/screenshots/${PROJECT_ID}/feat.png`)
    );
  });

  it("falls back to a null screenshot when the PNG is missing", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat", {
      url: "http://127.0.0.1:1/feat",
      metadata: { hibernated: "true" },
    });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();
    await flush();

    expect(lastSnapshot(deps).main).toEqual({ kind: "hibernated", screenshot: null });
  });

  it("workspace:switched null deselects: creation panel shows, no row active", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat", { url: "http://127.0.0.1:1/feat" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));

    await emit(module, EVENT_WORKSPACE_SWITCHED, null);
    await flush();

    expect(lastSnapshot(deps).main).toEqual({ kind: "creation" });
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.active).toBe(false);
    // The frame stays mounted: deselecting must not tear down the workspace.
    expect(lastSnapshot(deps).frames).toEqual({
      [`${PROJECT_ID}/feat`]: "http://127.0.0.1:1/feat",
    });
  });

  it("project:closed falls back to the first remaining workspace", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspaceA = makeWorkspace("a", { url: "http://127.0.0.1:1/a" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspaceA]) });

    const otherId = "beta-87654321" as ProjectId;
    const workspaceB: Workspace = {
      projectId: otherId,
      name: "b" as WorkspaceName,
      branch: "b",
      metadata: {},
      path: "/projects/beta/.worktrees/b",
      url: "http://127.0.0.1:1/b",
    };
    await emit(module, EVENT_PROJECT_OPENED, {
      project: { id: otherId, name: "beta", path: "/projects/beta", workspaces: [workspaceB] },
    });
    await emit(module, EVENT_WORKSPACE_SWITCHED, {
      projectId: otherId,
      projectName: "beta",
      projectPath: "/projects/beta",
      workspaceName: workspaceB.name,
      path: workspaceB.path,
    });

    await emit(module, EVENT_PROJECT_CLOSED, { projectId: otherId });
    await flush();

    const snapshot = lastSnapshot(deps);
    expect(snapshot.sidebar.projects).toHaveLength(1);
    expect(snapshot.main).toEqual({ kind: "workspace", frameKey: `${PROJECT_ID}/a` });
  });

  it("theme changes re-push with the new theme", async () => {
    const deps = createDeps();
    await startModule(deps);
    const onThemeChange = deps.windowManager.onThemeChange.mock.calls[0]![0];

    onThemeChange("light");
    await flush();

    expect(lastSnapshot(deps).theme).toBe("light");
  });
});

// =============================================================================
// Shutdown
// =============================================================================

describe("PresentationModule - shutdown", () => {
  it("removes the ui:event listener on app:shutdown", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const deps = createDeps();
    const presentationModule = createPresentationModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(presentationModule);
    dispatcher.registerModule(quitModule);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(1);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(0);
  });
});
