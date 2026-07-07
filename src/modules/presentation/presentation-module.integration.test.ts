// @vitest-environment node
/**
 * Integration tests for PresentationModule (Phases A+B of the UI-state
 * architecture).
 *
 * Phase A (ui:event intake):
 * - zod validation, invalid events dropped with a warning
 * - log events routed to the LoggingService
 * - app:shutdown removes the ui:event listener
 *
 * Phase B (ui:state shadow snapshots):
 * - hand-written expected snapshots driven through domain events; the
 *   expectations deliberately do NOT share any translation code with the
 *   presenter, so a shared bug cannot hide in both.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../../intents/app-shutdown";
import type { AppShutdownIntent } from "../../intents/app-shutdown";
import type { IntentModule } from "../../intents/lib/module";
import type { DomainEvent } from "../../intents/lib/types";
import { createMockLogging } from "../../boundaries/platform/logging";
import { createMockViewManager } from "../../boundaries/shell/view-manager.test-utils";
import { createMockAccessor } from "../../boundaries/platform/config.test-utils";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import { Path } from "../../utils/path/path";
import { ApiIpcChannels } from "../../shared/ipc";
import type { UiState } from "../../shared/ui-state";
import type { Project, ProjectId, Workspace, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import type { ShowUIHookResult } from "../../intents/app-start";
import { SETUP_OPERATION_ID, EVENT_SETUP_PROGRESS, EVENT_SETUP_ERROR } from "../../intents/setup";
import type { AgentSelectionHookContext } from "../../intents/setup";
import type { HookOutput } from "../../intents/lib/operation";
import { EVENT_PROJECT_OPENED } from "../../intents/open-project";
import { EVENT_PROJECT_CLOSED, CLOSE_PROJECT_OPERATION_ID } from "../../intents/close-project";
import type { CloseConfirmHookResult } from "../../intents/close-project";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
} from "../../intents/open-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
} from "../../intents/delete-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../../intents/switch-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernatePipelineHookInput,
} from "../../intents/hibernate-workspace";
import { EVENT_AGENT_STATUS_UPDATED } from "../../intents/update-agent-status";
import { EVENT_METADATA_CHANGED } from "../../intents/set-metadata";
import { EVENT_SHORTCUT_ACTIVE_CHANGED } from "../../intents/set-shortcut-active";
import { EVENT_SHORTCUT_KEY_PRESSED } from "../../intents/shortcut-key";
import { createPresentationModule, type UiPresenter } from "./presentation-module";

// =============================================================================
// Test setup helpers
// =============================================================================

const PROJECT_ID = "alpha-12345678" as ProjectId;
const PROJECT_PATH = "/projects/alpha";
// Local copies of the sidebar-width default/floor (the source constants are no
// longer exported; the tests only need values that match main.ts's inlined
// 250, which is stable).
const SIDEBAR_DEFAULT_WIDTH = 250;
const SIDEBAR_MIN_WIDTH = 250;

function createDeps() {
  // Typed sendToUI spy for snapshot assertions; the rest of the view-manager
  // mock provides onFromUI + __emitFromUI for driving inbound ui:events.
  const sendToUI = vi.fn<(channel: string, ...args: unknown[]) => void>();
  const viewManager = createMockViewManager({ overrides: { sendToUI } });
  return {
    loggingService: createMockLogging(),
    viewManager,
    /** Typed handle to the push spy (deps.viewManager.sendToUI loses the Mock type). */
    sendToUI,
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
    dispatcher: createMockDispatcher(),
    sidebarWidthConfig: createMockAccessor<number>("sidebar.width", SIDEBAR_DEFAULT_WIDTH),
    configService: createMockConfig(),
  };
}
type Deps = ReturnType<typeof createDeps>;

/** Drive an inbound ui:event into the presenter (via the view-manager mock). */
function emitUiEvent(deps: Deps, event: unknown): void {
  deps.viewManager.__emitFromUI(ApiIpcChannels.UI_EVENT, event);
}

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
  return deps.sendToUI.mock.calls
    .filter(([channel]) => channel === ApiIpcChannels.UI_STATE)
    .map(([, snapshot]) => snapshot as UiState);
}

