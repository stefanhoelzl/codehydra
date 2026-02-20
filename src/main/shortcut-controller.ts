/**
 * ShortcutController - Detects Alt+X shortcut activation in workspace views.
 *
 * Uses main-process `before-input-event` capture instead of the
 * previously-documented dual-capture strategy. This is simpler and
 * doesn't require injecting preload scripts into workspace content.
 *
 * IMPORTANT: This controller does NOT call event.preventDefault() on any keys.
 * This is intentional - Electron bug #37336 causes keyUp events to not fire
 * when keyDown was prevented. By letting all keys propagate, we ensure
 * reliable keyUp detection for exiting shortcut mode when Alt is released.
 */

import type { UIMode } from "../shared/ipc";
import type { ShortcutKey } from "../shared/shortcuts";
import { isShortcutKey } from "../shared/shortcuts";
import type { Logger } from "../services/logging";
import type { KeyboardInput, Unsubscribe } from "../services/shell/view";
import type { ViewHandle, WindowHandle } from "../services/shell/types";

type ShortcutActivationState = "NORMAL" | "ALT_WAITING";

/** Key constants for maintainability */
const SHORTCUT_MODIFIER_KEY = "Alt";
const SHORTCUT_ACTIVATION_KEY = "x";

/**
 * Map from Electron key values to normalized ShortcutKey values.
 * Only includes keys that need transformation; digit keys pass through.
 */
const KEY_MAP: Record<string, ShortcutKey> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
  Delete: "delete",
  Backspace: "delete",
};

/**
 * Normalizes an Electron key value to a ShortcutKey, or returns null if not a shortcut key.
 * Handles key mappings (e.g., ArrowUp → "up") and pass-through for digit keys.
 */
function normalizeKey(key: string): ShortcutKey | null {
  // Check explicit mappings first
  const mapped = KEY_MAP[key];
  if (mapped !== undefined) {
    return mapped;
  }
  // Digit keys pass through as-is
  if (isShortcutKey(key)) {
    return key;
  }
  return null;
}

export interface ShortcutControllerDeps {
  /** Focuses the UI layer */
  focusUI: () => void;
  /** Sets the UI mode (workspace, shortcut, dialog) */
  setMode: (mode: UIMode) => void;
  /** Gets the current UI mode */
  getMode: () => UIMode;
  /** Callback when a shortcut key is pressed in shortcut mode */
  onShortcut?: (key: ShortcutKey) => void;
  /** Logger for debugging */
  logger?: Logger;
  /** ViewLayer methods for event subscription */
  viewLayer: {
    onBeforeInputEvent(
      handle: ViewHandle,
      callback: (input: KeyboardInput, preventDefault: () => void) => void
    ): Unsubscribe;
    onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe;
  };
  /** WindowLayer methods for blur subscription */
  windowLayer: {
    onBlur(handle: WindowHandle, callback: () => void): Unsubscribe;
  };
  /** Handle to the main window */
  windowHandle: WindowHandle;
}

/**
 * Detects Alt+X shortcut activation in workspace views.
 * ONE global instance manages ALL workspace views.
 *
 * Uses main-process `before-input-event` capture instead of the
 * previously-documented dual-capture strategy. This is simpler and
 * doesn't require injecting preload scripts into workspace content.
 */
export class ShortcutController {
  private state: ShortcutActivationState = "NORMAL";
  /** Map of view handle ID → cleanup functions */
  private readonly cleanups = new Map<string, Unsubscribe[]>();
  private readonly deps: ShortcutControllerDeps;
  private readonly unsubscribeBlur: Unsubscribe;
  private readonly logger: Logger | undefined;

  constructor(deps: ShortcutControllerDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.unsubscribeBlur = deps.windowLayer.onBlur(deps.windowHandle, () => {
      this.handleWindowBlur();
    });
  }

  /**
   * Registers a view to listen for Alt+X shortcut.
   * Auto-unregisters when the view is destroyed.
   * @param handle - ViewHandle of the workspace/UI view
   */
  registerView(handle: ViewHandle): void {
    if (this.cleanups.has(handle.id)) return;

    const unsubs: Unsubscribe[] = [];
    unsubs.push(
      this.deps.viewLayer.onBeforeInputEvent(handle, (input) => {
        this.handleInput(input);
      })
    );
    unsubs.push(
      this.deps.viewLayer.onDestroyed(handle, () => {
        this.unregisterView(handle);
      })
    );
    this.cleanups.set(handle.id, unsubs);
  }

