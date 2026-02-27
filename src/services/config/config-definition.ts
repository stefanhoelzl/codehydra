/**
 * Config key definition types for module-owned config registration.
 *
 * Each module registers its own config keys via the "register-config" hook
 * in app:start. The config module collects all definitions and uses them
 * for parsing, validation, and help text generation.
 */

/**
 * Context available to computedDefault callbacks for build-dependent defaults.
 */
export interface ComputedDefaultContext {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
}

/**
 * Definition of a single configuration key.
 *
 * Modules return these from the "register-config" hook to declare
 * their config keys, defaults, and parsing/validation logic.
 */
export interface ConfigKeyDefinition<T> {
  /** Config key name (dot-separated, kebab-case). */
  readonly name: string;
  /** Static default value. */
  readonly default: T;
  /** Parse a raw CLI/env string into a typed value. undefined = invalid. */
  readonly parse: (raw: string) => T | undefined;
  /** Validate an unknown JSON value. undefined = invalid. */
  readonly validate: (value: unknown) => T | undefined;
  /** Optional computed default that overrides the static default based on build context. */
  readonly computedDefault?: (ctx: ComputedDefaultContext) => T | undefined;
}

/**
 * Parse a string as a boolean config value.
 * Accepts "true"/"1" for true, "false"/"0" for false.
 */
export function parseBool(s: string): boolean | undefined {
  return s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : undefined;
}
