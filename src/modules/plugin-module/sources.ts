/**
 * `plugins.config`: where plugins come from, and the values their settings take.
 *
 * One setting, a YAML mapping, edited as text — in the settings dialog, with
 * `ch config set`, or through `ch plugin add|remove`. Each key names an entry;
 * its `type` (default `local`) says what kind:
 *
 *   default:                  # ~/.codehydra/plugins — always there, listed only to configure it
 *     config:
 *       github: {token: ghp_xxx}
 *   work:                     # another folder of plugins
 *     path: ~/work/ch-plugins
 *   acme:                     # a git repository of plugins
 *     type: remote
 *     url: git@github.com:acme/ch-plugins.git
 *     ref: main               # branch, tag or commit; default: its default branch
 *     path: plugins           # the folder in the repository that holds them
 *     config:
 *       deploy: {region: us}
 *   codehydra:                # a repository's own .codehydra/plugins
 *     type: project
 *     project: codehydra      # name, path or origin; default: the key
 *     config:
 *       setup: {db-url: postgres://127.0.0.1/dev}
 *
 * Local and remote entries are sources: folders laid out like
 * `~/.codehydra/plugins`, applying to every project. A project entry adds no
 * plugins — a repository's come from its worktree — it only gives its plugins'
 * settings their values. A plugin is named `<type>:<entry>:<plugin>`
 * (`remote:acme:deploy`); a repository's plugins take the project's name
 * (`project:codehydra:setup`).
 *
 * The schema is strict, like a manifest's: an unknown key is an error, so a
 * typo is reported rather than silently doing nothing.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { Document, isMap, parseDocument } from "yaml";
import { Path } from "../../utils/path/path";
import { SETTING_NAME, type SettingValue } from "./plugin-config";
import { describeIssue, isPlainObject } from "./util";

export type SourceType = "local" | "remote" | "project";

/** The entry for `~/.codehydra/plugins`: always present, never removed. */
export const DEFAULT_SOURCE = "default";

/** Entry names become parts of plugin names and directory names, so they stay plain. */
export const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Plugin names, as discovery requires them. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The values one entry gives its plugins' settings, by plugin name. */
export type PluginValues = Readonly<Record<string, Readonly<Record<string, SettingValue>>>>;

interface EntryBase {
  /** The entry's key in `plugins.config`. */
  readonly key: string;
  readonly values: PluginValues;
}

export interface LocalSourceEntry extends EntryBase {
  readonly type: "local";
  /** The folder as written (`~` not yet expanded); null for the default folder. */
  readonly path: string | null;
}

export interface RemoteSourceEntry extends EntryBase {
  readonly type: "remote";
  readonly url: string;
  /** Branch, tag or commit; absent = the repository's default branch. */
  readonly ref?: string;
  /** The folder inside the repository that holds the plugins; absent = its root. */
  readonly path?: string;
}

export interface ProjectSourceEntry extends EntryBase {
  readonly type: "project";
  /** The project, as a short reference (name, path or origin). */
  readonly project: string;
}

export type SourceEntry = LocalSourceEntry | RemoteSourceEntry | ProjectSourceEntry;

// =============================================================================
// Schema
// =============================================================================

const valuesSchema = z
  .record(
    z.string().regex(PLUGIN_NAME, { error: "a plugin name (letters, digits, ., - and _)" }),
    z.record(
      z.string().regex(SETTING_NAME, {
        error: "setting names use letters, digits, - and _ (and start with a letter)",
      }),
      z.union([z.string(), z.number(), z.boolean()])
    )
  )
  .describe("Values for the plugins' settings, by plugin name, then setting name.");

const localSchema = z
  .object({
    type: z.literal("local"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("The folder of plugins: absolute, or starting with ~ (not for default)."),
    config: valuesSchema.optional(),
  })
  .strict();

const remoteSchema = z
  .object({
    type: z.literal("remote"),
    url: z.string().min(1).describe("The repository to clone, as git accepts it."),
    ref: z
      .string()
      .min(1)
      .optional()
      .describe("Branch, tag or commit (default: the repository's default branch)."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("The folder inside the repository that holds the plugins (default: its root)."),
    config: valuesSchema.optional(),
  })
  .strict();

const projectSchema = z
  .object({
    type: z.literal("project"),
    project: z
      .string()
      .min(1)
      .optional()
      .describe("The project: its name, path or origin (default: the entry's key)."),
    config: valuesSchema.optional(),
  })
  .strict();

const entrySchema = z.preprocess(
  // `type` defaults to local, but the union needs it to tell the shapes apart.
  (value) =>
    isPlainObject(value) && value["type"] === undefined ? { ...value, type: "local" } : value,
  z.discriminatedUnion("type", [localSchema, remoteSchema, projectSchema])
);

/** A local folder: absolute, or under the home directory. */
function isUsableLocalPath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || isAbsolute(path);
}

/** A folder inside a repository: relative, and staying inside it. */
function isUsableRepoPath(path: string): boolean {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((segment) => segment === "..");
}

/** The problem with an entry the schema accepted, if it has one. */
function entryProblem(key: string, entry: z.infer<typeof entrySchema>): string | undefined {
  if (entry.type === "local") {
    if (key === DEFAULT_SOURCE) {
      return entry.path === undefined
        ? undefined
        : `${key}.path: the default entry is always ~/.codehydra/plugins`;
    }
    if (entry.path === undefined) return `${key}.path: a local entry needs the folder it reads`;
    return isUsableLocalPath(entry.path)
      ? undefined
      : `${key}.path: must be absolute or start with ~`;
  }
  if (key === DEFAULT_SOURCE) return `${key}: the default entry is a local one`;
  if (entry.type === "remote" && entry.path !== undefined && !isUsableRepoPath(entry.path)) {
    return `${key}.path: must be a folder inside the repository`;
  }
  return undefined;
}

// =============================================================================
// Parsing
// =============================================================================

/** `plugins.config` that cannot be read, with the first thing wrong in it. */
export class SourcesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcesConfigError";
  }
}

