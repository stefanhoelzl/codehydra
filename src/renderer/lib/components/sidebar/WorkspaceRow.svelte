<!--
  WorkspaceRow.svelte

  One workspace in a project card: status glyph, title (or name), branch and
  tags on the second line, a short meta text at the end (the hibernation age,
  "working"), its questions as cards, and hover actions. Clicks are reported
  to the sidebar, which owns what they do.
-->
<script lang="ts">
  import type { UiNotification, UiWorkspaceRow } from "@shared/ui-state";
  import {
    isAutomated,
    rowGlyph,
    rowStatusText,
    type RowAction,
  } from "$lib/utils/sidebar-model.js";
  import { describeHibernation } from "$lib/utils/hibernation-age.js";
  import { minuteNow } from "$lib/utils/minute-clock.svelte.js";
  import SidebarIcon from "./SidebarIcon.svelte";
  import Highlighted from "./Highlighted.svelte";
  import NoteCard from "./NoteCard.svelte";
  import { noteIn, noteOut } from "./motion";

  interface Props {
    row: UiWorkspaceRow;
    /** The project's name, for the row's accessible name. */
    projectName: string;
    /** Normalized Find text (marks matches); empty outside Find. */
    query: string;
    /** The Find marker is on this row. */
    selected: boolean;
    /** This row's questions, newest on top. */
    questions: readonly UiNotification[];
    /** Shortcut-mode number (1–9, 0) or null. */
    shortcut: string | null;
    animate: boolean;
    onAction: (action: RowAction, row: UiWorkspaceRow) => void;
  }

  const { row, projectName, query, selected, questions, shortcut, animate, onAction }: Props =
    $props();

  const glyph = $derived(rowGlyph(row));
  const automated = $derived(isAutomated(row));
  const stateClass = $derived(
    glyph === "pending" ? (row.status === "deleting" ? "deleting" : "creating") : glyph
  );
  const label = $derived(row.title ?? row.name);
  const age = $derived(
    row.hibernated && row.hibernatedAt !== undefined
      ? describeHibernation(row.hibernatedAt, minuteNow())
      : null
  );
  const meta = $derived(row.hibernated ? (age?.short ?? "") : glyph === "busy" ? "working" : "");
  // The status cell is the row's button for assistive tech (a click anywhere in
  // the row switches, see ProjectCard): "alpha in web - 1 agent idle".
  const accessibleName = $derived(
    `${row.name} in ${projectName} - ${rowStatusText(
      row,
      age === null
        ? "Hibernated - click to wake"
        : `Hibernated ${age.relative} (${age.date}) - click to wake`
    )}`
  );
  const pendingText = $derived(
    row.status === "creating"
      ? "Creating worktree…"
      : row.status === "loading"
        ? "Opening…"
        : row.status === "deleting"
          ? "Removing…"
          : row.status === "open-failed"
            ? "Failed to open · click to retry"
            : row.status === "delete-failed"
              ? "Deletion failed"
              : null
  );
  const actions = $derived.by((): readonly RowAction[] => {
    if (row.status === "ready") return row.hibernated ? ["remove"] : ["hibernate", "remove"];
    if (row.status === "open-failed") return ["retry", "remove"];
    return [];
  });
  const ACTION_LABEL: Record<RowAction, string> = {
    hibernate: "Hibernate",
    remove: "Remove workspace",
    retry: "Retry",
  };
  const ACTION_ICON = { hibernate: "moon", remove: "trash", retry: "refresh" } as const;
  const tip = $derived(
    automated && row.wakeupScript !== undefined
      ? `Wakes automatically: ${row.wakeupScript}`
      : undefined
  );
</script>

<div
  class="ws {stateClass}"
  class:auto={automated}
  class:active={row.active}
  class:sel={selected}
  data-key={row.key}
  title={tip}
  aria-current={row.active ? "true" : undefined}
