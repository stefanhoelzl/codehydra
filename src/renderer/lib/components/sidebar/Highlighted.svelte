<!--
  Highlighted.svelte

  Text with the first match of the Find text marked.
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

{#if parts === null}{text}{:else}{parts.before}<mark>{parts.match}</mark>{parts.after}{/if}

<style>
  mark {
    background: var(--ch-sb-hl);
    color: inherit;
    border-radius: 2px;
  }
</style>
