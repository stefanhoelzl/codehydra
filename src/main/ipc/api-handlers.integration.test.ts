/**
 * Integration tests for API-based IPC handlers.
 *
 * These tests verify the full event flow from API through IPC handlers
 * to the renderer (mocked via webContents.send).
 *
 * Tests cover:
 * - API → IPC → Renderer event flow
 * - Handler + API integration
 * - Error handling across IPC boundaries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ICodeHydraApi, ApiEvents } from "../../shared/api/interfaces";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
} from "../../shared/api/types";

// =============================================================================
// Mock Setup
// =============================================================================

const mockHandle = vi.fn();
const mockRemoveHandler = vi.fn();

// Mock Electron
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockHandle(...args),
    removeHandler: (...args: unknown[]) => mockRemoveHandler(...args),
  },
}));

// Import after mock
import { registerApiHandlers, wireApiEvents } from "./api-handlers";

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_PATH = "/home/user/projects/my-project";
const TEST_WORKSPACE_PATH = "/home/user/.worktrees/feature-branch";

const TEST_PROJECT: Project = {
  id: TEST_PROJECT_ID,
  name: "my-project",
  path: TEST_PATH,
  workspaces: [],
};

const TEST_WORKSPACE: Workspace = {
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  branch: "feature-branch",
  path: TEST_WORKSPACE_PATH,
};

const TEST_WORKSPACE_REF: WorkspaceRef = {
  projectId: TEST_PROJECT_ID,
  workspaceName: TEST_WORKSPACE_NAME,
  path: TEST_WORKSPACE_PATH,
};

// =============================================================================
// Mock API Factory
// =============================================================================

type EventHandler<E extends keyof ApiEvents> = ApiEvents[E];

function createMockApiWithEvents(): {
  api: ICodeHydraApi;
  eventHandlers: Map<keyof ApiEvents, Set<EventHandler<keyof ApiEvents>>>;
  emitEvent: <E extends keyof ApiEvents>(event: E, ...args: Parameters<ApiEvents[E]>) => void;
} {
  const eventHandlers = new Map<keyof ApiEvents, Set<EventHandler<keyof ApiEvents>>>();

  const api: ICodeHydraApi = {
    projects: {
      open: vi.fn().mockResolvedValue(TEST_PROJECT),
      close: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([TEST_PROJECT]),
      get: vi.fn().mockResolvedValue(TEST_PROJECT),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn().mockResolvedValue(TEST_WORKSPACE),
      remove: vi.fn().mockResolvedValue({ branchDeleted: false }),
      get: vi.fn().mockResolvedValue(TEST_WORKSPACE),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
      setDialogMode: vi.fn().mockResolvedValue(undefined),
      focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue("ready"),
      setup: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue(undefined),
    },
    on: vi.fn().mockImplementation(<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler as EventHandler<keyof ApiEvents>);
      return () => {
        eventHandlers.get(event)?.delete(handler as EventHandler<keyof ApiEvents>);
      };
    }),
    dispose: vi.fn(),
  };

  const emitEvent = <E extends keyof ApiEvents>(
    event: E,
    ...args: Parameters<ApiEvents[E]>
  ): void => {
    const handlers = eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as (...args: Parameters<ApiEvents[E]>) => void)(...args);
      }
    }
  };

  return { api, eventHandlers, emitEvent };
}

// =============================================================================
// Mock WebContents Factory
// =============================================================================

function createMockWebContents(): {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe("API → IPC → Renderer event flow", () => {
  let api: ICodeHydraApi;
  let emitEvent: <E extends keyof ApiEvents>(event: E, ...args: Parameters<ApiEvents[E]>) => void;
  let mockWebContents: ReturnType<typeof createMockWebContents>;
  let cleanup: () => void;

  beforeEach(() => {
    mockHandle.mockClear();
    mockRemoveHandler.mockClear();

    const mock = createMockApiWithEvents();
    api = mock.api;
    emitEvent = mock.emitEvent;

    mockWebContents = createMockWebContents();
    cleanup = wireApiEvents(api, () => mockWebContents as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("should forward project:opened event to renderer", () => {
    emitEvent("project:opened", { project: TEST_PROJECT });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:project:opened", {
      project: TEST_PROJECT,
    });
  });

  it("should forward project:closed event to renderer", () => {
    emitEvent("project:closed", { projectId: TEST_PROJECT_ID });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:project:closed", {
      projectId: TEST_PROJECT_ID,
    });
  });

  it("should forward project:bases-updated event to renderer", () => {
    const bases = [{ name: "main", isRemote: false }];
    emitEvent("project:bases-updated", { projectId: TEST_PROJECT_ID, bases });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:project:bases-updated", {
      projectId: TEST_PROJECT_ID,
      bases,
    });
  });

  it("should forward workspace:created event to renderer", () => {
    emitEvent("workspace:created", { projectId: TEST_PROJECT_ID, workspace: TEST_WORKSPACE });

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:created", {
      projectId: TEST_PROJECT_ID,
      workspace: TEST_WORKSPACE,
    });
  });

  it("should forward workspace:removed event to renderer", () => {
    emitEvent("workspace:removed", TEST_WORKSPACE_REF);

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:removed", TEST_WORKSPACE_REF);
  });

  it("should forward workspace:switched event to renderer", () => {
    emitEvent("workspace:switched", TEST_WORKSPACE_REF);

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:switched", TEST_WORKSPACE_REF);
  });

  it("should forward workspace:switched with null to renderer", () => {
    emitEvent("workspace:switched", null);

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:switched", null);
  });

  it("should forward workspace:status-changed event to renderer", () => {
    const event = {
      ...TEST_WORKSPACE_REF,
      status: {
        isDirty: true,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 1, total: 1 } },
      },
    };
    emitEvent("workspace:status-changed", event);

    expect(mockWebContents.send).toHaveBeenCalledWith("api:workspace:status-changed", event);
  });

  it("should forward setup:progress event to renderer", () => {
    const progress = { step: "extensions" as const, message: "Installing extensions..." };
    emitEvent("setup:progress", progress);

    expect(mockWebContents.send).toHaveBeenCalledWith("api:setup:progress", progress);
  });

  it("should not forward events after cleanup", () => {
    cleanup();

    emitEvent("project:opened", { project: TEST_PROJECT });

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it("should not send to destroyed webContents", () => {
    mockWebContents.isDestroyed.mockReturnValue(true);

    emitEvent("project:opened", { project: TEST_PROJECT });

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });
});

describe("Handler + API integration", () => {
  let api: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    const mock = createMockApiWithEvents();
    api = mock.api;
    registerApiHandlers(api);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  describe("Project operations", () => {
    it("should call API and return result for project open", async () => {
      const handler = getHandler("api:project:open");
      const result = await handler({}, { path: TEST_PATH });

      expect(api.projects.open).toHaveBeenCalledWith(TEST_PATH);
      expect(result).toEqual(TEST_PROJECT);
    });

    it("should call API and return result for project list", async () => {
      const handler = getHandler("api:project:list");
      const result = await handler({}, undefined);

      expect(api.projects.list).toHaveBeenCalled();
      expect(result).toEqual([TEST_PROJECT]);
    });

    it("should call API and return result for project close", async () => {
      const handler = getHandler("api:project:close");
      await handler({}, { projectId: TEST_PROJECT_ID });

      expect(api.projects.close).toHaveBeenCalledWith(TEST_PROJECT_ID);
    });

    it("should call API and return result for fetchBases", async () => {
      const bases = [{ name: "main", isRemote: false }];
      vi.mocked(api.projects.fetchBases).mockResolvedValue({ bases });

      const handler = getHandler("api:project:fetch-bases");
      const result = await handler({}, { projectId: TEST_PROJECT_ID });

      expect(api.projects.fetchBases).toHaveBeenCalledWith(TEST_PROJECT_ID);
      expect(result).toEqual({ bases });
    });
  });

  describe("Workspace operations", () => {
    it("should call API and return result for workspace create", async () => {
      const handler = getHandler("api:workspace:create");
      const result = await handler(
        {},
        {
          projectId: TEST_PROJECT_ID,
          name: "feature-branch",
          base: "main",
        }
      );

      expect(api.workspaces.create).toHaveBeenCalledWith(TEST_PROJECT_ID, "feature-branch", "main");
      expect(result).toEqual(TEST_WORKSPACE);
    });

    it("should call API and return result for workspace remove", async () => {
      vi.mocked(api.workspaces.remove).mockResolvedValue({ branchDeleted: true });

      const handler = getHandler("api:workspace:remove");
      const result = await handler(
        {},
        {
          projectId: TEST_PROJECT_ID,
          workspaceName: TEST_WORKSPACE_NAME,
          keepBranch: false,
        }
      );

      expect(api.workspaces.remove).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        false
      );
      expect(result).toEqual({ branchDeleted: true });
    });

    it("should call API and return result for workspace getStatus", async () => {
      const status = {
        isDirty: true,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 1, total: 1 } },
      };
      vi.mocked(api.workspaces.getStatus).mockResolvedValue(status);

      const handler = getHandler("api:workspace:get-status");
      const result = await handler(
        {},
        {
          projectId: TEST_PROJECT_ID,
          workspaceName: TEST_WORKSPACE_NAME,
        }
      );

      expect(api.workspaces.getStatus).toHaveBeenCalledWith(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);
      expect(result).toEqual(status);
    });
  });

  describe("UI operations", () => {
    it("should call API and return result for selectFolder", async () => {
      vi.mocked(api.ui.selectFolder).mockResolvedValue("/selected/path");

      const handler = getHandler("api:ui:select-folder");
      const result = await handler({}, undefined);

      expect(api.ui.selectFolder).toHaveBeenCalled();
      expect(result).toBe("/selected/path");
    });

    it("should call API and return result for getActiveWorkspace", async () => {
      vi.mocked(api.ui.getActiveWorkspace).mockResolvedValue(TEST_WORKSPACE_REF);

      const handler = getHandler("api:ui:get-active-workspace");
      const result = await handler({}, undefined);

      expect(api.ui.getActiveWorkspace).toHaveBeenCalled();
      expect(result).toEqual(TEST_WORKSPACE_REF);
    });

    it("should call API for switchWorkspace", async () => {
      const handler = getHandler("api:ui:switch-workspace");
      await handler(
        {},
        {
          projectId: TEST_PROJECT_ID,
          workspaceName: TEST_WORKSPACE_NAME,
          focus: false,
        }
      );

      expect(api.ui.switchWorkspace).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        false
      );
    });
  });

  describe("Lifecycle operations", () => {
    it("should call API and return result for getState", async () => {
      const handler = getHandler("api:lifecycle:get-state");
      const result = await handler({}, undefined);

      expect(api.lifecycle.getState).toHaveBeenCalled();
      expect(result).toBe("ready");
    });

    it("should call API and return result for setup", async () => {
      const handler = getHandler("api:lifecycle:setup");
      const result = await handler({}, undefined);

      expect(api.lifecycle.setup).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("should return setup failure result", async () => {
      vi.mocked(api.lifecycle.setup).mockResolvedValue({
        success: false,
        message: "Extension install failed",
        code: "EXTENSION_INSTALL_FAILED",
      });

      const handler = getHandler("api:lifecycle:setup");
      const result = await handler({}, undefined);

      expect(result).toEqual({
        success: false,
        message: "Extension install failed",
        code: "EXTENSION_INSTALL_FAILED",
      });
    });
  });
});

describe("Error handling across IPC boundaries", () => {
  let api: ICodeHydraApi;

  beforeEach(() => {
    mockHandle.mockClear();
    const mock = createMockApiWithEvents();
    api = mock.api;
    registerApiHandlers(api);
  });

  function getHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    const call = mockHandle.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not found`);
    return call[1];
  }

  it("should propagate API errors through handlers", async () => {
    vi.mocked(api.projects.open).mockRejectedValue(new Error("Not a git repository"));

    const handler = getHandler("api:project:open");

    await expect(handler({}, { path: "/invalid/path" })).rejects.toThrow("Not a git repository");
  });

  it("should propagate workspace errors through handlers", async () => {
    vi.mocked(api.workspaces.create).mockRejectedValue(new Error("Branch already exists"));

    const handler = getHandler("api:workspace:create");

    await expect(
      handler({}, { projectId: TEST_PROJECT_ID, name: "feature", base: "main" })
    ).rejects.toThrow("Branch already exists");
  });

  it("should throw validation error for invalid input before calling API", async () => {
    const handler = getHandler("api:project:open");

    await expect(handler({}, { path: "relative/path" })).rejects.toThrow(/absolute/i);
    expect(api.projects.open).not.toHaveBeenCalled();
  });

  it("should throw validation error for missing required fields", async () => {
    const handler = getHandler("api:workspace:create");

    await expect(handler({}, { projectId: TEST_PROJECT_ID, base: "main" })).rejects.toThrow(
      /name/i
    );
    expect(api.workspaces.create).not.toHaveBeenCalled();
  });

  it("should throw validation error for invalid ProjectId format", async () => {
    const handler = getHandler("api:project:close");

    await expect(handler({}, { projectId: "invalid" })).rejects.toThrow(/projectId/i);
    expect(api.projects.close).not.toHaveBeenCalled();
  });

  it("should throw validation error for invalid WorkspaceName format", async () => {
    const handler = getHandler("api:workspace:remove");

    await expect(handler({}, { projectId: TEST_PROJECT_ID, workspaceName: "" })).rejects.toThrow(
      /workspaceName/i
    );
    expect(api.workspaces.remove).not.toHaveBeenCalled();
  });
});
