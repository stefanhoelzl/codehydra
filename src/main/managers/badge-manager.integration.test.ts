// @vitest-environment node

import { describe, it, expect, beforeEach } from "vitest";

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import { createAppLayerMock, type MockAppLayer } from "../../services/platform/app.state-mock";
import {
  createImageLayerMock,
  type MockImageLayer,
} from "../../services/platform/image.state-mock";
import type { WindowManager } from "./window-manager";
import type { ImageHandle } from "../../services/platform/types";
import type { AgentStatusManager, StatusChangedCallback } from "../../agents/opencode";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";

/**
 * Mock WindowManager for BadgeManager testing.
 */
interface MockWindowManager {
  setOverlayIcon: (image: ImageHandle | null, description: string) => void;
  setOverlayIconCalls: Array<{ image: ImageHandle | null; description: string }>;
}

function createMockWindowManager(): MockWindowManager {
  const setOverlayIconCalls: Array<{ image: ImageHandle | null; description: string }> = [];
  return {
    setOverlayIcon: (image: ImageHandle | null, description: string) => {
      setOverlayIconCalls.push({ image, description });
    },
    setOverlayIconCalls,
  };
}

/**
 * Creates a mock AgentStatusManager for integration testing.
 */
function createMockAgentStatusManager(): Pick<
  AgentStatusManager,
  "onStatusChanged" | "getAllStatuses"
> & {
  triggerStatusChange: () => void;
  setStatuses: (statuses: Map<WorkspacePath, AggregatedAgentStatus>) => void;
} {
  const listeners = new Set<StatusChangedCallback>();
  let statuses = new Map<WorkspacePath, AggregatedAgentStatus>();

  return {
    onStatusChanged: (callback: StatusChangedCallback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getAllStatuses: () => new Map(statuses),
    triggerStatusChange: () => {
      // Trigger all listeners with a dummy path (path doesn't matter for badge calculation)
      for (const listener of listeners) {
        listener("/dummy" as WorkspacePath, { status: "none", counts: { idle: 0, busy: 0 } });
      }
    },
    setStatuses: (newStatuses: Map<WorkspacePath, AggregatedAgentStatus>) => {
      statuses = new Map(newStatuses);
    },
  };
}

describe("BadgeManager Integration", () => {
  let appLayer: MockAppLayer;
  let imageLayer: MockImageLayer;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createAppLayerMock({ platform: "darwin" });
    imageLayer = createImageLayerMock();
    windowManager = createMockWindowManager();
  });

  describe("Badge state aggregation", () => {
    it("shows no badge when all workspaces are idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up all idle workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 2, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Badge should be empty (all ready = no badge)
      expect(appLayer).toHaveDockBadge("");
    });

    it("shows red badge when all workspaces are busy", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up all busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 2 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Badge should show filled circle (all working)
      expect(appLayer).toHaveDockBadge("●");
    });

    it("shows mixed badge when some workspaces are idle and some busy", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up mixed workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 2, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Badge should show half circle (mixed)
      expect(appLayer).toHaveDockBadge("◐");
    });

    it("treats workspace with mixed status as working", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up: one idle workspace, one with mixed status
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 2, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "mixed", counts: { idle: 1, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Badge should show half circle (mixed, because "mixed" workspace counts as working)
      expect(appLayer).toHaveDockBadge("◐");
    });

    it("ignores workspaces with none status", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up: only "none" status workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "none", counts: { idle: 0, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "none", counts: { idle: 0, busy: 0 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Badge should be empty (no workspaces with agents)
      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("Badge updates on status change", () => {
    it("updates badge when workspace status changes", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Connect to status manager
      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      // Change from empty to all busy
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 2 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appLayer).toHaveDockBadge("●");
    });

    it("transitions from all-working to mixed when workspace becomes idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Start with all busy
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appLayer).toHaveDockBadge("●");

      // One workspace becomes idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appLayer).toHaveDockBadge("◐");
    });

    it("transitions from mixed to none when all workspaces become idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Start with mixed
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appLayer).toHaveDockBadge("◐");

      // All workspaces become idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("Badge clears on last workspace removed", () => {
    it("clears badge when all workspaces are removed", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Start with busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appLayer).toHaveDockBadge("●");

      // Remove all workspaces
      statusManager.setStatuses(new Map());
      statusManager.triggerStatusChange();

      // Badge should be cleared
      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("Windows overlay icon", () => {
    it("creates image in same ImageLayer that WindowLayer would use for lookup", () => {
      // This test verifies the architectural constraint that BadgeManager and WindowLayer
      // must share the same ImageLayer instance. If separate instances are used,
      // the ImageHandle created by BadgeManager won't be found when WindowLayer
      // calls getNativeImage(), causing the overlay to not display.
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });
      const sharedImageLayer = createImageLayerMock();

      // Track the ImageHandle passed to setOverlayIcon
      let capturedImageHandle: ImageHandle | null = null;
      const mockWindowManager = {
        setOverlayIcon: (image: ImageHandle | null) => {
          capturedImageHandle = image;
        },
      };

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        sharedImageLayer, // Using the shared instance
        mockWindowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("all-working");

      // The image handle must exist in the shared ImageLayer and be valid
      expect(capturedImageHandle).not.toBeNull();
      expect(sharedImageLayer).toHaveImage(capturedImageHandle!.id, {
        isEmpty: false,
        size: { width: 16, height: 16 },
      });
    });

    it("generates image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up mixed workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("Some workspaces ready");
    });

    it("generates image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Set up all busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("All workspaces working");
    });
  });

  describe("disconnect", () => {
    it("clears badge and stops updates on disconnect", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Start with busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appLayer).toHaveDockBadge("●");

      // Disconnect
      badgeManager.disconnect();

      // Badge should be cleared
      expect(appLayer).toHaveDockBadge("");

      // Take a snapshot after disconnect
      const afterDisconnect = appLayer.$.snapshot();

      // Further status changes should not update badge
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 10, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      // State should be unchanged after status change
      expect(appLayer).toBeUnchanged(afterDisconnect);
    });
  });
});
