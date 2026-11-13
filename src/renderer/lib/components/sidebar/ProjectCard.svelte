<!--
  ProjectCard.svelte

  One project: a header bar (letter badge, name, hibernated/automated counts
  or the collapsed counts, close and +) over its rows. Every row is always in
  the page and folds open or closed, so collapsing, opening the hibernated list
  or entering Find animates.

  Clicks anywhere in the card are handled here, in one place: a click that is
  not on the hibernated button or the "Show automated workspaces" item folds
  the hibernated list away again.
-->
<script lang="ts">
  import type { UiNotification, UiProjectRow, UiWorkspaceRow } from "@shared/ui-state";
  import {
    automatedShown,
    describeRowCounts,
    projectColor,
    projectFolds,
    rowCounts,
    rowGroup,
    rowOn,
    rowHidden,
    rowQuestions,
    type RowAction,
    type SidebarView,
  } from "$lib/utils/sidebar-model.js";
  import SidebarIcon from "./SidebarIcon.svelte";
  import RowCountItems from "./RowCountItems.svelte";
  import Highlighted from "./Highlighted.svelte";
  import WorkspaceRow from "./WorkspaceRow.svelte";
  import type { TransitionConfig } from "svelte/transition";
  import type { RowMotion } from "./motion";

  interface Props {
    project: UiProjectRow;
    view: SidebarView;
    /** Normalized Find text. */
    query: string;
    notifications: readonly UiNotification[];
    /** The row the Find marker is on. */
    selectedKey: string | null;
    /** Shortcut-mode numbers by row key. */
    shortcuts: Readonly<Record<string, string>>;
    animate: boolean;
    motion: RowMotion;
    onToggleCollapsed: (project: UiProjectRow) => void;
    onSetHibernatedView: (project: UiProjectRow, view: UiProjectRow["hibernatedView"]) => void;
    onCloseProject: (project: UiProjectRow) => void;
    onNewWorkspace: (project: UiProjectRow) => void;
    onRowClick: (row: UiWorkspaceRow) => void;
    onRowAction: (action: RowAction, row: UiWorkspaceRow) => void;
  }

  const {
    project,
    view,
    query,
    notifications,
    selectedKey,
    shortcuts,
    animate,
    motion,
    onToggleCollapsed,
    onSetHibernatedView,
    onCloseProject,
    onNewWorkspace,
    onRowClick,
    onRowAction,
  }: Props = $props();

  // Transition directives need plain functions; these read the current motion.
  function arrive(node: HTMLElement, params: { key: string }): () => TransitionConfig {
    return motion.arrive(node, params);
  }
  function depart(node: HTMLElement, params: { key: string; projectId: string }): TransitionConfig {
    return motion.depart(node, params);
  }

  const folds = $derived(projectFolds(project, view));
  const finding = $derived(view.find !== null);
  const hibernated = $derived(project.workspaces.filter((row) => rowGroup(row) === "hibernated"));
  const automated = $derived(project.workspaces.filter((row) => rowGroup(row) === "automated"));
  const awake = $derived(project.workspaces.filter((row) => rowGroup(row) === "awake"));
  const on = (row: UiWorkspaceRow): boolean => rowOn(project, row, view);
  const menuOn = $derived(
    !finding && folds.expanded && automated.length > 0 && !automatedShown(project)
  );
  const delimOn = $derived(([...hibernated, ...automated].some(on) || menuOn) && awake.some(on));
  const counts = $derived(rowCounts(project.workspaces));
  // Split so an expanded header's hibernated button can hold the sleeping counts,
  // which stay where a collapsed header has them. The button has its own tooltip.
  const awakeCounts = $derived({ ...counts, hibernated: 0, automated: 0 });
  const sleepingCounts = $derived({
    busy: 0,
    loading: 0,
    idle: 0,
    freshIdle: 0,
    noAgent: 0,
    hibernated: counts.hibernated,
    automated: counts.automated,
  });
  const hibernatedOpen = $derived(project.hibernatedView !== "hidden");
  const color = $derived(projectColor(project.colorIndex));

  function handleClick(event: MouseEvent): void {
    const target = event.target as Element;
    // Buttons inside a card (answers, cancel, dismiss) are the card's own.
    if (target.closest(".note") !== null) return;
    const act = target.closest("[data-act]")?.getAttribute("data-act") ?? null;
    if (act !== "hibtoggle" && act !== "autoshow" && hibernatedOpen) {
      onSetHibernatedView(project, "hidden");
    }
    switch (act) {
      case "hibtoggle":
        onSetHibernatedView(project, hibernatedOpen ? "hidden" : "manual");
        return;
      case "autoshow":
        onSetHibernatedView(project, "all");
        return;
      case "closeproj":
        onCloseProject(project);
        return;
      case "newin":
        onNewWorkspace(project);
        return;
      case "toggle":
        if (!finding) onToggleCollapsed(project);
        return;
      case null:
        break;
      default:
        // A row's own hover action; WorkspaceRow already reported it.
        return;
    }
    const key = target.closest<HTMLElement>(".ws[data-key]")?.dataset.key;
    const row = project.workspaces.find((candidate) => candidate.key === key);
    if (row !== undefined) onRowClick(row);
  }

  function handleLeave(): void {
    if (hibernatedOpen) onSetHibernatedView(project, "hidden");
  }
