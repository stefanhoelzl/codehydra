/**
 * Test utilities for AppLayer.
 * Provides behavioral mock for testing app operations without Electron.
 */

import type { AppLayer, AppPathName, AppDock } from "./app";

/**
 * Command line switch entry.
 */
interface CommandLineSwitch {
  readonly key: string;
  readonly value: string | undefined;
}

/**
 * State of the AppLayer behavioral mock.
 */
export interface AppLayerState {
  /** Current badge count */
  readonly badgeCount: number;
  /** Current dock badge text (macOS only) */
  readonly dockBadge: string;
  /** All command line switches added */
  readonly commandLineSwitches: readonly CommandLineSwitch[];
  /** All calls to setBadgeCount */
  readonly setBadgeCountCalls: readonly number[];
  /** All calls to dock.setBadge */
  readonly dockSetBadgeCalls: readonly string[];
}

/**
 * Extended AppLayer interface with state inspection for testing.
 */
export interface BehavioralAppLayer extends AppLayer {
  /**
   * Get internal state for test assertions.
   */
  _getState(): AppLayerState;
}

/**
 * Options for creating a behavioral AppLayer mock.
 */
export interface BehavioralAppLayerOptions {
  /**
   * Simulated platform. Affects dock availability.
   * @default "darwin" (dock available)
   */
  platform?: "darwin" | "win32" | "linux";

  /**
   * Custom paths for getPath().
   * Unmapped paths return a placeholder.
   */
  paths?: Partial<Record<AppPathName, string>>;
}

/**
 * Creates a behavioral mock of AppLayer for testing.
 *
 * The mock maintains in-memory state and provides the same
 * platform-specific behavior as the real implementation:
 * - dock is undefined on non-macOS platforms
 * - setBadgeCount always returns true in the mock
 *
 * Use `_getState()` to inspect the internal state for assertions.
 */
export function createBehavioralAppLayer(
  options: BehavioralAppLayerOptions = {}
): BehavioralAppLayer {
  const { platform = "darwin", paths = {} } = options;

  // State tracking
  let badgeCount = 0;
  let dockBadge = "";
  const commandLineSwitches: CommandLineSwitch[] = [];
  const setBadgeCountCalls: number[] = [];
  const dockSetBadgeCalls: string[] = [];

  // Create dock only for macOS
  const dock: AppDock | undefined =
    platform === "darwin"
      ? {
          setBadge(text: string): void {
            dockBadge = text;
            dockSetBadgeCalls.push(text);
          },
        }
      : undefined;

  // Default path values
  const defaultPaths: Record<AppPathName, string> = {
    home: "/mock/home",
    appData: "/mock/appData",
    userData: "/mock/userData",
    sessionData: "/mock/sessionData",
    temp: "/mock/temp",
    exe: "/mock/exe",
    desktop: "/mock/desktop",
    documents: "/mock/documents",
    downloads: "/mock/downloads",
    music: "/mock/music",
    pictures: "/mock/pictures",
    videos: "/mock/videos",
    logs: "/mock/logs",
  };

  return {
    dock,

    setBadgeCount(count: number): boolean {
      badgeCount = count;
      setBadgeCountCalls.push(count);
      return true;
    },

    getPath(name: AppPathName): string {
      return paths[name] ?? defaultPaths[name];
    },

    commandLineAppendSwitch(key: string, value?: string): void {
      commandLineSwitches.push({ key, value });
    },

    _getState(): AppLayerState {
      return {
        badgeCount,
        dockBadge,
        commandLineSwitches: [...commandLineSwitches],
        setBadgeCountCalls: [...setBadgeCountCalls],
        dockSetBadgeCalls: [...dockSetBadgeCalls],
      };
    },
  };
}
