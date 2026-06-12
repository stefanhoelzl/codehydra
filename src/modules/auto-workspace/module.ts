/**
 * AutoWorkspaceModule - Unified orchestrator for auto-workspace sources.
 *
 * Polls external systems (via pluggable AutoWorkspaceSource implementations)
 * and automatically creates/deletes workspaces to match.
 *
 * Each source is activated independently when its config is fully set.
 * A source needs both a template-path and source.isConfigured() to be active.
 *
 * Hooks:
 * - app:start -> "start": read template paths from config
 * - app:shutdown -> "stop": clear poll timer, dispose sources
 *
 * Events:
 * - app:started: initialize active sources, load state, run initial poll, start timer
 * - workspace:deleted: clean up state entry
 * - workspace:delete-failed: clear tracking metadata, set red tag
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { DomainEvent } from "../../intents/lib/types";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../../intents/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
} from "../../intents/get-project-bases";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../intents/open-project";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import type { Config } from "../../boundaries/platform/config";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import {
  storePath,
  storeCustom,
  type PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import type { StateService } from "../../boundaries/platform/state-service";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { AgentSpec } from "../../shared/api/types";
import { getErrorMessage } from "../../shared/error-utils";
import { renderTemplate } from "../../utils/liquid/liquid-renderer";
import { parseTemplateOutput } from "./template";
import { Path } from "../../utils/path/path";
import type { AutoWorkspaceSource, PollItem, PollResult } from "./source";

// =============================================================================
// State Types
// =============================================================================

interface StateEntry {
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly createdAt: string;
}

/**
 * Persisted tracking map: `${source}/${itemKey}` -> live workspace entry, or
 * `null` for a dismissed item (don't re-create). Stored as the single
 * `auto-workspaces` key in state.json.
 */
type AutoWorkspaceEntries = Record<string, StateEntry | null>;

function isStateEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.workspacePath === "string" &&
    typeof o.workspaceName === "string" &&
    typeof o.createdAt === "string"
  );
}

/**
 * Validate an unknown value as an entries map, dropping malformed entries
 * (best-effort: one corrupt entry must not wipe all tracking). Returns
 * undefined only when the value isn't a plain object.
 */
function validateEntries(value: unknown): AutoWorkspaceEntries | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: AutoWorkspaceEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      out[key] = null;
    } else if (isStateEntry(entry)) {
      out[key] = {
        workspacePath: entry.workspacePath,
        workspaceName: entry.workspaceName,
        createdAt: entry.createdAt,
      };
    }
    // else: drop the malformed entry
  }
  return out;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Redaction projection for the `auto-workspaces` state key (see the `redact`
 * field on its definition). Scrubs only `workspacePath` — it leaks the user's
 * home dir and on-disk layout — while keeping the map keys, `workspaceName`,
 * `createdAt`, and null/active state so a bug report still shows what is
 * tracked and in what state. Exported for focused testing.
 */
export function redactAutoWorkspaceEntries(
  entries: AutoWorkspaceEntries,
  redacted: string
): Record<string, (Omit<StateEntry, "workspacePath"> & { workspacePath: string }) | null> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [
      key,
      entry === null ? null : { ...entry, workspacePath: redacted },
    ])
  );
}

// =============================================================================
// Constants
// =============================================================================

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const METADATA_SOURCE_KEY = "source";
const METADATA_URL_KEY = "url";
const METADATA_TRACKED_KEY = "auto-workspace.tracked";
const TAG_DELETION_FAILED_KEY = "tags.deletion-failed";
const TAG_DELETION_FAILED_VALUE = JSON.stringify({ color: "#e74c3c" });

// =============================================================================
// Module Dependencies
// =============================================================================

export interface AutoWorkspaceModuleDeps {
  readonly fs: Pick<FileSystemBoundary, "readFile" | "rm">;
  readonly logger: Logger;
  /**
   * Path of the pre-state.json `auto-workspaces.json`. Read once on first launch
   * to import its entries into state.json, then deleted. Kept only for that
   * one-shot migration.
   */
  readonly legacyStateFilePath: string;
  readonly dispatcher: Dispatcher;
  readonly sources: readonly AutoWorkspaceSource[];
  readonly configService: Config;
  readonly stateService: StateService;
}

