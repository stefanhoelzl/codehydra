/**
 * Behavioral state mock for AppBoundary.
 *
 * Provides a mock for testing app operations without Electron, following the
 * `MockWithState<T>` pattern from `src/test/state-mock.ts`.
 *
 * Custom matchers:
 * - `toHaveDockBadge(text)` - Assert current dock badge text
 * - `toHaveBadgeCount(count)` - Assert current badge count
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
  badgeCount = 0;
  dockBadge = "";
  shouldUseDarkColors = true;
  /** True when a sleep blocker is currently active (OS prevented from sleeping). */
  preventingSleep = false;
  /** Number of times a blocker transitioned from inactive → active. */
  sleepBlockerStarts = 0;
  /** Number of times a blocker transitioned from active → inactive. */
  sleepBlockerStops = 0;
  readonly themeUpdatedCallbacks = new CallbackSet();

  triggerThemeUpdated(): void {
    this.themeUpdatedCallbacks.trigger();
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    return `AppBoundaryMockState { badgeCount: ${this.badgeCount}, dockBadge: "${this.dockBadge}", preventingSleep: ${this.preventingSleep} }`;
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
 */
export function createAppBoundaryMock(options: MockAppBoundaryOptions = {}): MockAppBoundary {
  const { platform = "darwin", shouldUseDarkColors = true } = options;

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

  return {
    $: state,
    dock,

    setBadgeCount(count: number): boolean {
      state.badgeCount = count;
      return true;
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
   * Assert current badge count.
   * @param count - Expected badge count
   */
  toHaveBadgeCount(count: number): void;

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

  toHaveBadgeCount: countMatcher<MockAppBoundary & { $: AppBoundaryMockStateImpl }>(
    "badge",
    (mock) => mock.$.badgeCount
  ),

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
};

// Register matchers with vitest
expect.extend(appBoundaryMatchers as Parameters<typeof expect.extend>[0]);
