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
 * - app:start -> "register-config": register per-source template-path + source config keys
 * - app:start -> "start": initialize active sources, load state, run initial poll, start timer
 * - app:shutdown -> "stop": clear poll timer, dispose sources
 *
 * Events:
 * - config:updated: forward to sources, toggle activation per source
 * - workspace:deleted: clean up state entry
 * - workspace:delete-failed: clear tracking metadata, set red tag
 */

import type { IntentModule } from "../../intents/infrastructure/module";
import type { Dispatcher } from "../../intents/infrastructure/dispatcher";
import type { DomainEvent } from "../../intents/infrastructure/types";
import { APP_START_OPERATION_ID, type RegisterConfigResult } from "../../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../operations/app-shutdown";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../../operations/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../operations/resolve-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
} from "../../operations/get-project-bases";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../operations/open-project";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../operations/list-projects";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedEvent } from "../../operations/config-set-values";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../operations/set-metadata";
import { configPath } from "../../../services/config/config-definition";
import type { ConfigKeyDefinition } from "../../../services/config/config-definition";
import type { FileSystemLayer } from "../../../services/platform/filesystem";
import type { Logger } from "../../../services/logging/types";
import type { NormalizedInitialPrompt } from "../../../shared/api/types";
import { getErrorMessage } from "../../../shared/error-utils";
import { renderTemplate } from "../../../services/template/liquid-renderer";
import { parseTemplateOutput } from "./template";
import { Path } from "../../../services/platform/path";
import type { AutoWorkspaceSource, PollItem } from "./source";

// =============================================================================
// State Types
// =============================================================================

interface StateEntry {
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly createdAt: string;
}

interface AutoWorkspaceState {
  readonly version: 1;
  readonly entries: Record<string, StateEntry | null>;
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
  readonly fs: Pick<FileSystemLayer, "readFile" | "writeFile">;
  readonly logger: Logger;
  readonly stateFilePath: string;
  readonly dispatcher: Dispatcher;
  readonly sources: readonly AutoWorkspaceSource[];
}

// =============================================================================
// Helpers
// =============================================================================

function emptyState(): AutoWorkspaceState {
  return { version: 1, entries: {} };
}

function stateKey(sourceName: string, itemKey: string): string {
  return `${sourceName}/${itemKey}`;
}

