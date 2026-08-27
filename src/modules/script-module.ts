/**
 * ScriptModule - Keeps the app-data bin directory in sync with the required scripts.
 *
 * Provides the "init" hook on app-start. Reads `requiredScripts` from the
 * InitHookContext, prunes entries that are no longer required, and rewrites the
 * ones whose content differs from the bundled copy.
 *
 * The directory is converged in place rather than wiped and recreated. On Windows
 * the wrappers living here are held open by running processes: every Claude agent
 * is a `cmd.exe` executing `bin\ch-claude.cmd` (cmd keeps a batch file open for
 * the whole invocation), and the directory is on the IDE server's PATH, so its
 * terminals reach it too. A process surviving from a previous session therefore
 * makes deleting or rewriting these files fail with EPERM — which used to abort
 * startup on every launch, not just after an update. Writing only what actually
 * changed means the common path (same version, nothing stale) touches no files at
 * all and cannot collide with such a lock.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { InitHookContext } from "../intents/app-start";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { Logger } from "../boundaries/platform/logging-types";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { FileSystemError } from "../shared/errors/service-errors";
import { getErrorMessage } from "../shared/error-utils";
import { Path } from "../utils/path/path";
import { renderTemplate } from "../utils/liquid/liquid-renderer";
import type { RequiredScript } from "../intents/app-start";

// =============================================================================
// Constants
// =============================================================================

/** Write attempts (including the first) when a script write hits a file lock. */
const WRITE_MAX_ATTEMPTS = 4;

/**
 * Base delay between write attempts. Grows linearly per attempt, mirroring the
 * backoff `fs.rm` applies to the same error codes.
 */
const WRITE_RETRY_DELAY_MS = 150;

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ScriptModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly pathProvider: PathProvider;
  readonly logger: Logger;
  /**
   * Values available to templated scripts.
   *
   * Read at sync time rather than injected as a value: the bundled interpreter's
   * path depends on the configured IDE version, so it is only correct once
   * config has loaded.
   */
  readonly templateVariables: () => Record<string, string>;
}

// =============================================================================
// Helpers
// =============================================================================

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * True for the errors Windows raises when another process holds the file open.
 * These are worth retrying: a handle in the middle of closing (a delete-pending
 * file, an antivirus scan) clears within a few hundred milliseconds.
 */
function isLockError(error: unknown): boolean {
  if (!(error instanceof FileSystemError)) {
    return false;
  }
  return error.fsCode === "EPERM" || error.fsCode === "EACCES" || error.originalCode === "EBUSY";
}

/** The filename a required script lands under, whether or not it is a template. */
function scriptName(script: RequiredScript): string {
  return typeof script === "string" ? script : script.name;
}

