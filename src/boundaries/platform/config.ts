/**
 * Config - Plain service for application configuration.
 *
 * register() returns a typed PersistedAccessor for each key; reads and writes go
 * through that accessor (there is no string-keyed get/set on the service).
 * Config is fully resolved before any hooks run:
 *   1. Modules call register() to declare their keys and capture an accessor
 *   2. load() reads config.json (sync), env vars, CLI args, and merges
 *   3. Modules call accessor.get() to read, accessor.set()/reset() to persist
 *
 * Precedence (highest wins): CLI flags > env vars > config.json > computed defaults > static defaults
 *
 * Two input formats flow through one schema (PersistedDefinitions):
 *   - env vars / CLI flags are pure strings → tokenized here, then PersistedDefinitions.parse()
 *   - config.json is typed JSON → readConfigFile() reads it, then PersistedDefinitions.validate()
 * Both producers feed validate(), the shared-policy gate. parse(), validate(), and
 * readConfigFile() are pure: they return { values, issues } and never log or throw.
 * load() is the only place that interprets issues — logging the benign kinds and throwing
 * a PersistedValidationError on `invalid`.
 *
 * load() uses node:fs (readFileSync / writeFileSync / renameSync) directly because it must
 * run before Electron app.ready, and the FileSystemBoundary interface is async-only.
 * The sync write fires only when unknown (no-longer-registered) keys are stripped from
 * config.json on load; the sync rename fires only when config.json contains invalid JSON
 * and is moved aside to config.json.broken. This is a documented exception. accessor.set()
 * uses the async FileSystemBoundary for writes (all callers are post-ready).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  PersistedKeyDefinition,
  ComputedDefaultContext,
  PersistedAccessor,
  DeprecatedPersistedAccessor,
  PersistedIssue,
} from "./store-definition";
import { PersistedValidationError } from "./store-definition";
import type { FileSystemBoundary } from "./filesystem";
import { Path } from "../../utils/path/path";
import type { Logger } from "./logging-types";
import { PersistedStore } from "./persisted-store";

const BROKEN_CONFIG_FILENAME = "config.json.broken";

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 * Config-specific (not a generic store type), so it lives with the Config service.
 */
export type ConfigAgentType = "claude" | "opencode" | null;

// =============================================================================
// Name Derivation
// =============================================================================

/**
 * Convert an env var name to a config key (or undefined if not a CH_ var).
 * Rules: strip CH_, lowercase, __ → ., _ → -.
 *
 * Naming conventions:
 *   Config key / CLI flag: dot-separated, kebab-case  (e.g. "version.code-server")
 *   Env var:               CH_ prefix, . → __, - → _, UPPER  (e.g. CH_VERSION__CODE_SERVER)
 */
export function envVarToConfigKey(envVar: string): string | undefined {
  if (!envVar.startsWith("CH_")) return undefined;
  return envVar.slice(3).toLowerCase().replace(/__/g, ".").replace(/_/g, "-");
}

// =============================================================================
// Help Text
// =============================================================================

/**
 * Generate a human-readable config usage guide.
 *
 * `definitions` provides the set of registered config keys.
 * `defaults` should be the effective default values (accounting for
 * isDevelopment, isPackaged, etc.) so users see the actual defaults
 * that apply to their environment. Deprecated keys are omitted.
 */
export function generateHelpText(
  configFilePath: string,
  definitions: ReadonlyMap<string, PersistedKeyDefinition<unknown>>,
  defaults: Readonly<Record<string, unknown>>
): string {
  const lines: string[] = [
    "CodeHydra Configuration",
    "=======================",
    "",
    "Every key can be set three ways (highest precedence first):",
    "  CLI flag:   --<key>=<value>        e.g. --log.level=debug",
    "  Env var:    CH_ prefix, . → __, - → _, UPPER  e.g. CH_LOG__LEVEL=debug",
    "  Config file: " + configFilePath,
    "",
    "Keys:",
    "",
  ];

  for (const [key, def] of [...definitions].sort(([a], [b]) => a.localeCompare(b))) {
    if (def.deprecated) continue;
    const value = defaults[key];
    const valueStr = value === null || value === undefined ? "—" : String(value);

    let line = `  ${key.padEnd(38)} default: ${valueStr}`;
    if (def.validValues) {
      line += `  [${def.validValues}]`;
    }
    if (def.description) {
      line += `  — ${def.description}`;
    }
    lines.push(line);
  }

  lines.push("");
  return lines.join("\n");
}

// =============================================================================
// Interface
// =============================================================================

export interface Config {
  /**
   * Register a config key definition and return a typed accessor for it.
   * Must be called before load(). Keys with `deprecated: true` return a
   * DeprecatedPersistedAccessor whose get()/set() are typed `never`.
   */
  register<T>(
    key: string,
    definition: Omit<PersistedKeyDefinition<T>, "default"> & {
      default: NoInfer<T>;
      deprecated?: undefined;
    }
  ): PersistedAccessor<T>;
  register(
    key: string,
    definition: PersistedKeyDefinition<unknown> & { deprecated: true }
  ): DeprecatedPersistedAccessor;

