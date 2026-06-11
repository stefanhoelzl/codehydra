import { expect } from "vitest";

// =============================================================================
// Core Types
// =============================================================================

/**
 * Opaque snapshot type for state comparison.
 * Created via `mock.$.snapshot()`, compared via `toBeUnchanged(snapshot)`.
 */
export type Snapshot = { readonly __brand: "Snapshot"; readonly value: string };

/**
 * Base interface for mock state. All state mocks must extend this.
 * State should be pure data - logic belongs in matchers.
 */
export interface MockState {
  /**
   * Capture current state as snapshot for later comparison.
   * @returns Opaque snapshot that can be passed to `toBeUnchanged()`
   */
  snapshot(): Snapshot;

  /**
   * Human-readable description of current state.
   * Used in matcher error messages.
   */
  toString(): string;
}

/**
 * Create a branded Snapshot from the current state's string representation.
 * State mocks implement `snapshot()` as `return createSnapshot(this);`.
 */
export function createSnapshot(stringable: { toString(): string }): Snapshot {
  return { __brand: "Snapshot", value: stringable.toString() };
}

/**
 * A mock with inspectable state via the `$` property.
 * This formalizes the existing `_getState()` pattern.
 */
export interface MockWithState<TState extends MockState> {
  readonly $: TState;
}

/**
 * Helper type for defining type-safe matchers on Assertion<T>.
 * Returns TMatchers when T matches TMock, otherwise empty object.
 * The empty object fallback is intentional for conditional interface extension.
 */
export type MatchersFor<T, TMock extends MockWithState<MockState>, TMatchers> = T extends TMock
  ? TMatchers
  : {};

/**
 * Vitest matcher result type.
 */
export interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/**
 * Derives matcher implementation type from assertion matcher type.
 * - Prepends `received: TMock` parameter
 * - Changes return type from `void` to `MatcherResult`
 */
export type MatcherImplementationsFor<TMock, TMatchers> = {
  [K in keyof TMatchers]: TMatchers[K] extends (...args: infer Args) => void
    ? (received: TMock, ...args: Args) => MatcherResult
    : never;
};

// =============================================================================
// Callback Registries
// =============================================================================

/**
 * Per-key callback registry for event simulation in behavioral mocks.
 *
 * Replaces the hand-rolled `Map<string, Set<callback>>` scaffolding: keys are
 * created on resource creation (`init`), subscribed via `add` (which returns
 * an unsubscribe), fired via `trigger`, and torn down via `delete`/`clear`.
 *
 * Triggers with custom semantics (short-circuiting, result aggregation,
 * selective cleanup) compose via `get()` instead of using `trigger()`.
 */
export class CallbackRegistry<Args extends readonly unknown[] = []> {
  private readonly _callbacks = new Map<string, Set<(...args: Args) => void>>();

  /** Create an empty callback set for a key (called on resource creation). */
  init(id: string): void {
    this._callbacks.set(id, new Set());
  }

  /**
   * Subscribe a callback for a key. Returns an unsubscribe function.
   * No-op if the key was never initialized (mirrors `callbacks?.add()`).
   */
  add(id: string, callback: (...args: Args) => void): () => void {
    const callbacks = this._callbacks.get(id);
    callbacks?.add(callback);
    return () => {
      callbacks?.delete(callback);
    };
  }

  /** Invoke all callbacks registered for a key. */
  trigger(id: string, ...args: Args): void {
    const callbacks = this._callbacks.get(id);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(...args);
      }
    }
  }

  /** Access the raw callback set for custom trigger semantics. */
  get(id: string): ReadonlySet<(...args: Args) => void> | undefined {
    return this._callbacks.get(id);
  }

  /** Remove all callbacks for a key (called on resource destruction). */
  delete(id: string): void {
    this._callbacks.delete(id);
  }

  /** Remove all callbacks for all keys (called on destroyAll/dispose). */
  clear(): void {
    this._callbacks.clear();
  }
}

/**
 * Non-keyed variant of {@link CallbackRegistry} for global (per-mock) events.
 */
export class CallbackSet<Args extends readonly unknown[] = []> {
  private readonly _callbacks = new Set<(...args: Args) => void>();

  /** Subscribe a callback. Returns an unsubscribe function. */
  add(callback: (...args: Args) => void): () => void {
    this._callbacks.add(callback);
    return () => {
      this._callbacks.delete(callback);
    };
  }

  /** Invoke all registered callbacks. */
  trigger(...args: Args): void {
    for (const callback of this._callbacks) {
      callback(...args);
    }
  }
}

// =============================================================================
// Matcher Factories
// =============================================================================

/**
 * Create a count-assertion matcher implementation (`toHave*Count` family).
 *
 * @param noun - What is being counted, singular (used in failure messages)
 * @param getActual - Extracts the actual count from the received mock
 */
export function countMatcher<TMock>(
  noun: string,
  getActual: (received: TMock) => number
): (received: TMock, count: number) => MatcherResult {
  return (received, count) => {
    const actual = getActual(received);
    const pass = actual === count;
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${noun} count NOT to be ${count}`
          : `Expected ${noun} count to be ${count}, but got ${actual}`,
    };
  };
}

// =============================================================================
// Base Matchers for MockWithState
// =============================================================================

/**
 * Base matcher interface. These matchers are available for all assertions
 * but are intended for use with MockWithState objects.
 */
interface MockWithStateMatchers {
  /**
   * Assert that mock state has not changed since snapshot was taken.
   * Only works with objects that have a `$` property implementing MockState.
   * @param snapshot - Snapshot from `mock.$.snapshot()`
   */
  toBeUnchanged(snapshot: Snapshot): void;
}

declare module "vitest" {
  // Base matchers are added unconditionally (standard pattern for testing libraries)
  // Runtime checks ensure correct usage
  interface Assertion<T> extends MockWithStateMatchers {}
}

export const mockWithStateMatchers: MatcherImplementationsFor<
  MockWithState<MockState>,
  MockWithStateMatchers
> = {
  toBeUnchanged(received, snapshot) {
    const current = received.$.toString();
    const pass = snapshot.value === current;

    return {
      pass,
      message: () =>
        pass
          ? `Expected mock state to have changed.\nSnapshot: ${snapshot.value}\nCurrent: ${current}`
          : `Expected mock state to be unchanged.\nSnapshot: ${snapshot.value}\nCurrent: ${current}`,
    };
  },
};

expect.extend(mockWithStateMatchers);
