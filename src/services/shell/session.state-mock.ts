/**
 * Behavioral state mock for SessionLayer.
 *
 * Provides a stateful mock that simulates real SessionLayer behavior:
 * - In-memory session storage
 * - Partition-based session lookup
 * - Permission handler tracking
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const mock = createSessionLayerMock();
 * const handle = mock.fromPartition("persist:test");
 * await mock.clearStorageData(handle);
 * expect(mock).toHaveSession(handle.id, { cleared: true });
 */

import { expect } from "vitest";
import type { SessionLayer, PermissionRequestHandler, PermissionCheckHandler } from "./session";
import type { SessionHandle } from "./types";
import { ShellError } from "./errors";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// State Types
// =============================================================================

/**
 * State for an individual session.
 */
export interface MockSessionState {
  readonly partition: string;
  readonly cleared: boolean;
  readonly hasPermissionRequestHandler: boolean;
  readonly hasPermissionCheckHandler: boolean;
  readonly hasHeadersReceivedHandler: boolean;
}

/**
 * State interface for the session layer mock.
 * Provides read access to sessions and test helper methods.
 */
export interface SessionLayerMockState extends MockState {
  /**
   * Read-only access to all sessions.
   * Keys are session handle IDs.
   */
  readonly sessions: ReadonlyMap<string, MockSessionState>;

  /**
   * Capture current state as snapshot for later comparison.
   */
  snapshot(): Snapshot;

  /**
   * Human-readable representation of session state.
   */
  toString(): string;
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Mutable internal state for a session (used during mock operations).
 */
interface MutableSessionState {
  partition: string;
  cleared: boolean;
  hasPermissionRequestHandler: boolean;
  hasPermissionCheckHandler: boolean;
  hasHeadersReceivedHandler: boolean;
}

class SessionLayerMockStateImpl implements SessionLayerMockState {
  private readonly _sessions = new Map<string, MutableSessionState>();

  get sessions(): ReadonlyMap<string, MockSessionState> {
    return this._sessions;
  }

  /**
   * Add or update a session in the state.
   * Used internally by the mock implementation.
   */
  setSession(id: string, state: MutableSessionState): void {
    this._sessions.set(id, state);
  }

  /**
   * Get a mutable session state for modification.
   * Returns undefined if session doesn't exist.
   */
  getMutableSession(id: string): MutableSessionState | undefined {
    return this._sessions.get(id);
  }

  /**
   * Delete a session from the state.
   */
  deleteSession(id: string): boolean {
    return this._sessions.delete(id);
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this._sessions.clear();
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() };
  }

  toString(): string {
    const entries = [...this._sessions.entries()]
      .map(([id, s]) => `${id}: ${s.partition} (cleared=${s.cleared})`)
      .join(", ");
    return `SessionLayerMockState { ${entries} }`;
  }
}

// =============================================================================
// Mock Type and Factory Options
// =============================================================================

/**
 * SessionLayer mock with state access via `$` property.
 * Use `createSessionLayerMock()` to create instances.
 */
export type MockSessionLayer = SessionLayer & MockWithState<SessionLayerMockState>;

/**
 * Options for creating a session layer mock.
 */
