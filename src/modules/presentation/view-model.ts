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
): Pick<WorkspaceModel, "hibernated" | "tags" | "title"> {
  return {
    hibernated: metadata["hibernated"] === "true",
    tags: extractTags(metadata),
    title: readTitle(metadata["title"]),
  };
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
