/**
 * Tests for IPC channel definitions.
 */

import { describe, it, expect } from "vitest";
import { ApiIpcChannels, type UIMode } from "./ipc";

describe("UIMode types", () => {
  it("UIMode type accepts 'workspace' value", () => {
    // Type-level test: verify UIMode accepts valid values
    const mode: UIMode = "workspace";
    expect(mode).toBe("workspace");
  });

  it("UIMode type accepts 'dialog' value", () => {
    const mode: UIMode = "dialog";
    expect(mode).toBe("dialog");
  });

  it("UIMode type accepts 'shortcut' value", () => {
    const mode: UIMode = "shortcut";
    expect(mode).toBe("shortcut");
  });

  it("UIMode type accepts 'hover' value", () => {
    const mode: UIMode = "hover";
    expect(mode).toBe("hover");
  });
});

describe("ApiIpcChannels (v2 API)", () => {
  describe("Lifecycle commands", () => {
    it("has LIFECYCLE_QUIT channel (the only remaining command invoke)", () => {
      expect(ApiIpcChannels.LIFECYCLE_QUIT).toBe("api:lifecycle:quit");
    });
  });

  describe("Events", () => {
    it("has PROJECT_OPENED event channel", () => {
      expect(ApiIpcChannels.PROJECT_OPENED).toBe("api:project:opened");
    });

    it("has WORKSPACE_STATUS_CHANGED event channel", () => {
      expect(ApiIpcChannels.WORKSPACE_STATUS_CHANGED).toBe("api:workspace:status-changed");
    });
  });
});
