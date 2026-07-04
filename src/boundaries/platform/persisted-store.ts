/**
 * PersistedStore - generic typed key-value store backed by a single JSON file.
 *
 * Extracted from DefaultConfig: owns the definition registry, the effective and
 * default value maps, the typed accessor (get/set/reset/isDefault), and the
 * read-modify-write persistence to one JSON file via FileSystemBoundary.
 *
 * Two services compose it (composition, not inheritance):
 *   - Config layers multi-source resolution on top (env/CLI parse, precedence
 *     merge, sync pre-ready load, unknown-key stripping, help text).
 *   - StateService layers a trivial async single-file load on top.
 *
 * The store is source-agnostic. A composing service drives load in three steps:
 *   1. beginLoad()              - guard against double-load, lock registration
 *   2. seedDefaults(ctx)        - seed effective + defaults from definitions
 *   3. applyValues(resolved)    - overlay the values it resolved from its sources
 * After load, accessors read the effective value and persist mutations back to
 * the store's file. validate()/parseAndValidate() expose the shared-policy gate
 * so composing services can run their own source values through it.
 */

import type {
  PersistedKeyDefinition,
  ComputedDefaultContext,
  PersistedAccessor,
  DeprecatedPersistedAccessor,
  PersistedIssue,
} from "./store-definition";
import { PersistedValidationError, PersistedDefinitions } from "./store-definition";
import type { FileSystemBoundary } from "./filesystem";
import { Path } from "../../utils/path/path";
import type { Logger } from "./logging-types";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface PersistedStoreDeps {
  /** The JSON file this store reads/writes (e.g. config.json or state.json). */
  readonly filePath: Path;
  readonly fileSystem: FileSystemBoundary;
  readonly logger: Logger;
}

// =============================================================================
// Constants
// =============================================================================

/** Token substituted for redacted values in getRedactedOverrides(). */
const REDACTED = "<redacted>";

// =============================================================================
// Defaults / Equality Helpers
// =============================================================================

/**
 * Build default values from definitions, applying computedDefault where available.
 */
