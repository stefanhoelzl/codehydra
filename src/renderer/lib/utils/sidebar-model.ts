/**
 * The sidebar's display rules, as pure functions over the snapshot rows.
 *
 * Every row of every project is always in the page; these rules decide which
 * of them are folded open, so a change of state (Find entered, a hibernated
 * list opened, a project collapsed) animates instead of being redrawn. The
 * order of the rows is main's (see UiProjectRow.workspaces): hibernated, then
 * automated, then awake.
 */

import type {
  HibernatedView,
  UiNotification,
  UiProjectRow,
  UiSidebarFind,
  UiWorkspaceRow,
} from "@shared/ui-state";

/** What the sidebar is showing besides the snapshot: the Find text (renderer-local). */
export interface SidebarView {
  /** Main's Find state; null while the Find field does not have the focus. */
  readonly find: UiSidebarFind | null;
  /** The Find text, as typed. */
  readonly query: string;
}

/** A row's hover actions. */
export type RowAction = "hibernate" | "remove" | "retry";

/** The three groups a project's rows fall into, in display order. */
export type RowGroup = "hibernated" | "automated" | "awake";

export function rowGroup(row: UiWorkspaceRow): RowGroup {
  if (!row.hibernated) return "awake";
  return row.wakeupScript !== undefined ? "automated" : "hibernated";
}

export const isAutomated = (row: UiWorkspaceRow): boolean => rowGroup(row) === "automated";

/** What the row's status cell shows. */
export type RowGlyph = "busy" | "idle" | "none" | "pending" | "failed" | "hibernated";

export function rowGlyph(row: UiWorkspaceRow): RowGlyph {
  switch (row.status) {
    case "creating":
    case "loading":
    case "deleting":
      return "pending";
    case "open-failed":
    case "delete-failed":
      return "failed";
    case "ready":
      break;
  }
  if (row.hibernated) return "hibernated";
  if (row.agent.type === "busy" || row.agent.type === "mixed") return "busy";
  return row.agent.type === "idle" ? "idle" : "none";
}

/**
 * How many rows show each status, by the glyph each shows now. A row counts at
 * most once: one mid-change is loading even if hibernated, a failed one nowhere.
 */
export interface RowCounts {
  readonly busy: number;
  readonly loading: number;
  readonly idle: number;
  readonly noAgent: number;
  readonly hibernated: number;
  readonly automated: number;
}

export function rowCounts(rows: readonly UiWorkspaceRow[]): RowCounts {
  const showing = (glyph: RowGlyph): readonly UiWorkspaceRow[] =>
    rows.filter((row) => rowGlyph(row) === glyph);
  const sleeping = showing("hibernated");
  const automated = sleeping.filter(isAutomated).length;
  return {
    busy: showing("busy").length,
    loading: showing("pending").length,
    idle: showing("idle").length,
    noAgent: showing("none").length,
    hibernated: sleeping.length - automated,
    automated,
  };
}