function lastSnapshot(deps: Deps): UiState {
  const all = snapshots(deps);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

// The startup surfaces + mid-session loading are one reconciled modal "system
// dialog" now. These build the exact expected UiDialog entries (the first
// dialog minted gets id "dlg-1").
const STARTING_SPINNER = {
  type: "progress",
  style: "spinner",
  items: [{ id: "status", label: "CodeHydra is starting…", status: "running" }],
};
const LOADING_SPINNER = {
  type: "progress",
  style: "spinner",
  items: [{ id: "status", label: "Loading workspace...", status: "running" }],
};
function systemDialog(sections: unknown[], id = "dlg-1"): unknown {
  return { id, kind: "modal", config: { sections } };
}
/** The single open system dialog in the latest snapshot (asserts exactly one). */
function currentSystemDialog(deps: Deps): {
  id: string;
  kind: string;
  config: { sections: unknown[] };
} {
  const dialogs = lastSnapshot(deps).dialogs;
  expect(dialogs).toHaveLength(1);
  return dialogs[0]! as unknown as {
    id: string;
    kind: string;
    config: { sections: unknown[] };
  };
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

/** Mark the renderer connected (opens the snapshot stream) via ui-connected. */
function connect(deps: Deps): void {
  emitUiEvent(deps, { kind: "ui-connected" });
}

/**
 * Bring the module to the steady state: renderer connected + app:started
 * (startup phase left, normal main logic owns the view). Most snapshot tests
 * assert the post-startup view.
 */
async function startModule(deps: Deps): Promise<UiPresenter> {
  const module = createPresentationModule(deps);
  connect(deps);
  // Production ordering: the app:start `init` hook seeds + tracks theme before
  // app:started. Run it so the steady state mirrors that (theme subscription
  // registered, startup snapshots carry the real theme).
  await module.hooks![APP_START_OPERATION_ID]!.init!.handler({} as never);
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
  it("subscribes to the ui:event channel (ui-connected opens the stream)", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    // The presenter is listening: a ui-connected event opens the snapshot
    // stream and flushes the genesis snapshot.
    emitUiEvent(deps, { kind: "ui-connected" });
    expect(snapshots(deps).length).toBeGreaterThan(0);
  });

  it("drops events with an unknown kind and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    emitUiEvent(deps, { kind: "not-a-real-event" });
    // panel-visibility left the schema with the read cutover (the creation
    // panel is derived state); a stale emitter is dropped like any unknown.
    emitUiEvent(deps, { kind: "panel-visibility", open: true });

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledTimes(2);
    expect(logger?.debug).not.toHaveBeenCalled();
  });

  it("drops events with invalid payload fields and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    emitUiEvent(deps, { kind: "log", level: "shout", logger: "ui" });
    emitUiEvent(deps, { kind: "hover", region: "main" });
    emitUiEvent(deps, "not an object");

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

    emitUiEvent(deps, {
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

    emitUiEvent(deps, {
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

    emitUiEvent(deps, {
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
      emitUiEvent(deps, {
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
  it("does not push before ui-connected", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);

    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });
    await flush();

    expect(snapshots(deps)).toHaveLength(0);
  });

  it("pushes the boot-splash snapshot immediately on ui-connected", async () => {
    const deps = createDeps();
    createPresentationModule(deps);

    connect(deps);

    // The genesis "starting" splash is flushed synchronously on connect: a
    // blank `main: starting` base with the boot-splash system dialog on top.
    expect(snapshots(deps)).toEqual([
      {
        sidebar: { projects: [], width: SIDEBAR_DEFAULT_WIDTH },
        frames: {},
        main: { kind: "starting" },
        theme: "dark",
        labelScroll: "hover",
        mode: "dialog",
        capturing: false,
        dialogs: [systemDialog([STARTING_SPINNER])],
        notifications: [],
      },
    ]);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.debug).toHaveBeenCalledWith("ui:state push", {
      snapshot: JSON.stringify(snapshots(deps)[0]),
    });
  });

  it("pushes the ground-state snapshot (creation panel) once startup completes", async () => {
    const deps = createDeps();
    await startModule(deps);

    expect(lastSnapshot(deps)).toEqual({
      sidebar: { projects: [], width: SIDEBAR_DEFAULT_WIDTH },
      frames: {},
      main: { kind: "creation" },
      theme: "dark",
      labelScroll: "hover",
      mode: "hover",
      capturing: false,
      dialogs: [],
      notifications: [],
    });
  });

  it("includes pre-start events in the first post-startup snapshot (witnesses genesis)", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));

    connect(deps);
    await emit(module, EVENT_APP_STARTED, {});
    await flush();

    expect(lastSnapshot(deps)).toEqual({
      sidebar: {
        projects: [
          {
            id: PROJECT_ID,
            name: "alpha",
            title: PROJECT_PATH,
            remote: false,
            workspaces: [
              {
                key: `${PROJECT_ID}/main`,
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
        width: SIDEBAR_DEFAULT_WIDTH,
      },
      frames: { [`${PROJECT_ID}/main`]: "http://127.0.0.1:1/main" },
      main: { kind: "workspace", frameKey: `${PROJECT_ID}/main` },
      theme: "dark",
      labelScroll: "hover",
      mode: "workspace",
      capturing: false,
      dialogs: [],
      notifications: [],
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
        name: "feat",
        status: "creating",
        hibernated: false,
        agent: { type: "none" },
        tags: [],
        active: true,
      },
    ]);
    // No runtime yet: the placeholder has no frame, so main points at the
    // creating workspace (blank behind the dialog) and the mid-session loading
    // system dialog covers it.
    expect(snapshot.frames).toEqual({});
    expect(snapshot.main).toEqual({ kind: "workspace", frameKey: `${PROJECT_ID}/feat` });
    // Mid-session loading is a "panel" (no blur/dim over the live sidebar), not a
    // blocking modal — rendered below the sidebar by PanelView, like the deletion
    // panel. A panel does not count as a modal, so the mode is not "dialog".
    expect(currentSystemDialog(deps).kind).toBe("panel");
    expect(currentSystemDialog(deps).config.sections).toEqual([LOADING_SPINNER]);
    expect(snapshot.mode).not.toBe("dialog");
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

  it("is the single source of deletion progress: full via accessor, render-ready on the row", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat", { url: "http://127.0.0.1:1/feat" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    const path = workspace.path as WorkspacePath;

    expect(module.deletionProgress(path)).toBeUndefined();

    await emit(module, EVENT_WORKSPACE_DELETION_PROGRESS, {
      workspacePath: path,
      workspaceName: workspace.name,
      projectId: PROJECT_ID,
      keepBranch: true,
      operations: [{ id: "cleanup", label: "Removing", status: "error", error: "EBUSY" }],
      completed: true,
      hasErrors: true,
      blockingProcesses: [
        { pid: 4242, name: "node", commandLine: "node x", files: ["/w/a"], cwd: "/w" },
      ],
    });
    await flush();

    // Accessor exposes the FULL domain progress (pids, keepBranch) for the modal.
    const full = module.deletionProgress(path);
    expect(full?.keepBranch).toBe(true);
    expect(full?.blockingProcesses?.[0]?.pid).toBe(4242);

    // The row carries only the render-ready view (no pids / keepBranch / paths).
    const row = lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!;
    expect(row.deletionProgress).toEqual({
      operations: [{ id: "cleanup", label: "Removing", status: "error", error: "EBUSY" }],
      completed: true,
      hasErrors: true,
      blockingProcessCount: 1,
    });

    // Cleared on successful completion.
    await emit(module, EVENT_WORKSPACE_DELETION_PROGRESS, {
      workspacePath: path,
      workspaceName: workspace.name,
      projectId: PROJECT_ID,
      keepBranch: true,
      operations: [],
      completed: true,
      hasErrors: false,
    });
    await flush();
    expect(module.deletionProgress(path)).toBeUndefined();
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

  it("tag metadata changes update the row tags (add, recolor, remove)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat");
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    const change = (key: string, value: string | null): Promise<void> =>
      emit(module, EVENT_METADATA_CHANGED, {
        projectId: PROJECT_ID,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        key,
        value,
      });

    await change("tags.bugfix", "{}");
    await change("tags.wip", '{"color":"#ff0"}');
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.tags).toEqual([
      { name: "bugfix" },
      { name: "wip", color: "#ff0" },
    ]);

    await change("tags.bugfix", null);
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.tags).toEqual([
      { name: "wip", color: "#ff0" },
    ]);
  });

  it("reads the title metadata into the row, and clears it when emptied", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    // Seed a workspace that already carries a title (project:open path).
    const workspace = makeWorkspace("feat-branch", { metadata: { title: "  My title  " } });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await flush();
    // Trimmed on intake; the branch name is untouched (identity).
    const seeded = lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!;
    expect(seeded.title).toBe("My title");
    expect(seeded.name).toBe("feat-branch");

    const change = (value: string | null): Promise<void> =>
      emit(module, EVENT_METADATA_CHANGED, {
        projectId: PROJECT_ID,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        key: "title",
        value,
      });

    await change("Renamed");
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.title).toBe("Renamed");

    // Emptying the title clears it (row reverts to the branch name).
    await change("");
    await flush();
    expect(lastSnapshot(deps).sidebar.projects[0]!.workspaces[0]!.title).toBeUndefined();
  });

  it("ignores metadata keys the UI does not care about (no push)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("feat");
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await flush();
    const before = snapshots(deps).length;

    await emit(module, EVENT_METADATA_CHANGED, {
      projectId: PROJECT_ID,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      key: "some-plugin-key",
      value: "whatever",
    });
    await flush();

    expect(snapshots(deps).length).toBe(before);
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
// Sidebar resize
// =============================================================================

describe("PresentationModule - sidebar resize", () => {
  it("ships the persisted width in the snapshot's sidebar region", async () => {
    const deps = createDeps();
    await deps.sidebarWidthConfig.set(420);
    await startModule(deps);

    expect(lastSnapshot(deps).sidebar.width).toBe(420);
  });

  it("clamps a below-floor persisted width up to the minimum in the snapshot", async () => {
    const deps = createDeps();
    // A hand-edited config.json could hold a value below the grow-only floor.
    await deps.sidebarWidthConfig.set(120);
    await startModule(deps);

    expect(lastSnapshot(deps).sidebar.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("persists a resize-sidebar event and echoes it in the next snapshot", async () => {
    const deps = createDeps();
    await startModule(deps);

    emitUiEvent(deps, { kind: "resize-sidebar", width: 512 });
    await flush();

    expect(deps.sidebarWidthConfig.get()).toBe(512);
    expect(lastSnapshot(deps).sidebar.width).toBe(512);
  });

  it("clamps a resize-sidebar width to the minimum before persisting", async () => {
    const deps = createDeps();
    await startModule(deps);

    emitUiEvent(deps, { kind: "resize-sidebar", width: 10 });
    await flush();

    expect(deps.sidebarWidthConfig.get()).toBe(SIDEBAR_MIN_WIDTH);
    expect(lastSnapshot(deps).sidebar.width).toBe(SIDEBAR_MIN_WIDTH);
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

    // The presenter is listening: connect, then a hover event triggers a push.
    connect(deps);
    await flush();
    emitUiEvent(deps, { kind: "hover", region: "sidebar" });
    await flush();
    const pushesBefore = snapshots(deps).length;
    expect(pushesBefore).toBeGreaterThan(0);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    // After shutdown the ui:event listener is removed: further events do nothing.
    emitUiEvent(deps, { kind: "hover", region: null });
    await flush();
    expect(snapshots(deps).length).toBe(pushesBefore);
  });
});

// =============================================================================
// Load-bearing ui:event routing (remove-workspace / close-project)
// =============================================================================

describe("PresentationModule - ui:event routing", () => {
  /** Replace the deps dispatcher with a recording stub. */
  function recordDispatches(deps: Deps): Array<{ type: string; payload: unknown }> {
    const dispatched: Array<{ type: string; payload: unknown }> = [];
    deps.dispatcher = {
      dispatch: vi.fn((intent: { type: string; payload: unknown }) => {
        dispatched.push(intent);
        return Promise.resolve();
      }),
    } as unknown as Deps["dispatcher"];
    return dispatched;
  }

  it("ui-connected flushes buffered notifications and pushes the snapshot (no app:ready)", () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    createPresentationModule(deps);

    emitUiEvent(deps, { kind: "ui-connected" });

    // app:ready is dispatched by the app:start `start` hook now, not here.
    expect(dispatched).toEqual([]);
    // The boot splash flushed immediately so the renderer isn't blank.
    expect(snapshots(deps)).toHaveLength(1);
    expect(snapshots(deps)[0]!.main).toEqual({ kind: "starting" });
  });

  it("remove-workspace resolves the key and dispatches an interactive delete", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    const workspace = makeWorkspace("main");
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    emitUiEvent(deps, {
      kind: "remove-workspace",
      key: `${PROJECT_ID}/main`,
    });

    expect(dispatched).toEqual([
      {
        type: "workspace:delete",
        payload: {
          workspacePath: workspace.path,
          keepBranch: false,
          force: false,
          removeWorktree: true,
          interactive: true,
        },
      },
    ]);
  });

  it("drops remove-workspace for a stale key with a warning", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });

    emitUiEvent(deps, {
      kind: "remove-workspace",
      key: `${PROJECT_ID}/vanished`,
    });

    expect(dispatched).toHaveLength(0);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledWith("Dropped remove-workspace for unknown key", {
      key: `${PROJECT_ID}/vanished`,
    });
  });

  it("drops remove-workspace for a creating placeholder (nothing to delete yet)", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });
    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
    });

    emitUiEvent(deps, {
      kind: "remove-workspace",
      key: `${PROJECT_ID}/feat`,
    });

    expect(dispatched).toHaveLength(0);
  });

  it("switch-workspace resolves the key and dispatches a switch (default focus)", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    const workspace = makeWorkspace("main");
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    emitUiEvent(deps, {
      kind: "switch-workspace",
      key: `${PROJECT_ID}/main`,
    });

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: workspace.path } },
    ]);
  });

  it("switch-workspace with key null deselects (creation panel)", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    await startModule(deps);

    emitUiEvent(deps, { kind: "switch-workspace", key: null });

    expect(dispatched).toEqual([{ type: "workspace:switch", payload: { workspacePath: null } }]);
  });

  it("drops switch-workspace for a stale key with a warning", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });

    emitUiEvent(deps, {
      kind: "switch-workspace",
      key: `${PROJECT_ID}/vanished`,
    });

    expect(dispatched).toHaveLength(0);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledWith("Dropped switch-workspace for unknown key", {
      key: `${PROJECT_ID}/vanished`,
    });
  });

  it("wake-workspace resolves the key and dispatches a wake", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { metadata: { hibernated: "true" } });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });

    emitUiEvent(deps, {
      kind: "wake-workspace",
      key: `${PROJECT_ID}/main`,
    });

    expect(dispatched).toEqual([
      { type: "workspace:wake", payload: { workspacePath: workspace.path, source: "ui-ipc" } },
    ]);
  });

  it("drops wake-workspace for a stale key with a warning", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });

    emitUiEvent(deps, {
      kind: "wake-workspace",
      key: `${PROJECT_ID}/vanished`,
    });

    expect(dispatched).toHaveLength(0);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledWith("Dropped wake-workspace for unknown key", {
      key: `${PROJECT_ID}/vanished`,
    });
  });

  it("close-project resolves the projectId and dispatches an interactive close", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });

    emitUiEvent(deps, {
      kind: "close-project",
      projectId: PROJECT_ID,
    });

    expect(dispatched).toEqual([
      {
        type: "project:close",
        payload: { projectPath: PROJECT_PATH, interactive: true },
      },
    ]);
  });

  it("drops close-project for an unknown projectId with a warning", async () => {
    const deps = createDeps();
    const dispatched = recordDispatches(deps);
    createPresentationModule(deps);

    emitUiEvent(deps, {
      kind: "close-project",
      projectId: "ghost-00000000",
    });

    expect(dispatched).toHaveLength(0);
    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledWith("Dropped close-project for unknown project", {
      projectId: "ghost-00000000",
    });
  });
});

