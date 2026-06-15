<!--
  StartupView.svelte

  Renders the four first-run / boot startup surfaces from the UiState snapshot's
  `main` field, in place of MainView. The startup flow is fully main-owned: the
  presenter pushes these `main` kinds during app:start (before app:started), and
  this component is a pure render function over them. Gestures (agent pick, setup
  retry/quit) are fire-and-forget ui:events.

  Surfaces:
  - starting        → centered spinner + "CodeHydra is starting…"
  - setup           → "Setting up CodeHydra" + progress rows; on error a message
                      + Retry/Quit buttons
  - agent-selection → "Choose Agent" radio cards + Continue
  - loading         → centered spinner + label
-->
<script lang="ts">
  import * as api from "$lib/api";
  import Icon from "./Icon.svelte";
  import Logo from "./Logo.svelte";
  import type { UiAgentOption, UiSetupRow } from "@shared/ui-state";

  type StartupMain =
    | { kind: "starting" }
    | { kind: "setup"; rows: readonly UiSetupRow[]; error?: { message: string } }
    | { kind: "agent-selection"; agents: readonly UiAgentOption[] }
    | { kind: "loading"; label: string };

  interface Props {
    main: StartupMain;
    /** When true, offset left to keep the sidebar visible. */
    workspaceArea?: boolean;
  }

  const { main, workspaceArea = false }: Props = $props();

  /** Local agent selection: seeded once from the first option per surface. */
  let selectedAgent = $state<string | null>(null);
  let seededAgents: readonly UiAgentOption[] | null = null;
  $effect(() => {
    if (main.kind !== "agent-selection") {
      seededAgents = null;
      return;
    }
    if (seededAgents !== main.agents) {
      seededAgents = main.agents;
      selectedAgent = main.agents[0]?.agent ?? null;
    }
  });

  function rowIcon(status: UiSetupRow["status"]): { name: string; spin: boolean } {
    switch (status) {
      case "done":
        return { name: "check", spin: false };
      case "error":
        return { name: "error", spin: false };
      case "running":
        return { name: "sync", spin: true };
      default:
        return { name: "circle-large-outline", spin: false };
    }
  }

  function continueAgent(): void {
    if (selectedAgent === null) return;
    api.emitEvent({ kind: "agent-selected", agent: selectedAgent });
  }

  function retrySetup(): void {
    api.emitEvent({ kind: "setup-retry" });
  }

  function quitSetup(): void {
    api.emitEvent({ kind: "setup-quit" });
  }
</script>

<div class="startup-view" class:workspace-area={workspaceArea} role="dialog" aria-label="Starting">
  <div class="backdrop" aria-hidden="true">
    <Logo />
  </div>

  <div class="card">
    {#if main.kind === "starting"}
      <div class="spinner-block" aria-live="polite">
        <Icon name="sync" spin size={28} />
        <p class="message">CodeHydra is starting…</p>
      </div>
    {:else if main.kind === "loading"}
      <div class="spinner-block" aria-live="polite">
        <Icon name="sync" spin size={28} />
        <p class="message">{main.label}</p>
      </div>
    {:else if main.kind === "setup"}
      <h1 class="heading">Setting up CodeHydra</h1>
      <p class="subtitle">This is only required on first startup.</p>
      <ul class="rows">
        {#each main.rows as row (row.id)}
          {@const icon = rowIcon(row.status)}
          <li class="row" class:error={row.status === "error"}>
            <Icon name={icon.name} spin={icon.spin} />
            <span class="row-label">{row.label}</span>
            {#if row.message}<span class="row-message">{row.message}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if main.error}
        <p class="error-message" role="alert">{main.error.message}</p>
        <div class="actions">
          <button type="button" class="action-button primary" onclick={retrySetup}>Retry</button>
          <button type="button" class="action-button" onclick={quitSetup}>Quit</button>
        </div>
      {/if}
    {:else if main.kind === "agent-selection"}
      <h1 class="heading">Choose Agent</h1>
      <div class="agents" role="radiogroup" aria-label="Choose Agent">
        {#each main.agents as agent (agent.agent)}
          <button
            type="button"
            class="agent-card"
            class:selected={selectedAgent === agent.agent}
            role="radio"
            aria-checked={selectedAgent === agent.agent}
            onclick={() => (selectedAgent = agent.agent)}
          >
            <Icon name={agent.icon} size={24} />
            <span class="agent-label">{agent.label}</span>
          </button>
        {/each}
      </div>
      <div class="actions">
        <button
          type="button"
          class="action-button primary"
          onclick={continueAgent}
          disabled={selectedAgent === null}
        >
          Continue
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .startup-view {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--ch-surface-0, var(--ch-background));
    z-index: 900;
  }

  .startup-view.workspace-area {
    left: var(--ch-sidebar-minimized-width, 20px);
  }

  .backdrop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: var(--ch-logo-backdrop-opacity, 0.15);
    pointer-events: none;
  }

  .card {
    position: relative;
    max-width: 500px;
    width: 100%;
    padding: 2rem;
    text-align: center;
    background: color-mix(in srgb, var(--ch-surface-1, var(--ch-background)) 90%, transparent);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-lg, 14px);
    box-shadow: var(--ch-shadow);
    color: var(--ch-foreground);
  }

  .spinner-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .message {
    margin: 0;
    font-size: 1rem;
  }

  .heading {
    margin: 0 0 0.25rem;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .subtitle {
    margin: 0 0 1.5rem;
    color: var(--ch-foreground-muted, var(--ch-foreground));
    opacity: 0.8;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    text-align: left;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .row.error {
    color: var(--ch-error, #f48771);
  }

  .row-message {
    margin-left: auto;
    opacity: 0.7;
    font-size: 0.85rem;
  }

  .error-message {
    margin: 1.5rem 0 0;
    color: var(--ch-error, #f48771);
  }

  .actions {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }

  .action-button {
    padding: 0.4rem 1.25rem;
    font: inherit;
    border-radius: var(--ch-radius, 4px);
    border: 1px solid var(--ch-border);
    background: var(--vscode-button-secondaryBackground, var(--ch-surface-2, #3a3d41));
    color: var(--vscode-button-secondaryForeground, var(--ch-foreground));
    cursor: pointer;
  }

  .action-button.primary {
    border-color: transparent;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }

  .action-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  .action-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .agents {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .agent-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: transparent;
    color: var(--ch-foreground);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius, 8px);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .agent-card:hover {
    background: var(--ch-surface-2, var(--ch-background));
  }

  .agent-card.selected {
    border-color: var(--ch-focus-border, var(--vscode-focusBorder, #007fd4));
    background: color-mix(in srgb, var(--ch-focus-border, #007fd4) 12%, transparent);
  }

  .agent-label {
    font-size: 0.95rem;
  }
</style>
