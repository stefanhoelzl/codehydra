/**
 * Tests for dialog-framework store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { processCommand, dialogs, panelDialog, reset } from "./dialog-framework.svelte";
import type { DialogConfig } from "@shared/dialog-types";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

describe("dialog-framework store", () => {
  beforeEach(() => {
    reset();
  });

  describe("processCommand - open", () => {
    it("should add a dialog entry", () => {
      const config = createConfig("Hello");

      processCommand({ action: "open", dialogId: "dlg-1", config });

      expect(dialogs.value.size).toBe(1);
      const entry = dialogs.value.get("dlg-1");
      expect(entry).toBeDefined();
      expect(entry!.dialogId).toBe("dlg-1");
      expect(entry!.config).toEqual(config);
    });

    it("should support multiple concurrent dialogs", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("A") });
      processCommand({ action: "open", dialogId: "dlg-2", config: createConfig("B") });

      expect(dialogs.value.size).toBe(2);
    });

    it("should default the surface to modal", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("A") });

      expect(dialogs.value.get("dlg-1")!.surface).toBe("modal");
    });

    it("should pin the surface from the open command", () => {
      processCommand({
        action: "open",
        dialogId: "dlg-1",
        config: createConfig("A"),
        surface: "panel",
      });

      expect(dialogs.value.get("dlg-1")!.surface).toBe("panel");
    });
  });

  describe("processCommand - update", () => {
    it("should replace config for an existing dialog", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Initial") });

      const updated = createConfig("Updated");
      processCommand({ action: "update", dialogId: "dlg-1", config: updated });

      const entry = dialogs.value.get("dlg-1");
      expect(entry!.config.sections[0]).toEqual({
        type: "text",
        content: "Updated",
        style: "heading",
      });
    });

    it("should not create entry for non-existent dialog", () => {
      processCommand({ action: "update", dialogId: "dlg-999", config: createConfig("Ghost") });

      expect(dialogs.value.size).toBe(0);
    });

    it("should preserve the surface across updates", () => {
      processCommand({
        action: "open",
        dialogId: "dlg-1",
        config: createConfig("A"),
        surface: "panel",
      });

      processCommand({ action: "update", dialogId: "dlg-1", config: createConfig("B") });

      expect(dialogs.value.get("dlg-1")!.surface).toBe("panel");
    });
  });

  describe("panelDialog", () => {
    it("is undefined when no panel session exists", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Modal") });

      expect(panelDialog.value).toBeUndefined();
    });

    it("returns the panel-surface entry", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Modal") });
      processCommand({
        action: "open",
        dialogId: "dlg-2",
        config: createConfig("Panel"),
        surface: "panel",
      });

      expect(panelDialog.value?.dialogId).toBe("dlg-2");
    });

    it("returns the most recently opened panel when several exist", () => {
      processCommand({
        action: "open",
        dialogId: "dlg-1",
        config: createConfig("First"),
        surface: "panel",
      });
      processCommand({
        action: "open",
        dialogId: "dlg-2",
        config: createConfig("Second"),
        surface: "panel",
      });

      expect(panelDialog.value?.dialogId).toBe("dlg-2");
    });

    it("clears when the panel session closes", () => {
      processCommand({
        action: "open",
        dialogId: "dlg-1",
        config: createConfig("Panel"),
        surface: "panel",
      });

      processCommand({ action: "close", dialogId: "dlg-1" });

      expect(panelDialog.value).toBeUndefined();
    });
  });

  describe("processCommand - close", () => {
    it("should remove a dialog entry", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Test") });

      processCommand({ action: "close", dialogId: "dlg-1" });

      expect(dialogs.value.size).toBe(0);
    });

    it("should not throw for non-existent dialog", () => {
      expect(() => processCommand({ action: "close", dialogId: "dlg-999" })).not.toThrow();
    });

    it("should not affect other dialogs", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("A") });
      processCommand({ action: "open", dialogId: "dlg-2", config: createConfig("B") });

      processCommand({ action: "close", dialogId: "dlg-1" });

      expect(dialogs.value.size).toBe(1);
      expect(dialogs.value.has("dlg-2")).toBe(true);
    });
  });

  describe("reset", () => {
    it("should clear all dialogs", () => {
      processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("A") });
      processCommand({ action: "open", dialogId: "dlg-2", config: createConfig("B") });

      reset();

      expect(dialogs.value.size).toBe(0);
    });
  });
});
