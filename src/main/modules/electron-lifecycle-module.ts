/**
 * ElectronLifecycleModule - Electron app lifecycle hooks.
 *
 * Provides:
 * - "configure" hook on app:start (noAsar, electron flags, data paths)
 * - "await-ready" hook on app:start (waits for Electron app ready)
 * - "quit" hook on app:shutdown (calls app.quit())
 */

import { Path } from "../../services/platform/path";
import type { Logger } from "../../services/logging";
import type { IntentModule } from "../intents/infrastructure/module";
import type { ConfigureResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parses Electron command-line flags from a string.
 * @param flags - Space-separated flags string (e.g., "--disable-gpu --use-gl=swiftshader")
 * @returns Array of parsed flags
 * @throws Error if quotes are detected (not supported)
 */
export function parseElectronFlags(flags: string | undefined): { name: string; value?: string }[] {
  if (!flags || !flags.trim()) {
    return [];
  }

  if (flags.includes('"') || flags.includes("'")) {
    throw new Error(
      "Quoted values are not supported in CODEHYDRA_ELECTRON_FLAGS. " +
        'Use --flag=value instead of --flag="value".'
    );
  }

  const result: { name: string; value?: string }[] = [];
  const parts = flags.trim().split(/\s+/);

  for (const part of parts) {
    const withoutDashes = part.replace(/^--?/, "");
    const eqIndex = withoutDashes.indexOf("=");
    if (eqIndex !== -1) {
      result.push({
        name: withoutDashes.substring(0, eqIndex),
        value: withoutDashes.substring(eqIndex + 1),
      });
    } else {
      result.push({ name: withoutDashes });
    }
  }

  return result;
}

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ElectronLifecycleModuleDeps {
  readonly app: {
    whenReady(): Promise<void>;
    quit(): void;
    commandLine: { appendSwitch(key: string, value?: string): void };
    setPath(name: string, path: string): void;
  };
  readonly buildInfo?: { isPackaged: boolean } | null;
  readonly pathProvider?: { electronDataDir: { toNative(): string } } | null;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

export function createElectronLifecycleModule(deps: ElectronLifecycleModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        configure: {
          handler: async (): Promise<ConfigureResult> => {
            // Disable ASAR when not packaged
            if (deps.buildInfo && !deps.buildInfo.isPackaged) {
              process.noAsar = true;
            }
            // Apply Electron flags from environment
            const flags = parseElectronFlags(process.env.CODEHYDRA_ELECTRON_FLAGS);
            for (const flag of flags) {
              deps.app.commandLine.appendSwitch(
                flag.name,
                ...(flag.value !== undefined ? [flag.value] : [])
              );
              deps.logger.info("Applied Electron flag", {
                flag: flag.name,
                ...(flag.value !== undefined && { value: flag.value }),
              });
            }
            // Redirect data paths to isolate from system defaults
            if (deps.pathProvider) {
              const electronDir = new Path(deps.pathProvider.electronDataDir.toNative());
              for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
                deps.app.setPath(name, new Path(electronDir, name).toNative());
              }
            }
            return {};
          },
        },
        "await-ready": {
          handler: async (): Promise<void> => {
            await deps.app.whenReady();
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        quit: {
          handler: async () => {
            deps.app.quit();
          },
        },
      },
    },
  };
}
