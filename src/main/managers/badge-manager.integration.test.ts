// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Electron nativeImage
const mockNativeImage = vi.hoisted(() => {
  const createFromDataURL = vi.fn((url: string) => ({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,mock",
    _sourceUrl: url,
  }));

  return {
    createFromDataURL,
    getCalls: () => createFromDataURL.mock.calls as Array<[string]>,
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

      // Initial state should be 0 (no statuses)
      expect(appApi.dockSetBadgeCalls).toEqual([""]);
      appApi.dockSetBadgeCalls.length = 0;

      // Set up some statuses
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 2, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
        ])
      );

      // Trigger status change
      statusManager.triggerStatusChange();

      // Badge should show 2 (sum of idle counts)
      expect(appApi.dockSetBadgeCalls).toEqual(["2"]);
    });

    it("updates badge when multiple workspaces have idle agents", () => {
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

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      appApi.dockSetBadgeCalls.length = 0;

      // Set up multiple workspaces with idle agents
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 3, busy: 0 } }],
          ["/workspace2" as WorkspacePath, { status: "mixed", counts: { idle: 2, busy: 1 } }],
          ["/workspace3" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
        ])
      );

      statusManager.triggerStatusChange();

      // Badge should show 6 (3 + 2 + 1)
      expect(appApi.dockSetBadgeCalls).toEqual(["6"]);
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

      // Start with some idle agents
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 2, busy: 0 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("2");
      appApi.dockSetBadgeCalls.length = 0;

      // Remove all workspaces
      statusManager.setStatuses(new Map());
      statusManager.triggerStatusChange();

      // Badge should be cleared
      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("Badge shows large counts correctly", () => {
    it("shows counts like 15 and 42 correctly", () => {
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

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      appApi.dockSetBadgeCalls.length = 0;

      // Set up workspace with 15 idle agents
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 15, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();
      expect(appApi.dockSetBadgeCalls).toEqual(["15"]);
      appApi.dockSetBadgeCalls.length = 0;

      // Change to 42 idle agents
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 42, busy: 0 } }],
        ])
      );
      statusManager.triggerStatusChange();
      expect(appApi.dockSetBadgeCalls).toEqual(["42"]);
    });
  });

  describe("Multiple rapid status changes", () => {
    it("badge reflects final state after rapid changes", () => {
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

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      appApi.dockSetBadgeCalls.length = 0;

      // Rapid status changes
      for (let i = 1; i <= 10; i++) {
        statusManager.setStatuses(
          new Map<WorkspacePath, AggregatedAgentStatus>([
            ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: i, busy: 0 } }],
          ])
        );
        statusManager.triggerStatusChange();
      }

      // Final badge should be 10 (last value)
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("10");
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

      // Start with some idle agents
      statusManager.setStatuses(
        new Map<WorkspacePath, AggregatedAgentStatus>([
          ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 5, busy: 0 } }],
        ])
      );

      badgeManager.connectToStatusManager(statusManager as unknown as AgentStatusManager);
      expect(appApi.dockSetBadgeCalls.at(-1)).toEqual("5");
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
