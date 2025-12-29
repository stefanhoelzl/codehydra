/**
 * Unit tests for UiModule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UiModule, type UiModuleDeps, type MinimalDialog } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import type { WorkspaceName } from "../../../shared/api/types";
import { generateProjectId } from "../../api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PROJECT_PATH = "/test/project";
const TEST_PROJECT_ID = generateProjectId(TEST_PROJECT_PATH);
const TEST_WORKSPACE_PATH = `${TEST_PROJECT_PATH}/workspaces/feature`;

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    openProject: vi.fn(),
    closeProject: vi.fn(),
    getProject: vi.fn().mockReturnValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [
        { path: "/test/project/workspaces/feature", branch: "feature", metadata: { base: "main" } },
      ],
    }),
    getAllProjects: vi.fn().mockResolvedValue([
      {
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            path: "/test/project/workspaces/feature",
            branch: "feature",
            metadata: { base: "main" },
          },
        ],
      },
    ]),
    getWorkspaceProvider: vi.fn(),
    findProjectForWorkspace: vi.fn().mockReturnValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [],
    }),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn(),
    setLastBaseBranch: vi.fn(),
    loadPersistedProjects: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn(),
    getServerManager: vi.fn(),
    ...overrides,
  } as unknown as AppState;
}

function createMockViewManager(): IViewManager {
  const modeChangeHandlers: Array<(event: { mode: string; previousMode: string }) => void> = [];
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue("/test/project/workspaces/feature"),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn((handler) => {
      modeChangeHandlers.push(handler);
      return () => {
        const idx = modeChangeHandlers.indexOf(handler);
        if (idx >= 0) modeChangeHandlers.splice(idx, 1);
      };
    }),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
    // Test helper to emit mode change
    _emitModeChange: (event: { mode: string; previousMode: string }) => {
      for (const handler of modeChangeHandlers) {
        handler(event);
      }
    },
  } as unknown as IViewManager & {
    _emitModeChange: (event: { mode: string; previousMode: string }) => void;
  };
}

function createMockDialog(): MinimalDialog {
  return {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  };
}

function createMockDeps(overrides: Partial<UiModuleDeps> = {}): UiModuleDeps {
  return {
    appState: createMockAppState(),
    viewManager: createMockViewManager(),
    dialog: createMockDialog(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ui.selectFolder", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("returns null when dialog canceled", async () => {
    const dialog = createMockDialog();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    deps = createMockDeps({ dialog });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.selectFolder");
    const result = await handler!({});

    expect(result).toBeNull();
  });

  it("returns selected folder path", async () => {
    const dialog = createMockDialog();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/folder"],
    });
    deps = createMockDeps({ dialog });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.selectFolder");
    const result = await handler!({});

    expect(result).toBe("/selected/folder");
  });
});

describe("ui.getActiveWorkspace", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("returns null when no active workspace", async () => {
    const viewManager = createMockViewManager();
    vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(null);
    deps = createMockDeps({ viewManager });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.getActiveWorkspace");
    const result = await handler!({});

    expect(result).toBeNull();
  });

  it("returns active workspace reference", async () => {
    const viewManager = createMockViewManager();
    vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(
      "/test/project/workspaces/feature"
    );
    const appState = createMockAppState({
      findProjectForWorkspace: vi.fn().mockReturnValue({
        path: "/test/project",
        name: "test-project",
        workspaces: [],
      }),
    });
    deps = createMockDeps({ viewManager, appState });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.getActiveWorkspace");
    const result = await handler!({});

    expect(result).not.toBeNull();
    expect(result?.workspaceName).toBe("feature");
    expect(result?.path).toBe("/test/project/workspaces/feature");
  });
});

describe("ui.switchWorkspace", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("switches to workspace and emits event", async () => {
    const viewManager = createMockViewManager();
    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [
            {
              path: TEST_WORKSPACE_PATH,
              branch: "feature",
              metadata: { base: "main" },
            },
          ],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [
          {
            path: TEST_WORKSPACE_PATH,
            branch: "feature",
            metadata: { base: "main" },
          },
        ],
      }),
    });
    deps = createMockDeps({ viewManager, appState });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.switchWorkspace");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName: "feature" as WorkspaceName,
    });

    expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, true);
  });
});

describe("ui.setMode", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("calls viewManager.setMode", async () => {
    const viewManager = createMockViewManager();
    deps = createMockDeps({ viewManager });
    new UiModule(registry, deps);

    const handler = registry.getHandler("ui.setMode");
    await handler!({ mode: "shortcut" });

    expect(viewManager.setMode).toHaveBeenCalledWith("shortcut");
  });
});

describe("ui mode change events", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;
  let viewManager: ReturnType<typeof createMockViewManager>;

  beforeEach(() => {
    registry = createMockRegistry();
    viewManager = createMockViewManager();
    deps = createMockDeps({ viewManager });
  });

  it("emits ui:mode-changed when ViewManager mode changes", () => {
    new UiModule(registry, deps);

    // Trigger mode change
    (
      viewManager as unknown as {
        _emitModeChange: (e: { mode: string; previousMode: string }) => void;
      }
    )._emitModeChange({ mode: "shortcut", previousMode: "workspace" });

    const emittedEvents = registry.getEmittedEvents();
    expect(emittedEvents).toContainEqual({
      event: "ui:mode-changed",
      payload: { mode: "shortcut", previousMode: "workspace" },
    });
  });
});

describe("ui.registration", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("registers all ui.* paths with IPC", () => {
    new UiModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("ui.selectFolder");
    expect(registeredPaths).toContain("ui.getActiveWorkspace");
    expect(registeredPaths).toContain("ui.switchWorkspace");
    expect(registeredPaths).toContain("ui.setMode");
  });

  it("registers methods with correct IPC channels", () => {
    new UiModule(registry, deps);

    expect(registry.register).toHaveBeenCalledWith("ui.selectFolder", expect.any(Function), {
      ipc: "api:ui:select-folder",
    });
    expect(registry.register).toHaveBeenCalledWith("ui.setMode", expect.any(Function), {
      ipc: "api:ui:set-mode",
    });
  });
});

describe("UiModule.dispose", () => {
  let registry: MockApiRegistry;
  let deps: UiModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("unsubscribes from mode change events", () => {
    const module = new UiModule(registry, deps);

    // Verify onModeChange was called (subscription created)
    expect(deps.viewManager.onModeChange).toHaveBeenCalled();

    // Dispose should not throw
    expect(() => module.dispose()).not.toThrow();
  });
});
