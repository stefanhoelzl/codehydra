/**
 * AutoPrModule - Polls GitHub for PRs where the user is a requested reviewer
 * and automatically creates/deletes workspaces to match.
 *
 * Enabled when `experimental.auto-pr-template-path` is set to a Liquid template path.
 * When the template renders to empty/whitespace for a PR, that PR is skipped and
 * recorded as dismissed (null entry) to avoid re-computing the template every poll cycle.
 *
 * Hooks:
 * - app:start -> "activate": acquire gh token, load state, run initial poll, start timer
 * - app:shutdown -> "stop": clear poll timer
 *
 * Events:
 * - config:updated: react to experimental.auto-pr-template-path changes
 * - workspace:deleted: clean up mapping if a PR workspace is manually deleted
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
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
} from "../operations/delete-workspace";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../operations/open-project";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ProcessRunner } from "../../services/platform/process";
import type { HttpClient } from "../../services/platform/network";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Logger } from "../../services/logging/types";
import type { NormalizedInitialPrompt } from "../../shared/api/types";
import { getErrorMessage } from "../../shared/error-utils";
import { renderTemplate } from "../../services/template/liquid-renderer";
import { configPath } from "../../services/config/config-definition";
import type { ConfigKeyDefinition } from "../../services/config/config-definition";

// =============================================================================
// Persistence Types
// =============================================================================

interface AutoPrWorkspaceEntry {
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly prNumber: number;
  readonly repo: string;
  readonly projectPath: string;
  readonly createdAt: string;
}

interface AutoPrState {
  readonly version: 1;
  readonly workspaces: Record<string, AutoPrWorkspaceEntry | null>;
}

// =============================================================================
// GitHub API Types (minimal)
// =============================================================================

interface GitHubSearchResponse {
  readonly items: readonly GitHubSearchItem[];
}

interface GitHubSearchItem {
  readonly number: number;
  readonly html_url: string;
  readonly pull_request?: { readonly html_url: string };
  readonly repository_url: string;
}

interface GitHubPrDetail {
  readonly head: { readonly ref: string };
  readonly base: { readonly ref: string };
  readonly html_url: string;
  readonly clone_url?: string;
}

interface GitHubRepoDetail {
  readonly clone_url: string;
}

// =============================================================================
// Module Dependencies
// =============================================================================

export interface AutoPrModuleDeps {
  readonly processRunner: ProcessRunner;
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
const GITHUB_API_BASE = "https://api.github.com";

// =============================================================================
// Helpers
// =============================================================================

function emptyState(): AutoPrState {
  return { version: 1, workspaces: {} };
}

/**
 * Extract "owner/repo" from a GitHub repository API URL.
 * e.g. "https://api.github.com/repos/org/repo" → "org/repo"
 */
function repoFromApiUrl(repositoryUrl: string): string {
  const parts = repositoryUrl.split("/repos/");
  return parts[1] ?? repositoryUrl;
}

/**
 * Build workspace name from PR number and branch ref.
 * e.g. pr-42/feature-login
 */
function buildWorkspaceName(prNumber: number, headRef: string): string {
  return `pr-${prNumber}/${headRef}`;
}

// =============================================================================
// Front-matter parser
// =============================================================================

export interface TemplateConfig {
  readonly name?: string;
  readonly agent?: string;
  readonly base?: string;
  readonly focus?: boolean;
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly prompt: string;
}

export interface ParseResult {
  readonly config: TemplateConfig;
  readonly warnings: readonly string[];
}

const FRONT_MATTER_OPEN = "---\n";
const KNOWN_KEYS = new Set(["name", "agent", "base", "focus", "model.provider", "model.id"]);

