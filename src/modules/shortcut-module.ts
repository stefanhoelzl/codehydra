/**
 * ShortcutModule - Owns the Alt+X shortcut-mode state machine.
 *
 * It detects Alt+X activation, owns the local `shortcutActive` flag (it is the
 * one toggling it), and — in full mode — broadcasts entry/exit via the
 * ui:set-shortcut-active intent (→ ui:shortcut-active-changed, which the
 * presenter folds into its UI mode computation). While shortcut mode is active,
 * every key press is forwarded as a shortcut:key intent — the presenter runs
 * navigation over its authoritative model. Escape exits shortcut mode; so does
 * window blur (unless a navigation-initiated workspace switch is in flight —
 * Electron fires blur when the view bounds change during a switch).
 *
 * Restricted (over-a-modal) mode: a bug report must be reachable in EVERY state,
 * including while a modal is open (the startup/setup screens are themselves modal
 * system dialogs). So Alt+X is no longer blocked when a modal is open — instead
 * it enters a restricted mode that forwards ONLY the bug-report key ("b") and
 * does NOT broadcast ui:set-shortcut-active. Not broadcasting keeps the presenter
 * untouched: no overlay, no sidebar badges, no ARIA announcement, no workspace
 * blur — the modal stays exactly as it was, with the bug dialog layered on top.
 * The broadcast (full mode, all keys + affordances) fires only when no modal is
 * open. `isModalOpen()` is read live per key press, so a modal opening mid-gesture
 * transparently narrows to the bug-report key.
 *
 * IMPORTANT: Does NOT call event.preventDefault() on any keys.
 * Electron bug #37336 causes keyUp events to not fire when keyDown was
 * prevented. By letting all keys propagate, we ensure reliable Alt keyUp
 * detection.
 *
 * Hooks:
 * - app-start/init: Subscribe to input events on the UI view (before-input-event
 *   fires at the webContents level, so keys typed inside workspace iframes are
 *   included), subscribe to window blur
 * - app-shutdown/stop: Dispose all listeners
 */

import type { EventDeclarations, IntentModule } from "../intents/lib/module";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { KeyboardTarget } from "../boundaries/shell/view-manager-types";
import type { Logger } from "../boundaries/platform/logging";
import type { KeyboardInput, Unsubscribe } from "../boundaries/shell/view";
import type { WindowBoundary } from "../boundaries/shell/window";
import type { WindowManager } from "../boundaries/shell/window-manager";
import type { IDispatcher } from "../intents/lib/dispatcher";
import type { UiPresenter } from "./presentation/presentation-module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import {
  INTENT_SET_SHORTCUT_ACTIVE,
  type SetShortcutActiveIntent,
} from "../intents/set-shortcut-active";
import { INTENT_SHORTCUT_KEY, type ShortcutKeyIntent } from "../intents/shortcut-key";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";

type ShortcutActivationState = "NORMAL" | "ALT_WAITING";

const SHORTCUT_MODIFIER_KEY = "Alt";
const SHORTCUT_ACTIVATION_KEY = "x";

/**
 * The only shortcut honored while a modal is open (restricted mode): opens the
 * bug report dialog (handled by error-report-module on shortcut:key-pressed).
 * Every other key is dropped so nav/settings/hibernate/devtools stay inert over
 * a modal or the startup/setup screens.
 */
const BUG_REPORT_KEY = "b";

/**
 * Window (ms) after a navigation-initiated workspace switch during which a
 * window blur is ignored. Electron fires blur when the view bounds change as
 * the active workspace switches; without this guard, arrow-key navigation
 * would exit shortcut mode on the first press.
 */
const SWITCH_BLUR_SUPPRESS_MS = 250;

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
  readonly viewManager: Pick<IViewManager, "getUIKeyboardTarget">;
  readonly windowLayer: Pick<WindowBoundary, "onBlur">;
  readonly windowManager: Pick<WindowManager, "getWindowHandle">;
  readonly ui: Pick<UiPresenter, "isModalOpen">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly logger: Logger;
}

