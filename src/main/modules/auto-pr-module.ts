/**
 * AutoPrModule - Polls GitHub for PRs where the user is a requested reviewer
 * and automatically creates/deletes workspaces to match.
 *
 * Gated behind the `experimental.auto-pr-workspaces` config key.
 *
 * Hooks:
 * - app:start -> "activate": acquire gh token, load state, run initial poll, start timer
 * - app:shutdown -> "stop": clear poll timer
 *
 * Events:
 * - config:updated: react to experimental.auto-pr-workspaces toggle
 * - workspace:deleted: clean up mapping if a PR workspace is manually deleted
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { DomainEvent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";
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
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../shared/error-utils";

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
  readonly workspaces: Record<string, AutoPrWorkspaceEntry>;
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
  readonly dataRootDir: string;
  readonly dispatcher: Dispatcher;
}

// =============================================================================
// Constants
// =============================================================================

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const STATE_FILE_NAME = "auto-pr-workspaces.json";
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
// Module Factory
// =============================================================================

export function createAutoPrModule(deps: AutoPrModuleDeps): IntentModule {
  let token: string | null = null;
  let state: AutoPrState = emptyState();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = false;
  // Tracked from config:updated events (fires during app:start init phase, before activate)
  let configEnabled = false;
  // Prevents the event handler from triggering activation during initial startup
  let initialActivationDone = false;

  const stateFilePath = new Path(deps.dataRootDir, STATE_FILE_NAME).toString();

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

  async function fetchPrDetail(repo: string, prNumber: number): Promise<GitHubPrDetail | null> {
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

    return (await response.json()) as GitHubPrDetail;
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

  async function createPrWorkspace(
    prUrl: string,
    repo: string,
    prNumber: number,
    headRef: string,
    cloneUrl: string,
    baseRef: string
  ): Promise<void> {
    const workspaceName = buildWorkspaceName(prNumber, headRef);

    deps.logger.info("Creating PR workspace", { prUrl, workspaceName });

    try {
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
          workspaceName,
          base: `origin/${baseRef}`,
          keepInBackground: true,
          projectPath: project.path,
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
            workspaceName,
            workspacePath,
            prNumber,
            repo,
            projectPath: project.path,
            createdAt: new Date().toISOString(),
          },
        },
      };

      deps.logger.info("PR workspace created", { prUrl, workspaceName });
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

    // Detect disappeared PRs → delete workspaces
    const disappearedUrls = Object.keys(state.workspaces).filter((url) => !openPrUrls.has(url));
    for (const prUrl of disappearedUrls) {
      const entry = state.workspaces[prUrl];
      if (entry) {
        await deletePrWorkspace(prUrl, entry);
      }
    }

    // Detect new PRs → create workspaces
    for (const item of items) {
      const prUrl = item.pull_request?.html_url ?? item.html_url;
      if (state.workspaces[prUrl]) continue; // already tracked

      const repo = repoFromApiUrl(item.repository_url);
      const prDetail = await fetchPrDetail(repo, item.number);
      if (!prDetail) continue;

      const repoDetail = await fetchRepoDetail(repo);
      if (!repoDetail) continue;

      await createPrWorkspace(
        prUrl,
        repo,
        item.number,
        prDetail.head.ref,
        repoDetail.clone_url,
        prDetail.base.ref
      );
    }

    // Persist after all changes
    if (
      disappearedUrls.length > 0 ||
      items.some((i) => {
        const url = i.pull_request?.html_url ?? i.html_url;
        return state.workspaces[url]?.createdAt !== undefined;
      })
    ) {
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
    if (!configEnabled) {
      deps.logger.debug("experimental.auto-pr-workspaces is disabled");
      return;
    }

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
        if ("experimental.auto-pr-workspaces" in values) {
          const newValue = values["experimental.auto-pr-workspaces"];
          configEnabled = newValue === true;
          // Only react to runtime toggles (after initial activate hook has run).
          // During startup, the activate hook handles initial activation.
          if (!initialActivationDone) return;
          if (newValue === true && !enabled) {
            void activate();
          } else if (newValue === false && enabled) {
            deactivate();
          }
        }
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        // If a tracked PR workspace is manually deleted, remove from mapping
        for (const [prUrl, entry] of Object.entries(state.workspaces)) {
          if (entry.workspacePath === workspacePath) {
            const filtered = Object.fromEntries(
              Object.entries(state.workspaces).filter(([key]) => key !== prUrl)
            );
            state = { ...state, workspaces: filtered };
            void saveState();
            deps.logger.info("Removed manually deleted PR workspace from tracking", {
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
