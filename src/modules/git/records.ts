/**
 * Git project records: how the git type reads the config the project store
 * keeps for it (project-store-module owns the records themselves).
 *
 * A git project's record config is `{ path }` for a local project, `{ remoteUrl }`
 * for a managed clone (its path derived from the URL), or `{ path, remoteUrl }`
 * for a clone that is not where its URL derives.
 */

import { projectPathSchema } from "../../intents/contract";
import { Path } from "../../utils/path/path";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../../boundaries/platform/paths";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProjectConfig } from "../../shared/types/project";
import type { ProjectTypeConfig } from "../../intents/open-project";
import { loadProjectRecords, type StoredRecord } from "../project-store-module";
import { GIT_PROJECT_TYPE } from "./ref";

/** A git project as its record describes it, with the badge color the record keeps. */
export interface StoredProject extends ProjectConfig {
  readonly color?: number;
}

/** Where project records and managed clones live. */
export interface StoreDirs {
  readonly projectsDir: string;
  readonly remotesDir: string;
}

/**
 * Whether a project is managed in the current layout: cloned from `remoteUrl`
 * into exactly the place that URL derives. Only then may its record drop the
 * path — anything else keeps storing it, so no project is reopened somewhere
 * it is not.
 */
export function isManaged(
  dirs: StoreDirs,
  projectPath: string,
  remoteUrl: string | undefined
): boolean {
  return (
    remoteUrl !== undefined && managedClonePath(dirs.remotesDir, remoteUrl).equals(projectPath)
  );
}

/**
 * The directory a git project's record is in: a managed project's is named
 * after its URL, so the record survives the clone moving; every other
 * project's is named after its path.
 */
export function recordDirName(dirs: StoreDirs, projectPath: string, remoteUrl?: string): string {
  return remoteUrl !== undefined && isManaged(dirs, projectPath, remoteUrl)
    ? managedProjectDirName(remoteUrl)
    : projectDirName(projectPath);
}

/**
 * Read a git record's config. A managed project's holds its URL and the path is
 * derived from it; a local project's holds its path.
 */
export function parseGitConfig(
  dirs: StoreDirs,
  config: ProjectTypeConfig
): { path: ProjectConfig["path"]; remoteUrl?: string } | undefined {
  const remoteUrl = typeof config.remoteUrl === "string" ? config.remoteUrl : undefined;
  const extras = remoteUrl !== undefined ? { remoteUrl } : {};
  try {
    if (typeof config.path === "string") {
      return { path: projectPathSchema.parse(new Path(config.path).toString()), ...extras };
    }
    if (remoteUrl !== undefined) {
      const path = managedClonePath(dirs.remotesDir, remoteUrl).toString();
      return { path: projectPathSchema.parse(path), ...extras };
    }
  } catch {
    // An unusable path - not a project
  }
  return undefined;
}

/** A git record, read: the project it describes and the config it holds verbatim. */
export interface GitRecord {
  readonly project: StoredProject;
  readonly config: ProjectTypeConfig;
}

export function gitRecords(
  dirs: StoreDirs,
  records: readonly StoredRecord[]
): readonly GitRecord[] {
  const result: GitRecord[] = [];
  for (const record of records) {
    if (record.type !== GIT_PROJECT_TYPE) continue;
    const parsed = parseGitConfig(dirs, record.config);
    if (!parsed) continue;
    const project = record.color !== undefined ? { ...parsed, color: record.color } : parsed;
    result.push({ project, config: record.config });
  }
  return result;
}

/** Every saved git project. For the workspaces root, which moves managed clones. */
export async function loadAllProjects(
  fs: Pick<FileSystemBoundary, "readdir" | "readFile">,
  dirs: StoreDirs
): Promise<readonly StoredProject[]> {
  return gitRecords(dirs, await loadProjectRecords(fs, dirs.projectsDir)).map(
    (record) => record.project
  );
}

/** The git config a project at this path is stored with when it has no record yet. */
export function newLocalConfig(projectPath: string): ProjectTypeConfig {
  return { path: new Path(projectPath).toString() };
}
