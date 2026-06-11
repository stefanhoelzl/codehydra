/**
 * Key-definition types and value-type builders shared by the persisted stores.
 *
 * These back PersistedStore (see persisted-store.ts) and therefore both of its
 * composers — Config (config.json) and StateService (state.json). Modules pass a
 * PersistedKeyDefinition (usually via a store* builder) to register(), and the
 * store uses it for parsing, validation, and (for Config) help-text generation.
 */

import { Path } from "../../utils/path/path";

// =============================================================================
// Shared Type Aliases
// =============================================================================

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
export interface PersistedKeyDefinition<T> {
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
  /**
   * Controls redaction in contexts like bug reports (see getRedactedOverrides).
   * `true` replaces the whole value with the redaction token. A function
   * receives the effective value plus the redaction token and returns a custom
   * projection (e.g. scrub one field, keep the rest) — it must not throw;
   * getRedactedOverrides falls back to the token if it does.
   */
  readonly redact?: true | ((value: T, redacted: string) => unknown);
  /**
   * When true, the key is recognized and loaded read-only: its on-disk value is
   * preserved (so a downgrade doesn't lose it) and readable via get(), but set()
   * throws. reset() deletes it from the file. Hidden from help text and overrides.
   * Used as a one-shot migration source (read old value, seed elsewhere, reset()).
   */
  readonly deprecated?: true;
  /**
   * Map of legacy key -> translator that produces the new value from the legacy
   * JSON value. Used to migrate renamed keys without crashing on the old name.
   *
   * In config.json the translator runs on the typed legacy value, and the legacy
   * entry is preserved on disk. Env vars and CLI flags honor legacy names too, but
   * via pure-rename: the raw string is run through the new key's parse() (the
   * translator is not invoked), since a string can't be fed to the typed translator.
   */
  readonly legacyNames?: Record<string, (legacyValue: unknown) => T | undefined>;
}

/**
 * Subset of PersistedKeyDefinition produced by type builders.
 */
export type PersistedTypeBuilder<T> = Pick<PersistedKeyDefinition<T>, "parse" | "validate"> & {
  readonly validValues?: string;
};

// =============================================================================
// Accessors
// =============================================================================

/**
 * Typed handle to a single key, returned by `Config.register()` or
 * `StateService.register()`.
 *
 * The accessor carries the key's value type, so reads need no casts and writes
 * are checked against the registered type. It closes over the owning store;
 * `get()` reflects the effective value (after `load()`), `set()` persists, and
 * `reset()` reverts to the default.
 */
export interface PersistedAccessor<T> {
  /** The key name (dot-separated, kebab-case). */
  readonly name: string;
  /** The resolved default (static or computed) for this key. */
  readonly default: T;
  /** Get the effective value. */
  get(): T;
  /**
   * Set a value at runtime. Validates against the registered definition.
   * Always persists the given value (including `null` when `T` allows it)
   * unless `persist: false`. Use `reset()` to revert to the default.
   */
  set(value: T, options?: { persist?: boolean }): Promise<void>;
  /** Revert to the default value and delete the key from the backing file. */
  reset(options?: { persist?: boolean }): Promise<void>;
  /** True when the effective value equals the resolved default. */
  isDefault(): boolean;
}

/**
 * Accessor returned for keys registered with `deprecated: true`. The key is
 * recognized and its on-disk value is loaded read-only: `get()` returns the
 * value (typed `unknown`), but `set()` throws — a deprecated key cannot be
 * written. `reset()` deletes the key from the backing file. This makes a
 * deprecated key a clean one-time migration source: read the old value, seed it
 * elsewhere, then `reset()` to strip it. Hidden from help text and overrides.
 */
export interface DeprecatedPersistedAccessor {
  /** The config key name. */
  readonly name: string;
  /** Read the loaded (read-only) value. */
  get(): unknown;
  /** Always throws — deprecated keys are not settable. */
  set(value: never): never;
  /** Delete the key from the backing file (e.g. after migrating it elsewhere). */
  reset(options?: { persist?: boolean }): Promise<void>;
}

// =============================================================================
// Type Builders
// =============================================================================

/**
 * Builder for boolean config values.
 * Parses "true"/"1" → true, "false"/"0" → false.
 */
