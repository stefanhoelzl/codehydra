// @vitest-environment node
/**
 * Tests for API event wiring and window title utilities.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName, Project, Workspace } from "../../shared/api/types";
import { wireApiEvents, formatWindowTitle } from "./api-handlers";

// =============================================================================
// Mock API Factory
// =============================================================================

function createMockApi(): ICodeHydraApi {
  return {
    projects: {
      open: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn(),
      remove: vi.fn().mockResolvedValue({ started: true }),
      forceRemove: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      getOpenCodeSession: vi.fn().mockResolvedValue(null),
      setMetadata: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
      restartOpencodeServer: vi.fn().mockResolvedValue(3000),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn(),
      setMode: vi.fn(),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue("ready"),
      setup: vi.fn().mockResolvedValue({ success: true }),
      startServices: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-app-12345678" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;

const TEST_PROJECT: Project = {
  id: TEST_PROJECT_ID,
  name: "my-app",
  path: "/home/user/projects/my-app",
  workspaces: [],
};

const TEST_WORKSPACE: Workspace = {
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  branch: "feature-branch",
  metadata: { base: "main" },
  path: "/home/user/.codehydra/workspaces/feature-branch",
};

// =============================================================================
// formatWindowTitle Tests
// =============================================================================

describe("formatWindowTitle", () => {
  it("formats title with project, workspace, and dev branch", () => {
    const title = formatWindowTitle("my-app", "feature-login", "main");

    expect(title).toBe("CodeHydra - my-app / feature-login - (main)");
  });

  it("formats title with project and workspace, no dev branch", () => {
    const title = formatWindowTitle("my-app", "feature-login", undefined);

    expect(title).toBe("CodeHydra - my-app / feature-login");
  });

  it("formats title with only dev branch when no workspace", () => {
    const title = formatWindowTitle(undefined, undefined, "main");

    expect(title).toBe("CodeHydra - (main)");
  });

  it("formats title as plain CodeHydra when no workspace and no dev branch", () => {
    const title = formatWindowTitle(undefined, undefined, undefined);

    expect(title).toBe("CodeHydra");
  });

  it("formats title without project name (uses only dev branch)", () => {
    // Edge case: workspace name provided but no project name
    const title = formatWindowTitle(undefined, "feature", "main");

    expect(title).toBe("CodeHydra - (main)");
  });

  it("formats title without workspace name (uses only dev branch)", () => {
    // Edge case: project name provided but no workspace name
    const title = formatWindowTitle("my-app", undefined, "main");

    expect(title).toBe("CodeHydra - (main)");
  });
});

// =============================================================================
// wireApiEvents Tests
// =============================================================================

describe("wireApiEvents", () => {
  let mockApi: ICodeHydraApi;
  let mockWebContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> };
  let eventHandlers: Map<string, (event: unknown) => void>;

  beforeEach(() => {
    eventHandlers = new Map();

    mockApi = {
      ...createMockApi(),
      on: vi.fn().mockImplementation((event: string, handler: (event: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => {
          eventHandlers.delete(event);
        };
      }),
    };

    mockWebContents = {
      send: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
    };
  });

  it("subscribes to all API events", () => {
    wireApiEvents(mockApi, () => mockWebContents as never);

    expect(mockApi.on).toHaveBeenCalledWith("project:opened", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("project:closed", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("project:bases-updated", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("workspace:created", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("workspace:removed", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("workspace:switched", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("workspace:status-changed", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("workspace:metadata-changed", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("ui:mode-changed", expect.any(Function));
  });

  it("forwards project:opened events to webContents", () => {
    wireApiEvents(mockApi, () => mockWebContents as never);

    const handler = eventHandlers.get("project:opened");
    handler?.({ project: TEST_PROJECT });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:project:opened", {
      project: TEST_PROJECT,
    });
  });

  it("forwards workspace:created events to webContents", () => {
    wireApiEvents(mockApi, () => mockWebContents as never);

    const handler = eventHandlers.get("workspace:created");
    handler?.({ projectId: TEST_PROJECT_ID, workspace: TEST_WORKSPACE });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:created", {
      projectId: TEST_PROJECT_ID,
      workspace: TEST_WORKSPACE,
    });
  });

  it("forwards ui:mode-changed events to webContents", () => {
    wireApiEvents(mockApi, () => mockWebContents as never);

    const handler = eventHandlers.get("ui:mode-changed");
    handler?.({ mode: "shortcut", previousMode: "workspace" });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:ui:mode-changed", {
      mode: "shortcut",
      previousMode: "workspace",
    });
  });

  it("does not send to destroyed webContents", () => {
    mockWebContents.isDestroyed.mockReturnValue(true);
    wireApiEvents(mockApi, () => mockWebContents as never);

    const handler = eventHandlers.get("project:opened");
    handler?.({ project: TEST_PROJECT });

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it("does not send when webContents is null", () => {
    wireApiEvents(mockApi, () => null);

    const handler = eventHandlers.get("project:opened");
    handler?.({ project: TEST_PROJECT });

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it("returns cleanup function that unsubscribes from all events", () => {
    const cleanup = wireApiEvents(mockApi, () => mockWebContents as never);

    cleanup();

    // After cleanup, handlers should be removed
    expect(eventHandlers.size).toBe(0);
  });

  describe("with titleConfig", () => {
    let mockSetTitle: (title: string) => void;

    beforeEach(() => {
      mockSetTitle = vi.fn();
    });

    it("updates window title on workspace:switched event", () => {
      wireApiEvents(mockApi, () => mockWebContents as never, {
        setTitle: mockSetTitle,
        defaultTitle: "CodeHydra - (main)",
        devBranch: "main",
        getProjectName: () => "my-project",
      });

      const handler = eventHandlers.get("workspace:switched");
      handler?.({
        projectId: TEST_PROJECT_ID,
        workspaceName: "feature-x" as WorkspaceName,
        path: "/home/user/.worktrees/feature-x",
      });

      expect(mockSetTitle).toHaveBeenCalledWith("CodeHydra - my-project / feature-x - (main)");
    });

    it("uses default title when workspace:switched event is null", () => {
      wireApiEvents(mockApi, () => mockWebContents as never, {
        setTitle: mockSetTitle,
        defaultTitle: "CodeHydra - (main)",
        devBranch: "main",
        getProjectName: () => "my-project",
      });

      const handler = eventHandlers.get("workspace:switched");
      handler?.(null);

      expect(mockSetTitle).toHaveBeenCalledWith("CodeHydra - (main)");
    });

    it("formats title correctly when project name not found", () => {
      wireApiEvents(mockApi, () => mockWebContents as never, {
        setTitle: mockSetTitle,
        defaultTitle: "CodeHydra - (dev)",
        devBranch: "dev",
        getProjectName: () => undefined, // Project not found
      });

      const handler = eventHandlers.get("workspace:switched");
      handler?.({
        projectId: TEST_PROJECT_ID,
        workspaceName: "feature-x" as WorkspaceName,
        path: "/home/user/.worktrees/feature-x",
      });

      // Without project name, falls back to just dev branch
      expect(mockSetTitle).toHaveBeenCalledWith("CodeHydra - (dev)");
    });

    it("formats title without dev branch in production", () => {
      wireApiEvents(mockApi, () => mockWebContents as never, {
        setTitle: mockSetTitle,
        defaultTitle: "CodeHydra",
        // No devBranch - production mode
        getProjectName: () => "my-project",
      });

      const handler = eventHandlers.get("workspace:switched");
      handler?.({
        projectId: TEST_PROJECT_ID,
        workspaceName: "feature-x" as WorkspaceName,
        path: "/home/user/.worktrees/feature-x",
      });

      expect(mockSetTitle).toHaveBeenCalledWith("CodeHydra - my-project / feature-x");
    });
  });
});
