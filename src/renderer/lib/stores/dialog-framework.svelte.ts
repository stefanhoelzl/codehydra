/**
 * Dialog framework store: a read-only view over the open dialog sessions in the
 * ui:state snapshot. The backend (UiPresenter) owns dialog lifecycle entirely;
 * the renderer renders this derived view and echoes user interactions back as
 * ui:events. There is no local mutation — dialogs appear/update/disappear only
 * as the snapshot changes.
 */

import { SvelteMap } from "svelte/reactivity";
import type { DialogConfig, DialogSurface } from "@shared/dialog-types";
import { uiState } from "./ui-state.svelte.js";

// ============ Types ============

export interface DialogEntry {
  readonly dialogId: string;
  readonly config: DialogConfig;
  /** Hosting surface, pinned by the backend when the session opened. */
  readonly surface: DialogSurface;
}

function snapshotEntries(): DialogEntry[] {
  return (uiState.value?.dialogs ?? []).map((d) => ({
    dialogId: d.id,
    config: d.config,
    surface: d.surface,
  }));
}

// ============ Reactive Getters ============

/**
 * Reactive access to all open dialogs, keyed by id (in open order).
 */
export const dialogs = {
  get value(): ReadonlyMap<string, DialogEntry> {
    return new SvelteMap(snapshotEntries().map((entry) => [entry.dialogId, entry]));
  },
};

/**
 * Reactive access to the active panel-surface session, or undefined.
 * The panel occupies the whole content area, so at most one is shown; if
 * several are open, the most recently opened wins (snapshot order).
 */
export const panelDialog = {
  get value(): DialogEntry | undefined {
    let latest: DialogEntry | undefined;
    for (const entry of snapshotEntries()) {
      if (entry.surface === "panel") {
        latest = entry;
      }
    }
    return latest;
  },
};
