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
</style>
