/**
 * Test utilities for StateService.
 *
 * Provides a stateful Map-backed mock whose register() returns working,
 * store-backed accessors (mirroring production), for module tests that read or
 * write persisted state without constructing a real DefaultStateService.
 */
import type { StateService } from "./state-service";
import type { PersistedAccessor, DeprecatedPersistedAccessor } from "./store-definition";

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
export function createMockState(options?: CreateMockStateOptions): StateService {
  const store = new Map<string, unknown>(Object.entries(options?.values ?? {}));
  const overrides = { ...(options?.overrides ?? {}) };
  const defaultsByKey = new Map<string, unknown>();

  function makeAccessor(key: string): PersistedAccessor<unknown> {
    return {
      name: key,
      get default() {
        return defaultsByKey.get(key);
      },
      get: () => store.get(key),
      set: async (value: unknown) => {
        store.set(key, value);
      },
      reset: async () => {
        store.set(key, defaultsByKey.get(key));
      },
      isDefault: () => store.get(key) === defaultsByKey.get(key),
    };
  }

  const register = ((
    key: string,
    definition: { default?: unknown }
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor => {
    defaultsByKey.set(key, definition.default);
    // Mirror production: registered defaults seed the store for unset keys,
    // but never overwrite values pre-populated via the `values` option.
    if (!store.has(key) && definition.default !== undefined) {
      store.set(key, definition.default);
    }
    return makeAccessor(key);
  }) as StateService["register"];

  return {
    register,
    load: async () => {},
    getEffective: () => Object.fromEntries(store),
    getRedactedOverrides: () => ({ ...overrides }),
  };
}