export function storeBoolean(): PersistedTypeBuilder<boolean> {
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
export function storeEnum<const T extends string>(values: readonly T[]): PersistedTypeBuilder<T>;
export function storeEnum<const T extends string>(
  values: readonly T[],
  options: { nullable: true }
): PersistedTypeBuilder<T | null>;
export function storeEnum<const T extends string>(
  values: readonly T[],
  options?: { nullable: true }
): PersistedTypeBuilder<T | null> {
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
export function storeEnumList(values: readonly string[]): PersistedTypeBuilder<string> {
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
export function storeString(): PersistedTypeBuilder<string>;
export function storeString(options: { nullable: true }): PersistedTypeBuilder<string | null>;
export function storeString(options?: { nullable: true }): PersistedTypeBuilder<string | null> {
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
export function storePath(options: { nullable: true }): PersistedTypeBuilder<string | null> {
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
export function storeCustom<T>(fns: {
  parse: (raw: string) => T | undefined;
  validate: (value: unknown) => T | undefined;
  validValues?: string;
}): PersistedTypeBuilder<T> {
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
  readonly reason: "unknown" | "invalid" | "deprecated";
  readonly source: string;
  readonly description?: string;
  readonly validValues?: string;
}

/**
 * Error thrown when config validation fails.
 * Contains structured details about what went wrong.
 */
export class PersistedValidationError extends Error {
  readonly detail: ValidationErrorDetail;

  constructor(detail: ValidationErrorDetail) {
    const msg =
      detail.reason === "unknown"
        ? `Unknown config key "${detail.key}"`
        : detail.reason === "deprecated"
          ? `Deprecated config key "${detail.key}"`
          : `Invalid value ${JSON.stringify(detail.value)} for config key "${detail.key}"`;
    const lines = [msg, `  Source: ${detail.source}`];
    if (detail.description) {
      lines.push(`  Description: ${detail.description}`);
    }
    if (detail.validValues) {
      lines.push(`  Valid values: ${detail.validValues}`);
    }
    super(lines.join("\n"));
    this.name = "PersistedValidationError";
    this.detail = detail;
  }
}

// =============================================================================
// Config Issues
// =============================================================================

/**
 * A diagnostic produced while parsing or validating config sources.
 *
 * The transform functions (PersistedDefinitions.parse / .validate, readConfigFile)
 * are pure: they return issues instead of logging or throwing. `Config.load()`
 * is the single place that interprets them — logging the benign kinds and
 * throwing a PersistedValidationError on `invalid`.
 */
export type PersistedIssue =
  | { kind: "invalid"; key: string; value: unknown; description?: string; validValues?: string }
  | { kind: "unknown"; key: string }
  | { kind: "deprecated"; key: string }
  | { kind: "legacy-shadowed"; legacy: string; newKey: string }
  | { kind: "legacy-untranslatable"; legacy: string; newKey: string; value: unknown }
  | { kind: "broken-json"; path: string; backup: string; error: string };

function invalidIssue(
  key: string,
  value: unknown,
  def: PersistedKeyDefinition<unknown>
): PersistedIssue {
  return {
    kind: "invalid",
    key,
    value,
    ...(def.description !== undefined && { description: def.description }),
    ...(def.validValues !== undefined && { validValues: def.validValues }),
  };
}

// =============================================================================
// Config Definitions (schema object)
// =============================================================================

/**
 * The set of registered config-key definitions, plus the record-level
 * operations that run against them.
 *
 * Two input formats, two methods:
 *  - parse():    raw strings (env/CLI) → typed values, using each def.parse.
 *  - validate(): typed values (config.json, or parse() output) → validated,
 *                using each def.validate. This is the shared-policy gate:
 *                unknown keys, deprecated keys, and typed legacy translation
 *                are all resolved here.
 *
 * Both are pure: they return { values, issues } and never log or throw.
 * Raw legacy keys are resolved in parse() (pure-rename through the new key's
 * parse) because validate() cannot coerce a string into a typed value.
 */
export class PersistedDefinitions {
  private readonly map = new Map<string, PersistedKeyDefinition<unknown>>();

  add(key: string, definition: PersistedKeyDefinition<unknown>): void {
    this.map.set(key, definition);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): PersistedKeyDefinition<unknown> | undefined {
    return this.map.get(key);
  }

  /** The underlying map as a ReadonlyMap, for help-text generation and the public getter. */
  asReadonlyMap(): ReadonlyMap<string, PersistedKeyDefinition<unknown>> {
    return this.map;
  }

  [Symbol.iterator](): IterableIterator<[string, PersistedKeyDefinition<unknown>]> {
    return this.map[Symbol.iterator]();
  }

  /** Build legacyName -> { newKey, translator }. Last writer wins on collision. */
  private buildLegacyLookup(): Map<
    string,
    { newKey: string; translator: (v: unknown) => unknown }
  > {
    const lookup = new Map<string, { newKey: string; translator: (v: unknown) => unknown }>();
    for (const [newKey, def] of this.map) {
      if (!def.legacyNames) continue;
      for (const [legacyName, translator] of Object.entries(def.legacyNames)) {
        lookup.set(legacyName, { newKey, translator });
      }
    }
    return lookup;
  }

  /**
   * Parse raw string values (env vars / CLI flags) into typed values.
   *
   * Per key:
   *  - active known key → def.parse(string); won't parse → `invalid` issue.
   *  - legacy name (new key absent) → rename, newDef.parse(string) (pure-rename).
   *  - legacy name (new key present) → `legacy-shadowed` issue.
   *  - unknown or deprecated key → pass the raw string through; validate() classifies it.
   */
  parse(rawValues: Record<string, string>): {
    values: Record<string, unknown>;
    issues: PersistedIssue[];
  } {
    const values: Record<string, unknown> = {};
    const issues: PersistedIssue[] = [];
    const legacyLookup = this.buildLegacyLookup();

    for (const [key, raw] of Object.entries(rawValues)) {
      const def = this.map.get(key);
      if (def && !def.deprecated) {
        const parsed = def.parse(raw);
        if (parsed === undefined) {
          issues.push(invalidIssue(key, raw, def));
        } else {
          values[key] = parsed;
        }
        continue;
      }

      if (!def) {
        const legacy = legacyLookup.get(key);
        if (legacy) {
          if (Object.prototype.hasOwnProperty.call(rawValues, legacy.newKey)) {
            issues.push({ kind: "legacy-shadowed", legacy: key, newKey: legacy.newKey });
            continue;
          }
          const newDef = this.map.get(legacy.newKey)!;
          const parsed = newDef.parse(raw);
          if (parsed === undefined) {
            issues.push(invalidIssue(key, raw, newDef));
          } else {
            values[legacy.newKey] = parsed;
          }
          continue;
        }
      }

      // Unknown or deprecated: pass the raw string through. validate() emits the issue.
      values[key] = raw;
    }

    return { values, issues };
  }

  /**
   * Validate typed values (config.json, or the output of parse()). The shared-policy gate.
   *
   * Per key:
   *  - active known key → def.validate(value); won't validate → `invalid` issue.
   *  - deprecated key → loaded read-only (value validated and included so get()
   *    can read it) plus a benign `deprecated` issue; never `invalid`.
   *  - legacy name (new key absent) → translate; translator returns undefined → `legacy-untranslatable`.
   *  - legacy name (new key present) → `legacy-shadowed` issue.
   *  - unknown key → `unknown` issue.
   */
  validate(input: Record<string, unknown>): {
    values: Record<string, unknown>;
    issues: PersistedIssue[];
  } {
    const values: Record<string, unknown> = {};
    const issues: PersistedIssue[] = [];
    const legacyLookup = this.buildLegacyLookup();

    for (const [key, value] of Object.entries(input)) {
      const def = this.map.get(key);
      if (def) {
        if (def.deprecated) {
          // Load the value read-only (so get() can read it for migration), but
          // never fail: a stale/garbage value just stays unread (effective default).
          const validated = def.validate(value);
          if (validated !== undefined) values[key] = validated;
          issues.push({ kind: "deprecated", key });
          continue;
        }
        const validated = def.validate(value);
        if (validated === undefined) {
          issues.push(invalidIssue(key, value, def));
        } else {
          values[key] = validated;
        }
        continue;
      }

      const legacy = legacyLookup.get(key);
      if (legacy) {
        if (Object.prototype.hasOwnProperty.call(input, legacy.newKey)) {
          issues.push({ kind: "legacy-shadowed", legacy: key, newKey: legacy.newKey });
          continue;
        }
        const translated = legacy.translator(value);
        if (translated === undefined) {
          issues.push({ kind: "legacy-untranslatable", legacy: key, newKey: legacy.newKey, value });
          continue;
        }
        values[legacy.newKey] = translated;
        continue;
      }

      issues.push({ kind: "unknown", key });
    }

    return { values, issues };
  }

  /**
   * Convenience for the raw-string sources: parse() then validate() the result,
   * concatenating the issues from both passes. Used for env vars and CLI flags.
   */
  parseAndValidate(rawValues: Record<string, string>): {
    values: Record<string, unknown>;
    issues: PersistedIssue[];
  } {
    const parsed = this.parse(rawValues);
    const validated = this.validate(parsed.values);
    return { values: validated.values, issues: [...parsed.issues, ...validated.issues] };
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
