<!--
  InactiveProjects.svelte

  The "Inactive projects" entry at the top of the sidebar's list: the projects
  without an awake workspace (see isInactive), folded into one slim card. Its
  header stacks their letter badges and sums their hibernated (moon) and
  automated (alarm) workspaces; a click unfolds one line per project.

  A line opens the New workspace form for its project; its moon/alarm button
  unfolds the project's hibernated workspaces below it (main's per-project
  hibernated view, as on a project card), where a click wakes one — the project
  then has an awake workspace and leaves this entry for a card of its own. The
  trash closes the project.

  Whether the entry is open is the sidebar's (local, never persisted). It folds
  shut a moment after the pointer leaves it, and every hibernated list in it
  with it; a line's own list folds as the pointer leaves the line.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    HibernatedView,
    UiNotification,
    UiProjectRow,
    UiWorkspaceRow,
  } from "@shared/ui-state";
  import {
    describeRowCounts,
    moonToggle,
    projectColor,
    rowCounts,
    rowOn,
    rowQuestions,
    sleepingCounts,
    type RowAction,
    type SidebarView,
  } from "$lib/utils/sidebar-model.js";
  import SidebarIcon from "./SidebarIcon.svelte";
  import RowCountItems from "./RowCountItems.svelte";
  import WorkspaceRow from "./WorkspaceRow.svelte";
  import HibernatedList from "./HibernatedList.svelte";

  interface Props {
    /** The inactive projects, in main's order. */
    projects: readonly UiProjectRow[];
    notifications: readonly UiNotification[];
    /** The entry is unfolded. */
    open: boolean;
    animate: boolean;
    onSetOpen: (open: boolean) => void;
    onSetHibernatedView: (project: UiProjectRow, view: HibernatedView) => void;
    onCloseProject: (project: UiProjectRow) => void;
    onNewWorkspace: (project: UiProjectRow) => void;
    onRowClick: (row: UiWorkspaceRow) => void;
    onRowAction: (action: RowAction, row: UiWorkspaceRow) => void;
  }

  const {
    projects,
    notifications,
    open,
    animate,
    onSetOpen,
    onSetHibernatedView,
    onCloseProject,
    onNewWorkspace,
    onRowClick,
    onRowAction,
  }: Props = $props();

  /** How long the pointer may be away before the entry folds shut. */
  const LEAVE_DELAY_MS = 300;
  /** Letter badges stacked in the header before "+N". */
  const STACKED = 3;

  /** The entry's rows are outside Find, and a project's collapsed card does not apply here. */
  const REST: SidebarView = { find: null, query: "" };
  const unfolded = (project: UiProjectRow): UiProjectRow =>
    project.collapsed ? { ...project, collapsed: false } : project;

  const counts = $derived(rowCounts(projects.flatMap((project) => project.workspaces)));
  const sleeping = $derived(sleepingCounts(counts));
  const stacked = $derived(projects.slice(0, STACKED));
  const more = $derived(projects.length - stacked.length);
  const summary = $derived(
    [
      `${projects.length} inactive ${projects.length === 1 ? "project" : "projects"}`,
      projects.map((project) => project.name).join(", "),
      describeRowCounts(sleeping),
    ]
      .filter((part) => part !== "")
      .join(" · ")
  );

  let leaveTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearLeave(): void {
    if (leaveTimeout !== null) {
      clearTimeout(leaveTimeout);
      leaveTimeout = null;
    }
  }

  function hideHibernated(project: UiProjectRow): void {
    if (project.hibernatedView !== "hidden") onSetHibernatedView(project, "hidden");
  }

  function handleLeave(): void {
    clearLeave();
    leaveTimeout = setTimeout(() => {
      leaveTimeout = null;
      for (const project of projects) hideHibernated(project);
      if (open) onSetOpen(false);
    }, LEAVE_DELAY_MS);
  }

  onDestroy(clearLeave);

  function letter(project: UiProjectRow): string {
    return project.name.slice(0, 1).toUpperCase();
  }

  function handleLineClick(project: UiProjectRow, event: MouseEvent): void {
    const target = event.target as Element;
    const act = target.closest("[data-act]")?.getAttribute("data-act") ?? null;
    if (act !== "hibtoggle") hideHibernated(project);
    switch (act) {
      case "hibtoggle":
        onSetHibernatedView(project, moonToggle(project.hibernatedView));
        return;
      case "closeproj":
        onCloseProject(project);
        return;
      case "newin":
        onNewWorkspace(project);
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
</script>

{#snippet line(project: UiProjectRow)}
  {@const shown = unfolded(project)}
  {@const lineCounts = sleepingCounts(rowCounts(project.workspaces))}
  {@const sleepers = lineCounts.hibernated + lineCounts.automated > 0}
  {@const listOpen = project.hibernatedView !== "hidden"}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="iproj"
    style:--pc={projectColor(project.colorIndex)}
    data-project-id={project.id}
    onclick={(event) => handleLineClick(project, event)}
    onmouseleave={() => hideHibernated(project)}
  >
    <div class="iline" data-act="newin" title={`New workspace in ${project.name}`}>
      <span class="mono-av">{letter(project)}</span>
      <span class="name" title={project.title}>{project.name}</span>
      {#if project.remote}<SidebarIcon name="cloud" class="remote" />{/if}
      {#if sleepers}
        <button
          type="button"
          class="sleepers"
          data-act="hibtoggle"
          aria-pressed={listOpen}
          title={`${listOpen ? "Hide" : "Show"} hibernated: ${lineCounts.hibernated} · automated: ${lineCounts.automated}`}
        >
          <RowCountItems counts={lineCounts} />
        </button>
      {/if}
      <span class="spacer"></span>
      <button
        type="button"
        class="ib hov"
        data-act="closeproj"
        title="Close project"
        aria-label={`Close project ${project.name}`}><SidebarIcon name="trash" /></button
      >
      <button
        type="button"
        class="ib plus"
        data-act="newin"
        title={`New workspace in ${project.name}`}
        aria-label={`New workspace in ${project.name}`}><SidebarIcon name="plus" /></button
      >
    </div>
    {#if sleepers}
      {#snippet row(ws: UiWorkspaceRow)}{@render rowFold(shown, ws)}{/snippet}
      <HibernatedList project={shown} open={listOpen} indented {row} />
    {/if}
  </div>
{/snippet}

{#snippet rowFold(project: UiProjectRow, row: UiWorkspaceRow)}
  {@const on = rowOn(project, row, REST)}
  <div class="cl rowf" class:open={on} inert={!on} aria-hidden={on ? undefined : "true"}>
    <div class="clin">
      <WorkspaceRow
        {row}
        projectName={project.name}
        query=""
        selected={false}
        questions={rowQuestions(notifications, row.key)}
        shortcut={null}
        {animate}
        onAction={onRowAction}
      />
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="inact" class:open onmouseenter={clearLeave} onmouseleave={handleLeave}>
  <button
    type="button"
    class="inact-h"
    aria-expanded={open}
    title={summary}
    onclick={() => onSetOpen(!open)}
  >
    <span class="stack" aria-hidden="true">
      {#each stacked as project (project.id)}
        <span class="mono-av" style:--pc={projectColor(project.colorIndex)}>{letter(project)}</span>
      {/each}
      {#if more > 0}<span class="more">+{more}</span>{/if}
    </span>
    <span class="label">Inactive projects</span>
    <span class="cnt"><RowCountItems counts={sleeping} /></span>
    <span class="spacer"></span>
    <SidebarIcon name="chev" class="chev" />
  </button>
  <div class="body-wrap" class:open inert={!open}>
    <div class="body-inner">
      {#each projects as project (project.id)}{@render line(project)}{/each}
    </div>
  </div>
</div>

<style>
  /* A shade flatter than a project card, without its shadow: it sits behind them. */
  .inact {
    background: var(--ch-sb-s1);
    border: 1px dashed var(--ch-sb-line-2);
    border-radius: 10px;
    padding: 3px;
    margin: 8px 0 0;
  }
  .inact.open {
    border-style: solid;
    background: var(--ch-sb-s2);
  }
  .inact-h {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    height: 30px;
    padding: 0 4px 0 6px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--ch-sb-fg-2);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.12s;
  }
  .inact-h:hover {
    background: var(--ch-sb-head-hover);
  }
  .inact-h:focus-visible {
    outline: 1px solid var(--ch-sb-accent);
  }
  /* The projects' badges, overlapping like a hand of cards. */
  .stack {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .stack .mono-av {
    width: 16px;
    height: 16px;
    font-size: 9px;
    border-radius: 4px;
    box-shadow: 0 0 0 1.5px var(--ch-sb-s1);
  }
  .inact.open .stack .mono-av {
    box-shadow: 0 0 0 1.5px var(--ch-sb-s2);
  }
  .stack .mono-av + .mono-av {
    margin-left: -3px;
  }
  .more {
    margin-left: 3px;
    font-size: 10px;
    font-weight: 600;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
  }
  .label {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex-shrink: 100;
  }
  .cnt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .inact-h :global(.sb-icon.chev) {
    width: 12px;
    height: 12px;
    color: var(--ch-sb-fg-3);
    margin-right: 2px;
    flex: none;
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .inact.open .inact-h :global(.sb-icon.chev) {
    transform: rotate(90deg);
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

  .iproj {
    border-radius: 8px;
    margin: 1px 0;
  }
  .iproj:first-child {
    margin-top: 2px;
  }
  .iline {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 4px 0 8px;
    border-radius: 7px;
    color: var(--ch-sb-fg-2);
    cursor: pointer;
    transition: background-color 0.12s;
  }
  .iline:hover {
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
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
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex-shrink: 100;
  }
  .iline :global(.sb-icon.remote) {
    color: var(--ch-sb-fg-3);
    width: 12px;
    height: 12px;
    flex: none;
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
    padding: 2px 4px;
    border-radius: 99px;
    cursor: pointer;
  }
  .sleepers:hover,
  .sleepers[aria-pressed="true"] {
    color: var(--ch-sb-fg);
    background: var(--ch-sb-s2);
  }
  .sleepers[aria-pressed="true"] {
    box-shadow: inset 0 0 0 1px var(--ch-sb-line-2);
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
  .hov {
    display: none;
    color: var(--ch-sb-danger);
  }
  .iline:hover .hov,
  .iline:focus-within .hov {
    display: grid;
  }
  /* Hovering the line lights its +: the click anywhere on the line is "new workspace here". */
  .iline:hover .plus {
    background: var(--pc);
    color: #fff;
  }

  /* Its rows' folds (the hibernated list itself is HibernatedList's). */
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

  /* with reduced motion the layout lands at once */
  :global(.sb.instant) .body-wrap,
  :global(.sb.instant) .cl,
  :global(.sb.instant) .inact-h :global(.sb-icon.chev) {
    transition: none;
  }
</style>
