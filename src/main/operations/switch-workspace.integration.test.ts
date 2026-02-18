// @vitest-environment node
/**
 * Integration tests for switch-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * including workspace resolution, no-op detection, focus handling, and event emission.
 *
 * Test plan items covered:
 * #1:  switches to resolved workspace
 * #2:  emits workspace:switched event with correct payload
 * #3:  defaults focus to true
 * #4:  passes focus=false when specified
 * #5:  throws when workspace not found
 * #6:  no-op when switching to already-active workspace
 * #7:  bridge handler defaults focus when omitted in API payload
 * #8:  IPC bridge forwards workspace:switched event
 * #9:  title module updates window title on switch
 * #10: title module formats title with update-available suffix
 * #11: interceptor cancellation prevents operation and event
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  SwitchWorkspaceOperation,
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
  isAutoSwitch,
} from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ResolveProjectHookResult,
  ResolveWorkspaceHookInput,
  ResolveWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
  FindCandidatesHookResult,
} from "./switch-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
import { createIpcEventBridge } from "../modules/ipc-event-bridge";
import { createWindowTitleModule } from "../modules/window-title-module";
import { SILENT_LOGGER } from "../../services/logging";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./update-available";
import type { UpdateAvailableIntent } from "./update-available";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Mock ApiRegistry for IpcEventBridge
// =============================================================================

interface MockApiRegistry {
  emit: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getInterface: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function createMockApiRegistry(): MockApiRegistry {
  return {
    emit: vi.fn(),
    register: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    getInterface: vi.fn(),
    dispose: vi.fn(),
  };
}

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface MockViewManager {
  activeWorkspacePath: string | null;
  focusState: boolean;
  setActiveWorkspace(path: string | null, focus: boolean): void;
  getActiveWorkspacePath(): string | null;
}

function createMockViewManager(initialActive: string | null = null): MockViewManager {
  return {
    activeWorkspacePath: initialActive,
    focusState: false,
    setActiveWorkspace(path: string | null, focus: boolean): void {
      this.activeWorkspacePath = path;
      this.focusState = focus;
    },
    getActiveWorkspacePath(): string | null {
      return this.activeWorkspacePath;
    },
  };
}

// =============================================================================
// Mock AppState for workspace resolution
// =============================================================================

interface WorkspaceEntry {
  path: string;
  branch?: string | null;
  metadata: Readonly<Record<string, string>>;
}

interface ProjectEntry {
  path: string;
  name: string;
  workspaces: WorkspaceEntry[];
}

interface MockAppState {
  projects: ProjectEntry[];
  getAllProjects(): Promise<ReadonlyArray<{ path: string }>>;
  getProject(
    projectPath: string
  ): { path: string; name: string; workspaces: ReadonlyArray<WorkspaceEntry> } | undefined;
}

function createMockAppState(projects: ProjectEntry[]): MockAppState {
  return {
    projects,
    async getAllProjects(): Promise<ReadonlyArray<{ path: string }>> {
      return this.projects;
    },
    getProject(
      projectPath: string
    ): { path: string; name: string; workspaces: ReadonlyArray<WorkspaceEntry> } | undefined {
      return this.projects.find((p) => p.path === projectPath);
    },
  };
}

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PROJECT_PATH = "/projects/my-app";
const TEST_PROJECT_NAME = "my-app";
const TEST_WORKSPACE_PATH = "/projects/my-app/workspaces/feature-login";
const TEST_WORKSPACE_NAME = "feature-login" as WorkspaceName;
const TEST_WORKSPACE_PATH_B = "/projects/my-app/workspaces/feature-signup";
function createTestProject(): ProjectEntry {
  return {
    path: TEST_PROJECT_PATH,
    name: TEST_PROJECT_NAME,
    workspaces: [
      {
        path: TEST_WORKSPACE_PATH,
        branch: "feature-login",
        metadata: {},
      },
    ],
  };
}
function createMultiWorkspaceProject(): ProjectEntry {
  return {
    path: TEST_PROJECT_PATH,
    name: TEST_PROJECT_NAME,
    workspaces: [
      {
        path: TEST_WORKSPACE_PATH,
        branch: "feature-login",
        metadata: {},
      },
      {
        path: TEST_WORKSPACE_PATH_B,
        branch: "feature-signup",
        metadata: {},
      },
    ],
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  viewManager: MockViewManager;
  appState: MockAppState;
  mockApiRegistry: MockApiRegistry;
  setTitle: ReturnType<typeof vi.fn>;
}

function createTestSetup(opts?: {
  initialActive?: string | null;
  withIpcEventBridge?: boolean;
  withTitleModule?: boolean;
  withAutoSelect?: boolean;
  titleVersion?: string;
  projects?: ProjectEntry[];
}): TestSetup {
  const projects = opts?.projects ?? [createTestProject()];
  const viewManager = createMockViewManager(opts?.initialActive ?? null);
  const appState = createMockAppState(projects);
  const setTitle = vi.fn();
  const titleVersion = opts?.titleVersion ?? "main";

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(extractWorkspaceName, generateProjectId)
  );

  // ResolveProjectModule: "resolve-project" hook -- resolves projectId → projectPath + projectName
  const resolveProjectModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { payload } = ctx.intent as SwitchWorkspaceIntent;
            if (isAutoSwitch(payload)) return {};
            const projectPath = await resolveProjectPath(payload.projectId, appState);
            if (!projectPath) return {};
            const project = appState.getProject(projectPath);
            if (!project) return {};
            return { projectPath, projectName: project.name };
          },
        },
      },
    },
  };

  // ResolveWorkspaceModule: "resolve-workspace" hook -- resolves workspaceName → workspacePath
  const resolveWorkspaceModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { projectPath, workspaceName } = ctx as ResolveWorkspaceHookInput;
            const project = appState.getProject(projectPath);
            if (!project) return {};
            const workspace = project.workspaces.find(
              (w) => extractWorkspaceName(w.path) === workspaceName
            );
            return workspace ? { workspacePath: workspace.path } : {};
          },
        },
      },
    },
  };

  // SwitchViewModule: "activate" hook -- calls setActiveWorkspace
  // Also subscribes to workspace:switched(null) to clear viewManager.
  const switchViewModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath } = ctx as ActivateHookInput;
            const intent = ctx.intent as SwitchWorkspaceIntent;

            if (viewManager.getActiveWorkspacePath() === workspacePath) {
              return {};
            }

            const focus = intent.payload.focus ?? true;
            viewManager.setActiveWorkspace(workspacePath, focus);
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          viewManager.setActiveWorkspace(null, false);
        }
      },
    },
  };

  const mockApiRegistry = createMockApiRegistry();
  const modules: IntentModule[] = [resolveProjectModule, resolveWorkspaceModule, switchViewModule];

  if (opts?.withAutoSelect) {
    const findCandidatesModule: IntentModule = {
      hooks: {
        [SWITCH_WORKSPACE_OPERATION_ID]: {
          "find-candidates": {
            handler: async (): Promise<FindCandidatesHookResult> => {
              const candidates: Array<{
                projectPath: string;
                projectName: string;
                workspacePath: string;
              }> = [];
              for (const project of appState.projects) {
                for (const ws of project.workspaces) {
                  candidates.push({
                    projectPath: project.path,
                    projectName: project.name,
                    workspacePath: ws.path,
                  });
                }
              }
              return { candidates };
            },
          },
        },
      },
    };
    modules.push(findCandidatesModule);
  }

  if (opts?.withIpcEventBridge) {
    const ipcEventBridge = createIpcEventBridge({
      apiRegistry: mockApiRegistry as unknown as import("../api/registry-types").IApiRegistry,
      getApi: () => {
        throw new Error("not wired");
      },
      getUIWebContents: () => null,
      pluginServer: null,
      logger: SILENT_LOGGER,
    });
    modules.push(ipcEventBridge);
  }

  if (opts?.withTitleModule) {
    dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());
    modules.push(createWindowTitleModule(setTitle, titleVersion));
  }

  wireModules(modules, hookRegistry, dispatcher);

  return {
    dispatcher,
    viewManager,
    appState,
    mockApiRegistry,
    setTitle,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Resolve project path from project ID using the same logic as id-utils */
