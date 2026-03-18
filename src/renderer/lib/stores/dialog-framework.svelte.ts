/**
 * Dialog framework store using Svelte 5 runes.
 * Manages active dialogs driven by the backend via IPC commands.
 * This is a pure state container - IPC subscriptions are handled by DialogHost.
 */

import { SvelteMap } from "svelte/reactivity";
import type { DialogConfig, DialogCommand } from "@shared/dialog-types";

// ============ Types ============

export interface DialogEntry {
  readonly dialogId: string;
  readonly config: DialogConfig;
}

// ============ State ============

const _dialogs = new SvelteMap<string, DialogEntry>();

// ============ Actions ============

/**
 * Process a dialog command from the main process.
 * - open: add dialog to the map
 * - update: replace config for existing dialog
 * - close: remove dialog from the map
 */
export function processCommand(command: DialogCommand): void {
  switch (command.action) {
    case "open":
      _dialogs.set(command.dialogId, {
        dialogId: command.dialogId,
        config: command.config,
      });
      break;
    case "update":
      if (_dialogs.has(command.dialogId)) {
        _dialogs.set(command.dialogId, {
          dialogId: command.dialogId,
          config: command.config,
        });
      }
      break;
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
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _dialogs.clear();
}
