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

/** An awake, ready row: one that can be hibernated (and counts in the footer summary). */
export const isAwakeReady = (row: UiWorkspaceRow): boolean =>
  row.status === "ready" && !row.hibernated;

/** No agent running counts as idle, like an idle one: both wait for the user. */
export const isIdleRow = (row: UiWorkspaceRow): boolean => {
  const glyph = rowGlyph(row);
  return glyph === "idle" || glyph === "none";
};

/** The Find text as matched: trimmed, lower case. Empty outside Find. */
export function normalizedQuery(view: SidebarView): string {
  return view.find === null ? "" : view.query.trim().toLowerCase();
}

/** Whether a row matches the Find text: its project, title, branch or a tag. */
export function matches(project: UiProjectRow, row: UiWorkspaceRow, ql: string): boolean {
  if (ql === "") return true;
  const words = [
    project.name,
    row.title,
    row.name,
    ...row.tags.flatMap((tag) => [tag.name, tag.label, tag.description]),
  ];
  return words.some((word) => word !== undefined && word.toLowerCase().includes(ql));
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
  return !isAutomated(row) || automatedShown(project);
}

/** The project's two folds: its body (expanded) and its hibernated list. */
export function projectFolds(
  project: UiProjectRow,
  view: SidebarView
): { readonly expanded: boolean; readonly hibernatedOpen: boolean } {
  if (view.find !== null) {
    return { expanded: true, hibernatedOpen: view.find.hibernatedView !== "hidden" };
  }
  return {
    expanded: !project.collapsed,
    hibernatedOpen:
      project.hibernatedView !== "hidden" ||
      project.workspaces.some((row) => row.active && row.hibernated),
  };
}

/** The row is out of sight: project collapsed, hibernated list closed, filtered or folded away. */
export function rowHidden(project: UiProjectRow, row: UiWorkspaceRow, view: SidebarView): boolean {
  const folds = projectFolds(project, view);
  return !folds.expanded || (row.hibernated && !folds.hibernatedOpen) || !rowOn(project, row, view);
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

/** A project's questions whose rows are out of sight (its header shows a question mark). */
export function hiddenQuestions(
  project: UiProjectRow,
  notifications: readonly UiNotification[],
  view: SidebarView
): readonly UiNotification[] {
  return notifications.filter((note) => {
    if (!isQuestion(note)) return false;
    const row = project.workspaces.find((candidate) => candidate.key === note.workspace?.key);
    return row !== undefined && rowHidden(project, row, view);
  });
}

/** A project's rows whose editor holds a question while the row is out of sight. */
export function hiddenAskingRows(
  project: UiProjectRow,
  view: SidebarView
): readonly UiWorkspaceRow[] {
  return project.workspaces.filter(
    (row) => row.editorQuestion === true && rowHidden(project, row, view)
  );
}

/** The colors a project's letter badge cycles through, picked by its name. */
const PROJECT_COLORS = [
  "#7c6cff",
  "#0ea5a4",
  "#e0782f",
  "#d946ef",
  "#22c55e",
  "#3b82f6",
  "#ef4444",
  "#f59e0b",
] as const;

/** A stable color for a project, derived from its name. */
export function projectColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

/** The next view the moon button toggles to: open the hibernated list, or close it. */
export function moonToggle(view: HibernatedView): HibernatedView {
  return view === "hidden" ? "manual" : "hidden";
}

/** Split text around the first match of the Find text, for highlighting. */
export function highlightParts(
  text: string,
  ql: string
): { readonly before: string; readonly match: string; readonly after: string } | null {
  if (ql === "") return null;
  const index = text.toLowerCase().indexOf(ql);
  if (index < 0) return null;
  return {
    before: text.slice(0, index),
    match: text.slice(index, index + ql.length),
    after: text.slice(index + ql.length),
  };
}
