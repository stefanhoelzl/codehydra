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
      clone: vi.fn(),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn(),
      remove: vi.fn().mockResolvedValue({ started: true }),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      getAgentSession: vi.fn().mockResolvedValue(null),
      setMetadata: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
      restartAgentServer: vi.fn().mockResolvedValue(3000),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn(),
      setMode: vi.fn(),
    },
    lifecycle: {
      ready: vi.fn(),
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
  it("formats title with project, workspace, and version", () => {
    const title = formatWindowTitle("my-app", "feature-login", "main");

    expect(title).toBe("CodeHydra - my-app / feature-login - (main)");
  });

  it("formats title with project and workspace, no version", () => {
    const title = formatWindowTitle("my-app", "feature-login", undefined);

    expect(title).toBe("CodeHydra - my-app / feature-login");
  });

  it("formats title with only version when no workspace", () => {
    const title = formatWindowTitle(undefined, undefined, "main");

    expect(title).toBe("CodeHydra - (main)");
  });

  it("formats title as plain CodeHydra when no workspace and no version", () => {
    const title = formatWindowTitle(undefined, undefined, undefined);

    expect(title).toBe("CodeHydra");
  });

  it("formats title without project name (uses only version)", () => {
    // Edge case: workspace name provided but no project name
    const title = formatWindowTitle(undefined, "feature", "main");

    expect(title).toBe("CodeHydra - (main)");
  });

  it("formats title without workspace name (uses only version)", () => {
    // Edge case: project name provided but no workspace name
    const title = formatWindowTitle("my-app", undefined, "main");

    expect(title).toBe("CodeHydra - (main)");
  });

  it("formats title with update available", () => {
    const title = formatWindowTitle("my-app", "feature-login", "main", true);

    expect(title).toBe("CodeHydra - my-app / feature-login - (main) - (update available)");
  });

  it("formats title with update available but no workspace", () => {
    const title = formatWindowTitle(undefined, undefined, "main", true);

    expect(title).toBe("CodeHydra - (main) - (update available)");
  });

  it("formats title with update available but no version suffix", () => {
    const title = formatWindowTitle("my-app", "feature-login", undefined, true);

    expect(title).toBe("CodeHydra - my-app / feature-login - (update available)");
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
    expect(mockApi.on).toHaveBeenCalledWith("lifecycle:setup-progress", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("lifecycle:setup-error", expect.any(Function));
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

  it("forwards lifecycle:setup-error events to webContents", () => {
    wireApiEvents(mockApi, () => mockWebContents as never);

    const handler = eventHandlers.get("lifecycle:setup-error");
    handler?.({ message: "Download failed", code: "NETWORK_ERROR" });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:lifecycle:setup-error", {
      message: "Download failed",
      code: "NETWORK_ERROR",
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

  // Note: titleConfig / workspace:switched tests removed.
  // Title updates are now tested via SwitchTitleModule in switch-workspace.integration.test.ts
  // IPC forwarding of workspace:switched is tested via IpcEventBridge
});
