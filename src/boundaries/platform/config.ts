/**
 * Config - Plain service for application configuration.
 *
 * register() returns a typed ConfigAccessor for each key; reads and writes go
 * through that accessor (there is no string-keyed get/set on the service).
 * Config is fully resolved before any hooks run:
 *   1. Modules call register() to declare their keys and capture an accessor
 *   2. load() reads config.json (sync), env vars, CLI args, and merges
 *   3. Modules call accessor.get() to read, accessor.set()/reset() to persist
 *
 * Precedence (highest wins): CLI flags > env vars > config.json > computed defaults > static defaults
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
  ConfigKeyDefinition,
  ComputedDefaultContext,
  ConfigAccessor,
  DeprecatedConfigAccessor,
} from "./config-definition";
import { ConfigValidationError } from "./config-definition";
import type { FileSystemBoundary } from "./filesystem";
import { Path } from "../../utils/path/path";
import type { Logger } from "./logging-types";

const BROKEN_CONFIG_FILENAME = "config.json.broken";

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
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
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
   * DeprecatedConfigAccessor whose get()/set() are typed `never`.
   */
  register<T>(
    key: string,
    definition: Omit<ConfigKeyDefinition<T>, "default"> & {
      default: NoInfer<T>;
      deprecated?: undefined;
    }
  ): ConfigAccessor<T>;
  register(
    key: string,
    definition: ConfigKeyDefinition<unknown> & { deprecated: true }
  ): DeprecatedConfigAccessor;

  /**
   * Load config from all sources and merge with precedence:
   * static defaults < computed defaults < config.json < env vars < CLI flags.
   *
   * Uses sync filesystem I/O. Call once after all register() calls.
   * Throws on validation errors or duplicate keys.
   */
  load(): void;

  /** Get the full definition map (for help text generation). */
  getDefinitions(): ReadonlyMap<string, ConfigKeyDefinition<unknown>>;

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
// Validation Helpers
// =============================================================================

/**
 * Validate and parse raw string values (from env vars or CLI flags).
 * Throws ConfigValidationError on unknown keys or invalid values.
 */
export function validateAndParse(
  rawValues: Record<string, string>,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  source: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(rawValues)) {
    const def = definitions.get(key);
    if (!def) {
      throw new ConfigValidationError({
        key,
        value: rawValue,
        reason: "unknown",
        source,
      });
    }

    const parsed = def.parse(rawValue);
    if (parsed === undefined) {
      throw new ConfigValidationError({
        key,
        value: rawValue,
        reason: "invalid",
        source,
        ...(def.description !== undefined && { description: def.description }),
        ...(def.validValues !== undefined && { validValues: def.validValues }),
      });
    }
    result[key] = parsed;
  }

  return result;
}

// =============================================================================
// Source Parsers
// =============================================================================

/**
 * Scan an env object for CH_* keys (not _CH_*), convert to config keys,
 * collect as raw string values for validation.
 */
export function parseEnvVars(
  env: Record<string, string | undefined>,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
  const rawValues: Record<string, string> = {};

  for (const [envKey, rawValue] of Object.entries(env)) {
    if (!envKey.startsWith("CH_") || envKey.startsWith("_CH_")) continue;
    if (rawValue === undefined) continue;

    const configKey = envVarToConfigKey(envKey);
    if (configKey === undefined) continue;

    rawValues[configKey] = rawValue;
  }

  return validateAndParse(rawValues, definitions, "env var");
}

/**
 * Parse CLI args in the form --key=value or --key value.
 * Unknown flags (e.g. Electron's --inspect) are skipped with a warning.
 */
export function parseCliArgs(
  argv: readonly string[],
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  logger: Logger
): Record<string, unknown> {
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

    if (!definitions.has(key)) {
      logger.warn("Unknown CLI flag (ignored)", { flag: key });
      continue;
    }

    rawValues[key] = value;
  }

  return validateAndParse(rawValues, definitions, "CLI flag");
}

export interface ParseConfigFileResult {
  /** Typed values to merge into the effective config (file precedence layer). */
  readonly values: Record<string, unknown>;
  /**
   * Subset of original file entries to keep on disk. Non-null only when at least
   * one unknown key was stripped; null means no rewrite needed.
   */
  readonly rewrite: Record<string, unknown> | null;
}

