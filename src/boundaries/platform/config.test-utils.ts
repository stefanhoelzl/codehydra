/**
 * Test utilities for Config.
 *
 * Provides a stateful Map-backed mock whose register() returns working,
 * store-backed accessors (mirroring production), plus a standalone
 * createMockAccessor() for injecting cross-module accessors into deps.
 */
import type { Config } from "./config";
import type { PersistedAccessor, DeprecatedPersistedAccessor } from "./store-definition";

export interface CreateMockConfigOptions {
  /**
   * Seed the in-memory store. Mirrored by accessor get()/set() and
   * getEffective().
   */
  defaults?: Record<string, unknown> | undefined;
  /**
   * Snapshot returned by getRedactedOverrides(). Independent of `defaults`
   * because overrides are computed against registered definitions
   * the mock doesn't track.
   */
  overrides?: Record<string, unknown> | undefined;
}

/**
 * Create a stateful mock Config for tests. register() returns an accessor
 * backed by the shared store, so a module under test reads/writes through it
 * exactly as it would in production.
 *
 * @example
 * const config = createMockConfig({ defaults: { agent: "claude" } });
 * const agent = config.register("agent", { default: null, ... });
 * await agent.set("opencode");
 * expect(agent.get()).toBe("opencode");
 */
export function createMockConfig(options?: CreateMockConfigOptions): Config {
  const store = new Map<string, unknown>(Object.entries(options?.defaults ?? {}));
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
    definition: { default?: unknown; deprecated?: true }
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor => {
    defaultsByKey.set(key, definition.default);
    // Mirror production: registered defaults seed the store for unset keys,
    // but never overwrite values pre-populated via the `defaults` option.
    if (!store.has(key) && definition.default !== undefined) {
      store.set(key, definition.default);
    }
    if (definition.deprecated) {
      // Mirror production: deprecated keys are readable, not settable, and
      // reset() strips them from the store.
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
  }) as Config["register"];

  return {
    register,
    load: () => {},
    getEffective: () => Object.fromEntries(store),
    getRedactedOverrides: () => ({ ...overrides }),
    getHelpText: () => "",
  };
}

/**
 * Create a standalone, store-backed PersistedAccessor for tests that inject a
 * cross-module accessor (e.g. `agent`, `experimental.iframes`) into a module's
 * deps without constructing a full Config.
 *
 * @example
 * const agentConfig = createMockAccessor<ConfigAgentType>("agent", "claude");
 * const module = createTelemetryModule({ ...deps, agentConfig });
 */
export function createMockAccessor<T>(
  name: string,
  initial: T,
  defaultValue: T = initial
): PersistedAccessor<T> {
  let value = initial;
  return {
    name,
    default: defaultValue,
    get: () => value,
    set: async (next: T) => {
      value = next;
    },
    reset: async () => {
      value = defaultValue;
    },
    isDefault: () => value === defaultValue,
  };
}
