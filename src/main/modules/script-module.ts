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
import { setupBinDirectory } from "../../services/vscode-setup/bin-setup";

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
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          handler: async (ctx: HookContext): Promise<void> => {
            const { requiredScripts } = ctx as InitHookContext;
            await setupBinDirectory(deps.fileSystem, deps.pathProvider, requiredScripts);
          },
        },
      },
    },
  };
}
