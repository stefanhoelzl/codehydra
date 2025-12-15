/**
 * Tests for IPC channel definitions.
 */

import { describe, it, expect } from "vitest";
import {
  IpcChannels,
  ApiIpcChannels,
  type SetupReadyResponse,
  type UIMode,
  type UIModeChangedEvent,
} from "./ipc";

describe("IpcChannels (legacy)", () => {
  describe("Setup channels", () => {
    it("has SETUP_READY channel", () => {
      expect(IpcChannels.SETUP_READY).toBe("setup:ready");
    });

    it("has SETUP_RETRY channel", () => {
      expect(IpcChannels.SETUP_RETRY).toBe("setup:retry");
    });

    it("has SETUP_QUIT channel", () => {
      expect(IpcChannels.SETUP_QUIT).toBe("setup:quit");
    });

    it("has SETUP_PROGRESS channel", () => {
      expect(IpcChannels.SETUP_PROGRESS).toBe("setup:progress");
    });

    it("has SETUP_COMPLETE channel", () => {
      expect(IpcChannels.SETUP_COMPLETE).toBe("setup:complete");
    });

    it("has SETUP_ERROR channel", () => {
      expect(IpcChannels.SETUP_ERROR).toBe("setup:error");
    });

    it("SetupReadyResponse type has ready boolean", () => {
      // Type-level test: verify SetupReadyResponse has the expected shape
      const response: SetupReadyResponse = { ready: true };
      expect(response.ready).toBe(true);

      const response2: SetupReadyResponse = { ready: false };
      expect(response2.ready).toBe(false);
    });
  });
});

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

    it("has PROJECT_LIST channel", () => {
      expect(ApiIpcChannels.PROJECT_LIST).toBe("api:project:list");
    });
  });

  describe("Workspace commands", () => {
    it("has WORKSPACE_CREATE channel", () => {
      expect(ApiIpcChannels.WORKSPACE_CREATE).toBe("api:workspace:create");
    });

    it("has WORKSPACE_GET_STATUS channel", () => {
      expect(ApiIpcChannels.WORKSPACE_GET_STATUS).toBe("api:workspace:get-status");
    });
  });

  describe("UI commands", () => {
    it("has UI_SELECT_FOLDER channel", () => {
      expect(ApiIpcChannels.UI_SELECT_FOLDER).toBe("api:ui:select-folder");
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

    it("has UI_SET_MODE command channel", () => {
      expect(ApiIpcChannels.UI_SET_MODE).toBe("api:ui:set-mode");
    });
  });
});