export function parseTemplateOutput(rendered: string): ParseResult {
  const warnings: string[] = [];

  if (!rendered.startsWith(FRONT_MATTER_OPEN)) {
    return { config: { prompt: rendered }, warnings };
  }

  // Find closing delimiter after the opening "---\n"
  const rest = rendered.slice(FRONT_MATTER_OPEN.length);
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    // No closing delimiter → treat entire string as prompt
    return { config: { prompt: rendered }, warnings };
  }

  const frontMatterBlock = rest.slice(0, closeMatch.index);
  const prompt = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, "");

  // Parse key-value lines
  const fields: Record<string, string> = {};
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

  const config: TemplateConfig = {
    prompt,
    ...(fields["name"] !== undefined && { name: fields["name"] }),
    ...(fields["agent"] !== undefined && { agent: fields["agent"] }),
    ...(fields["base"] !== undefined && { base: fields["base"] }),
    ...(focus !== undefined && { focus }),
    ...(model !== undefined && { model }),
  };

  return { config, warnings };
}

// =============================================================================
// Module Factory
// =============================================================================

export function createAutoPrModule(deps: AutoPrModuleDeps): IntentModule {
  let token: string | null = null;
  let state: AutoPrState = emptyState();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = false;
  // Tracked from config:updated events (fires during app:start init phase, before activate)
  let templatePath: string | null = null;
  // Prevents the event handler from triggering activation during initial startup
  let initialActivationDone = false;

  const stateFilePath = deps.stateFilePath;

  // ------ Token Acquisition ------

  async function acquireToken(): Promise<string | null> {
    try {
      const proc = deps.processRunner.run("gh", ["auth", "token"]);
      const result = await proc.wait(5000);
      if (result.exitCode !== 0) {
        deps.logger.warn("gh auth token failed — auto-pr-workspaces disabled", {
          exitCode: result.exitCode ?? -1,
          stderr: result.stderr.slice(0, 200),
        });
        return null;
      }
      return result.stdout.trim();
    } catch (error) {
      deps.logger.warn("gh auth token threw — auto-pr-workspaces disabled", {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  // ------ State Persistence ------

  async function loadState(): Promise<AutoPrState> {
    try {
      const raw = await deps.fs.readFile(stateFilePath);
      const parsed = JSON.parse(raw) as AutoPrState;
      if (parsed.version === 1 && typeof parsed.workspaces === "object") {
        return parsed;
      }
      deps.logger.warn("Invalid auto-pr state file, starting fresh");
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  async function saveState(): Promise<void> {
    try {
      await deps.fs.writeFile(stateFilePath, JSON.stringify(state, null, 2));
    } catch (error) {
      deps.logger.warn("Failed to save auto-pr state", { error: getErrorMessage(error) });
    }
  }

  // ------ GitHub API ------

  function githubHeaders(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async function fetchReviewRequestedPrs(): Promise<GitHubSearchItem[]> {
    const query = encodeURIComponent("is:open is:pr review-requested:@me");
    const url = `${GITHUB_API_BASE}/search/issues?q=${query}&sort=created&order=desc&per_page=100`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("GitHub search API returned non-OK", { status: response.status });
      return [];
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return [...data.items];
  }

  async function fetchPrDetail(
    repo: string,
    prNumber: number
  ): Promise<Record<string, unknown> | null> {
    const url = `${GITHUB_API_BASE}/repos/${repo}/pulls/${prNumber}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("GitHub PR detail API returned non-OK", {
        repo,
        prNumber,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async function fetchRepoDetail(repo: string): Promise<GitHubRepoDetail | null> {
    const url = `${GITHUB_API_BASE}/repos/${repo}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: githubHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("GitHub repo detail API returned non-OK", {
        repo,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as GitHubRepoDetail;
  }

  // ------ Workspace Lifecycle ------

  interface WorkspaceConfig {
    readonly workspaceName: string;
    readonly base: string;
    readonly stealFocus: boolean;
    readonly initialPrompt: NormalizedInitialPrompt;
  }

  async function buildWorkspaceConfig(
    prNumber: number,
    headRef: string,
    baseRef: string,
    prDetail: Record<string, unknown>
  ): Promise<WorkspaceConfig | null> {
    try {
      const templateContent = await deps.fs.readFile(templatePath!);
      const rendered = renderTemplate(templateContent, prDetail);
      const { config, warnings } = parseTemplateOutput(rendered);

      for (const warning of warnings) {
        deps.logger.warn("Template front-matter warning", { warning, templatePath });
      }

      if (!config.prompt.trim()) return null;

      const initialPrompt: NormalizedInitialPrompt = {
        prompt: config.prompt,
        agent: config.agent ?? "plan",
        ...(config.model !== undefined && { model: config.model }),
      };

      return {
        workspaceName: config.name ?? buildWorkspaceName(prNumber, headRef),
        base: config.base ?? `origin/${baseRef}`,
        stealFocus: config.focus ?? false,
        initialPrompt,
      };
    } catch (error) {
      deps.logger.warn("Failed to read/render PR template", {
        templatePath,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async function createPrWorkspace(
    prUrl: string,
    repo: string,
    prNumber: number,
    headRef: string,
    cloneUrl: string,
    baseRef: string,
    prDetail: Record<string, unknown>
  ): Promise<void> {
    deps.logger.info("Creating PR workspace", { prUrl });

    try {
      // Build config first — skip workspace entirely if template resolves to empty
      const config = await buildWorkspaceConfig(prNumber, headRef, baseRef, prDetail);
      if (!config) {
        deps.logger.info("Skipping PR workspace (template resolved to empty)", { prUrl });
        state = {
          ...state,
          workspaces: { ...state.workspaces, [prUrl]: null },
        };
        return;
      }

      // Open the project (clones if not already open)
      const project = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: { git: cloneUrl },
      } as OpenProjectIntent);

      if (!project) {
        deps.logger.warn("project:open returned null for PR workspace", { cloneUrl });
        return;
      }

      // Create the workspace
      const wsResult = await deps.dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: config.workspaceName,
          base: config.base,
          stealFocus: config.stealFocus,
          projectPath: project.path,
          initialPrompt: config.initialPrompt,
        },
      } as OpenWorkspaceIntent);

      // Extract workspace path from result (Workspace type has path field)
      const workspacePath =
        wsResult && typeof wsResult === "object" && "path" in wsResult
          ? (wsResult as { path: string }).path
          : "";

      // Record in state
      state = {
        ...state,
        workspaces: {
          ...state.workspaces,
          [prUrl]: {
            workspaceName: config.workspaceName,
            workspacePath,
            prNumber,
            repo,
            projectPath: project.path,
            createdAt: new Date().toISOString(),
          },
        },
      };

      deps.logger.info("PR workspace created", {
        prUrl,
        workspaceName: config.workspaceName,
      });
    } catch (error) {
      deps.logger.warn("Failed to create PR workspace", {
        prUrl,
        error: getErrorMessage(error),
      });
    }
  }

  async function deletePrWorkspace(prUrl: string, entry: AutoPrWorkspaceEntry): Promise<void> {
    deps.logger.info("Deleting PR workspace (PR disappeared)", {
      prUrl,
      workspaceName: entry.workspaceName,
    });

    try {
      await deps.dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: entry.workspacePath,
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      deps.logger.info("PR workspace deleted", { prUrl, workspaceName: entry.workspaceName });
    } catch (error) {
      deps.logger.warn("Failed to delete PR workspace", {
        prUrl,
        error: getErrorMessage(error),
      });
    }

    // Remove from state regardless of success (don't retry forever)
    const remaining = Object.fromEntries(
      Object.entries(state.workspaces).filter(([key]) => key !== prUrl)
    );
    state = { ...state, workspaces: remaining };
  }

  // ------ Poll Cycle ------

  async function poll(): Promise<void> {
    if (!token) return;

    deps.logger.debug("Polling GitHub for review-requested PRs");

    const stateBefore = state;

    let items: GitHubSearchItem[];
    try {
      items = await fetchReviewRequestedPrs();
    } catch (error) {
      deps.logger.warn("Failed to poll GitHub", { error: getErrorMessage(error) });
      return;
    }

    // Build set of currently open PR URLs
    const openPrUrls = new Set<string>();
    for (const item of items) {
      const prUrl = item.pull_request?.html_url ?? item.html_url;
      openPrUrls.add(prUrl);
    }

    // Detect disappeared PRs → delete workspaces or clean up dismissed entries
    const disappearedUrls = Object.keys(state.workspaces).filter((url) => !openPrUrls.has(url));
    for (const prUrl of disappearedUrls) {
      const entry = state.workspaces[prUrl];
      if (entry) {
        await deletePrWorkspace(prUrl, entry);
      } else {
        // null entry (dismissed by user or template-skipped) — just remove the key
        const remaining = Object.fromEntries(
          Object.entries(state.workspaces).filter(([key]) => key !== prUrl)
        );
        state = { ...state, workspaces: remaining };
      }
    }

    // Detect new PRs → create workspaces
    for (const item of items) {
      const prUrl = item.pull_request?.html_url ?? item.html_url;
      if (prUrl in state.workspaces) continue; // tracked (active or dismissed)

      const repo = repoFromApiUrl(item.repository_url);
      const prDetail = await fetchPrDetail(repo, item.number);
      if (!prDetail) continue;

      const head = prDetail.head as GitHubPrDetail["head"] | undefined;
      const base = prDetail.base as GitHubPrDetail["base"] | undefined;
      if (!head?.ref || !base?.ref) continue;

      const repoDetail = await fetchRepoDetail(repo);
      if (!repoDetail) continue;

      await createPrWorkspace(
        prUrl,
        repo,
        item.number,
        head.ref,
        repoDetail.clone_url,
        base.ref,
        prDetail
      );
    }

    // Persist if state changed (new workspaces, deletions, or template-skipped null entries)
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
    deps.logger.info("Auto-PR polling started", { intervalMs: POLL_INTERVAL_MS });
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      deps.logger.info("Auto-PR polling stopped");
    }
  }

  // ------ Activation / Deactivation ------

  async function activate(): Promise<void> {
    if (templatePath === null) {
      return;
    }

    deps.logger.info("experimental.auto-pr-template-path is set, enabling auto-PR");

    token = await acquireToken();
    if (!token) return;

    state = await loadState();
    enabled = true;

    // Run initial poll (reconcile stale state)
    await poll();

    startPolling();
  }

  function deactivate(): void {
    stopPolling();
    enabled = false;
    token = null;
  }

  // ------ Module Definition ------

  return {
    name: "auto-pr",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "experimental.auto-pr-template-path",
                default: null,
                description: "Path to Liquid template for auto-PR workspaces",
                ...configPath({ nullable: true }),
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
        if ("experimental.auto-pr-template-path" in values) {
          const prev = templatePath;
          templatePath = (values["experimental.auto-pr-template-path"] as string | null) ?? null;
          // Only react to runtime toggles (after initial activate hook has run).
          // During startup, the activate hook handles initial activation.
          if (!initialActivationDone) return;
          if (prev === null && templatePath !== null && !enabled) {
            void activate();
          } else if (prev !== null && templatePath === null && enabled) {
            deactivate();
          }
        }
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        // If a tracked PR workspace is deleted, set to null to prevent re-creation
        for (const [prUrl, entry] of Object.entries(state.workspaces)) {
          if (entry?.workspacePath === workspacePath) {
            state = {
              ...state,
              workspaces: { ...state.workspaces, [prUrl]: null },
            };
            void saveState();
            deps.logger.info("Marked PR workspace as dismissed", {
              prUrl,
              workspaceName: entry.workspaceName,
            });
            break;
          }
        }
      },
    },
  };
}