/**
 * Parse a config.json object (flat kebab-case format) into typed config values.
 *
 * Per-key behavior:
 *  - Active registered key: validated; throws ConfigValidationError on invalid value.
 *  - Deprecated registered key: entry preserved on disk, value ignored, debug-logged.
 *  - Legacy name (matches some def's `legacyNames`): translated to the new key's value.
 *    If the new key is also present, the new value wins and the legacy is ignored.
 *    If the translator returns undefined, the value is dropped (default applies).
 *    Legacy entries are preserved on disk.
 *  - Unknown key: warn-logged and stripped (triggers a rewrite).
 */
export function parseConfigFile(
  data: unknown,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  logger: Logger
): ParseConfigFileResult {
  if (typeof data !== "object" || data === null) {
    return { values: {}, rewrite: null };
  }

  const obj = data as Record<string, unknown>;

  // Build legacy lookup: legacyName -> { newKey, translator }.
  // Map.set overwrite gives last-writer-wins on collision (the register-time
  // warning has already alerted the developer).
  const legacyLookup = new Map<string, { newKey: string; translator: (v: unknown) => unknown }>();
  for (const [newKey, def] of definitions) {
    if (!def.legacyNames) continue;
    for (const [legacyName, translator] of Object.entries(def.legacyNames)) {
      legacyLookup.set(legacyName, { newKey, translator });
    }
  }

  const values: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  let stripped = false;

  for (const [key, value] of Object.entries(obj)) {
    const def = definitions.get(key);
    if (def) {
      kept[key] = value;
      if (def.deprecated) {
        logger.debug("Deprecated config key in config.json (ignored)", { key });
        continue;
      }
      const validated = def.validate(value);
      if (validated === undefined) {
        throw new ConfigValidationError({
          key,
          value,
          reason: "invalid",
          source: "config.json",
          ...(def.description !== undefined && { description: def.description }),
          ...(def.validValues !== undefined && { validValues: def.validValues }),
        });
      }
      values[key] = validated;
      continue;
    }

    const legacy = legacyLookup.get(key);
    if (legacy) {
      kept[key] = value;
      if (Object.prototype.hasOwnProperty.call(obj, legacy.newKey)) {
        logger.warn("Legacy config key shadowed by new key (legacy ignored)", {
          legacy: key,
          newKey: legacy.newKey,
        });
        continue;
      }
      const translated = legacy.translator(value);
      if (translated === undefined) {
        logger.warn("Legacy config key could not be translated (using default)", {
          legacy: key,
          newKey: legacy.newKey,
          value: JSON.stringify(value),
        });
        continue;
      }
      values[legacy.newKey] = translated;
      continue;
    }

    logger.warn("Unknown config key in config.json (stripped)", { key });
    stripped = true;
  }

  return { values, rewrite: stripped ? kept : null };
}

/**
 * Build default values from definitions, applying computedDefault where available.
 */
export function buildDefaults(
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  ctx: ComputedDefaultContext
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of definitions) {
    defaults[key] = def.default;
    if (def.computedDefault) {
      const computed = def.computedDefault(ctx);
      if (computed !== undefined) {
        defaults[key] = computed;
      }
    }
  }
  return defaults;
}

function overrideEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// =============================================================================
// Implementation
// =============================================================================

