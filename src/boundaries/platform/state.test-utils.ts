/**
 * Test utilities for StateService.
 *
 * Provides a stateful Map-backed mock whose register() returns working,
 * store-backed accessors (mirroring production), for module tests that read or
 * write persisted state without constructing a real DefaultStateService.
 */
import type { StateService } from "./state-service";
import { createMockPersistedStore } from "./persisted-store.test-utils";

/**
 * Mock StateService with a test-only inspection helper for the in-memory store.
 */
export interface MockStateService extends StateService {
  /** Test-only: snapshot of all values in the in-memory store. */
  getEffective(): Record<string, unknown>;
}

export interface CreateMockStateOptions {
  /** Seed the in-memory store. Mirrored by accessor get()/set() and getEffective(). */
  values?: Record<string, unknown> | undefined;
  /**
   * Snapshot returned by getRedactedOverrides(). Independent of `values`
   * because overrides are computed against registered definitions
   * the mock doesn't track.
   */
  overrides?: Record<string, unknown> | undefined;
}

/**
 * Create a stateful mock StateService for tests. register() returns an accessor
 * backed by the shared store, so a module under test reads/writes through it
 * exactly as it would in production. load() is a no-op (values are seeded up front).
 */
export function createMockState(options?: CreateMockStateOptions): MockStateService {
  const { store, register } = createMockPersistedStore(options?.values);
  const overrides = { ...(options?.overrides ?? {}) };

  return {
    register: register as StateService["register"],
    load: async () => {},
    getEffective: () => Object.fromEntries(store),
    getRedactedOverrides: () => ({ ...overrides }),
  };
}