export function createShortcutModule(deps: ShortcutModuleDeps): IntentModule {
  let state: ShortcutActivationState = "NORMAL";
  /** Locally-owned shortcut-mode flag: while true, key presses are forwarded. */
  let shortcutActive = false;
  /**
   * Whether entry broadcast ui:set-shortcut-active (active:true) — i.e. full mode
   * with UI affordances. False for a restricted (over-a-modal) activation, which
   * forwards only the bug-report key and leaves the presenter untouched. Mirrored
   * on exit so we only broadcast active:false when we broadcast active:true.
   */
  let broadcasted = false;
  /** Timestamp (ms) of the last navigation-initiated workspace switch. */
  let lastSwitchAt = 0;
  let unsubscribeBeforeInput: Unsubscribe | null = null;
  let unsubscribeDestroyed: Unsubscribe | null = null;
  let unsubscribeBlur: Unsubscribe | null = null;

  /**
   * Enter shortcut mode. `restricted` (a modal is open) forwards only the
   * bug-report key and does NOT broadcast — the UI stays exactly as the modal
   * left it. Full activation broadcasts so the overlay/nav affordances light up.
   */
  function enterShortcut(restricted: boolean): void {
    if (shortcutActive) return;
    shortcutActive = true;
    if (restricted) return;
    broadcasted = true;
    void deps.dispatcher.dispatch({
      type: INTENT_SET_SHORTCUT_ACTIVE,
      payload: { active: true },
    } as SetShortcutActiveIntent);
  }

  /** Exit shortcut mode. Broadcasts active:false only if entry broadcast true. */
  function exitShortcut(): void {
    if (!shortcutActive) return;
    shortcutActive = false;
    if (!broadcasted) return;
    broadcasted = false;
    void deps.dispatcher.dispatch({
      type: INTENT_SET_SHORTCUT_ACTIVE,
      payload: { active: false },
    } as SetShortcutActiveIntent);
  }

  function dispatchShortcutKey(key: string): void {
    void deps.dispatcher.dispatch({
      type: INTENT_SHORTCUT_KEY,
      payload: { key },
    } as ShortcutKeyIntent);
  }

  function registerView(target: KeyboardTarget): void {
    unsubscribeBeforeInput = target.onBeforeInput((input) => {
      handleInput(input);
    });
    unsubscribeDestroyed = target.onDestroyed(() => {
      unregisterView();
    });
  }

  function unregisterView(): void {
    unsubscribeBeforeInput?.();
    unsubscribeBeforeInput = null;
    unsubscribeDestroyed?.();
    unsubscribeDestroyed = null;
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
   * 3. In shortcut mode: Escape exits; otherwise the key is forwarded — but while
   *    a modal is open (restricted mode) only the bug-report key gets through
   * 4. Alt keydown: NORMAL → ALT_WAITING
   * 5. In ALT_WAITING + X keydown: activate shortcut — full mode, or restricted
   *    (bug-report key only, no broadcast) when a modal is open. Never blocked.
   * 6. In ALT_WAITING + other key: exit to NORMAL, let through
   */
  function handleInput(input: KeyboardInput): void {
    const isAltKey = input.key === SHORTCUT_MODIFIER_KEY;

    deps.logger.silly("Input received", {
      type: input.type,
      key: input.key,
      isAutoRepeat: input.isAutoRepeat,
      state,
      shortcutActive,
    });

    // Handle Alt keyUp: exit shortcut mode
    if (input.type === "keyUp" && isAltKey) {
      deps.logger.debug("Alt keyUp detected", { willExitShortcutMode: shortcutActive });
      exitShortcut();
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
    if (shortcutActive) {
      const normalized = normalizeKey(input.key);
      // Escape exits shortcut mode (no preventDefault — see #37336). In full
      // mode dialog and shortcut modes are mutually exclusive, so this never
      // steals a dialog's Escape; in restricted mode (bug dialog not yet open)
      // there is no dialog to steal from either.
      if (normalized === "escape") {
        exitShortcut();
        state = "NORMAL";
        return;
      }
      // Restricted mode: while a modal is open, only the bug-report key is
      // honored (so a report is reachable over any modal / the startup screens);
      // every other key is dropped. Read isModalOpen() live so a modal opening
      // mid-gesture narrows to "b" from that point on.
      if (deps.ui.isModalOpen() && normalized !== BUG_REPORT_KEY) return;
      // NOTE: Do NOT call event.preventDefault() - see Electron bug #37336
      dispatchShortcutKey(normalized);
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
        // A modal open at activation → restricted mode (bug-report key only, no
        // broadcast). Otherwise full mode. Never blocked: a bug report must be
        // reachable in every state, including over the startup/setup screens.
        const restricted = deps.ui.isModalOpen();

        // Defer activation to next tick to avoid interfering with keyboard
        // event delivery.
        setImmediate(() => {
          enterShortcut(restricted);
        });

        state = "NORMAL";
      } else if (!isAltKey) {
        // Non-X key: exit waiting, let the key through to VS Code
        state = "NORMAL";
      }
    }
  }

  /**
   * Window blur exits shortcut mode — unless a navigation-initiated workspace
   * switch is in flight. Electron fires blur when the view bounds change as
   * the active workspace switches; navigation runs in the presenter, so we
   * coordinate via the workspace:switched domain event (recorded in
   * lastSwitchAt) and ignore the immediately-following blur.
   */
  function handleBlur(): void {
    if (shortcutActive && Date.now() - lastSwitchAt < SWITCH_BLUR_SUPPRESS_MS) {
      deps.logger.debug("Blur during workspace switch ignored");
      return;
    }
    exitShortcut();
    state = "NORMAL";
  }

  function dispose(): void {
    unregisterView();

    // Remove window blur listener
    unsubscribeBlur?.();
    unsubscribeBlur = null;
    state = "NORMAL";
    shortcutActive = false;
    broadcasted = false;
  }

  // While shortcut mode is active, a workspace:switched is navigation-initiated
  // (the user pressed an arrow/jump key). Record it so the resulting Electron
  // bounds-change blur does not exit shortcut mode.
  const events: EventDeclarations = {
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (): Promise<void> => {
        if (shortcutActive) {
          lastSwitchAt = Date.now();
        }
      },
    },
  };

  return {
    name: "shortcut",
    events,
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "ui-ready": true },
          handler: async (): Promise<void> => {
            unsubscribeBlur = deps.windowLayer.onBlur(
              deps.windowManager.getWindowHandle(),
              handleBlur
            );

            registerView(deps.viewManager.getUIKeyboardTarget());
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
  };
}
