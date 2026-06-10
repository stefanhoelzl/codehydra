/**
 * Dialog framework store using Svelte 5 runes.
 * Manages active dialogs driven by the backend via IPC commands.
 * This is a pure state container - IPC subscriptions are handled by DialogHost.
 */

import { SvelteMap } from "svelte/reactivity";
import type { DialogConfig, DialogCommand, DialogSurface } from "@shared/dialog-types";

// ============ Types ============

export interface DialogEntry {
  readonly dialogId: string;
  readonly config: DialogConfig;
  /** Hosting surface, pinned from the open command — updates cannot change it. */
  readonly surface: DialogSurface;
}

// ============ State ============

const _dialogs = new SvelteMap<string, DialogEntry>();

// ============ Actions ============

/**
 * Process a dialog command from the main process.
 * - open: add dialog to the map (surface defaults to "modal")
 * - update: replace config for existing dialog (surface is preserved)
 * - close: remove dialog from the map
 */
export function processCommand(command: DialogCommand): void {
  switch (command.action) {
    case "open":
      _dialogs.set(command.dialogId, {
        dialogId: command.dialogId,
        config: command.config,
        surface: command.surface ?? "modal",
      });
      break;
    case "update": {
      const existing = _dialogs.get(command.dialogId);
      if (existing) {
        _dialogs.set(command.dialogId, {
          dialogId: command.dialogId,
          config: command.config,
          surface: existing.surface,
        });
      }
      break;
    }
    case "close":
      _dialogs.delete(command.dialogId);
      break;
  }
}

// ============ Reactive Getters ============

/**
 * Reactive access to all active dialogs.
 */
export const dialogs = {
  get value(): ReadonlyMap<string, DialogEntry> {
    return _dialogs;
  },
};

/**
 * Reactive access to the active panel-surface session, or undefined.
 * The panel occupies the whole content area, so at most one is shown; if
 * several are open, the most recently opened wins (SvelteMap preserves
 * insertion order).
 */
export const panelDialog = {
  get value(): DialogEntry | undefined {
    let latest: DialogEntry | undefined;
    for (const entry of _dialogs.values()) {
      if (entry.surface === "panel") {
        latest = entry;
      }
    }
    return latest;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _dialogs.clear();
}
