/**
 * ExtensionModule - Declares required extensions from the bundled manifest.
 *
 * Loads extensions/manifest.json at init time, validates it, and returns
 * ExtensionRequirement[] for downstream modules (code-server-module) to
 * compare against installed extensions and build an install plan.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { PathProvider } from "../../services/platform/path-provider";
import type { Logger } from "../../services/logging/types";
import type { InitResult } from "../operations/app-start";
import type { ExtensionRequirement } from "../../services/vscode-setup/types";
import { validateExtensionsManifest } from "../../services/vscode-setup/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ExtensionModuleDeps {
  readonly pathProvider: Pick<PathProvider, "runtimePath">;
  readonly fileSystemLayer: Pick<FileSystemLayer, "readFile">;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an ExtensionModule that loads the extensions manifest and returns
 * extension requirements for downstream consumption.
 */
export function createExtensionModule(deps: ExtensionModuleDeps): IntentModule {
  const { pathProvider, fileSystemLayer, logger } = deps;

  return {
    name: "extension",
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          handler: async (): Promise<InitResult> => {
            try {
              const manifestPath = pathProvider.runtimePath("extensions/manifest.json");
              const content = await fileSystemLayer.readFile(manifestPath);
              const parsed = JSON.parse(content) as unknown;
              const validation = validateExtensionsManifest(parsed);

              if (!validation.isValid) {
                logger.warn("Invalid extensions manifest", { error: validation.error });
                return {};
              }

              const extensionRequirements: ExtensionRequirement[] = validation.manifest.map(
                (entry) => ({
                  id: entry.id,
                  version: entry.version,
                  vsixPath: new Path(pathProvider.runtimePath("extensions"), entry.vsix).toNative(),
                })
              );

              logger.debug("Loaded extension requirements", {
                count: extensionRequirements.length,
              });

              return { extensionRequirements };
            } catch (error) {
              logger.warn("Failed to load extensions manifest", {
                error: getErrorMessage(error),
              });
              return {};
            }
          },
        },
      },
    },
  };
}
