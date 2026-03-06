/**
 * YouTrackModule - Polls YouTrack for issues matching a configured query
 * and automatically creates/deletes workspaces to match.
 *
 * Enabled when ALL FOUR config keys are non-null:
 * - experimental.youtrack.base-url
 * - experimental.youtrack.token
 * - experimental.youtrack.template-path
 * - experimental.youtrack.query
 *
 * Hooks:
 * - app:start -> "register-config": register 4 config keys
 * - app:start -> "activate": load state, run initial poll, start timer
 * - app:shutdown -> "stop": clear poll timer
 *
 * Events:
 * - config:updated: react to youtrack config key changes
 * - workspace:deleted: clean up mapping if a youtrack workspace is manually deleted
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { DomainEvent } from "../intents/infrastructure/types";
import {
  APP_START_OPERATION_ID,
  type ActivateHookResult,
  type RegisterConfigResult,
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeleteFailedEvent,
} from "../operations/delete-workspace";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../operations/open-project";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../operations/list-projects";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedEvent } from "../operations/config-set-values";
import type { HttpClient } from "../../services/platform/network";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Logger } from "../../services/logging/types";
import { isValidMetadataKey, type NormalizedInitialPrompt } from "../../shared/api/types";
import { getErrorMessage } from "../../shared/error-utils";
import { renderTemplate } from "../../services/template/liquid-renderer";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../operations/set-metadata";
import { configString, configPath } from "../../services/config/config-definition";
import type { ConfigKeyDefinition } from "../../services/config/config-definition";
import { Path } from "../../services/platform/path";

// =============================================================================
// Persistence Types
// =============================================================================

interface YouTrackWorkspaceEntry {
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly issueId: string;
  readonly idReadable: string;
  readonly projectPath: string;
  readonly createdAt: string;
}

interface YouTrackState {
  readonly version: 1;
  readonly workspaces: Record<string, YouTrackWorkspaceEntry | null>;
}

// =============================================================================
// Module Dependencies
// =============================================================================

export interface YouTrackModuleDeps {
  readonly httpClient: HttpClient;
  readonly fs: Pick<FileSystemLayer, "readFile" | "writeFile" | "mkdir">;
  readonly logger: Logger;
  readonly stateFilePath: string;
  readonly dispatcher: Dispatcher;
}

// =============================================================================
// Constants
// =============================================================================

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

const CONFIG_KEYS = {
  baseUrl: "experimental.youtrack.base-url",
  token: "experimental.youtrack.token",
  templatePath: "experimental.youtrack.template-path",
  query: "experimental.youtrack.query",
} as const;

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";

const METADATA_TRACKED_KEY = "youtrack.tracked";
const TAG_DELETION_FAILED_KEY = "tags.deletion-failed";
const TAG_DELETION_FAILED_VALUE = JSON.stringify({ color: "#e74c3c" });

// =============================================================================
// Helpers
// =============================================================================

function emptyState(): YouTrackState {
  return { version: 1, workspaces: {} };
}

/**
 * Build the state key for a YouTrack issue.
 * e.g. "https://youtrack.example.com/api/issues/2-123"
 */
function issueStateKey(baseUrl: string, issueId: string): string {
  return `${baseUrl}/api/issues/${issueId}`;
}

// =============================================================================
// Front-matter parser
// =============================================================================

export interface YouTrackTemplateConfig {
  readonly name?: string;
  readonly agent?: string;
  readonly base?: string;
  readonly focus?: boolean;
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly metadata?: Readonly<Record<string, string>>;
  readonly project?: string;
  readonly git?: string;
  readonly prompt: string;
}

export interface YouTrackParseResult {
  readonly config: YouTrackTemplateConfig;
  readonly warnings: readonly string[];
}

const FRONT_MATTER_OPEN = "---\n";
const KNOWN_KEYS = new Set([
  "name",
  "agent",
  "base",
  "focus",
  "model.provider",
  "model.id",
  "project",
  "git",
]);

