/**
 * ElectronLifecycleModule - Electron app lifecycle hooks.
 *
 * Provides:
 * - "before-ready" hook on app:start (noAsar, data paths, electron flags)
 * - "init" hook on app:start (waits for Electron app ready, provides "app-ready" capability)
 * - "start" hook on app:start (power monitor resume handler)
 * - "quit" hook on app:shutdown (calls app.quit())
 */

import type { PathProvider } from "../../services/platform/path-provider";
import type { AsyncWatcher } from "../../services/platform/async-watcher";
import type { Logger } from "../../services/logging";
import type { IntentModule } from "../intents/infrastructure/module";
import type { ConfigureResult } from "../operations/app-start";
import type { ConfigService } from "../../services/config/config-service";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import { configString } from "../../services/config/config-definition";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { INTENT_APP_RESUME } from "../operations/app-resume";

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
  readonly powerMonitor?: { on(event: string, callback: () => void): void } | null;
  readonly dispatcher?: Pick<Dispatcher, "dispatch"> | null;
  readonly logger: Logger;
  readonly configService: ConfigService;
}

// =============================================================================
// Factory
// =============================================================================

export function createElectronLifecycleModule(deps: ElectronLifecycleModuleDeps): IntentModule {
  // Register config key
  deps.configService.register("electron.flags", {
    name: "electron.flags",
    default: null,
    description: "Electron switches (e.g., --disable-gpu)",
    ...configString({ nullable: true }),
  });

  return {
    name: "electron-lifecycle",
    hooks: {
      [APP_START_OPERATION_ID]: {
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
            // Apply electron flags from config
            const flagsValue = deps.configService.get("electron.flags") as string | null;
            const flags = parseElectronFlags(flagsValue ?? undefined);
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
            return {};
          },
        },
        init: {
          provides: () => ({ "app-ready": true }),
          handler: async (): Promise<void> => {
            deps.asyncWatcher?.check();
            await deps.app.whenReady();
          },
        },
        start: {
          handler: async (): Promise<void> => {
            if (deps.powerMonitor && deps.dispatcher) {
              deps.powerMonitor.on("resume", () => {
                deps.logger.info("System resumed — dispatching app:resume");
                void deps.dispatcher!.dispatch({ type: INTENT_APP_RESUME, payload: {} });
              });
            }
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
