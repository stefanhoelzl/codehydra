/**
 * Test utilities for Config.
 *
 * Provides a stateful Map-backed mock whose register() returns working,
 * store-backed accessors (mirroring production), plus a standalone
 * createMockAccessor() for injecting cross-module accessors into deps.
 */
import type { Config, ConfigSource } from "./config";
import type { PersistedAccessor } from "./store-definition";
import { createMockPersistedStore } from "./persisted-store.test-utils";

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
  /**
   * Value returned by wasConfigured(). Defaults to true (a configured install);
   * set false to simulate a first run (drives agent-selection onboarding).
   */
  wasConfigured?: boolean | undefined;
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
  const { store, defaultsByKey, definitionsByKey, register } = createMockPersistedStore(
    options?.defaults,
    { deprecatedReadOnly: true }
  );
  const overrides = { ...(options?.overrides ?? {}) };

  return {
    register: register as Config["register"],
    load: () => {},
    getEffective: () => Object.fromEntries(store),
    getDefinitions: () => definitionsByKey,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    reset: async (key: string) => {
      store.set(key, defaultsByKey.get(key));
    },
    getSource: (key: string): ConfigSource =>
      store.get(key) === defaultsByKey.get(key) ? "default" : "user",
    getDefault: (key: string) => defaultsByKey.get(key),
    wasConfigured: () => options?.wasConfigured ?? true,
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