export function parseYouTrackTemplateOutput(rendered: string): YouTrackParseResult {
  const warnings: string[] = [];

  if (!rendered.startsWith(FRONT_MATTER_OPEN)) {
    return { config: { prompt: rendered }, warnings };
  }

  // Find closing delimiter after the opening "---\n"
  const rest = rendered.slice(FRONT_MATTER_OPEN.length);
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    // No closing delimiter -> treat entire string as prompt
    return { config: { prompt: rendered }, warnings };
  }

  const frontMatterBlock = rest.slice(0, closeMatch.index);
  const prompt = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, "");

  // Parse key-value lines
  const fields: Record<string, string> = {};
  const metadataFields: Record<string, string> = {};
  for (const line of frontMatterBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      warnings.push(`Ignoring front-matter line (no colon): "${trimmed}"`);
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (key.startsWith("metadata.")) {
      const metaKey = key.slice("metadata.".length);
      if (isValidMetadataKey(metaKey)) {
        metadataFields[metaKey] = value;
      } else {
        warnings.push(`Invalid metadata key: "${metaKey}"`);
      }
      continue;
    }

    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown front-matter key: "${key}"`);
      continue;
    }

    fields[key] = value;
  }

  // Build config
  let focus: boolean | undefined;
  if (fields["focus"] !== undefined) {
    if (fields["focus"] === "true") {
      focus = true;
    } else if (fields["focus"] === "false") {
      focus = false;
    } else {
      warnings.push(`Invalid focus value "${fields["focus"]}", expected "true" or "false"`);
    }
  }

  let model: { readonly providerID: string; readonly modelID: string } | undefined;
  if (fields["model.provider"] !== undefined || fields["model.id"] !== undefined) {
    if (fields["model.provider"] && fields["model.id"]) {
      model = { providerID: fields["model.provider"], modelID: fields["model.id"] };
    } else {
      warnings.push("Both model.provider and model.id must be specified together");
    }
  }

  const config: YouTrackTemplateConfig = {
    prompt,
    ...(fields["name"] !== undefined && { name: fields["name"] }),
    ...(fields["agent"] !== undefined && { agent: fields["agent"] }),
    ...(fields["base"] !== undefined && { base: fields["base"] }),
    ...(focus !== undefined && { focus }),
    ...(model !== undefined && { model }),
    ...(Object.keys(metadataFields).length > 0 && { metadata: metadataFields }),
    ...(fields["project"] !== undefined && { project: fields["project"] }),
    ...(fields["git"] !== undefined && { git: fields["git"] }),
  };

  return { config, warnings };
}

// =============================================================================
// Module Factory
// =============================================================================

export function createYouTrackModule(deps: YouTrackModuleDeps): IntentModule {
  let state: YouTrackState = emptyState();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = false;
  // Tracked from config:updated events (fires during app:start init phase, before activate)
  let configBaseUrl: string | null = null;
  let configToken: string | null = null;
  let configTemplatePath: string | null = null;
  let configQuery: string | null = null;
  // Prevents the event handler from triggering activation during initial startup
  let initialActivationDone = false;

  const stateFilePath = deps.stateFilePath;
  const deletingStateKeys = new Set<string>();

  function isFullyConfigured(): boolean {
    return (
      configBaseUrl !== null &&
      configToken !== null &&
      configTemplatePath !== null &&
      configQuery !== null
    );
  }

  // ------ State Persistence ------

  async function loadState(): Promise<YouTrackState> {
    try {
      const raw = await deps.fs.readFile(stateFilePath);
      const parsed = JSON.parse(raw) as YouTrackState;
      if (parsed.version === 1 && typeof parsed.workspaces === "object") {
        return parsed;
      }
      deps.logger.warn("Invalid youtrack state file, starting fresh");
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  async function saveState(): Promise<void> {
    try {
      await deps.fs.writeFile(stateFilePath, JSON.stringify(state, null, 2));
    } catch (error) {
      deps.logger.warn("Failed to save youtrack state", { error: getErrorMessage(error) });
    }
  }

  // ------ YouTrack API ------

  function youtrackHeaders(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${configToken}`,
      Accept: "application/json",
    };
  }

  async function fetchIssues(): Promise<Record<string, unknown>[]> {
    const query = encodeURIComponent(configQuery!);
    const fields = encodeURIComponent(YOUTRACK_FIELDS);
    const url = `${configBaseUrl}/api/issues?query=${query}&fields=${fields}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: youtrackHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("YouTrack API returned non-OK", { status: response.status });
      return [];
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  // ------ Workspace Lifecycle ------

  interface WorkspaceConfig {
    readonly workspaceName: string;
    readonly base?: string;
    readonly stealFocus: boolean;
    readonly initialPrompt: NormalizedInitialPrompt;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly projectSource: { type: "path"; path: string } | { type: "git"; url: string } | null;
  }

  async function buildWorkspaceConfig(
    issue: Record<string, unknown>
  ): Promise<WorkspaceConfig | null> {
    try {
      const templateContent = await deps.fs.readFile(configTemplatePath!);
      const rendered = renderTemplate(templateContent, issue);
      const { config, warnings } = parseYouTrackTemplateOutput(rendered);

      for (const warning of warnings) {
        deps.logger.warn("Template front-matter warning", {
          warning,
          templatePath: configTemplatePath,
        });
      }

      if (!config.prompt.trim()) return null;

      // Determine project source: "project" wins over "git"
      let projectSource: WorkspaceConfig["projectSource"] = null;
      if (config.project) {
        projectSource = { type: "path", path: config.project };
      } else if (config.git) {
        projectSource = { type: "git", url: config.git };
      }

      // Skip if no project source
      if (!projectSource) return null;

      const initialPrompt: NormalizedInitialPrompt = {
        prompt: config.prompt,
        agent: config.agent ?? "plan",
        ...(config.model !== undefined && { model: config.model }),
      };

      const idReadable = issue.idReadable as string;

      return {
        workspaceName: config.name ?? idReadable,
        ...(config.base !== undefined && { base: config.base }),
        stealFocus: config.focus ?? false,
        initialPrompt,
        ...(config.metadata !== undefined && { metadata: config.metadata }),
        projectSource,
      };
    } catch (error) {
      deps.logger.warn("Failed to read/render YouTrack template", {
        templatePath: configTemplatePath,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async function createIssueWorkspace(
    stateKey: string,
    issue: Record<string, unknown>
  ): Promise<void> {
    const issueId = issue.id as string;
    const idReadable = issue.idReadable as string;
    deps.logger.info("Creating YouTrack workspace", { stateKey, idReadable });

    try {
      const config = await buildWorkspaceConfig(issue);
      if (!config) {
        deps.logger.info("Skipping YouTrack workspace (template resolved to empty or no project)", {
          stateKey,
        });
        state = {
          ...state,
          workspaces: { ...state.workspaces, [stateKey]: null },
        };
        return;
      }

      // Open the project (local path or git clone)
      const projectPayload: OpenProjectIntent["payload"] =
        config.projectSource!.type === "path"
          ? { path: new Path(config.projectSource!.path) }
          : { git: config.projectSource!.url };

      const project = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: projectPayload,
      } as OpenProjectIntent);

      if (!project) {
        deps.logger.warn("project:open returned null for YouTrack workspace", { stateKey });
        return;
      }

      // Create the workspace
      const wsResult = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: config.workspaceName,
          ...(config.base !== undefined && { base: config.base }),
          stealFocus: config.stealFocus,
          projectPath: project.path,
          initialPrompt: config.initialPrompt,
        },
      } as OpenWorkspaceIntent);

      const workspacePath =
        wsResult && typeof wsResult === "object" && "path" in wsResult
          ? (wsResult as { path: string }).path
          : "";

      // Auto-set source and url metadata
      if (workspacePath) {
        const issueUrl = `${configBaseUrl}/issue/${idReadable}`;
        const autoMetadata: Record<string, string> = {
          source: "youtrack",
          url: issueUrl,
          [METADATA_TRACKED_KEY]: "true",
        };

        // Merge auto metadata with template metadata (template wins on conflict)
        const allMetadata = { ...autoMetadata, ...(config.metadata ?? {}) };

        for (const [key, value] of Object.entries(allMetadata)) {
          try {
            await deps.dispatcher.dispatch({
              type: INTENT_SET_METADATA,
              payload: { workspacePath, key, value },
            } as SetMetadataIntent);
          } catch (error) {
            deps.logger.warn("Failed to set workspace metadata", {
              key,
              stateKey,
              error: getErrorMessage(error),
            });
          }
        }
      }

      // Record in state
      state = {
        ...state,
        workspaces: {
          ...state.workspaces,
          [stateKey]: {
            workspaceName: config.workspaceName,
            workspacePath,
            issueId,
            idReadable,
            projectPath: project.path,
            createdAt: new Date().toISOString(),
          },
        },
      };

      deps.logger.info("YouTrack workspace created", {
        stateKey,
        workspaceName: config.workspaceName,
      });
    } catch (error) {
      deps.logger.warn("Failed to create YouTrack workspace", {
        stateKey,
        error: getErrorMessage(error),
      });
    }
  }

  async function deleteIssueWorkspace(
    stateKey: string,
    entry: YouTrackWorkspaceEntry
  ): Promise<void> {
    deps.logger.info("Deleting YouTrack workspace (issue disappeared)", {
      stateKey,
      workspaceName: entry.workspaceName,
    });

    deletingStateKeys.add(stateKey);
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

      deps.logger.info("YouTrack workspace deleted", {
        stateKey,
        workspaceName: entry.workspaceName,
      });
    } catch (error) {
      deps.logger.warn("Failed to delete YouTrack workspace", {
        stateKey,
        error: getErrorMessage(error),
      });
    }
    deletingStateKeys.delete(stateKey);
  }

  // ------ Metadata Tracking ------

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

  // ------ Poll Cycle ------

  async function poll(): Promise<void> {
    deps.logger.debug("Polling YouTrack for issues");

    const stateBefore = state;

    let issues: Record<string, unknown>[];
    try {
      issues = await fetchIssues();
    } catch (error) {
      deps.logger.warn("Failed to poll YouTrack", { error: getErrorMessage(error) });
      return;
    }

    // Build set of currently open issue state keys
    const openIssueKeys = new Set<string>();
    for (const issue of issues) {
      const issueId = issue.id as string;
      const key = issueStateKey(configBaseUrl!, issueId);
      openIssueKeys.add(key);
    }

    // Detect disappeared issues -> delete workspaces or clean up null entries
    const trackedPaths = await buildTrackedPaths();
    const disappearedKeys = Object.keys(state.workspaces).filter((key) => !openIssueKeys.has(key));
    for (const stateKey of disappearedKeys) {
      const entry = state.workspaces[stateKey];
      if (entry && trackedPaths.has(entry.workspacePath)) {
        await deleteIssueWorkspace(stateKey, entry);
      } else if (!entry) {
        // null entry (dismissed) — just remove the key
        const remaining = Object.fromEntries(
          Object.entries(state.workspaces).filter(([key]) => key !== stateKey)
        );
        state = { ...state, workspaces: remaining };
      }
    }

    // Detect new issues -> create workspaces
    for (const issue of issues) {
      const issueId = issue.id as string;
      const key = issueStateKey(configBaseUrl!, issueId);
      if (key in state.workspaces) continue; // tracked (active or dismissed)

      await createIssueWorkspace(key, issue);
    }

    // Persist if state changed
    if (state !== stateBefore) {
      await saveState();
    }
  }

  // ------ Timer Management ------

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    deps.logger.info("YouTrack polling started", { intervalMs: POLL_INTERVAL_MS });
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      deps.logger.info("YouTrack polling stopped");
    }
  }

  // ------ Activation / Deactivation ------

  async function activate(): Promise<void> {
    if (!isFullyConfigured()) {
      return;
    }

    deps.logger.info("YouTrack integration fully configured, enabling");

    state = await loadState();
    enabled = true;

    // Run initial poll (reconcile stale state)
    await poll();

    startPolling();
  }

  function deactivate(): void {
    stopPolling();
    enabled = false;
  }

  // ------ Module Definition ------

  return {
    name: "youtrack",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: CONFIG_KEYS.baseUrl,
                default: null,
                description: "YouTrack instance URL (e.g. https://youtrack.example.com)",
                ...configString({ nullable: true }),
              },
              {
                name: CONFIG_KEYS.token,
                default: null,
                description: "YouTrack API permanent token",
                ...configString({ nullable: true }),
              },
              {
                name: CONFIG_KEYS.templatePath,
                default: null,
                description: "Path to Liquid template for YouTrack workspaces",
                ...configPath({ nullable: true }),
              },
              {
                name: CONFIG_KEYS.query,
                default: null,
                description: "YouTrack search query (e.g. for:me State: {In Progress})",
                ...configString({ nullable: true }),
              },
            ] satisfies ConfigKeyDefinition<unknown>[],
          }),
        },
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            await activate();
            initialActivationDone = true;
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            deactivate();
          },
        },
      },
    },
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        const prevConfigured = isFullyConfigured();

        if (CONFIG_KEYS.baseUrl in values) {
          configBaseUrl = (values[CONFIG_KEYS.baseUrl] as string | null) ?? null;
        }
        if (CONFIG_KEYS.token in values) {
          configToken = (values[CONFIG_KEYS.token] as string | null) ?? null;
        }
        if (CONFIG_KEYS.templatePath in values) {
          configTemplatePath = (values[CONFIG_KEYS.templatePath] as string | null) ?? null;
        }
        if (CONFIG_KEYS.query in values) {
          configQuery = (values[CONFIG_KEYS.query] as string | null) ?? null;
        }

        // Only react to runtime toggles (after initial activate hook has run).
        if (!initialActivationDone) return;

        const nowConfigured = isFullyConfigured();
        if (!prevConfigured && nowConfigured && !enabled) {
          void activate();
        } else if (prevConfigured && !nowConfigured && enabled) {
          deactivate();
        }
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        for (const [stateKey, entry] of Object.entries(state.workspaces)) {
          if (entry?.workspacePath === workspacePath) {
            if (deletingStateKeys.has(stateKey)) {
              // Auto-deletion (issue disappeared) — remove entry entirely
              const remaining = Object.fromEntries(
                Object.entries(state.workspaces).filter(([key]) => key !== stateKey)
              );
              state = { ...state, workspaces: remaining };
            } else {
              // Manual deletion — set to null to prevent re-creation
              state = {
                ...state,
                workspaces: { ...state.workspaces, [stateKey]: null },
              };
            }
            void saveState();
            deps.logger.info("Marked YouTrack workspace as dismissed", {
              stateKey,
              workspaceName: entry.workspaceName,
            });
            break;
          }
        }
      },
      [EVENT_WORKSPACE_DELETE_FAILED]: (event: DomainEvent) => {
        const { workspacePath } = (event as WorkspaceDeleteFailedEvent).payload;
        for (const [stateKey, entry] of Object.entries(state.workspaces)) {
          if (entry?.workspacePath === workspacePath && deletingStateKeys.has(stateKey)) {
            void deps.dispatcher.dispatch({
              type: INTENT_SET_METADATA,
              payload: { workspacePath, key: METADATA_TRACKED_KEY, value: null },
            } as SetMetadataIntent);
            void deps.dispatcher.dispatch({
              type: INTENT_SET_METADATA,
              payload: {
                workspacePath,
                key: TAG_DELETION_FAILED_KEY,
                value: TAG_DELETION_FAILED_VALUE,
              },
            } as SetMetadataIntent);
            break;
          }
        }
      },
    },
  };
}
