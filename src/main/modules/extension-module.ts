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
import type { InitResult, ExtensionRequirement } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Manifest Types (internal to this module)
// =============================================================================

interface ExtensionConfig {
  readonly id: string;
  readonly version: string;
  readonly vsix: string;
}

type ExtensionsManifest = readonly ExtensionConfig[];

interface ExtensionsManifestValidationSuccess {
  readonly isValid: true;
  readonly manifest: ExtensionsManifest;
}

interface ExtensionsManifestValidationFailure {
  readonly isValid: false;
  readonly error: string;
}

type ExtensionsManifestValidationResult =
  | ExtensionsManifestValidationSuccess
  | ExtensionsManifestValidationFailure;

function validateExtensionsManifest(value: unknown): ExtensionsManifestValidationResult {
  if (!Array.isArray(value)) {
    return { isValid: false, error: "manifest.json must be an array of extension objects" };
  }

  const extensions: ExtensionConfig[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      return {
        isValid: false,
        error:
          `manifest.json[${i}] is a string but should be an object with { id, version, vsix }. ` +
          `Found: "${item}". ` +
          `Please update manifest.json to use the new format.`,
      };
    }
    if (typeof item !== "object" || item === null) {
      return {
        isValid: false,
        error: `manifest.json[${i}] must be an object with { id, version, vsix }`,
      };
    }
    const ext = item as Record<string, unknown>;
    if (typeof ext.id !== "string" || !ext.id) {
      return { isValid: false, error: `manifest.json[${i}].id must be a non-empty string` };
    }
    if (typeof ext.version !== "string" || !ext.version) {
      return { isValid: false, error: `manifest.json[${i}].version must be a non-empty string` };
    }
    if (typeof ext.vsix !== "string" || !ext.vsix) {
      return { isValid: false, error: `manifest.json[${i}].vsix must be a non-empty string` };
    }
    extensions.push({ id: ext.id, version: ext.version, vsix: ext.vsix });
  }

  return { isValid: true, manifest: extensions };
}

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
          requires: { "app-ready": true },
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