function templatePathConfigKey(sourceName: string): string {
  return `experimental.${sourceName}.template-path`;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createAutoWorkspaceModule(deps: AutoWorkspaceModuleDeps): IntentModule {
  let state: AutoWorkspaceState = emptyState();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let initialActivationDone = false;

  // Per-source activation state
  const templatePaths = new Map<string, string | null>(); // sourceName → template path
  const activeSources = new Set<string>(); // currently polling source names
  const deletingKeys = new Set<string>(); // sentinel for auto-deletions

  // ------ State Persistence ------

  async function loadState(): Promise<AutoWorkspaceState> {
    try {
      const raw = await deps.fs.readFile(deps.stateFilePath);
      const parsed = JSON.parse(raw) as AutoWorkspaceState;
      if (parsed.version === 1 && typeof parsed.entries === "object") {
        return parsed;
      }
      deps.logger.warn("Invalid auto-workspace state file, starting fresh");
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  async function saveState(): Promise<void> {
    try {
      await deps.fs.writeFile(deps.stateFilePath, JSON.stringify(state, null, 2));
    } catch (error) {
      deps.logger.warn("Failed to save auto-workspace state", { error: getErrorMessage(error) });
    }
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
        state = { ...state, entries: { ...state.entries, [key]: null } };
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
        state = { ...state, entries: { ...state.entries, [key]: null } };
        return;
      }

      // No name → dismiss with warning
      if (!config.name) {
        deps.logger.warn("Skipping auto-workspace (no name in template)", { key });
        state = { ...state, entries: { ...state.entries, [key]: null } };
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

      const initialPrompt: NormalizedInitialPrompt = {
        prompt: config.prompt,
        agent: config.agent ?? "plan",
        ...(config.model !== undefined && { model: config.model }),
      };

      // Create the workspace
      const wsResult = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: config.name,
          ...(config.base !== undefined && { base: config.base }),
          stealFocus: config.focus ?? false,
          projectPath: project.path,
          initialPrompt,
        },
      } as OpenWorkspaceIntent);

      const workspacePath =
        wsResult && typeof wsResult === "object" && "path" in wsResult
          ? (wsResult as { path: string }).path
          : "";

      if (!workspacePath) return;

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
      state = {
        ...state,
        entries: {
          ...state.entries,
          [key]: {
            workspacePath,
            workspaceName: config.name,
            createdAt: new Date().toISOString(),
          },
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
      state = { ...state, entries: { ...state.entries, [key]: null } };
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
    for (const key of Object.keys(state.entries)) {
      if (key.startsWith(prefix)) {
        trackedKeys.add(key.slice(prefix.length));
      }
    }

    const { activeKeys, newItems } = await source.poll(trackedKeys);

    let stateChanged = false;
    const stateBefore = state;

    // Build set of full state keys that are still active
    const activeStateKeys = new Set<string>();
    for (const itemKey of activeKeys) {
      activeStateKeys.add(stateKey(source.name, itemKey));
    }

    // Detect disappeared items
    const trackedPaths = await buildTrackedPaths();
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!key.startsWith(prefix)) continue;
      if (activeStateKeys.has(key)) continue;

      if (entry === null) {
        // Dismissed entry — remove from state
        const remaining = Object.fromEntries(
          Object.entries(state.entries).filter(([k]) => k !== key)
        );
        state = { ...state, entries: remaining };
      } else if (trackedPaths.has(entry.workspacePath)) {
        // Active entry with tracked metadata — auto-delete
        await deleteWorkspace(source, key, entry);
      }
      // Entry exists but not tracked → previous failure, leave entry to prevent recreation
    }

    // Create workspaces for new items
    for (const item of newItems) {
      await createWorkspace(source, item);
    }

    if (state !== stateBefore) {
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
      await saveState();
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
    state = await loadState();

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
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => {
            const definitions: ConfigKeyDefinition<unknown>[] = [];

            for (const source of deps.sources) {
              // Template-path key per source
              definitions.push({
                name: templatePathConfigKey(source.name),
                default: null,
                description: `Path to Liquid template for ${source.name} auto-workspaces`,
                ...configPath({ nullable: true }),
              });

              // Source-specific config keys
              definitions.push(...source.configDefinitions());
            }

            return { definitions };
          },
        },
        start: {
          handler: async (): Promise<void> => {
            await activateAll();
            initialActivationDone = true;
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
      [EVENT_CONFIG_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { values } = (event as ConfigUpdatedEvent).payload;

          for (const source of deps.sources) {
            const tplKey = templatePathConfigKey(source.name);
            if (tplKey in values) {
              templatePaths.set(source.name, (values[tplKey] as string | null) ?? null);
            }

            source.onConfigUpdated(values);

            if (!initialActivationDone) continue;

            const wasActive = activeSources.has(source.name);
            const shouldBeActive = isSourceActive(source);

            if (!wasActive && shouldBeActive) {
              void activateSource(source).then(() => {
                if (activeSources.size > 0) {
                  void poll().then(() => {
                    startPolling();
                  });
                }
              });
            } else if (wasActive && !shouldBeActive) {
              deactivateSource(source);
              if (activeSources.size === 0) {
                stopPolling();
              }
            }
          }
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath } = (event as WorkspaceDeletedEvent).payload;

          for (const [key, entry] of Object.entries(state.entries)) {
            if (entry?.workspacePath === workspacePath) {
              if (deletingKeys.has(key)) {
                // Auto-deletion — remove entry entirely
                const remaining = Object.fromEntries(
                  Object.entries(state.entries).filter(([k]) => k !== key)
                );
                state = { ...state, entries: remaining };
              } else {
                // Manual deletion — set to null to prevent re-creation
                state = {
                  ...state,
                  entries: { ...state.entries, [key]: null },
                };
              }
              void saveState();
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

          const dismissEntry = (key: string): void => {
            state = { ...state, entries: { ...state.entries, [key]: null } };
            void saveState();
          };

          for (const [key, entry] of Object.entries(state.entries)) {
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
