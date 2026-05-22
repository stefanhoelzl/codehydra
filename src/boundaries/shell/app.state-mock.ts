/**
 * Behavioral state mock for AppBoundary.
 *
 * Provides a mock for testing app operations without Electron, following the
 * `MockWithState<T>` pattern from `src/test/state-mock.ts`.
 *
 * Custom matchers:
 * - `toHaveDockBadge(text)` - Assert current dock badge text
 * - `toHaveBadgeCount(count)` - Assert current badge count
 * - `toHaveCommandLineSwitch(key, value?)` - Assert command line switch exists
 */

import { expect } from "vitest";
import type { AppBoundary, AppPathName, AppDock } from "./app";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Command line switch entry.
 */
interface CommandLineSwitch {
  readonly key: string;
  readonly value: string | undefined;
}

/**
 * Internal state for the AppBoundary mock.
 * State is not directly exposed - use matchers for assertions.
 */
class AppBoundaryMockStateImpl implements MockState {
  badgeCount = 0;
  dockBadge = "";
  shouldUseDarkColors = true;
  /** True when a sleep blocker is currently active (OS prevented from sleeping). */
  preventingSleep = false;
  /** Number of times a blocker transitioned from inactive → active. */
  sleepBlockerStarts = 0;
  /** Number of times a blocker transitioned from active → inactive. */
  sleepBlockerStops = 0;
  readonly commandLineSwitches: CommandLineSwitch[] = [];
  readonly themeUpdatedCallbacks: Set<() => void> = new Set();

  triggerThemeUpdated(): void {
    for (const cb of this.themeUpdatedCallbacks) {
      cb();
    }
  }

  snapshot(): Snapshot {
    return {
      __brand: "Snapshot",
      value: this.toString(),
    };
  }

  toString(): string {
    const switches = this.commandLineSwitches
      .map((s) => (s.value !== undefined ? `${s.key}=${s.value}` : s.key))
      .join(", ");
    return `AppBoundaryMockState { badgeCount: ${this.badgeCount}, dockBadge: "${this.dockBadge}", preventingSleep: ${this.preventingSleep}, switches: [${switches}] }`;
  }
}

/**
 * Public state interface for AppBoundary mock.
 * Provides snapshot/toString only - use matchers for assertions.
 */
export interface AppBoundaryMockState extends MockState {
  snapshot(): Snapshot;
  toString(): string;
}

// =============================================================================
// Mock Type and Factory
// =============================================================================

/**
 * Mock AppBoundary with inspectable state via `$` property.
 */
export type MockAppBoundary = AppBoundary & MockWithState<AppBoundaryMockState>;

/**
 * Options for creating an AppBoundary mock.
 */
export interface MockAppBoundaryOptions {
  /**
   * Simulated platform. Affects dock availability.
   * - "darwin": dock is defined
   * - "win32" | "linux": dock is undefined
   * @default "darwin"
   */
  platform?: "darwin" | "win32" | "linux";

  /**
   * Custom paths for getPath().
   * Unmapped paths return a placeholder.
   */
  paths?: Partial<Record<AppPathName, string>>;

  /**
   * Initial value reported by shouldUseDarkColors().
   * @default true
   */
  shouldUseDarkColors?: boolean;
}

/**
 * Creates a behavioral mock of AppBoundary for testing.
 *
 * The mock maintains in-memory state and provides the same
 * platform-specific behavior as the real implementation:
 * - dock is undefined on non-macOS platforms
 * - setBadgeCount always returns true in the mock
 *
 * Use custom matchers for assertions:
 * - `expect(mock).toHaveDockBadge("text")`
 * - `expect(mock).toHaveBadgeCount(5)`
 * - `expect(mock).toHaveCommandLineSwitch("key", "value")`
 *
 * @example Basic usage
 * ```ts
 * const appLayer = createAppBoundaryMock();
 * appLayer.dock?.setBadge("test");
 * expect(appLayer).toHaveDockBadge("test");
 * ```
 *
 * @example Windows platform (no dock)
 * ```ts
 * const appLayer = createAppBoundaryMock({ platform: "win32" });
 * expect(appLayer.dock).toBeUndefined();
 * ```
 *
 * @example Badge count
 * ```ts
 * const appLayer = createAppBoundaryMock();
 * appLayer.setBadgeCount(5);
 * expect(appLayer).toHaveBadgeCount(5);
 * ```
 *
 * @example Command line switches
 * ```ts
 * const appLayer = createAppBoundaryMock();
 * appLayer.commandLineAppendSwitch("disable-gpu");
 * appLayer.commandLineAppendSwitch("use-gl", "swiftshader");
 * expect(appLayer).toHaveCommandLineSwitch("disable-gpu");
 * expect(appLayer).toHaveCommandLineSwitch("use-gl", "swiftshader");
 * ```
 */
