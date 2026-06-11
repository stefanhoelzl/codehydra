// @vitest-environment node
/**
 * Integration tests for BadgeModule and its internal BadgeManager.
 *
 * Tests verify:
 * - BadgeManager platform-specific badge rendering (darwin, win32, linux)
 * - BadgeManager image caching and disposal
 * - Full dispatcher pipeline: UpdateAgentStatusOperation -> domain event -> BadgeModule
 * - Workspace deletion clears stale badge entries
 * - Badge disposed on app shutdown
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "../intents/update-agent-status";
import { INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import {
  createDeleteEventOperation,
  createMinimalOperation,
} from "../intents/lib/operation.test-utils";
import { registerTestInfrastructure, updateStatusIntent } from "../intents/operations.test-utils";
import { BadgeManager, createBadgeModule } from "./badge-module";
import { createMockPlatformInfo } from "../boundaries/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createAppBoundaryMock, type MockAppBoundary } from "../boundaries/shell/app.state-mock";
import {
  createImageBoundaryMock,
  type MockImageBoundary,
} from "../boundaries/shell/image.state-mock";
import type { WindowManager } from "../boundaries/shell/window-manager";
import {
  createMockWindowManager,
  type MockWindowManager,
} from "../boundaries/shell/window-manager.test-utils";
import type { ImageHandle } from "../boundaries/shell/image-types";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// BadgeManager Direct Tests
// =============================================================================

describe("BadgeManager", () => {
  let appLayer: MockAppBoundary;
  let imageLayer: MockImageBoundary;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createAppBoundaryMock();
    imageLayer = createImageBoundaryMock();
    windowManager = createMockWindowManager();
  });

  describe("updateBadge (darwin)", () => {
    it("shows filled circle for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppBoundaryMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer).toHaveDockBadge("●");
    });

    it("shows half circle for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppBoundaryMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer).toHaveDockBadge("◐");
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppBoundaryMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("updateBadge (win32)", () => {
    it("generates image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.getOverlayIconCalls()).toHaveLength(1);
      expect(windowManager.getOverlayIconCalls()[0]?.description).toBe("All workspaces working");
    });

    it("generates image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.getOverlayIconCalls()).toHaveLength(1);
      expect(windowManager.getOverlayIconCalls()[0]?.description).toBe("Some workspaces ready");
    });

    it("clears overlay for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(imageLayer).toHaveImages([]);
      expect(windowManager.getOverlayIconCalls()).toHaveLength(1);
      expect(windowManager.getOverlayIconCalls()[0]?.image).toBeNull();
      expect(windowManager.getOverlayIconCalls()[0]?.description).toBe("");
    });

    it("creates image in shared ImageBoundary that WindowBoundary would use for lookup", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppBoundaryMock({ platform: "win32" });
      const sharedImageBoundary = createImageBoundaryMock();
      const mockWm = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        sharedImageBoundary,
        mockWm as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      const capturedImageHandle = mockWm.getOverlayIconCalls()[0]?.image ?? null;
      expect(capturedImageHandle).not.toBeNull();
      expect(sharedImageBoundary).toHaveImage(capturedImageHandle!.id, {
        isEmpty: false,
        size: { width: 16, height: 16 },
      });
    });
  });

  describe("updateBadge (linux)", () => {
    it("sets badge count to 1 for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppBoundaryMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer).toHaveBadgeCount(1);
    });

    it("sets badge count to 1 for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppBoundaryMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer).toHaveBadgeCount(1);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppBoundaryMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer).toHaveBadgeCount(0);
    });
  });

  describe("generateBadgeImage", () => {
    it("creates a 16x16 bitmap image for all-working", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(imageLayer).toHaveImage("image-1", { size: { width: 16, height: 16 } });
    });

    it("creates different images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
    });

    it("creates non-empty image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImage("image-1", { isEmpty: false });
    });

    it("creates non-empty image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(imageLayer).toHaveImage("image-1", { isEmpty: false });
    });
  });

  describe("image caching", () => {
    it("reuses cached images for same state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.getOverlayIconCalls()).toHaveLength(3);
    });

    it("creates new images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
    });
  });

  describe("dispose", () => {
    it("releases all cached images", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);

      manager.dispose();

      expect(imageLayer).toHaveImages([]);
    });

    it("clears overlay on dispose (win32)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      const callsAfterUpdate = windowManager.getOverlayIconCalls().length;
      expect(callsAfterUpdate).toBeGreaterThan(0);

      manager.dispose();

      const lastCall = windowManager.getOverlayIconCalls().at(-1);
      expect(lastCall?.image).toBeNull();
    });

    it("clears badge on dispose (darwin)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppBoundaryMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      expect(appLayer).toHaveDockBadge("●");

      manager.dispose();

      expect(appLayer).toHaveDockBadge("");
    });

    it("is idempotent - can be called multiple times safely", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      manager.dispose();
      manager.dispose();
      manager.dispose();

      expect(imageLayer).toHaveImages([]);
    });
  });
});

// =============================================================================
// Module Integration Tests (through Dispatcher)
// =============================================================================

/**
 * Mock WindowManager for module integration tests.
 */
