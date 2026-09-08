// @vitest-environment node
/**
 * Integration tests for ErrorNotificationModule.
 *
 * Tests that workspace:create-failed events trigger error notifications
 * via NotificationManager with the correct config.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import type { WorkspaceCreateFailedEvent } from "../intents/open-workspace";
import { EVENT_APP_RESUME_FAILED, type AppResumeFailedEvent } from "../intents/app-resume";
import { createErrorNotificationModule } from "./error-notification-module";
import type { IntentModule } from "../intents/lib/module";
import {
  createMockNotificationManager,
  type MockNotificationManager,
} from "./presentation/notification-manager.state-mock";
import { projPath } from "../shared/test-fixtures";

// =============================================================================
// Tests
// =============================================================================

describe("ErrorNotificationModule", () => {
  let notificationManager: MockNotificationManager;
  let module: IntentModule;

  beforeEach(() => {
    notificationManager = createMockNotificationManager();
    module = createErrorNotificationModule({
      ui: notificationManager.ui,
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
        projectPath: projPath("/projects/test"),
        error: "Worktree already exists",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.notifications).toHaveLength(1);
    expect(notificationManager.lastNotification!.opened).toEqual({
      type: "error",
      title: 'Failed to create "my-workspace"',
      message: "Worktree already exists",
      dismissible: true,
    });
  });

  describe("a failure that repeats", () => {
    const failure = (workspaceName: string, error: string): WorkspaceCreateFailedEvent => ({
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: { workspaceName, projectPath: projPath("/projects/test"), error },
    });

    const emit = async (event: WorkspaceCreateFailedEvent): Promise<void> => {
      await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);
    };

    it("collapses into one card carrying the count", async () => {
      // What an orphaned auto-workspace item did: the same branch collision,
      // once a minute, for hours. 98 was a real figure from a bug report.
      for (let i = 0; i < 98; i++) {
        await emit(failure("pr/446/mcxn547-gpio", "Branch is already checked out"));
      }

      expect(notificationManager.notifications).toHaveLength(1);
      expect(notificationManager.lastNotification!.count).toBe(98);
    });

    it("gives a different error its own card", async () => {
      await emit(failure("pr/446/mcxn547-gpio", "Branch is already checked out"));
      await emit(failure("pr/446/mcxn547-gpio", "Invalid workspace name"));

      expect(notificationManager.notifications).toHaveLength(2);
    });

    it("gives a different workspace its own card", async () => {
      await emit(failure("pr/445/ifc-50-ksz9893", "Branch is already checked out"));
      await emit(failure("pr/446/mcxn547-gpio", "Branch is already checked out"));

      expect(notificationManager.notifications).toHaveLength(2);
    });

    it("goes away on one dismiss, not ninety-eight", async () => {
      for (let i = 0; i < 98; i++) {
        await emit(failure("pr/446/mcxn547-gpio", "Branch is already checked out"));
      }

      notificationManager.emitEvent(0, { actionId: "dismiss" });

      expect(notificationManager.notifications[0]!.closed).toBe(true);
    });
  });

  it("should close notification when user dismisses it", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "test-ws",
        projectPath: projPath("/projects/test"),
        error: "Some error",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.lastNotification!.closed).toBe(false);

    // Simulate user dismissing
    notificationManager.emitEvent(0, { actionId: "dismiss" });

    expect(notificationManager.lastNotification!.closed).toBe(true);
  });

  it("should skip notification for mcp source", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "mcp-workspace",
        projectPath: projPath("/projects/test"),
        error: "Some MCP error",
        source: "mcp",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.notifications).toHaveLength(0);
  });

  it("should show notification for non-mcp sources", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "plugin-workspace",
        projectPath: projPath("/projects/test"),
        error: "Some plugin error",
        source: "plugin-server",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.notifications).toHaveLength(1);
  });

  it("should show notification when source is undefined", async () => {
    const event: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "unknown-workspace",
        projectPath: projPath("/projects/test"),
        error: "Some error",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event);

    expect(notificationManager.notifications).toHaveLength(1);
  });

  it("should open error notification on app:resume-failed", async () => {
    const event: AppResumeFailedEvent = {
      type: EVENT_APP_RESUME_FAILED,
      payload: { error: "Port 25448 already in use" },
    };

    await module.events![EVENT_APP_RESUME_FAILED]!.handler(event);

    expect(notificationManager.notifications).toHaveLength(1);
    expect(notificationManager.lastNotification!.opened).toEqual({
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

    notificationManager.emitEvent(0, { actionId: "dismiss" });

    expect(notificationManager.lastNotification!.closed).toBe(true);
  });

  it("should handle multiple failures independently", async () => {
    const event1: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "ws-1",
        projectPath: projPath("/projects/test"),
        error: "Error 1",
      },
    };
    const event2: WorkspaceCreateFailedEvent = {
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: "ws-2",
        projectPath: projPath("/projects/test"),
        error: "Error 2",
      },
    };

    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event1);
    await module.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler(event2);

    expect(notificationManager.notifications).toHaveLength(2);
    expect(notificationManager.notifications[0]!.opened.title).toBe('Failed to create "ws-1"');
    expect(notificationManager.notifications[1]!.opened.title).toBe('Failed to create "ws-2"');
  });
});
