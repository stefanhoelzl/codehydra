/**
 * MigrationModule - One-time startup migration for cloned project layout.
 *
 * Migrates old-layout cloned projects from projects/ to remotes/.
 *
 * Old layout: projects/<url-hash>/config.json + projects/<url-hash>/repo/
 * New layout: remotes/<url-hash>/repo/ + projects/<path-hash>/config.json
 *
 * Hook registrations:
 * - app:start → activate: run migration (before LocalProjectModule loads configs)
 *
 * TODO: Remove after sufficient migration period
 */

import nodePath from "path";
import type { IntentModule } from "../intents/infrastructure/module";
import { Path } from "../../services/platform/path";
import { projectDirName } from "../../services/platform/paths";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { ProjectConfig } from "../../services/project/types";
import { CURRENT_PROJECT_VERSION } from "../../services/project/types";
import { ProjectStoreError, getErrorMessage } from "../../services/errors";
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";

// =============================================================================
// Types
// =============================================================================

type MigrationFs = Pick<
  FileSystemLayer,
  "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm" | "rename"
>;

export interface MigrationModuleDeps {
  readonly projectsDir: string;
  readonly remotesDir: string | undefined;
  readonly fs: MigrationFs;
}

// =============================================================================
// Private Persistence Helpers
// =============================================================================

async function saveProject(
  fs: MigrationFs,
  projectsDir: string,
  projectPath: string,
  remoteUrl?: string
): Promise<void> {
  const normalizedPath = new Path(projectPath).toString();
  const projectDir = nodePath.join(projectsDir, projectDirName(normalizedPath));
  const configPath = nodePath.join(projectDir, "config.json");

  const config: ProjectConfig = {
    version: CURRENT_PROJECT_VERSION,
    path: normalizedPath,
    ...(remoteUrl !== undefined && { remoteUrl }),
  };

  try {
    await fs.mkdir(projectDir);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  } catch (error: unknown) {
    throw new ProjectStoreError(`Failed to save project: ${getErrorMessage(error)}`);
  }
}

async function internalLoadAllProjectConfigs(
  fs: MigrationFs,
  projectsDir: string
): Promise<readonly { config: ProjectConfig; entryName: string }[]> {
  const results: { config: ProjectConfig; entryName: string }[] = [];

  try {
    const entries = await fs.readdir(projectsDir);

    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }

      const configPath = nodePath.join(projectsDir, entry.name, "config.json");

      try {
        const content = await fs.readFile(configPath);
        const parsed: unknown = JSON.parse(content);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "path" in parsed &&
          typeof (parsed as Record<string, unknown>).path === "string"
        ) {
          const rawPath = (parsed as { path: string }).path;
          try {
            const normalizedPath = new Path(rawPath).toString();
            const rawRemoteUrl = (parsed as { remoteUrl?: string }).remoteUrl;

            const config: ProjectConfig = {
              version: (parsed as { version?: number }).version ?? 1,
              path: normalizedPath,
              ...(rawRemoteUrl !== undefined && { remoteUrl: rawRemoteUrl }),
            };
            results.push({ config, entryName: entry.name });
          } catch {
            // Invalid path format - skip this entry
            continue;
          }
        }
      } catch {
        // Skip invalid entries (ENOENT, malformed JSON, etc.)
        continue;
      }
    }
  } catch {
    // Directory doesn't exist or other error - return empty array
    return [];
  }

  return results;
}

// =============================================================================
// Migration Logic
// =============================================================================

/**
 * Migrate old-layout cloned projects from projects/ to remotes/.
 */
async function migrateClonedProjects(
  fs: MigrationFs,
  projectsDir: string,
  remotesDir: string | undefined
): Promise<void> {
  if (!remotesDir) return;

  const entries = await internalLoadAllProjectConfigs(fs, projectsDir);
  for (const { config, entryName } of entries) {
    if (!config.remoteUrl) continue;

    // Detect old layout: entry dir name doesn't match path-hashed dir name
    const expectedDirName = projectDirName(config.path);
    if (entryName === expectedDirName) continue; // Already in new layout

    const oldDir = nodePath.join(projectsDir, entryName);
    const newDir = nodePath.join(remotesDir, entryName);

    try {
      await fs.mkdir(remotesDir);
      await fs.rename(oldDir, newDir);

      // Compute new project path (under remotes/)
      const repoName = new Path(config.path).basename;
      const newProjectPath = new Path(newDir, repoName).toString();

      // Save config at path-hashed location
      await saveProject(fs, projectsDir, newProjectPath, config.remoteUrl);

      // Remove old config.json that moved with the directory
      const movedConfig = nodePath.join(newDir, "config.json");
      try {
        await fs.unlink(movedConfig);
      } catch {
        /* ignore */
      }
    } catch {
      // Migration is best-effort — skip on failure
    }
  }
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a MigrationModule that handles one-time project layout migration.
 *
 * Must be registered before LocalProjectModule so migration runs before config loading.
 */
export function createMigrationModule(deps: MigrationModuleDeps): IntentModule {
  const { projectsDir, remotesDir, fs } = deps;

  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            await migrateClonedProjects(fs, projectsDir, remotesDir);
            return {};
          },
        },
      },
    },
  };
}
