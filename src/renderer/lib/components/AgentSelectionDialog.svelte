<script lang="ts">
  /**
   * Agent selection dialog component.
   * Displayed on first run to let users choose their preferred AI agent.
   */
  import { onMount } from "svelte";
  import Logo from "./Logo.svelte";
  import Icon from "./Icon.svelte";
  import type { ConfigAgentType } from "@shared/api/types";

  interface Props {
    /** Callback when agent is selected and user clicks Continue */
    onselect: (agent: ConfigAgentType) => void;
  }

  const { onselect }: Props = $props();

  /** Available agents in order */
  const agents: ConfigAgentType[] = ["claude", "opencode"];

  /** Currently selected agent */
  let selectedAgent = $state<ConfigAgentType>("claude");

  /** Handle card selection */
  function selectAgent(agent: ConfigAgentType): void {
    selectedAgent = agent;
  }

  /** Focus the card for the given agent */
  function focusCard(agent: ConfigAgentType): void {
    const card = document.querySelector(`[data-agent="${agent}"]`) as HTMLElement | null;
    card?.focus();
  }

  /** Auto-focus selected card on mount for immediate keyboard navigation */
  onMount(() => {
    focusCard(selectedAgent);
  });

  /** Handle keyboard navigation on cards */
  function handleCardKeydown(event: KeyboardEvent, agent: ConfigAgentType): void {
    const currentIndex = agents.indexOf(agent);

    switch (event.key) {
      case "ArrowUp":
      case "ArrowLeft": {
        event.preventDefault();
        const prevIndex = currentIndex === 0 ? agents.length - 1 : currentIndex - 1;
        const prevAgent = agents[prevIndex] as ConfigAgentType;
        selectAgent(prevAgent);
        focusCard(prevAgent);
        break;
      }
      case "ArrowDown":
      case "ArrowRight": {
        event.preventDefault();
        const nextIndex = currentIndex === agents.length - 1 ? 0 : currentIndex + 1;
        const nextAgent = agents[nextIndex] as ConfigAgentType;
        selectAgent(nextAgent);
        focusCard(nextAgent);
        break;
      }
      case "Enter":
        event.preventDefault();
        handleContinue();
        break;
      case " ":
        event.preventDefault();
        selectAgent(agent);
        break;
    }
  }

  /** Handle Continue button click */
  function handleContinue(): void {
    onselect(selectedAgent);
  }
</script>

<div class="agent-selection">
  <Logo size={96} />

  <h1>Choose your AI Agent</h1>
  <p class="subtitle">Select which AI assistant to use with CodeHydra</p>

  <div class="cards" role="radiogroup" aria-label="AI Agent selection">
    <button
      type="button"
      class="card"
      class:selected={selectedAgent === "claude"}
      role="radio"
      aria-checked={selectedAgent === "claude"}
      tabindex={selectedAgent === "claude" ? 0 : -1}
      data-agent="claude"
      onclick={() => selectAgent("claude")}
      onkeydown={(e) => handleCardKeydown(e, "claude")}
    >
      <div class="card-icon">
        <Icon name="sparkle" size={32} />
      </div>
      <span class="card-title">Claude</span>
      <div class="card-indicator">
        {#if selectedAgent === "claude"}
          <Icon name="circle-filled" size={16} />
        {:else}
          <Icon name="circle-outline" size={16} />
        {/if}
      </div>
    </button>

    <button
      type="button"
      class="card"
      class:selected={selectedAgent === "opencode"}
      role="radio"
      aria-checked={selectedAgent === "opencode"}
      tabindex={selectedAgent === "opencode" ? 0 : -1}
      data-agent="opencode"
      onclick={() => selectAgent("opencode")}
      onkeydown={(e) => handleCardKeydown(e, "opencode")}
    >
      <div class="card-icon">
        <Icon name="terminal" size={32} />
      </div>
      <span class="card-title">OpenCode</span>
      <div class="card-indicator">
        {#if selectedAgent === "opencode"}
          <Icon name="circle-filled" size={16} />
        {:else}
          <Icon name="circle-outline" size={16} />
        {/if}
      </div>
    </button>
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <vscode-button onclick={handleContinue}> Continue </vscode-button>
</div>

<style>
  .agent-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
  }

  .subtitle {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .cards {
    display: flex;
    gap: 1rem;
    margin: 1rem 0;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 140px;
    padding: 1.5rem 1rem;
    border: 1px solid var(--ch-border);
    border-radius: 8px;
    background: var(--ch-panel-background);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
    color: inherit;
    font-family: inherit;
  }

  .card:hover {
    border-color: var(--ch-focus-border);
    background: var(--ch-list-hover-background);
  }

  .card:focus {
    outline: none;
    border-color: var(--ch-focus-border);
    box-shadow: 0 0 0 1px var(--ch-focus-border);
  }

  .card.selected {
    border-color: var(--ch-focus-border);
    background: var(--ch-list-active-selection-background);
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 500;
  }

  .card-indicator {
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .card.selected .card-indicator {
    opacity: 1;
    color: var(--ch-focus-border);
  }
</style>
