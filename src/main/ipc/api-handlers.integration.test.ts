/**
 * Integration tests for API event wiring.
 *
 * These tests verify the full event flow from API through wireApiEvents
 * to the renderer (mocked via webContents.send).
 *
 * Tests cover:
 * - API → IPC → Renderer event flow
 * - Event forwarding for all event types
 * - Cleanup and error handling
 *
 * Note: IPC handler tests are now in the module tests (lifecycle, core, ui)
 * since IPC handlers are auto-registered by the ApiRegistry.
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
import { wireApiEvents } from "./api-handlers";

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
  metadata: { base: "main" },
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
      remove: vi.fn().mockResolvedValue({ started: true }),
      forceRemove: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(TEST_WORKSPACE),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
      getAgentSession: vi.fn().mockResolvedValue(null),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue({ base: "main", note: "test note" }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
      restartAgentServer: vi.fn().mockResolvedValue(3000),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue("ready"),
      setup: vi.fn().mockResolvedValue({ success: true }),
      startServices: vi.fn().mockResolvedValue({ success: true }),
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
