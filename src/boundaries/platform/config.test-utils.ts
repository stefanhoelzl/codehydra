/**
 * Test utilities for Config.
 *
 * Provides a stateful Map-backed mock that mirrors get/set/getEffective
 * and lets callers seed both the in-memory store and the getOverrides()
 * snapshot independently.
 */
import type { Config } from "./config";

export interface CreateMockConfigOptions {
  /**
   * Seed the in-memory store. Mirrored by get(), set() (mutates),
   * and getEffective().
   */
  defaults?: Record<string, unknown> | undefined;
  /**
   * Snapshot returned by getOverrides(). Independent of `defaults`
   * because overrides are computed against registered definitions
   * the mock doesn't track.
   */
  overrides?: Record<string, unknown> | undefined;
}

/**
 * Create a stateful mock Config for tests.
 *
 * @example
 * const config = createMockConfig({ defaults: { agent: "claude" } });
 * await config.set("agent", "opencode");
 * expect(config.get("agent")).toBe("opencode");
 *
 * @example
 * const config = createMockConfig({
 *   defaults: { "telemetry.enabled": true },
 *   overrides: { agent: "claude", "log.level": "debug" },
 * });
 * expect(config.getOverrides()).toEqual({ agent: "claude", "log.level": "debug" });
 */
export function createMockConfig(options?: CreateMockConfigOptions): Config {
  const store = new Map<string, unknown>(Object.entries(options?.defaults ?? {}));
  const overrides = { ...(options?.overrides ?? {}) };
  return {
    register: (key: string, definition: { default?: unknown }) => {
      // Mirror production: registered defaults seed get() for unset keys,
      // but never overwrite values pre-populated via the `defaults` option.
      if (!store.has(key) && definition.default !== undefined) {
        store.set(key, definition.default);
      }
    },
    load: () => {},
    get: (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getDefinitions: () => new Map(),
    getEffective: () => Object.fromEntries(store),
    getDefaults: () => ({}),
    getOverrides: () => ({ ...overrides }),
    getHelpText: () => "",
  };
}