  /**
   * Unregisters a view from shortcut detection.
   * @param handle - ViewHandle of the workspace/UI view
   */
  unregisterView(handle: ViewHandle): void {
    const unsubs = this.cleanups.get(handle.id);
    if (unsubs) {
      for (const unsub of unsubs) {
        unsub();
      }
      this.cleanups.delete(handle.id);
    }
  }

  /**
   * Gets the current mode from deps or returns 'workspace' as default.
   */
  private getCurrentMode(): UIMode {
    return this.deps.getMode?.() ?? "workspace";
  }

  /**
   * Handles keyboard input from workspace views via before-input-event.
   *
   * IMPORTANT: This handler does NOT call event.preventDefault() on any keys.
   * Electron bug #37336 causes keyUp events to not fire when keyDown was prevented.
   * By letting all keys propagate, we ensure reliable Alt keyUp detection.
   *
   * Algorithm:
   * 1. Handle keyUp: Alt release exits shortcut mode
   * 2. Skip auto-repeat events
   * 3. Shortcut key in shortcut mode: emit event (no suppress)
   * 4. Alt keydown: NORMAL → ALT_WAITING
   * 5. In ALT_WAITING + X keydown: activate shortcut (no suppress)
   * 6. In ALT_WAITING + other key: exit to NORMAL, let through
   */
  private handleInput(input: KeyboardInput): void {
    const isAltKey = input.key === SHORTCUT_MODIFIER_KEY;
    const currentMode = this.getCurrentMode();

    // Log all input events for debugging (silly level to avoid noise)
    this.logger?.silly("Input received", {
      type: input.type,
      key: input.key,
      isAutoRepeat: input.isAutoRepeat,
      state: this.state,
      mode: currentMode,
    });

    // Handle Alt keyUp: exit shortcut mode
    if (input.type === "keyUp" && isAltKey) {
      this.logger?.debug("Alt keyUp detected", {
        mode: currentMode,
        willExitShortcutMode: currentMode === "shortcut",
      });
      if (currentMode === "shortcut") {
        if (this.deps.setMode) {
          this.deps.setMode("workspace");
        }
      }
      this.state = "NORMAL";
      return;
    }

    // Only process keyDown events from here
    if (input.type !== "keyDown") return;

    // Ignore auto-repeat events (fires dozens per second on key hold)
    if (input.isAutoRepeat) return;

    const isActivationKey = input.key.toLowerCase() === SHORTCUT_ACTIVATION_KEY;

    // Shortcut key detection in shortcut mode
    // NOTE: This runs before Alt+X detection because shortcut mode is already active
    if (currentMode === "shortcut") {
      const normalizedKey = normalizeKey(input.key);
      if (normalizedKey !== null) {
        // NOTE: Do NOT call event.preventDefault() - see Electron bug #37336
        // Preventing any key breaks keyUp tracking for ALL keys in the sequence
        if (this.deps.onShortcut) {
          this.deps.onShortcut(normalizedKey);
        }
        return;
      }
      // Unknown key in shortcut mode - let it pass through
      // (e.g., Escape is handled by renderer)
    }

    // NORMAL state: Alt keydown starts waiting
    if (this.state === "NORMAL" && isAltKey) {
      this.state = "ALT_WAITING";
      // NOTE: Do NOT call event.preventDefault() - see Electron bug #37336
      return;
    }

    // ALT_WAITING state
    if (this.state === "ALT_WAITING") {
      if (isActivationKey) {
        // Alt+X detected: check if we can activate shortcut mode
        // Don't activate shortcut mode if a dialog is open
        if (currentMode === "dialog") {
          this.state = "NORMAL";
          return;
        }

        // NOTE: Do NOT call event.preventDefault() - see Electron bug #37336

        // Defer mode change to next tick to avoid interfering with keyboard event delivery
        // (Being inside before-input-event callback may affect subsequent events)
        if (this.deps.setMode) {
          const setMode = this.deps.setMode;
          setImmediate(() => {
            setMode("shortcut");
          });
        }

        this.state = "NORMAL";
      } else if (!isAltKey) {
        // Non-X key: exit waiting, let the key through to VS Code
        this.state = "NORMAL";
      }
    }
  }

  private handleWindowBlur(): void {
    // Reset state when window loses OS focus (e.g., Alt+Tab)
    this.state = "NORMAL";
  }

  /**
   * Cleans up event listeners and resets state.
   */
  dispose(): void {
    // Unregister all views (makes copy to avoid mutation during iteration)
    for (const id of [...this.cleanups.keys()]) {
      const unsubs = this.cleanups.get(id);
      if (unsubs) {
        for (const unsub of unsubs) {
          unsub();
        }
      }
    }
    this.cleanups.clear();

    // Remove window blur listener
    this.unsubscribeBlur();
    this.state = "NORMAL";
  }
}
