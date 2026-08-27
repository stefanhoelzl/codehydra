/**
 * Behavioral mock for OsNotificationBoundary.
 *
 * Records shown notifications in order and tracks which are still open, so a
 * test can assert both what the user was told and that nothing was left behind
 * at shutdown. Clicks are simulated via `$.click(index)`.
 *
 * @example
 * const osNotificationLayer = createOsNotificationBoundaryMock();
 * // ... exercise the module ...
 * expect(osNotificationLayer).toHaveShownNotifications([
 *   { title: "CodeHydra agent needs your attention", body: "my-workspace" },
 * ]);
 * osNotificationLayer.$.click(0);
 */

import { expect } from "vitest";
import type {
  OsNotificationBoundary,
  OsNotificationHandle,
  OsNotificationOptions,
} from "./os-notification";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import { createSnapshot } from "../../test/state-mock";

// =============================================================================
// State Types
// =============================================================================

/** A notification the mock was asked to show. */
export interface ShownNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** False once it has been closed (by the module, by closeAll, or by a click). */
  readonly open: boolean;
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Mock state for OsNotificationBoundary.
 */
export class OsNotificationBoundaryMockState implements MockState {
  /**
   * Every notification shown, oldest first. Entries are never removed — closing
   * flips `open`, so a test can still assert on notifications that came and went.
   */
  private readonly _shown: ShownNotification[] = [];
  private readonly _clickHandlers = new Map<string, () => void>();

  /** Whether the simulated platform can show notifications at all. */
  supported = true;

  get shown(): readonly ShownNotification[] {
    return this._shown;
  }

  /** The notifications still on screen, oldest first. */
  get open(): readonly ShownNotification[] {
    return this._shown.filter((n) => n.open);
  }

  /**
   * Simulate the user clicking a notification, by index into `shown`.
   * Closes it first, mirroring the real boundary.
   *
   * @param index - Index into `shown` (not `open`)
   */
  click(index: number): void {
    const notification = this._shown[index];
    if (!notification) {
      throw new Error(`No notification at index ${index} (${this._shown.length} shown so far)`);
    }
    // Read the handler out before closing: `_close` forgets it, mirroring the
    // real boundary, which drops its reference on any terminal outcome.
    const handler = this._clickHandlers.get(notification.id);
    this._close(notification.id);
    handler?.();
  }

  /** @internal */
  _add(notification: ShownNotification, onClick: (() => void) | undefined): void {
    this._shown.push(notification);
    if (onClick) {
      this._clickHandlers.set(notification.id, onClick);
    }
  }

  /** @internal */
  _close(id: string): void {
    const index = this._shown.findIndex((n) => n.id === id);
    const existing = this._shown[index];
    if (!existing || !existing.open) return;
    this._shown[index] = { ...existing, open: false };
    this._clickHandlers.delete(id);
  }

  /** @internal */
  _openIds(): readonly string[] {
    return this._shown.filter((n) => n.open).map((n) => n.id);
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    if (this._shown.length === 0) return "(no notifications shown)";
    return this._shown
      .map((n) => `${n.id}: "${n.title}" / "${n.body}"${n.open ? "" : " [closed]"}`)
      .join("\n");
  }
}

// =============================================================================
// Mock Type
// =============================================================================

export type MockOsNotificationBoundary = OsNotificationBoundary &
  MockWithState<OsNotificationBoundaryMockState>;

/** Options for creating an OsNotificationBoundary mock. */
export interface MockOsNotificationBoundaryOptions {
  /**
   * Whether the simulated platform supports notifications.
   * @default true
   */
  supported?: boolean;
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for OsNotificationBoundary.
 *
 * Mirrors the real implementation's contract: `show` returns null when
 * unsupported, `close` is a silent no-op for unknown or already-closed handles,
 * and a click closes the notification before invoking the handler.
 */
export function createOsNotificationBoundaryMock(
  options: MockOsNotificationBoundaryOptions = {}
): MockOsNotificationBoundary {
  const state = new OsNotificationBoundaryMockState();
  state.supported = options.supported ?? true;
  let nextId = 1;

  const layer: OsNotificationBoundary = {
    isSupported(): boolean {
      return state.supported;
    },

    show(showOptions: OsNotificationOptions): OsNotificationHandle | null {
      if (!state.supported) return null;
      const id = `os-notification-${nextId++}`;
      state._add(
        {
          id,
          title: showOptions.title,
          body: showOptions.body,
          open: true,
        },
        showOptions.onClick
      );
      return { id, __brand: "OsNotificationHandle" };
    },

    close(handle: OsNotificationHandle): void {
      state._close(handle.id);
    },

    closeAll(): void {
      for (const id of state._openIds()) {
        state._close(id);
      }
    },
  };

  return Object.assign(layer, { $: state });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/** An expected notification, matched by the fields the test cares about. */
export interface ExpectedNotification {
  readonly title?: string;
  readonly body?: string;
}

export interface OsNotificationBoundaryMatchers {
  /**
   * Assert the exact sequence of notifications shown, oldest first.
   * Only the fields present on each expectation are compared.
   */
  toHaveShownNotifications(expected: readonly ExpectedNotification[]): void;

  /** Assert how many notifications are still on screen. */
  toHaveOpenNotificationCount(expected: number): void;
}

// Extend vitest's assertion interface
declare module "vitest" {
  interface Assertion<T> extends OsNotificationBoundaryMatchers {}
}

export const osNotificationBoundaryMatchers: MatcherImplementationsFor<
  MockOsNotificationBoundary,
  OsNotificationBoundaryMatchers
> = {
  toHaveShownNotifications(
    received: MockOsNotificationBoundary,
    expected: readonly ExpectedNotification[]
  ) {
    const shown = received.$.shown;
    const describe = (): string =>
      shown.length === 0 ? "(none)" : shown.map((n) => `"${n.title}" / "${n.body}"`).join(", ");

    if (shown.length !== expected.length) {
      return {
        pass: false,
        message: () =>
          `Expected ${expected.length} notification(s), but ${shown.length} were shown: ${describe()}`,
      };
    }

    for (const [index, expectation] of expected.entries()) {
      // Length is checked above, so this index is always populated.
      const actual = shown[index] as ShownNotification;
      for (const field of ["title", "body"] as const) {
        const want = expectation[field];
        if (want !== undefined && actual[field] !== want) {
          return {
            pass: false,
            message: () =>
              `Expected notification ${index} to have ${field} ${JSON.stringify(want)}, but got ${JSON.stringify(actual[field])}`,
          };
        }
      }
    }

    return {
      pass: true,
      message: () => `Expected notifications not to match: ${describe()}`,
    };
  },

  toHaveOpenNotificationCount(received: MockOsNotificationBoundary, expected: number) {
    const actual = received.$.open.length;
    return {
      pass: actual === expected,
      message: () => `Expected ${expected} open notification(s), but found ${actual}`,
    };
  },
};

// Register matchers with expect
expect.extend(osNotificationBoundaryMatchers);