>
  <button
    type="button"
    class="st"
    aria-label={accessibleName}
    aria-current={row.active ? "true" : undefined}
  >
    {#if glyph === "busy"}
      <span class="ring busy" title="Agent working"></span>
    {:else if glyph === "idle"}
      <span class="dot idle" title="Agent waiting for you"></span>
    {:else if glyph === "none"}
      <span class="dot none" title="No agent running"></span>
    {:else if glyph === "pending"}
      <span class="ring pending"></span>
    {:else if glyph === "failed"}
      <span class="failed-icon"><SidebarIcon name="warn" /></span>
    {:else}
      <span class="moon"><SidebarIcon name="moon" /></span>
    {/if}
  </button>
  <div class="txt">
    <span class="title"><Highlighted text={label} {query} /></span>
    {#if pendingText !== null}
      <span class="sub" title={row.status === "open-failed" ? row.openError : undefined}
        >{pendingText}</span
      >
    {:else if row.title !== undefined || row.tags.length > 0}
      <span class="sub">
        {#if row.title !== undefined}
          <SidebarIcon name="branch" class="sm" /><span class="mono"
            ><Highlighted text={row.name} {query} /></span
          >
        {/if}
        {#each row.tags as tag (tag.name)}
          <span
            class="tagp"
            style:--c={tag.color ?? "var(--ch-sb-fg-3)"}
            title={tag.description ?? undefined}
            ><Highlighted text={tag.label ?? tag.name} {query} /></span
          >
        {/each}
      </span>
    {/if}
  </div>
  {#if shortcut !== null}
    <span class="meta"><kbd>{shortcut}</kbd></span>
  {:else}
    <span class="meta" title={age === null ? undefined : `Hibernated ${age.relative} (${age.date})`}
      >{meta}</span
    >
  {/if}
  <span class="enter"><kbd>↵</kbd></span>
  {#if questions.length > 0}
    <div class="wnotes">
      {#each questions as note (note.id)}
        <div in:noteIn={{ enabled: animate }} out:noteOut={{ enabled: animate }}>
          <NoteCard {note} inRow {animate} />
        </div>
      {/each}
    </div>
  {/if}
  {#if actions.length > 0}
    <div class="hover-acts">
      {#each actions as action (action)}
        <button
          type="button"
          class="ib"
          title={ACTION_LABEL[action]}
          aria-label={ACTION_LABEL[action]}
          data-act={action}
          onclick={(event) => {
            event.stopPropagation();
            onAction(action, row);
          }}
        >
          <SidebarIcon name={ACTION_ICON[action]} />
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ws {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    row-gap: 0;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 8px 7px 10px;
    margin: 1px 0;
    border-radius: 8px;
    cursor: pointer;
    scroll-margin: 6px;
    color: var(--ch-sb-fg);
  }
  .ws:hover {
    background: var(--ch-sb-s3);
  }
  .ws.active {
    background: var(--ch-sb-accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ch-sb-accent) 35%, transparent);
  }
  .ws.active .title {
    color: var(--ch-sb-fg);
    font-weight: 600;
  }
  .ws.sel {
    box-shadow: inset 0 0 0 1.5px var(--ch-sb-marker);
  }
  .ws.sel::before {
    content: "";
    position: absolute;
    left: -4px;
    top: 50%;
    border: 4px solid transparent;
    border-left-color: var(--ch-sb-marker);
    transform: translateY(-50%);
  }
  .ws.sel .meta {
    display: none;
  }
  .enter {
    display: none;
  }
  .ws.sel .enter {
    display: block;
  }
  .st {
    width: 16px;
    height: 18px;
    display: grid;
    place-items: center;
    flex: none;
    /* A button for assistive tech; it looks like the bare glyph. */
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: inherit;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    white-space: nowrap;
    overflow: hidden;
  }
  .sub :global(.sb-icon.sm) {
    width: 11px;
    height: 11px;
  }
  .mono {
    font-family: "Cascadia Code", "JetBrains Mono", ui-monospace, monospace;
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
    padding-top: 1px;
    white-space: nowrap;
  }
  .ws.idle .meta {
    color: var(--ch-sb-idle);
  }
  .hover-acts {
    position: absolute;
    right: 6px;
    top: 5px;
    display: none;
    gap: 6px;
  }
  .ws:hover .hover-acts {
    display: flex;
  }
  .ws:hover .meta,
  .ws:hover .enter {
    visibility: hidden;
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
    cursor: pointer;
    flex: none;
    background: var(--ch-sb-s2);
    box-shadow: 0 0 0 1px var(--ch-sb-line);
  }
  .ib:hover {
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
  }
  .ws.hibernated .title {
    color: var(--ch-sb-fg-3);
  }
  .ws.failed .sub {
    color: var(--ch-sb-danger);
  }
  /* Dimmed, but still a click target: it opens the removal panel, where a
     hanging hook can be cancelled. */
  .ws.deleting {
    opacity: 0.5;
  }
  .ws.hibernated.auto .title,
  .ws.hibernated.auto .moon,
  .ws.hibernated.auto .meta {
    color: var(--ch-sb-auto);
  }
  .wnotes {
    flex: 0 0 100%;
    padding-left: 26px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 3px;
  }
  .ws:has(.wnotes):hover .hover-acts {
    top: 5px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: block;
    box-sizing: border-box;
  }
  .dot.idle {
    background: var(--ch-sb-idle);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ch-sb-idle) 20%, transparent);
  }
  .dot.none {
    border: 1.5px solid var(--ch-sb-fg-3);
  }
  .ring {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid var(--ch-sb-spin-track);
    border-top-color: var(--ch-sb-spin-head);
    animation: spin 0.9s linear infinite;
    display: block;
    box-sizing: border-box;
  }
  .ring.busy {
    border-color: var(--ch-sb-busy-track);
    border-top-color: var(--ch-sb-busy);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .moon {
    color: var(--ch-sb-fg-3);
    display: grid;
  }
  .failed-icon {
    color: var(--ch-sb-danger);
    display: grid;
  }
  .tagp {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 99px;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 16%, transparent);
    flex: none;
  }
  :global([data-theme="light"]) .tagp {
    color: color-mix(in srgb, var(--c) 70%, black);
  }
  kbd {
    font:
      500 10px/1 "Segoe UI",
      system-ui;
    color: var(--ch-sb-fg-3);
    border: 1px solid var(--ch-sb-line-2);
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 2px 4px;
    background: var(--ch-sb-s2);
    white-space: nowrap;
  }

  /* the flying copy of a row (hibernate / wake) */
  :global(.ws.ghost) {
    background: var(--ch-sb-s2);
    box-shadow:
      0 10px 28px rgba(0, 0, 0, 0.35),
      inset 0 0 0 1px var(--ch-sb-line-2);
    border-radius: 8px;
  }
  :global(.ws.ghost.active) {
    background:
      linear-gradient(var(--ch-sb-accent-soft), var(--ch-sb-accent-soft)), var(--ch-sb-s2);
  }

  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
  }
</style>