export class DefaultConfig implements Config {
  private readonly definitions = new Map<string, ConfigKeyDefinition<unknown>>();
  private readonly effective: Record<string, unknown> = {};
  private readonly defaults: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly deps: ConfigDeps) {}

  register<T>(
    key: string,
    definition: Omit<ConfigKeyDefinition<T>, "default"> & {
      default: NoInfer<T>;
      deprecated?: undefined;
    }
  ): ConfigAccessor<T>;
  register(
    key: string,
    definition: ConfigKeyDefinition<unknown> & { deprecated: true }
  ): DeprecatedConfigAccessor;
  register(
    key: string,
    definition: ConfigKeyDefinition<unknown>
  ): ConfigAccessor<unknown> | DeprecatedConfigAccessor {
    if (this.loaded) {
      throw new Error(`Cannot register config key "${key}" after load()`);
    }
    if (this.definitions.has(key)) {
      throw new Error(`Duplicate config key definition: "${key}"`);
    }
    if (definition.legacyNames) {
      for (const legacyName of Object.keys(definition.legacyNames)) {
        for (const [otherKey, otherDef] of this.definitions) {
          if (otherDef.legacyNames && legacyName in otherDef.legacyNames) {
            this.deps.logger.warn("Legacy config name collision (last writer wins)", {
              legacy: legacyName,
              previousOwner: otherKey,
              newOwner: key,
            });
          }
        }
      }
    }
    this.definitions.set(key, definition);
    return definition.deprecated ? this.createDeprecatedAccessor(key) : this.createAccessor(key);
  }

  private createAccessor(key: string): ConfigAccessor<unknown> {
    // Arrow functions close over the DefaultConfig `this` directly (no aliasing).
    const readDefault = (): unknown => this.defaults[key];
    return {
      name: key,
      get default(): unknown {
        return readDefault();
      },
      get: (): unknown => this.readValue(key),
      set: (value: unknown, options?: { persist?: boolean }): Promise<void> =>
        this.writeValue(key, value, options),
      reset: (options?: { persist?: boolean }): Promise<void> => this.resetValue(key, options),
      isDefault: (): boolean => this.isDefaultValue(key),
    };
  }

  private createDeprecatedAccessor(key: string): DeprecatedConfigAccessor {
    const throwDeprecated = (): never => {
      throw new ConfigValidationError({
        key,
        value: undefined,
        reason: "deprecated",
        source: "accessor",
      });
    };
    return {
      name: key,
      get: throwDeprecated,
      set: throwDeprecated,
    };
  }

  load(): void {
    if (this.loaded) {
      throw new Error("Config.load() has already been called");
    }
    this.loaded = true;

    const { configPath, logger, isDevelopment, isPackaged, env, argv } = this.deps;
    const syncRead = this.deps.readFileSync ?? ((p: string) => readFileSync(p, "utf-8"));
    const computedDefaultCtx: ComputedDefaultContext = { isDevelopment, isPackaged };

    // 1. Build defaults (static + computed) and seed effective immediately
    //    so getHelpText()/getEffective() work even if parsing throws below
    const defaults = buildDefaults(this.definitions, computedDefaultCtx);
    for (const [key, value] of Object.entries(defaults)) {
      this.effective[key] = value;
      this.defaults[key] = value;
    }

    // 2. Read config.json from disk (sync)
    let fileValues: Record<string, unknown> = {};
    let rewrite: Record<string, unknown> | null = null;
    let content: string | null = null;
    try {
      content = syncRead(configPath.toNative());
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        logger.debug("Config not found, using defaults", { path: configPath.toString() });
      } else {
        logger.warn("Config load failed, using defaults", {
          path: configPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (content !== null) {
      let parsed: unknown = null;
      let parseOk = false;
      try {
        parsed = JSON.parse(content);
        parseOk = true;
      } catch (error) {
        // Invalid JSON: move config.json aside so the user can recover it,
        // then proceed with defaults. If the rename itself fails, throw —
        // silently writing fresh would destroy the broken-but-recoverable file.
        const backupPath = new Path(configPath.dirname, BROKEN_CONFIG_FILENAME);
        const syncRen = this.deps.renameSync ?? renameSync;
        syncRen(configPath.toNative(), backupPath.toNative());
        logger.warn(
          "Invalid JSON in config.json, backed up to config.json.broken; using defaults",
          {
            path: configPath.toString(),
            backup: backupPath.toString(),
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
      if (parseOk) {
        const result = parseConfigFile(parsed, this.definitions, logger);
        fileValues = result.values;
        rewrite = result.rewrite;
        logger.debug("Config loaded from disk", { path: configPath.toString() });
      }
    }

    // 3. Parse env vars and CLI args
    const envValues = parseEnvVars(env, this.definitions);
    const cliValues = parseCliArgs(argv, this.definitions, logger);

    // 4. Merge with precedence: defaults < file < env < CLI
    const merged = {
      ...defaults,
      ...fileValues,
      ...envValues,
      ...cliValues,
    };

    for (const [key, value] of Object.entries(merged)) {
      this.effective[key] = value;
    }

    // 5. If unknown keys were stripped, rewrite config.json (sync).
    if (rewrite !== null) {
      const syncWrite =
        this.deps.writeFileSync ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));
      try {
        syncWrite(configPath.toNative(), JSON.stringify(rewrite, null, 2));
        logger.debug("Config rewritten (unknown keys stripped)", {
          path: configPath.toString(),
        });
      } catch (error) {
        logger.warn("Config rewrite failed", {
          path: configPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Backs ConfigAccessor.get(). The accessor exists only for registered keys. */
  private readValue(key: string): unknown {
    return this.effective[key];
  }

  /** Backs ConfigAccessor.set(): validate, update effective, persist the value. */
  private async writeValue(
    key: string,
    value: unknown,
    options?: { persist?: boolean }
  ): Promise<void> {
    const def = this.definitions.get(key);
    if (!def) {
      throw new ConfigValidationError({ key, value, reason: "unknown", source: "set" });
    }

    const validated = def.validate(value);
    if (validated === undefined) {
      throw new ConfigValidationError({
        key,
        value,
        reason: "invalid",
        source: "set",
        ...(def.description !== undefined && { description: def.description }),
        ...(def.validValues !== undefined && { validValues: def.validValues }),
      });
    }
    this.effective[key] = validated;

    if (options?.persist !== false) {
      await this.persistMutation((fileContent) => {
        fileContent[key] = validated;
      });
    }
  }

  /** Backs ConfigAccessor.reset(): revert to default, delete the key from disk. */
  private async resetValue(key: string, options?: { persist?: boolean }): Promise<void> {
    if (!this.definitions.has(key)) {
      throw new ConfigValidationError({
        key,
        value: undefined,
        reason: "unknown",
        source: "reset",
      });
    }
    this.effective[key] = this.defaults[key];

    if (options?.persist !== false) {
      await this.persistMutation((fileContent) => {
        delete fileContent[key];
      });
    }
  }

  /** Backs ConfigAccessor.isDefault(). */
  private isDefaultValue(key: string): boolean {
    return overrideEquals(this.effective[key], this.defaults[key]);
  }

  /**
   * Read-modify-write config.json with the given mutator. Handles a missing
   * file (start fresh) and invalid JSON (back up to config.json.broken, then
   * write fresh — if the rename fails, throw rather than destroy the file).
   */
  private async persistMutation(
    mutator: (fileContent: Record<string, unknown>) => void
  ): Promise<void> {
    const { configPath, fileSystem, logger } = this.deps;

    let fileContent: Record<string, unknown> = {};
    let raw: string | null = null;
    try {
      raw = await fileSystem.readFile(configPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // File doesn't exist yet — start fresh.
      } else {
        throw error;
      }
    }
    if (raw !== null) {
      try {
        fileContent = JSON.parse(raw) as Record<string, unknown>;
      } catch (error) {
        const backupPath = new Path(configPath.dirname, BROKEN_CONFIG_FILENAME);
        await fileSystem.rename(configPath, backupPath);
        logger.warn("Invalid JSON in config.json, backed up to config.json.broken; writing fresh", {
          path: configPath.toString(),
          backup: backupPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
        fileContent = {};
      }
    }

    mutator(fileContent);

    await fileSystem.mkdir(configPath.dirname);
    await fileSystem.writeFile(configPath, JSON.stringify(fileContent, null, 2));
    logger.debug("Config persisted", { path: configPath.toString() });
  }

  getDefinitions(): ReadonlyMap<string, ConfigKeyDefinition<unknown>> {
    return this.definitions;
  }

  getEffective(): Readonly<Record<string, unknown>> {
    return this.effective;
  }

  getDefaults(): Readonly<Record<string, unknown>> {
    return this.defaults;
  }

  getOverrides(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, def] of this.definitions) {
      if (def.deprecated) continue;
      if (overrideEquals(this.effective[key], this.defaults[key])) continue;
      out[key] = def.sensitive === true ? "<redacted>" : this.effective[key];
    }
    return out;
  }

  getHelpText(): string {
    return generateHelpText(this.deps.configPath.toString(), this.definitions, this.effective);
  }
}
