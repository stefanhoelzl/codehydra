<!--
  RowCountItems.svelte

  The sidebar's workspace counts: each non-zero count with the glyph of what it
  counts, in one order. The items are this component's root elements; the caller
  lays them out (a flex row with its own gap) and sets the font.
-->
<script lang="ts">
  import type { RowCounts } from "$lib/utils/sidebar-model.js";
  import SidebarIcon from "./SidebarIcon.svelte";

  interface Props {
    counts: RowCounts;
    /** Spinners stand still. */
    still?: boolean;
  }

  const { counts, still = false }: Props = $props();
</script>

{#if counts.busy > 0}<i><span class="ring busy" class:still></span>{counts.busy}</i>{/if}
{#if counts.loading > 0}<i class="loading"><span class="ring" class:still></span>{counts.loading}</i
  >{/if}
{#if counts.idle > 0}<i><span class="dot idle"></span>{counts.idle}</i>{/if}
{#if counts.noAgent > 0}<i class="none"><span class="dot"></span>{counts.noAgent}</i>{/if}
{#if counts.hibernated > 0}<i class="hib"
    ><SidebarIcon name="moon" size={11} />{counts.hibernated}</i
  >{/if}
{#if counts.automated > 0}<i class="auto"
    ><SidebarIcon name="alarm" size={11} />{counts.automated}</i
  >{/if}

<style>
  i {
    font-style: normal;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .ring {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--ch-sb-busy-track);
    border-top-color: var(--ch-sb-busy);
    animation: spin 0.9s linear infinite;
    display: block;
    box-sizing: border-box;
  }
  .loading .ring {
    border-color: var(--ch-sb-spin-track);
    border-top-color: var(--ch-sb-spin-head);
  }
  .ring.still {
    animation: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: block;
    background: var(--ch-sb-idle);
  }
  /* No agent: the row's hollow dot, at the count's size. */
  .none .dot {
    box-sizing: border-box;
    background: none;
    border: 1.5px solid var(--ch-sb-fg-3);
  }
  .auto {
    color: var(--ch-sb-auto);
  }
</style>