export function createAppBoundaryMock(options: MockAppBoundaryOptions = {}): MockAppBoundary {
  const { platform = "darwin", paths = {}, shouldUseDarkColors = true } = options;

  const state = new AppBoundaryMockStateImpl();
  state.shouldUseDarkColors = shouldUseDarkColors;

  // Create dock only for macOS
  const dock: AppDock | undefined =
    platform === "darwin"
      ? {
          setBadge(text: string): void {
            state.dockBadge = text;
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
    $: state,
    dock,

    setBadgeCount(count: number): boolean {
      state.badgeCount = count;
      return true;
    },

    getPath(name: AppPathName): string {
      return paths[name] ?? defaultPaths[name];
    },

    commandLineAppendSwitch(key: string, value?: string): void {
      state.commandLineSwitches.push({ key, value });
    },

    allowPowerSaving(allow: boolean): void {
      // Mirror the real boundary's idempotent single-blocker semantics.
      if (allow) {
        if (state.preventingSleep) {
          state.sleepBlockerStops += 1;
        }
        state.preventingSleep = false;
      } else {
        if (!state.preventingSleep) {
          state.sleepBlockerStarts += 1;
        }
        state.preventingSleep = true;
      }
    },

    async openUrl(): Promise<void> {},
    async openPath(): Promise<void> {},

    shouldUseDarkColors(): boolean {
      return state.shouldUseDarkColors;
    },

    onThemeUpdated(callback: () => void) {
      state.themeUpdatedCallbacks.add(callback);
      return () => {
        state.themeUpdatedCallbacks.delete(callback);
      };
    },
  };
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for MockAppBoundary assertions.
 */
export interface AppBoundaryMatchers {
  /**
   * Assert current dock badge text.
   * @param text - Expected badge text
   */
  toHaveDockBadge(text: string): void;

  /**
   * Assert current badge count.
   * @param count - Expected badge count
   */
  toHaveBadgeCount(count: number): void;

  /**
   * Assert a command line switch exists.
   * - toHaveCommandLineSwitch("flag") - switch exists (any value)
   * - toHaveCommandLineSwitch("flag", "val") - switch exists with exact value
   * - toHaveCommandLineSwitch("flag", undefined) - switch exists with no value
   * @param key - Switch name
   * @param value - Optional expected value (if provided, checks exact match)
   */
  toHaveCommandLineSwitch(key: string, value?: string): void;

  /**
   * Assert that the OS is currently being prevented from sleeping
   * (a sleep blocker is active). Use `.not` to assert sleep is allowed.
   */
  toBePreventingSleep(): void;

  /**
   * Assert how many times a sleep blocker has been started
   * (inactive → active transitions). Useful for verifying idempotency.
   * @param count - Expected number of blocker starts
   */
  toHaveSleepBlockerStartCount(count: number): void;
}

// Extend vitest's assertion interface
declare module "vitest" {
  interface Assertion<T> extends AppBoundaryMatchers {}
}

/**
 * Matcher implementations for MockAppBoundary.
 */
const appBoundaryMatchers: MatcherImplementationsFor<
  MockAppBoundary & { $: AppBoundaryMockStateImpl },
  AppBoundaryMatchers
> = {
  toHaveDockBadge(received, text) {
    const actual = received.$.dockBadge;
    const pass = actual === text;

    return {
      pass,
      message: () =>
        pass
          ? `Expected dock badge NOT to be "${text}"`
          : `Expected dock badge to be "${text}", but got "${actual}"`,
    };
  },

  toHaveBadgeCount(received, count) {
    const actual = received.$.badgeCount;
    const pass = actual === count;

    return {
      pass,
      message: () =>
        pass
          ? `Expected badge count NOT to be ${count}`
          : `Expected badge count to be ${count}, but got ${actual}`,
    };
  },

  toBePreventingSleep(received) {
    const actual = received.$.preventingSleep;
    return {
      pass: actual,
      message: () =>
        actual
          ? `Expected OS NOT to be prevented from sleeping, but a sleep blocker is active`
          : `Expected OS to be prevented from sleeping, but no sleep blocker is active`,
    };
  },

  toHaveSleepBlockerStartCount(received, count) {
    const actual = received.$.sleepBlockerStarts;
    const pass = actual === count;
    return {
      pass,
      message: () =>
        pass
          ? `Expected sleep blocker start count NOT to be ${count}`
          : `Expected sleep blocker start count to be ${count}, but got ${actual}`,
    };
  },

  toHaveCommandLineSwitch(received, key, value?) {
    const switches = received.$.commandLineSwitches;

    // Check if we're verifying exact value match
    const checkValue = arguments.length >= 3;

    const found = switches.find((s) => {
      if (s.key !== key) return false;
      if (checkValue) return s.value === value;
      return true;
    });

    const pass = found !== undefined;

    // Build descriptive message
    const switchList = switches
      .map((s) => (s.value !== undefined ? `  ${s.key}=${s.value}` : `  ${s.key}`))
      .join("\n");
    const currentSwitches =
      switches.length > 0 ? `Current switches:\n${switchList}` : "No switches set";

    if (checkValue) {
      const valueDesc = value !== undefined ? `"${value}"` : "undefined";
      return {
        pass,
        message: () =>
          pass
            ? `Expected switch "${key}" with value ${valueDesc} NOT to exist`
            : `Expected switch "${key}" with value ${valueDesc} to exist.\n${currentSwitches}`,
      };
    }

    return {
      pass,
      message: () =>
        pass
          ? `Expected switch "${key}" NOT to exist`
          : `Expected switch "${key}" to exist.\n${currentSwitches}`,
    };
  },
};

// Register matchers with vitest
expect.extend(appBoundaryMatchers as Parameters<typeof expect.extend>[0]);