// =============================================================================
// Startup flow (boot splash, first-run setup, agent-selection, loading)
// =============================================================================

describe("PresentationModule - startup flow", () => {
  /** Run a hook handler directly. */
  function runHook(
    module: IntentModule,
    opId: string,
    point: string,
    ctx: unknown
  ): Promise<unknown> {
    return module.hooks![opId]![point]!.handler(ctx as never) as Promise<unknown>;
  }

  /** Emit a system-dialog action (the button clicks the renderer sends). */
  function action(deps: Deps, actionId: string, data?: Record<string, string>): void {
    const { id } = currentSystemDialog(deps);
    emitUiEvent(deps, { kind: "dialog-action", dialogId: id, actionId, ...(data && { data }) });
  }

  it("starts in the boot-splash phase and shows the starting system dialog on connect", async () => {
    const deps = createDeps();
    createPresentationModule(deps);
    connect(deps);

    // Blank base + the boot-splash dialog; the modal ⇒ dialog mode (Alt+X inert).
    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
    expect(lastSnapshot(deps).mode).toBe("dialog");
    expect(currentSystemDialog(deps).config.sections).toEqual([STARTING_SPINNER]);
  });

  it("app:start show-ui sets the starting phase and advertises retry support", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);

    const result = (
      (await runHook(module, APP_START_OPERATION_ID, "show-ui", {
        intent: { type: "app:start", payload: {} },
      })) as HookOutput<ShowUIHookResult>
    ).result!;
    await flush();

    expect(result.retrySupported).toBe(true);
    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
  });

  it("app:setup show-ui shows the setup dialog with pending rows", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);

    await runHook(module, SETUP_OPERATION_ID, "show-ui", {
      intent: { type: "app:setup", payload: {} },
    });
    await flush();

    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
    expect(currentSystemDialog(deps).config.sections).toEqual([
      { type: "text", content: "Setting up CodeHydra", style: "heading" },
      { type: "text", content: "This is only required on first startup.", style: "subtitle" },
      {
        type: "progress",
        style: "bar",
        items: [
          { id: "vscode", label: "VSCode", status: "pending" },
          { id: "agent", label: "Agent", status: "pending" },
          { id: "setup", label: "Setup", status: "pending" },
        ],
      },
    ]);
  });

  it("setup:progress accumulates rows; setup:error adds the error text + Retry/Quit", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);
    await runHook(module, SETUP_OPERATION_ID, "show-ui", {
      intent: { type: "app:setup", payload: {} },
    });

    await emit(module, EVENT_SETUP_PROGRESS, { id: "vscode", status: "done" });
    await emit(module, EVENT_SETUP_PROGRESS, {
      id: "agent",
      status: "running",
      message: "Downloading",
      progress: 42,
    });
    await emit(module, EVENT_SETUP_PROGRESS, { id: "setup", status: "failed" });
    await flush();

    expect(currentSystemDialog(deps).config.sections).toContainEqual({
      type: "progress",
      style: "bar",
      items: [
        { id: "vscode", label: "VSCode", status: "done" },
        { id: "agent", label: "Agent", status: "running", message: "Downloading", progress: 42 },
        // "failed" maps to "error".
        { id: "setup", label: "Setup", status: "error" },
      ],
    });

    await emit(module, EVENT_SETUP_ERROR, { message: "boom" });
    await flush();
    const sections = currentSystemDialog(deps).config.sections;
    expect(sections).toContainEqual({ type: "text", content: "boom", style: "error" });
    expect(sections).toContainEqual({
      type: "group",
      items: [
        { type: "button", id: "retry", label: "Retry", variant: "primary", autofocus: true },
        { type: "button", id: "quit", label: "Quit", variant: "secondary" },
      ],
    });
  });

  it("agent-selection parks until Continue, then provides the agentType capability", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);

    const ctx: AgentSelectionHookContext = {
      intent: { type: "app:setup", payload: {} },
      availableAgents: [
        { agent: "claude", label: "Claude", icon: "sparkle" },
        { agent: "opencode", label: "OpenCode", icon: "terminal" },
      ],
    };
    const handlerDecl = module.hooks![SETUP_OPERATION_ID]!["agent-selection"]!;
    const pending = handlerDecl.handler(ctx as never);
    await flush();

    // The picker dialog is shown with the available agents + a Continue button.
    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
    expect(currentSystemDialog(deps).config.sections).toEqual([
      { type: "text", content: "Choose Agent", style: "heading" },
      {
        type: "radio",
        id: "agent",
        autofocus: true,
        options: [
          { id: "claude", label: "Claude", icon: "sparkle" },
          { id: "opencode", label: "OpenCode", icon: "terminal" },
        ],
      },
      {
        type: "group",
        items: [{ type: "button", id: "continue", label: "Continue", variant: "primary" }],
      },
    ]);

    // The user picks opencode and clicks Continue (a dialog action).
    action(deps, "continue", { agent: "opencode" });
    const output = await pending;

    // The handler returns the chosen agent as the agent-selection hook result.
    expect(output).toEqual({ result: "opencode" });
  });

  it("app:setup hide-ui returns to the boot-splash dialog", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);
    await runHook(module, SETUP_OPERATION_ID, "show-ui", {
      intent: { type: "app:setup", payload: {} },
    });

    await runHook(module, SETUP_OPERATION_ID, "hide-ui", {
      intent: { type: "app:setup", payload: {} },
    });
    await flush();

    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
    expect(currentSystemDialog(deps).config.sections).toEqual([STARTING_SPINNER]);
  });

  it("app:start start shows the loading dialog until app:started", async () => {
    const deps = createDeps();
    const dispatched: Array<{ type: string }> = [];
    deps.dispatcher = {
      dispatch: vi.fn((intent: { type: string }) => {
        dispatched.push(intent);
        return Promise.resolve();
      }),
    } as unknown as Deps["dispatcher"];
    const module = createPresentationModule(deps);
    connect(deps);

    await runHook(module, APP_START_OPERATION_ID, "start", {
      intent: { type: "app:start", payload: {} },
    });
    await flush();

    // app:ready is dispatched by the app:start operation (after all start handlers),
    // not by this handler — the handler only advances the UI phase.
    expect(dispatched).toEqual([]);
    expect(lastSnapshot(deps).main).toEqual({ kind: "starting" });
    // Boot-phase loading stays a blocking modal (MainView is unmounted while
    // main is "starting", so DialogHost must own the screen).
    expect(currentSystemDialog(deps).kind).toBe("modal");
    expect(currentSystemDialog(deps).config.sections).toEqual([LOADING_SPINNER]);

    // app:started leaves the startup flow: the dialog closes, creation is ground.
    await emit(module, EVENT_APP_STARTED, {});
    await flush();
    expect(lastSnapshot(deps).main).toEqual({ kind: "creation" });
    expect(lastSnapshot(deps).dialogs).toEqual([]);
  });

  it("the setup-error Retry action resolves the parked await-retry hook", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);
    await runHook(module, APP_START_OPERATION_ID, "show-ui", {
      intent: { type: "app:start", payload: {} },
    });
    // Enter setup + fail so the dialog shows the Retry button.
    await runHook(module, SETUP_OPERATION_ID, "show-ui", {
      intent: { type: "app:setup", payload: {} },
    });
    await emit(module, EVENT_SETUP_ERROR, { message: "boom" });
    await flush();

    // The operation waits by collecting the await-retry hook; the handler parks
    // until the Retry action resolves it, then returns.
    let resolved = false;
    void runHook(module, APP_START_OPERATION_ID, "await-retry", {
      intent: { type: "app:start", payload: {} },
    }).then(() => {
      resolved = true;
    });
    await flush();
    action(deps, "retry");
    await flush();

    expect(resolved).toBe(true);
  });

  it("the setup-error Quit action dispatches app:shutdown", async () => {
    const deps = createDeps();
    const dispatched: Array<{ type: string }> = [];
    deps.dispatcher = {
      dispatch: vi.fn((intent: { type: string }) => {
        dispatched.push(intent);
        return Promise.resolve();
      }),
    } as unknown as Deps["dispatcher"];
    createPresentationModule(deps);
    connect(deps);

    action(deps, "quit");

    expect(dispatched).toEqual([{ type: "app:shutdown", payload: {} }]);
  });

  it("app:shutdown stop REJECTS a parked agent-selection so nothing is persisted", async () => {
    const deps = createDeps();
    const module = createPresentationModule(deps);
    connect(deps);

    const ctx: AgentSelectionHookContext = {
      intent: { type: "app:setup", payload: {} },
      availableAgents: [{ agent: "claude", label: "Claude", icon: "sparkle" }],
    };
    const pending = module.hooks![SETUP_OPERATION_ID]!["agent-selection"]!.handler(ctx as never);

    await runHook(module, APP_SHUTDOWN_OPERATION_ID, "stop", {
      intent: { type: "app:shutdown", payload: {} },
    });

    // The parked promise rejects: app:setup unwinds WITHOUT reaching save-agent,
    // so a quit-mid-selection never persists an agent the user didn't choose.
    await expect(pending).rejects.toThrow(/shutting down/);
    // The system dialog is closed and stays closed.
    expect(lastSnapshot(deps).dialogs).toEqual([]);
  });
});