/** Read a file, returning undefined when it doesn't exist. Other errors propagate. */
async function readIfPresent(
  fileSystem: FileSystemBoundary,
  path: Path
): Promise<string | undefined> {
  try {
    return await fileSystem.readFile(path);
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Remove directory entries that are no longer required.
 *
 * Best-effort by design: a stale wrapper we cannot delete is not a startup
 * blocker. Nothing requires it, and the only way to reach it is to call it by a
 * name no current agent uses.
 */
async function pruneStaleScripts(
  deps: ScriptModuleDeps,
  binDir: Path,
  requiredScripts: readonly RequiredScript[]
): Promise<void> {
  const required = new Set(requiredScripts.map(scriptName));

  let entries;
  try {
    entries = await deps.fileSystem.readdir(binDir);
  } catch (error) {
    deps.logger.warn("Could not list the bin directory to prune stale scripts", {
      path: binDir.toNative(),
      error: getErrorMessage(error),
    });
    return;
  }

  for (const entry of entries) {
    if (required.has(entry.name)) {
      continue;
    }
    const stalePath = new Path(binDir, entry.name);
    try {
      await deps.fileSystem.rm(stalePath, { recursive: entry.isDirectory, force: true });
    } catch (error) {
      deps.logger.warn("Could not remove stale script", {
        path: stalePath.toNative(),
        error: getErrorMessage(error),
      });
    }
  }
}

/**
 * Copy a script into the bin directory, retrying while the destination looks
 * locked by another process.
 *
 * Retries only help for a handle that is already closing. A wrapper held by a
 * live agent from a previous session stays locked for that agent's whole
 * session, so this eventually gives up and fails startup with an actionable
 * message — running an outdated wrapper against a new app version is worse than
 * refusing to start.
 */
async function writeScript(deps: ScriptModuleDeps, destPath: Path, content: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.fileSystem.writeFile(destPath, content);
      return;
    } catch (error) {
      if (attempt >= WRITE_MAX_ATTEMPTS || !isLockError(error)) {
        throw new Error(
          `Could not update the CodeHydra wrapper script "${destPath.basename}" in ` +
            `${destPath.dirname.toNative()}: ${getErrorMessage(error)}. ` +
            `A process from a previous CodeHydra session is most likely still using it. ` +
            `Close all CodeHydra windows, end any terminals or agents it started, then start ` +
            `CodeHydra again.`,
          { cause: error }
        );
      }
      deps.logger.warn("Script is locked, retrying", {
        path: destPath.toNative(),
        attempt,
        error: getErrorMessage(error),
      });
      await sleep(WRITE_RETRY_DELAY_MS * attempt);
    }
  }
}

/** Write each required script whose content differs from the bundled copy. */
async function syncRequiredScripts(
  deps: ScriptModuleDeps,
  binDir: Path,
  binAssetsDir: Path,
  requiredScripts: readonly RequiredScript[]
): Promise<void> {
  // Resolved once per sync: rendering is per script, but the values are not.
  let variables: Record<string, string> | undefined;

  for (const script of requiredScripts) {
    const name = scriptName(script);
    const srcPath = new Path(binAssetsDir, name);
    const destPath = new Path(binDir, name);

    // A missing or unreadable source is a packaging bug — let it abort startup.
    const source = await deps.fileSystem.readFile(srcPath);

    let desired = source;
    if (typeof script !== "string" && script.template) {
      variables ??= deps.templateVariables();
      // Liquid rather than the ${VAR} form used for the agent JSON configs:
      // `${...}` is shell variable syntax, and these templates are shell and
      // batch scripts that contain real ones.
      desired = renderTemplate(source, variables);
    }

    const current = await readIfPresent(deps.fileSystem, destPath);

    if (current !== desired) {
      await writeScript(deps, destPath, desired);
    }

    if (!name.endsWith(".cmd") && !name.endsWith(".cjs")) {
      // Unconditional: chmod never opens the file, so it cannot hit a lock, and
      // it repairs a mode that was clobbered without rewriting the content.
      await deps.fileSystem.makeExecutable(destPath);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ScriptModule that syncs required scripts during the "init" hook.
 */
export function createScriptModule(deps: ScriptModuleDeps): IntentModule {
  return {
    name: "script",
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "app-ready": true },
          handler: async (ctx: HookContext): Promise<void> => {
            const { requiredScripts } = ctx as InitHookContext;

            const binDir = deps.pathProvider.dataPath("bin");
            // Source the bundled wrappers from runtimePath (extraResources /
            // resources/bin), NOT assetPath (inside app.asar). In the packaged
            // app the FileSystemBoundary uses Electron's original-fs, which has
            // no asar virtualization, so copying out of app.asar throws
            // ENOTDIR/ENOENT and aborts app:start. runtimePath points at the
            // real, un-archived copy on every target (dev + prod).
            const binAssetsDir = deps.pathProvider.runtimePath("bin");

            await deps.fileSystem.mkdir(binDir);
            await pruneStaleScripts(deps, binDir, requiredScripts);
            await syncRequiredScripts(deps, binDir, binAssetsDir, requiredScripts);
          },
        },
      },
    },
  };
}
