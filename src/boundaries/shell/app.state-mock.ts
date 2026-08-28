/**
 * Behavioral state mock for AppBoundary.
 *
 * Provides a mock for testing app operations without Electron, following the
 * `MockWithState<T>` pattern from `src/test/state-mock.ts`.
 *
 * Custom matchers:
 * - `toHaveDockBadge(text)` - Assert current dock badge text
 */

import { expect } from "vitest";
import type { AppBoundary, AppDock } from "./app";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import { CallbackSet, countMatcher, createSnapshot } from "../../test/state-mock";

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Internal state for the AppBoundary mock.
 * State is not directly exposed - use matchers for assertions.
 */
class AppBoundaryMockStateImpl implements MockState {
  dockBadge = "";
  shouldUseDarkColors = true;
  /** True when a sleep blocker is currently active (OS prevented from sleeping). */
  preventingSleep = false;
  /** Number of times a blocker transitioned from inactive → active. */
  sleepBlockerStarts = 0;
  /** Number of times a blocker transitioned from active → inactive. */
  sleepBlockerStops = 0;
  /** Number of times relaunch() was called (Save & Restart). */
  relaunchCount = 0;
  /** Last id passed to setAppUserModelId(), or null when never called. */
  appUserModelId: string | null = null;
  /** Whether ensureSingleInstance() reports this process as the primary one. */
  isPrimaryInstance = true;
  /** Number of times ensureSingleInstance() was called. */
  singleInstanceChecks = 0;
  /** Exit code the process terminated with, or null while still running. */
  exitCode: number | null = null;
  readonly themeUpdatedCallbacks = new CallbackSet();
  readonly reactivateCallbacks = new CallbackSet();

  triggerThemeUpdated(): void {
    this.themeUpdatedCallbacks.trigger();
  }

  /** Simulate another launch asking this instance to come forward. */
  triggerReactivate(): void {
    this.reactivateCallbacks.trigger();
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    return `AppBoundaryMockState { dockBadge: "${this.dockBadge}", preventingSleep: ${this.preventingSleep} }`;
  }
}

/**
 * Public state interface for AppBoundary mock.
 * Provides snapshot/toString only - use matchers for assertions.
 */
export interface AppBoundaryMockState extends MockState {
  snapshot(): Snapshot;
  toString(): string;

  /** Simulate another launch asking this instance to come forward. */
  triggerReactivate(): void;
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
   * Initial value reported by shouldUseDarkColors().
   * @default true
   */
  shouldUseDarkColors?: boolean;

  /**
   * Whether ensureSingleInstance() reports this process as the primary one.
   * Set false to drive the branch where another instance already holds the
   * lock — the mock records the exit instead of terminating the test runner.
   * @default true
   */
  primaryInstance?: boolean;
}

/**
 * Creates a behavioral mock of AppBoundary for testing.
 *
 * The mock maintains in-memory state and provides the same
 * platform-specific behavior as the real implementation:
 * - dock is undefined on non-macOS platforms
 *
 * Use custom matchers for assertions:
 * - `expect(mock).toHaveDockBadge("text")`
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
 */
export function createAppBoundaryMock(options: MockAppBoundaryOptions = {}): MockAppBoundary {
  const { platform = "darwin", shouldUseDarkColors = true, primaryInstance = true } = options;

  const state = new AppBoundaryMockStateImpl();
  state.shouldUseDarkColors = shouldUseDarkColors;
  state.isPrimaryInstance = primaryInstance;

  // Create dock only for macOS
  const dock: AppDock | undefined =
    platform === "darwin"
      ? {
          setBadge(text: string): void {
            state.dockBadge = text;
          },
        }
      : undefined;

  return {
    $: state,
    dock,

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

    relaunch(): void {
      state.relaunchCount += 1;
    },

    ensureSingleInstance(): boolean {
      state.singleInstanceChecks += 1;
      if (state.isPrimaryInstance) {
        return true;
      }
      // The real boundary calls app.exit(0) here and never returns. A mock
      // cannot terminate the process, so it records the exit and returns false
      // — callers bail on false, taking the same branch production takes.
      state.exitCode = 0;
      return false;
    },

    onReactivate(callback: () => void) {
      return state.reactivateCallbacks.add(callback);
    },

    setAppUserModelId(id: string): void {
      state.appUserModelId = id;
    },

    shouldUseDarkColors(): boolean {
      return state.shouldUseDarkColors;
    },

    onThemeUpdated(callback: () => void) {
      return state.themeUpdatedCallbacks.add(callback);
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

  /**
   * Assert how many times relaunch() was called (Save & Restart).
   * @param count - Expected number of relaunch calls
   */
  toHaveRelaunchCount(count: number): void;

  /**
   * Assert the Windows Application User Model ID that was set.
   * @param id - Expected id, or null when it should never have been set
   */
  toHaveAppUserModelId(id: string | null): void;

  /**
   * Assert the code the process exited with via ensureSingleInstance().
   * @param code - Expected exit code, or null when it should still be running
   */
  toHaveExitedWithCode(code: number | null): void;
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

  toHaveSleepBlockerStartCount: countMatcher<MockAppBoundary & { $: AppBoundaryMockStateImpl }>(
    "sleep blocker start",
    (mock) => mock.$.sleepBlockerStarts
  ),

  toHaveRelaunchCount: countMatcher<MockAppBoundary & { $: AppBoundaryMockStateImpl }>(
    "relaunch",
    (mock) => mock.$.relaunchCount
  ),

  toHaveAppUserModelId(received, id) {
    const actual = received.$.appUserModelId;
    const pass = actual === id;
    return {
      pass,
      message: () =>
        pass
          ? `Expected app user model id NOT to be ${JSON.stringify(id)}`
          : `Expected app user model id to be ${JSON.stringify(id)}, but got ${JSON.stringify(actual)}`,
    };
  },

  toHaveExitedWithCode(received, code) {
    const actual = received.$.exitCode;
    const pass = actual === code;
    return {
      pass,
      message: () =>
        pass
          ? `Expected process NOT to have exited with code ${JSON.stringify(code)}`
          : `Expected process to have exited with code ${JSON.stringify(code)}, but got ${JSON.stringify(actual)}`,
    };
  },
};

// Register matchers with vitest
expect.extend(appBoundaryMatchers as Parameters<typeof expect.extend>[0]);
