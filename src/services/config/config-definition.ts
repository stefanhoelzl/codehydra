/**
 * Config key definition types for module-owned config registration.
 *
 * Each module registers its own config keys via the "register-config" hook
 * in app:start. The config module collects all definitions and uses them
 * for parsing, validation, and help text generation.
 */

import { Path } from "../platform/path";

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
  /** Human-readable description for help text. */
  readonly description?: string;
  /** Valid values hint for help text (e.g. "true|false", "claude|opencode"). */
  readonly validValues?: string;
}

/**
 * Subset of ConfigKeyDefinition produced by type builders.
 */
type ConfigTypeBuilder<T> = Pick<ConfigKeyDefinition<T>, "parse" | "validate"> & {
  readonly validValues?: string;
};

// =============================================================================
// Type Builders
// =============================================================================

/**
 * Builder for boolean config values.
 * Parses "true"/"1" → true, "false"/"0" → false.
 */
export function configBoolean(): ConfigTypeBuilder<boolean> {
  return {
    parse: parseBool,
    validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
    validValues: "true|false",
  };
}

/**
 * Builder for enum config values.
 * Parses/validates against a fixed set of allowed string values.
 */
export function configEnum<T extends string>(values: readonly T[]): ConfigTypeBuilder<T>;
export function configEnum<T extends string>(
  values: readonly T[],
  options: { nullable: true }
): ConfigTypeBuilder<T | null>;
export function configEnum<T extends string>(
  values: readonly T[],
  options?: { nullable: true }
): ConfigTypeBuilder<T | null> {
  const set = new Set<string>(values);
  const validValues = options?.nullable ? [...values, "null"].join("|") : values.join("|");

  if (options?.nullable) {
    return {
      parse: (s: string): T | null | undefined =>
        set.has(s) ? (s as T) : s === "" ? null : undefined,
      validate: (v: unknown): T | null | undefined =>
        v === null ? null : typeof v === "string" && set.has(v) ? (v as T) : undefined,
      validValues,
    };
  }

  return {
    parse: (s: string): T | null | undefined => (set.has(s) ? (s as T) : undefined),
    validate: (v: unknown): T | null | undefined =>
      typeof v === "string" && set.has(v) ? (v as T) : undefined,
    validValues,
  };
}

/**
 * Builder for comma-separated enum list config values.
 * Parses comma-separated tokens, deduplicates, sorts, validates each token.
 */
export function configEnumList(values: readonly string[]): ConfigTypeBuilder<string> {
  const set = new Set(values);
  const validValues = values.join(",");

  function parseList(raw: string): string | undefined {
    if (!raw) return undefined;
    const tokens = raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return undefined;

    for (const token of tokens) {
      if (!set.has(token)) return undefined;
    }

    const unique = [...new Set(tokens)].sort();
    return unique.join(",");
  }

  return {
    parse: parseList,
    validate: (v: unknown) => (typeof v === "string" ? parseList(v) : undefined),
    validValues,
  };
}

/**
 * Builder for non-empty string config values.
 */
export function configString(): ConfigTypeBuilder<string>;
export function configString(options: { nullable: true }): ConfigTypeBuilder<string | null>;
export function configString(options?: { nullable: true }): ConfigTypeBuilder<string | null> {
  if (options?.nullable) {
    return {
      parse: (s: string): string | null | undefined => (s === "" ? null : s),
      validate: (v: unknown): string | null | undefined =>
        v === null ? null : typeof v === "string" ? v : undefined,
      validValues: "<string>",
    };
  }

  return {
    parse: (s: string): string | null | undefined => (s === "" ? undefined : s),
    validate: (v: unknown): string | null | undefined => (typeof v === "string" ? v : undefined),
    validValues: "<string>",
  };
}

/**
 * Builder for nullable path config values.
 * Validates that the string has no null bytes and is a valid path.
 */
export function configPath(options: { nullable: true }): ConfigTypeBuilder<string | null> {
  void options;
  return {
    parse: (s: string) => {
      if (s === "") return null;
      if (s.includes("\0")) return undefined;
      try {
        new Path(s);
        return s;
      } catch {
        return undefined;
      }
    },
    validate: (v: unknown) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      if (v.includes("\0")) return undefined;
      try {
        new Path(v);
        return v;
      } catch {
        return undefined;
      }
    },
    validValues: "<path>",
  };
}

/**
 * Builder for custom config values with explicit parse/validate functions.
 */
export function configCustom<T>(fns: {
  parse: (raw: string) => T | undefined;
  validate: (value: unknown) => T | undefined;
  validValues?: string;
}): ConfigTypeBuilder<T> {
  return {
    parse: fns.parse,
    validate: fns.validate,
    ...(fns.validValues !== undefined && { validValues: fns.validValues }),
  };
}

// =============================================================================
// Validation Error
// =============================================================================

export interface ValidationErrorDetail {
  readonly key: string;
  readonly value: unknown;
  readonly reason: "unknown" | "invalid";
  readonly source: string;
  readonly description?: string;
  readonly validValues?: string;
}

/**
 * Error thrown when config validation fails.
 * Contains structured details about what went wrong.
 */
export class ConfigValidationError extends Error {
  readonly detail: ValidationErrorDetail;

  constructor(detail: ValidationErrorDetail) {
    const msg =
      detail.reason === "unknown"
        ? `Unknown config key "${detail.key}"`
        : `Invalid value ${JSON.stringify(detail.value)} for config key "${detail.key}"`;
    const lines = [msg, `  Source: ${detail.source}`];
    if (detail.description) {
      lines.push(`  Description: ${detail.description}`);
    }
    if (detail.validValues) {
      lines.push(`  Valid values: ${detail.validValues}`);
    }
    super(lines.join("\n"));
    this.name = "ConfigValidationError";
    this.detail = detail;
  }
}

// =============================================================================
// Legacy helper (still used by test definitions)
// =============================================================================

/**
 * Parse a string as a boolean config value.
 * Accepts "true"/"1" for true, "false"/"0" for false.
 */
export function parseBool(s: string): boolean | undefined {
  return s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : undefined;
}
