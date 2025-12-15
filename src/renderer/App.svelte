<!--
  App.svelte
  
  Root application component that acts as a mode router between setup and normal app modes.
  
  Component Ownership Model:
  - App.svelte: Mode routing, global keyboard events (shortcuts), setup event subscriptions
  - MainView.svelte: Normal app state, IPC initialization, domain events (project/workspace/agent)
  
  App.svelte owns:
  - <main> element with dynamic aria-label based on mode
  - Shortcut event subscriptions (global - work in both modes)
  - Setup event subscriptions (onSetupProgress, onSetupComplete, onSetupError)
  - aria-live announcements for mode transitions
  
  MainView.svelte owns:
  - IPC initialization (listProjects, getAllAgentStatuses)
  - Domain event subscriptions (project/workspace/agent changes)
  - setMode("dialog") calls when dialogs open/close
  - Sidebar, dialogs, ShortcutOverlay rendering
-->
<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import {
    handleModeChange,
    handleKeyDown,
    handleWindowBlur,
    handleShortcutKey,
  } from "$lib/stores/shortcuts.svelte.js";
  import {
    setupState,
    updateProgress,
    completeSetup,
    errorSetup,
    resetSetup,
  } from "$lib/stores/setup.svelte.js";
  import MainView from "$lib/components/MainView.svelte";
  import SetupScreen from "$lib/components/SetupScreen.svelte";
  import SetupComplete from "$lib/components/SetupComplete.svelte";
  import SetupError from "$lib/components/SetupError.svelte";

  /**
   * App mode discriminated union.
   * - initializing: Checking setup status (shows loading state)
   * - setup: Setup is needed (shows setup screens)
   * - ready: Setup complete, normal app mode (shows MainView)
   */
  type AppMode = { type: "initializing" } | { type: "setup" } | { type: "ready" };

  /** Time in ms before clearing ARIA announcement to prevent repetition */
  const ARIA_ANNOUNCEMENT_CLEAR_MS = 1000;

  let appMode = $state<AppMode>({ type: "initializing" });

  // Announcement message for screen readers (cleared after announcement)
  let announceMessage = $state<string>("");

  // Subscribe to ui:mode-changed events from main process (unified mode system)
  $effect(() => {
    const unsubModeChange = api.onModeChange((event) => {
      handleModeChange(event);
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

  // Subscribe to setup events from main process
  $effect(() => {
    const unsubProgress = api.onSetupProgress((event) => {
      updateProgress(event.message);
    });

    const unsubComplete = api.onSetupComplete(() => {
      completeSetup();
    });

    const unsubError = api.onSetupError((event) => {
      errorSetup(event.message);
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
    };
  });

  // Check setup status on mount
  onMount(async () => {
    try {
      const { ready } = await api.setupReady();
      if (ready) {
        appMode = { type: "ready" };
      } else {
        appMode = { type: "setup" };
      }
    } catch (error) {
      // If setupReady fails, fall back to ready mode
      console.error("Setup ready check failed:", error);
      appMode = { type: "ready" };
    }
  });

  // Handle setup retry
  function handleSetupRetry(): void {
    resetSetup();
    void api.setupRetry();
  }

  // Handle setup quit
  function handleSetupQuit(): void {
    void api.setupQuit();
  }

  // Handle setup complete transition (after success screen timer)
  function handleSetupCompleteTransition(): void {
    appMode = { type: "ready" };
    // Announce mode transition for screen readers
    announceMessage = "Setup complete. Application ready.";
    // Clear after timeout so it doesn't repeat
    setTimeout(() => {
      announceMessage = "";
    }, ARIA_ANNOUNCEMENT_CLEAR_MS);
  }

  // Derive current step message for setup screen
  function getCurrentStepMessage(): string {
    if (appMode.type === "initializing") {
      return "Loading...";
    }
    if (setupState.value.type === "progress") {
      return setupState.value.message;
    }
    return "Initializing...";
  }

  // Get aria-label for main element based on mode
  function getAriaLabel(): string {
    return appMode.type === "ready" ? "Application workspace" : "Setup wizard";
  }
</script>

<svelte:window onkeydowncapture={handleKeyDown} onblur={handleWindowBlur} />

<!-- Screen reader announcements for mode transitions -->
<div class="ch-visually-hidden" aria-live="polite" aria-atomic="true">
  {#if announceMessage}{announceMessage}{/if}
</div>

<main class="app" aria-label={getAriaLabel()}>
  {#if appMode.type === "initializing"}
    <!-- Loading state while checking setup status -->
    <div class="setup-container">
      <SetupScreen currentStep="Loading..." />
    </div>
  {:else if appMode.type === "setup"}
    <!-- Setup mode - show setup screens based on setup state -->
    <div class="setup-container">
      {#if setupState.value.type === "error"}
        <SetupError
          errorMessage={setupState.value.errorMessage}
          onretry={handleSetupRetry}
          onquit={handleSetupQuit}
        />
      {:else if setupState.value.type === "complete"}
        <SetupComplete oncomplete={handleSetupCompleteTransition} />
      {:else}
        <!-- loading or progress state -->
        <SetupScreen currentStep={getCurrentStepMessage()} />
      {/if}
    </div>
  {:else}
    <!-- Ready mode - normal app with fade-in animation -->
    <!-- Uses CSS animation that respects prefers-reduced-motion -->
    <div class="main-view-container">
      <MainView />
    </div>
  {/if}
</main>

<style>
  .app {
    display: flex;
    width: 100vw;
    height: 100vh;
    color: var(--ch-foreground);
    background: transparent; /* Allow VS Code to show through UI layer */
  }

  .setup-container {
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