/** Names the counts that are shown, the non-zero ones; empty when there are none. */
export function describeRowCounts(counts: RowCounts): string {
  const named: readonly (readonly [number, string])[] = [
    [counts.busy, "working"],
    [counts.loading, "loading"],
    [counts.idle, "waiting for you"],
    [counts.noAgent, "no agent"],
    [counts.hibernated, "hibernated"],
    [counts.automated, "automated"],
  ];
  return named
    .filter(([count]) => count !== 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
}

/**
 * The status part of a row's accessible name ("alpha in web - 1 agent idle").
 * `hibernated` is the hibernated wording, which carries the row's age.
 */
export function rowStatusText(row: UiWorkspaceRow, hibernated: string): string {
  switch (row.status) {
    case "creating":
      return "Creating";
    case "loading":
      return "Loading";
    case "open-failed":
      return "Failed to open";
    case "deleting":
      return "Deleting";
    case "delete-failed":
      return "Deletion failed";
    case "ready":
      break;
  }
  if (row.hibernated) return hibernated;
  if (row.agent.type === "none") return "No agents running";
  const { idle, busy } = row.agent.counts;
  const agents = (count: number): string => `${count} ${count === 1 ? "agent" : "agents"}`;
  if (busy === 0) return `${agents(idle)} idle`;
  if (idle === 0) return `${agents(busy)} busy`;
  return `${idle} idle, ${busy} busy`;
}

/** An awake, ready row: one that can be hibernated (and counts in the footer summary). */
export const isAwakeReady = (row: UiWorkspaceRow): boolean =>
  row.status === "ready" && !row.hibernated;

/** The Find text as matched: trimmed, lower case. Empty outside Find. */
export function normalizedQuery(view: SidebarView): string {
  return view.find === null ? "" : view.query.trim().toLowerCase();
}

/** The words of a normalized Find text. */
const queryWords = (ql: string): readonly string[] => (ql === "" ? [] : ql.split(/\s+/));

/** Whether every word of the Find text is in a row's project, title, name, subtitle or a tag. */
export function matches(project: UiProjectRow, row: UiWorkspaceRow, ql: string): boolean {
  const fields = [
    project.name,
    row.title,
    row.name,
    row.subtitle,
    ...row.tags.flatMap((tag) => [tag.name, tag.label, tag.description]),
  ].flatMap((field) => (field === undefined ? [] : [field.toLowerCase()]));
  return queryWords(ql).every((word) => fields.some((field) => field.includes(word)));
}

/** Whether a project's automated rows are shown (outside Find). */
export function automatedShown(project: UiProjectRow): boolean {
  return (
    project.hibernatedView === "all" ||
    project.workspaces.some((row) => row.active && isAutomated(row))
  );
}

/** Which hibernated rows Find shows. */
function findShows(view: HibernatedView, row: UiWorkspaceRow): boolean {
  switch (rowGroup(row)) {
    case "awake":
      return true;
    case "hibernated":
      return view !== "hidden";
    case "automated":
      return view === "all";
  }
}

/** Is the row part of the list right now (before its project's own folds)? */
export function rowOn(project: UiProjectRow, row: UiWorkspaceRow, view: SidebarView): boolean {
  if (view.find !== null) {
    return matches(project, row, normalizedQuery(view)) && findShows(view.find.hibernatedView, row);
  }
  if (project.collapsed) return false;
  return !isAutomated(row) || automatedShown(project);
}

/**
 * The project's folds: whether it is expanded (its header says so), whether
 * its body is open and its hibernated list.
 */
export function projectFolds(
  project: UiProjectRow,
  view: SidebarView
): {
  readonly expanded: boolean;
  readonly bodyOpen: boolean;
  readonly hibernatedOpen: boolean;
} {
  if (view.find !== null) {
    return {
      expanded: true,
      bodyOpen: true,
      hibernatedOpen: view.find.hibernatedView !== "hidden",
    };
  }
  return {
    expanded: !project.collapsed,
    bodyOpen: !project.collapsed,
    hibernatedOpen:
      project.hibernatedView !== "hidden" ||
      project.workspaces.some((row) => row.active && row.hibernated),
  };
}

/** The row is out of sight: project collapsed, hibernated list closed, filtered or folded away. */
export function rowHidden(project: UiProjectRow, row: UiWorkspaceRow, view: SidebarView): boolean {
  const folds = projectFolds(project, view);
  return !folds.bodyOpen || (row.hibernated && !folds.hibernatedOpen) || !rowOn(project, row, view);
}

/** Rows the Find marker walks (in display order). */
export function markerRows(
  projects: readonly UiProjectRow[],
  view: SidebarView
): readonly UiWorkspaceRow[] {
  return projects.flatMap((project) =>
    project.workspaces.filter((row) => !rowHidden(project, row, view))
  );
}

/** The Find text matches nothing at all. */
export function nothingMatches(projects: readonly UiProjectRow[], view: SidebarView): boolean {
  if (normalizedQuery(view) === "") return false;
  return !projects.some((project) => project.workspaces.some((row) => rowOn(project, row, view)));
}

/** A project card is shown: always, except in Find when none of its rows match. */
export function projectShown(project: UiProjectRow, view: SidebarView): boolean {
  return (
    normalizedQuery(view) === "" || project.workspaces.some((row) => rowOn(project, row, view))
  );
}

/** A question (`ch ws ask`): shown in its workspace's row, never in the stack at the bottom. */
export const isQuestion = (note: UiNotification): boolean => note.config.type === "question";

/** The questions waiting in one row, newest on top. */
export function rowQuestions(
  notifications: readonly UiNotification[],
  key: string
): readonly UiNotification[] {
  return notifications.filter((note) => isQuestion(note) && note.workspace?.key === key).reverse();
}

/**
 * The project badge palette (PROJECT_COLOR_COUNT colors, each readable under
 * the badge's white letter). Main hands out the indices lowest first, so
 * neighbours in this list are far apart in hue.
 */
export const PROJECT_COLORS = [
  "#3b82f6",
  "#e0782f",
  "#22c55e",
  "#d946ef",
  "#0ea5a4",
  "#ef4444",
  "#7c6cff",
  "#ca8a04",
  "#ec4899",
  "#0891b2",
  "#65a30d",
  "#64748b",
] as const;

/** A project's badge color, from the palette index main assigned it. */
export function projectColor(colorIndex: number): string {
  return PROJECT_COLORS[colorIndex % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

/** The next view the moon button toggles to: open the hibernated list, or close it. */
export function moonToggle(view: HibernatedView): HibernatedView {
  return view === "hidden" ? "manual" : "hidden";
}

/** Split text into runs, marking the first match of each word of the Find text. */
export function highlightParts(
  text: string,
  ql: string
): readonly { readonly text: string; readonly marked: boolean }[] {
  const lower = text.toLowerCase();
  const hits = queryWords(ql)
    .map((word) => ({ start: lower.indexOf(word), length: word.length }))
    .filter((hit) => hit.start >= 0)
    .sort((a, b) => a.start - b.start);

  const marks: { start: number; end: number }[] = [];
  for (const { start, length } of hits) {
    const last = marks.at(-1);
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, start + length);
    else marks.push({ start, end: start + length });
  }

  const parts: { text: string; marked: boolean }[] = [];
  let position = 0;
  for (const { start, end } of marks) {
    if (start > position) parts.push({ text: text.slice(position, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    position = end;
  }
  if (position < text.length) parts.push({ text: text.slice(position), marked: false });
  return parts;
}