function generateProjectId(path: string): ProjectId {
  return Buffer.from(path).toString("base64url") as ProjectId;
}

function extractWorkspaceName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

async function resolveProjectPath(
  projectId: string,
  accessor: { getAllProjects(): Promise<ReadonlyArray<{ path: string }>> }
): Promise<string | undefined> {
  const projects = await accessor.getAllProjects();
  return projects.find((p) => generateProjectId(p.path) === projectId)?.path;
}

function switchIntent(
  projectId?: ProjectId,
  workspaceName?: WorkspaceName,
  focus?: boolean
): SwitchWorkspaceIntent {
  return {
    type: INTENT_SWITCH_WORKSPACE,
    payload: {
      projectId: projectId ?? (generateProjectId(TEST_PROJECT_PATH) as ProjectId),
      workspaceName: workspaceName ?? TEST_WORKSPACE_NAME,
      ...(focus !== undefined && { focus }),
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("SwitchWorkspace Operation", () => {
  describe("switches to resolved workspace (#1)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup();
    });

    it("sets viewManager activeWorkspacePath to resolved path", async () => {
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(switchIntent());

      expect(viewManager.activeWorkspacePath).toBe(TEST_WORKSPACE_PATH);
    });
  });

  describe("emits workspace:switched event (#2)", () => {
    it("emits event with correct projectId, workspaceName, and path", async () => {
      const setup = createTestSetup();
      const { dispatcher } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(switchIntent());

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as WorkspaceSwitchedEvent;
      expect(event.type).toBe(EVENT_WORKSPACE_SWITCHED);
      expect(event.payload).toEqual({
        projectId: generateProjectId(TEST_PROJECT_PATH),
        projectName: TEST_PROJECT_NAME,
        projectPath: TEST_PROJECT_PATH,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });
  });

  describe("defaults focus to true (#3)", () => {
    it("sets focusState to true when focus not specified", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(switchIntent(undefined, undefined, undefined));

      expect(viewManager.focusState).toBe(true);
    });
  });

  describe("passes focus=false when specified (#4)", () => {
    it("sets focusState to false when focus is false", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(switchIntent(undefined, undefined, false));

      expect(viewManager.focusState).toBe(false);
    });
  });

  describe("throws when workspace not found (#5)", () => {
    it("rejects with error and leaves activeWorkspacePath unchanged", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      await expect(
        dispatcher.dispatch(
          switchIntent(
            generateProjectId(TEST_PROJECT_PATH) as ProjectId,
            "nonexistent" as WorkspaceName
          )
        )
      ).rejects.toThrow("Workspace not found: nonexistent");

      expect(viewManager.activeWorkspacePath).toBeNull();
    });

    it("rejects when project not found", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      await expect(
        dispatcher.dispatch(
          switchIntent(generateProjectId("/nonexistent") as ProjectId, TEST_WORKSPACE_NAME)
        )
      ).rejects.toThrow("Project not found");

      expect(viewManager.activeWorkspacePath).toBeNull();
    });
  });

  describe("no-op when switching to already-active workspace (#6)", () => {
    it("does not emit event and leaves activeWorkspacePath unchanged", async () => {
      const setup = createTestSetup({ initialActive: TEST_WORKSPACE_PATH });
      const { dispatcher, viewManager } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(switchIntent());

      expect(viewManager.activeWorkspacePath).toBe(TEST_WORKSPACE_PATH);
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("bridge handler defaults focus (#7)", () => {
    it("dispatches with focus defaulting to true when omitted", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      // Simulate what the bridge handler does: no focus field in payload
      const intent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          projectId: generateProjectId(TEST_PROJECT_PATH) as ProjectId,
          workspaceName: TEST_WORKSPACE_NAME,
        },
      };
      await dispatcher.dispatch(intent);

      expect(viewManager.activeWorkspacePath).toBe(TEST_WORKSPACE_PATH);
      expect(viewManager.focusState).toBe(true);
    });
  });

  describe("IPC bridge forwards workspace:switched event (#8)", () => {
    it("forwards to apiRegistry.emit with correct payload", async () => {
      const setup = createTestSetup({ withIpcEventBridge: true });
      const { dispatcher, mockApiRegistry } = setup;

      await dispatcher.dispatch(switchIntent());

      expect(mockApiRegistry.emit).toHaveBeenCalledWith("workspace:switched", {
        projectId: generateProjectId(TEST_PROJECT_PATH),
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });
  });

  describe("title module updates window title on switch (#9)", () => {
    it("calls setTitle with formatted title including version", async () => {
      const setup = createTestSetup({ withTitleModule: true, titleVersion: "main" });
      const { dispatcher, setTitle } = setup;

      await dispatcher.dispatch(switchIntent());

      expect(setTitle).toHaveBeenCalledWith(
        `CodeHydra - ${TEST_PROJECT_NAME} / ${TEST_WORKSPACE_NAME} - (main)`
      );
    });
  });

  describe("title module formats title with update-available suffix (#10)", () => {
    it("includes (update available) after update:available intent", async () => {
      const setup = createTestSetup({
        withTitleModule: true,
        titleVersion: "main",
      });
      const { dispatcher, setTitle } = setup;

      // Dispatch update:available before workspace switch
      await dispatcher.dispatch({
        type: INTENT_UPDATE_AVAILABLE,
        payload: { version: "1.2.3" },
      } as UpdateAvailableIntent);
      setTitle.mockClear();

      await dispatcher.dispatch(switchIntent());

      expect(setTitle).toHaveBeenCalledWith(
        `CodeHydra - ${TEST_PROJECT_NAME} / ${TEST_WORKSPACE_NAME} - (main) - (update available)`
      );
    });
  });

  describe("interceptor cancellation prevents operation and event (#11)", () => {
    it("does not run operation and does not emit event", async () => {
      const setup = createTestSetup();
      const { dispatcher, viewManager } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      dispatcher.addInterceptor(cancelInterceptor);

      const result = await dispatcher.dispatch(switchIntent());

      expect(result).toBeUndefined();
      expect(viewManager.activeWorkspacePath).toBeNull();
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("auto-select switches to best candidate (#12)", () => {
    it("selects nearest workspace when current is being deleted", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [createMultiWorkspaceProject()],
      });
      const { dispatcher, viewManager } = setup;

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: TEST_WORKSPACE_PATH, focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(viewManager.activeWorkspacePath).toBe(TEST_WORKSPACE_PATH_B);
    });
  });

  describe("auto-select emits null when no candidates (#13)", () => {
    it("sets active workspace to null and emits workspace:switched(null)", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [createTestProject()], // only one workspace (the current one)
      });
      const { dispatcher, viewManager } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: TEST_WORKSPACE_PATH, focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(viewManager.activeWorkspacePath).toBeNull();
      expect(receivedEvents).toHaveLength(1);
      expect((receivedEvents[0] as WorkspaceSwitchedEvent).payload).toBeNull();
    });
  });

  describe("auto-select emits null when candidates list is empty (#14)", () => {
    it("handles zero candidates gracefully", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [], // no projects at all
      });
      const { dispatcher, viewManager } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: "/nonexistent", focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(viewManager.activeWorkspacePath).toBeNull();
      expect(receivedEvents).toHaveLength(1);
      expect((receivedEvents[0] as WorkspaceSwitchedEvent).payload).toBeNull();
    });
  });
});
