<!--
  Sidebar.svelte

  The sidebar: a floating card with the Find field on top, one card per
  project, the notifications at the bottom and a footer (status summary, +,
  dock, settings, help). Collapsed (overlay mode, not hovered) it is a rail of
  status glyphs.

  Main owns what persists or what keys change (collapsed projects, each
  project's hibernated list, whether Find is open); the Find text, the Find
  marker and every animation are local. Gestures go to main as ui:events.
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import * as api from "$lib/api";
  import type {
    HibernatedView,
    SidebarMode,
    UiNotification,
    UiProjectRow,
    UiSidebarFind,
    UiWorkspaceRow,
  } from "@shared/ui-state";
  import type { UIMode } from "@shared/ipc";
  import { clampSidebarWidthMin } from "@shared/ui-state";
  import { createLogger } from "$lib/logging";
  import {
    hiddenAskingRows,
    hiddenQuestions,
    isQuestion,
    markerRows,
    normalizedQuery,
    nothingMatches,
    projectColor,
    projectShown,
    rowGlyph,
    rowGroup,
    rowHidden,
    rowQuestions,
    type RowAction,
    type SidebarView,
  } from "$lib/utils/sidebar-model.js";
  import ProjectCard from "./sidebar/ProjectCard.svelte";
  import NoteCard from "./sidebar/NoteCard.svelte";
  import SidebarIcon from "./sidebar/SidebarIcon.svelte";
  import { createRowMotion, highlight, noteIn, noteOut } from "./sidebar/motion";

  const logger = createLogger("ui");

  interface SidebarProps {
    /** Render-ready project rows from the UiState snapshot. */
    projects: readonly UiProjectRow[];
    /** Persisted expanded-sidebar width (px) from the snapshot. */
    sidebarWidth: number;
    /**
     * Reports the width (px) the expanded sidebar renders at — the persisted
     * width clamped to the window, or the live width mid-drag — whenever it
     * changes, so a docked sidebar's workspace area follows the drag.
     */
    onRenderedWidthChange?: (width: number) => void;
    /** Overlay (expands over the workspace) or docked (always expanded). */
    sidebarMode?: SidebarMode;
    /** Main's Find state (null while the Find field does not have the focus). */
    find?: UiSidebarFind | null;
    /** Open sidebar notifications from the snapshot. */
    notifications: readonly UiNotification[];
    /** The single UI mode from the snapshot (main-owned). */
    mode?: UIMode;
    shortcutModeActive?: boolean;
    /**
     * True while main is capturing the hibernation screenshot: force an
     * overlay sidebar collapsed (overriding mode) so it is not baked into the
     * shot. A docked sidebar never covers the workspace, so it ignores this.
     */
    capturing?: boolean;
  }

  let {
    projects,
    sidebarWidth,
    onRenderedWidthChange,
    sidebarMode = "overlay",
    find = null,
    notifications,
    mode = "workspace",
    shortcutModeActive = false,
    capturing = false,
  }: SidebarProps = $props();

  const reducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const animate = !reducedMotion;

  const allRows = $derived(projects.flatMap((project) => project.workspaces));
  const totalWorkspaces = $derived(allRows.length);
  const activeKey = $derived(allRows.find((row) => row.active)?.key ?? null);

  // ============ Find ============

  let findInput = $state<HTMLInputElement | null>(null);
  let findFocused = $state(false);
  let query = $state("");
  /** The row the Find marker is on (only while Find is focused). */
  let selectedKey = $state<string | null>(null);
  /** This render lands at once (typing in Find): no fold animation. */
  let instant = $state(false);
  let scrollSelection = false;

  /** Until main echoes the focus, Find shows what main will report: hibernated, not automated. */
  const FIND_DEFAULT: UiSidebarFind = { hibernatedView: "manual" };
  const view = $derived<SidebarView>({
    find: findFocused ? (find ?? FIND_DEFAULT) : null,
    query,
  });
  const ql = $derived(normalizedQuery(view));
  const marker = $derived(markerRows(projects, view));

  function selectFirst(preferActive: boolean): void {
    const rows = markerRows(projects, view);
    if (rows.length === 0) {
      selectedKey = null;
      return;
    }
    const active = preferActive ? rows.find((row) => row.active) : undefined;
    selectedKey = (active ?? rows[0])?.key ?? null;
    scrollSelection = true;
  }

  function handleFindFocus(): void {
    if (findFocused) return;
    findFocused = true;
    api.emitEvent({ kind: "set-find", active: true });
    selectFirst(true);
  }

  function handleFindBlur(): void {
    if (!findFocused) return;
    findFocused = false;
    selectedKey = null;
    api.emitEvent({ kind: "set-find", active: false });
  }

  /** Leave Find: clear the text and give the focus up. */
  function endFind(): void {
    query = "";
    if (findInput !== null) findInput.value = "";
    findInput?.blur();
    handleFindBlur();
  }

  function focusWorkspace(): void {
    const hooks = window as Window & { __chFocusActiveFrame?: () => void };
    hooks.__chFocusActiveFrame?.();
  }

  function settleInstant(): void {
    instant = true;
    requestAnimationFrame(() => requestAnimationFrame(() => (instant = false)));
  }

  function handleFindInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    settleInstant();
    selectFirst(false);
  }

  /** The row a Page Up / Page Down lands on: about a list height away. */
  function pageTarget(direction: 1 | -1, index: number): number {
    const elements = marker.map((row) =>
      listEl?.querySelector(`.ws[data-key="${CSS.escape(row.key)}"]`)
    );
    const current = elements[index];
    if (!current || !listEl) return direction > 0 ? elements.length - 1 : 0;
    const viewHeight = listEl.clientHeight;
    let target = index;
    if (direction > 0) {
      const top = current.getBoundingClientRect().top;
      while (
        target + 1 < elements.length &&
        (elements[target + 1]?.getBoundingClientRect().bottom ?? Infinity) - top <= viewHeight
      ) {
        target++;
      }
      if (target === index) target = Math.min(index + 1, elements.length - 1);
    } else {
      const bottom = current.getBoundingClientRect().bottom;
      while (
        target - 1 >= 0 &&
        bottom - (elements[target - 1]?.getBoundingClientRect().top ?? -Infinity) <= viewHeight
      ) {
        target--;
      }
      if (target === index) target = Math.max(index - 1, 0);
    }
    return target;
  }

  function handleFindKeydown(event: KeyboardEvent): void {
    if (event.altKey) return;
    const rows = marker;
    let index = rows.findIndex((row) => row.key === selectedKey);
    switch (event.key) {
      case "ArrowDown":
        index = Math.min(rows.length - 1, index + 1);
        break;
      case "ArrowUp":
        index = Math.max(0, index - 1);
        break;
      case "Home":
        index = 0;
        break;
      case "End":
        index = rows.length - 1;
        break;
      case "PageDown":
        index = pageTarget(1, index);
        break;
      case "PageUp":
        index = pageTarget(-1, index);
        break;
      case "Enter": {
        event.preventDefault();
        const row = rows.find((candidate) => candidate.key === selectedKey);
        if (row !== undefined) {
          endFind();
          activateRow(row);
        }
        return;
      }
      case "Escape":
        event.preventDefault();
        endFind();
        focusWorkspace();
        return;
      default:
        return;
    }
    event.preventDefault();
    const row = rows[Math.max(0, index)];
    if (row !== undefined) {
      selectedKey = row.key;
      scrollSelection = true;
    }
  }

  // Alt+X, F: main opens Find; the field takes the focus.
  $effect(() => {
    if (find !== null && !untrack(() => findFocused)) findInput?.focus();
  });

  // The marker stays on its row while it is listed (Alt+X, T in Find), else moves to the first.
  $effect(() => {
    const rows = marker;
    if (!untrack(() => findFocused)) return;
    const current = untrack(() => selectedKey);
    if (current !== null && rows.some((row) => row.key === current)) return;
    untrack(() => selectFirst(false));
  });

  // Bring the marker into view once it has moved (again once the folds have settled).
  $effect(() => {
    void selectedKey;
    void marker;
    if (!scrollSelection) return;
    scrollSelection = false;
    const go = (): void => listEl?.querySelector(".ws.sel")?.scrollIntoView({ block: "nearest" });
    void tick().then(go);
    if (animate && !instant) setTimeout(go, 330);
  });

  /** "/" anywhere outside a text field opens Find. */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    event.preventDefault();
    findInput?.focus();
  }

  // ============ Expansion ============

  /** Debounce for both arming expansion and collapsing. */
  const HOVER_DELAY_MS = 150;

  let isHovering = false;
  let openTimeout: ReturnType<typeof setTimeout> | null = null;
  let collapseTimeout: ReturnType<typeof setTimeout> | null = null;

  const docked = $derived(sidebarMode === "docked");

  // Expanded when docked (always), or when the snapshot mode is anything but
  // "workspace" (hover, shortcut, dialog, Find — the creation panel maps to
  // hover), or when there are no workspaces — unless main is capturing the
  // hibernation screenshot, which forces an overlay sidebar collapsed.
  const isExpanded = $derived(
    docked || (!capturing && (mode !== "workspace" || totalWorkspaces === 0))
  );

  function clearOpenTimeout(): void {
    if (openTimeout) {
      clearTimeout(openTimeout);
      openTimeout = null;
    }
  }

  function clearCollapseTimeout(): void {
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  }

  function armExpansion(): void {
    if (isHovering || docked || mode !== "workspace") return;
    if (openTimeout) return;
    openTimeout = setTimeout(() => {
      openTimeout = null;
      if (mode !== "workspace") return;
      logger.debug("sidebar hover: expand");
      isHovering = true;
      api.emitEvent({ kind: "hover", region: "sidebar" });
    }, HOVER_DELAY_MS);
  }

  function handleMouseEnter(): void {
    clearCollapseTimeout();
    armExpansion();
  }

  function handleMouseLeave(): void {
    // Mid-resize the drag overlay sits on top: never collapse while dragging.
    if (dragging) return;
    clearOpenTimeout();
    if (!isHovering) return;
    collapseTimeout ??= setTimeout(() => {
      collapseTimeout = null;
      logger.debug("sidebar hover: collapse");
      isHovering = false;
      api.emitEvent({ kind: "hover", region: null });
    }, HOVER_DELAY_MS);
  }

  onDestroy(() => {
    clearOpenTimeout();
    clearCollapseTimeout();
  });

  // ============ Resize ============
  // The expanded sidebar's right edge is a drag handle. Dragging sets a local
  // `liveWidth` override; on release it is persisted (resize-sidebar) and the
  // snapshot echoes it back. The override lingers until that echo arrives.

  let dragging = $state(false);
  let liveWidth = $state<number | null>(null);
  let dragStartX = 0;
  let dragStartWidth = 0;
  let winWidth = $state(typeof window !== "undefined" ? window.innerWidth : 0);

  function clampWidth(width: number): number {
    const floored = clampSidebarWidthMin(width);
    const max = clampSidebarWidthMin(winWidth * 0.75);
    return Math.min(floored, max);
  }

  const effectiveWidth = $derived(clampWidth(liveWidth ?? sidebarWidth));

  $effect(() => {
    onRenderedWidthChange?.(effectiveWidth);
  });

  $effect(() => {
    void sidebarWidth;
    if (!untrack(() => dragging)) liveWidth = null;
  });

  function handleResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = effectiveWidth;
    liveWidth = dragStartWidth;
    clearOpenTimeout();
    clearCollapseTimeout();
  }

  function handleResizeMove(event: MouseEvent): void {
    if (!dragging) return;
    liveWidth = clampWidth(dragStartWidth + (event.clientX - dragStartX));
  }

  function handleResizeEnd(event: MouseEvent): void {
    if (!dragging) return;
    const finalWidth = clampWidth(dragStartWidth + (event.clientX - dragStartX));
    dragging = false;
    liveWidth = finalWidth;
    api.emitEvent({ kind: "resize-sidebar", width: finalWidth });
    if (!docked && event.clientX > finalWidth) {
      isHovering = false;
      api.emitEvent({ kind: "hover", region: null });
    }
  }

  // ============ Motion ============

  let listEl = $state<HTMLElement | null>(null);
  const motion = createRowMotion({
    enabled: () => animate && !instant,
    row: (key) => allRows.find((row) => row.key === key),
    moonTarget: (projectId) => {
      const card = listEl?.querySelector(`.proj[data-project-id="${CSS.escape(projectId)}"]`);
      return (card?.querySelector(".sleepers") ??
        card?.querySelector(".proj-h .name")) as HTMLElement | null;
    },
  });

  // Where every row was before this update: a row that hibernates or wakes flies from there.
  $effect.pre(() => {
    void projects;
    untrack(() => motion.capture(listEl));
  });
  $effect(() => {
    const keys = allRows.map((row) => row.key);
    motion.settle(keys);
  });

  // Keep the active row in view (keyboard navigation, a collapse moving you on).
  $effect(() => {
    void activeKey;
    if (!isExpanded) return;
    void tick().then(() =>
      listEl?.querySelector(".ws.active")?.scrollIntoView({ block: "nearest" })
    );
  });

  // A question arriving while its row is out of sight: its project's header
  // bar flashes in the question color three times.
  /** Question ids already seen (not reactive: only this effect reads it). */
  const seenQuestions: Record<string, true> = {};
  let questionsPrimed = false;
  $effect(() => {
    const questions = notifications.filter(isQuestion);
    const fresh = questions.filter((note) => seenQuestions[note.id] !== true);
    for (const note of questions) seenQuestions[note.id] = true;
    if (!questionsPrimed) {
      questionsPrimed = true;
      return;
    }
    if (!animate) return;
    for (const note of fresh) {
      const project = projects.find((candidate) =>
        candidate.workspaces.some((row) => row.key === note.workspace?.key)
      );
      if (project === undefined) continue;
      const row = project.workspaces.find((candidate) => candidate.key === note.workspace?.key);
      if (row === undefined || !untrack(() => rowHidden(project, row, view))) continue;
      void tick().then(() => signal(project.id));
    }
  });

  // Likewise when a question opens in the editor of a workspace whose row is out of sight.
  let askingBefore: readonly string[] | null = null;
  $effect(() => {
    const asking = allRows.filter((row) => row.editorQuestion === true).map((row) => row.key);
    const before = askingBefore;
    askingBefore = asking;
    if (before === null || !animate) return;
    for (const key of asking) {
      if (before.includes(key)) continue;
      const project = projects.find((candidate) =>
        candidate.workspaces.some((row) => row.key === key)
      );
      const row = project?.workspaces.find((candidate) => candidate.key === key);
      if (project === undefined || row === undefined) continue;
      if (!untrack(() => rowHidden(project, row, view))) continue;
      void tick().then(() => signal(project.id));
    }
  });

  function signal(projectId: string): void {
    const header = listEl?.querySelector<HTMLElement>(
      `.proj[data-project-id="${CSS.escape(projectId)}"] .proj-h`
    );
    if (!header) return;
    const base = getComputedStyle(header).backgroundColor;
    const ask = getComputedStyle(document.documentElement).getPropertyValue("--ch-sb-ask").trim();
    const on = `color-mix(in srgb, ${ask} 45%, ${base})`;
    const options = { duration: 1600, easing: "ease-in-out" };
    header.animate(
      [base, on, base, on, base, on, base].map((color) => ({ backgroundColor: color })),
      options
    );
    header.querySelector(".hdr-note")?.animate(
      [1, 1.35, 1, 1.35, 1, 1.35, 1].map((k) => ({ transform: `scale(${k})` })),
      options
    );
  }

  // ============ Gestures ============

  function switchTo(row: UiWorkspaceRow): void {
    if (row.hibernated || row.status === "open-failed") {
      // A hibernated row wakes; a failed one opens again. Either way you go there.
      api.emitEvent({ kind: "wake-workspace", key: row.key });
    }
    api.emitEvent({ kind: "switch-workspace", key: row.key });
  }

  function activateRow(row: UiWorkspaceRow): void {
    if (view.find !== null) endFind();
    switchTo(row);
  }

  function handleRowAction(action: RowAction, row: UiWorkspaceRow): void {
    switch (action) {
      case "hibernate":
        api.emitEvent({ kind: "hibernate-workspace", key: row.key });
        return;
      case "remove":
        api.emitEvent({ kind: "remove-workspace", key: row.key });
        return;
      case "retry":
        api.emitEvent({ kind: "wake-workspace", key: row.key });
        return;
    }
  }

  function setHibernatedView(project: UiProjectRow, next: HibernatedView): void {
    if (project.hibernatedView === next) return;
    api.emitEvent({ kind: "set-hibernated-view", projectId: project.id, view: next });
  }

  function toggleCollapsed(project: UiProjectRow): void {
    api.emitEvent({ kind: "toggle-project-collapsed", projectId: project.id });
  }

  /**
   * Bring an out-of-sight question into view — the newest card, else a row whose
   * editor asks: expand, open the hibernated list.
   */
  function revealQuestion(project: UiProjectRow): void {
    const note = hiddenQuestions(project, notifications, view).at(-1);
    const row =
      note === undefined
        ? hiddenAskingRows(project, view)[0]
        : project.workspaces.find((candidate) => candidate.key === note.workspace?.key);
    if (row === undefined) return;
    if (view.find !== null) endFind();
    if (project.collapsed) toggleCollapsed(project);
    const group = rowGroup(row);
    if (group === "automated") setHibernatedView(project, "all");
    else if (group === "hibernated" && project.hibernatedView === "hidden") {
      setHibernatedView(project, "manual");
    }
    setTimeout(
      () => {
        const el = listEl?.querySelector(`.ws[data-key="${CSS.escape(row.key)}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: animate ? "smooth" : "auto" });
        if (animate && el) highlight(el.querySelector(".note") ?? el);
        // A row that only asks in its editor: going there is what answers it.
      },
      animate ? 330 : 0
    );
  }

  // ============ Derived display ============

  /** Shortcut-mode numbers: the awake rows of expanded projects, 1–9 then 0. */
  const shortcutNumbers = $derived.by((): Readonly<Record<string, string>> => {
    if (!shortcutModeActive) return {};
    const rows = projects
      .filter((project) => !project.collapsed)
      .flatMap((project) => project.workspaces.filter((row) => !row.hibernated));
    return Object.fromEntries(
      rows.slice(0, 10).map((row, index) => [row.key, String((index + 1) % 10)])
    );
  });

  const bottomNotes = $derived([...notifications].filter((note) => !isQuestion(note)).reverse());
  const summary = $derived({
    busy: allRows.filter((row) => rowGlyph(row) === "busy").length,
    idle: allRows.filter((row) => rowGlyph(row) === "idle").length,
    hibernated: allRows.filter((row) => row.status === "ready" && row.hibernated).length,
  });

  /** The rail: per expanded project its awake rows (and the active one); a dot per question. */
  const railGroups = $derived(
    projects.map((project) => {
      const shown = project.collapsed
        ? []
        : project.workspaces.filter((row) => !row.hibernated || row.active);
      const offRail = notifications.filter(
        (note) =>
          isQuestion(note) &&
          project.workspaces.some((row) => row.key === note.workspace?.key) &&
          !shown.some((row) => row.key === note.workspace?.key)
      );
      const askingOffRail = project.workspaces.some(
        (row) => row.editorQuestion === true && !shown.includes(row)
      );
      return { project, shown, offRail: offRail.length > 0 || askingOffRail };
    })
  );

  const NOTE_RAIL_ICON = { info: "info", warning: "warn", error: "xcircle" } as const;
</script>

<svelte:window onresize={() => (winWidth = window.innerWidth)} onkeydown={handleWindowKeydown} />

<nav
  class="sidebar"
  class:expanded={isExpanded || dragging}
  class:dragging
  class:docked
  style="--ch-sidebar-width: {effectiveWidth}px"
  aria-label="Projects"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  <aside
    class="sb"
    class:collapsed={!(isExpanded || dragging)}
    class:peek={!docked && isExpanded}
    class:searching={view.find !== null}
    class:instant={instant || !animate}
  >
    <div class="sb-head">
      <div class="search">
        <SidebarIcon name="search" />
        <input
          bind:this={findInput}
          placeholder="Find workspace…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Find workspace"
          data-no-autofocus
          onfocus={handleFindFocus}
          onblur={handleFindBlur}
          oninput={handleFindInput}
          onkeydown={handleFindKeydown}
        />
        <span class="hint"><kbd>Alt X</kbd><kbd>F</kbd></span>
      </div>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sb-body"
      bind:this={listEl}
      onmousedown={(event) => {
        // Keep the focus in Find while clicking a row, a header or a card.
        if (
          findFocused &&
          (event.target as Element).closest(".ws, .proj-h, .auto-menu, .note") !== null
        ) {
          event.preventDefault();
        }
      }}
    >
      {#each projects as project (project.id)}
        <div class="cl projf" class:open={projectShown(project, view)}>
          <div class="clin">
            <ProjectCard
              {project}
              {view}
              query={ql}
              {notifications}
              {selectedKey}
              shortcuts={shortcutNumbers}
              {animate}
              {motion}
              onToggleCollapsed={toggleCollapsed}
              onSetHibernatedView={setHibernatedView}
              onRevealQuestion={revealQuestion}
              onCloseProject={(p) => api.emitEvent({ kind: "close-project", projectId: p.id })}
              onNewWorkspace={(p) => {
                if (view.find !== null) endFind();
                api.emitEvent({ kind: "open-new-workspace", projectId: p.id });
              }}
              onRowClick={activateRow}
              onRowAction={handleRowAction}
            />
          </div>
        </div>
      {/each}
      {#if nothingMatches(projects, view)}
        <div class="empty">No workspace matches “{query}”</div>
      {/if}
    </div>

    <div class="notes" class:empty={bottomNotes.length === 0}>
      {#each bottomNotes as note (note.id)}
        <div in:noteIn={{ enabled: animate }} out:noteOut={{ enabled: animate }}>
          <NoteCard {note} {animate} />
        </div>
      {/each}
    </div>

    <div class="sb-foot">
      <div class="sum" title="working · waiting for you · hibernated">
        <i><span class="ring"></span>{summary.busy}</i>
        <i><span class="d"></span>{summary.idle}</i>
        <i><SidebarIcon name="moon" size={10} />{summary.hibernated}</i>
      </div>
      <button
        type="button"
        class="ib newb"
        title="New workspace (Alt+X, Enter)"
        aria-label="New workspace"
        onclick={() => {
          if (view.find !== null) endFind();
          api.emitEvent({ kind: "open-new-workspace", projectId: null });
        }}><SidebarIcon name="plus" /></button
      >
      <span class="vsep"></span>
      <button
        type="button"
        class="ib"
        class:on={docked}
        title={`${docked ? "Undock" : "Dock"} sidebar (Alt+X, P)`}
        aria-label={docked ? "Undock sidebar" : "Dock sidebar"}
        aria-pressed={docked}
        onclick={() =>
          api.emitEvent({ kind: "set-sidebar-mode", mode: docked ? "overlay" : "docked" })}
        ><SidebarIcon name={docked ? "docked" : "undocked"} /></button
      >
      <button
        type="button"
        class="ib"
        title="Settings (Alt+X, S)"
        aria-label="Settings"
        onclick={() => api.emitEvent({ kind: "open-settings" })}><SidebarIcon name="gear" /></button
      >
      <button
        type="button"
        class="ib"
        title="Help"
        aria-label="Help"
        onclick={() => api.emitEvent({ kind: "open-help" })}><SidebarIcon name="help" /></button
      >
    </div>

    <div class="rail" aria-hidden="true">
      {#each railGroups as group (group.project.id)}
        <div class="rgrp">
          <span class="r-ws"
            ><span
              class="mono-av"
              style:--pc={projectColor(group.project.name)}
              title={group.project.name}>{group.project.name.slice(0, 1).toUpperCase()}</span
            >{#if group.offRail}<span class="rn"></span>{/if}</span
          >
          {#each group.shown as row (row.key)}
            {@const glyph = rowGlyph(row)}
            <div class="r-ws" class:active={row.active}>
              {#if glyph === "busy"}<span class="ring"></span>
              {:else if glyph === "idle"}<span class="dot idle"></span>
              {:else if glyph === "none"}<span class="dot none"></span>
              {:else if glyph === "pending"}<span class="ring pending"></span>
              {:else if glyph === "failed"}<span class="failed-icon"
                  ><SidebarIcon name="warn" /></span
                >
              {:else}<span class="moon"><SidebarIcon name="moon" /></span>{/if}
              {#if rowQuestions(notifications, row.key).length > 0 || row.editorQuestion === true}<span
                  class="rn"
                ></span>{/if}
            </div>
          {/each}
        </div>
      {/each}
      <div class="rspacer"></div>
      {#each bottomNotes as note (note.id)}
        {@const type = note.config.type}
        <div class="rnote {type === 'spinner' ? 'info' : type}" title={note.config.title}>
          {#if type === "spinner" || type === "question"}<span class="ring"></span>
          {:else}<SidebarIcon name={NOTE_RAIL_ICON[type]} />{/if}
        </div>
      {/each}
    </div>
  </aside>

  {#if isExpanded || dragging}
    <div
      class="resize-handle"
      class:dragging
      aria-hidden="true"
      title="Drag to resize"
      onmousedown={handleResizeStart}
    ></div>
  {/if}
</nav>

{#if dragging}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="resize-overlay"
    onmousemove={handleResizeMove}
    onmouseup={handleResizeEnd}
    onmouseleave={handleResizeEnd}
  ></div>
{/if}

<style>
  /* The sidebar's strip of the window: the card floats in it with an 8px margin. */
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--ch-sidebar-minimized-width, 56px);
    height: 100%;
    background: var(--ch-sb-s1);
    z-index: var(--ch-z-sidebar-minimized, 1);
    pointer-events: auto;
    user-select: none;
    font:
      13px/1.4 "Segoe UI Variable Text",
      "Segoe UI",
      Inter,
      system-ui,
      sans-serif;
    color: var(--ch-sb-fg);
  }
  .sidebar :global(*) {
    box-sizing: border-box;
  }
  /* Zero specificity, so every component's own button rules win. */
  :global(:where(.sidebar button)) {
    font: inherit;
    color: inherit;
  }
  .sidebar.expanded {
    z-index: var(--ch-z-sidebar-expanded, 50);
  }
  .sidebar.docked.expanded {
    width: var(--ch-sidebar-width, 288px);
  }
  /* Overlay: the strip stays a rail wide; the expanded card floats over the workspace. */
  .sidebar:not(.docked).expanded {
    width: calc(var(--ch-sidebar-width, 288px) - 8px);
    background: linear-gradient(
      to right,
      var(--ch-sb-s1) var(--ch-sidebar-minimized-width, 56px),
      transparent var(--ch-sidebar-minimized-width, 56px)
    );
  }

  .sb {
    position: absolute;
    left: 8px;
    top: 8px;
    bottom: 8px;
    width: calc(var(--ch-sidebar-width, 288px) - 16px);
    border-radius: 12px;
    background: var(--ch-sb-shell);
    border: 1px solid var(--ch-sb-line);
    box-shadow: var(--ch-sb-shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 5;
  }
  .sb.collapsed {
    width: calc(var(--ch-sidebar-minimized-width, 56px) - 12px);
  }
  .sb.peek {
    z-index: 30;
    box-shadow: var(--ch-sb-peek-shadow);
  }
  .sb.collapsed > :not(.rail) {
    display: none;
  }
  .sb:not(.collapsed) > .rail {
    display: none;
  }
  .sb-head {
    padding: 10px 10px 4px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 6px 0 10px;
    border-radius: 8px;
    background: var(--ch-sb-s2);
    border: 1px solid var(--ch-sb-line);
    color: var(--ch-sb-fg-3);
  }
  .search:focus-within {
    border-color: var(--ch-sb-accent);
    box-shadow: 0 0 0 3px var(--ch-sb-accent-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--ch-sb-fg);
    font: inherit;
  }
  .search input::placeholder {
    color: var(--ch-sb-fg-3);
  }
  .search .hint {
    display: flex;
    gap: 3px;
  }
  .search:focus-within .hint {
    display: none;
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
  .sb-body {
    flex: 1;
    overflow: auto;
    padding: 2px 6px 8px;
  }
  .sb-body,
  .notes {
    scrollbar-width: thin;
    scrollbar-color: var(--ch-sb-line-2) transparent;
  }
  .empty {
    padding: 24px 12px;
    text-align: center;
    color: var(--ch-sb-fg-3);
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
  .sb.instant .cl {
    transition: none;
  }

  .ib {
    width: 26px;
    height: 26px;
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
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
  }
  .ib.on {
    color: var(--ch-sb-accent);
  }

  .notes {
    flex-shrink: 0;
    max-height: 34%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--ch-sb-line);
  }
  .notes.empty {
    display: none;
  }

  .sb-foot {
    border-top: 1px solid var(--ch-sb-line);
    padding: 5px 6px;
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .sum {
    flex: 1;
    font-size: 11px;
    color: var(--ch-sb-fg-3);
    padding-left: 6px;
    display: flex;
    gap: 10px;
  }
  .sum i {
    font-style: normal;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .sum .ring {
    width: 9px;
    height: 9px;
    border-width: 1.5px;
    animation: none;
  }
  .sum .d {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ch-sb-idle);
  }
  .vsep {
    width: 1px;
    height: 16px;
    background: var(--ch-sb-line-2);
    margin: 0 3px;
  }
  .newb {
    color: var(--ch-sb-fg);
  }
  .newb:hover {
    background: var(--ch-sb-accent);
    color: #fff;
  }

  .rail {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0;
    gap: 2px;
    overflow: hidden;
  }
  .rgrp {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 5px 0 4px;
    width: 34px;
    background: var(--ch-sb-s2);
    border: 1px solid var(--ch-sb-line);
    border-radius: 9px;
    margin: 3px 0;
  }
  .r-ws {
    position: relative;
    width: 28px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 7px;
  }
  .r-ws .rn {
    position: absolute;
    right: 1px;
    top: 1px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ch-sb-ask);
    box-shadow: 0 0 0 1.5px var(--ch-sb-s2);
  }
  .r-ws.active {
    background: var(--ch-sb-accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ch-sb-accent) 35%, transparent);
  }
  .rspacer {
    flex: 1;
  }
  .rnote {
    width: 28px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 7px;
  }
  .rnote.error {
    color: var(--ch-sb-danger);
  }
  .rnote.warning {
    color: var(--ch-sb-warn);
  }
  .rnote.info {
    color: var(--ch-sb-accent);
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
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: block;
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
  }
  .ring.pending {
    border: 2px dotted var(--ch-sb-fg-3);
    animation-duration: 2.4s;
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

  .resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: 40;
    background: transparent;
    transition: background-color 120ms ease-out;
  }
  .resize-handle:hover,
  .resize-handle.dragging {
    background: var(--ch-sb-accent);
  }
  .resize-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    cursor: ew-resize;
  }

  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
  }
</style>
