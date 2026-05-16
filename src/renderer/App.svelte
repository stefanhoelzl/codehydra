<!--
  App.svelte

  Root application component that acts as a mode router between initializing and ready modes.

  Component Ownership Model:
  - App.svelte: Mode routing, global keyboard events (shortcuts)
  - MainView.svelte: Normal app state, IPC initialization, domain events (project/workspace/agent)

  App.svelte owns:
  - <main> element with dynamic aria-label based on mode
  - Shortcut event subscriptions (global - work in both modes)
  - aria-live announcements for mode transitions
  - DialogHost for declarative dialogs from main process

  MainView.svelte owns:
  - IPC initialization (listProjects, getAllAgentStatuses)
  - Domain event subscriptions (project/workspace/agent changes)
  - setMode("dialog") calls when dialogs open/close
  - Sidebar, dialogs, ShortcutOverlay rendering
-->
<script lang="ts">
  import * as api from "$lib/api";
  import {
    handleModeChange,
    handleKeyDown,
    handleWindowBlur,
    handleShortcutKey,
  } from "$lib/stores/shortcuts.svelte.js";
  import { createLogger } from "$lib/logging";
  import MainView from "$lib/components/MainView.svelte";
  import DialogHost from "$lib/components/DialogHost.svelte";

  const logger = createLogger("ui");

  /**
   * App mode discriminated union.
   * - initializing: Waiting for main process IPC (shows blank/loading state)
   * - ready: Services started, normal app mode (shows MainView)
   */
  type AppMode = { type: "initializing" } | { type: "ready" };

  /** Time in ms before clearing ARIA announcement to prevent repetition */
  const ARIA_ANNOUNCEMENT_CLEAR_MS = 1000;

  let appMode = $state<AppMode>({ type: "initializing" });

  // Announcement message for screen readers (cleared after announcement)
  let announceMessage = $state<string>("");

  // Subscribe to ui:mode-changed events from main process (unified mode system)
  $effect(() => {
    const unsubModeChange = api.onModeChange((event) => {
      handleModeChange(event);
      // Log shortcut mode changes
      if (event.mode === "shortcut" || event.previousMode === "shortcut") {
        logger.debug("Shortcut mode", { enabled: event.mode === "shortcut" });
      }
      // Announce mode changes for screen readers
      if (event.mode === "shortcut") {
        announceMessage = "Shortcut mode active. Use arrow keys to navigate.";
        // Clear after timeout so it doesn't repeat
        setTimeout(() => {
          announceMessage = "";
        }, ARIA_ANNOUNCEMENT_CLEAR_MS);
      }
    });
    return () => {
      unsubModeChange();
    };
  });

  // Subscribe to shortcut:key events from main process (Stage 2.5)
  // Main process detects action keys and emits normalized ShortcutKey values
  $effect(() => {
    const unsubShortcut = api.onShortcut((key) => {
      handleShortcutKey(key);
    });
    return () => {
      unsubShortcut();
    };
  });

  // Subscribe to lifecycle:show-main-view event from main process
  // Main process tells us when setup is complete and we can show the main view.
  // Note: MainView mounts in this mode but is covered by a startup overlay
  // until projects finish loading (loadingState becomes "loaded").
  $effect(() => {
    const unsub = api.on<void>("lifecycle:show-main-view", () => {
      logger.debug("Showing main view");
      appMode = { type: "ready" };
    });
    return () => {
      unsub();
    };
  });

  // Announce "Application ready." once when the main view becomes visible.
  // One-shot guard prevents re-announcing if reactive deps are re-read.
  let announcedReady = false;
  $effect(() => {
    if (appMode.type === "ready" && !announcedReady) {
      announcedReady = true;
      announceMessage = "Application ready.";
      setTimeout(() => {
        announceMessage = "";
      }, ARIA_ANNOUNCEMENT_CLEAR_MS);
    }
  });

  // No onMount needed - main process drives the flow via IPC events
  // The renderer starts in "initializing" mode and waits for IPC instructions

  // Get aria-label for main element based on mode
  function getAriaLabel(): string {
    return appMode.type === "ready" ? "Application workspace" : "Application starting";
  }
</script>

<svelte:window onkeydowncapture={handleKeyDown} onblur={handleWindowBlur} />

<!-- Screen reader announcements for mode transitions -->
<div class="ch-visually-hidden" aria-live="polite" aria-atomic="true">
  {#if announceMessage}{announceMessage}{/if}
</div>

<main class="app" aria-label={getAriaLabel()}>
  {#if appMode.type === "initializing"}
    <!-- Minimal blank state while waiting for main process IPC -->
    <div class="initializing-container" aria-busy="true"></div>
  {:else}
    <!-- Ready mode - MainView mounts and calls lifecycle.ready() -->
    <div class="main-view-container">
      <MainView />
    </div>
  {/if}

  <!-- Declarative dialog host: renders dialogs driven by main process -->
  <DialogHost workspaceArea={appMode.type === "ready"} />
</main>

<style>
  .app {
    display: flex;
    width: 100vw;
    height: 100vh;
    color: var(--ch-foreground);
    background: transparent; /* Allow VS Code to show through UI layer */
  }

  .initializing-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    padding: 2rem;
    color: var(--ch-foreground);
    background-color: var(--ch-background);
  }

  .main-view-container {
    display: flex;
    width: 100vw;
    height: 100vh;
    animation: fadeIn 200ms ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* Respect user's motion preferences */
  @media (prefers-reduced-motion: reduce) {
    .main-view-container {
      animation: none;
    }
  }
</style>
