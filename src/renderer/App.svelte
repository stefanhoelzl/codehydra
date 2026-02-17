<!--
  App.svelte
  
  Root application component that acts as a mode router between setup and normal app modes.
  
  Component Ownership Model:
  - App.svelte: Mode routing, global keyboard events (shortcuts), setup flow
  - MainView.svelte: Normal app state, IPC initialization, domain events (project/workspace/agent)
  
  App.svelte owns:
  - <main> element with dynamic aria-label based on mode
  - Shortcut event subscriptions (global - work in both modes)
  - Setup flow (setup screens, retry/quit handling)
  - aria-live announcements for mode transitions
  
  MainView.svelte owns:
  - IPC initialization (listProjects, getAllAgentStatuses)
  - Domain event subscriptions (project/workspace/agent changes)
  - setMode("dialog") calls when dialogs open/close
  - Sidebar, dialogs, ShortcutOverlay rendering
-->
<script lang="ts">
  import * as api from "$lib/api";
  import type { SetupRowProgress, SetupScreenProgress, ConfigAgentType } from "@shared/api/types";
  import type {
    ShowAgentSelectionPayload,
    SetupErrorPayload,
    LifecycleAgentType,
  } from "@shared/ipc";
  import {
    handleModeChange,
    handleKeyDown,
    handleWindowBlur,
    handleShortcutKey,
  } from "$lib/stores/shortcuts.svelte.js";
  import { setupState, errorSetup, resetSetup } from "$lib/stores/setup.svelte.js";
  import { loadingState } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";
  import MainView from "$lib/components/MainView.svelte";
  import SetupScreen from "$lib/components/SetupScreen.svelte";
  import SetupError from "$lib/components/SetupError.svelte";
  import AgentSelectionDialog from "$lib/components/AgentSelectionDialog.svelte";

  const logger = createLogger("ui");

  /**
   * App mode discriminated union.
   * - initializing: Checking setup status (shows loading state)
   * - agent-selection: Agent not selected (shows agent selection dialog)
   * - setup: Setup is needed (shows setup screens)
   * - loading: Services are starting (shows loading screen)
   * - ready: Services started, normal app mode (shows MainView)
   */
  type AppMode =
    | { type: "initializing" }
    | { type: "agent-selection" }
    | { type: "setup" }
    | { type: "loading" }
    | { type: "ready" };

  /** Time in ms before clearing ARIA announcement to prevent repetition */
  const ARIA_ANNOUNCEMENT_CLEAR_MS = 1000;

  let appMode = $state<AppMode>({ type: "initializing" });

  // Selected agent type (from initial getState or after user selection)
  let selectedAgent = $state<ConfigAgentType | null>(null);

  // Setup progress state - array of row progress updates
  let setupProgress = $state<SetupRowProgress[]>([]);

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

  // Subscribe to setup progress events from main process
  // Updates row state during setup
  $effect(() => {
    const unsubProgress = api.on<SetupScreenProgress>("lifecycle:setup-progress", (progress) => {
      // Event contains full row state array, replace entirely
      setupProgress = [...progress.rows];
    });
    return () => {
      unsubProgress();
    };
  });

  // Subscribe to lifecycle:show-starting event from main process
  // Main process tells us to show the starting screen (loading mode)
  $effect(() => {
    const unsub = api.on<void>("lifecycle:show-starting", () => {
      logger.debug("Showing starting screen");
      appMode = { type: "loading" };
    });
    return () => {
      unsub();
    };
  });

  // Subscribe to lifecycle:show-setup event from main process
  // Main process tells us to show the setup screen (setup mode)
  $effect(() => {
    const unsub = api.on<void>("lifecycle:show-setup", () => {
      logger.debug("Showing setup screen");
      // Clear any previous progress state when entering setup
      setupProgress = [];
      appMode = { type: "setup" };
    });
    return () => {
      unsub();
    };
  });

  // Subscribe to lifecycle:show-agent-selection event from main process
  // Main process tells us when to show the agent selection dialog
  $effect(() => {
    const unsub = api.on<ShowAgentSelectionPayload>("lifecycle:show-agent-selection", (payload) => {
      logger.debug("Showing agent selection", { agents: payload.agents.join(",") });
      // Store available agents if needed for display
      appMode = { type: "agent-selection" };
    });
    return () => {
      unsub();
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

  // Announce "Application ready." once when projects finish loading
  // (the startup overlay disappears at this point).
  // One-shot guard prevents re-announcing if reactive deps are re-read.
  let announcedReady = false;
  $effect(() => {
    if (appMode.type === "ready" && loadingState.value === "loaded" && !announcedReady) {
      announcedReady = true;
      announceMessage = "Application ready.";
      setTimeout(() => {
        announceMessage = "";
      }, ARIA_ANNOUNCEMENT_CLEAR_MS);
    }
  });

  // Subscribe to lifecycle:setup-error event from main process
  // Main process tells us when setup fails and we should show an error
  $effect(() => {
    const unsub = api.on<SetupErrorPayload>("lifecycle:setup-error", (payload) => {
      logger.warn("Setup error received", { message: payload.message, code: payload.code ?? null });
      errorSetup(payload.message);
    });
    return () => {
      unsub();
    };
  });

  // No onMount needed - main process drives the flow via IPC events
  // The renderer starts in "initializing" mode and waits for IPC instructions

  // Handle setup/service retry
  // Sends a signal to main process to retry the startup flow
  function handleSetupRetry(): void {
    resetSetup();
    // Show loading state while main process re-dispatches app:setup
    appMode = { type: "loading" };
    // Signal main process to retry
    api.sendRetry();
  }

  // Handle setup quit
  function handleSetupQuit(): void {
    void api.lifecycle.quit();
  }

  /**
   * Handle agent selection from the dialog.
   * Sends IPC event to main process with selected agent.
   * Main process will continue the setup flow and send next IPC event.
   */
  function handleAgentSelect(agent: ConfigAgentType): void {
    logger.info("Agent selected", { agent });
    // Store selected agent for display in SetupScreen
    selectedAgent = agent;
    // Clear any previous progress state
    setupProgress = [];
    // Transition to setup mode while main process continues
    appMode = { type: "setup" };
    // Send IPC event to main process
    api.sendAgentSelected(agent as LifecycleAgentType);
  }

  // Get aria-label for main element based on mode
  function getAriaLabel(): string {
    if (appMode.type === "ready") {
      return loadingState.value === "loading" ? "Loading projects" : "Application workspace";
    }
    if (appMode.type === "loading") return "Loading services";
    if (appMode.type === "agent-selection") return "Agent selection";
    if (appMode.type === "initializing") return "Application starting";
    return "Setup wizard";
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
    <div class="setup-container" aria-busy="true"></div>
  {:else if appMode.type === "agent-selection"}
    <!-- Agent selection mode - show selection dialog -->
    <div class="setup-container">
      <AgentSelectionDialog onselect={handleAgentSelect} />
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
      {:else}
        <!-- Setup in progress - main process will send lifecycle:show-main-view when done -->
        <SetupScreen
          agent={selectedAgent}
          progress={setupProgress}
          onretry={handleSetupRetry}
          onquit={handleSetupQuit}
        />
      {/if}
    </div>
  {:else if appMode.type === "loading"}
    <!-- Loading mode - starting services -->
    <div class="setup-container">
      {#if setupState.value.type === "error"}
        <SetupError
          errorMessage={setupState.value.errorMessage}
          onretry={handleSetupRetry}
          onquit={handleSetupQuit}
        />
      {:else}
        <!-- Hide progress rows when starting services (we're past setup phase) -->
        <SetupScreen message="CodeHydra is starting..." subtitle="" hideProgress={true} />
      {/if}
    </div>
  {:else}
    <!-- Ready mode - MainView must mount to call lifecycle.ready() -->
    <!-- Startup overlay stays visible until projects finish loading -->
    <div class="main-view-container" inert={loadingState.value === "loading"}>
      <MainView />
    </div>
    {#if loadingState.value === "loading"}
      <div class="startup-overlay" role="status" aria-busy="true" aria-label="Loading projects">
        <SetupScreen message="CodeHydra is starting..." subtitle="" hideProgress={true} />
      </div>
    {/if}
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

  .startup-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: var(--ch-foreground);
    background-color: var(--ch-background);
    z-index: 1000;
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