  /**
   * Load config from all sources and merge with precedence:
   * static defaults < computed defaults < config.json < env vars < CLI flags.
   *
   * Uses sync filesystem I/O. Call once after all register() calls.
   * Throws PersistedValidationError on an invalid value for a known key.
   */
  load(): void;

  /** Get the full definition map (for help text generation). */
  getDefinitions(): ReadonlyMap<string, PersistedKeyDefinition<unknown>>;

  /** Get all effective config values (for help text). */
  getEffective(): Readonly<Record<string, unknown>>;

  /** Get the resolved defaults (static + computed) for all registered keys. */
  getDefaults(): Readonly<Record<string, unknown>>;

  /**
   * Get the subset of effective values that differ from their defaults,
   * with values for keys marked `sensitive: true` replaced by "<redacted>".
   */
  getOverrides(): Record<string, unknown>;

  /** Generate human-readable config help text. */
  getHelpText(): string;
}

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ConfigDeps {
  readonly configPath: Path;
  readonly fileSystem: FileSystemBoundary;
  readonly logger: Logger;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  /** Override sync file reader (for testing). Defaults to node:fs readFileSync. */
  readonly readFileSync?: (path: string) => string;
  /** Override sync file writer (for testing). Defaults to node:fs writeFileSync. */
  readonly writeFileSync?: (path: string, content: string) => void;
  /** Override sync file renamer (for testing). Defaults to node:fs renameSync. */
  readonly renameSync?: (oldPath: string, newPath: string) => void;
}

// =============================================================================
// Source Tokenizers
// =============================================================================

/**
 * Scan an env object for CH_* keys (not _CH_*), convert to config keys, and
 * collect their raw string values. Pure key extraction — no parsing, no validation.
 * The result feeds PersistedDefinitions.parse().
 */
export function parseEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  const rawValues: Record<string, string> = {};

  for (const [envKey, rawValue] of Object.entries(env)) {
    if (!envKey.startsWith("CH_") || envKey.startsWith("_CH_")) continue;
    if (rawValue === undefined) continue;

    const configKey = envVarToConfigKey(envKey);
    if (configKey === undefined) continue;

    rawValues[configKey] = rawValue;
  }

  return rawValues;
}

/**
 * Tokenize CLI args of the form --key=value or --key value (bare --flag → "true").
 * Pure tokenization — no parsing, no validation. Unrecognized flags (e.g. Electron's
 * --inspect) are collected too and surface as `unknown` issues from validate(), which
 * load() logs and ignores. The result feeds PersistedDefinitions.parse().
 */
export function parseCliArgs(argv: readonly string[]): Record<string, string> {
  const rawValues: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;

    let key: string;
    let value: string;

    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = "true";
      }
    }

    rawValues[key] = value;
  }

  return rawValues;
}

// =============================================================================
// Config File Reader
// =============================================================================

/**
 * Read and JSON-parse config.json (sync). Pure of logging — returns the parsed
 * object plus any issues for load() to log.
 *
 * Behavior:
 *  - missing or unreadable file → empty object (ENOENT is the common case).
 *  - invalid JSON → move the file aside to config.json.broken (read-recovery I/O)
 *    and return a `broken-json` issue. If the rename itself fails, it throws —
 *    silently discarding would destroy a broken-but-recoverable file.
 *  - non-object JSON (e.g. a bare number) → empty object.
 *
 * The returned `data` is the original parsed object (untransformed); load() passes
 * it to PersistedDefinitions.validate() and also uses it to compute the on-disk rewrite.
 */
