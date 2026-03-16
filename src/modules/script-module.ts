/**
 * ScriptModule - Copies required scripts to the app-data bin directory.
 *
 * Provides the "init" hook on app-start. Reads `requiredScripts` from the
 * InitHookContext (collected from configure results) and copies them to
 * the bin directory using setupBinDirectory.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { InitHookContext } from "../intents/app-start";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { Path } from "../utils/path/path";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ScriptModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly pathProvider: PathProvider;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ScriptModule that copies required scripts during the "init" hook.
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
            const binAssetsDir = deps.pathProvider.assetPath("bin");

            // Clean bin directory to remove stale scripts before copying new ones
            await deps.fileSystem.rm(binDir, { recursive: true, force: true });
            await deps.fileSystem.mkdir(binDir);

            // Copy declared scripts
            for (const name of requiredScripts) {
              const srcPath = new Path(binAssetsDir, name);
              const destPath = new Path(binDir, name);

              await deps.fileSystem.copyTree(srcPath, destPath);

              if (!name.endsWith(".cmd") && !name.endsWith(".cjs")) {
                await deps.fileSystem.makeExecutable(destPath);
              }
            }
          },
        },
      },
    },
  };
}
