/**
 * ShortcutModule - Detects Alt+X shortcut activation and dispatches key intents.
 *
 * IMPORTANT: Does NOT call event.preventDefault() on any keys.
 * Electron bug #37336 causes keyUp events to not fire when keyDown was prevented.
 * By letting all keys propagate, we ensure reliable Alt keyUp detection.
 *
 * Hooks:
 * - app-start/init: Subscribe to input events on UI view, subscribe to window blur
 * - app-shutdown/stop: Dispose all listeners
 *
 * Events:
 * - workspace:created: Register new workspace view for input detection
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IViewManager } from "../managers/view-manager.interface";
import type { Logger } from "../../services/logging";
import type { KeyboardInput, Unsubscribe, ViewLayer } from "../../services/shell/view";
import type { WindowLayer } from "../../services/shell/window";
import type { ViewHandle } from "../../services/shell/types";
import type { WindowManager } from "../managers/window-manager";
import type { IDispatcher } from "../intents/infrastructure/dispatcher";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { INTENT_SET_MODE, type SetModeIntent } from "../operations/set-mode";
import { INTENT_SHORTCUT_KEY, type ShortcutKeyIntent } from "../operations/shortcut-key";

type ShortcutActivationState = "NORMAL" | "ALT_WAITING";

const SHORTCUT_MODIFIER_KEY = "Alt";
const SHORTCUT_ACTIVATION_KEY = "x";

/**
 * Map from Electron key values to normalized key strings.
 * Keys not in this map are lowercased as-is (e.g., "d" → "d", "Escape" → "escape").
 */
const KEY_MAP: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
  Delete: "delete",
  Backspace: "delete",
};

/**
 * Normalizes an Electron key value to a lowercase key string.
 * Handles key mappings (e.g., ArrowUp → "up") and lowercase passthrough for all other keys.
 */
export function normalizeKey(key: string): string {
  const mapped = KEY_MAP[key];
  if (mapped !== undefined) {
    return mapped;
  }
  return key.toLowerCase();
}

export interface ShortcutModuleDeps {
  readonly viewManager: Pick<IViewManager, "getUIViewHandle" | "getMode" | "getWorkspaceView">;
  readonly viewLayer: Pick<ViewLayer, "onBeforeInputEvent" | "onDestroyed">;
  readonly windowLayer: Pick<WindowLayer, "onBlur">;
  readonly windowManager: Pick<WindowManager, "getWindowHandle">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly logger: Logger;
}

export function createShortcutModule(deps: ShortcutModuleDeps): IntentModule {
  let state: ShortcutActivationState = "NORMAL";
  const cleanups = new Map<string, Unsubscribe[]>();
  let unsubscribeBlur: Unsubscribe | null = null;

  function dispatchSetMode(mode: string): void {
    void deps.dispatcher.dispatch({
      type: INTENT_SET_MODE,
      payload: { mode },
    } as SetModeIntent);
  }

  function dispatchShortcutKey(key: string): void {
    void deps.dispatcher.dispatch({
      type: INTENT_SHORTCUT_KEY,
      payload: { key },
    } as ShortcutKeyIntent);
  }

  function registerView(handle: ViewHandle): void {
    if (cleanups.has(handle.id)) return;

    const unsubs: Unsubscribe[] = [];
    unsubs.push(
      deps.viewLayer.onBeforeInputEvent(handle, (input) => {
        handleInput(input);
      })
    );
    unsubs.push(
      deps.viewLayer.onDestroyed(handle, () => {
        unregisterView(handle);
      })
    );
    cleanups.set(handle.id, unsubs);
  }

  function unregisterView(handle: ViewHandle): void {
    const unsubs = cleanups.get(handle.id);
    if (unsubs) {
      for (const unsub of unsubs) {
        unsub();
      }
      cleanups.delete(handle.id);
    }
  }

  /**
   * Handles keyboard input from workspace views via before-input-event.
   *
   * IMPORTANT: Does NOT call event.preventDefault() on any keys.
   * Electron bug #37336 causes keyUp events to not fire when keyDown was prevented.
   *
   * Algorithm:
   * 1. Handle keyUp: Alt release exits shortcut mode
   * 2. Skip auto-repeat events
   * 3. Shortcut key in shortcut mode: emit event (no suppress)
   * 4. Alt keydown: NORMAL → ALT_WAITING
   * 5. In ALT_WAITING + X keydown: activate shortcut (no suppress)
   * 6. In ALT_WAITING + other key: exit to NORMAL, let through
   */
  function handleInput(input: KeyboardInput): void {
    const isAltKey = input.key === SHORTCUT_MODIFIER_KEY;
    const currentMode = deps.viewManager.getMode();

    deps.logger.silly("Input received", {
      type: input.type,
      key: input.key,
      isAutoRepeat: input.isAutoRepeat,
      state,
      mode: currentMode,
    });

    // Handle Alt keyUp: exit shortcut mode
    if (input.type === "keyUp" && isAltKey) {
      deps.logger.debug("Alt keyUp detected", {
        mode: currentMode,
        willExitShortcutMode: currentMode === "shortcut",
      });
      if (currentMode === "shortcut") {
        dispatchSetMode("workspace");
      }
      state = "NORMAL";
      return;
    }

    // Only process keyDown events from here
    if (input.type !== "keyDown") return;

    // Ignore auto-repeat events (fires dozens per second on key hold)
    if (input.isAutoRepeat) return;

    const isActivationKey = input.key.toLowerCase() === SHORTCUT_ACTIVATION_KEY;

    // Key dispatch in shortcut mode
    // NOTE: This runs before Alt+X detection because shortcut mode is already active
    if (currentMode === "shortcut") {
      // NOTE: Do NOT call event.preventDefault() - see Electron bug #37336
      dispatchShortcutKey(normalizeKey(input.key));
      return;
    }

    // NORMAL state: Alt keydown starts waiting
    if (state === "NORMAL" && isAltKey) {
      state = "ALT_WAITING";
      return;
    }

    // ALT_WAITING state
    if (state === "ALT_WAITING") {
      if (isActivationKey) {
        // Don't activate shortcut mode if a dialog is open
        if (currentMode === "dialog") {
          state = "NORMAL";
          return;
        }

        // Defer mode change to next tick to avoid interfering with keyboard event delivery
        setImmediate(() => {
          dispatchSetMode("shortcut");
        });

        state = "NORMAL";
      } else if (!isAltKey) {
        // Non-X key: exit waiting, let the key through to VS Code
        state = "NORMAL";
      }
    }
  }

  function dispose(): void {
    // Unregister all views (makes copy to avoid mutation during iteration)
    for (const id of [...cleanups.keys()]) {
      const unsubs = cleanups.get(id);
      if (unsubs) {
        for (const unsub of unsubs) {
          unsub();
        }
      }
    }
    cleanups.clear();

    // Remove window blur listener
    unsubscribeBlur?.();
    unsubscribeBlur = null;
    state = "NORMAL";
  }

  return {
    name: "shortcut",
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "ui-ready": true },
          handler: async (): Promise<void> => {
            unsubscribeBlur = deps.windowLayer.onBlur(deps.windowManager.getWindowHandle(), () => {
              state = "NORMAL";
            });

            registerView(deps.viewManager.getUIViewHandle());
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            try {
              dispose();
            } catch {
              // Best-effort: shutdown disposal is non-fatal
            }
          },
        },
      },
    },

    events: {
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const payload = (event as WorkspaceCreatedEvent).payload;
          const handle = deps.viewManager.getWorkspaceView(payload.workspacePath);
          if (handle) {
            registerView(handle);
          }
        },
      },
    },
  };
}
