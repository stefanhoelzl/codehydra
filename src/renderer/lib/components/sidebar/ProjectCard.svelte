<!--
  ProjectCard.svelte

  One project: a header bar (letter badge, name, hibernated moon or the
  collapsed counts, a question mark for questions out of sight, close and +)
  over its rows. Every row is always in the page and folds open or closed, so
  collapsing, opening the hibernated list or entering Find animates.

  Clicks anywhere in the card are handled here, in one place: a click that is
  not on the moon, the "Show automated workspaces" item or the question mark
  folds the hibernated list away again.
-->
<script lang="ts">
  import type { UiNotification, UiProjectRow, UiWorkspaceRow } from "@shared/ui-state";
  import {
    automatedShown,
    hiddenAskingRows,
    hiddenQuestions,
    isIdleRow,
    projectColor,
    projectFolds,
    rowGlyph,
    rowGroup,
    rowOn,
    rowQuestions,
    type RowAction,
    type SidebarView,
  } from "$lib/utils/sidebar-model.js";
  import SidebarIcon from "./SidebarIcon.svelte";
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
    onRevealQuestion: (project: UiProjectRow) => void;
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
    onRevealQuestion,
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
  const menuOn = $derived(!finding && automated.length > 0 && !automatedShown(project));
  const delimOn = $derived(([...hibernated, ...automated].some(on) || menuOn) && awake.some(on));
  const running = $derived(project.workspaces.filter((row) => rowGlyph(row) === "busy").length);
  const idle = $derived(project.workspaces.filter(isIdleRow).length);
  /** Questions out of sight: cards in hidden rows, then hidden rows whose editor asks. */
  const questionsOutOfSight = $derived([
    ...hiddenQuestions(project, notifications, view).map((note) => note.config.title),
    ...hiddenAskingRows(project, view).map(
      (row) => `A question in ${row.title ?? row.name}'s editor`
    ),
  ]);
  const hibernatedOpen = $derived(project.hibernatedView !== "hidden");
  const color = $derived(projectColor(project.name));

  function handleClick(event: MouseEvent): void {
    const target = event.target as Element;
    // Buttons inside a card (answers, cancel, dismiss) are the card's own.
    if (target.closest(".note") !== null) return;
    const act = target.closest("[data-act]")?.getAttribute("data-act") ?? null;
    if (act !== "hibtoggle" && act !== "autoshow" && act !== "revealnote" && hibernatedOpen) {
      onSetHibernatedView(project, "hidden");
    }
    switch (act) {
      case "hibtoggle":
        onSetHibernatedView(project, hibernatedOpen ? "hidden" : "manual");
        return;
      case "autoshow":
        onSetHibernatedView(project, "all");
        return;
      case "revealnote":
        onRevealQuestion(project);
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
  <div
    class="cl rowf"
    class:open={on(row)}
    in:arrive={{ key: row.key }}
    out:depart={{ key: row.key, projectId: project.id }}
  >
    <div class="clin">
      <WorkspaceRow
        {row}
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
    {#if !folds.expanded}
      <span class="cnt" title={`${running} working · ${idle} idle`}>
        {#if running > 0}<i><span class="ring"></span>{running}</i>{/if}
        {#if idle > 0}<i><span class="dot idle"></span>{idle}</i>{/if}
      </span>
    {:else if hibernated.length + automated.length > 0}
      <button
        type="button"
        class="sleepers"
        data-act="hibtoggle"
        aria-pressed={hibernatedOpen}
        title={`${hibernatedOpen ? "Hide" : "Show"} hibernated: ${hibernated.length} · automated: ${automated.length}`}
        ><SidebarIcon name="moon" />{hibernated.length}{#if automated.length > 0}<span class="na"
            >/{automated.length}</span
          >{/if}</button
      >
    {/if}
    {#if questionsOutOfSight.length > 0}
      <button
        type="button"
        class="hdr-note question"
        data-act="revealnote"
        title={`${questionsOutOfSight.join(" · ")} (click to show)`}
        ><SidebarIcon name="help" />{questionsOutOfSight.length > 1
          ? questionsOutOfSight.length
          : ""}</button
      >
    {/if}
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
  <div class="body-wrap" class:open={folds.expanded}>
    <div class="body-inner">
      {#if hibernated.length + automated.length > 0}
        <div class="hib-group" class:open={folds.hibernatedOpen}>
          <div class="hib-inner">
            {#each hibernated as row (row.key)}{@render rowFold(row)}{/each}
            {#if automated.length > 0}
              <div class="cl" class:open={menuOn}>
                <div class="clin">
                  <button type="button" class="auto-menu" data-act="autoshow"
                    ><SidebarIcon name="moon" />Show automated workspaces ({automated.length})</button
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
    flex-shrink: 0;
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
  .hov {
    display: none;
  }
  .proj-h:hover .hov {
    display: grid;
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
    gap: 3px;
    font: inherit;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    flex: none;
    font-variant-numeric: tabular-nums;
    border: 0;
    background: transparent;
    padding: 2px 6px;
    border-radius: 99px;
    cursor: pointer;
  }
  .sleepers :global(.sb-icon) {
    width: 11px;
    height: 11px;
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
  .sleepers .na {
    color: var(--ch-sb-auto);
  }
  .cnt {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
    flex: none;
    padding: 0 4px;
  }
  .cnt i {
    font-style: normal;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .cnt .ring {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--ch-sb-spin-track);
    border-top-color: var(--ch-sb-spin-head);
    animation: spin 0.9s linear infinite;
    display: block;
    box-sizing: border-box;
  }
  .cnt .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: block;
    background: var(--ch-sb-idle);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .hdr-note {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 0;
    background: transparent;
    padding: 2px 4px;
    border-radius: 99px;
    cursor: pointer;
    font: inherit;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .hdr-note :global(.sb-icon) {
    width: 13px;
    height: 13px;
  }
  .hdr-note.question {
    color: var(--ch-sb-ask);
  }
  .hdr-note:hover {
    background: var(--ch-sb-s2);
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
