/**
 * ConfigService - Plain service for application configuration.
 *
 * Replaces the intent-based config module with a simple register/get/set API.
 * Config is fully resolved before any hooks run:
 *   1. Modules call register() to declare their keys
 *   2. load() reads config.json (sync), env vars, CLI args, and merges
 *   3. Modules call get() to read values, set() to persist changes
 *
 * Precedence (highest wins): CLI flags > env vars > config.json > computed defaults > static defaults
 *
 * load() uses node:fs (readFileSync) directly because it must run before Electron app.ready,
 * and the FileSystemLayer interface is async-only. This is a documented exception.
 * set() uses the async FileSystemLayer for writes (all callers are post-ready).
 */

import { readFileSync } from "node:fs";
import type { ConfigKeyDefinition, ComputedDefaultContext } from "./config-definition";
import { ConfigValidationError } from "./config-definition";
import { envVarToConfigKey } from "./config-values";
import type { FileSystemLayer } from "../platform/filesystem";
import type { Path } from "../platform/path";
import type { Logger } from "../logging/types";

// =============================================================================
// Interface
// =============================================================================

export interface ConfigService {
  /** Register a config key definition. Must be called before load(). */
  register(key: string, definition: ConfigKeyDefinition<unknown>): void;

  /**
   * Load config from all sources and merge with precedence:
   * static defaults < computed defaults < config.json < env vars < CLI flags.
   *
   * Uses sync filesystem I/O. Call once after all register() calls.
   * Throws on validation errors or duplicate keys.
   */
  load(): void;

  /** Get the effective value for a registered config key. Throws if key is not registered. */
  get(key: string): unknown;

  /**
   * Set a value at runtime. Validates against the registered definition.
   * When persist is true (default), writes to config.json via FileSystemLayer.
   */
  set(key: string, value: unknown, options?: { persist?: boolean }): Promise<void>;

  /** Get the full definition map (for help text generation). */
  getDefinitions(): ReadonlyMap<string, ConfigKeyDefinition<unknown>>;

  /** Get all effective config values (for help text). */
  getEffective(): Readonly<Record<string, unknown>>;
}

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ConfigServiceDeps {
  readonly configPath: Path;
  readonly fileSystem: FileSystemLayer;
  readonly logger: Logger;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  /** Override sync file reader (for testing). Defaults to node:fs readFileSync. */
  readonly readFileSync?: (path: string) => string;
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

/**
 * Validate already-typed values (from config.json or set()).
 * Throws ConfigValidationError on unknown keys or invalid values.
 */
export function validateTyped(
  values: Record<string, unknown>,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  source: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    const def = definitions.get(key);
    if (!def) {
      throw new ConfigValidationError({
        key,
        value,
        reason: "unknown",
        source,
      });
    }

    const validated = def.validate(value);
    if (validated === undefined) {
      throw new ConfigValidationError({
        key,
        value,
        reason: "invalid",
        source,
        ...(def.description !== undefined && { description: def.description }),
        ...(def.validValues !== undefined && { validValues: def.validValues }),
      });
    }
    result[key] = validated;
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

/**
 * Parse a config.json object (flat kebab-case format) into typed config values.
 * Throws on unknown keys or invalid values.
 */
export function parseConfigFile(
  data: unknown,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
  if (typeof data !== "object" || data === null) return {};

  const obj = data as Record<string, unknown>;
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    values[key] = value;
  }

  return validateTyped(values, definitions, "config.json");
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

// =============================================================================
// Implementation
// =============================================================================

export class DefaultConfigService implements ConfigService {
  private readonly definitions = new Map<string, ConfigKeyDefinition<unknown>>();
  private readonly effective: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly deps: ConfigServiceDeps) {}

  register(key: string, definition: ConfigKeyDefinition<unknown>): void {
    if (this.loaded) {
      throw new Error(`Cannot register config key "${key}" after load()`);
    }
    if (this.definitions.has(key)) {
      throw new Error(`Duplicate config key definition: "${key}"`);
    }
    this.definitions.set(key, definition);
  }

  load(): void {
    if (this.loaded) {
      throw new Error("ConfigService.load() has already been called");
    }
    this.loaded = true;

    const { configPath, logger, isDevelopment, isPackaged, env, argv } = this.deps;
    const syncRead = this.deps.readFileSync ?? ((p: string) => readFileSync(p, "utf-8"));
    const computedDefaultCtx: ComputedDefaultContext = { isDevelopment, isPackaged };

    // 1. Build defaults (static + computed)
    const defaults = buildDefaults(this.definitions, computedDefaultCtx);

    // 2. Read config.json from disk (sync)
    let fileValues: Record<string, unknown> = {};
    try {
      const content = syncRead(configPath.toNative());
      const parsed = JSON.parse(content) as unknown;
      fileValues = parseConfigFile(parsed, this.definitions);
      logger.debug("Config loaded from disk", { path: configPath.toString() });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw error;
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        logger.debug("Config not found, using defaults", { path: configPath.toString() });
      } else {
        logger.warn("Config load failed, using defaults", {
          path: configPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
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
  }

  get(key: string): unknown {
    if (!this.definitions.has(key)) {
      throw new Error(`Unknown config key: "${key}"`);
    }
    return this.effective[key];
  }

  async set(key: string, value: unknown, options?: { persist?: boolean }): Promise<void> {
    const def = this.definitions.get(key);
    if (!def) {
      throw new ConfigValidationError({
        key,
        value,
        reason: "unknown",
        source: "set",
      });
    }

    // Validate
    if (value !== null) {
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
    } else {
      // null means revert to default
      this.effective[key] = value;
    }

    const persist = options?.persist !== false;
    if (persist) {
      const { configPath, fileSystem, logger } = this.deps;

      // Read-modify-write config file
      let fileContent: Record<string, unknown> = {};
      try {
        const raw = await fileSystem.readFile(configPath);
        fileContent = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* file doesn't exist yet — start fresh */
      }

      if (value === null) {
        delete fileContent[key];
      } else {
        fileContent[key] = this.effective[key];
      }

      await fileSystem.mkdir(configPath.dirname);
      await fileSystem.writeFile(configPath, JSON.stringify(fileContent, null, 2));
      logger.debug("Config persisted", { path: configPath.toString() });
    }
  }

  getDefinitions(): ReadonlyMap<string, ConfigKeyDefinition<unknown>> {
    return this.definitions;
  }

  getEffective(): Readonly<Record<string, unknown>> {
    return this.effective;
  }
}
