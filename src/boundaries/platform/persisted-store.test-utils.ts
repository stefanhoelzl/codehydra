/**
 * Test utilities shared by the Config and StateService mocks.
 *
 * Both services compose a `PersistedStore` in production; their mocks compose
 * this Map-backed stand-in, so register() returns working, store-backed
 * accessors in both.
 */
import type {
  PersistedAccessor,
  DeprecatedPersistedAccessor,
  PersistedKeyDefinition,
} from "./store-definition";

/** A Map-backed store with production-like `register()`. */
export interface MockPersistedStore {
  /** Current values, seeded from the `seed` passed in. */
  readonly store: Map<string, unknown>;
  /** Each registered key's default. */
  readonly defaultsByKey: Map<string, unknown>;
  /** Each registered key's definition. */
  readonly definitionsByKey: Map<string, PersistedKeyDefinition<unknown>>;
  /** Register a key: record its definition and return an accessor backed by the store. */
  register(
    key: string,
    definition: { default?: unknown; deprecated?: true }
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor;
  /**
   * Write a value as a string-keyed setter would (the settings dialog), telling
   * the key's onChange listeners when it changed.
   */
  write(key: string, value: unknown): void;
}

export interface MockPersistedStoreOptions {
  /**
   * Give `deprecated: true` keys a read-only accessor whose reset() strips the
   * key from the store (Config's one-shot migration source). Default: false —
   * every key gets an ordinary accessor.
   */
  readonly deprecatedReadOnly?: boolean;
}

/**
 * Create a Map-backed store seeded with `seed`. Mirrors `PersistedStore`:
 * registered defaults fill unset keys (never overwriting a seeded value).
 */
export function createMockPersistedStore(
  seed: Record<string, unknown> | undefined,
  options?: MockPersistedStoreOptions
): MockPersistedStore {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  const defaultsByKey = new Map<string, unknown>();
  const definitionsByKey = new Map<string, PersistedKeyDefinition<unknown>>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();

  function write(key: string, value: unknown): void {
    const previous = store.get(key);
    store.set(key, value);
    if (previous === value) return;
    for (const listener of [...(listeners.get(key) ?? [])]) listener(value);
  }

  function makeAccessor(key: string): PersistedAccessor<unknown> {
    return {
      name: key,
      get default() {
        return defaultsByKey.get(key);
      },
      get: () => store.get(key),
      set: async (value: unknown) => {
        write(key, value);
      },
      reset: async () => {
        write(key, defaultsByKey.get(key));
      },
      isDefault: () => store.get(key) === defaultsByKey.get(key),
      onChange: (listener) => {
        let set = listeners.get(key);
        if (set === undefined) {
          set = new Set();
          listeners.set(key, set);
        }
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
    };
  }

  function register(
    key: string,
    definition: { default?: unknown; deprecated?: true }
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor {
    defaultsByKey.set(key, definition.default);
    definitionsByKey.set(key, definition as PersistedKeyDefinition<unknown>);
    if (!store.has(key) && definition.default !== undefined) {
      store.set(key, definition.default);
    }
    if (definition.deprecated && options?.deprecatedReadOnly) {
      return {
        name: key,
        get: () => store.get(key),
        set: (): never => {
          throw new Error(`Deprecated config key "${key}"`);
        },
        reset: async () => {
          store.delete(key);
        },
      };
    }
    return makeAccessor(key);
  }

  return { store, defaultsByKey, definitionsByKey, register, write };
}
