<!--
  HibernatedList.svelte

  A project's folded list of sleeping workspaces, shared by its card and its
  line in the "Inactive projects" entry: the hibernated rows (most recently
  hibernated first), then the automated ones (in their own color). It folds
  open and shut as one, its rows fade in, and folded it is out of reach (inert).

  The rows are the parent's (`row`), so each keeps its own fold, transitions and
  Find state.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { UiProjectRow, UiWorkspaceRow } from "@shared/ui-state";
  import { rowGroup } from "$lib/utils/sidebar-model.js";

  interface Props {
    project: UiProjectRow;
    /** The list is unfolded. */
    open: boolean;
    /**
     * Awake rows follow the list: a dashed delimiter closes it, shown while
     * this is true. Leave it out where nothing follows.
     */
    delimiter?: boolean | undefined;
    /** Indented under its line, with a dashed guide on the left (the Inactive projects entry). */
    indented?: boolean;
    /** Renders one of the project's sleeping rows. */
    row: Snippet<[UiWorkspaceRow]>;
  }

  const { project, open, delimiter = undefined, indented = false, row }: Props = $props();

  const hibernated = $derived(project.workspaces.filter((ws) => rowGroup(ws) === "hibernated"));
  const automated = $derived(project.workspaces.filter((ws) => rowGroup(ws) === "automated"));
</script>

<div class="hib-group" class:open class:indented inert={!open}>
  <div class="hib-inner">
    {#each hibernated as ws (ws.key)}{@render row(ws)}{/each}
    {#each automated as ws (ws.key)}{@render row(ws)}{/each}
    {#if delimiter !== undefined}
      <div class="cl" class:open={delimiter}>
        <div class="clin"><div class="hib-delim"><span></span></div></div>
      </div>
    {/if}
  </div>
</div>

<style>
  .hib-group {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .hib-group.open {
    grid-template-rows: 1fr;
  }
  .hib-group.indented {
    margin-left: 12px;
  }
  .hib-inner {
    overflow: hidden;
    min-height: 0;
  }
  .indented .hib-inner {
    border-left: 1px dashed var(--ch-sb-line-2);
    padding-left: 4px;
  }
  .hib-group .hib-inner :global(.ws) {
    transition:
      opacity 0.2s,
      transform 0.24s cubic-bezier(0.3, 0.7, 0.2, 1);
  }
  .hib-group:not(.open) .hib-inner :global(.ws) {
    opacity: 0;
    transform: translateY(-6px);
  }
  .hib-group:not(.indented) :global(.ws:first-child) {
    margin-top: 2px;
  }
  .cl {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.22s;
  }
  .cl.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }
  .clin {
    overflow: hidden;
    min-height: 0;
    overflow-clip-margin: 5px;
  }
  .cl:not(.open) {
    pointer-events: none;
  }
  .hib-delim {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 3px 8px 4px;
  }
  .hib-delim::before,
  .hib-delim::after {
    content: "";
    flex: 1;
    height: 1px;
    background: repeating-linear-gradient(90deg, var(--ch-sb-line-2) 0 4px, transparent 4px 8px);
  }
  .hib-delim span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--ch-sb-line-2);
  }

  /* while typing in Find (or with reduced motion) the list lands at once */
  :global(.sb.instant) .hib-group,
  :global(.sb.instant) .cl,
  :global(.sb.instant) .hib-inner :global(.ws) {
    transition: none;
  }
</style>