// =============================================================================
// Close-project confirmation dialog (the "confirm" hook on project:close)
// =============================================================================

describe("PresentationModule - close confirm", () => {
  function runConfirm(
    deps: Deps,
    input: { remoteUrl?: string; workspaceCount?: number }
  ): Promise<CloseConfirmHookResult> {
    const module = createPresentationModule(deps);
    // Open the snapshot stream so the confirm dialog appears in ui:state, and
    // reach the steady state (app started) so the startup system dialog closes —
    // project:close only happens post-startup, so the confirm dialog is alone.
    connect(deps);
    void emit(module, EVENT_APP_STARTED, {});
    const workspaces = Array.from({ length: input.workspaceCount ?? 2 }, (_, i) => ({
      path: `${PROJECT_PATH}/.worktrees/ws${i + 1}`,
    }));
    const hookInput = {
      intent: {
        type: "project:close",
        payload: { projectPath: PROJECT_PATH, interactive: true },
      },
      projectPath: PROJECT_PATH,
      ...(input.remoteUrl !== undefined && { remoteUrl: input.remoteUrl }),
      workspaces,
    };
    return (
      module.hooks![CLOSE_PROJECT_OPERATION_ID]!["confirm"]!.handler(hookInput as never) as Promise<
        HookOutput<CloseConfirmHookResult>
      >
    ).then((output) => output.result!);
  }

  function buttonLabel(config: { sections: readonly unknown[] }): string | undefined {
    for (const section of config.sections as Array<{
      type: string;
      items?: Array<{ type: string; id: string; label?: string }>;
    }>) {
      if (section.type !== "group") continue;
      return section.items?.find((item) => item.id === "close")?.label;
    }
    return undefined;
  }

  function checkbox(
    config: { sections: readonly unknown[] },
    id: string
  ): { value?: boolean; disabled?: boolean } | undefined {
    return (
      config.sections as Array<{ type: string; id?: string; value?: boolean; disabled?: boolean }>
    ).find((s) => s.type === "checkbox" && s.id === id);
  }

  // The presenter owns the dialog now; read it from the snapshot and drive user
  // interactions via dialog ui:events (routed to the internal session by id).
  type SnapshotDialog = { id: string; kind: string; config: { sections: readonly unknown[] } };
  function currentDialog(deps: Deps): SnapshotDialog {
    const dialogs = lastSnapshot(deps).dialogs;
    expect(dialogs.length).toBeGreaterThan(0);
    return dialogs[dialogs.length - 1]! as unknown as SnapshotDialog;
  }
  function action(deps: Deps, id: string, actionId: string, data?: Record<string, string>): void {
    emitUiEvent(deps, { kind: "dialog-action", dialogId: id, actionId, ...(data && { data }) });
  }
  function change(deps: Deps, id: string, fieldId: string, data: Record<string, string>): void {
    emitUiEvent(deps, { kind: "dialog-change", dialogId: id, fieldId, data });
  }
  function dismiss(deps: Deps, id: string): void {
    emitUiEvent(deps, { kind: "dialog-dismiss", dialogId: id });
  }
  /** After a close, the dialog is removed from the snapshot. */
  async function expectClosed(deps: Deps): Promise<void> {
    await flush();
    expect(lastSnapshot(deps).dialogs).toEqual([]);
  }

  it("local project: workspace count, remove-all checkbox, Close Project button", async () => {
    const deps = createDeps();
    const pending = runConfirm(deps, { workspaceCount: 2 });
    await flush();
    const dialog = currentDialog(deps);

    expect(dialog.kind).toBe("modal");
    const texts = (dialog.config.sections as Array<{ type: string; content?: string }>)
      .filter((s) => s.type === "text")
      .map((s) => s.content);
    expect(texts).toContain("Close Project");
    expect(texts).toContain(
      "This project has 2 workspaces that will remain on disk after closing."
    );
    expect(checkbox(dialog.config, "remove-all")).toMatchObject({ value: false });
    expect(checkbox(dialog.config, "keep-repo")).toBeUndefined();
    expect(buttonLabel(dialog.config)).toBe("Close Project");

    action(deps, dialog.id, "close");
    await expect(pending).resolves.toEqual({ removeAll: false, removeLocalRepo: false });
    await expectClosed(deps);
  });

  it("checking remove-all updates the warning and button label, and submits removeAll", async () => {
    const deps = createDeps();
    const pending = runConfirm(deps, { workspaceCount: 1 });
    await flush();
    let dialog = currentDialog(deps);

    change(deps, dialog.id, "remove-all", { "remove-all": "true" });
    await flush();
    dialog = currentDialog(deps);

    expect(buttonLabel(dialog.config)).toBe("Remove & Close");
    const texts = (dialog.config.sections as Array<{ type: string; content?: string }>)
      .filter((s) => s.type === "text")
      .map((s) => s.content);
    expect(texts).toContain(
      "All workspaces and their branches will be removed, including any uncommitted changes."
    );

    action(deps, dialog.id, "close");
    await expect(pending).resolves.toEqual({ removeAll: true, removeLocalRepo: false });
  });

  it("remote project defaults to deleting the repo (remove-all forced + disabled)", async () => {
    const deps = createDeps();
    const pending = runConfirm(deps, { remoteUrl: "https://example.com/repo.git" });
    await flush();
    const dialog = currentDialog(deps);

    expect(checkbox(dialog.config, "remove-all")).toMatchObject({ value: true, disabled: true });
    expect(checkbox(dialog.config, "keep-repo")).toMatchObject({ value: false });
    expect(buttonLabel(dialog.config)).toBe("Delete & Close");
    const texts = (dialog.config.sections as Array<{ type: string; content?: string }>)
      .filter((s) => s.type === "text")
      .map((s) => s.content);
    expect(
      texts.some(
        (t) => t?.includes("permanently delete") && t.includes("https://example.com/repo.git")
      )
    ).toBe(true);

    action(deps, dialog.id, "close");
    await expect(pending).resolves.toEqual({ removeAll: true, removeLocalRepo: true });
  });

  it("keeping the cloned repository withdraws the implied remove-all (interlock)", async () => {
    const deps = createDeps();
    const pending = runConfirm(deps, { remoteUrl: "https://example.com/repo.git" });
    await flush();
    let dialog = currentDialog(deps);

    change(deps, dialog.id, "keep-repo", { "keep-repo": "true", "remove-all": "true" });
    await flush();
    dialog = currentDialog(deps);

    expect(checkbox(dialog.config, "remove-all")).toMatchObject({ value: false });
    expect(checkbox(dialog.config, "remove-all")!.disabled).toBeFalsy();
    expect(buttonLabel(dialog.config)).toBe("Close Project");

    action(deps, dialog.id, "close");
    await expect(pending).resolves.toEqual({ removeAll: false, removeLocalRepo: false });
  });

  it("Cancel and Escape resolve canceled", async () => {
    const deps = createDeps();
    const viaCancel = runConfirm(deps, {});
    await flush();
    const cancel = currentDialog(deps);
    action(deps, cancel.id, "cancel");
    await expect(viaCancel).resolves.toEqual({ canceled: true });
    await expectClosed(deps);

    const deps2 = createDeps();
    const viaDismiss = runConfirm(deps2, {});
    await flush();
    const dismissDialog = currentDialog(deps2);
    dismiss(deps2, dismissDialog.id);
    await expect(viaDismiss).resolves.toEqual({ canceled: true });
    await expectClosed(deps2);
  });
});

