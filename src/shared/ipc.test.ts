/**
 * Tests for IPC channel definitions.
 */

import { describe, it, expect } from "vitest";
import { ApiIpcChannels, type UIMode, type UIModeChangedEvent } from "./ipc";

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

  it("UIModeChangedEvent has mode and previousMode", () => {
    const event: UIModeChangedEvent = {
      mode: "shortcut",
      previousMode: "workspace",
    };
    expect(event.mode).toBe("shortcut");
    expect(event.previousMode).toBe("workspace");
  });
});

describe("ApiIpcChannels (v2 API)", () => {
  describe("Project commands", () => {
    it("has PROJECT_OPEN channel", () => {
      expect(ApiIpcChannels.PROJECT_OPEN).toBe("api:project:open");
    });
  });

  describe("Workspace commands", () => {
    it("has WORKSPACE_HIBERNATE channel", () => {
      expect(ApiIpcChannels.WORKSPACE_HIBERNATE).toBe("api:workspace:hibernate");
    });
  });

  describe("Events", () => {
    it("has PROJECT_OPENED event channel", () => {
      expect(ApiIpcChannels.PROJECT_OPENED).toBe("api:project:opened");
    });

    it("has WORKSPACE_STATUS_CHANGED event channel", () => {
      expect(ApiIpcChannels.WORKSPACE_STATUS_CHANGED).toBe("api:workspace:status-changed");
    });

    it("has UI_MODE_CHANGED event channel", () => {
      expect(ApiIpcChannels.UI_MODE_CHANGED).toBe("api:ui:mode-changed");
    });

    it("has SHORTCUT_KEY event channel", () => {
      expect(ApiIpcChannels.SHORTCUT_KEY).toBe("api:shortcut:key");
    });

    it("has UI_SET_MODE command channel", () => {
      expect(ApiIpcChannels.UI_SET_MODE).toBe("api:ui:set-mode");
    });
  });
});
