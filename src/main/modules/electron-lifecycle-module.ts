/**
 * ElectronLifecycleModule - Electron app lifecycle hooks.
 *
 * Provides:
 * - "before-ready" hook on app:start (noAsar, data paths)
 * - "await-ready" hook on app:start (waits for Electron app ready)
 * - "quit" hook on app:shutdown (calls app.quit())
 *
 * Electron flags are applied via config:updated event subscription
 * when the config module dispatches env-layer values.
 */

import type { PathProvider } from "../../services/platform/path-provider";
import type { AsyncWatcher } from "../../services/platform/async-watcher";
import type { Logger } from "../../services/logging";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { ConfigureResult, RegisterConfigResult } from "../operations/app-start";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";

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
      "Quoted values are not supported in CH_ELECTRON_FLAGS. " +
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
  readonly pathProvider?: Pick<PathProvider, "dataPath"> | null;
  readonly asyncWatcher?: AsyncWatcher | null;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

export function createElectronLifecycleModule(deps: ElectronLifecycleModuleDeps): IntentModule {
  return {
    name: "electron-lifecycle",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "electron.flags",
                default: undefined,
                parse: (s: string) => (s === "" ? undefined : s),
                validate: (v: unknown) => (typeof v === "string" ? v : undefined),
              },
            ],
          }),
        },
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            // Disable ASAR when not packaged
            if (deps.buildInfo && !deps.buildInfo.isPackaged) {
              process.noAsar = true;
            }
            // Redirect data paths to isolate from system defaults
            if (deps.pathProvider) {
              for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
                deps.app.setPath(name, deps.pathProvider.dataPath(`electron/${name}`).toNative());
              }
            }
            // Electron flags are applied via config:updated event handler
            return {};
          },
        },
        "await-ready": {
          handler: async (): Promise<void> => {
            deps.asyncWatcher?.check();
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
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        if (values["electron.flags"] !== undefined) {
          const flags = parseElectronFlags(values["electron.flags"] as string | undefined);
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
        }
      },
    },
  };
}
