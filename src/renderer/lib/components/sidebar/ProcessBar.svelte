<!--
  ProcessBar.svelte

  The process bar above the sidebar's footer (with the process summary on).
  Its bottom row is always there: the three level buttons on the left (total,
  breakdown, tree; the current one in the accent color) and CodeHydra's total
  on the right. Above it, by level:
  - breakdown: one row each for the workspaces, the code server and CodeHydra
    itself — they add up to the total;
  - tree: every process, under Workspaces › project › workspace › process,
    Code server and CodeHydra. Everything starts expanded; a click on a row
    with children folds it (kept while the app runs). A workspace's processes
    have a kill button on hover, which asks once more in place ("Kill?") and
    forgets the question when the pointer leaves the row. The tree takes a
    fraction of the sidebar's height (main persists it), scrolls, and its top
    edge drags to resize; a double-click resets it.

  Main owns the level and the height; the fold state and a drag in progress
  are local.
-->
<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import * as api from "$lib/api";
  import {
    PROCESS_TREE_DEFAULT_HEIGHT,
    PROCESS_TREE_MAX_HEIGHT,
    PROCESS_TREE_MIN_HEIGHT,
    type ProcessBarLevel,
    type UiProcessNode,
    type UiProcessSummary,
    type UiProcessTotals,
    type UiProcessTree,
  } from "@shared/ui-state";
  import {
    describeProcessNode,
    describeProcessSummary,
    describeProcessTotals,
    processBadgeParts,
    PROCESS_TOTALS_PENDING,
  } from "$lib/utils/process-summary.js";
  import SidebarIcon, { type SidebarIconName } from "./SidebarIcon.svelte";

  interface Props {
    level: ProcessBarLevel;
    /** CodeHydra's whole footprint; undefined until the first scan. */
    totals: UiProcessTotals | undefined;
    /** Every process (at the tree level); undefined until the first scan. */
    tree: UiProcessTree | undefined;
    /** The tree's height, a fraction of the sidebar's. */
    treeHeight: number;
  }

  const { level, totals, tree, treeHeight }: Props = $props();

  const LEVELS: readonly { level: ProcessBarLevel; icon: SidebarIconName; label: string }[] = [
    { level: "total", icon: "level-total", label: "Total" },
    { level: "breakdown", icon: "level-breakdown", label: "Breakdown" },
    { level: "tree", icon: "level-tree", label: "Process tree" },
  ];

  const totalTip = $derived(
    totals === undefined ? PROCESS_TOTALS_PENDING : describeProcessTotals(totals)
  );

  const breakdown = $derived([
    { label: "Workspaces", summary: totals?.workspaces },
    { label: "Code server", summary: totals?.codeServer },
    { label: "CodeHydra", summary: totals?.codehydra },
  ]);

  // ============ Fold state ============

  /** Rows the user folded; everything else is expanded. */
  const folded = new SvelteSet<string>();

  function toggle(key: string): void {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
  }

  const processKey = (node: UiProcessNode): string => `pid:${node.pid}:${node.startedAt ?? ""}`;

  function sum(summaries: readonly UiProcessSummary[]): UiProcessSummary {
    let cpu: number | null = null;
    let rssBytes = 0;
    let count = 0;
    for (const summary of summaries) {
      if (summary.cpuPercent !== null) cpu = (cpu ?? 0) + summary.cpuPercent;
      rssBytes += summary.rssBytes;
      count += summary.count;
    }
    return { cpuPercent: cpu, rssBytes, count };
  }

  // ============ Kill ============

  /** The process whose kill button is asking "Kill?". */
  let confirming = $state<string | null>(null);

  function kill(node: UiProcessNode): void {
    const key = processKey(node);
    if (confirming !== key) {
      confirming = key;
      return;
    }
    confirming = null;
    api.emitEvent({ kind: "kill-process", pid: node.pid, startedAt: node.startedAt });
  }

  // ============ Height ============

  let root = $state<HTMLDivElement | null>(null);
  /** The sidebar card's height, which the tree's fraction is of. */
  let sidebarHeight = $state(typeof window !== "undefined" ? window.innerHeight : 0);
  /** A drag in progress overrides the persisted fraction. */
  let liveFraction = $state<number | null>(null);
  let dragStartY = 0;
  let dragStartFraction = 0;

  $effect(() => {
    const card = root?.closest(".sb");
    if (!(card instanceof HTMLElement)) return;
    sidebarHeight = card.clientHeight;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => (sidebarHeight = card.clientHeight));
    observer.observe(card);
    return () => observer.disconnect();
  });

  // The echo of a persisted drag replaces the override.
  $effect(() => {
    void treeHeight;
    liveFraction = null;
  });

  const clampFraction = (fraction: number): number =>
    Math.min(PROCESS_TREE_MAX_HEIGHT, Math.max(PROCESS_TREE_MIN_HEIGHT, fraction));

  const fraction = $derived(clampFraction(liveFraction ?? treeHeight));
  const treePx = $derived(Math.round(fraction * sidebarHeight));

  function dragTo(event: PointerEvent): number {
    // Dragging up grows the tree: its bottom edge stays put.
    const delta = (dragStartY - event.clientY) / Math.max(1, sidebarHeight);
    return clampFraction(dragStartFraction + delta);
  }

  function handleGripDown(event: PointerEvent): void {
    event.preventDefault();
    dragStartY = event.clientY;
    dragStartFraction = fraction;
    liveFraction = fraction;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handleGripMove(event: PointerEvent): void {
    if (liveFraction === null) return;
    liveFraction = dragTo(event);
  }

  function handleGripUp(event: PointerEvent): void {
    if (liveFraction === null) return;
    const final = dragTo(event);
    liveFraction = final;
    api.emitEvent({ kind: "resize-process-tree", fraction: final });
  }

  function handleGripReset(): void {
    liveFraction = PROCESS_TREE_DEFAULT_HEIGHT;
    api.emitEvent({ kind: "resize-process-tree", fraction: PROCESS_TREE_DEFAULT_HEIGHT });
  }
</script>

{#snippet numbers(summary: UiProcessSummary | undefined, icons: boolean)}
  {@const parts = processBadgeParts(summary)}
  <span class="nums"
    ><span class="pm" data-part="cpu"
      >{#if icons}<SidebarIcon name="cpu" size={12} />{/if}<span class="v cpu">{parts.cpu}</span
      ></span
    ><span class="pm" data-part="memory"
      >{#if icons}<SidebarIcon name="memory" size={12} />{/if}<span class="v mem"
        >{parts.memory}</span
      ></span
    ><span class="pm" data-part="count"
      >{#if icons}<SidebarIcon name="processes" size={12} />{/if}<span class="v cnt"
        >{parts.count}</span
      ></span
    ></span
  >
{/snippet}

{#snippet group(
  key: string,
  label: string,
  summary: UiProcessSummary,
  depth: number,
  hasChildren: boolean
)}
  {@const open = !folded.has(key)}
  <div
    class="row grp"
    role="treeitem"
    aria-level={depth + 1}
    aria-expanded={hasChildren ? open : undefined}
    aria-selected="false"
    tabindex="-1"
    style:padding-left="{6 + depth * 8}px"
    title="{label}: {describeProcessSummary(summary)}"
    data-key={key}
    onclick={() => hasChildren && toggle(key)}
    onkeydown={(event) => {
      if (hasChildren && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggle(key);
      }
    }}
  >
    <span class="tw" class:open class:none={!hasChildren}
      ><SidebarIcon name="chev" size={10} /></span
    >
    <span class="lbl">{label}</span>
    {@render numbers(summary, false)}
  </div>
{/snippet}

{#snippet processRow(node: UiProcessNode, depth: number, killable: boolean)}
  {@const key = processKey(node)}
  {@const open = !folded.has(key)}
  {@const hasChildren = node.children.length > 0}
  <div
    class="row"
    role="treeitem"
    aria-level={depth + 1}
    aria-expanded={hasChildren ? open : undefined}
    aria-selected="false"
    tabindex="-1"
    style:padding-left="{6 + depth * 8}px"
    title={describeProcessNode(node)}
    data-key={key}
    onclick={() => hasChildren && toggle(key)}
    onkeydown={(event) => {
      if (hasChildren && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggle(key);
      }
    }}
    onmouseleave={() => {
      if (confirming === key) confirming = null;
    }}
  >
    <span class="tw" class:open class:none={!hasChildren}
      ><SidebarIcon name="chev" size={10} /></span
    >
    <span class="lbl">{node.name}<span class="pid">{node.pid}</span></span>
    {#if killable}
      <button
        type="button"
        class="kill"
        class:confirm={confirming === key}
        title={confirming === key
          ? `Click again to kill ${node.name} and what it started`
          : `Kill ${node.name} and what it started`}
        aria-label={confirming === key ? `Confirm killing ${node.name}` : `Kill ${node.name}`}
        onclick={(event) => {
          event.stopPropagation();
          kill(node);
        }}
        >{#if confirming === key}Kill?{:else}<SidebarIcon name="close" size={10} />{/if}</button
      >
    {/if}
    {@render numbers(node.subtree, false)}
  </div>
  {#if open}
    {#each node.children as child (processKey(child))}
      {@render processRow(child, depth + 1, killable)}
    {/each}
  {/if}
{/snippet}

<div class="pbar" bind:this={root}>
  {#if level === "tree"}
    <div class="tree-wrap" style:height="{treePx}px">
      <div
        class="grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the process tree"
        title="Drag to resize, double-click to reset"
        onpointerdown={handleGripDown}
        onpointermove={handleGripMove}
        onpointerup={handleGripUp}
        ondblclick={handleGripReset}
      ></div>
      <div class="tree" role="tree" aria-label="Processes">
        {#if tree === undefined}
          <div class="pending">Not measured yet</div>
        {:else}
          {@const workspacesTotal = sum(tree.projects.map((project) => project.total))}
          {@render group(
            "g:workspaces",
            "Workspaces",
            workspacesTotal,
            0,
            tree.projects.length > 0
          )}
          {#if !folded.has("g:workspaces")}
            {#each tree.projects as project (project.id)}
              {@const projectKey = `p:${project.id}`}
              {@render group(projectKey, project.name, project.total, 1, true)}
              {#if !folded.has(projectKey)}
                {#each project.workspaces as workspace (workspace.key)}
                  {@const workspaceKey = `w:${workspace.key}`}
                  {@render group(workspaceKey, workspace.name, workspace.total, 2, true)}
                  {#if !folded.has(workspaceKey)}
                    {#each workspace.processes as node (processKey(node))}
                      {@render processRow(node, 3, true)}
                    {/each}
                  {/if}
                {/each}
              {/if}
            {/each}
          {/if}
          {#each [{ key: "g:codeServer", label: "Code server", nodes: tree.codeServer }, { key: "g:codehydra", label: "CodeHydra", nodes: tree.codehydra }] as part (part.key)}
            {@render group(
              part.key,
              part.label,
              sum(part.nodes.map((node) => node.subtree)),
              0,
              part.nodes.length > 0
            )}
            {#if !folded.has(part.key)}
              {#each part.nodes as node (processKey(node))}
                {@render processRow(node, 1, false)}
              {/each}
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {:else if level === "breakdown"}
    <div class="parts">
      {#each breakdown as part (part.label)}
        <div
          class="row part"
          title={part.summary === undefined
            ? `${part.label}: not measured yet`
            : `${part.label}: ${describeProcessSummary(part.summary)}`}
        >
          <span class="lbl">{part.label}</span>
          {@render numbers(part.summary, false)}
        </div>
      {/each}
    </div>
  {/if}

  <div class="total">
    <div class="levels" role="group" aria-label="Process bar level">
      {#each LEVELS as option (option.level)}
        <button
          type="button"
          class="lv"
          class:on={level === option.level}
          title={option.label}
          aria-label={option.label}
          aria-pressed={level === option.level}
          onclick={() => api.emitEvent({ kind: "set-sidebar-process-summary", mode: option.level })}
          ><SidebarIcon name={option.icon} size={14} /></button
        >
      {/each}
    </div>
    <span class="proc" title={totalTip} aria-label={totalTip}>
      {@render numbers(totals?.all, true)}
    </span>
  </div>
</div>

<style>
  .pbar {
    border-top: 1px solid var(--ch-sb-line);
    font-size: 11px;
    color: var(--ch-sb-fg-2);
    font-variant-numeric: tabular-nums;
  }
  /* Right edge in line with an idle row's badge: the list's 6px, the card's 1px
     border and 3px padding, the row's 8px and the 10px gap before its (empty)
     end column. */
  .total,
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 28px;
  }
  .total {
    padding-top: 3px;
    padding-bottom: 3px;
    padding-left: 8px;
  }
  .levels {
    display: flex;
    gap: 2px;
    margin-right: auto;
  }
  .lv {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 5px;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--ch-sb-fg-3);
    cursor: pointer;
  }
  .lv:hover {
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
  }
  .lv.on {
    color: var(--ch-sb-accent);
  }
  .proc {
    display: block;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .nums {
    display: inline-flex;
    flex: none;
    gap: 10px;
    white-space: nowrap;
  }
  .pm {
    display: inline-flex;
    align-items: center;
  }
  .pm :global(.sb-icon) {
    margin-right: 4px;
    color: var(--ch-sb-fg-3);
  }
  /* Fixed widths, so every row's numbers line up under the total's. */
  .v {
    display: inline-block;
    text-align: right;
  }
  .v.cpu {
    min-width: 4ch;
  }
  .v.mem {
    min-width: 4.5ch;
  }
  .v.cnt {
    min-width: 3ch;
  }
  .parts .row,
  .tree .row {
    padding-top: 2px;
    padding-bottom: 2px;
  }
  /* Breakdown rows: indent the numbers by an icon's width each, under the total's.
     The tree keeps that room for the names. */
  .parts .pm::before {
    content: "";
    width: 16px;
    flex: none;
  }
  .tree .nums {
    gap: 6px;
  }
  .parts {
    padding-top: 3px;
  }
  .part {
    padding-left: 12px;
  }
  .lbl {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grp .lbl {
    color: var(--ch-sb-fg);
  }
  .pid {
    margin-left: 6px;
    color: var(--ch-sb-fg-3);
  }

  .tree-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .grip {
    position: absolute;
    left: 0;
    right: 0;
    top: -3px;
    height: 6px;
    cursor: ns-resize;
    z-index: 1;
    touch-action: none;
  }
  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 3px 0;
    scrollbar-width: thin;
    scrollbar-color: var(--ch-sb-line-2) transparent;
  }
  .tree .row {
    position: relative;
    cursor: default;
    user-select: none;
  }
  .tree .row:hover {
    background: var(--ch-sb-s2);
  }
  .tree .row[aria-expanded] {
    cursor: pointer;
  }
  .pending {
    padding: 4px 12px;
    color: var(--ch-sb-fg-3);
  }
  .tw {
    width: 10px;
    display: inline-grid;
    place-items: center;
    flex: none;
    color: var(--ch-sb-fg-3);
    transition: transform 0.15s;
  }
  .tw.open {
    transform: rotate(90deg);
  }
  .tw.none {
    visibility: hidden;
  }
  /* In the row's right padding, so a killable row's numbers line up with the rest. */
  .kill {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    height: 16px;
    min-width: 16px;
    padding: 0 3px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--ch-sb-fg-3);
    display: grid;
    place-items: center;
    font: inherit;
    cursor: pointer;
    visibility: hidden;
  }
  .row:hover .kill,
  .kill:focus-visible,
  .kill.confirm {
    visibility: visible;
  }
  .kill:hover {
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
  }
  .kill.confirm {
    color: var(--ch-sb-danger);
    background: var(--ch-sb-s3);
    font-weight: 600;
  }
</style>
