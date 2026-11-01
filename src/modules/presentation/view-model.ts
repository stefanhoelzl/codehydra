/**
 * The presenter's semantic view-model: open projects and their workspace rows.
 *
 * One index, keyed by workspace ref, holds every row (a creating placeholder
 * included) together with the project it belongs to. The ref is also the row's
 * UI identity — the `key` a snapshot row carries and the renderer echoes back —
 * so a key resolves with one map lookup, and the maps the presenter keeps beside
 * the model (deletions, released frames, agent status) share its keys.
 */

import type { WorkspaceTag } from "../../shared/api/types";
import { extractTags, readTitle } from "../../shared/api/types";
import type { UiWorkspaceRow } from "../../shared/ui-state";
import type { ProjectPath, ProjectRef, WorkspaceRef } from "../../intents/contract";
import { asWorkspaceRef } from "../../utils/ref";
import { decodeWakeup, WAKEUP_METADATA_KEY } from "../wakeup-module";

/**
 * The tag older versions set beside a wakeup script (an alarm clock). The
 * sidebar now shows such a workspace as automated instead, so the tag is
 * never shown even where it is still stored.
 */
const LEGACY_WAKEUP_TAG = "wakeup";

/**
 * Semantic workspace view-model. The UI cares about meanings, not metadata:
 * domain metadata is interpreted once at event intake (hibernated flag,
 * tags) and raw metadata is never stored.
 */
export interface WorkspaceModel {
  /** The workspace's identity; known from the start, a creation's placeholder included. */
  readonly ref: WorkspaceRef;
  readonly name: string;
  /**
   * User-given display title (metadata `title`); undefined when unset, so the
   * row falls back to `name`. Display-only — `name` stays the identity.
   */
  title: string | undefined;
  hibernated: boolean;
  /**
   * When it was hibernated (metadata `hibernated-at`, ISO-8601); undefined when
   * unrecorded or unparsable. Only meaningful while `hibernated`.
   */
  hibernatedAt: string | undefined;
  /**
   * The wakeup script (metadata `wakeup`, its `script` field); undefined when
   * there is none or it is unreadable. Only shown while `hibernated`.
   */
  wakeupScript: string | undefined;
  tags: WorkspaceTag[];
  url: string | undefined;
  /**
   * Where the workspace is in its open: `creating` (a new worktree, no path
   * yet), `loading` (a discovered worktree whose workspace:open has not
   * finished), `ready`, or `open-failed` (that open failed; `openError` says
   * why). Deletion is tracked apart, in the presenter's `deletions`.
   */
  phase: WorkspacePhase;
  openError?: string;
}

export type WorkspacePhase = "creating" | "loading" | "ready" | "open-failed";

export interface ProjectModel {
  readonly ref: ProjectRef;
  readonly id: string;
  readonly name: string;
  readonly path: ProjectPath;
  readonly remoteUrl: string | undefined;
}

/** A workspace row and the project it belongs to. */
export interface WorkspaceEntry {
  readonly project: ProjectModel;
  readonly workspace: WorkspaceModel;
}

/** A workspace row plus the model objects it was built from. */
export interface RowEntry extends WorkspaceEntry {
  readonly row: UiWorkspaceRow;
}

/** Interpret a workspace's domain metadata into the semantic model fields. */
export function fromMetadata(
  metadata: Readonly<Record<string, string>>
): Pick<WorkspaceModel, "hibernated" | "hibernatedAt" | "wakeupScript" | "tags" | "title"> {
  return {
    hibernated: metadata["hibernated"] === "true",
    hibernatedAt: readHibernatedAt(metadata["hibernated-at"]),
    wakeupScript: readWakeupScript(metadata[WAKEUP_METADATA_KEY]),
    tags: readTags(metadata),
    title: readTitle(metadata["title"]),
  };
}

/** A stored `wakeup` metadata value's script, or undefined. */
export function readWakeupScript(value: string | null | undefined): string | undefined {
  return decodeWakeup(value ?? undefined)?.script;
}