function createSimpleMockWindowManager(): {
  setOverlayIcon: (image: ImageHandle | null, description: string) => void;
} {
  return {
    setOverlayIcon: () => {},
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface ModuleTestSetup {
  dispatcher: Dispatcher;
  appLayer: MockAppBoundary;
}

function createModuleTestSetup(): ModuleTestSetup {
  const platformInfo = createMockPlatformInfo({ platform: "darwin" });
  const appLayer = createAppBoundaryMock({ platform: "darwin" });
  const imageLayer = createImageBoundaryMock();
  const windowManager = createSimpleMockWindowManager();

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, createDeleteEventOperation());

  // Every workspace path resolves; workspaceName derives from the path basename.
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath) => ({
      projectPath: "/projects/test",
      workspaceName: workspacePath.split("/").pop() as WorkspaceName,
    }),
    projects: () => ({ projectId: "test-project" as ProjectId }),
  });

  const badgeModule = createBadgeModule({
    platformInfo,
    appLayer,
    imageLayer,
    windowManager: windowManager as unknown as WindowManager,
    logger: SILENT_LOGGER,
  });

  dispatcher.registerModule(badgeModule);

  return { dispatcher, appLayer };
}

// =============================================================================
// Module Tests
// =============================================================================

describe("BadgeModule Integration", () => {
  describe("app icon shows busy indicator when agent becomes busy (#4)", () => {
    it("shows all-working badge when single workspace becomes busy", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 2 } })
      );

      expect(appLayer).toHaveDockBadge("\u25CF"); // ●
    });

    it("clears badge when workspace becomes idle", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // First make busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Then become idle
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("mixed workspaces show mixed badge (#5)", () => {
    it("shows mixed badge when some workspaces idle, some busy", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 2, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );

      expect(appLayer).toHaveDockBadge("\u25D0"); // ◐
    });

    it("transitions from mixed to all-working when idle workspace becomes busy", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // Mixed state
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");

      // Workspace 1 becomes busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");
    });

    it("transitions from all-working to mixed when workspace becomes idle", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // All working
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Workspace 1 becomes idle
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");
    });
  });

  describe("deleting workspace clears stale badge entry (#6)", () => {
    it("clears badge when the only busy workspace is deleted", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // One busy workspace
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Dispatch a delete intent through the public API to trigger workspace:deleted event
      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspace/1",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);

      expect(appLayer).toHaveDockBadge("");
    });

    it("shows correct badge after busy workspace is deleted and idle workspace remains", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // Mixed state: one idle, one busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");

      // Dispatch a delete intent through the public API to trigger workspace:deleted event
      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspace/2",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);

      // Only idle workspace remains - should clear badge
      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("badge disposed on app shutdown (#7)", () => {
    it("clears badge when app shuts down", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();

      // Set a busy badge first
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Register shutdown operation and dispatch
      dispatcher.registerOperation(
        INTENT_APP_SHUTDOWN,
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );
      await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent);

      // Badge should be cleared by dispose()
      expect(appLayer).toHaveDockBadge("");
    });

    it("collect catches dispose error, dispatch still resolves", async () => {
      const { dispatcher } = createModuleTestSetup();

      // Spy on the prototype's dispose to make it throw for this test.
      // The module constructs its own BadgeManager internally, so we spy on the prototype.
      const disposeSpy = vi.spyOn(BadgeManager.prototype, "dispose").mockImplementation(function (
        this: BadgeManager
      ) {
        throw new Error("dispose failed");
      });

      dispatcher.registerOperation(
        INTENT_APP_SHUTDOWN,
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      // Should not throw - collect() catches the error
      await expect(
        dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent)
      ).resolves.not.toThrow();

      disposeSpy.mockRestore();
    });
  });
});
