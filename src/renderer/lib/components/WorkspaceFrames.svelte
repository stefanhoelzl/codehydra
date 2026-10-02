<!--
  WorkspaceFrames.svelte

  Renders one <iframe> per mountable workspace (has an IDE server URL and is
  not hibernated), from the UiState snapshot's `frames` region. All frames
  mount eagerly so switching is instant; only the active frame is visible.

  Inactive frames are display:none so Chromium suspends their paint/layout.
  visibility:hidden would seem equivalent but makes elements non-focusable,
  breaking focus restoration on switch-back. display:block is async — the
  show flow defers focus past layout via requestAnimationFrame.

  Focus chain on switch:
    1. The .active class toggles display:none → display:block.
    2. iframe.focus() + contentWindow.focus() (deferred via rAF so layout has
       flushed) put the iframe element in the document's focus chain and fire
       a `focus` event on the iframe's window.
    3. The in-frame focus tracker (installed by the UiViewManager via
       installChildFrameScript) reacts to that `focus` event and restores the
       last-focused element inside the iframe.

  Focus is routed by mode, mirroring the old main-process behavior: frames
  are only focused while in "workspace" mode; entering shortcut mode blurs
  the frame so navigation keys don't reach VS Code.

  Focus repair: a hidden frame can still take focus away from the visible one
  (`window.focus()` is frame-level, so Chromium honours it even for a
  display:none iframe — VS Code's webview bootstrap makes that call). Focus
  then sits in a subtree where nothing is focusable and keystrokes vanish. The
  frame that lost it says so (`__chBlurred`, from the injected tracker) and the
  active frame is focused again. Unlike the mode routing above this runs in
  "hover" too: hovering the sidebar is a mouse position, not a decision to give
  up the caret.

  Focus policy: the workbench also focuses itself on its own schedule (at
  startup, among others), which pulls the caret out of a dialog's field. Each
  frame is told whether it may take focus on its own (`__chFocusAllowed`: the
  active frame, in the modes the repair defends), and a gate patched into the
  workbench refuses its focus calls otherwise (bundle-patches.ts, FOCUS_GATE).
  A frame asks for its policy as it loads (`__chFocusPolicyRequest`). The gate
  prevents what it sees; the repair still covers the move it cannot see (a
  hidden workspace's webview host focusing its cross-origin content).

  Recovery is main's: frame-watchdog-module notices a workspace renderer
  process dying and reloads every frame through __chReloadFrames.

  Exposes window hooks for the main process (UiViewManager):
  - __chFocusActiveFrame(): focus the active frame (window-focus handler,
    post-terminal-focus refresh)
  - __chActiveFrameRect(): bounding rect of the active frame (hibernation
    screenshot capture clipping)
  - __chReloadFrames(): reload every mounted frame (IDE server restart, the
    workspace renderer process died; see frame-watchdog-module)
  - __chReloadFrame(key): reload one mounted frame (its IDE went away on its
    own; see frame-watchdog-module)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { UIMode } from "@shared/ipc";
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  interface FrameHooks {
    __chFocusActiveFrame?: () => void;
    __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
    __chReloadFrames?: () => void;
    __chReloadFrame?: (key: string) => void;
  }

  /** One mountable workspace frame from the UiState snapshot. */
  export interface FrameEntry {
    readonly key: string;
    readonly url: string;
    /** Accessible iframe title (workspace name). */
    readonly title: string;
  }

  interface WorkspaceFramesProps {
    /** Mounted frames (snapshot `frames`, joined with names by MainView). */
    frames: readonly FrameEntry[];
    /** Frame currently shown (snapshot main.frameKey), null when main shows
     *  something else (panel, hibernated screen). */
    activeKey: string | null;
    /** The single UI mode from the snapshot (main-owned). */
    mode?: UIMode;
  }

  let { frames, activeKey, mode = "workspace" }: WorkspaceFramesProps = $props();

  const frameEls = new SvelteMap<string, HTMLIFrameElement>();

  /** Whether an element of this page (not a frame) holds focus — a dialog field, a sidebar button. */
  let uiHoldsFocus = $state(false);

  function updateUiFocus(): void {
    const active = document.activeElement;
    uiHoldsFocus =
      active !== null && active !== document.body && !(active instanceof HTMLIFrameElement);
  }

  // focusout fires before focus lands anywhere; read the outcome once it has.
  function handleFocusOut(): void {
    setTimeout(updateUiFocus, 0);
  }

  function registerFrame(el: HTMLIFrameElement, key: string): { destroy(): void } {
    frameEls.set(key, el);
    return {
      destroy() {
        frameEls.delete(key);
      },
    };
  }

  /** The mounted frame that sent a message, by window identity. */
  function keyForSource(source: MessageEvent["source"]): string | undefined {
    if (source === null) return undefined;
    for (const [key, el] of frameEls) {
      if (el.contentWindow === source) return key;
    }
    return undefined;
  }

  /**
   * Modes in which a frame losing focus is a defect rather than the point.
   * "shortcut" blurs the frame deliberately (below) and "dialog" hands focus
   * to a modal, so neither is repaired. "hover" is — the sidebar being under
   * the pointer says nothing about where the user is typing.
   */
  function repairableMode(current: UIMode): boolean {
    return current === "workspace" || current === "hover";
  }

  /**
   * Restore focus to the active frame after another frame took it. Bounded, so
   * a frame that steals in a loop cannot start a focus fight the user is caught
   * in the middle of: past the budget the caret is left where it is.
   */
  const REPAIR_WINDOW_MS = 2000;
  const REPAIR_LIMIT = 3;
  let repairTimes: number[] = [];

  function repairFocus(blurredKey: string): void {
    if (blurredKey !== activeKey) return;
    if (!repairableMode(mode)) return;
    // The whole window lost focus (alt-tab, another app): not ours to reclaim.
    if (!document.hasFocus()) return;

    const now = Date.now();
    repairTimes = repairTimes.filter((at) => now - at < REPAIR_WINDOW_MS);
    if (repairTimes.length >= REPAIR_LIMIT) {
      logger.warn("Active frame keeps losing focus; leaving it alone", { key: blurredKey });
      return;
    }
    repairTimes.push(now);
    focusActiveFrame();
  }

  function handleFrameMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;

    if ((data as { __chBlurred?: unknown }).__chBlurred === true) {
      const blurredKey = keyForSource(event.source);
      if (blurredKey !== undefined) repairFocus(blurredKey);
      return;
    }

    if ((data as { __chFocusPolicyRequest?: unknown }).__chFocusPolicyRequest === true) {
      const key = keyForSource(event.source);
      const el = key === undefined ? undefined : frameEls.get(key);
      if (key !== undefined && el) postFocusPolicy(key, el);
      return;
    }
  }

  function activeFrame(): HTMLIFrameElement | undefined {
    if (activeKey === null) return undefined;
    return frameEls.get(activeKey);
  }

  /** requestAnimationFrame that tolerates a torn-down frame (unmount, tests). */
  function raf(callback: () => void): void {
    try {
      requestAnimationFrame(callback);
    } catch {
      // Frame is being destroyed; the deferred work is moot
    }
  }

  function focusFrame(el: HTMLIFrameElement): void {
    // display:none → block is async; defer focus past layout. The
    // contentWindow.focus() fires a window 'focus' event inside the iframe,
    // which the in-frame tracker uses to restore the last-focused element.
    raf(() => {
      try {
        el.focus();
        el.contentWindow?.focus();
      } catch {
        // Cross-origin frame may reject; focus is best-effort
      }
    });
  }

  /**
   * Tell a frame whether it may take focus on its own — the focus gate patched
   * into the workbench (bundle-patches.ts, `FOCUS_GATE`) enforces the answer.
   * Only the active frame may, only in the modes where it owns the keyboard
   * (the same ones the repair defends), and only while nothing on this page
   * holds focus: a dialog's field or shortcut mode must not lose the caret to a
   * workbench focusing itself.
   *
   * `uiHoldsFocus` is what closes the race: `mode` reaches the renderer only
   * after a round trip through main, so a dialog's field can have the caret
   * while the mode still says "hover". A focusin here is immediate.
   */
  function postFocusPolicy(key: string, el: HTMLIFrameElement): void {
    const allowed = key === activeKey && repairableMode(mode) && !uiHoldsFocus;
    try {
      el.contentWindow?.postMessage({ __chFocusAllowed: allowed }, "*");
    } catch {
      // Frame torn down mid-update; it asks again when it loads
    }
  }

  // Re-send the policy whenever it can change: the active frame, the mode, the
  // page's own focus, or the mounted set. A frame that loads later asks for it
  // itself.
  $effect(() => {
    for (const [key, el] of frameEls) postFocusPolicy(key, el);
  });

  function focusActiveFrame(): void {
    const el = activeFrame();
    if (el) focusFrame(el);
  }

  // Reload every mounted frame by re-assigning its src (forces a navigation
  // even though the URL is unchanged — the prod IDE server port is stable
  // across a restart). Invoked by the main process via __chReloadFrames after
  // the IDE server restarts on resume, so the frames reconnect to the fresh
  // server instead of showing the IDE server's own "Reload" dialog, and after
  // the frames' shared renderer process died. frameEls holds exactly the
  // mounted (non-hibernated) frames.
  function reloadFrames(): void {
    for (const el of frameEls.values()) {
      // Re-assigning src (via a local, to dodge no-self-assign) forces a fresh
      // navigation even though the resolved URL is identical.
      const url = el.src;
      el.src = url;
    }
    if (mode === "workspace") focusActiveFrame();
  }

  // Reload one mounted frame. Invoked by the main process via __chReloadFrame
  // when that workspace's IDE went away on its own — the workbench shut down or
  // navigated off while its iframe stayed mounted, which leaves a blank frame
  // in a live renderer process. An unknown key is a no-op: the frame
  // may have been unmounted (hibernated, deleted) since main decided.
  function reloadFrame(key: string): void {
    const el = frameEls.get(key);
    if (!el) return;
    // Re-assigning src (via a local, to dodge no-self-assign) forces a fresh
    // navigation even though the resolved URL is identical.
    const url = el.src;
    el.src = url;
    if (key === activeKey && mode === "workspace") focusFrame(el);
  }

  // Show flow: when the active workspace changes, force a paint-tree refresh
  // of the now-visible frame to work around Windows DirectComposition
  // surfaces that can come back blank after a display:none → display:block
  // toggle (the symptom in PostHog issue 019e3bd1). Reading `offsetHeight`
  // flushes layout; the transient transform forces a compositor layer
  // rebuild, which is cleared on the next frame.
  $effect(() => {
    const key = activeKey;
    if (key === null) return;
    const el = frameEls.get(key);
    if (!el) return;

    void el.offsetHeight;
    el.style.transform = "translateZ(0)";
    raf(() => {
      el.style.transform = "";
    });

    if (mode === "workspace") {
      focusFrame(el);
    }
  });

  // Mode routing: returning to workspace mode focuses the active frame
  // (replaces the old bringUIToBottom + focus); entering shortcut mode blurs
  // it so arrow keys drive shortcut navigation instead of VS Code. The first
  // effect run only records the initial mode (no action on mount).
  let previousMode: UIMode | undefined = undefined;
  $effect(() => {
    const current = mode;
    const isFirstRun = previousMode === undefined;
    if (current === previousMode) return;
    previousMode = current;
    if (isFirstRun) return;
    if (current === "workspace") {
      focusActiveFrame();
    } else if (current === "shortcut") {
      const el = activeFrame();
      if (el && document.activeElement === el) {
        el.blur();
      }
    }
  });

  onMount(() => {
    const hooks = window as FrameHooks;
    hooks.__chFocusActiveFrame = () => {
      if (mode === "workspace") focusActiveFrame();
    };
    hooks.__chActiveFrameRect = () => {
      const el = activeFrame();
      if (!el || el.style.display === "none") return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    hooks.__chReloadFrames = reloadFrames;
    hooks.__chReloadFrame = reloadFrame;

    window.addEventListener("message", handleFrameMessage);
    document.addEventListener("focusin", updateUiFocus, true);
    document.addEventListener("focusout", handleFocusOut, true);

    return () => {
      delete hooks.__chFocusActiveFrame;
      delete hooks.__chActiveFrameRect;
      delete hooks.__chReloadFrames;
      delete hooks.__chReloadFrame;
      window.removeEventListener("message", handleFrameMessage);
      document.removeEventListener("focusin", updateUiFocus, true);
      document.removeEventListener("focusout", handleFocusOut, true);
    };
  });
</script>

<div class="workspace-frames">
  {#each frames as frame (frame.key)}
    <iframe
      use:registerFrame={frame.key}
      src={frame.url}
      title="Workspace {frame.title}"
      data-key={frame.key}
      class:active={frame.key === activeKey}
      allow="clipboard-read; clipboard-write; fullscreen; cross-origin-isolated; autoplay"
      allowfullscreen
    ></iframe>
  {/each}
</div>

<style>
  /* First child of .main-view with no z-index: every later positioned
     sibling (sidebar, overlays, panel, dialogs) paints above the frames.
     pointer-events pass through the container so only the visible frame
     captures input. */
  .workspace-frames {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-workspace-left, var(--ch-sidebar-minimized-width, 20px));
    pointer-events: none;
  }

  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
    display: none;
    pointer-events: auto;
  }

  iframe.active {
    display: block;
  }
</style>
