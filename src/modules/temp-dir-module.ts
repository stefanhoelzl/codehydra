/**
 * TempDirModule - Manages the application temp directory lifecycle.
 *
 * Hook handlers:
 * - app:start / init: recreates the temp directory for a clean start
 */

import type { IntentModule } from "../intents/lib/module";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem/filesystem";
import type { PathProvider } from "../boundaries/platform/env/path-provider";
import { APP_START_OPERATION_ID } from "../intents/app-start";

// =============================================================================
// Dependencies
// =============================================================================

export interface TempDirModuleDeps {
  readonly fileSystem: Pick<FileSystemBoundary, "rm" | "mkdir">;
  readonly pathProvider: Pick<PathProvider, "dataPath">;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createTempDirModule(deps: TempDirModuleDeps): IntentModule {
  const tempRoot = deps.pathProvider.dataPath("temp");

  return {
    name: "temp-dir",
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "app-ready": true },
          handler: async (): Promise<void> => {
            await deps.fileSystem.rm(tempRoot, { recursive: true, force: true });
            await deps.fileSystem.mkdir(tempRoot);
          },
        },
      },
    },
  };
}