/**
 * Read `plugins.config`. The default entry is always first, whether or not the
 * text lists it; the rest follow in the order written. Empty text is just the
 * default entry. Throws `SourcesConfigError` naming the first problem.
 */
export function parseSourcesConfig(text: string): SourceEntry[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new SourcesConfigError(doc.errors[0]!.message);
  const raw = doc.toJS() as unknown;
  if (raw !== null && raw !== undefined && !isPlainObject(raw)) {
    throw new SourcesConfigError("must be a mapping of entry names to entries");
  }

  const entries: SourceEntry[] = [];
  let sawDefault = false;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!SOURCE_NAME.test(key)) {
      throw new SourcesConfigError(
        `"${key}" is not a usable entry name (letters, digits, ., - and _)`
      );
    }
    const parsed = entrySchema.safeParse(value ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new SourcesConfigError(
        `${key}${issue.path.length > 0 ? "." : ": "}${describeIssue(issue, "key")}`
      );
    }
    const problem = entryProblem(key, parsed.data);
    if (problem !== undefined) throw new SourcesConfigError(problem);

    const entry = toEntry(key, parsed.data);
    if (key === DEFAULT_SOURCE) {
      sawDefault = true;
      entries.unshift(entry);
    } else {
      entries.push(entry);
    }
  }
  if (!sawDefault) entries.unshift({ key: DEFAULT_SOURCE, type: "local", path: null, values: {} });
  return entries;
}

function toEntry(key: string, entry: z.infer<typeof entrySchema>): SourceEntry {
  const values = entry.config ?? {};
  switch (entry.type) {
    case "local":
      return { key, type: "local", path: entry.path ?? null, values };
    case "remote":
      return {
        key,
        type: "remote",
        url: entry.url,
        ...(entry.ref !== undefined && { ref: entry.ref }),
        ...(entry.path !== undefined && { path: entry.path }),
        values,
      };
    case "project":
      return { key, type: "project", project: entry.project ?? key, values };
  }
}

/** A local entry's folder, `~` expanded. */
export function localSourcePath(path: string, home: string = homedir()): Path {
  if (path === "~") return new Path(home);
  if (path.startsWith("~/") || path.startsWith("~\\")) return new Path(home, path.slice(2));
  return new Path(path);
}

// =============================================================================
// Editing
// =============================================================================

/**
 * Add an entry to `plugins.config` text, keeping its comments and layout.
 * Throws `SourcesConfigError` when the key is taken or the result is invalid.
 */
export function addSourceEntry(text: string, key: string, entry: Record<string, unknown>): string {
  let doc: Document = parseDocument(text);
  if (doc.errors.length > 0) throw new SourcesConfigError(doc.errors[0]!.message);
  if (doc.contents === null) {
    // Empty, or only comments: start a mapping, keeping what was said above it.
    const fresh = new Document({});
    const comments = [doc.commentBefore, doc.comment].filter(
      (comment): comment is string => typeof comment === "string" && comment !== ""
    );
    if (comments.length > 0) fresh.commentBefore = comments.join("\n");
    doc = fresh;
  }
  if (!isMap(doc.contents)) {
    throw new SourcesConfigError("must be a mapping of entry names to entries");
  }
  if (doc.has(key)) throw new SourcesConfigError(`there is already an entry named ${key}`);
  doc.set(key, doc.createNode(entry));
  const next = doc.toString();
  parseSourcesConfig(next);
  return next;
}

/**
 * Remove an entry from `plugins.config` text, keeping the rest as written.
 * Returns undefined when there is no such entry.
 */
export function removeSourceEntry(text: string, key: string): string | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new SourcesConfigError(doc.errors[0]!.message);
  if (!isMap(doc.contents) || !doc.has(key)) return undefined;
  doc.delete(key);
  if (!isMap(doc.contents) || doc.contents.items.length > 0) return doc.toString();
  // The last entry gone: keep what was said around it, not an empty `{}`.
  const comments = [doc.commentBefore, doc.contents.commentBefore, doc.comment].filter(
    (comment): comment is string => typeof comment === "string" && comment !== ""
  );
  return comments.map((comment) => `${comment.replace(/^(?=.)/gm, "#")}\n`).join("");
}
