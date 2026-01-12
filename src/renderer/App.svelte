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
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import type { ConfigAgentType } from "$lib/api";
  import type { SetupRowProgress, SetupScreenProgress } from "@shared/api/types";
  import { getErrorMessage } from "@shared/error-utils";
  import {
    handleModeChange,
    handleKeyDown,
    handleWindowBlur,
    handleShortcutKey,
  } from "$lib/stores/shortcuts.svelte.js";
  import { setupState, completeSetup, errorSetup, resetSetup } from "$lib/stores/setup.svelte.js";
  import { createLogger } from "$lib/logging";
  import MainView from "$lib/components/MainView.svelte";
  import SetupScreen from "$lib/components/SetupScreen.svelte";
  import SetupComplete from "$lib/components/SetupComplete.svelte";
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

  // Check setup status on mount
  onMount(async () => {
    try {
      const result = await api.lifecycle.getState();
      // Store selected agent for display in SetupScreen
      selectedAgent = result.agent;
      if (result.state === "agent-selection") {
        // Agent not selected - show selection dialog
        appMode = { type: "agent-selection" };
      } else if (result.state === "loading") {
        // No setup needed, but services not started yet
        appMode = { type: "loading" };
        void runStartServices();
      } else if (result.state === "setup") {
        // Setup needed - start setup automatically
        appMode = { type: "setup" };
        void runSetup();
      } else {
        // Unexpected "ready" state (should not happen with new flow)
        appMode = { type: "ready" };
      }
    } catch (error) {
      // If lifecycle.getState() fails, try to start services anyway
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "App", error: message });
      console.error("Setup state check failed:", error);
      appMode = { type: "loading" };
      void runStartServices();
    }
  });

  /**
   * Run the setup process via lifecycle API.
   * On success, transitions to loading state to start services.
   */
  async function runSetup(): Promise<void> {
    try {
      const result = await api.lifecycle.setup();
      if (result.success) {
        completeSetup();
      } else {
        errorSetup(result.message);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "App", error: message });
      errorSetup(message);
    }
  }

  /**
   * Start application services via lifecycle API.
   * Called after setup completes or when getState returns "loading".
   */
  async function runStartServices(): Promise<void> {
    try {
      const result = await api.lifecycle.startServices();
      if (result.success) {
        appMode = { type: "ready" };
        // Announce mode transition for screen readers
        announceMessage = "Application ready.";
        setTimeout(() => {
          announceMessage = "";
        }, ARIA_ANNOUNCEMENT_CLEAR_MS);
      } else {
        // Show error with retry option
        errorSetup(result.message);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "App", error: message });
      errorSetup(message);
    }
  }

  // Handle setup/service retry
  function handleSetupRetry(): void {
    resetSetup();
    // If we're in loading mode, retry startServices, otherwise retry setup
    if (appMode.type === "loading") {
      void runStartServices();
    } else {
      void runSetup();
    }
  }

  // Handle setup quit
  function handleSetupQuit(): void {
    void api.lifecycle.quit();
  }

  // Handle setup complete transition (after success screen timer)
  // Transitions to loading state to start services
  function handleSetupCompleteTransition(): void {
    appMode = { type: "loading" };
    // Start services after setup completes
    void runStartServices();
  }

  /**
   * Handle agent selection from the dialog.
   * Saves selection via API and proceeds to setup or loading.
   */
  async function handleAgentSelect(agent: ConfigAgentType): Promise<void> {
    try {
      const result = await api.lifecycle.setAgent(agent);
      if (result.success) {
        logger.info("Agent selected", { agent });
        // Store selected agent for display in SetupScreen
        selectedAgent = agent;
        // Clear any previous progress state
        setupProgress = [];
        // Re-check state after selection (will return setup or loading)
        const stateResult = await api.lifecycle.getState();
        if (stateResult.state === "setup") {
          appMode = { type: "setup" };
          void runSetup();
        } else {
          appMode = { type: "loading" };
          void runStartServices();
        }
      } else {
        errorSetup(result.message);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "App", error: message });
      errorSetup(message);
    }
  }

  // Get aria-label for main element based on mode
  function getAriaLabel(): string {
    if (appMode.type === "ready") return "Application workspace";
    if (appMode.type === "loading") return "Loading services";
    if (appMode.type === "agent-selection") return "Agent selection";
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
    <!-- Loading state while checking setup status -->
    <div class="setup-container">
      <SetupScreen />
    </div>
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
      {:else if setupState.value.type === "complete"}
        <SetupComplete oncomplete={handleSetupCompleteTransition} />
      {:else}
        <!-- loading state -->
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