export function readConfigFile(
  configPath: Path,
  syncRead: (path: string) => string,
  syncRename: (oldPath: string, newPath: string) => void
): { data: Record<string, unknown>; issues: PersistedIssue[] } {
  let content: string;
  try {
    content = syncRead(configPath.toNative());
  } catch {
    return { data: {}, issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const backupPath = new Path(configPath.dirname, BROKEN_CONFIG_FILENAME);
    syncRename(configPath.toNative(), backupPath.toNative());
    return {
      data: {},
      issues: [
        {
          kind: "broken-json",
          path: configPath.toString(),
          backup: backupPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { data: {}, issues: [] };
  }
  return { data: parsed as Record<string, unknown>, issues: [] };
}

// =============================================================================
// Implementation
// =============================================================================

export class DefaultConfig implements Config {
  /** Generic typed key-value store backed by config.json. */
  private readonly store: PersistedStore;

  constructor(private readonly deps: ConfigDeps) {
    this.store = new PersistedStore({
      filePath: deps.configPath,
      fileSystem: deps.fileSystem,
      logger: deps.logger,
    });
  }

  register<T>(
    key: string,
    definition: Omit<PersistedKeyDefinition<T>, "default"> & {
      default: NoInfer<T>;
      deprecated?: undefined;
    }
  ): PersistedAccessor<T>;
  register(
    key: string,
    definition: PersistedKeyDefinition<unknown> & { deprecated: true }
  ): DeprecatedPersistedAccessor;
  register(
    key: string,
    definition: PersistedKeyDefinition<unknown>
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor {
    return this.store.register(key, definition);
  }

  load(): void {
    const { configPath, isDevelopment, isPackaged, env, argv } = this.deps;
    const syncRead = this.deps.readFileSync ?? ((p: string) => readFileSync(p, "utf-8"));
    const syncRename = this.deps.renameSync ?? renameSync;
    const computedDefaultCtx: ComputedDefaultContext = { isDevelopment, isPackaged };

    // beginLoad guards double-load and locks registration.
    this.store.beginLoad("Config.load() has already been called");

    // 1. Build defaults (static + computed) and seed effective immediately
    //    so getHelpText()/getEffective() work even if we throw below.
    const defaults = this.store.seedDefaults(computedDefaultCtx);

    // 2. config.json: read (I/O) → validate (typed values).
    const file = readConfigFile(configPath, syncRead, syncRename);
    const fileResult = this.store.validate(file.data);

    // 3. env + CLI: tokenize → parse (strings → typed) → validate.
    const envResult = this.store.parseAndValidate(parseEnvVars(env));
    const cliResult = this.store.parseAndValidate(parseCliArgs(argv));

    // 4. Interpret issues per source (precedence order): log benign kinds, throw on invalid.
    this.reportIssues("config.json", [...file.issues, ...fileResult.issues]);
    this.reportIssues("env var", envResult.issues);
    this.reportIssues("CLI flag", cliResult.issues);

    // 5. Merge with precedence: defaults < file < env < CLI.
    this.store.applyValues({
      ...defaults,
      ...fileResult.values,
      ...envResult.values,
      ...cliResult.values,
    });

    // 6. If config.json contained unknown keys, rewrite it with those stripped
    //    (active, deprecated, and legacy entries are preserved).
    const unknownFileKeys = fileResult.issues.flatMap((issue) =>
      issue.kind === "unknown" ? [issue.key] : []
    );
    if (unknownFileKeys.length > 0) {
      const stripped = new Set(unknownFileKeys);
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(file.data)) {
        if (!stripped.has(key)) kept[key] = value;
      }
      const syncWrite =
        this.deps.writeFileSync ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));
      try {
        syncWrite(configPath.toNative(), JSON.stringify(kept, null, 2));
        this.deps.logger.debug("Config rewritten (unknown keys stripped)", {
          path: configPath.toString(),
        });
      } catch (error) {
        this.deps.logger.warn("Config rewrite failed", {
          path: configPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Interpret the issues from one source: log the benign kinds, and throw a
   * PersistedValidationError on the first `invalid` (which main.ts turns into exit(1)).
   * Benign issues are logged first so they surface even when an invalid follows.
   */
  private reportIssues(source: string, issues: PersistedIssue[]): void {
    const { logger } = this.deps;
    for (const issue of issues) {
      switch (issue.kind) {
        case "unknown":
          logger.warn("Unknown config key (ignored)", { source, key: issue.key });
          break;
        case "deprecated":
          logger.debug("Deprecated config key (read-only)", { source, key: issue.key });
          break;
        case "legacy-shadowed":
          logger.warn("Legacy config key shadowed by new key (ignored)", {
            source,
            legacy: issue.legacy,
            newKey: issue.newKey,
          });
          break;
        case "legacy-untranslatable":
          logger.warn("Legacy config key could not be translated (using default)", {
            source,
            legacy: issue.legacy,
            newKey: issue.newKey,
            value: JSON.stringify(issue.value),
          });
          break;
        case "broken-json":
          logger.warn(
            "Invalid JSON in config.json, backed up to config.json.broken; using defaults",
            { path: issue.path, backup: issue.backup, error: issue.error }
          );
          break;
        case "invalid":
          break;
      }
    }

    const invalid = issues.find(
      (i): i is Extract<PersistedIssue, { kind: "invalid" }> => i.kind === "invalid"
    );
    if (invalid) {
      throw new PersistedValidationError({
        key: invalid.key,
        value: invalid.value,
        reason: "invalid",
        source,
        ...(invalid.description !== undefined && { description: invalid.description }),
        ...(invalid.validValues !== undefined && { validValues: invalid.validValues }),
      });
    }
  }

  getDefinitions(): ReadonlyMap<string, PersistedKeyDefinition<unknown>> {
    return this.store.getDefinitions();
  }

  getEffective(): Readonly<Record<string, unknown>> {
    return this.store.getEffective();
  }

  getDefaults(): Readonly<Record<string, unknown>> {
    return this.store.getDefaults();
  }

  getOverrides(): Record<string, unknown> {
    return this.store.getOverrides();
  }

  getHelpText(): string {
    return generateHelpText(
      this.deps.configPath.toString(),
      this.store.getDefinitions(),
      this.store.getEffective()
    );
  }
}
