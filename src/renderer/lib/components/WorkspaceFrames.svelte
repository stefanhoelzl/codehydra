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

  Liveness: showing a frame pings it, and it answers via the probe responder
  the UiViewManager injects alongside the focus tracker. All workspace iframes
  are same-origin, so Chromium hosts them in one shared renderer process; when
  it dies every workbench blanks at once and no main-process event reports it.
  A frame that does not answer is logged — nothing reloads on its own.

  Exposes two window hooks for the main process (UiViewManager):
  - __chFocusActiveFrame(): focus the active frame (window-focus handler,
    post-terminal-focus refresh)
  - __chActiveFrameRect(): bounding rect of the active frame (hibernation
    screenshot capture clipping)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import type { UIMode } from "@shared/ipc";
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  /**
   * How long a frame gets to answer the probe sent when it is shown. Generous:
   * a workbench whose main thread is briefly blocked, or one still loading its
   * document, must not be mistaken for a dead one. Detection only logs, so
   * erring long costs nothing.
   */
  const PROBE_TIMEOUT_MS = 5_000;

  interface FrameHooks {
    __chFocusActiveFrame?: () => void;
    __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
    __chReloadFrames?: () => void;
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

  function registerFrame(el: HTMLIFrameElement, key: string): { destroy(): void } {
    frameEls.set(key, el);
    return {
      destroy() {
        frameEls.delete(key);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Liveness
  //
  // A dead frame is indistinguishable from a live one out here, so the frame
  // has to answer for itself: showing one sends it a ping, and a frame that
  // stays silent is logged. The frames are the only witnesses to their own
  // renderer process dying — Electron surfaces no event for a subframe process
  // (PostHog issue 019fb265). Detection only reports; nothing reloads.
  // ---------------------------------------------------------------------------

  /** Keys that have answered at least once — separates dead from never-loaded. */
  const everAnswered = new SvelteSet<string>();

  /** The frame currently being probed, and its pending verdict. */
  let probeKey: string | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  function cancelProbe(): void {
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    probeTimer = undefined;
    probeKey = null;
  }

  function probeFrame(key: string, el: HTMLIFrameElement): void {
    cancelProbe();
    probeKey = key;
    try {
      el.contentWindow?.postMessage({ __chPing: true }, "*");
    } catch {
      // Cross-origin frame may reject; the timeout reports it anyway
    }
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      probeKey = null;
      logger.warn(
        everAnswered.has(key)
          ? "Workspace frame stopped responding (renderer may have died)"
          : "Workspace frame never responded (may never have finished loading)",
        { key }
      );
    }, PROBE_TIMEOUT_MS);
  }

  /** The mounted frame that sent a message, by window identity. */
  function keyForSource(source: MessageEvent["source"]): string | undefined {
    if (source === null) return undefined;
    for (const [key, el] of frameEls) {
      if (el.contentWindow === source) return key;
    }
    return undefined;
  }

  function handleFrameMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    const alive =
      typeof data === "object" &&
      data !== null &&
      (data as { __chAlive?: unknown }).__chAlive === true;
    if (!alive) return;
    const key = keyForSource(event.source);
    if (key === undefined) return;
    everAnswered.add(key);
    if (key === probeKey) cancelProbe();
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

  function focusActiveFrame(): void {
    const el = activeFrame();
    if (el) focusFrame(el);
  }

  // Reload every mounted frame by re-assigning its src (forces a navigation
  // even though the URL is unchanged — the prod IDE server port is stable
  // across a restart). Invoked by the main process via __chReloadFrames after
  // the IDE server restarts on resume, so the frames reconnect to the fresh
  // server instead of showing the IDE server's own "Reload" dialog. frameEls
  // holds exactly the mounted (non-hibernated) frames.
  function reloadFrames(): void {
    // A reloading frame is legitimately silent until its script is re-injected;
    // drop any probe in flight rather than read the navigation as a death.
    cancelProbe();
    for (const el of frameEls.values()) {
      // Re-assigning src (via a local, to dodge no-self-assign) forces a fresh
      // navigation even though the resolved URL is identical.
      const url = el.src;
      el.src = url;
    }
    if (mode === "workspace") focusActiveFrame();
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

  // Probe the frame being shown, exactly once per switch.
  //
  // Separate from the show flow above, which also tracks `mode` — that flips on
  // every sidebar hover and shortcut toggle. This effect still reruns whenever
  // the mounted set changes (frameEls is reactive), so `probedKey` is what
  // pins it to one check per switch: a workspace being created or hibernated
  // elsewhere must not re-open a verdict on the frame already on screen.
  // Leaving it unset while the element is missing is deliberate — the frame of
  // a just-created workspace registers after the switch lands, and the rerun
  // that brings it is the run that gets to probe it.
  let probedKey: string | null = null;
  $effect(() => {
    const key = activeKey;
    if (key === null) {
      cancelProbe();
      probedKey = null;
      return;
    }
    if (key === probedKey) return;
    const el = frameEls.get(key);
    if (!el) return;
    probedKey = key;
    probeFrame(key, el);
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

    window.addEventListener("message", handleFrameMessage);

    return () => {
      delete hooks.__chFocusActiveFrame;
      delete hooks.__chActiveFrameRect;
      delete hooks.__chReloadFrames;
      window.removeEventListener("message", handleFrameMessage);
      cancelProbe();
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
    left: var(--ch-sidebar-minimized-width, 20px);
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
