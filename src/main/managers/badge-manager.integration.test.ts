// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Electron nativeImage
const mockNativeImage = vi.hoisted(() => {
  const createFromBitmap = vi.fn((buffer: Buffer, options: { width: number; height: number }) => ({
    isEmpty: () => false,
    getSize: () => ({ width: options.width, height: options.height }),
    toPNG: () => Buffer.from("mock-png"),
    _buffer: buffer,
    _options: options,
  }));

  return {
    createFromBitmap,
    getCalls: () =>
      createFromBitmap.mock.calls as Array<[Buffer, { width: number; height: number }]>,
  };
});

vi.mock("electron", () => ({
  nativeImage: mockNativeImage,
}));

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { createSilentLogger } from "../../services/logging";
import {
  createMockElectronAppApi,
  createMockWindowManagerForBadge as createMockWindowManager,
} from "./badge-manager.test-utils";
import type { WindowManager } from "./window-manager";
import type { AgentStatusManager, StatusChangedCallback } from "../../services/opencode";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Badge state aggregation", () => {
    it("shows no badge when all workspaces are idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
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
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("");
    });

    it("shows red badge when all workspaces are busy", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
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
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("●");
    });

    it("shows mixed badge when some workspaces are idle and some busy", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
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
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("◐");
    });

    it("treats workspace with mixed status as working", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
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
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("◐");
    });

    it("ignores workspaces with none status", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
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
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("");
    });
  });

  describe("Badge updates on status change", () => {
    it("updates badge when workspace status changes", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Connect to status manager
      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      appApi.dockSetBadgeCalls.length = 0;

      // Change from empty to all busy
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 2 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appApi.dockSetBadgeCalls).toEqual(["●"]);
    });

    it("transitions from all-working to mixed when workspace becomes idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Start with all busy
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("●");
      appApi.dockSetBadgeCalls.length = 0;

      // One workspace becomes idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appApi.dockSetBadgeCalls).toEqual(["◐"]);
    });

    it("transitions from mixed to none when all workspaces become idle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Start with mixed
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("◐");
      appApi.dockSetBadgeCalls.length = 0;

      // All workspaces become idle
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("Badge clears on last workspace removed", () => {
    it("clears badge when all workspaces are removed", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Start with busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("●");
      appApi.dockSetBadgeCalls.length = 0;

      // Remove all workspaces
      statusManager.setStatuses(new Map());
      statusManager.triggerStatusChange();

      // Badge should be cleared
      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("Windows overlay icon", () => {
    it("generates split circle for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Set up mixed workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("Some workspaces ready");
    });

    it("generates red circle for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Set up all busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("All workspaces working");
    });
  });

  describe("disconnect", () => {
    it("clears badge and stops updates on disconnect", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();
      const statusManager = createMockAgentStatusManager();

      const badgeManager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Start with busy workspaces
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("●");
      appApi.dockSetBadgeCalls.length = 0;

      // Disconnect
      badgeManager.disconnect();

      // Badge should be cleared
      expect(appApi.dockSetBadgeCalls).toEqual([""]);
      appApi.dockSetBadgeCalls.length = 0;

      // Further status changes should not update badge
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 10, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();

      expect(appApi.dockSetBadgeCalls).toHaveLength(0);
    });
  });
});
