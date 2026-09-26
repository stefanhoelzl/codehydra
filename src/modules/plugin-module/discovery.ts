/**
 * Finding plugins on disk.
 *
 * Two places hold plugins, with one layout:
 *
 * - **local** — `~/.codehydra/plugins/`: what the user installed. Applies to
 *   every project and runs without asking.
 * - **workspace** — `.codehydra/plugins/` in a worktree: what a repository
 *   ships. Applies to that worktree only, contributes hooks only, and runs once
 *   trusted.
 *
 * In either, a plugin is `<name>.yaml` (a single manifest) or `<name>/plugin.yaml`
 * (a manifest plus the files it bundles, reached through `CH_PLUGIN_DIR`). The
 * name is the file or directory name — there is no name key to disagree with it.
 *
 * Discovery is a directory listing at the moment a plugin is needed: editing a
 * plugin takes effect the next time it would run, with no cache or watcher in
 * the way.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { FileSystemError } from "../../shared/errors/service-errors";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import {
  documentsFor,
  parseManifest,
  pluginPlatformOf,
  type PluginDocument,
  type PluginPlatform,
} from "./manifest";

export type PluginOrigin = "local" | "workspace";

/** The manifest file a plugin directory holds. */
export const MANIFEST_FILE = "plugin.yaml";

/** Where a repository's plugins live, relative to its worktree. */
export const WORKSPACE_PLUGINS_DIR = [".codehydra", "plugins"] as const;

/** Plugin names become log directories and state keys, so they stay plain. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A plugin on disk, before its manifest is read. */
export interface PluginRef {
  readonly origin: PluginOrigin;
  readonly name: string;
  readonly manifestPath: Path;
  /** The plugin's directory, for the directory form only. */
  readonly pluginDir?: Path;
}

/** A plugin with its manifest read. */
export interface LoadedPlugin extends PluginRef {
  /** `local:<name>` or `workspace:<name>` — how `ch plugin` addresses it. */
  readonly id: string;
  /** Every document in the manifest. Empty when it could not be read. */
  readonly documents: readonly PluginDocument[];
  /** The documents that apply on this platform, in file order. */
  readonly applied: readonly PluginDocument[];
  /** The platforms any document applies on, in manifest order. */
  readonly platforms: readonly PluginPlatform[];
  /** Why the plugin cannot run, when it cannot. */
  readonly error?: string;
}

/** Something in a plugins directory that is not a usable plugin. */
export interface DiscoveryProblem {
  readonly origin: PluginOrigin;
  readonly name: string;
  readonly path: Path;
  readonly message: string;
}

export interface Discovered {
  readonly plugins: readonly PluginRef[];
  readonly problems: readonly DiscoveryProblem[];
}

export function pluginId(origin: PluginOrigin, name: string): string {
  return `${origin}:${name}`;
}

/** A worktree's plugins directory. */
export function workspacePluginsDir(worktree: Path): Path {
  return new Path(worktree, ...WORKSPACE_PLUGINS_DIR);
}

function manifestName(filename: string): string | undefined {
  const match = /^(.+)\.ya?ml$/.exec(filename);
  return match?.[1];
}

/**
 * List the plugins in a directory, sorted by name.
 *
 * A missing directory is no plugins, silently: that is the ordinary case for
 * almost every repository. Entries that look like a plugin but are not one —
 * a directory without `plugin.yaml`, a name used by both forms, an unusable
 * name — are reported as problems rather than skipped in silence.
 */
export async function discoverPlugins(
  fileSystem: Pick<FileSystemBoundary, "readdir">,
  dir: Path,
  origin: PluginOrigin
): Promise<Discovered> {
  let entries;
  try {
    entries = await fileSystem.readdir(dir);
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
      return { plugins: [], problems: [] };
    }
    return {
      plugins: [],
      problems: [{ origin, name: dir.basename, path: dir, message: getErrorMessage(error) }],
    };
  }

  const byName = new Map<string, PluginRef[]>();
  const problems: DiscoveryProblem[] = [];
  const add = (ref: PluginRef): void => {
    byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
  };

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = new Path(dir, entry.name);
    if (entry.isDirectory) {
      const manifestPath = new Path(path, MANIFEST_FILE);
      let hasManifest: boolean;
      try {
        hasManifest = (await fileSystem.readdir(path)).some(
          (child) => child.name === MANIFEST_FILE && child.isFile
        );
      } catch {
        hasManifest = false;
      }
      if (!hasManifest) {
        problems.push({
          origin,
          name: entry.name,
          path,
          message: `${entry.name}/ has no ${MANIFEST_FILE}`,
        });
        continue;
      }
      add({ origin, name: entry.name, manifestPath, pluginDir: path });
    } else if (entry.isFile) {
      const name = manifestName(entry.name);
      if (name === undefined) continue; // A README or a script beside the manifests.
      add({ origin, name, manifestPath: path });
    }
  }

  const plugins: PluginRef[] = [];
  for (const [name, refs] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!PLUGIN_NAME.test(name)) {
      problems.push({
        origin,
        name,
        path: refs[0]!.manifestPath,
        message: `"${name}" is not a usable plugin name (letters, digits, ., - and _)`,
      });
      continue;
    }
    if (refs.length > 1) {
      problems.push({
        origin,
        name,
        path: refs[0]!.manifestPath,
        message:
          `${refs.map((ref) => (ref.manifestPath.basename === MANIFEST_FILE ? `${name}/` : ref.manifestPath.basename)).join(" and ")} ` +
          `both claim the plugin name "${name}"; keep one`,
      });
      continue;
    }
    plugins.push(refs[0]!);
  }
  return { plugins, problems };
}

/**
 * Read a plugin's manifest. Never throws: a manifest that cannot be read or is
 * invalid yields a plugin with an `error` and no documents, so it is listed
 * (and reported) but never runs.
 */
export async function loadPlugin(
  fileSystem: Pick<FileSystemBoundary, "readFile">,
  ref: PluginRef,
  platform: NodeJS.Platform
): Promise<LoadedPlugin> {
  const id = pluginId(ref.origin, ref.name);
  let documents: PluginDocument[];
  try {
    documents = parseManifest(await fileSystem.readFile(ref.manifestPath));
  } catch (error) {
    return { ...ref, id, documents: [], applied: [], platforms: [], error: getErrorMessage(error) };
  }

  const platforms = new Set<PluginPlatform>();
  for (const doc of documents) for (const p of doc.platforms) platforms.add(p);
  const own = pluginPlatformOf(platform);

  return {
    ...ref,
    id,
    documents,
    applied: documentsFor(documents, platform),
    platforms: [...platforms],
    ...(own === undefined && { error: `${platform} is not a platform plugins run on` }),
  };
}

/** Discover and load every plugin in a directory. */
export async function loadPlugins(
  fileSystem: Pick<FileSystemBoundary, "readdir" | "readFile">,
  dir: Path,
  origin: PluginOrigin,
  platform: NodeJS.Platform
): Promise<{ plugins: LoadedPlugin[]; problems: DiscoveryProblem[] }> {
  const discovered = await discoverPlugins(fileSystem, dir, origin);
  const plugins = await Promise.all(
    discovered.plugins.map((ref) => loadPlugin(fileSystem, ref, platform))
  );
  return { plugins, problems: [...discovered.problems] };
}