// =============================================================================
// UI mode computation (shortcut > dialog > hover > workspace)
// =============================================================================

describe("PresentationModule - UI mode", () => {
  function mode(deps: Deps): UiState["mode"] {
    return lastSnapshot(deps).mode;
  }

  it("workspace mode when a workspace is active and nothing else applies", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();

    expect(mode(deps)).toBe("workspace");
  });

  it("hover mode while the creation panel is the ground state (no workspace active)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });
    await flush();

    expect(lastSnapshot(deps).main.kind).toBe("creation");
    expect(mode(deps)).toBe("hover");
  });

  it("hover mode when the sidebar hover region is set (workspace active)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();
    expect(mode(deps)).toBe("workspace");

    emitUiEvent(deps, { kind: "hover", region: "sidebar" });
    await flush();
    expect(mode(deps)).toBe("hover");

    emitUiEvent(deps, { kind: "hover", region: null });
    await flush();
    expect(mode(deps)).toBe("workspace");
  });

  it("dialog mode when a modal dialog is open (beats hover)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });
    await flush();
    // Ground state ⇒ hover.
    expect(mode(deps)).toBe("hover");

    // Open a modal dialog → dialogModalOpen flips the mode to "dialog".
    module.dialog({ sections: [] }, { kind: "modal" });
    await flush();
    expect(mode(deps)).toBe("dialog");
  });

  it("shortcut mode wins over dialog/hover/workspace", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([makeWorkspace("main")]) });

    module.dialog({ sections: [] }, { kind: "modal" });
    await emit(module, EVENT_SHORTCUT_ACTIVE_CHANGED, { active: true });
    await flush();
    expect(mode(deps)).toBe("shortcut");

    await emit(module, EVENT_SHORTCUT_ACTIVE_CHANGED, { active: false });
    await flush();
    // Falls back to dialog (the modal is still open).
    expect(mode(deps)).toBe("dialog");
  });

  it("a panel-kind dialog does NOT count as a modal (no dialog mode)", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await flush();

    module.dialog({ sections: [] }, { kind: "panel" });
    await flush();
    expect(mode(deps)).toBe("workspace");
  });
});

