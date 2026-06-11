<!--
  WorkspaceFrames.svelte

  Renders one <iframe> per mountable workspace (has a code-server URL and is
  not hibernated), derived from the projects store. All frames mount eagerly
  so switching is instant; only the active workspace's frame is visible.

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

  Exposes two window hooks for the main process (UiViewManager):
  - __chFocusActiveFrame(): focus the active frame (window-focus handler,
    post-terminal-focus refresh)
  - __chActiveFrameRect(): bounding rect of the active frame (hibernation
    screenshot capture clipping)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { projects, activeWorkspacePath } from "$lib/stores/projects.svelte.js";
  import { uiMode } from "$lib/stores/ui-mode.svelte.js";

  interface FrameHooks {
    __chFocusActiveFrame?: () => void;
    __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
  }

  const frameEls = new SvelteMap<string, HTMLIFrameElement>();

  // All mountable workspaces: a code-server URL exists and not hibernated.
  // Hibernating a workspace unmounts its frame (metadata flip); waking
  // remounts it (workspace:created delivers a fresh URL).
  const frames = $derived(
    projects.value
      .flatMap((p) => p.workspaces)
      .filter((w) => w.url !== undefined && w.metadata?.["hibernated"] !== "true")
  );

  function registerFrame(el: HTMLIFrameElement, path: string): { destroy(): void } {
    frameEls.set(path, el);
    return {
      destroy() {
        frameEls.delete(path);
      },
    };
  }

  function activeFrame(): HTMLIFrameElement | undefined {
    const path = activeWorkspacePath.value;
    if (path === null) return undefined;
    return frameEls.get(path);
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

  // Show flow: when the active workspace changes, force a paint-tree refresh
  // of the now-visible frame to work around Windows DirectComposition
  // surfaces that can come back blank after a display:none → display:block
  // toggle (the symptom in PostHog issue 019e3bd1). Reading `offsetHeight`
  // flushes layout; the transient transform forces a compositor layer
  // rebuild, which is cleared on the next frame.
  $effect(() => {
    const path = activeWorkspacePath.value;
    if (path === null) return;
    const el = frameEls.get(path);
    if (!el) return;

    void el.offsetHeight;
    el.style.transform = "translateZ(0)";
    raf(() => {
      el.style.transform = "";
    });

    if (uiMode.value === "workspace") {
      focusFrame(el);
    }
  });

  // Mode routing: returning to workspace mode focuses the active frame
  // (replaces the old bringUIToBottom + focus); entering shortcut mode blurs
  // it so arrow keys drive shortcut navigation instead of VS Code.
  let previousMode = uiMode.value;
  $effect(() => {
    const mode = uiMode.value;
    if (mode === previousMode) return;
    previousMode = mode;
    if (mode === "workspace") {
      focusActiveFrame();
    } else if (mode === "shortcut") {
      const el = activeFrame();
      if (el && document.activeElement === el) {
        el.blur();
      }
    }
  });

  onMount(() => {
    const hooks = window as FrameHooks;
    hooks.__chFocusActiveFrame = () => {
      if (uiMode.value === "workspace") focusActiveFrame();
    };
    hooks.__chActiveFrameRect = () => {
      const el = activeFrame();
      if (!el || el.style.display === "none") return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return () => {
      delete hooks.__chFocusActiveFrame;
      delete hooks.__chActiveFrameRect;
    };
  });
</script>

<div class="workspace-frames">
  {#each frames as workspace (workspace.path)}
    <iframe
      use:registerFrame={workspace.path}
      src={workspace.url}
      title="Workspace {workspace.name}"
      data-path={workspace.path}
      class:active={workspace.path === activeWorkspacePath.value}
      allow="clipboard-read; clipboard-write; fullscreen; cross-origin-isolated; autoplay; camera; microphone; display-capture"
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
