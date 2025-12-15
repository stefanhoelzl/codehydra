/**
 * ShortcutController - Detects Alt+X shortcut activation in workspace views.
 *
 * Uses main-process `before-input-event` capture instead of the
 * previously-documented dual-capture strategy. This is simpler and
 * doesn't require injecting preload scripts into workspace content.
 */

import type { WebContents, Event as ElectronEvent, Input, BaseWindow } from "electron";
import type { UIMode } from "../shared/ipc";

type ShortcutActivationState = "NORMAL" | "ALT_WAITING";

/** Key constants for maintainability */
const SHORTCUT_MODIFIER_KEY = "Alt";
const SHORTCUT_ACTIVATION_KEY = "x";

interface ShortcutControllerDeps {
  /** @deprecated Use setMode instead */
  setDialogMode: (isOpen: boolean) => void;
  /** @deprecated Handled by setMode */
  focusUI: () => void;
  getUIWebContents: () => WebContents | null;
  /** Sets the UI mode (workspace, shortcut, dialog) */
  setMode?: (mode: UIMode) => void;
  /** Gets the current UI mode */
  getMode?: () => UIMode;
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
  private readonly registeredViews = new Set<WebContents>();
  private readonly inputHandlers = new Map<
    WebContents,
    (event: ElectronEvent, input: Input) => void
  >();
  private readonly destroyedHandlers = new Map<WebContents, () => void>();
  private readonly deps: ShortcutControllerDeps;
  private readonly window: BaseWindow;
  private readonly boundHandleWindowBlur: () => void;

  constructor(window: BaseWindow, deps: ShortcutControllerDeps) {
    this.window = window;
    this.deps = deps;
    this.boundHandleWindowBlur = this.handleWindowBlur.bind(this);
    this.window.on("blur", this.boundHandleWindowBlur);
  }

  /**
   * Registers a workspace view to listen for Alt+X shortcut.
   * Also listens for 'destroyed' event to auto-cleanup stale references.
   * @param webContents - WebContents of the workspace view
   */
  registerView(webContents: WebContents): void {
    if (this.registeredViews.has(webContents)) return;

    const inputHandler = (event: ElectronEvent, input: Input) => {
      this.handleInput(event, input);
    };
    const destroyedHandler = () => {
      this.unregisterView(webContents);
    };

    webContents.on("before-input-event", inputHandler);
    webContents.on("destroyed", destroyedHandler);

    this.registeredViews.add(webContents);
    this.inputHandlers.set(webContents, inputHandler);
    this.destroyedHandlers.set(webContents, destroyedHandler);
  }

  /**
   * Unregisters a workspace view from shortcut detection.
   * @param webContents - WebContents of the workspace view
   */
  unregisterView(webContents: WebContents): void {
    const inputHandler = this.inputHandlers.get(webContents);
    const destroyedHandler = this.destroyedHandlers.get(webContents);

    if (inputHandler && !webContents.isDestroyed()) {
      webContents.off("before-input-event", inputHandler);
    }
    if (destroyedHandler && !webContents.isDestroyed()) {
      webContents.off("destroyed", destroyedHandler);
    }

    this.registeredViews.delete(webContents);
    this.inputHandlers.delete(webContents);
    this.destroyedHandlers.delete(webContents);
  }

  /**
   * Gets the current mode from deps or returns 'workspace' as default.
   */
  private getCurrentMode(): UIMode {
    return this.deps.getMode?.() ?? "workspace";
  }

  /**
   * Handles keyboard input from workspace views.
   *
   * Algorithm:
   * 1. Early exit for non-keyDown events (performance)
   * 2. Early exit for auto-repeat events
   * 3. Alt keyup: always suppress (any state) → NORMAL
   * 4. Alt keydown: NORMAL → ALT_WAITING, suppress
   * 5. In ALT_WAITING + X keydown: activate shortcut, suppress
   * 6. In ALT_WAITING + other key: exit to NORMAL, let through
   */
  private handleInput(event: ElectronEvent, input: Input): void {
    // Performance: only process keyDown for state machine, keyUp for Alt suppression
    if (input.type !== "keyDown" && input.type !== "keyUp") return;

    // Ignore auto-repeat events (fires dozens per second on key hold)
    if (input.isAutoRepeat) return;

    const isAltKey = input.key === SHORTCUT_MODIFIER_KEY;
    const isActivationKey = input.key.toLowerCase() === SHORTCUT_ACTIVATION_KEY;

    // Alt keyup: ALWAYS suppress to prevent VS Code menu activation
    // Also exit shortcut mode if active. This handles a race condition:
    // 1. Alt+X activates shortcut mode, focus moves to UI
    // 2. User releases Alt very quickly (before focus actually switches)
    // 3. This handler catches the Alt keyup (workspace still has focus)
    // 4. We need to exit shortcut mode
    if (input.type === "keyUp" && isAltKey) {
      event.preventDefault();
      const currentMode = this.getCurrentMode();
      if (currentMode === "shortcut") {
        if (this.deps.setMode) {
          this.deps.setMode("workspace");
        }
      }
      this.state = "NORMAL";
      return;
    }

    // Only process keyDown from here
    if (input.type !== "keyDown") return;

    // NORMAL state: Alt keydown starts waiting
    if (this.state === "NORMAL" && isAltKey) {
      this.state = "ALT_WAITING";
      event.preventDefault();
      return;
    }

    // ALT_WAITING state
    if (this.state === "ALT_WAITING") {
      if (isActivationKey) {
        // Alt+X detected: check if we can activate shortcut mode
        const currentMode = this.getCurrentMode();

        // Don't activate shortcut mode if a dialog is open
        if (currentMode === "dialog") {
          this.state = "NORMAL";
          return;
        }

        event.preventDefault();

        // Activate shortcut mode via unified mode system
        // setMode handles z-order and focus (UI on top, UI focused)
        if (this.deps.setMode) {
          this.deps.setMode("shortcut");
        }

        this.state = "NORMAL";
      } else if (!isAltKey) {
        // Non-X key: exit waiting, let the key through to VS Code
        this.state = "NORMAL";
        // Do NOT preventDefault - let the keystroke pass through
      }
    }
  }

  private handleWindowBlur(): void {
    // Reset state when window loses OS focus (e.g., Alt+Tab)
    this.state = "NORMAL";
  }

  /**
   * Cleans up event listeners and resets state.
   * Should be called from ViewManager.destroy() during shutdown.
   */
  dispose(): void {
    // Unregister all views (makes copies to avoid mutation during iteration)
    for (const webContents of [...this.registeredViews]) {
      this.unregisterView(webContents);
    }

    // Remove window blur listener
    this.window.off("blur", this.boundHandleWindowBlur);
    this.state = "NORMAL";
  }
}
