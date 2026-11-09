/**
 * ProjectStoreModule - The core project store: what CodeHydra keeps about every
 * project, whatever its type.
 *
 * Owns the project records (`<projectsDir>/<dir>/config.json`), the in-memory
 * map of open projects, project ids and badge colors. A record holds the
 * project's `type`, that type's opaque `config` and its badge `color`; only the
 * type's module reads `config`. Records written before project types existed
 * hold `path` / `remoteUrl` at the top level; they are read as git projects and
 * rewritten in the new shape the next time they are written.
 *
 * Hook registrations:
 * - resolve-project: projectRef → projectId + projectPath + projectName (open projects)
 * - project:open  → register:      generate ID, assign color, persist the record
 * - project:close → close:         drop from state, remove the record (frees its color)
 * - app:ready     → load-projects: every saved project's { type, config }
 * - list-projects → list-projects: every open project
 *
 * The type modules (for now only git: local-project-module, remote-project-module)
 * resolve a project at open, turn a saved project back into an open payload at
 * restore, and clean up their own on-disk state at close.
 */

import * as crypto from "node:crypto";
import { normalize } from "node:path";
import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { ProjectId } from "../shared/api/types";
import { projectPathSchema } from "../intents/contract";
import type { ProjectPath, ProjectRef } from "../intents/contract";
import { Path } from "../utils/path/path";
import { managedProjectDirName, projectDirName } from "../boundaries/platform/paths";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { SupportedPlatform } from "../boundaries/platform/platform-info";
import type { Logger } from "../boundaries/platform/logging";
import { PROJECT_COLOR_COUNT } from "../shared/ui-state";
import { ProjectStoreError, getErrorMessage } from "../shared/errors/service-errors";
import {
  OPEN_PROJECT_OPERATION_ID,
  type ProjectType,
  type ProjectTypeConfig,
  type RegisterHookResult,
} from "../intents/open-project";
import { CLOSE_PROJECT_OPERATION_ID, type CloseHookResult } from "../intents/close-project";
import { APP_READY_OPERATION_ID, type LoadProjectsResult } from "../intents/app-ready";
import {
  RESOLVE_PROJECT_OPERATION_ID,
  type ResolveHookResult as ResolveProjectHookResult,
} from "../intents/resolve-project";
import {
  LIST_PROJECTS_OPERATION_ID,
  type ListProjectsHookResult,
  type ListProjectsHookEntry,
} from "../intents/list-projects";
import { defineHooks } from "../intents/declarations";

// =============================================================================
// Records
// =============================================================================

/** The type a record written before project types existed belongs to: every one was git. */
export const LEGACY_RECORD_TYPE = "git";

/** A project's record, as stored. */
export interface ProjectRecord {
  readonly type: ProjectType;
  readonly config: ProjectTypeConfig;
  /** Index into the sidebar's badge palette (see assignColor); absent until first assigned. */
  readonly color?: number;
}

/** A record together with the name of the directory under projectsDir it lives in. */
export interface StoredRecord extends ProjectRecord {
  readonly dirName: string;
}

export type ProjectStoreFs = Pick<
  FileSystemBoundary,
  "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm"
>;

const RECORD_FILE = "config.json";

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one record. A record without a `type` predates project types: it is a
 * git project, and its top-level `path` / `remoteUrl` are that type's config.
 */
export function parseRecord(content: string): ProjectRecord | undefined {
  const parsed: unknown = JSON.parse(content);
  if (!isPlainObject(parsed)) return undefined;
  const color = Number.isInteger(parsed.color) ? (parsed.color as number) : undefined;
  const withColor = color !== undefined ? { color } : {};

  if (parsed.type !== undefined) {
    if (typeof parsed.type !== "string" || parsed.type.length === 0) return undefined;
    if (!isPlainObject(parsed.config)) return undefined;
    return { type: parsed.type, config: parsed.config, ...withColor };
  }

  const legacy = {
    ...(typeof parsed.path === "string" && { path: parsed.path }),
    ...(typeof parsed.remoteUrl === "string" && { remoteUrl: parsed.remoteUrl }),
  };
  if (Object.keys(legacy).length === 0) return undefined;
  return { type: LEGACY_RECORD_TYPE, config: legacy, ...withColor };
}

