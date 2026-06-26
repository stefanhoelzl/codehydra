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
  it("exposes exactly the two live channels (ui:event up, ui:state down)", () => {
    expect(ApiIpcChannels.UI_EVENT).toBe("api:ui:event");
    expect(ApiIpcChannels.UI_STATE).toBe("api:ui:state");
    expect(Object.keys(ApiIpcChannels)).toEqual(["UI_EVENT", "UI_STATE"]);
  });
});
