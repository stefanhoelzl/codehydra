<!--
  App.svelte

  Root application component. Owns the single ui:state subscription + the
  ui-connected handshake (moved up from MainView so startup snapshots arrive
  during the initializing phase — the presenter pushes the boot splash / setup /
  agent-selection / loading surfaces before MainView would ever mount).

  Renders by the snapshot's main.kind:
  - startup kinds (starting / setup / agent-selection / loading) → StartupView
  - workspace / hibernated / creation → MainView
  - before the first snapshot arrives → a minimal blank initializing state

  App.svelte owns:
  - <main> element with dynamic aria-label
  - the ui:state subscription + ui-connected emit (on mount)
  - aria-live announcements for snapshot mode transitions (shortcut mode) and
    application-ready (first non-startup snapshot)
  - DialogHost for declarative dialogs from the main process

  Keyboard shortcuts (Alt+X, navigation, Escape/blur exit) and UI mode are
  fully main-owned: the renderer reads mode from the UiState snapshot.
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import * as api from "$lib/api";
  import type { UiState } from "@shared/ui-state";
  import { createLogger } from "$lib/logging";
  import { getFocusables } from "$lib/utils/focus-trap";
  import MainView from "$lib/components/MainView.svelte";
  import StartupView from "$lib/components/StartupView.svelte";
  import DialogHost from "$lib/components/DialogHost.svelte";

  const logger = createLogger("ui");

  /** Time in ms before clearing ARIA announcement to prevent repetition */
  const ARIA_ANNOUNCEMENT_CLEAR_MS = 1000;

  // Announcement message for screen readers (cleared after announcement)
  let announceMessage = $state<string>("");

  // Root container for focus management (first control on the first normal
  // snapshot).
  let containerRef = $state<HTMLElement>();

  // The single source of UI state: the latest snapshot pushed on api:ui:state.
  // $state.raw because snapshots are immutable and replaced wholesale — no deep
  // reactivity, and local patching is physically impossible (the renderer
  // cannot drift from main's truth). Null until the genesis push arrives.
  let ui = $state.raw<UiState | null>(null);
  const main = $derived(ui?.main ?? null);
  /** True once a normal (non-startup) snapshot has rendered: MainView shows. */
  const showMain = $derived(
    main !== null &&
      main.kind !== "starting" &&
      main.kind !== "setup" &&
      main.kind !== "agent-selection" &&
      main.kind !== "loading"
  );

  // Subscribe to ui:state, then emit the ui-connected handshake (on mount,
  // during the initializing phase). The subscription MUST be in place before
  // emitting: the presenter pushes the current snapshot synchronously on
  // connect and there is no replay.
  let focused = false;
  onMount(() => {
    const unsubscribe = api.onState((state) => {
      ui = state;
      // Theme ships in the snapshot (no separate channel): mirror it onto the
      // document so the global --ch-* CSS vars resolve to the OS theme.
      document.documentElement.dataset.theme = state.theme;
      // Focus the first control once, after the first normal snapshot renders
      // (the startup surfaces own their own focus).
      if (focused || state.main.kind === "starting" || state.main.kind === "setup") return;
      if (state.main.kind === "agent-selection" || state.main.kind === "loading") return;
      focused = true;
      void tick().then(() => {
        const firstFocusable = containerRef ? getFocusables(containerRef)[0] : undefined;
        firstFocusable?.focus();
      });
    });
    api.emitEvent({ kind: "ui-connected" });
    return () => {
      unsubscribe();
    };
  });

  // Announce shortcut-mode entry for screen readers, watching the snapshot
  // mode (main-owned). Fires on the transition into "shortcut".
  let prevShortcut = false;
  $effect(() => {
    const isShortcut = ui?.mode === "shortcut";
    if (isShortcut !== prevShortcut) {
      logger.debug("Shortcut mode", { enabled: isShortcut });
      if (isShortcut) {
        announceMessage = "Shortcut mode active. Use arrow keys to navigate.";
        setTimeout(() => {
          announceMessage = "";
        }, ARIA_ANNOUNCEMENT_CLEAR_MS);
      }
    }
    prevShortcut = isShortcut;
  });

  // Announce "Application ready." once when the main view becomes visible.
  let announcedReady = false;
  $effect(() => {
    if (showMain && !announcedReady) {
      announcedReady = true;
      announceMessage = "Application ready.";
      setTimeout(() => {
        announceMessage = "";
      }, ARIA_ANNOUNCEMENT_CLEAR_MS);
    }
  });

  function getAriaLabel(): string {
    return showMain ? "Application workspace" : "Application starting";
  }
</script>

<!-- Screen reader announcements for mode transitions -->
<div class="ch-visually-hidden" aria-live="polite" aria-atomic="true">
  {#if announceMessage}{announceMessage}{/if}
</div>

<main class="app" aria-label={getAriaLabel()} bind:this={containerRef}>
  {#if main === null}
    <!-- Minimal blank state until the first snapshot arrives. -->
    <div class="initializing-container" aria-busy="true"></div>
  {:else if main.kind === "starting" || main.kind === "setup" || main.kind === "agent-selection" || main.kind === "loading"}
    <StartupView {main} workspaceArea={false} />
  {:else if ui !== null}
    <div class="main-view-container">
      <MainView {ui} />
    </div>
  {/if}

  <!-- Declarative dialog host: renders dialogs driven by the main process. -->
  <DialogHost dialogs={ui?.dialogs ?? []} workspaceArea={showMain} />
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

  @media (prefers-reduced-motion: reduce) {
    .main-view-container {
      animation: none;
    }
  }
</style>