export interface SessionLayerMockOptions {
  /**
   * Pre-existing sessions to initialize.
   * Keys are partition names; sessions will be assigned sequential handle IDs.
   */
  sessions?: Record<
    string,
    {
      cleared?: boolean;
      hasPermissionRequestHandler?: boolean;
      hasPermissionCheckHandler?: boolean;
      hasHeadersReceivedHandler?: boolean;
    }
  >;
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for SessionLayer.
 *
 * The mock maintains state and validates operations just like the real
 * implementation, making it suitable for integration tests.
 *
 * @example Basic usage
 * const mock = createSessionLayerMock();
 * const handle = mock.fromPartition("persist:test");
 * expect(mock).toHaveSession(handle.id);
 *
 * @example With initial sessions
 * const mock = createSessionLayerMock({
 *   sessions: {
 *     "persist:workspace1": { cleared: true },
 *   },
 * });
 *
 * @example Verify permission handlers
 * const mock = createSessionLayerMock();
 * const handle = mock.fromPartition("persist:test");
 * mock.setPermissionRequestHandler(handle, () => true);
 * expect(mock).toHaveSession(handle.id, { requestHandler: true });
 */
export function createSessionLayerMock(options?: SessionLayerMockOptions): MockSessionLayer {
  const state = new SessionLayerMockStateImpl();
  // Map partition name to handle ID for quick lookup
  const partitionToId = new Map<string, string>();
  let nextId = 1;

  // Initialize with pre-existing sessions if provided
  if (options?.sessions) {
    for (const [partition, sessionState] of Object.entries(options.sessions)) {
      const id = `session-${nextId++}`;
      state.setSession(id, {
        partition,
        cleared: sessionState.cleared ?? false,
        hasPermissionRequestHandler: sessionState.hasPermissionRequestHandler ?? false,
        hasPermissionCheckHandler: sessionState.hasPermissionCheckHandler ?? false,
        hasHeadersReceivedHandler: sessionState.hasHeadersReceivedHandler ?? false,
      });
      partitionToId.set(partition, id);
    }
  }

  function getSession(handle: SessionHandle): MutableSessionState {
    const session = state.getMutableSession(handle.id);
    if (!session) {
      throw new ShellError("SESSION_NOT_FOUND", `Session ${handle.id} not found`, handle.id);
    }
    return session;
  }

  const layer: SessionLayer = {
    fromPartition(partition: string): SessionHandle {
      // Check if we already have a handle for this partition
      const existingId = partitionToId.get(partition);
      if (existingId) {
        return { id: existingId, __brand: "SessionHandle" };
      }

      // Create new session
      const id = `session-${nextId++}`;
      state.setSession(id, {
        partition,
        cleared: false,
        hasPermissionRequestHandler: false,
        hasPermissionCheckHandler: false,
        hasHeadersReceivedHandler: false,
      });
      partitionToId.set(partition, id);

      return { id, __brand: "SessionHandle" };
    },

    async clearStorageData(handle: SessionHandle): Promise<void> {
      const session = getSession(handle);
      session.cleared = true;
    },

    setPermissionRequestHandler(
      handle: SessionHandle,
      handler: PermissionRequestHandler | null
    ): void {
      const session = getSession(handle);
      session.hasPermissionRequestHandler = handler !== null;
    },

    setPermissionCheckHandler(handle: SessionHandle, handler: PermissionCheckHandler | null): void {
      const session = getSession(handle);
      session.hasPermissionCheckHandler = handler !== null;
    },

    setHeadersReceivedHandler(
      handle: SessionHandle,
      handler: ((headers: Record<string, string[]>) => Record<string, string[]>) | null
    ): void {
      const session = getSession(handle);
      session.hasHeadersReceivedHandler = handler !== null;
    },

    async dispose(): Promise<void> {
      state.clear();
      partitionToId.clear();
    },
  };

  return Object.assign(layer, { $: state as SessionLayerMockState });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Expected state for session assertions.
 */
interface SessionExpected {
  /** Whether storage has been cleared */
  cleared?: boolean;
  /** Whether a permission request handler is set (maps to hasPermissionRequestHandler) */
  requestHandler?: boolean;
  /** Whether a permission check handler is set (maps to hasPermissionCheckHandler) */
  checkHandler?: boolean;
  /** The partition name */
  partition?: string;
}

/**
 * Custom matchers for session layer mock assertions.
 */
interface SessionLayerMatchers {
  /**
   * Assert that a session exists with optional state verification.
   *
   * @param handleId - The session handle ID to check
   * @param expected - Optional expected state properties
   *
   * @example Check session exists
   * expect(mock).toHaveSession("session-1");
   *
   * @example Check session state
   * expect(mock).toHaveSession("session-1", { cleared: true });
   * expect(mock).toHaveSession("session-1", { requestHandler: true, partition: "persist:test" });
   */
  toHaveSession(handleId: string, expected?: SessionExpected): void;

  /**
   * Assert the total number of sessions.
   *
   * @param count - Expected number of sessions
   *
   * @example
   * expect(mock).toHaveSessionCount(2);
   */
  toHaveSessionCount(count: number): void;
}

declare module "vitest" {
  interface Assertion<T> extends SessionLayerMatchers {}
}

export const sessionLayerMatchers: MatcherImplementationsFor<
  MockSessionLayer,
  SessionLayerMatchers
> = {
  toHaveSession(received, handleId, expected?) {
    const session = received.$.sessions.get(handleId);

    if (!session) {
      return {
        pass: false,
        message: () =>
          `Expected session "${handleId}" to exist but it was not found.\n` +
          `Available sessions: ${[...received.$.sessions.keys()].join(", ") || "(none)"}`,
      };
    }

    // If no expected properties, just check existence
    if (!expected) {
      return {
        pass: true,
        message: () => `Expected session "${handleId}" not to exist`,
      };
    }

    // Check each expected property
    const mismatches: string[] = [];

    if (expected.cleared !== undefined && session.cleared !== expected.cleared) {
      mismatches.push(`cleared: expected ${expected.cleared}, got ${session.cleared}`);
    }

    if (
      expected.requestHandler !== undefined &&
      session.hasPermissionRequestHandler !== expected.requestHandler
    ) {
      mismatches.push(
        `requestHandler: expected ${expected.requestHandler}, got ${session.hasPermissionRequestHandler}`
      );
    }

    if (
      expected.checkHandler !== undefined &&
      session.hasPermissionCheckHandler !== expected.checkHandler
    ) {
      mismatches.push(
        `checkHandler: expected ${expected.checkHandler}, got ${session.hasPermissionCheckHandler}`
      );
    }

    if (expected.partition !== undefined && session.partition !== expected.partition) {
      mismatches.push(`partition: expected "${expected.partition}", got "${session.partition}"`);
    }

    if (mismatches.length > 0) {
      return {
        pass: false,
        message: () =>
          `Session "${handleId}" exists but has mismatched properties:\n  ${mismatches.join("\n  ")}`,
      };
    }

    return {
      pass: true,
      message: () => `Expected session "${handleId}" not to match ${JSON.stringify(expected)}`,
    };
  },

  toHaveSessionCount(received, count) {
    const actual = received.$.sessions.size;

    if (actual !== count) {
      return {
        pass: false,
        message: () => `Expected ${count} sessions but found ${actual}`,
      };
    }

    return {
      pass: true,
      message: () => `Expected not to have ${count} sessions`,
    };
  },
};

// Register matchers with expect
expect.extend(sessionLayerMatchers);
