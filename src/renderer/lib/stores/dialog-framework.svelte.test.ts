/**
 * Tests for the dialog-framework store — a read-only derived view over the
 * ui:state snapshot's open dialogs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { dialogs, panelDialog } from "./dialog-framework.svelte";
import { setUiState, resetUiState } from "./ui-state.svelte.js";
import type { DialogConfig } from "@shared/dialog-types";
import type { UiDialog, UiState } from "@shared/ui-state";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

/** Push a snapshot carrying the given open dialogs. */
function show(dialogList: UiDialog[]): void {
  setUiState({
    sidebar: { projects: [] },
    frames: {},
    main: { kind: "creation" },
    theme: "dark",
    mode: "hover",
    dialogs: dialogList,
    notifications: [],
  } satisfies UiState);
}

describe("dialog-framework store (derived from ui:state)", () => {
  beforeEach(() => {
    resetUiState();
  });

  it("is empty before the first snapshot", () => {
    expect(dialogs.value.size).toBe(0);
    expect(panelDialog.value).toBeUndefined();
  });

  it("maps snapshot dialogs into entries keyed by id", () => {
    const config = createConfig("Hello");
    show([{ id: "dlg-1", surface: "modal", config }]);

    expect(dialogs.value.size).toBe(1);
    expect(dialogs.value.get("dlg-1")).toMatchObject({
      dialogId: "dlg-1",
      surface: "modal",
      config,
    });
  });

  it("supports multiple concurrent dialogs", () => {
    show([
      { id: "dlg-1", surface: "modal", config: createConfig("A") },
      { id: "dlg-2", surface: "modal", config: createConfig("B") },
    ]);

    expect(dialogs.value.size).toBe(2);
  });

  describe("panelDialog", () => {
    it("is undefined when no panel session exists", () => {
      show([{ id: "dlg-1", surface: "modal", config: createConfig("Modal") }]);

      expect(panelDialog.value).toBeUndefined();
    });

    it("returns the panel-surface entry", () => {
      show([
        { id: "dlg-1", surface: "modal", config: createConfig("Modal") },
        { id: "dlg-2", surface: "panel", config: createConfig("Panel") },
      ]);

      expect(panelDialog.value?.dialogId).toBe("dlg-2");
    });

    it("returns the most recently opened panel when several exist", () => {
      show([
        { id: "dlg-1", surface: "panel", config: createConfig("First") },
        { id: "dlg-2", surface: "panel", config: createConfig("Second") },
      ]);

      expect(panelDialog.value?.dialogId).toBe("dlg-2");
    });

    it("clears when the panel session leaves the snapshot", () => {
      show([{ id: "dlg-1", surface: "panel", config: createConfig("Panel") }]);
      expect(panelDialog.value).toBeDefined();

      show([]);
      expect(panelDialog.value).toBeUndefined();
    });
  });
});
