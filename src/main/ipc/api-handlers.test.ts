// @vitest-environment node
/**
 * Tests for API-based IPC handlers.
 * These handlers delegate to ICodeHydraApi methods.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName, Project, Workspace } from "../../shared/api/types";

// Mock functions at top level
const mockHandle = vi.fn();

// Mock Electron - must be at module scope
vi.mock("electron", () => {
  return {
    ipcMain: {
      handle: (...args: unknown[]) => mockHandle(...args),
    },
  };
});

// Import after mock
import { registerApiHandlers, wireApiEvents, formatWindowTitle } from "./api-handlers";

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
      remove: vi.fn().mockResolvedValue({ branchDeleted: false }),
      get: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      setMetadata: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
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
      quit: vi.fn(),
    },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

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
// Tests
// =============================================================================

describe("registerApiHandlers", () => {
  let mockApi: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    mockApi = createMockApi();
  });

  it("registers all API handlers", () => {
    registerApiHandlers(mockApi);

    // Verify expected channels are registered
    const registeredChannels = mockHandle.mock.calls.map((call) => call[0]);
    expect(registeredChannels).toContain("api:project:open");
    expect(registeredChannels).toContain("api:project:close");
    expect(registeredChannels).toContain("api:project:list");
    expect(registeredChannels).toContain("api:project:get");
    expect(registeredChannels).toContain("api:project:fetch-bases");
    expect(registeredChannels).toContain("api:workspace:create");
    expect(registeredChannels).toContain("api:workspace:remove");
    expect(registeredChannels).toContain("api:workspace:get");
    expect(registeredChannels).toContain("api:workspace:get-status");
    expect(registeredChannels).toContain("api:ui:select-folder");
    expect(registeredChannels).toContain("api:ui:get-active-workspace");
    expect(registeredChannels).toContain("api:ui:switch-workspace");
    expect(registeredChannels).toContain("api:ui:set-mode");
    // NOTE: Lifecycle handlers are registered separately via registerLifecycleHandlers()
    // in bootstrap(), NOT in registerApiHandlers(). See lifecycle-handlers.ts.
  });
});

describe("Project API handlers", () => {
  let mockApi: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    mockApi = createMockApi();
    registerApiHandlers(mockApi);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  describe("api:project:open", () => {
    it("delegates to api.projects.open", async () => {
      vi.mocked(mockApi.projects.open).mockResolvedValue(TEST_PROJECT);

      const handler = getHandler("api:project:open");
      const result = await handler({}, { path: "/home/user/projects/my-app" });

      expect(mockApi.projects.open).toHaveBeenCalledWith("/home/user/projects/my-app");
      expect(result).toEqual(TEST_PROJECT);
    });

    it("throws validation error for missing path", async () => {
      const handler = getHandler("api:project:open");

      await expect(handler({}, {})).rejects.toThrow(/path/i);
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("throws validation error for non-string path", async () => {
      const handler = getHandler("api:project:open");

      await expect(handler({}, { path: 123 })).rejects.toThrow(/path/i);
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("throws validation error for relative path", async () => {
      const handler = getHandler("api:project:open");

      await expect(handler({}, { path: "relative/path" })).rejects.toThrow(/absolute/i);
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });
  });

  describe("api:project:close", () => {
    it("delegates to api.projects.close", async () => {
      const handler = getHandler("api:project:close");
      await handler({}, { projectId: TEST_PROJECT_ID });

      expect(mockApi.projects.close).toHaveBeenCalledWith(TEST_PROJECT_ID);
    });

    it("throws validation error for invalid projectId", async () => {
      const handler = getHandler("api:project:close");

      await expect(handler({}, { projectId: "invalid" })).rejects.toThrow(/projectId/i);
      expect(mockApi.projects.close).not.toHaveBeenCalled();
    });
  });

  describe("api:project:list", () => {
    it("delegates to api.projects.list", async () => {
      vi.mocked(mockApi.projects.list).mockResolvedValue([TEST_PROJECT]);

      const handler = getHandler("api:project:list");
      const result = await handler({}, undefined);

      expect(mockApi.projects.list).toHaveBeenCalled();
      expect(result).toEqual([TEST_PROJECT]);
    });
  });

  describe("api:project:get", () => {
    it("delegates to api.projects.get", async () => {
      vi.mocked(mockApi.projects.get).mockResolvedValue(TEST_PROJECT);

      const handler = getHandler("api:project:get");
      const result = await handler({}, { projectId: TEST_PROJECT_ID });

      expect(mockApi.projects.get).toHaveBeenCalledWith(TEST_PROJECT_ID);
      expect(result).toEqual(TEST_PROJECT);
    });
  });

  describe("api:project:fetch-bases", () => {
    it("delegates to api.projects.fetchBases", async () => {
      const bases = [{ name: "main", isRemote: false }];
      vi.mocked(mockApi.projects.fetchBases).mockResolvedValue({ bases });

      const handler = getHandler("api:project:fetch-bases");
      const result = await handler({}, { projectId: TEST_PROJECT_ID });

      expect(mockApi.projects.fetchBases).toHaveBeenCalledWith(TEST_PROJECT_ID);
      expect(result).toEqual({ bases });
    });
  });
});

describe("Workspace API handlers", () => {
  let mockApi: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    mockApi = createMockApi();
    registerApiHandlers(mockApi);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  describe("api:workspace:create", () => {
    it("delegates to api.workspaces.create", async () => {
      vi.mocked(mockApi.workspaces.create).mockResolvedValue(TEST_WORKSPACE);

      const handler = getHandler("api:workspace:create");
      const result = await handler(
        {},
        { projectId: TEST_PROJECT_ID, name: "feature-branch", base: "main" }
      );

      expect(mockApi.workspaces.create).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        "feature-branch",
        "main"
      );
      expect(result).toEqual(TEST_WORKSPACE);
    });

    it("throws validation error for missing name", async () => {
      const handler = getHandler("api:workspace:create");

      await expect(handler({}, { projectId: TEST_PROJECT_ID, base: "main" })).rejects.toThrow(
        /name/i
      );
    });

    it("throws validation error for empty name", async () => {
      const handler = getHandler("api:workspace:create");

      await expect(
        handler({}, { projectId: TEST_PROJECT_ID, name: "", base: "main" })
      ).rejects.toThrow(/name/i);
    });
  });

  describe("api:workspace:remove", () => {
    it("delegates to api.workspaces.remove with keepBranch default", async () => {
      const handler = getHandler("api:workspace:remove");
      await handler({}, { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME });

      // keepBranch defaults to true in the handler
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        true
      );
    });

    it("passes keepBranch=false when specified", async () => {
      const handler = getHandler("api:workspace:remove");
      await handler(
        {},
        { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME, keepBranch: false }
      );

      expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        false
      );
    });
  });

  describe("api:workspace:get", () => {
    it("delegates to api.workspaces.get", async () => {
      vi.mocked(mockApi.workspaces.get).mockResolvedValue(TEST_WORKSPACE);

      const handler = getHandler("api:workspace:get");
      const result = await handler(
        {},
        { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME }
      );

      expect(mockApi.workspaces.get).toHaveBeenCalledWith(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);
      expect(result).toEqual(TEST_WORKSPACE);
    });
  });

  describe("api:workspace:get-status", () => {
    it("delegates to api.workspaces.getStatus", async () => {
      const status = {
        isDirty: true,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 1, total: 1 } },
      };
      vi.mocked(mockApi.workspaces.getStatus).mockResolvedValue(status);

      const handler = getHandler("api:workspace:get-status");
      const result = await handler(
        {},
        { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME }
      );

      expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME
      );
      expect(result).toEqual(status);
    });
  });
});

describe("UI API handlers", () => {
  let mockApi: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    mockApi = createMockApi();
    registerApiHandlers(mockApi);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  describe("api:ui:select-folder", () => {
    it("delegates to api.ui.selectFolder", async () => {
      vi.mocked(mockApi.ui.selectFolder).mockResolvedValue("/selected/path");

      const handler = getHandler("api:ui:select-folder");
      const result = await handler({}, undefined);

      expect(mockApi.ui.selectFolder).toHaveBeenCalled();
      expect(result).toBe("/selected/path");
    });
  });

  describe("api:ui:get-active-workspace", () => {
    it("delegates to api.ui.getActiveWorkspace", async () => {
      const ref = {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: "/test/path",
      };
      vi.mocked(mockApi.ui.getActiveWorkspace).mockResolvedValue(ref);

      const handler = getHandler("api:ui:get-active-workspace");
      const result = await handler({}, undefined);

      expect(mockApi.ui.getActiveWorkspace).toHaveBeenCalled();
      expect(result).toEqual(ref);
    });
  });

  describe("api:ui:switch-workspace", () => {
    it("delegates to api.ui.switchWorkspace", async () => {
      const handler = getHandler("api:ui:switch-workspace");
      await handler({}, { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME });

      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        true // default focus
      );
    });

    it("passes focus=false when specified", async () => {
      const handler = getHandler("api:ui:switch-workspace");
      await handler(
        {},
        { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME, focus: false }
      );

      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        false
      );
    });
  });

  describe("api:ui:set-mode", () => {
    it("delegates to api.ui.setMode", async () => {
      const handler = getHandler("api:ui:set-mode");
      await handler({}, { mode: "shortcut" });

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("throws validation error for missing mode", async () => {
      const handler = getHandler("api:ui:set-mode");

      await expect(handler({}, {})).rejects.toThrow(/mode/i);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("throws validation error for invalid mode", async () => {
      const handler = getHandler("api:ui:set-mode");

      await expect(handler({}, { mode: "invalid" })).rejects.toThrow(/mode/i);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });
  });
});

// NOTE: Lifecycle API handlers tests are in lifecycle-handlers.test.ts.
// Lifecycle handlers are registered separately via registerLifecycleHandlers() in bootstrap().

describe("Error serialization", () => {
  let mockApi: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    mockApi = createMockApi();
    registerApiHandlers(mockApi);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  it("propagates API errors as Error instances", async () => {
    vi.mocked(mockApi.projects.open).mockRejectedValue(new Error("Project not found"));

    const handler = getHandler("api:project:open");

    await expect(handler({}, { path: "/test/path" })).rejects.toThrow("Project not found");
  });
});

describe("wireApiEvents", () => {
  let mockApi: ICodeHydraApi;
  let mockWebContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> };
  let eventHandlers: Map<string, (event: unknown) => void>;

  beforeEach(() => {
    mockHandle.mockClear();
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
    expect(mockApi.on).toHaveBeenCalledWith("ui:mode-changed", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith("setup:progress", expect.any(Function));
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

// =============================================================================
// Tests: Workspace Metadata IPC Handlers
// =============================================================================

describe("Workspace Metadata IPC Handlers", () => {
  let mockApi: ICodeHydraApi;
  let registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    mockHandle.mockClear();
    registeredHandlers = new Map();

    mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    });

    mockApi = createMockApi();
    registerApiHandlers(mockApi);
  });

  describe("api:workspace:set-metadata handler", () => {
    it("validates projectId format", async () => {
      const handler = registeredHandlers.get("api:workspace:set-metadata");
      expect(handler).toBeDefined();

      await expect(
        handler!(
          {},
          { projectId: "invalid", workspaceName: TEST_WORKSPACE_NAME, key: "note", value: "test" }
        )
      ).rejects.toThrow(/projectId/);
    });

    it("validates workspaceName format", async () => {
      const handler = registeredHandlers.get("api:workspace:set-metadata");
      expect(handler).toBeDefined();

      await expect(
        handler!(
          {},
          { projectId: TEST_PROJECT_ID, workspaceName: "-invalid", key: "note", value: "test" }
        )
      ).rejects.toThrow(/workspaceName/);
    });

    it("validates key format (rejects underscore)", async () => {
      const handler = registeredHandlers.get("api:workspace:set-metadata");
      expect(handler).toBeDefined();

      await expect(
        handler!(
          {},
          {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            key: "my_key",
            value: "test",
          }
        )
      ).rejects.toThrow(/key/);
    });

    it("calls api.workspaces.setMetadata", async () => {
      const handler = registeredHandlers.get("api:workspace:set-metadata");
      expect(handler).toBeDefined();

      await handler!(
        {},
        {
          projectId: TEST_PROJECT_ID,
          workspaceName: TEST_WORKSPACE_NAME,
          key: "note",
          value: "test value",
        }
      );

      expect(mockApi.workspaces.setMetadata).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        "note",
        "test value"
      );
    });
  });

  describe("api:workspace:get-metadata handler", () => {
    it("calls api.workspaces.getMetadata", async () => {
      vi.mocked(mockApi.workspaces.getMetadata).mockResolvedValue({ base: "main", note: "WIP" });

      const handler = registeredHandlers.get("api:workspace:get-metadata");
      expect(handler).toBeDefined();

      const result = await handler!(
        {},
        { projectId: TEST_PROJECT_ID, workspaceName: TEST_WORKSPACE_NAME }
      );

      expect(mockApi.workspaces.getMetadata).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME
      );
      expect(result).toEqual({ base: "main", note: "WIP" });
    });
  });
});