/** The tags a row shows: every tag but the legacy wakeup one. */
export function readTags(metadata: Readonly<Record<string, string>>): WorkspaceTag[] {
  return extractTags(metadata).filter((tag) => tag.name !== LEGACY_WAKEUP_TAG);
}

/**
 * Display order of a project's rows: hibernated without a wakeup script, then
 * hibernated with one (each most recently hibernated first; an unrecorded time
 * after the known ones), then the awake ones; ties and awake rows by name.
 */
export function compareRows(
  a: WorkspaceModel,
  b: WorkspaceModel,
  compareNames: (a: string, b: string) => number
): number {
  const group = (w: WorkspaceModel): number =>
    !w.hibernated ? 2 : w.wakeupScript === undefined ? 0 : 1;
  const byGroup = group(a) - group(b);
  if (byGroup !== 0) return byGroup;
  if (a.hibernated) {
    const at = (w: WorkspaceModel): number =>
      w.hibernatedAt === undefined ? -Infinity : Date.parse(w.hibernatedAt);
    const byTime = at(b) - at(a);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  }
  return compareNames(a.name, b.name);
}

/** A `hibernated-at` value as a valid ISO timestamp, or undefined. */
export function readHibernatedAt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

export class PresentationModel {
  /** Open projects by ref; insertion-ordered. */
  readonly projects = new Map<ProjectRef, ProjectModel>();
  /** Every workspace row by ref; insertion-ordered. */
  readonly workspaces = new Map<WorkspaceRef, WorkspaceEntry>();
  /** The active workspace's ref; null = nothing active (the creation panel shows). */
  activeRef: WorkspaceRef | null = null;

  /** The row behind a ref or an echoed snapshot key; undefined for a stale or foreign one. */
  find(key: string | null): WorkspaceEntry | undefined {
    if (key === null) return undefined;
    const ref = asWorkspaceRef(key);
    return ref === null ? undefined : this.workspaces.get(ref);
  }

  /** The active row, if the active ref still names one. */
  active(): WorkspaceEntry | undefined {
    return this.find(this.activeRef);
  }

  /**
   * A project's row by workspace name — for events that carry only the name
   * (a creation that failed, possibly before its name could make a ref).
   */
  findByName(project: ProjectModel, name: string): WorkspaceModel | undefined {
    for (const entry of this.workspaces.values()) {
      if (entry.project === project && entry.workspace.name === name) return entry.workspace;
    }
    return undefined;
  }

  /** A project by its snapshot id (what the renderer echoes in `close-project`). */
  projectById(id: string): ProjectModel | undefined {
    for (const project of this.projects.values()) {
      if (project.id === id) return project;
    }
    return undefined;
  }

  /** Add a project with its rows. */
  addProject(project: ProjectModel, workspaces: readonly WorkspaceModel[]): void {
    this.projects.set(project.ref, project);
    for (const workspace of workspaces) this.putWorkspace(project, workspace);
  }

  /** Drop a project and every row of it. */
  removeProject(ref: ProjectRef): void {
    const project = this.projects.get(ref);
    if (project === undefined) return;
    this.projects.delete(ref);
    for (const [workspaceRef, entry] of this.workspaces) {
      if (entry.project === project) this.workspaces.delete(workspaceRef);
    }
  }

  /** Add a row, or replace the one with the same ref in place (a placeholder's swap). */
  putWorkspace(project: ProjectModel, workspace: WorkspaceModel): void {
    this.workspaces.set(workspace.ref, { project, workspace });
  }

  /** Drop a row. */
  removeWorkspace(ref: WorkspaceRef): void {
    this.workspaces.delete(ref);
  }

  /** Each project's rows, in insertion order. Projects without rows map to an empty list. */
  workspacesByProject(): Map<ProjectModel, WorkspaceModel[]> {
    const grouped = new Map<ProjectModel, WorkspaceModel[]>();
    for (const project of this.projects.values()) grouped.set(project, []);
    for (const { project, workspace } of this.workspaces.values()) {
      grouped.get(project)?.push(workspace);
    }
    return grouped;
  }
}