// =============================================================================
// Hibernation capture hooks (collapse the sidebar out of the screenshot)
// =============================================================================

describe("PresentationModule - hibernation capture hooks", () => {
  function captureInput(active: boolean): HibernatePipelineHookInput {
    return {
      intent: { type: "workspace:hibernate", payload: {} },
      projectPath: PROJECT_PATH,
      workspacePath: `${PROJECT_PATH}/.worktrees/main`,
      projectId: PROJECT_ID,
      workspaceName: "main" as WorkspaceName,
      active,
    } as HibernatePipelineHookInput;
  }

  async function prepare(module: UiPresenter, active: boolean): Promise<unknown> {
    return module.hooks![HIBERNATE_WORKSPACE_OPERATION_ID]!["prepare-capture"]!.handler(
      captureInput(active)
    );
  }

  async function cleanup(module: UiPresenter, active: boolean): Promise<unknown> {
    return module.hooks![HIBERNATE_WORKSPACE_OPERATION_ID]!["cleanup-capture"]!.handler(
      captureInput(active)
    );
  }

  /** Active workspace + shortcut mode: the exact state hibernate fires from. */
  async function activeInShortcutMode(deps: Deps): Promise<UiPresenter> {
    const module = await startModule(deps);
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    await emit(module, EVENT_SHORTCUT_ACTIVE_CHANGED, { active: true });
    await flush();
    return module;
  }

  it("prepare-capture flips capturing on and waits for the collapsed paint", async () => {
    const deps = createDeps();
    const module = await activeInShortcutMode(deps);
    expect(lastSnapshot(deps).capturing).toBe(false);
    expect(lastSnapshot(deps).mode).toBe("shortcut");

    await prepare(module, true);

    // The snapshot carries capturing=true (the renderer folds this into an
    // always-collapsed sidebar) while mode stays "shortcut", and main awaited
    // the paint barrier so the following capture sees the collapsed sidebar.
    expect(lastSnapshot(deps).capturing).toBe(true);
    expect(lastSnapshot(deps).mode).toBe("shortcut");
    expect(deps.viewManager.waitForUIPaint).toHaveBeenCalledTimes(1);
  });

  it("cleanup-capture restores capturing to false", async () => {
    const deps = createDeps();
    const module = await activeInShortcutMode(deps);
    await prepare(module, true);
    expect(lastSnapshot(deps).capturing).toBe(true);

    await cleanup(module, true);
    await flush();

    expect(lastSnapshot(deps).capturing).toBe(false);
  });

  it("is a no-op for a background (inactive) hibernation", async () => {
    const deps = createDeps();
    const module = await activeInShortcutMode(deps);
    const pushesBefore = snapshots(deps).length;

    await prepare(module, false);
    await cleanup(module, false);
    await flush();

    expect(deps.viewManager.waitForUIPaint).not.toHaveBeenCalled();
    expect(snapshots(deps).length).toBe(pushesBefore);
    expect(lastSnapshot(deps).capturing).toBe(false);
  });
});

