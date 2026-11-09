/**
 * Workspace and project refs: the one identity a workspace or project has.
 *
 *   ch::<machine>::<type>::<identifier>                (ProjectRef)
 *   ch::<machine>::<type>::<identifier>::<workspace>   (WorkspaceRef)
 *
 * e.g. `ch::local::git::github.com/org/codehydra::feature/x`.
 *
 * - **machine** names the machine the project lives on. Only `local` exists today.
 * - **type** names the project type that owns the project (`git` is the only one).
 * - **identifier** is what that type names the project by, derived by the type's
 *   module from its config — never here. Git names a managed clone by its
 *   normalized origin and an existing checkout by its path.
 * - **workspace** is the workspace's name — its branch when it was created, fixed
 *   for life however the branch changes afterwards.
 *
 * A ref is read as `ch`, the machine and the type, then the identifier up to the
 * last `::`. The machine and the type (both restricted) and the name (branch
 * characters, which exclude `:`) never contain one, so the identifier between
 * them is kept verbatim and never escaped — a checkout path may contain anything.
 * Because of that, a ref cannot say on its own whether it names a project or a
 * workspace: the reader always knows which it expects, so it asks for one.
 *
 * Refs from before project types (`ch::<machine>::<project>[::<workspace>]`) are
 * still read, as git: their project part is an origin or an absolute path, so it
 * contains a `/` and its first segment never looks like a type name. Reading one
 * gives the ref in today's form; only that form is ever built.
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

/** Leading segment of every ref; sets a ref apart from a name or a path. */
export const REF_SCHEME = "ch";
/** Between the parts of a ref. */
export const REF_SEPARATOR = "::";
/** The machine the app itself runs on. */
export const LOCAL_MACHINE = "local";
/**
 * The type a reference naming none means: a ref from before project types (every
 * project then was git), or a short project form without `<type>::`.
 */
export const DEFAULT_PROJECT_TYPE = "git";

const PREFIX = `${REF_SCHEME}${REF_SEPARATOR}`;
const MACHINE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The parts of a project ref. */
export interface ProjectRefParts {
  readonly machine: string;
  /** The project type that owns the project. */
  readonly type: string;
  /** What that type names the project by. */
  readonly identifier: string;
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

/**
 * Whether `type` can be a project type's name: lower case, starting with a
 * letter. Never a path (`/`, `c:`) nor an origin (`.`, `/`), which is what keeps
 * a ref from before project types apart from one of today.
 */
export function isValidProjectType(type: string): boolean {
  return TYPE_PATTERN.test(type);
}

/** The ref of the project that `type` names `identifier`, on `machine`. */
export function makeProjectRef(
  type: string,
  identifier: string,
  machine = LOCAL_MACHINE
): ProjectRef {
  if (!MACHINE_PATTERN.test(machine)) throw new Error(`Invalid machine name: "${machine}"`);
  if (!isValidProjectType(type)) throw new Error(`Invalid project type: "${type}"`);
  if (identifier.length === 0) throw new Error("A project ref needs an identifier");
  return projectRefSchema.parse(
    `${PREFIX}${machine}${REF_SEPARATOR}${type}${REF_SEPARATOR}${identifier}`
  );
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

/**
 * The parts of a project ref, or null when `value` is not one. A ref from
 * before project types reads as git.
 */
export function parseProjectRef(value: string): ProjectRefParts | null {
  if (!isRef(value)) return null;
  const rest = value.slice(PREFIX.length);
  const cut = rest.indexOf(REF_SEPARATOR);
  if (cut < 0) return null;
  const machine = rest.slice(0, cut);
  if (!MACHINE_PATTERN.test(machine)) return null;
  const project = rest.slice(cut + REF_SEPARATOR.length);

  const typeCut = project.indexOf(REF_SEPARATOR);
  const type = typeCut < 0 ? project : project.slice(0, typeCut);
  if (isValidProjectType(type)) {
    const identifier = typeCut < 0 ? "" : project.slice(typeCut + REF_SEPARATOR.length);
    return identifier.length === 0 ? null : { machine, type, identifier };
  }
  // Before project types: an origin or an absolute path, either holding a `/`
  return project.includes("/")
    ? { machine, type: DEFAULT_PROJECT_TYPE, identifier: project }
    : null;
}

/** The parts of a workspace ref, or null when `value` is not one. */
export function parseWorkspaceRef(value: string): WorkspaceRefParts | null {
  const cut = value.lastIndexOf(REF_SEPARATOR);
  if (cut < 0) return null;
  const name = value.slice(cut + REF_SEPARATOR.length);
  const project = parseProjectRef(value.slice(0, cut));
  if (project === null || !isValidRefName(name)) return null;
  return { ...project, projectRef: refOfParts(project), name };
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

/**
 * A project's name for showing to a person: the last part of its identifier
 * (`github.com/org/codehydra` and `/home/s/codehydra` are both `codehydra`).
 */
export function projectNameOf(project: ProjectRef): string {
  const part = parseProjectRef(project)?.identifier ?? project;
  return part.slice(part.lastIndexOf("/") + 1) || part;
}

/**
 * A project ref as `ProjectRef`, in today's form, or null when `value` is not
 * one. A ref from before project types comes back as the git ref it names.
 */
export function asProjectRef(value: string): ProjectRef | null {
  const parts = parseProjectRef(value);
  return parts === null ? null : refOfParts(parts);
}

/**
 * A workspace ref as `WorkspaceRef`, in today's form, or null when `value` is
 * not one. A ref from before project types comes back as the git ref it names.
 */
export function asWorkspaceRef(value: string): WorkspaceRef | null {
  const parts = parseWorkspaceRef(value);
  return parts === null ? null : makeWorkspaceRef(parts.projectRef, parts.name);
}

/**
 * A short workspace reference, split into the project it names (if any) and the
 * workspace name. `name` alone means the caller's own project; `<project>::<name>`
 * names the project the short project forms do (a name, a path, an origin, a
 * `<type>::<identifier>`). A full ref is not short — check `isRef` first.
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
 * A short project reference naming its type, `<type>::<identifier>`, split; null
 * when `reference` does not start with one of the `types` given. A short form
 * without a type names a git project.
 */
export function splitTypedProjectReference(
  reference: string,
  types: ReadonlySet<string>
): { readonly type: string; readonly identifier: string } | null {
  const cut = reference.indexOf(REF_SEPARATOR);
  if (cut <= 0) return null;
  const type = reference.slice(0, cut);
  const identifier = reference.slice(cut + REF_SEPARATOR.length);
  return types.has(type) && identifier.length > 0 ? { type, identifier } : null;
}

function refOfParts(parts: ProjectRefParts): ProjectRef {
  return makeProjectRef(parts.type, parts.identifier, parts.machine);
}
