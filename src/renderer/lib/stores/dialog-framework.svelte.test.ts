/**
 * Tests for dialog-framework store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { processCommand, dialogs, reset } from "./dialog-framework.svelte";
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