// =============================================================================
// Helpers
// =============================================================================

function stateKey(sourceName: string, itemKey: string): string {
  return `${sourceName}/${itemKey}`;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createAutoWorkspaceModule(deps: AutoWorkspaceModuleDeps): IntentModule {
  // Register template-path config keys (sources register their own keys)
  const templatePathConfigs = new Map<string, PersistedAccessor<string | null>>();
  for (const source of deps.sources) {
    const tplConfig = deps.configService.register(`experimental.${source.name}.template-path`, {
      default: null,
      description: `Path to Liquid template for ${source.name} auto-workspaces`,
      redact: true,
      ...storePath({ nullable: true }),
    });
    templatePathConfigs.set(source.name, tplConfig);
  }

  // Persisted tracking map, owned in state.json under the `auto-workspaces` key.
  const stateAccessor = deps.stateService.register("auto-workspaces", {
    default: {} as AutoWorkspaceEntries,
    description: "Auto-workspace tracking entries (app-managed)",
    redact: redactAutoWorkspaceEntries,
    ...storeCustom<AutoWorkspaceEntries>({
      parse: (raw) => validateEntries(safeJsonParse(raw)),
      validate: validateEntries,
    }),
  });

  let entries: AutoWorkspaceEntries = {};
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Per-source activation state
  const templatePaths = new Map<string, string | null>(); // sourceName → template path
  const activeSources = new Set<string>(); // currently polling source names
  const deletingKeys = new Set<string>(); // sentinel for auto-deletions

  // ------ State Persistence ------

  // This module is the sole in-process owner of the entries map, so it writes
  // the whole value rather than read-modify-writing it. Cross-key safety (the
  // shared state.json) comes from PersistedStore serializing its writes.
  async function persist(): Promise<void> {
    try {
      await stateAccessor.set(entries);
    } catch (error) {
      deps.logger.warn("Failed to save auto-workspace state", { error: getErrorMessage(error) });
    }
  }

  /**
   * One-shot import of the pre-state.json `auto-workspaces.json` file. Runs once
   * on first launch after upgrade: if state.json has no entries yet and the old
   * file exists, import its `entries` and delete it. Guarding on isDefault()
   * (not file-existence) makes a lingering file harmless — once the key is
   * populated, it wins. Best-effort: failures retry next launch.
   */
  async function migrateLegacyStateFile(): Promise<void> {
    if (!stateAccessor.isDefault()) return;

    let raw: string;
    try {
      raw = await deps.fs.readFile(deps.legacyStateFilePath);
    } catch {
      return; // no legacy file — nothing to migrate
    }

    // Old shape was { version, entries }; tolerate a bare map too.
    const parsed = safeJsonParse(raw);
    const entriesValue =
      typeof parsed === "object" && parsed !== null && "entries" in parsed
        ? (parsed as { entries: unknown }).entries
        : parsed;
    const migrated = validateEntries(entriesValue);

    if (migrated && Object.keys(migrated).length > 0) {
      try {
        await stateAccessor.set(migrated);
        deps.logger.info("Migrated auto-workspaces.json into state.json", {
          count: Object.keys(migrated).length,
        });
      } catch (error) {
        // Leave the legacy file in place so the migration retries next launch.
        deps.logger.warn("Failed to migrate auto-workspaces.json into state.json", {
          error: getErrorMessage(error),
        });
        return;
      }
    }

    // Best-effort cleanup of the superseded file (imported or empty/unusable).
    await deps.fs.rm(deps.legacyStateFilePath, { force: true }).catch(() => {});
  }

  // ------ Tracked Paths (metadata-based) ------

  async function buildTrackedPaths(): Promise<Set<string>> {
    const projects = await deps.dispatcher.dispatch({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    } as ListProjectsIntent);

    const tracked = new Set<string>();
    for (const project of projects) {
      for (const workspace of project.workspaces) {
        if (workspace.metadata[METADATA_TRACKED_KEY]) {
          tracked.add(workspace.path);
        }
      }
    }
    return tracked;
  }

  // ------ Workspace Lifecycle ------

  async function createWorkspace(source: AutoWorkspaceSource, item: PollItem): Promise<void> {
    const key = stateKey(source.name, item.key);
    const tplPath = templatePaths.get(source.name);
    deps.logger.info("Creating auto-workspace", { source: source.name, key });

    try {
      const templateContent = await deps.fs.readFile(tplPath!);
      const rendered = renderTemplate(templateContent, item.data);
      const { config, warnings } = parseTemplateOutput(rendered);

      for (const warning of warnings) {
        deps.logger.warn("Template front-matter warning", {
          warning,
          templatePath: tplPath ?? null,
        });
      }

      // Empty prompt → dismiss
      if (!config.prompt.trim()) {
        deps.logger.info("Skipping auto-workspace (template resolved to empty)", { key });
        entries = { ...entries, [key]: null };
        return;
      }

      // Determine project source: "project" wins over "git"
      let projectPayload: OpenProjectIntent["payload"] | null = null;
      if (config.project) {
        projectPayload = { path: new Path(config.project) };
      } else if (config.git) {
        projectPayload = { git: config.git };
      }

      // No project source → dismiss
      if (!projectPayload) {
        deps.logger.info("Skipping auto-workspace (no project/git in template)", { key });
        entries = { ...entries, [key]: null };
        return;
      }

      // No name → dismiss with warning
      if (!config.name) {
        deps.logger.warn("Skipping auto-workspace (no name in template)", { key });
        entries = { ...entries, [key]: null };
        return;
      }

      // Open the project
      const project = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: projectPayload,
      } as OpenProjectIntent);

      if (!project) {
        deps.logger.warn("project:open returned null for auto-workspace", { key });
        return;
      }

      // Fetch latest remote state before creating workspace
      try {
        await deps.dispatcher.dispatch({
          type: INTENT_GET_PROJECT_BASES,
          payload: { projectPath: project.path, refresh: true, wait: true },
        } as GetProjectBasesIntent);
      } catch (error) {
        deps.logger.warn("Failed to fetch bases before auto-create (will retry next poll)", {
          key,
          error: getErrorMessage(error),
        });
        return;
      }

      // The template's `agent.*` front-matter (parsed into config.agent) carries
      // the backend + launch config. With none set, fall back to a prompt-only
      // "default" arm so the resolved-default backend runs the body.
      const agent: AgentSpec = config.agent ?? {
        type: "default",
        ...(config.prompt !== "" && { prompt: config.prompt }),
      };

      // Create the workspace
      const wsResult = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: config.name,
          ...(config.base !== undefined && { base: config.base }),
          ...(config.tracking !== undefined && { tracking: config.tracking }),
          stealFocus: config.focus ?? false,
          projectPath: project.path,
          agent,
          source: "auto-workspace",
        },
      } as OpenWorkspaceIntent);

      const workspacePath = wsResult.path;

      // Set metadata
      const autoMetadata: Record<string, string> = {
        [METADATA_SOURCE_KEY]: source.name,
        [METADATA_URL_KEY]: item.url,
        [METADATA_TRACKED_KEY]: "true",
      };
      const allMetadata = { ...autoMetadata, ...(config.metadata ?? {}) };

      for (const [metaKey, value] of Object.entries(allMetadata)) {
        try {
          await deps.dispatcher.dispatch({
            type: INTENT_SET_METADATA,
            payload: { workspacePath, key: metaKey, value },
          } as SetMetadataIntent);
        } catch (error) {
          deps.logger.warn("Failed to set workspace metadata", {
            key: metaKey,
            stateKey: key,
            error: getErrorMessage(error),
          });
        }
      }

      // Record in state
      entries = {
        ...entries,
        [key]: {
          workspacePath,
          workspaceName: config.name,
          createdAt: new Date().toISOString(),
        },
      };

      deps.logger.info("Auto-workspace created", {
        source: source.name,
        key,
        workspaceName: config.name,
      });
    } catch (error) {
      deps.logger.warn("Failed to create auto-workspace", {
        key,
        error: getErrorMessage(error),
      });
      // Dismiss to avoid re-evaluation every poll cycle
      entries = { ...entries, [key]: null };
    }
  }

  async function deleteWorkspace(
    source: AutoWorkspaceSource,
    key: string,
    entry: StateEntry
  ): Promise<void> {
    deps.logger.info("Deleting auto-workspace (item disappeared)", {
      key,
      workspaceName: entry.workspaceName,
    });

    if (source.fetchBasesBeforeDelete) {
      try {
        const { projectPath } = await deps.dispatcher.dispatch({
          type: INTENT_RESOLVE_WORKSPACE,
          payload: { workspacePath: entry.workspacePath },
        } as ResolveWorkspaceIntent);

        await deps.dispatcher.dispatch({
          type: INTENT_GET_PROJECT_BASES,
          payload: { projectPath, refresh: true, wait: true },
        } as GetProjectBasesIntent);
      } catch (error) {
        deps.logger.warn("Failed to fetch bases before auto-delete (continuing)", {
          key,
          error: getErrorMessage(error),
        });
      }
    }

    deletingKeys.add(key);
    try {
      await deps.dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: entry.workspacePath,
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      deps.logger.info("Auto-workspace deleted", {
        key,
        workspaceName: entry.workspaceName,
      });
    } catch (error) {
      deps.logger.warn("Failed to delete auto-workspace", {
        key,
        error: getErrorMessage(error),
      });
    }
    deletingKeys.delete(key);
  }

  // ------ Poll Cycle ------

  async function pollSource(source: AutoWorkspaceSource): Promise<boolean> {
    const prefix = `${source.name}/`;

    // Build trackedKeys from state entries for this source
    const trackedKeys = new Set<string>();
    for (const key of Object.keys(entries)) {
      if (key.startsWith(prefix)) {
        trackedKeys.add(key.slice(prefix.length));
      }
    }

    let pollResult: PollResult;
    try {
      pollResult = await source.poll(trackedKeys);
    } catch (error) {
      deps.logger.warn("Poll failed for source, skipping", {
        source: source.name,
        error: getErrorMessage(error),
      });
      return false;
    }
    const { activeKeys, newItems } = pollResult;

    deps.logger.debug("Poll completed", {
      source: source.name,
      total: activeKeys.size,
      tracked: activeKeys.size - newItems.length,
      new: newItems.length,
    });
    if (newItems.length > 0) {
      deps.logger.debug("Poll new items", {
        source: source.name,
        keys: newItems.map((i) => i.key).join(","),
      });
    }

    let stateChanged = false;
    const entriesBefore = entries;

    // Build set of full state keys that are still active
    const activeStateKeys = new Set<string>();
    for (const itemKey of activeKeys) {
      activeStateKeys.add(stateKey(source.name, itemKey));
    }

    // Detect disappeared items
    const trackedPaths = await buildTrackedPaths();
    for (const [key, entry] of Object.entries(entries)) {
      if (!key.startsWith(prefix)) continue;
      if (activeStateKeys.has(key)) continue;

      if (entry === null) {
        // Dismissed entry — remove from state
        deps.logger.info("Forgot dismissed entry (item disappeared from poll)", {
          source: source.name,
          key,
        });
        entries = Object.fromEntries(Object.entries(entries).filter(([k]) => k !== key));
      } else if (trackedPaths.has(entry.workspacePath)) {
        // Active entry with tracked metadata — auto-delete (deleteWorkspace logs)
        await deleteWorkspace(source, key, entry);
      } else {
        // Entry exists but workspace not tracked → previous failure, leave entry
        deps.logger.info("Leaving stale entry to prevent recreation", {
          source: source.name,
          key,
          workspaceName: entry.workspaceName,
        });
      }
    }

    // Create workspaces for new items
    for (const item of newItems) {
      await createWorkspace(source, item);
    }

    if (entries !== entriesBefore) {
      stateChanged = true;
    }

    return stateChanged;
  }

  async function poll(): Promise<void> {
    let anyChanged = false;

    for (const source of deps.sources) {
      if (!activeSources.has(source.name)) continue;
      const changed = await pollSource(source);
      if (changed) anyChanged = true;
    }

    if (anyChanged) {
      await persist();
    }
  }

  // ------ Timer Management ------

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    deps.logger.info("Auto-workspace polling started", { intervalMs: POLL_INTERVAL_MS });
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      deps.logger.info("Auto-workspace polling stopped");
    }
  }

  // ------ Source Activation ------

  function isSourceActive(source: AutoWorkspaceSource): boolean {
    const tplPath = templatePaths.get(source.name);
    return tplPath !== null && tplPath !== undefined && source.isConfigured();
  }

  async function activateSource(source: AutoWorkspaceSource): Promise<void> {
    if (!isSourceActive(source)) return;

    deps.logger.info("Activating auto-workspace source", { source: source.name });

    const initialized = await source.initialize();
    if (!initialized) return;

    activeSources.add(source.name);
  }

  function deactivateSource(source: AutoWorkspaceSource): void {
    activeSources.delete(source.name);
    source.dispose();
    deps.logger.info("Deactivated auto-workspace source", { source: source.name });
  }

  async function activateAll(): Promise<void> {
    await migrateLegacyStateFile();
    entries = stateAccessor.get();

    for (const source of deps.sources) {
      await activateSource(source);
    }

    if (activeSources.size > 0) {
      await poll();
      startPolling();
    }
  }

  function deactivateAll(): void {
    stopPolling();
    for (const source of deps.sources) {
      if (activeSources.has(source.name)) {
        deactivateSource(source);
      }
    }
  }

  // ------ Module Definition ------

  return {
    name: "auto-workspace",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            // Read template paths from config
            for (const source of deps.sources) {
              const tplValue = templatePathConfigs.get(source.name)?.get() ?? null;
              templatePaths.set(source.name, tplValue);
            }
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            deactivateAll();
          },
        },
      },
    },
    events: {
      [EVENT_APP_STARTED]: {
        handler: async (): Promise<void> => {
          await activateAll();
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath, worktreeRemoved } = (event as WorkspaceDeletedEvent).payload;

          // Runtime-only teardown (e.g. the per-workspace teardown during
          // project:close) is not a deletion: the worktree stays on disk and
          // tracking must survive a close/reopen cycle.
          if (!worktreeRemoved) return;

          for (const [key, entry] of Object.entries(entries)) {
            if (entry?.workspacePath === workspacePath) {
              if (deletingKeys.has(key)) {
                // Auto-deletion — remove entry entirely
                entries = Object.fromEntries(Object.entries(entries).filter(([k]) => k !== key));
              } else {
                // Manual deletion — set to null to prevent re-creation
                entries = { ...entries, [key]: null };
              }
              await persist();
              deps.logger.info("Marked auto-workspace as dismissed", {
                key,
                workspaceName: entry.workspaceName,
              });
              break;
            }
          }
        },
      },
      [EVENT_WORKSPACE_DELETE_FAILED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath } = (event as WorkspaceDeleteFailedEvent).payload;

          // Runs inside the dispatch .catch() handlers below, so it can't be
          // awaited here; PersistedStore serializes the write, so the
          // fire-and-forget persist() stays race-safe.
          const dismissEntry = (key: string): void => {
            entries = { ...entries, [key]: null };
            void persist();
          };

          for (const [key, entry] of Object.entries(entries)) {
            if (entry?.workspacePath === workspacePath && deletingKeys.has(key)) {
              void deps.dispatcher
                .dispatch({
                  type: INTENT_SET_METADATA,
                  payload: { workspacePath, key: METADATA_TRACKED_KEY, value: null },
                } as SetMetadataIntent)
                .catch((err: unknown) => {
                  deps.logger.warn("Failed to clear tracked metadata after delete failure", {
                    workspacePath,
                    error: getErrorMessage(err),
                  });
                  dismissEntry(key);
                });
              void deps.dispatcher
                .dispatch({
                  type: INTENT_SET_METADATA,
                  payload: {
                    workspacePath,
                    key: TAG_DELETION_FAILED_KEY,
                    value: TAG_DELETION_FAILED_VALUE,
                  },
                } as SetMetadataIntent)
                .catch((err: unknown) => {
                  deps.logger.warn("Failed to set deletion-failed tag after delete failure", {
                    workspacePath,
                    error: getErrorMessage(err),
                  });
                  dismissEntry(key);
                });
              break;
            }
          }
        },
      },
    },
  };
}