/** Every readable record under projectsDir. Unreadable or malformed ones are skipped. */
export async function loadProjectRecords(
  fs: Pick<FileSystemBoundary, "readdir" | "readFile">,
  projectsDir: string
): Promise<readonly StoredRecord[]> {
  let entries;
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    // Directory doesn't exist or other error - nothing stored
    return [];
  }

  const results: StoredRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    try {
      const record = parseRecord(await fs.readFile(new Path(projectsDir, entry.name, RECORD_FILE)));
      if (record) results.push({ ...record, dirName: entry.name });
    } catch {
      // Skip invalid entries (ENOENT, malformed JSON, etc.)
      continue;
    }
  }
  return results;
}

async function saveRecord(
  fs: ProjectStoreFs,
  projectsDir: string,
  dirName: string,
  record: ProjectRecord
): Promise<void> {
  const projectDir = new Path(projectsDir, dirName);
  const content = {
    type: record.type,
    config: record.config,
    ...(record.color !== undefined && { color: record.color }),
  };
  try {
    await fs.mkdir(projectDir);
    await fs.writeFile(new Path(projectDir, RECORD_FILE), JSON.stringify(content, null, 2));
  } catch (error: unknown) {
    throw new ProjectStoreError(`Failed to save project: ${getErrorMessage(error)}`);
  }
}

/** JSON with object keys sorted, so two equal configs compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether a record is the one for this project: the same type and the same config. */
function isRecordOf(record: ProjectRecord, type: ProjectType, config: ProjectTypeConfig): boolean {
  return record.type === type && canonicalJson(record.config) === canonicalJson(config);
}

/**
 * The directory a new project's record goes in: named after its origin when it
 * has one (a clone is identified by its URL, wherever it sits), else after its
 * path. An existing record stays in the directory it was found in.
 */
function newRecordDirName(projectPath: string, remoteUrl: string | undefined): string {
  return remoteUrl !== undefined ? managedProjectDirName(remoteUrl) : projectDirName(projectPath);
}

// =============================================================================
// Badge colors and ids
// =============================================================================

/**
 * The badge color for a project being opened: the one its record keeps, unless
 * another open project has it by now; else the lowest index none has. With
 * every color taken, they repeat in order.
 */
export function assignColor(kept: number | undefined, taken: readonly number[]): number {
  const isFree = (index: number): boolean => !taken.includes(index);
  if (kept !== undefined && kept >= 0 && kept < PROJECT_COLOR_COUNT && isFree(kept)) return kept;
  for (let index = 0; index < PROJECT_COLOR_COUNT; index++) {
    if (isFree(index)) return index;
  }
  return taken.length % PROJECT_COLOR_COUNT;
}