function buildDefaults(
  definitions: ReadonlyMap<string, PersistedKeyDefinition<unknown>>,
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

export class PersistedStore {
  private readonly definitions = new PersistedDefinitions();
  private readonly effective: Record<string, unknown> = {};
  private readonly defaults: Record<string, unknown> = {};
  // Where each key's effective value came from. Seeded to "default" for every
  // key by seedDefaults(); the composing service overlays higher-precedence
  // sources via markSources(). set()/reset() keep it current at runtime. Read by
  // the settings UI to show a source badge (e.g. env/CLI-overridden keys).
  private readonly sources: Record<string, string> = {};
  private loaded = false;
  // Tail of the write queue. Every persistMutation() chains off this so writes
  // to the backing file run strictly one-at-a-time, even across owners that
  // share one file (e.g. state.json's telemetry/update/auto-workspace keys).
  // Without this, two concurrent read-modify-write cycles could interleave and
  // silently drop one update.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PersistedStoreDeps) {}

  /**
   * Register a config key definition and return an accessor for it. Must be
   * called before the composing service calls beginLoad(). Keys with
   * `deprecated: true` return a DeprecatedPersistedAccessor.
   *
   * This is the broad, single-signature entry point. The typed get/set
   * overloads live on the composing services (Config, StateService), which
   * delegate here — keeping the overload surface where module callers consume it.
   */
  register(
    key: string,
    definition: PersistedKeyDefinition<unknown>
  ): PersistedAccessor<unknown> | DeprecatedPersistedAccessor {
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
    this.definitions.add(key, definition);
    return definition.deprecated ? this.createDeprecatedAccessor(key) : this.createAccessor(key);
  }

  private createAccessor(key: string): PersistedAccessor<unknown> {
    // Arrow functions close over the PersistedStore `this` directly (no aliasing).
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

  private createDeprecatedAccessor(key: string): DeprecatedPersistedAccessor {
    return {
      name: key,
      // Readable: returns the loaded value (or its default if not present on disk).
      get: (): unknown => this.readValue(key),
      // Not settable — deprecated keys are read-only.
      set: (): never => {
        throw new PersistedValidationError({
          key,
          value: undefined,
          reason: "deprecated",
          source: "accessor",
        });
      },
      // Strips the key from the backing file (used after migrating its value away).
      reset: (options?: { persist?: boolean }): Promise<void> => this.resetValue(key, options),
    };
  }

  // ---------------------------------------------------------------------------
  // Load lifecycle (driven by the composing service)
  // ---------------------------------------------------------------------------

  /**
   * Lock registration and guard against a second load. Call once, first.
   * The composing service passes its own message so the error reads in its terms.
   */
  beginLoad(alreadyLoadedMessage = "PersistedStore load has already begun"): void {
    if (this.loaded) {
      throw new Error(alreadyLoadedMessage);
    }
    this.loaded = true;
  }

  /**
   * Seed effective + defaults from the registered definitions (static plus
   * computedDefault). Returns the defaults map so the caller can use it as the
   * base of a precedence merge.
   */
  seedDefaults(ctx: ComputedDefaultContext): Record<string, unknown> {
    const defaults = buildDefaults(this.definitions.asReadonlyMap(), ctx);
    for (const [key, value] of Object.entries(defaults)) {
      this.effective[key] = value;
      this.defaults[key] = value;
      this.sources[key] = "default";
    }
    return defaults;
  }

  /**
   * Mark a set of keys as sourced from `source` (e.g. "user", "env", "cli").
   * The composing service calls this in precedence order after seedDefaults() so
   * the last writer wins, matching the effective-value merge.
   */
  markSources(keys: Iterable<string>, source: string): void {
    for (const key of keys) {
      this.sources[key] = source;
    }
  }

  /** Where the key's effective value currently comes from (default if unseeded). */
  getSource(key: string): string {
    return this.sources[key] ?? "default";
  }

  /**
   * String-keyed set for callers that don't hold the typed accessor (the settings
   * dialog). Same validation/persistence as PersistedAccessor.set().
   */
  setValue(key: string, value: unknown, options?: { persist?: boolean }): Promise<void> {
    return this.writeValue(key, value, options);
  }

  /** String-keyed reset for callers that don't hold the typed accessor. */
  resetKey(key: string, options?: { persist?: boolean }): Promise<void> {
    return this.resetValue(key, options);
  }

  /** Overlay resolved values onto the effective map (highest-precedence last). */
  applyValues(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.effective[key] = value;
    }
  }

  /** Run typed values (e.g. parsed JSON) through the shared-policy validation gate. */
  validate(input: Record<string, unknown>): {
    values: Record<string, unknown>;
    issues: PersistedIssue[];
  } {
    return this.definitions.validate(input);
  }

  /** Tokenized string values (env/CLI) → typed, validated values. */
  parseAndValidate(rawValues: Record<string, string>): {
    values: Record<string, unknown>;
    issues: PersistedIssue[];
  } {
    return this.definitions.parseAndValidate(rawValues);
  }

  // ---------------------------------------------------------------------------
  // Accessor backing
  // ---------------------------------------------------------------------------

  /** Backs PersistedAccessor.get(). The accessor exists only for registered keys. */
  private readValue(key: string): unknown {
    return this.effective[key];
  }

  /** Backs PersistedAccessor.set(): validate, update effective, persist the value. */
  private async writeValue(
    key: string,
    value: unknown,
    options?: { persist?: boolean }
  ): Promise<void> {
    const def = this.definitions.get(key);
    if (!def) {
      throw new PersistedValidationError({ key, value, reason: "unknown", source: "set" });
    }

    const validated = def.validate(value);
    if (validated === undefined) {
      throw new PersistedValidationError({
        key,
        value,
        reason: "invalid",
        source: "set",
        ...(def.description !== undefined && { description: def.description }),
        ...(def.validValues !== undefined && { validValues: def.validValues }),
      });
    }
    this.effective[key] = validated;
    // A persisted write lands in config.json, i.e. becomes user-sourced — except
    // env/CLI overrides, which still win on the next load, so we keep that source
    // sticky so the settings UI keeps warning about the active override.
    if (options?.persist !== false && this.sources[key] !== "env" && this.sources[key] !== "cli") {
      this.sources[key] = "user";
    }

    if (options?.persist !== false) {
      await this.persistMutation((fileContent) => {
        fileContent[key] = validated;
      });
    }
  }

  /** Backs PersistedAccessor.reset(): revert to default, delete the key from disk. */
  private async resetValue(key: string, options?: { persist?: boolean }): Promise<void> {
    if (!this.definitions.has(key)) {
      throw new PersistedValidationError({
        key,
        value: undefined,
        reason: "unknown",
        source: "reset",
      });
    }
    this.effective[key] = this.defaults[key];
    // Deleting the key from config.json reverts it to the default source (env/CLI
    // overrides would re-apply on next load, but the in-memory value is now the
    // default, so report it as such).
    this.sources[key] = "default";

    if (options?.persist !== false) {
      await this.persistMutation((fileContent) => {
        delete fileContent[key];
      });
    }
  }

  /** Backs PersistedAccessor.isDefault(). */
  private isDefaultValue(key: string): boolean {
    return overrideEquals(this.effective[key], this.defaults[key]);
  }

  /**
   * Enqueue a read-modify-write so it runs after all earlier writes to this
   * file have settled. Serializing here is what makes a single file shared by
   * several owners safe: concurrent set()/reset() calls can no longer interleave
   * their read-modify-write cycles and lose an update. The returned promise
   * rejects to the caller on failure, while the chain itself advances through a
   * swallowed branch so one failed write neither poisons subsequent writes nor
   * surfaces as an unhandled rejection.
   */
  private persistMutation(mutator: (fileContent: Record<string, unknown>) => void): Promise<void> {
    const result = this.writeChain.then(() => this.runPersistMutation(mutator));
    this.writeChain = result.catch(() => {});
    return result;
  }

  /**
   * Read-modify-write the store's JSON file with the given mutator. Handles a
   * missing file (start fresh) and invalid JSON (back up to <file>.broken, then
   * write fresh — if the rename fails, throw rather than destroy the file).
   */
  private async runPersistMutation(
    mutator: (fileContent: Record<string, unknown>) => void
  ): Promise<void> {
    const { filePath, fileSystem, logger } = this.deps;

    let fileContent: Record<string, unknown> = {};
    let raw: string | null = null;
    try {
      raw = await fileSystem.readFile(filePath);
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
        const backupPath = new Path(filePath.dirname, `${filePath.basename}.broken`);
        await fileSystem.rename(filePath, backupPath);
        logger.warn(`Invalid JSON in ${filePath.basename}, backed up; writing fresh`, {
          path: filePath.toString(),
          backup: backupPath.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
        fileContent = {};
      }
    }

    mutator(fileContent);

    await fileSystem.mkdir(filePath.dirname);
    await fileSystem.writeFile(filePath, JSON.stringify(fileContent, null, 2));
    logger.debug("Store persisted", { path: filePath.toString() });
  }

  // ---------------------------------------------------------------------------
  // Read-only views
  // ---------------------------------------------------------------------------

  getDefinitions(): ReadonlyMap<string, PersistedKeyDefinition<unknown>> {
    return this.definitions.asReadonlyMap();
  }

  getEffective(): Readonly<Record<string, unknown>> {
    return this.effective;
  }

  getRedactedOverrides(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, def] of this.definitions) {
      if (def.deprecated) continue;
      if (overrideEquals(this.effective[key], this.defaults[key])) continue;
      out[key] = this.redactValue(def, this.effective[key]);
    }
    return out;
  }

  /**
   * Apply a definition's redaction policy to an effective value. `redact: true`
   * fully redacts; a redactor function gets the value plus the token and returns
   * a projection — if it throws, we fail closed to the token rather than leak
   * the raw value (this output feeds user-submitted bug reports). No `redact`
   * declared → the value passes through unchanged.
   */
  private redactValue(def: PersistedKeyDefinition<unknown>, value: unknown): unknown {
    if (def.redact === undefined) return value;
    if (def.redact === true) return REDACTED;
    try {
      return def.redact(value, REDACTED);
    } catch (error) {
      this.deps.logger.debug("redact() threw; falling back to redaction token", {
        error: error instanceof Error ? error.message : String(error),
      });
      return REDACTED;
    }
  }
}
