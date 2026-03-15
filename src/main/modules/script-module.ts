/**
 * ScriptModule - Copies required scripts to the app-data bin directory.
 *
 * Provides the "init" hook on app-start. Reads `requiredScripts` from the
 * InitHookContext (collected from configure results) and copies them to
 * the bin directory using setupBinDirectory.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { InitHookContext } from "../operations/app-start";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { PathProvider } from "../../services/platform/path-provider";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { Path } from "../../services/platform/path";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ScriptModuleDeps {
  readonly fileSystem: FileSystemLayer;
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
