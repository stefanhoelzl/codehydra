/**
 * StateService - persisted application state (state.json).
 *
 * Sibling of Config, built on the same PersistedStore core, but for values the
 * *app* writes at runtime (not user-authored settings). Where Config resolves
 * many sources with precedence and loads synchronously before app.ready,
 * StateService is deliberately minimal: one JSON file in the data dir, loaded
 * asynchronously, no env/CLI overrides, no computed defaults.
 *
 * Modules register their own state keys here and read/write them through the
 * returned accessor exactly as they would a config key. The file is app-owned,
 * so load() is lenient: a missing file yields defaults, and an unreadable or
 * unrecognized entry is logged and skipped rather than thrown.
 *
 * @see PersistedStore for the shared register/accessor/persist machinery.
 * @see Config for the user-authored counterpart.
 */

import type {
  PersistedKeyDefinition,
  PersistedAccessor,
  DeprecatedPersistedAccessor,
} from "./store-definition";
import type { FileSystemBoundary } from "./filesystem";
import type { Path } from "../../utils/path/path";
import type { Logger } from "./logging-types";
import { PersistedStore } from "./persisted-store";
import { getErrorMessage, isEnoent } from "../../shared/error-utils";

// State keys never use build-dependent (computed) defaults, so the seed context
// is a constant — the values are app runtime state, not environment-derived.
const STATIC_DEFAULT_CONTEXT = { isDevelopment: false, isPackaged: false } as const;

// =============================================================================
// Interface
// =============================================================================

export interface StateService {
  /**
   * Register a state key and return a typed accessor. Must be called before
   * load(). State keys are never deprecated, but the deprecated overload is
   * kept for shape-parity with Config.
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

  /** Load state.json (async). Call once after all register() calls. */
  load(): Promise<void>;

  /**
   * Get the subset of effective values that differ from their defaults, with
   * each key's `redact` policy applied. Use this for any sink that leaves the
   * machine, e.g. bug reports.
   */
  getRedactedOverrides(): Record<string, unknown>;
}

// =============================================================================
// Dependency Interface
// =============================================================================

export interface StateServiceDeps {
  readonly statePath: Path;
  readonly fileSystem: FileSystemBoundary;
  readonly logger: Logger;
}

// =============================================================================
// Implementation
// =============================================================================

export class DefaultStateService implements StateService {
  private readonly store: PersistedStore;

  constructor(private readonly deps: StateServiceDeps) {
    this.store = new PersistedStore({
      filePath: deps.statePath,
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

  async load(): Promise<void> {
    this.store.beginLoad("StateService.load() has already been called");

    // Seed defaults first so accessors are populated even if the file is
    // missing or unreadable below.
    this.store.seedDefaults(STATIC_DEFAULT_CONTEXT);

    const { statePath, fileSystem, logger } = this.deps;

    let raw: string;
    try {
      raw = await fileSystem.readFile(statePath);
    } catch (error) {
      if (isEnoent(error)) {
        // No state file yet — defaults stand.
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Corrupt state.json: log and fall back to defaults. The next write will
      // back the file up to <file>.broken via PersistedStore.persistMutation.
      logger.warn("Invalid JSON in state.json; using defaults", {
        path: statePath.toString(),
        error: getErrorMessage(error),
      });
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const { values, issues } = this.store.validate(parsed as Record<string, unknown>);
    for (const issue of issues) {
      // App-owned file: never throw. Surface anything unexpected at debug.
      logger.debug("Ignoring unexpected state.json entry", { issue: JSON.stringify(issue) });
    }
    this.store.applyValues(values);
  }

  getRedactedOverrides(): Record<string, unknown> {
    return this.store.getRedactedOverrides();
  }
}
