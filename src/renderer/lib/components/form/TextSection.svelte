<!--
  TextSection.svelte

  Text section leaf: heading, subtitle, or plain paragraph.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { TextSectionConfig } from "./types";

  interface Props {
    section: TextSectionConfig;
  }

  const { section }: Props = $props();
</script>

{#if section.style === "heading"}
  <h1 class="section-heading" class:has-icon={!!section.icon}>
    {#if section.icon}
      <span class="heading-icon" class:icon-error={section.icon === "error"}>
        <Icon name={section.icon} size={20} />
      </span>
    {/if}
    {section.content}
  </h1>
{:else if section.style === "subtitle"}
  <p class="section-subtitle">{section.content}</p>
{:else if section.style === "warning" || section.style === "error"}
  <div class="section-alert {section.style}" role="alert">
    <span class="alert-icon">
      <Icon name={section.icon ?? "warning"} />
    </span>
    <span class="alert-text">{section.content}</span>
  </div>
{:else}
  <p class="section-text">{section.content}</p>
{/if}

<style>
  .section-heading {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .heading-icon {
    display: flex;
    align-items: center;
  }

  .icon-error {
    color: var(--ch-danger);
  }

  .section-subtitle {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .section-text {
    margin: 0;
    font-size: 0.875rem;
  }

  /* Alert box: icon + tinted background, colored by semantic style. */
  .section-alert {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--ch-radius-sm);
    font-size: 13px;
    text-align: left;
    word-break: break-word;
  }

  .section-alert.error {
    background: var(--ch-error-bg);
    color: var(--ch-error-fg);
  }

  .section-alert.error .alert-icon {
    --vscode-icon-foreground: var(--ch-error-fg);
  }

  .section-alert.warning {
    background: var(--ch-warning-bg);
    color: var(--ch-warning-fg);
  }

  .section-alert.warning .alert-icon {
    --vscode-icon-foreground: var(--ch-warning-fg);
  }

  .alert-icon {
    flex-shrink: 0;
  }
</style>
