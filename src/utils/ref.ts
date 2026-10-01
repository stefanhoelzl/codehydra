/**
 * Workspace and project refs: the one identity a workspace or project has.
 *
 *   ch::<machine>::<project>                (ProjectRef)
 *   ch::<machine>::<project>::<workspace>   (WorkspaceRef)
 *
 * e.g. `ch::local::github.com/org/codehydra::feature/x`.
 *
 * - **machine** names the machine the clone lives on. Only `local` exists today.
 * - **project** is a location on that machine, but never one CodeHydra may move: a
 *   managed clone is named by its normalized origin (`normalizeGitUrl`), an existing
 *   checkout by its path (`Path`-normalized, so lowercased on Windows).
 * - **workspace** is the workspace's name — its branch when it was created, fixed
 *   for life however the branch changes afterwards.
 *
 * A ref is split at its first and its last `::`. The machine (ours) and the name
 * (branch characters, which exclude `:`) never contain one, so the project between
 * them is kept verbatim and never escaped — a checkout path may contain anything.
 * Because of that, a ref cannot say on its own whether it names a project or a
 * workspace: the reader always knows which it expects, so it asks for one.
 *
 * Refs are compared with `===` and used as Map keys, so every ref is built here and
 * nowhere else: one spelling per workspace.
 */

import {
  projectRefSchema,
  workspaceRefSchema,
  type ProjectRef,
  type WorkspaceRef,
} from "../intents/contract";
import { Path } from "./path/path";
import { normalizeGitUrl } from "./url-utils";

/** Leading segment of every ref; sets a ref apart from a name or a path. */
export const REF_SCHEME = "ch";
/** Between the parts of a ref. */
export const REF_SEPARATOR = "::";
/** The machine the app itself runs on. */
export const LOCAL_MACHINE = "local";

const PREFIX = `${REF_SCHEME}${REF_SEPARATOR}`;
const MACHINE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;

/** Where a project lives, which decides how its ref names it. */
export type ProjectLocation =
  | { readonly kind: "managed"; readonly origin: string }
  | { readonly kind: "checkout"; readonly path: string };

/** The parts of a project ref. */
export interface ProjectRefParts {
  readonly machine: string;
  /** The normalized origin of a managed clone, or the path of a checkout. */
  readonly project: string;
  readonly kind: "managed" | "checkout";
}

/** The parts of a workspace ref. */
export interface WorkspaceRefParts extends ProjectRefParts {
  readonly projectRef: ProjectRef;
  readonly name: string;
}

/** Whether a value is written as a ref (rather than a name or a path). */
export function isRef(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** The project part of a ref for a location: a normalized origin, or a normalized path. */
export function projectPart(location: ProjectLocation): string {
  return location.kind === "managed"
    ? normalizeGitUrl(location.origin)
    : new Path(location.path).toString();
}

/** The ref of the project at `location` on `machine`. */
export function makeProjectRef(location: ProjectLocation, machine = LOCAL_MACHINE): ProjectRef {
  const project = projectPart(location);
  if (!MACHINE_PATTERN.test(machine)) throw new Error(`Invalid machine name: "${machine}"`);
  if (project.length === 0) throw new Error("A project ref needs a project");
  return projectRefSchema.parse(`${PREFIX}${machine}${REF_SEPARATOR}${project}`);
}

/** The ref of workspace `name` in `project`. */
export function makeWorkspaceRef(project: ProjectRef, name: string): WorkspaceRef {
  if (!isValidRefName(name)) throw new Error(`Invalid workspace name for a ref: "${name}"`);
  return workspaceRefSchema.parse(`${project}${REF_SEPARATOR}${name}`);
}

/** Whether `name` can be the last part of a workspace ref. */
export function isValidRefName(name: string): boolean {
  return name.length > 0 && !name.includes(":");
}

/** The parts of a project ref, or null when `value` is not one. */
export function parseProjectRef(value: string): ProjectRefParts | null {
  if (!isRef(value)) return null;
  const rest = value.slice(PREFIX.length);
  const cut = rest.indexOf(REF_SEPARATOR);
  if (cut < 0) return null;
  const machine = rest.slice(0, cut);
  const project = rest.slice(cut + REF_SEPARATOR.length);
  if (!MACHINE_PATTERN.test(machine) || project.length === 0) return null;
  return { machine, project, kind: isPathLike(project) ? "checkout" : "managed" };
}

/** The parts of a workspace ref, or null when `value` is not one. */
export function parseWorkspaceRef(value: string): WorkspaceRefParts | null {
  const cut = value.lastIndexOf(REF_SEPARATOR);
  if (cut < 0) return null;
  const name = value.slice(cut + REF_SEPARATOR.length);
  const projectRef = value.slice(0, cut);
  const project = parseProjectRef(projectRef);
  if (project === null || !isValidRefName(name)) return null;
  return { ...project, projectRef: projectRefSchema.parse(projectRef), name };
}

/** The project ref a workspace ref belongs to. */
export function projectRefOf(workspace: WorkspaceRef): ProjectRef {
  const parts = parseWorkspaceRef(workspace);
  if (parts === null) throw new Error(`Not a workspace ref: "${workspace}"`);
  return parts.projectRef;
}

/** The name part of a workspace ref. */
export function workspaceNameOf(workspace: WorkspaceRef): string {
  const parts = parseWorkspaceRef(workspace);
  if (parts === null) throw new Error(`Not a workspace ref: "${workspace}"`);
  return parts.name;
}

/** A project ref as `ProjectRef`, or null when `value` is not one. */
export function asProjectRef(value: string): ProjectRef | null {
  return parseProjectRef(value) === null ? null : projectRefSchema.parse(value);
}

/** A workspace ref as `WorkspaceRef`, or null when `value` is not one. */
export function asWorkspaceRef(value: string): WorkspaceRef | null {
  return parseWorkspaceRef(value) === null ? null : workspaceRefSchema.parse(value);
}

/**
 * A short workspace reference, split into the project it names (if any) and the
 * workspace name. `name` alone means the caller's own project; `<project>::<name>`
 * names the project the short project forms do (a name, a path, an origin). A full
 * ref is not short — check `isRef` first.
 */
export function splitWorkspaceReference(reference: string): {
  readonly project: string | null;
  readonly name: string;
} {
  const cut = reference.lastIndexOf(REF_SEPARATOR);
  if (cut < 0) return { project: null, name: reference };
  return {
    project: reference.slice(0, cut),
    name: reference.slice(cut + REF_SEPARATOR.length),
  };
}

/**
 * Whether a project part is a checkout path rather than a managed origin. A
 * normalized origin starts with its host, never with `/` or a drive letter.
 */
function isPathLike(project: string): boolean {
  return project.startsWith("/") || /^[A-Za-z]:\//.test(project);
}