</script>

{#snippet rowFold(row: UiWorkspaceRow)}
  {@const hidden = rowHidden(project, row, view)}
  <!-- A folded row stays in the page (so it can animate) but is out of reach:
       not focusable, and not there for assistive tech. -->
  <div
    class="cl rowf"
    class:open={on(row)}
    inert={hidden}
    aria-hidden={hidden ? "true" : undefined}
    in:arrive={{ key: row.key }}
    out:depart={{ key: row.key, projectId: project.id }}
  >
    <div class="clin">
      <WorkspaceRow
        {row}
        projectName={project.name}
        {query}
        selected={finding && row.key === selectedKey}
        questions={rowQuestions(notifications, row.key)}
        shortcut={shortcuts[row.key] ?? null}
        {animate}
        onAction={onRowAction}
      />
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="proj"
  class:closed={!folds.expanded}
  style:--pc={color}
  data-project-id={project.id}
  onclick={handleClick}
  onmouseleave={handleLeave}
>
  <div
    class="proj-h"
    data-act="toggle"
    title={`${folds.expanded ? "Collapse" : "Expand"} ${project.name}`}
  >
    <span class="mono-av">{project.name.slice(0, 1).toUpperCase()}</span>
    <span class="name" title={project.title}><Highlighted text={project.name} {query} /></span>
    {#if project.remote}<SidebarIcon name="cloud" class="remote" />{/if}
    <span class="cnt" title={describeRowCounts(folds.expanded ? awakeCounts : counts) || undefined}>
      <RowCountItems counts={awakeCounts} />
      {#if !folds.expanded}
        <RowCountItems counts={sleepingCounts} />
      {:else if hibernated.length + automated.length > 0}
        <button
          type="button"
          class="sleepers"
          data-act="hibtoggle"
          aria-pressed={hibernatedOpen}
          title={`${hibernatedOpen ? "Hide" : "Show"} hibernated: ${counts.hibernated} · automated: ${counts.automated}`}
        >
          <RowCountItems counts={sleepingCounts} />
          {#if counts.hibernated + counts.automated === 0}<SidebarIcon name="moon" size={11} />{/if}
        </button>
      {/if}
    </span>
    <span class="spacer"></span>
    <button
      type="button"
      class="ib hov"
      data-act="closeproj"
      title="Close project"
      aria-label="Close project"><SidebarIcon name="trash" /></button
    >
    <button
      type="button"
      class="ib"
      data-act="newin"
      title={`New workspace in ${project.name}`}
      aria-label={`New workspace in ${project.name}`}><SidebarIcon name="plus" /></button
    >
    <SidebarIcon name="chev" class="chev" />
  </div>
  <div class="body-wrap" class:open={folds.bodyOpen}>
    <div class="body-inner">
      {#if hibernated.length + automated.length > 0}
        <div class="hib-group" class:open={folds.hibernatedOpen}>
          <div class="hib-inner">
            {#each hibernated as row (row.key)}{@render rowFold(row)}{/each}
            {#if automated.length > 0}
              <div class="cl" class:open={menuOn}>
                <div class="clin">
                  <button type="button" class="auto-menu" data-act="autoshow"
                    ><SidebarIcon name="moon" />Show automated workspaces{counts.automated > 0
                      ? ` (${counts.automated})`
                      : ""}</button
                  >
                </div>
              </div>
            {/if}
            {#each automated as row (row.key)}{@render rowFold(row)}{/each}
            {#if awake.length > 0}
              <div class="cl" class:open={delimOn}>
                <div class="clin"><div class="hib-delim"><span></span></div></div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      {#each awake as row (row.key)}{@render rowFold(row)}{/each}
    </div>
  </div>
</div>

<style>
  .proj {
    background: var(--ch-sb-s2);
    border: 1px solid var(--ch-sb-line);
    border-radius: 10px;
    padding: 3px;
    margin: 8px 0 0;
    box-shadow: var(--ch-sb-card-shadow);
  }
  .proj-h {
    position: relative;
    display: flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 4px 0 6px;
    border-radius: 7px;
    color: var(--ch-sb-fg-2);
    cursor: pointer;
    background: var(--ch-sb-head);
    transition: background-color 0.12s;
  }
  .proj-h:hover {
    background: var(--ch-sb-head-hover);
  }
  .body-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .body-wrap.open {
    grid-template-rows: 1fr;
  }
  .body-inner {
    overflow: hidden;
    min-height: 0;
  }
  .body-inner > :first-child {
    margin-top: 2px;
  }
  .mono-av {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 10px;
    color: #fff;
    flex: none;
    background: var(--pc);
  }
  .name {
    flex-shrink: 100;
    max-width: 120px;
    font-weight: 600;
    font-size: 12.5px;
    color: var(--ch-sb-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .proj-h :global(.sb-icon.remote) {
    color: var(--ch-sb-fg-3);
    width: 12px;
    height: 12px;
  }
  .spacer {
    flex: 1;
  }
  .ib {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    color: var(--ch-sb-fg-2);
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
    flex: none;
  }
  .ib:hover {
    background: var(--ch-sb-s2);
    color: var(--ch-sb-fg);
  }
  .ib[data-act="closeproj"] {
    color: var(--ch-sb-danger);
  }
  .hov {
    display: none;
  }
  .proj-h:hover .hov {
    display: grid;
  }
  /* The header has no room to spare: the trash sits over whatever is left of
     the + (22px wide, past the chevron's 14px and 4px padding, 5px gaps) instead
     of pushing + and the chevron out of the card. */
  .hov {
    position: absolute;
    right: 50px;
  }
  .hov:not(:hover) {
    background: var(--ch-sb-head-hover);
  }
  /* Room for it, taken from the name before any overlap. */
  .proj-h:hover .spacer {
    flex: 1 1 27px;
  }
  .proj-h :global(.sb-icon.chev) {
    width: 12px;
    height: 12px;
    transform: rotate(90deg);
    color: var(--ch-sb-fg-3);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    margin-right: 2px;
  }
  .proj.closed .proj-h :global(.sb-icon.chev) {
    transform: none;
  }
  .sleepers {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    flex: none;
    font-variant-numeric: tabular-nums;
    border: 0;
    background: transparent;
    /* The pill reaches past its counts, which stay where a collapsed header has them. */
    padding: 2px 4px;
    margin: 0 -4px;
    border-radius: 99px;
    cursor: pointer;
  }
  .sleepers:hover {
    color: var(--ch-sb-fg);
    background: var(--ch-sb-s2);
  }
  .sleepers[aria-pressed="true"] {
    color: var(--ch-sb-fg);
    background: var(--ch-sb-s2);
    box-shadow: inset 0 0 0 1px var(--ch-sb-line-2);
  }
  .cnt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
    flex: none;
    padding: 0 2px;
  }

  .hib-group {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .hib-inner {
    overflow: hidden;
    min-height: 0;
  }
  .hib-group.open {
    grid-template-rows: 1fr;
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
  .hib-group :global(.ws:first-child) {
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
  .auto-menu {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--ch-sb-auto);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    margin: 1px 0;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
  }
  .auto-menu :global(.sb-icon) {
    width: 14px;
    height: 14px;
    margin: 0 1px;
  }
  .auto-menu:hover {
    background: color-mix(in srgb, var(--ch-sb-auto) 12%, transparent);
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

  /* while typing in Find (or with reduced motion) the layout lands at once */
  :global(.sb.instant) .body-wrap,
  :global(.sb.instant) .hib-group,
  :global(.sb.instant) .cl,
  :global(.sb.instant) .hib-inner :global(.ws),
  :global(.sb.instant) .proj-h :global(.sb-icon.chev) {
    transition: none;
  }
</style>
