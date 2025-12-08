/**
 * Tests for IPC channel definitions.
 */

import { describe, it, expect } from "vitest";
import { IpcChannels } from "./ipc";

describe("IpcChannels", () => {
  describe("SHORTCUT_ENABLE", () => {
    it("exists with correct channel name", () => {
      expect(IpcChannels.SHORTCUT_ENABLE).toBe("shortcut:enable");
    });
  });

  describe("SHORTCUT_DISABLE", () => {
    it("exists with correct channel name", () => {
      expect(IpcChannels.SHORTCUT_DISABLE).toBe("shortcut:disable");
    });
  });

  describe("Agent status channels", () => {
    it("has AGENT_GET_STATUS channel", () => {
      expect(IpcChannels.AGENT_GET_STATUS).toBe("agent:get-status");
    });

    it("has AGENT_GET_ALL_STATUSES channel", () => {
      expect(IpcChannels.AGENT_GET_ALL_STATUSES).toBe("agent:get-all-statuses");
    });

    it("has AGENT_REFRESH channel", () => {
      expect(IpcChannels.AGENT_REFRESH).toBe("agent:refresh");
    });

    it("has AGENT_STATUS_CHANGED event channel", () => {
      expect(IpcChannels.AGENT_STATUS_CHANGED).toBe("agent:status-changed");
    });
  });
});
