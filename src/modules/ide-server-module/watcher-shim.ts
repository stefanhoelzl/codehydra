/**
 * Forward-slash-normalizing shim for the embedded IDE server's native file
 * watcher (`@parcel/watcher` in VSCodium reh-web).
 *
 * ## Why
 *
 * On Windows the watcher compiles each glob `ignore` pattern into a C++
 * `std::regex` via picomatch's regex source. VS Code passes absolute *backslash*
 * paths as ignore globs to exclude a bare-repo worktree's external `.git` dir,
 * and the watcher lowercases them — so `C:\Users\…` becomes `c:\users\…`. The
 * `\u` in `\users` is an invalid escape in `std::regex`'s ECMAScript grammar and
 * throws `regex_error(error_escape)`, aborting `subscribe()`. Recursive watching
 * is then disabled for every workspace, so saving a file no longer refreshes the
 * Source Control view (upstream: parcel-bundler/watcher#194).
 *
 * Forward-slash globs match identically on Windows (picomatch runs with
 * `windows: true` either way, and VS Code's own built-in excludes are already
 * forward-slash), so rewriting the separators only prevents the crash — it does
 * not change matching behavior.
 *
 * ## How
 *
 * A tiny post-download shim wraps the watcher package's entry module: the
 * original is renamed to `<name>.orig.js` and a new entry re-exports the API,
 * rewriting `opts.ignore` string entries `\` → `/` before they reach
 * picomatch/`std::regex`. Idempotent (skips if the `.orig.js` already exists) and
 * re-applied after every download, since a bundle re-download restores the
 * originals.
 */

import { basename, dirname, join } from "node:path";

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging-types";
import { getErrorMessage } from "../../shared/errors/service-errors";

/** Scoped package name of the watcher shipped by VSCodium reh-web. */
const WATCHER_SCOPES = ["@parcel"] as const;

/** Guard rails for the bundle directory walk (a runaway tree never hangs setup). */
const MAX_WALK_DEPTH = 12;
const MAX_WALK_DIRS = 10_000;

/** FileSystem surface the shim needs — a narrow slice of the boundary. */
export type WatcherShimFs = Pick<
  FileSystemBoundary,
  "readdir" | "readFile" | "writeFile" | "rename"
>;

export interface WatcherShimDeps {
  readonly fileSystemLayer: WatcherShimFs;
  readonly logger: Logger;
}

/**
 * Build the shim entry module source. `origRequire` is the relative specifier of
 * the renamed original (e.g. `./index.orig.js`), resolved from the shim's own
 * directory.
 */
function buildShimSource(origRequire: string): string {
  return `// Injected by CodeHydra: forward-slash-normalize watcher ignore globs on
// Windows so absolute backslash paths (e.g. c:\\users\\...) don't compile to an
// invalid std::regex and crash subscribe(). See watcher-shim.ts for details.
const orig = require(${JSON.stringify(origRequire)});
const fixIgnore = (opts) =>
  opts && Array.isArray(opts.ignore)
    ? {
        ...opts,
        ignore: opts.ignore.map((v) => (typeof v === "string" ? v.replace(/\\\\/g, "/") : v)),
      }
    : opts;
module.exports = {
  ...orig,
  subscribe: (dir, fn, opts) => orig.subscribe(dir, fn, fixIgnore(opts)),
  unsubscribe: (dir, fn, opts) => orig.unsubscribe(dir, fn, fixIgnore(opts)),
  writeSnapshot: (dir, snapshot, opts) => orig.writeSnapshot(dir, snapshot, fixIgnore(opts)),
  getEventsSince: (dir, snapshot, opts) => orig.getEventsSince(dir, snapshot, fixIgnore(opts)),
};
`;
}

/** Insert `.orig` before the file extension (index.js → index.orig.js). */
function toOrigName(fileName: string): string {
  return fileName.endsWith(".js")
    ? `${fileName.slice(0, -".js".length)}.orig.js`
    : `${fileName}.orig.js`;
}

