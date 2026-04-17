// @vitest-environment node
/**
 * Integration tests for ErrorNotificationModule.
 *
 * Tests that workspace:create-failed events trigger error notifications
 * via NotificationManager with the correct config.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import type { WorkspaceCreateFailedEvent } from "../intents/open-workspace";
import { EVENT_APP_RESUME_FAILED, type AppResumeFailedEvent } from "../intents/app-resume";
import { createErrorNotificationModule } from "./error-notification-module";
import type { IntentModule } from "../intents/lib/module";
import type { NotificationManager } from "./notification-manager";
import type { NotificationConfig, NotificationUserEvent } from "../shared/notification-types";

// =============================================================================
// Mock NotificationManager
// =============================================================================

interface MockHandle {
  id: string;
  config: NotificationConfig;
  closed: boolean;
  eventListeners: Set<(event: NotificationUserEvent) => void>;
  emitEvent(event: NotificationUserEvent): void;
}

interface MockNotificationManager {
  handles: MockHandle[];
  lastHandle: MockHandle | null;
  open: ReturnType<typeof vi.fn>;
  routeEvent: () => void;
}

function createMockNotificationManager(): MockNotificationManager {
  const handles: MockHandle[] = [];
  return {
    handles,
    get lastHandle() {
      return handles[handles.length - 1] ?? null;
    },
    open: vi.fn((config: NotificationConfig) => {
      const listeners = new Set<(event: NotificationUserEvent) => void>();
      const handle: MockHandle = {
        id: `ntf-test-${handles.length + 1}`,
        config,
        closed: false,
        eventListeners: listeners,
        emitEvent(event) {
          for (const l of listeners) l(event);
        },
      };
      handles.push(handle);
      return {
        id: handle.id,
        update: vi.fn((newConfig: NotificationConfig) => {
          handle.config = newConfig;
        }),
        close: vi.fn(() => {
          handle.closed = true;
        }),
        onEvent: vi.fn((handler: (event: NotificationUserEvent) => void): (() => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        }),
        nextEvent: vi.fn(),
        closed: Promise.resolve(),
      };
    }),
    routeEvent: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ErrorNotificationModule", () => {
  let notificationManager: MockNotificationManager;
  let module: IntentModule;

  beforeEach(() => {
    notificationManager = createMockNotificationManager();
    module = createErrorNotificationModule({
      notificationManager: notificationManager as unknown as NotificationManager,
    });
  });

  it("should have name 'error-notification'", () => {
    expect(module.name).toBe("error-notification");
  });

  it("should open error notification on workspace:create-failed", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "my-workspace",
        projectPath: "/projects/test",
        error: "Worktree already exists",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.open).toHaveBeenCalledOnce();
    expect(notificationManager.open).toHaveBeenCalledWith({
      type: "error",
      title: 'Failed to create "my-workspace"',
      message: "Worktree already exists",
      dismissible: true,
    });
  });

  it("should close notification when user dismisses it", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "test-ws",
        projectPath: "/projects/test",
        error: "Some error",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    const handle = notificationManager.lastHandle!;
    expect(handle.closed).toBe(false);

    // Simulate user dismissing
    handle.emitEvent({ notificationId: handle.id, actionId: "dismiss" });

    const returnedHandle = notificationManager.open.mock.results[0]!.value;
    expect(returnedHandle.close).toHaveBeenCalledOnce();
  });

  it("should skip notification for mcp source", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "mcp-workspace",
        projectPath: "/projects/test",
        error: "Some MCP error",
        source: "mcp",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.open).not.toHaveBeenCalled();
  });

  it("should show notification for non-mcp sources", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "plugin-workspace",
        projectPath: "/projects/test",
        error: "Some plugin error",
        source: "plugin-server",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.open).toHaveBeenCalledOnce();
  });

  it("should show notification when source is undefined", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "unknown-workspace",
        projectPath: "/projects/test",
        error: "Some error",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.open).toHaveBeenCalledOnce();
  });

  it("should open error notification on app:resume-failed", async () => {
    const event: AppResumeFailedEvent = {
      type: EVENT_APP_RESUME_FAILED,
      payload: { error: "Port 25448 already in use" },
    };

    await module.events![EVENT_APP_RESUME_FAILED]!.handler(event);

    expect(notificationManager.open).toHaveBeenCalledOnce();
    expect(notificationManager.open).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to recover after system resume",
      message: "Port 25448 already in use",
      dismissible: true,
    });
  });

  it("should close resume-failed notification on user dismiss", async () => {
    const event: AppResumeFailedEvent = {
      type: EVENT_APP_RESUME_FAILED,
      payload: { error: "health check timed out" },
    };

    await module.events![EVENT_APP_RESUME_FAILED]!.handler(event);

    const handle = notificationManager.lastHandle!;
    handle.emitEvent({ notificationId: handle.id, actionId: "dismiss" });

    const returnedHandle = notificationManager.open.mock.results[0]!.value;
    expect(returnedHandle.close).toHaveBeenCalledOnce();
  });

  it("should handle multiple failures independently", async () => {
    const event1: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "ws-1",
        projectPath: "/projects/test",
        error: "Error 1",
      },
    };
    const event2: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "ws-2",
        projectPath: "/projects/test",
        error: "Error 2",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event1);
    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event2);

    expect(notificationManager.open).toHaveBeenCalledTimes(2);
    expect(notificationManager.handles).toHaveLength(2);
    expect(notificationManager.handles[0]!.config.title).toBe('Failed to create "ws-1"');
    expect(notificationManager.handles[1]!.config.title).toBe('Failed to create "ws-2"');
  });
});
