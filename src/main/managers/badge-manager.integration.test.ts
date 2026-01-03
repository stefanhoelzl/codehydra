// @vitest-environment node

import { describe, it, expect, beforeEach } from "vitest";

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import {
  createBehavioralAppLayer,
  type BehavioralAppLayer,
} from "../../services/platform/app.test-utils";
import {
  createImageLayerMock,
  type MockImageLayer,
} from "../../services/platform/image.state-mock";
import type { WindowManager } from "./window-manager";
import type { ImageHandle } from "../../services/platform/types";
import type { AgentStatusManager, StatusChangedCallback } from "../../services/opencode";
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
  let appLayer: BehavioralAppLayer;
  let imageLayer: MockImageLayer;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createBehavioralAppLayer({ platform: "darwin" });
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("");
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("●");
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("◐");
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("◐");
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("");
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
      // Clear initial calls
      const initialCalls = appLayer._getState().dockSetBadgeCalls.length;

      // Change from empty to all busy
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 2 } }],
        ])
      );
      statusManager.triggerStatusChange();

      const newCalls = appLayer._getState().dockSetBadgeCalls.slice(initialCalls);
      expect(newCalls).toEqual(["●"]);
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("●");
      const initialCalls = appLayer._getState().dockSetBadgeCalls.length;

      // One workspace becomes idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );
      statusManager.triggerStatusChange();

      const newCalls = appLayer._getState().dockSetBadgeCalls.slice(initialCalls);
      expect(newCalls).toEqual(["◐"]);
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("◐");
      const initialCalls = appLayer._getState().dockSetBadgeCalls.length;

      // All workspaces become idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      const newCalls = appLayer._getState().dockSetBadgeCalls.slice(initialCalls);
      expect(newCalls).toEqual([""]);
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("●");
      const initialCalls = appLayer._getState().dockSetBadgeCalls.length;

      // Remove all workspaces
      statusManager.setStatuses(new Map());
      statusManager.triggerStatusChange();

      // Badge should be cleared
      const newCalls = appLayer._getState().dockSetBadgeCalls.slice(initialCalls);
      expect(newCalls).toEqual([""]);
    });
  });

  describe("Windows overlay icon", () => {
    it("generates image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createBehavioralAppLayer({ platform: "win32" });
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
      appLayer = createBehavioralAppLayer({ platform: "win32" });
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
      expect(appLayer._getState().dockSetBadgeCalls.at(-1)).toEqual("●");
      const initialCalls = appLayer._getState().dockSetBadgeCalls.length;

      // Disconnect
      badgeManager.disconnect();

      // Badge should be cleared
      const disconnectCalls = appLayer._getState().dockSetBadgeCalls.slice(initialCalls);
      expect(disconnectCalls).toEqual([""]);
      const afterDisconnectCalls = appLayer._getState().dockSetBadgeCalls.length;

      // Further status changes should not update badge
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 10, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      // No new calls should have been made
      expect(appLayer._getState().dockSetBadgeCalls.length).toBe(afterDisconnectCalls);
    });
  });
});
