<!--
  Highlighted.svelte

  Text with the first match of each word of the Find text marked.
-->
<script lang="ts">
  import { highlightParts } from "$lib/utils/sidebar-model.js";

  interface Props {
    text: string;
    /** The normalized Find text; empty marks nothing. */
    query: string;
  }

  const { text, query }: Props = $props();
  const parts = $derived(highlightParts(text, query));
</script>

{#each parts as part, index (index)}{#if part.marked}<mark>{part.text}</mark
    >{:else}{part.text}{/if}{/each}

<style>
  mark {
    background: var(--ch-sb-hl);
    color: inherit;
    border-radius: 2px;
  }
</style>
