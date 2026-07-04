/**
 * ElectronLifecycleModule - Electron app lifecycle hooks.
 *
 * Provides:
 * - "before-ready" hook on app:start (noAsar, data paths, electron flags)
 * - "init" hook on app:start (waits for Electron app ready, provides "app-ready" capability)
 * - "start" hook on app:start (power monitor resume handler)
 * - "quit" hook on app:shutdown (calls app.quit())
 */

import type { PathProvider } from "../boundaries/platform/path-provider";
import type { AsyncWatcher } from "../boundaries/platform/async-watcher";
import type { Logger } from "../boundaries/platform/logging";
import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { ConfigureResult } from "../intents/app-start";
import type { Config } from "../boundaries/platform/config";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { storeString } from "../boundaries/platform/store-definition";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { INTENT_APP_RESUME } from "../intents/app-resume";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parses Electron command-line flags from a string.
 * @param flags - Space-separated flags string (e.g., "--disable-gpu --use-gl=swiftshader")
 * @returns Array of parsed flags
 * @throws Error if quotes are detected (not supported)
 */
function parseElectronFlags(flags: string | undefined): { name: string; value?: string }[] {
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

/**
 * Default Chromium features to disable. Curated for CodeHydra's use case:
 * a desktop dev tool hosting code-server and agent UIs, with no media playback,
 * autofill, translate, casting, ad-tech, or web device APIs.
 *
 * Excludes BackForwardCache, IsolateOrigins/SitePerProcess, NetworkService,
 * GPU-pipeline features, Spellcheck, and the web Notifications API — those
 * carry risk or have a real upside we want to keep.
 */
export const DEFAULT_DISABLED_FEATURES: readonly string[] = [
  // Occlusion (Windows) — we manage view visibility ourselves
  "CalculateNativeWinOcclusion",
  // Media — no playback / casting / media-key hijacking
  "MediaSessionService",
  "HardwareMediaKeyHandling",
  "GlobalMediaControls",
  "MediaRouter",
  "DialMediaRouteProvider",
  // Autofill / Translate / SafeBrowsing — not useful in an IDE host
  "AutofillServerCommunication",
  "Translate",
  "TranslateUI",
  "TranslateSubFrames",
  "SafeBrowsingEnhancedProtection",
  "SafeBrowsingExtendedReportingOptInAllowed",
  // Cloud-ML hints — phones home
  "OptimizationHints",
  "OptimizationGuideModelDownloading",
  // Privacy Sandbox / ad-tech APIs — dead weight in Electron
  "PrivacySandboxSettings4",
  "BrowsingTopics",
  "AttributionReporting",
  "FedCm",
  // Misc web platform we don't use
  "AcceptCHFrame",
  "WebOTP",
  "IdleDetection",
  // Service-worker background machinery — we use Electron native notifications
  "BackgroundFetch",
  "BackgroundSync",
  "PushMessaging",
  // Web device APIs — reduce attack surface
  "WebBluetooth",
  "WebUSB",
  "WebSerial",
  "WebHID",
  // Chrome browser-UI features that don't apply to Electron
  "LensOverlay",
  "ReadAnything",
];

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
  readonly buildInfo: { isPackaged: boolean };
  readonly pathProvider: Pick<PathProvider, "dataPath">;
  readonly asyncWatcher: Pick<AsyncWatcher, "check">;
  readonly powerMonitor: { on(event: string, callback: () => void): void };
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly logger: Logger;
  readonly configService: Config;
}

// =============================================================================
// Factory
// =============================================================================

export function createElectronLifecycleModule(deps: ElectronLifecycleModuleDeps): IntentModule {
  // Register config keys
  const electronFlagsConfig = deps.configService.register("electron.flags", {
    default: null,
    description: "Electron switches (e.g., --disable-gpu)",
    ...storeString({ nullable: true }),
  });
  const electronDisabledFeaturesConfig = deps.configService.register("electron.disabled-features", {
    default: null,
    description:
      "Comma-separated Chromium features to disable via --disable-features. " +
      "null = use curated defaults; empty string = disable nothing; any value fully replaces defaults.",
    ...storeString({ nullable: true }),
    // Settings UI: a checkbox guarding the feature list, since this key needs
    // three states (unchecked = null = curated defaults; checked + empty = "" =
    // disable nothing; checked + value = replace). Overrides the string control
    // the builder would otherwise attach.
    settingsControl: {
      kind: "guarded-text",
      offValue: null,
      onEmptyValue: "",
      fromText: (text: string) => text,
      toText: (value: unknown) =>
        value === null ? { active: false, text: "" } : { active: true, text: String(value) },
    },
  });

  return {
    name: "electron-lifecycle",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<HookOutput<ConfigureResult>> => {
            // Disable ASAR when not packaged
            if (!deps.buildInfo.isPackaged) {
              process.noAsar = true;
            }
            // Redirect data paths to isolate from system defaults
            for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
              deps.app.setPath(name, deps.pathProvider.dataPath(`electron/${name}`).toNative());
            }
            // Disable proxy lookups by default to avoid WPAD/wpad.dat probes.
            // Users can override via electron.flags (e.g. --proxy-server=...).
            deps.app.commandLine.appendSwitch("no-proxy-server");
            deps.logger.info("Applied Electron flag", { flag: "no-proxy-server" });
            // Apply --disable-features from config (or curated defaults).
            // null/undefined = use defaults; "" = disable nothing; any other value fully replaces defaults.
            const disabledFeaturesValue = electronDisabledFeaturesConfig.get();
            const disabledFeatures =
              disabledFeaturesValue === null
                ? [...DEFAULT_DISABLED_FEATURES]
                : disabledFeaturesValue
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
            if (disabledFeatures.length > 0) {
              const joined = disabledFeatures.join(",");
              deps.app.commandLine.appendSwitch("disable-features", joined);
              deps.logger.info("Disabled Chromium features", {
                count: disabledFeatures.length,
                features: joined,
              });
            }
            // Apply electron flags from config
            const flagsValue = electronFlagsConfig.get();
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
            return { result: {} };
          },
        },
        init: {
          handler: async (): Promise<HookOutput> => {
            deps.asyncWatcher.check();
            await deps.app.whenReady();
            return { provides: { "app-ready": true } };
          },
        },
        start: {
          handler: async (): Promise<void> => {
            deps.powerMonitor.on("resume", () => {
              deps.logger.info("System resumed — dispatching app:resume");
              void deps.dispatcher.dispatch({ type: INTENT_APP_RESUME, payload: {} });
            });
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