/**
 * Resolve a watcher package's entry file from its package.json `main`
 * (defaulting to `index.js`), or `null` if the directory isn't a watcher
 * package (missing/unreadable — a bare `@parcel` scope with no `watcher`, etc).
 */
async function resolveEntryFile(fs: WatcherShimFs, packageDir: string): Promise<string | null> {
  let names: readonly string[];
  try {
    names = (await fs.readdir(packageDir)).map((e) => e.name);
  } catch {
    return null; // directory doesn't exist
  }

  let main = "index.js";
  if (names.includes("package.json")) {
    try {
      const pkg = JSON.parse(await fs.readFile(join(packageDir, "package.json"))) as {
        main?: unknown;
      };
      if (typeof pkg.main === "string" && pkg.main.trim() !== "") {
        // Strip a leading "./" so join() treats it as relative to the package dir.
        main = pkg.main.replace(/^\.\//, "");
      }
    } catch {
      // Malformed package.json — fall back to index.js.
    }
  }
  return join(packageDir, main);
}

/**
 * Apply the shim to a single watcher package. Returns true if it was newly
 * shimmed, false if it was already shimmed (idempotent skip) or not applicable.
 */
async function shimPackage(
  deps: WatcherShimDeps,
  packageDir: string
): Promise<"applied" | "skipped"> {
  const { fileSystemLayer: fs, logger } = deps;

  const entryPath = await resolveEntryFile(fs, packageDir);
  if (entryPath === null) return "skipped";

  const entryDir = dirname(entryPath);
  const origName = toOrigName(basename(entryPath));
  const origPath = join(entryDir, origName);

  // Idempotency: presence of the renamed original means we've already shimmed.
  try {
    await fs.readFile(origPath);
    logger.debug("Watcher shim already applied", { packageDir });
    return "skipped";
  } catch {
    // Not yet shimmed — proceed.
  }

  await fs.rename(entryPath, origPath);
  try {
    await fs.writeFile(entryPath, buildShimSource(`./${origName}`));
  } catch (error) {
    // Never leave the package without an entry module: restore the original.
    await fs.rename(origPath, entryPath).catch(() => {});
    throw error;
  }
  logger.info("Applied watcher forward-slash shim", { packageDir });
  return "applied";
}

/**
 * Recursively locate watcher package directories under `bundleDir`. Descends the
 * bundle skeleton and, at each `node_modules`, checks the known watcher scopes
 * without recursing into sibling packages (the watcher is a hoisted top-level
 * dependency).
 */
async function findWatcherPackages(fs: WatcherShimFs, bundleDir: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_DIRS) return;
    visited++;

    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // unreadable / not a directory
    }

    if (basename(dir) === "node_modules") {
      const scopes = new Set(entries.filter((e) => e.isDirectory).map((e) => e.name));
      for (const scope of WATCHER_SCOPES) {
        if (scopes.has(scope)) found.push(join(dir, scope, "watcher"));
      }
      return; // don't recurse into individual packages
    }

    for (const entry of entries) {
      if (entry.isDirectory && !entry.isSymbolicLink) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  }

  await walk(bundleDir, 0);
  return found;
}

/**
 * Locate every watcher package under `bundleDir` and apply the forward-slash
 * shim to each. Best-effort and idempotent: individual package failures are
 * logged and skipped rather than propagated, so a shim problem never fails the
 * IDE server download. Returns the number of packages newly shimmed.
 */
export async function applyWatcherShim(deps: WatcherShimDeps, bundleDir: string): Promise<number> {
  const { logger } = deps;
  const packages = await findWatcherPackages(deps.fileSystemLayer, bundleDir);

  if (packages.length === 0) {
    logger.debug("No watcher package found to shim", { bundleDir });
    return 0;
  }

  let applied = 0;
  for (const packageDir of packages) {
    try {
      if ((await shimPackage(deps, packageDir)) === "applied") applied++;
    } catch (error) {
      logger.warn("Failed to apply watcher shim", {
        packageDir,
        error: getErrorMessage(error),
      });
    }
  }
  return applied;
}
