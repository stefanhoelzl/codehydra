/**
 * Repository hooks from before plugins: `.codehydra/hooks/<entry>[.<platform>][.*]`.
 *
 * They no longer run. A worktree that still has them and no plugin of its own
 * gets a notification in its editor offering to migrate: the files stay where
 * they are, and a `.codehydra/plugins/hooks.yaml` is written that runs each of
 * them from its entry, with the old file-name rules turned into documents —
 *
 * - a file suffixed `.win`, `.linux` or `.mac` ran only on that platform, and
 *   beat the unsuffixed file there;
 * - more than one file left for an entry on a platform ran nothing, so it is
 *   left out (and named, so the user can pick).
 *
 * A `.cmd`/`.bat` file runs through cmd, a `.ps1` through PowerShell, anything
 * else through bash, which runs the file itself — its shebang and exec bit
 * decide, as they did.
 */

import { stringify } from "yaml";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { Path } from "../../utils/path/path";
import { ALL_ENTRIES } from "./hook-map";
import type { PluginPlatform } from "./manifest";
import type { ShellName } from "./shells";

/** Where the old hooks live, relative to the worktree. */
export const LEGACY_HOOKS_DIR = [".codehydra", "hooks"] as const;

/** The plugin a migration writes, in the worktree's plugins directory. */
export const MIGRATED_PLUGIN_FILE = "hooks.yaml";

const SUFFIX_OF: Readonly<Record<PluginPlatform, string>> = {
  windows: "win",
  linux: "linux",
  macos: "mac",
};
const ALL_SUFFIXES = new Set(Object.values(SUFFIX_OF));
const PLATFORMS: readonly PluginPlatform[] = ["linux", "windows", "macos"];

/** The hook files in a worktree's old hooks directory, sorted; none when it is absent. */
export async function listLegacyHooks(
  fileSystem: Pick<FileSystemBoundary, "readdir">,
  worktree: Path
): Promise<string[]> {
  try {
    const entries = await fileSystem.readdir(new Path(worktree, ...LEGACY_HOOKS_DIR));
    return entries
      .filter(
        (entry) => entry.isFile && ALL_ENTRIES.some((spec) => namesEntry(entry.name, spec.name))
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function namesEntry(filename: string, entry: string): boolean {
  return filename === entry || filename.startsWith(`${entry}.`);
}

function suffixOf(filename: string, entry: string): string | undefined {
  if (filename === entry) return undefined;
  const segment = filename.slice(entry.length + 1).split(".")[0] ?? "";
  return ALL_SUFFIXES.has(segment) ? segment : undefined;
}

/** The files that applied for an entry on a platform, by the old rules. */
function selectFor(files: readonly string[], entry: string, platform: PluginPlatform): string[] {
  const named = files.filter((name) => namesEntry(name, entry)).sort();
  const specific = named.filter((name) => suffixOf(name, entry) === SUFFIX_OF[platform]);
  if (specific.length > 0) return specific;
  return named.filter((name) => suffixOf(name, entry) === undefined);
}

function shellFor(filename: string): ShellName {
  if (/\.(cmd|bat)$/i.test(filename)) return "cmd";
  if (/\.ps1$/i.test(filename)) return "powershell";
  return "bash";
}

/** A script that runs the old hook file, handing it this script's stdin. */
function runner(shell: ShellName, filename: string): string {
  switch (shell) {
    case "cmd":
      return `call "%CH_WORKSPACE_DIR%\\.codehydra\\hooks\\${filename}"`;
    case "powershell":
      return `$input | & "$env:CH_WORKSPACE_DIR/.codehydra/hooks/${filename}"`;
    case "bash":
      return `"$CH_WORKSPACE_DIR/.codehydra/hooks/${filename}"`;
  }
}

export interface MigratedHooks {
  readonly manifest: string;
  /** Entries left out on some platform because several files claimed them. */
  readonly ambiguous: readonly { entry: string; platform: PluginPlatform; files: string[] }[];
}

/** The plugin manifest that runs a worktree's old hook files. */
export function migrateLegacyHooks(files: readonly string[]): MigratedHooks {
  const ambiguous: { entry: string; platform: PluginPlatform; files: string[] }[] = [];
  // shell + the entry→file table → the platforms it applies on.
  const groups = new Map<
    string,
    { shell: ShellName; hooks: [string, string][]; platforms: PluginPlatform[] }
  >();

  for (const platform of PLATFORMS) {
    const byShell = new Map<ShellName, [string, string][]>();
    for (const spec of ALL_ENTRIES) {
      const selected = selectFor(files, spec.name, platform);
      if (selected.length === 0) continue;
      if (selected.length > 1) {
        ambiguous.push({ entry: spec.name, platform, files: selected });
        continue;
      }
      const file = selected[0]!;
      const shell = shellFor(file);
      byShell.set(shell, [...(byShell.get(shell) ?? []), [spec.name, file]]);
    }
    for (const [shell, hooks] of byShell) {
      const key = JSON.stringify([shell, hooks]);
      const group = groups.get(key) ?? { shell, hooks, platforms: [] };
      group.platforms.push(platform);
      groups.set(key, group);
    }
  }

  const documents = [...groups.values()].map((group) => ({
    ...(group.shell !== "bash" && { shell: group.shell }),
    ...(group.platforms.length < PLATFORMS.length && {
      platform: group.platforms.length === 1 ? group.platforms[0] : group.platforms,
    }),
    hooks: Object.fromEntries(
      group.hooks.map(([entry, file]) => [entry, runner(group.shell, file)])
    ),
  }));

  const header =
    "# Migrated from .codehydra/hooks: each entry runs the hook file it used to.\n" +
    "# Edit freely — or move the scripts in here and delete .codehydra/hooks.\n";
  const body =
    documents.length === 0
      ? "hooks: {}\n"
      : documents.map((doc) => stringify(doc, { lineWidth: 0 })).join("---\n");
  return { manifest: header + body, ambiguous };
}
