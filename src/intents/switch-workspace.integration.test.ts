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
 * #11: interceptor cancellation prevents operation and event
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Dispatcher } from "./lib/dispatcher";
import type { IntentInterceptor } from "./lib/dispatcher";

import {
  SwitchWorkspaceOperation,
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
  selectNextWorkspace,
} from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
  FindCandidatesHookResult,
  SelectNextHookInput,
  SelectNextHookResult,
} from "./switch-workspace";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "./resolve-project";
import type { IntentModule } from "./lib/module";
import type { HookContext } from "./lib/operation";
import type { DomainEvent, Intent } from "./lib/types";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { extractWorkspaceName } from "../shared/api/id-utils";

// =============================================================================
// Behavioral Mocks
// =============================================================================

// =============================================================================
// Mock state for workspace resolution
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
  appState: MockAppState;
  getActivePath: () => string | null;
}

function createTestSetup(opts?: {
  initialActive?: string | null;
  withAutoSelect?: boolean;
  projects?: ProjectEntry[];
}): TestSetup {
  const projects = opts?.projects ?? [createTestProject()];
  let activePath: string | null = opts?.initialActive ?? null;
  const setActiveWorkspace = vi.fn((path: string | null) => {
    activePath = path;
  });
  const appState = createMockAppState(projects);

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());

  // ResolveModule: "resolve" hook -- resolves workspacePath → projectPath + workspaceName + active
  const resolveModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath: wsPath } = ctx as { workspacePath: string } & HookContext;
            // Reverse lookup: find which project owns this workspace path
            for (const project of appState.projects) {
              const workspace = project.workspaces.find((w) => w.path === wsPath);
              if (workspace) {
                return {
                  projectPath: project.path,
                  workspaceName: extractWorkspaceName(wsPath),
                  active: activePath === wsPath,
                };
              }
            }
            return {};
          },
        },
      },
    },
  };

  // ResolveProjectModule: "resolve" hook -- resolves projectPath → projectId + projectName
  const resolveProjectModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as { projectPath: string } & HookContext;
            const project = appState.getProject(projectPath);
            if (!project) return {};
            return { projectId: generateProjectId(project.path), projectName: project.name };
          },
        },
      },
    },
  };

  // SwitchViewModule: "activate" hook -- records the active surface
  // (mirrors view-module's hook). Also subscribes to workspace:switched(null)
  // to clear it.
  const switchViewModule: IntentModule = {
    name: "test",
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath, active } = ctx as ActivateHookInput;

            if (active) {
              return {};
            }

            setActiveWorkspace(workspacePath);
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceSwitchedEvent).payload;
          if (payload === null) {
            setActiveWorkspace(null);
          }
        },
      },
    },
  };

  const modules: IntentModule[] = [resolveModule, resolveProjectModule, switchViewModule];

  if (opts?.withAutoSelect) {
    const findCandidatesModule: IntentModule = {
      name: "test",
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

    const selectNextModule: IntentModule = {
      name: "test",
      hooks: {
        [SWITCH_WORKSPACE_OPERATION_ID]: {
          "select-next": {
            handler: async (ctx: HookContext): Promise<SelectNextHookResult> => {
              const { currentPath, candidates } = ctx as unknown as SelectNextHookInput;
              const result = selectNextWorkspace(currentPath, candidates, extractWorkspaceName);
              return result ? { selected: result } : {};
            },
          },
        },
      },
    };
    modules.push(selectNextModule);
  }

  for (const m of modules) dispatcher.registerModule(m);

  return {
    dispatcher,
    appState,
    getActivePath: () => activePath,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Resolve project path from project ID using the same logic as id-utils */
function generateProjectId(path: string): ProjectId {
  return Buffer.from(path).toString("base64url") as ProjectId;
}

function switchIntent(workspacePath?: string, focus?: boolean): SwitchWorkspaceIntent {
  return {
    type: INTENT_SWITCH_WORKSPACE,
    payload: {
      workspacePath: workspacePath ?? TEST_WORKSPACE_PATH,
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

    it("sets the active surface to the resolved path", async () => {
      const { dispatcher, getActivePath } = setup;

      await dispatcher.dispatch(switchIntent());

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH);
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

  describe("activates regardless of focus flag (#3/#4)", () => {
    it("activates when focus not specified", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

      await dispatcher.dispatch(switchIntent(undefined, undefined));

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH);
    });

    it("activates when focus is false (focus routing is renderer-side)", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

      await dispatcher.dispatch(switchIntent(undefined, false));

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH);
    });
  });

  describe("throws when workspace not found (#5)", () => {
    it("rejects with error and leaves activeWorkspacePath unchanged", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

      await expect(
        dispatcher.dispatch(switchIntent("/projects/my-app/workspaces/nonexistent"))
      ).rejects.toThrow("Workspace not found: /projects/my-app/workspaces/nonexistent");

      expect(getActivePath()).toBeNull();
    });

    it("rejects when project not found", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

      await expect(
        dispatcher.dispatch(switchIntent("/nonexistent/workspaces/feature-login"))
      ).rejects.toThrow("Workspace not found: /nonexistent/workspaces/feature-login");

      expect(getActivePath()).toBeNull();
    });
  });

  describe("no-op when switching to already-active workspace (#6)", () => {
    it("does not emit event and leaves activeWorkspacePath unchanged", async () => {
      const setup = createTestSetup({ initialActive: TEST_WORKSPACE_PATH });
      const { dispatcher, getActivePath } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(switchIntent());

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH);
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("bridge handler defaults focus (#7)", () => {
    it("dispatches with focus defaulting to true when omitted", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

      // Simulate what the bridge handler does: no focus field in payload
      const intent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: TEST_WORKSPACE_PATH,
        },
      };
      await dispatcher.dispatch(intent);

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH);
    });
  });

  describe("interceptor cancellation prevents operation and event (#11)", () => {
    it("does not run operation and does not emit event", async () => {
      const setup = createTestSetup();
      const { dispatcher, getActivePath } = setup;

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
      expect(getActivePath()).toBeNull();
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("auto-select switches to best candidate (#12)", () => {
    it("selects nearest workspace when current is being deleted", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [createMultiWorkspaceProject()],
      });
      const { dispatcher, getActivePath } = setup;

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: TEST_WORKSPACE_PATH, focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(getActivePath()).toBe(TEST_WORKSPACE_PATH_B);
    });
  });

  describe("auto-select emits null when no candidates (#13)", () => {
    it("sets active workspace to null and emits workspace:switched(null)", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [createTestProject()], // only one workspace (the current one)
      });
      const { dispatcher, getActivePath } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: TEST_WORKSPACE_PATH, focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(getActivePath()).toBeNull();
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
      const { dispatcher, getActivePath } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        receivedEvents.push(event);
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: "/nonexistent", focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      expect(getActivePath()).toBeNull();
      expect(receivedEvents).toHaveLength(1);
      expect((receivedEvents[0] as WorkspaceSwitchedEvent).payload).toBeNull();
    });
  });

  describe("auto-select when currentPath not in candidates", () => {
    it("selects best candidate even when currentPath is already de-registered", async () => {
      const setup = createTestSetup({
        withAutoSelect: true,
        projects: [createMultiWorkspaceProject()],
      });
      const { dispatcher, getActivePath } = setup;

      // currentPath doesn't match any candidate (workspace already de-registered)
      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: "/nonexistent", focus: true },
      };
      await dispatcher.dispatch(autoIntent);

      // Should still switch to a valid workspace instead of null
      expect(getActivePath()).not.toBeNull();
    });
  });
});
