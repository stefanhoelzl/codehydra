<!--
  TextSection.svelte

  Text section leaf: heading, subtitle, mono block, or plain paragraph.
  Heading/subtitle/text content supports {badge:text} syntax for inline
  badges; mono blocks render their content verbatim.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { TextSectionConfig } from "./types";

  interface Props {
    section: TextSectionConfig;
  }

  const { section }: Props = $props();

  /** Parse text content for {badge:text} syntax. Returns segments. */
  function parseTextContent(content: string): Array<{ type: "text" | "badge"; value: string }> {
    const segments: Array<{ type: "text" | "badge"; value: string }> = [];
    const regex = /\{badge:([^}]+)\}/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: "text", value: content.slice(lastIndex, match.index) });
      }
      segments.push({ type: "badge", value: match[1]! });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < content.length) {
      segments.push({ type: "text", value: content.slice(lastIndex) });
    }
    return segments;
  }
</script>

{#snippet richText(content: string)}
  {#each parseTextContent(content) as seg, segIndex (segIndex)}
    {#if seg.type === "badge"}<vscode-badge>{seg.value}</vscode-badge>{:else}{seg.value}{/if}
  {/each}
{/snippet}

{#if section.style === "heading"}
  <h1 class="section-heading" class:has-icon={!!section.icon}>
    {#if section.icon}
      <span class="heading-icon" class:icon-error={section.icon === "error"}>
        <Icon name={section.icon} size={20} />
      </span>
    {/if}
    {@render richText(section.content)}
  </h1>
{:else if section.style === "subtitle"}
  <p class="section-subtitle">{@render richText(section.content)}</p>
{:else if section.style === "mono"}
  <pre class="section-mono">{section.content}</pre>
{:else}
  <p class="section-text">{@render richText(section.content)}</p>
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

  .section-mono {
    margin: 0;
    font-family: monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
    width: 100%;
    padding: 0.75rem;
    background: color-mix(in srgb, var(--ch-foreground) 5%, transparent);
    border-radius: var(--ch-radius-sm, 6px);
  }
</style>