function normalizePathForId(absolutePath: string, platform: SupportedPlatform): string {
  let normalized = normalize(absolutePath);
  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * A project's id: its sanitized basename plus a hash of its normalized path.
 * Case-folded on Windows, whose paths are case-insensitive. Persisted (it names
 * the project's screenshot directory), so the derivation must not change.
 */
export function generateProjectId(absolutePath: string, platform: SupportedPlatform): ProjectId {
  const normalizedPath = normalizePathForId(absolutePath, platform);
  const basename = normalizedPath.split("/").pop() ?? "";
  const safeName =
    basename
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root";
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
  return `${safeName}-${hash}` as ProjectId;
}

// =============================================================================
// Module
// =============================================================================

export interface ProjectStoreModuleDeps {
  readonly projectsDir: string;
  readonly fs: ProjectStoreFs;
  /** Host platform: project ids are case-folded on Windows. */
  readonly platform: SupportedPlatform;
  readonly logger: Logger;
}

/** An open project, as the store tracks it. */
interface OpenProject {
  readonly ref: ProjectRef;
  readonly id: ProjectId;
  readonly name: string;
  /** Index into the sidebar's badge palette (see assignColor). */
  readonly color: number;
  /** The directory its record lives in. */
  readonly dirName: string;
}

/** The project store, plus what other modules may ask it. */
export interface ProjectStoreModule extends IntentModule {
  /** Every saved project's record, open or not. */
  records(): Promise<readonly StoredRecord[]>;
  /** Whether the project at this path is open. */
  isOpen(projectPath: string): boolean;
  /** An open project's badge color (see assignColor); undefined if it is not open. */
  projectColor(projectRef: ProjectRef): number | undefined;
}

export function createProjectStoreModule(deps: ProjectStoreModuleDeps): ProjectStoreModule {
  const { projectsDir, fs, logger } = deps;

  // Keyed by the branded project path, so a key can be handed straight back to the
  // contract (e.g. the list-projects hook result) without re-minting the brand.
  const projects = new Map<ProjectPath, OpenProject>();

  const keyOf = (projectPath: string): ProjectPath =>
    projectPathSchema.parse(new Path(projectPath).toString());

  /**
   * Remove a closed project's record, then its directory if that is now empty.
   * Best-effort: the project is already out of state. Whatever else the
   * directory holds belongs to the project's type, which cleans it up itself.
   */
  async function removeRecord(dirName: string): Promise<void> {
    const projectDir = new Path(projectsDir, dirName);
    try {
      await fs.unlink(new Path(projectDir, RECORD_FILE));
    } catch (error: unknown) {
      logger.debug("No project record to remove", {
        dir: dirName,
        error: getErrorMessage(error),
      });
    }
    try {
      await fs.rm(projectDir);
    } catch {
      // ENOTEMPTY (the type still has files there) or ENOENT - that's fine
    }
  }

  return {
    name: "project-store",
    records: () => loadProjectRecords(fs, projectsDir),
    isOpen: (projectPath) => projects.has(keyOf(projectPath)),
    projectColor(projectRef) {
      for (const project of projects.values()) {
        if (project.ref === projectRef) return project.color;
      }
      return undefined;
    },
    hooks: defineHooks({
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx): Promise<HookOutput<ResolveProjectHookResult>> => {
            for (const [projectPath, project] of projects) {
              if (project.ref !== ctx.projectRef) continue;
              return { result: { projectId: project.id, projectPath, projectName: project.name } };
            }
            return { result: {} };
          },
        },
      },

      [OPEN_PROJECT_OPERATION_ID]: {
        // register: generate ID, assign the badge color, persist the record
        register: {
          handler: async (ctx): Promise<HookOutput<RegisterHookResult>> => {
            const { projectPath: projectPathStr, projectRef, remoteUrl, type, config } = ctx;

            const projectPath = new Path(projectPathStr);
            const key = keyOf(projectPathStr);
            const projectId = generateProjectId(projectPathStr, deps.platform);
            const name = projectPath.basename;

            if (projects.has(key)) {
              return { result: { projectId, name, alreadyOpen: true } };
            }
            if (type === undefined || config === undefined) {
              throw new Error(`No project type resolved for ${projectPathStr}`);
            }

            const existing = (await loadProjectRecords(fs, projectsDir)).find((record) =>
              isRecordOf(record, type, config)
            );
            // A record keeps its badge color while no other open project has it.
            // Picked and added to internal state with no await in between:
            // startup opens the saved projects in parallel.
            const color = assignColor(
              existing?.color,
              [...projects.values()].map((project) => project.color)
            );
            const dirName = existing?.dirName ?? newRecordDirName(key, remoteUrl);
            projects.set(key, { ref: projectRef, id: projectId, name, color, dirName });

            // Persist if new, or if its color changed
            if (!existing || existing.color !== color) {
              try {
                await saveRecord(fs, projectsDir, dirName, { type, config, color });
              } catch (error: unknown) {
                projects.delete(key);
                throw error;
              }
            }

            return { result: { projectId, name } };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // close: drop from state and remove the record, which frees its color
        close: {
          handler: async (ctx): Promise<HookOutput<CloseHookResult>> => {
            const key = keyOf(ctx.projectPath);
            const project = projects.get(key);
            projects.delete(key);
            if (project) await removeRecord(project.dirName);
            return { result: { otherProjectsExist: projects.size > 0 } };
          },
        },
      },

      [APP_READY_OPERATION_ID]: {
        // load-projects: every saved project, for its type's module to restore
        "load-projects": {
          handler: async (): Promise<HookOutput<LoadProjectsResult>> => {
            const records = await loadProjectRecords(fs, projectsDir);
            return {
              result: { projects: records.map(({ type, config }) => ({ type, config })) },
            };
          },
        },
      },

      [LIST_PROJECTS_OPERATION_ID]: {
        "list-projects": {
          handler: async (): Promise<HookOutput<ListProjectsHookResult>> => {
            const entries: ListProjectsHookEntry[] = [];
            for (const [key, project] of projects) {
              entries.push({
                ref: project.ref,
                projectId: project.id,
                name: project.name,
                path: key,
              });
            }
            return { result: { projects: entries } };
          },
        },
      },
    }),
  };
}