// =============================================================================
// Shortcut navigation (the presenter runs nav over its own ordered rows)
// =============================================================================

describe("PresentationModule - shortcut navigation", () => {
  /** Replace the deps dispatcher with a recording stub. */
  function recordDispatches(deps: Deps): Array<{ type: string; payload: unknown }> {
    const dispatched: Array<{ type: string; payload: unknown }> = [];
    deps.dispatcher = {
      dispatch: vi.fn((intent: { type: string; payload: unknown }) => {
        dispatched.push(intent);
        return Promise.resolve();
      }),
    } as unknown as Deps["dispatcher"];
    return dispatched;
  }

  function key(module: IntentModule, k: string): Promise<void> {
    return emit(module, EVENT_SHORTCUT_KEY_PRESSED, { key: k });
  }

  const pathOf = (name: string): string => `${PROJECT_PATH}/.worktrees/${name}`;

  async function withWorkspaces(
    deps: Deps,
    names: string[],
    activeName: string | null
  ): Promise<IntentModule> {
    const module = await startModule(deps);
    const workspaces = names.map((n) => makeWorkspace(n, { url: `http://127.0.0.1:1/${n}` }));
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject(workspaces) });
    if (activeName) {
      const active = workspaces.find((w) => w.name === activeName)!;
      await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(active));
    }
    return module;
  }

  it("up navigates to the previous workspace (focus:false)", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b", "c"], "b");
    const dispatched = recordDispatches(deps);

    await key(module, "up");

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: pathOf("a"), focus: false } },
    ]);
  });

  it("down navigates to the next workspace", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b", "c"], "b");
    const dispatched = recordDispatches(deps);

    await key(module, "down");

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: pathOf("c"), focus: false } },
    ]);
  });

  it("up with no active workspace targets the last; down targets the first", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b", "c"], null);
    const dispatched = recordDispatches(deps);

    await key(module, "up");
    await key(module, "down");

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: pathOf("c"), focus: false } },
      { type: "workspace:switch", payload: { workspacePath: pathOf("a"), focus: false } },
    ]);
  });

  it("a numeric jump targets the Nth awake workspace", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b", "c"], null);
    const dispatched = recordDispatches(deps);

    await key(module, "2");

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: pathOf("b"), focus: false } },
    ]);
  });

  it("a numeric jump beyond the workspace count is ignored", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b"], null);
    const dispatched = recordDispatches(deps);

    await key(module, "5");

    expect(dispatched).toEqual([]);
  });

  it("left/right navigation prefers idle workspaces, skipping hibernated", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    const a = makeWorkspace("a", { url: "http://127.0.0.1:1/a" });
    const b = makeWorkspace("b", { url: "http://127.0.0.1:1/b", metadata: { hibernated: "true" } });
    const c = makeWorkspace("c", { url: "http://127.0.0.1:1/c" });
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([a, b, c]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(a));
    // Mark c idle; b is hibernated (skipped) and would otherwise be the next.
    await emit(module, EVENT_AGENT_STATUS_UPDATED, {
      workspace: { path: c.path, projectId: PROJECT_ID, name: c.name, active: false },
      status: { status: "idle", counts: { idle: 1, busy: 0 } },
    });
    const dispatched = recordDispatches(deps);

    await key(module, "right");

    expect(dispatched).toEqual([
      { type: "workspace:switch", payload: { workspacePath: c.path, focus: false } },
    ]);
  });

  it("h hibernates an awake active workspace and wakes a hibernated one", async () => {
    const deps = createDeps();
    const awake = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([awake]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(awake));
    const dispatched = recordDispatches(deps);

    await key(module, "h");
    expect(dispatched).toEqual([
      { type: "workspace:hibernate", payload: { workspacePath: awake.path } },
    ]);

    // Flip to hibernated, then h again → wake.
    await emit(module, EVENT_METADATA_CHANGED, {
      projectId: PROJECT_ID,
      workspaceName: awake.name,
      workspacePath: awake.path,
      key: "hibernated",
      value: "true",
    });
    dispatched.length = 0;
    await key(module, "h");
    expect(dispatched).toEqual([
      { type: "workspace:wake", payload: { workspacePath: awake.path, source: "ui-ipc" } },
    ]);
  });

  it("enter deselects (switch to null) so the creation panel shows", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["main"], "main");
    const dispatched = recordDispatches(deps);

    await key(module, "enter");

    expect(dispatched).toEqual([{ type: "workspace:switch", payload: { workspacePath: null } }]);
  });

  it("enter is a no-op when the creation panel is already showing", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["main"], null);
    const dispatched = recordDispatches(deps);

    await key(module, "enter");

    expect(dispatched).toEqual([]);
  });

  it("delete triggers the interactive remove flow for the active workspace", async () => {
    const deps = createDeps();
    const workspace = makeWorkspace("main", { url: "http://127.0.0.1:1/main" });
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([workspace]) });
    await emit(module, EVENT_WORKSPACE_SWITCHED, switchedPayload(workspace));
    const dispatched = recordDispatches(deps);

    await key(module, "delete");

    expect(dispatched).toEqual([
      {
        type: "workspace:delete",
        payload: {
          workspacePath: workspace.path,
          keepBranch: false,
          force: false,
          removeWorktree: true,
          interactive: true,
        },
      },
    ]);
  });

  it("delete is a no-op while the active workspace is still creating", async () => {
    const deps = createDeps();
    const module = await startModule(deps);
    await emit(module, EVENT_PROJECT_OPENED, { project: makeProject([]) });
    await emit(module, EVENT_WORKSPACE_LOADING, {
      workspaceName: "feat",
      projectPath: PROJECT_PATH,
    });
    const dispatched = recordDispatches(deps);

    await key(module, "delete");

    expect(dispatched).toEqual([]);
  });

  it("ignores unrecognized keys", async () => {
    const deps = createDeps();
    const module = await withWorkspaces(deps, ["a", "b"], "a");
    const dispatched = recordDispatches(deps);

    await key(module, "z");

    expect(dispatched).toEqual([]);
  });
});
