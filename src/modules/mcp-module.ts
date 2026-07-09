/**
 * McpModule - MCP server lifecycle management.
 *
 * Hook handlers:
 * - app:start / start: start MCP server, return mcpPort
 * - app:shutdown / stop: dispose MCP server
 *
 * McpServerManager is an internal implementation detail of this module.
 *
 * Workspace registration is no longer needed — the MCP server passes
 * workspacePath directly to API methods, and the intent system resolves
 * workspace identity via hook modules.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer as McpServerSdk } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DomainEvent } from "../intents/lib/types";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { PortManager } from "../boundaries/platform/network";
import type { Logger, LogContext } from "../boundaries/platform/logging";
import { SILENT_LOGGER, logAtLevel } from "../boundaries/platform/logging";
import type { LogLevel } from "../boundaries/platform/logging-types";
import type { IDisposable } from "../shared/types";
import { getErrorMessage } from "../shared/errors/service-errors";
import { type Workspace, type DeletionProgress } from "../shared/api/types";

// Intent types for direct dispatch
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../intents/get-workspace-status";
import { INTENT_GET_METADATA } from "../intents/get-metadata";
import type { GetMetadataIntent } from "../intents/get-metadata";
import { INTENT_SET_METADATA } from "../intents/set-metadata";
import type { SetMetadataIntent } from "../intents/set-metadata";
import { INTENT_GET_AGENT_SESSION } from "../intents/get-agent-session";
import type { GetAgentSessionIntent } from "../intents/get-agent-session";
import { INTENT_RESTART_AGENT } from "../intents/restart-agent";
import type { RestartAgentIntent } from "../intents/restart-agent";
import { INTENT_HIBERNATE_WORKSPACE } from "../intents/hibernate-workspace";
import type { HibernateWorkspaceIntent } from "../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE } from "../intents/wake-workspace";
import type { WakeWorkspaceIntent } from "../intents/wake-workspace";
import { INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import type { OpenWorkspaceIntent } from "../intents/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETION_PROGRESS,
} from "../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  WorkspaceDeletionProgressEvent,
} from "../intents/delete-workspace";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";
import type { ListProjectsIntent } from "../intents/list-projects";
import { INTENT_VSCODE_SHOW_MESSAGE } from "../intents/vscode-show-message";
import type { VscodeShowMessageIntent } from "../intents/vscode-show-message";
import { INTENT_VSCODE_COMMAND } from "../intents/vscode-command";
import type { VscodeCommandIntent } from "../intents/vscode-command";
import { INTENT_SUBMIT_BUG_REPORT } from "../intents/submit-bug-report";
import type { SubmitBugReportIntent } from "../intents/submit-bug-report";

/**
 * Optional target workspace path for tools that can act on a workspace other
 * than the session's own (hibernate/wake/delete). Omit to target the current
 * workspace; use project_list to discover other workspaces' paths.
 */
const targetWorkspacePathSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Path of the workspace to act on. Omit to target the current workspace. " +
      "Use project_list to discover other workspaces' paths."
  );

/**
 * Build a human-readable failure message from a terminal deletion-progress
 * event, preferring blocking-process detail when present and otherwise
 * summarizing the failed pipeline steps.
 */
function formatDeletionFailure(progress: DeletionProgress): string {
  const blockers = progress.blockingProcesses;
  if (blockers && blockers.length > 0) {
    const list = blockers.map((p) => `pid ${p.pid} (${p.name})`).join(", ");
    return `Workspace deletion blocked by ${blockers.length} process(es): ${list}`;
  }
  const stepErrors = progress.operations
    .filter((op) => op.error)
    .map((op) => `${op.label}: ${op.error}`);
  if (stepErrors.length > 0) {
    return `Workspace deletion failed: ${stepErrors.join("; ")}`;
  }
  return "Workspace deletion failed";
}

// =============================================================================
// MCP Type Definitions
// =============================================================================

/**
 * MCP error codes.
 */
export type McpErrorCode = "workspace-not-found" | "internal-error";

/**
 * MCP error structure.
 */
export interface McpError {
  readonly code: McpErrorCode;
  readonly message: string;
}

// =============================================================================
// MCP Server Implementation
// =============================================================================

/**
 * X-Workspace-Path header name.
 */
const WORKSPACE_PATH_HEADER = "x-workspace-path";

/**
 * MCP session ID header name.
 */
const MCP_SESSION_HEADER = "mcp-session-id";

/**
 * Factory function type for creating MCP SDK instances.
 * Used for dependency injection and testability.
 */
export type McpServerFactory = () => McpServerSdk;

/**
 * Server-level instructions surfaced to AI agents via MCP initialize response.
 * Guides agents on how to use CodeHydra tools effectively.
 */
export const SERVER_INSTRUCTIONS = [
  "CodeHydra manages workspaces as git worktrees, each with its own AI agent session.",
  "",
  "When creating a workspace with workspace_create, pass an optional prompt to tell the new workspace's agent what to do.",
  "The prompt runs under the workspace agent's default mode and model; backend selection, permission mode and model are configured on the CodeHydra side, not via this tool.",
  "",
  "When working with tool results, write down any important information you might need later in your response,",
  "as the original tool result may be cleared later.",
  "",
  "ui_show_message is a unified tool for all VS Code UI interactions. The type field controls the behavior:",
  '- "info", "warning", "error" — show a notification. Add options for action buttons.',
  '- "status" — update the status bar (single entry per workspace). Set message to null to clear it. hint is the tooltip.',
  '- "select" — show a selection dialog. With options: quick pick list. Without options: free text input. hint is the placeholder.',
  "",
  "report_bug files a bug report about CodeHydra itself with the maintainers. Use it only when the user explicitly asks to report a CodeHydra bug or send feedback — never proactively. It attaches CodeHydra's current logs and redacted config and sends even if telemetry is off.",
].join("\n");

export function createDefaultMcpServer(): McpServerSdk {
  return new McpServerSdk(
    { name: "codehydra", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );
}

/**
 * Per-client MCP session.
 * Each workspace's Claude Code gets its own session with a dedicated transport + server pair.
 */
interface McpSession {
  mcpServer: McpServerSdk;
  transport: StreamableHTTPServerTransport;
  workspacePath: string;
}

/**
 * MCP Server implementation.
 *
 * Provides HTTP-based MCP server that exposes workspace tools to AI agents.
 * Each connecting client gets a dedicated MCP session with its own transport and server.
 * Workspace resolution is delegated to the intent system via workspacePath-based API methods.
 */
export class McpServer {
  private readonly dispatcher: Dispatcher;
  private readonly portManager: Pick<PortManager, "listenOnFreePort">;
  private readonly serverFactory: McpServerFactory;
  private readonly logger: Logger;

  private httpServer: HttpServer | null = null;
  private boundPort: number | null = null;
  private running = false;

  /** Per-client MCP sessions, keyed by MCP session ID. */
  private sessions = new Map<string, McpSession>();

  /**
   * Resolvers awaiting a terminal deletion-progress event, keyed by workspace
   * path. A single dispatcher subscription (set up in start()) routes terminal
   * events to these waiters so workspace_delete can report the real outcome.
   */
  private deletionWaiters = new Map<string, Set<(progress: DeletionProgress) => void>>();

  /** Unsubscribe handle for the deletion-progress subscription. */
  private unsubscribeDeletionProgress: (() => void) | null = null;

  constructor(
    dispatcher: Dispatcher,
    portManager: Pick<PortManager, "listenOnFreePort">,
    serverFactory: McpServerFactory = createDefaultMcpServer,
    logger?: Logger
  ) {
    this.dispatcher = dispatcher;
    this.portManager = portManager;
    this.serverFactory = serverFactory;
    this.logger = logger ?? SILENT_LOGGER;
  }

  /**
   * Start the MCP server on an OS-assigned free port.
   * Only creates the HTTP server — MCP sessions are created on-demand per client.
   *
   * @returns The port the server is listening on
   */
  async start(): Promise<number> {
    if (this.running) {
      this.logger.warn("Server already running");
      return this.boundPort!;
    }

    // Subscribe once to terminal deletion-progress events so workspace_delete
    // can surface the real outcome to callers (subscribe() leaks its handler on
    // unsubscribe, so this must be per-server, not per-call).
    if (!this.unsubscribeDeletionProgress) {
      this.unsubscribeDeletionProgress = this.dispatcher.subscribe(
        EVENT_WORKSPACE_DELETION_PROGRESS,
        (event) => this.handleDeletionProgress(event)
      );
    }

    // Create HTTP server to handle incoming requests
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("Request handling failed", { error: getErrorMessage(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            })
          );
        }
      });
    });

    // Bind and discover in one step; a port discovered up front can be lost
    // again before listen() reaches it.
    try {
      this.boundPort = await this.portManager.listenOnFreePort(this.httpServer, "127.0.0.1");
    } catch (error) {
      this.httpServer = null;
      throw error;
    }

    this.running = true;
    this.logger.info("Started", { port: this.boundPort });
    return this.boundPort;
  }

  /**
   * Stop the MCP server and close all sessions.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info("Stopping");

    // Stop routing deletion-progress events and drop any pending waiters.
    this.unsubscribeDeletionProgress?.();
    this.unsubscribeDeletionProgress = null;
    this.deletionWaiters.clear();

    // Close all MCP sessions
    for (const [sessionId, session] of this.sessions) {
      try {
        await session.mcpServer.close();
      } catch {
        this.logger.warn("Failed to close MCP server for session", { sessionId });
      }
      try {
        await session.transport.close();
      } catch {
        this.logger.warn("Failed to close transport for session", { sessionId });
      }
    }
    this.sessions.clear();

    // Close HTTP server
    const httpServer = this.httpServer;
    this.httpServer = null;
    this.boundPort = null;
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    }

    this.running = false;
    this.logger.info("Stopped");
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle incoming HTTP requests with per-session routing.
   *
   * - POST without mcp-session-id: create a new session (initialize)
   * - POST/GET/DELETE with mcp-session-id: route to existing session
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const sessionId = this.getSessionId(req);

    if (sessionId) {
      // Route to existing session
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }

      this.logger.debug("Routing to session", {
        sessionId,
        workspacePath: session.workspacePath,
        method: req.method ?? "unknown",
      });

      // Inject stored workspace path into auth info and delegate
      this.attachAuth(req, session.workspacePath);
      await session.transport.handleRequest(this.asAuthRequest(req), res);
    } else if (req.method === "POST") {
      // New session — initialize
      await this.handleNewSession(req, res);
    } else {
      // Non-POST without session ID
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
          id: null,
        })
      );
    }
  }

  /**
   * Create a new MCP session for a connecting client.
   * Creates a dedicated transport + McpServerSdk pair and registers all tools.
   */
  private async handleNewSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Workspace path is required to bind the session to a workspace
    const workspacePath = this.getWorkspacePath(req);
    if (!workspacePath) {
      this.logger.warn("Initialize request missing X-Workspace-Path header");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Workspace-Path header" }));
      return;
    }

    // Create per-session MCP server and register tools
    const mcpServer = this.serverFactory();
    this.registerTools(mcpServer);

    // Create per-session transport with session management callbacks
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        this.sessions.set(newSessionId, { mcpServer, transport, workspacePath });
        this.logger.info("Session created", { sessionId: newSessionId, workspacePath });
      },
      onsessionclosed: (closedSessionId) => {
        if (closedSessionId) {
          this.sessions.delete(closedSessionId);
          this.logger.info("Session closed", { sessionId: closedSessionId });
        }
      },
    });

    // Connect MCP server to transport
    // Cast needed due to exactOptionalPropertyTypes mismatch between SDK types
    await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);

    // Attach workspace path and delegate the initialize request
    this.attachAuth(req, workspacePath);
    await transport.handleRequest(this.asAuthRequest(req), res);
  }

  /**
   * Get MCP session ID from request header.
   */
  private getSessionId(req: IncomingMessage): string | null {
    const header = req.headers[MCP_SESSION_HEADER];
    if (typeof header === "string" && header.length > 0) {
      return header;
    }
    return null;
  }

  /**
   * Get workspace path from request header.
   */
  private getWorkspacePath(req: IncomingMessage): string | null {
    const header = req.headers[WORKSPACE_PATH_HEADER];
    if (typeof header === "string" && header.length > 0) {
      return header;
    }
    return null;
  }

  /**
   * Attach auth info with workspace path to the request.
   * The MCP SDK's StreamableHTTPServerTransport.handleRequest() accepts req.auth of type AuthInfo
   * which has an extra field for custom data that gets passed to tool handlers.
   */
  private attachAuth(req: IncomingMessage, workspacePath: string): void {
    const reqWithAuth = req as IncomingMessage & {
      auth?: { token: string; clientId: string; scopes: string[]; extra?: Record<string, unknown> };
    };
    reqWithAuth.auth = {
      token: "codehydra",
      clientId: "codehydra",
      scopes: [],
      extra: { workspacePath },
    };
  }

  /**
   * Cast request to the type expected by StreamableHTTPServerTransport.handleRequest().
   * Must be called after attachAuth() which sets the auth property.
   */
  private asAuthRequest(
    req: IncomingMessage
  ): Parameters<StreamableHTTPServerTransport["handleRequest"]>[0] {
    return req as Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
  }

  /**
   * Create a workspace tool handler that passes workspacePath and handles errors.
   */
  private createWorkspaceHandler<TArgs, TResult>(
    fn: (workspacePath: string, args: TArgs) => Promise<TResult>
  ): (
    args: TArgs,
    extra: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    return async (args: TArgs, extra: unknown) => {
      const workspacePath = this.getWorkspacePathFromExtra(extra);
      if (!workspacePath) {
        return this.errorResult("workspace-not-found", "Missing workspace path");
      }

      try {
        const result = await fn(workspacePath, args);
        return this.successResult(result);
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Register all MCP tools on the given server instance.
   */
  private registerTools(mcpServer: McpServerSdk): void {
    // workspace_get_status
    mcpServer.registerTool(
      "workspace_get_status",
      {
        description: "Get the current workspace status including dirty flag and agent status",
        inputSchema: z.object({ refresh: z.boolean().optional() }),
      },
      this.createWorkspaceHandler(
        async (workspacePath, args: { refresh?: boolean | undefined }) => {
          const result = await this.dispatcher.dispatch({
            type: INTENT_GET_WORKSPACE_STATUS,
            payload: {
              workspacePath,
              ...(typeof args.refresh === "boolean" && { refresh: args.refresh }),
            },
          } as GetWorkspaceStatusIntent);
          if (!result) throw new Error("Get workspace status dispatch returned no result");
          return result;
        }
      )
    );

    // workspace_get_metadata
    mcpServer.registerTool(
      "workspace_get_metadata",
      {
        description:
          "Get all metadata for the current workspace. Always includes a 'base' key with the base branch name.",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) => {
        const result = await this.dispatcher.dispatch({
          type: INTENT_GET_METADATA,
          payload: { workspacePath },
        } as GetMetadataIntent);
        if (!result) throw new Error("Get metadata dispatch returned no result");
        return result;
      })
    );

    // workspace_set_metadata
    mcpServer.registerTool(
      "workspace_set_metadata",
      {
        description:
          "Set or delete a metadata key for the current workspace. " +
          "Use key 'title' to set the workspace's sidebar display title; set value to null to delete/clear the title and revert the row to the branch name (this is how you 'delete the workspace title' — do not use workspace_delete for that). " +
          "To set tags, use the 'tags.' prefix for the key (e.g., key: 'tags.bugfix'). " +
          "The value is a JSON object with an optional color field: '{\"color\":\"#ff0000\"}' or '{}' for no color. " +
          "To remove a tag, set value to null.",
        inputSchema: z.object({
          key: z
            .string()
            .describe("Metadata key (must start with letter, contain only letters/digits/hyphens)"),
          value: z
            .union([z.string(), z.null()])
            .describe("Value to set, or null to delete the key"),
        }),
      },
      this.createWorkspaceHandler(
        async (workspacePath, args: { key: string; value: string | null }) => {
          await this.dispatcher.dispatch({
            type: INTENT_SET_METADATA,
            payload: { workspacePath, key: args.key, value: args.value },
          } as SetMetadataIntent);
          return null;
        }
      )
    );

    // workspace_get_agent_session
    mcpServer.registerTool(
      "workspace_get_agent_session",
      {
        description: "Get the agent session info (port and session ID) for the current workspace",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) => {
        return this.dispatcher.dispatch({
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath },
        } as GetAgentSessionIntent);
      })
    );

    // workspace_restart_agent_server
    mcpServer.registerTool(
      "workspace_restart_agent_server",
      {
        description: "Restart the agent server for the current workspace, preserving the same port",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) => {
        const result = await this.dispatcher.dispatch({
          type: INTENT_RESTART_AGENT,
          payload: { workspacePath },
        } as RestartAgentIntent);
        if (result === undefined) throw new Error("Restart agent dispatch returned no result");
        return result;
      })
    );

    // workspace_hibernate
    mcpServer.registerTool(
      "workspace_hibernate",
      {
        description:
          "Hibernate a workspace: tears down its view and agent server to free " +
          "resources, while keeping the git worktree on disk. The workspace stays listed and " +
          "can be brought back online with workspace_wake. Returns { started: true } once " +
          "hibernation has begun — teardown completes in the background. " +
          "Omit workspacePath to hibernate the current workspace.",
        inputSchema: z.object({
          workspacePath: targetWorkspacePathSchema,
        }),
      },
      this.createWorkspaceHandler(
        async (sessionWorkspacePath, args: { workspacePath?: string | undefined }) => {
          const workspacePath = args.workspacePath ?? sessionWorkspacePath;
          const intent: HibernateWorkspaceIntent = {
            type: INTENT_HIBERNATE_WORKSPACE,
            payload: { workspacePath },
          };
          const handle = this.dispatcher.dispatch(intent);
          if (!(await handle.accepted)) {
            return { started: false };
          }
          await handle;
          return { started: true };
        }
      )
    );

    // workspace_wake
    mcpServer.registerTool(
      "workspace_wake",
      {
        description:
          "Wake a hibernated workspace: clears the hibernated flag and brings " +
          "the workspace back online (recreates its view and restarts its agent server). " +
          "Returns the reopened workspace. Does not steal focus. " +
          "Omit workspacePath to wake the current workspace.",
        inputSchema: z.object({
          workspacePath: targetWorkspacePathSchema,
        }),
      },
      this.createWorkspaceHandler(
        async (sessionWorkspacePath, args: { workspacePath?: string | undefined }) => {
          const workspacePath = args.workspacePath ?? sessionWorkspacePath;
          // The wake operation clears the hibernated flag AND reopens the
          // workspace (restarts the agent server, rebuilds the view) in one step.
          // stealFocus:false keeps it in the background for API callers; source
          // "mcp" suppresses interactive error notifications.
          const result = await this.dispatcher.dispatch({
            type: INTENT_WAKE_WORKSPACE,
            payload: { workspacePath, stealFocus: false, source: "mcp" },
          } as WakeWorkspaceIntent);
          if (!result) throw new Error("Wake workspace dispatch returned no result");
          return result as Workspace;
        }
      )
    );

    // project_list
    mcpServer.registerTool(
      "project_list",
      {
        description:
          "List all open projects with their workspaces. " +
          "Call this before workspace_create to discover available projects and their projectPath values.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const result = await this.dispatcher.dispatch({
            type: INTENT_LIST_PROJECTS,
            payload: {} as Record<string, never>,
          } as ListProjectsIntent);
          if (!result) throw new Error("List projects dispatch returned no result");
          return this.successResult(result);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // workspace_create
    mcpServer.registerTool(
      "workspace_create",
      {
        description:
          "Create a new workspace in the specified project. " +
          "Requires projectPath — use project_list to discover available projects. " +
          "Returns the created workspace.",
        inputSchema: z.object({
          projectPath: z
            .string()
            .min(1)
            .describe(
              "Project path to create the workspace in. Use project_list to discover available projects."
            ),
          name: z.string().min(1).describe("Name for the new workspace (becomes branch name)"),
          base: z.string().min(1).describe("Base branch to create the workspace from"),
          tracking: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Remote branch to check out (e.g., 'origin/feature-login'). " +
                "When set, the local branch is created at this ref with upstream configured. " +
                "Must be a valid remote-tracking branch."
            ),
          prompt: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Optional initial prompt to send after the workspace is created. " +
                "The workspace's agent runs it under that agent's default mode."
            ),
          stealFocus: z
            .boolean()
            .optional()
            .describe(
              "If true, switch to the new workspace (default: false = stay in background for API calls)"
            ),
        }),
      },
      async (args) => {
        try {
          const projectPath = args.projectPath as string;
          const name = args.name as string;
          const base = args.base as string;
          const tracking = args.tracking as string | undefined;
          const prompt = args.prompt as string | undefined;
          // Default to false for API calls (stay in background)
          const stealFocus = (args.stealFocus as boolean | undefined) ?? false;

          const intent: OpenWorkspaceIntent = {
            type: INTENT_OPEN_WORKSPACE,
            payload: {
              projectPath,
              workspaceName: name,
              base,
              ...(tracking !== undefined && { tracking }),
              // Prompt-only under the resolved-default backend.
              ...(prompt !== undefined && { agent: { type: "default", prompt } }),
              stealFocus,
              source: "mcp",
            },
          };
          const result = await this.dispatcher.dispatch(intent);
          if (!result) throw new Error("Create workspace dispatch returned no result");
          return this.successResult(result as Workspace);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // workspace_delete
    mcpServer.registerTool(
      "workspace_delete",
      {
        description:
          "Delete a workspace: terminates its agent session and removes the git worktree. " +
          "This removes the entire workspace, not a label — to delete or change a workspace's " +
          "display title, use workspace_set_metadata with key 'title' (value null clears it), " +
          "NOT this tool. " +
          "Omit workspacePath to delete the current workspace, or pass a path to delete " +
          "another workspace (use project_list to discover paths). Blocks until deletion " +
          "finishes and returns { started: true } on success. Fails with an error if the " +
          "target has uncommitted changes or unmerged commits (pass ignoreWarnings to " +
          "override) or if processes block worktree removal.",
        inputSchema: z.object({
          workspacePath: targetWorkspacePathSchema,
          keepBranch: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, keep the git branch after deleting the worktree"),
          ignoreWarnings: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, skip checks for uncommitted changes and unmerged commits"),
        }),
      },
      this.createWorkspaceHandler(
        async (
          sessionWorkspacePath,
          args: {
            workspacePath?: string | undefined;
            keepBranch: boolean;
            ignoreWarnings: boolean;
          }
        ) => {
          const workspacePath = args.workspacePath ?? sessionWorkspacePath;

          // Capture the terminal deletion-progress event so we can report the
          // real outcome. ctx.emit is not awaited inside the delete operation,
          // so we wait on this event explicitly rather than reading state after
          // `await handle` (which would race the emit).
          let resolveOutcome!: (progress: DeletionProgress) => void;
          const outcome = new Promise<DeletionProgress>((resolve) => {
            resolveOutcome = resolve;
          });
          const removeWaiter = this.registerDeletionWaiter(workspacePath, resolveOutcome);

          try {
            const intent: DeleteWorkspaceIntent = {
              type: INTENT_DELETE_WORKSPACE,
              payload: {
                workspacePath,
                keepBranch: args.keepBranch,
                force: false,
                removeWorktree: true,
                ignoreWarnings: args.ignoreWarnings,
              },
            };
            const handle = this.dispatcher.dispatch(intent);
            if (!(await handle.accepted)) {
              return { started: false };
            }
            // Preflight / unexpected failures reject the handle (no terminal
            // event is emitted) and propagate to an isError result.
            await handle;
            // Blocker / shutdown failures resolve the handle but report
            // hasErrors via the terminal event — surface them as an error.
            const progress = await outcome;
            if (progress.hasErrors) {
              throw new Error(formatDeletionFailure(progress));
            }
            return { started: true };
          } finally {
            removeWaiter();
          }
        }
      )
    );

    // workspace_execute_command
    mcpServer.registerTool(
      "workspace_execute_command",
      {
        description:
          "Execute a VS Code command in the current workspace. Most commands return undefined. " +
          "Commands requiring VS Code objects (Uri, Position, Range, Selection, Location) can use " +
          'the $vscode wrapper format. Example: { "$vscode": "Uri", "value": "file:///path/to/file.ts" }',
        inputSchema: z.object({
          command: z
            .string()
            .min(1)
            .max(256)
            .describe("VS Code command identifier (e.g., 'workbench.action.files.save')"),
          args: z
            .array(z.unknown())
            .optional()
            .describe(
              "Optional command arguments. Supports $vscode wrapper format for VS Code objects:\n" +
                '- Uri: { "$vscode": "Uri", "value": "file:///path/to/file.ts" }\n' +
                '- Position: { "$vscode": "Position", "line": 10, "character": 5 }\n' +
                '- Range: { "$vscode": "Range", "start": <Position>, "end": <Position> }\n' +
                '- Selection: { "$vscode": "Selection", "anchor": <Position>, "active": <Position> }\n' +
                '- Location: { "$vscode": "Location", "uri": <Uri>, "range": <Range> }'
            ),
        }),
      },
      this.createWorkspaceHandler(
        async (workspacePath, args: { command: string; args?: unknown[] | undefined }) => {
          return this.dispatcher.dispatch({
            type: INTENT_VSCODE_COMMAND,
            payload: { workspacePath, command: args.command, args: args.args },
          } as VscodeCommandIntent);
        }
      )
    );

    // ui_show_message — unified VS Code UI messaging
    mcpServer.registerTool(
      "ui_show_message",
      {
        description:
          "Show a message in the workspace's VS Code editor. Covers notifications, status bar, and selection dialogs.\n\n" +
          "**Types:**\n" +
          '- `"info"`, `"warning"`, `"error"` — Show a notification. Add `options` for action buttons (blocks until clicked/dismissed).\n' +
          '- `"status"` — Update the status bar. Supports codicon syntax: `$(icon-name) text`. ' +
          "Set `message` to `null` to clear it. `hint` is the tooltip on hover.\n" +
          '- `"select"` — Show a selection dialog. With `options`: quick pick list. Without `options`: free text input. ' +
          "`hint` is the placeholder text.\n\n" +
          "**Result:** `{ result: string | null }` — the selected option, clicked button, entered text, or null if dismissed.\n\n" +
          "**Examples:**\n" +
          '  Notification: { type: "info", message: "Build complete" }\n' +
          '  Notification with actions: { type: "warning", message: "Overwrite?", options: ["Yes", "No"] }\n' +
          '  Status bar: { type: "status", message: "$(sync~spin) Building...", hint: "Running build task" }\n' +
          '  Clear status bar: { type: "status", message: null }\n' +
          '  Quick pick: { type: "select", message: "Choose a file", options: ["a.ts", "b.ts"], hint: "Filter..." }\n' +
          '  Free text input: { type: "select", message: "Enter your name", hint: "Name" }',
        inputSchema: z.object({
          type: z
            .enum(["info", "warning", "error", "status", "select"])
            .describe(
              "Message type: info/warning/error (notification), status (status bar), select (picker or input)"
            ),
          message: z
            .string()
            .max(1000)
            .nullable()
            .describe(
              "Display text. Set to null to dismiss (only valid for status). " +
                'For status: supports codicon syntax "$(icon-name) text"'
            ),
          hint: z
            .string()
            .max(200)
            .optional()
            .describe("Secondary text: tooltip for status, placeholder for select"),
          options: z
            .array(z.string())
            .max(100)
            .optional()
            .describe(
              "Action buttons (notification) or selection items (select). Omit for free text input."
            ),
          timeout: z
            .number()
            .positive()
            .optional()
            .describe("Timeout in seconds for interactive operations. Default: no timeout."),
        }),
      },
      this.createWorkspaceHandler(
        async (
          workspacePath,
          args: {
            type: "info" | "warning" | "error" | "status" | "select";
            message: string | null;
            hint?: string | undefined;
            options?: string[] | undefined;
            timeout?: number | undefined;
          }
        ) => {
          const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;
          const result = await this.dispatcher.dispatch({
            type: INTENT_VSCODE_SHOW_MESSAGE,
            payload: {
              workspacePath,
              type: args.type,
              message: args.message,
              ...(args.hint !== undefined && { hint: args.hint }),
              ...(args.options !== undefined && { options: args.options }),
              ...(timeoutMs !== undefined && { timeoutMs }),
            },
          } as VscodeShowMessageIntent);
          return { result };
        }
      )
    );

    // log - different pattern, doesn't require workspace resolution
    mcpServer.registerTool(
      "log",
      {
        description:
          "Send a structured log message to CodeHydra's logging system. Logs appear with [mcp] scope.",
        inputSchema: z.object({
          level: z
            .enum(["silly", "debug", "info", "warn", "error"])
            .describe("Log level (silly=most verbose, error=least verbose)"),
          message: z.string().min(1).describe("Log message"),
          context: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional()
            .describe("Optional structured context data (primitives only)"),
        }),
      },
      async (args, extra) => {
        const workspacePath = this.getWorkspacePathFromExtra(extra);
        const level = args.level as LogLevel;
        const logContext: LogContext = {
          ...(args.context ?? {}),
          workspace: workspacePath,
        };

        logAtLevel(this.logger, level, args.message, logContext);

        return this.successResult(null);
      }
    );

    // report_bug - files a bug report through the same pipeline as the in-app
    // "Report a Bug" dialog. Non-workspace: reports are app-global and the
    // module attaches the current logs + redacted config/state itself.
    mcpServer.registerTool(
      "report_bug",
      {
        description:
          "File a bug report for CodeHydra itself (not the user's project). " +
          "Only use this when the user explicitly asks to report a bug or send feedback about CodeHydra — do not file reports proactively. " +
          "The report sends the given description together with CodeHydra's current application logs and redacted configuration to CodeHydra's maintainers, and is sent even if telemetry is disabled. " +
          "Returns { submitted: true } once the report has been sent.",
        inputSchema: z.object({
          description: z
            .string()
            .trim()
            .min(1)
            .describe("Description of the bug or feedback. Must be non-empty."),
        }),
      },
      async (args: { description: string }) => {
        try {
          await this.dispatcher.dispatch({
            type: INTENT_SUBMIT_BUG_REPORT,
            payload: { description: args.description },
          } as SubmitBugReportIntent);
          return this.successResult({ submitted: true });
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.logger.debug("Registered tools", { count: 12 });
  }

  /**
   * Extract workspace path from MCP extra info.
   * The workspace path is passed via req.auth.extra.workspacePath which becomes
   * extra.authInfo.extra.workspacePath in tool handlers.
   */
  private getWorkspacePathFromExtra(extra: unknown): string {
    if (extra && typeof extra === "object" && "authInfo" in extra) {
      const authInfo = (extra as { authInfo?: unknown }).authInfo;
      if (authInfo && typeof authInfo === "object" && "extra" in authInfo) {
        const authExtra = (authInfo as { extra?: unknown }).extra;
        if (authExtra && typeof authExtra === "object" && "workspacePath" in authExtra) {
          return String((authExtra as { workspacePath: unknown }).workspacePath);
        }
      }
    }
    return "";
  }

  /**
   * Route a terminal deletion-progress event to any waiters for that workspace.
   * Non-terminal (in-progress) events are ignored.
   */
  private handleDeletionProgress(event: DomainEvent): void {
    const progress = (event as WorkspaceDeletionProgressEvent).payload;
    if (!progress.completed) return;
    const waiters = this.deletionWaiters.get(progress.workspacePath);
    if (!waiters) return;
    this.deletionWaiters.delete(progress.workspacePath);
    for (const resolve of waiters) resolve(progress);
  }

  /**
   * Register a resolver that fires when the next terminal deletion-progress
   * event for the given workspace arrives. Returns a cleanup function that must
   * be called once the caller no longer needs the resolver.
   */
  private registerDeletionWaiter(
    workspacePath: string,
    resolve: (progress: DeletionProgress) => void
  ): () => void {
    let waiters = this.deletionWaiters.get(workspacePath);
    if (!waiters) {
      waiters = new Set();
      this.deletionWaiters.set(workspacePath, waiters);
    }
    waiters.add(resolve);
    return () => {
      const current = this.deletionWaiters.get(workspacePath);
      if (!current) return;
      current.delete(resolve);
      if (current.size === 0) this.deletionWaiters.delete(workspacePath);
    };
  }

  /**
   * Create a success result for MCP tools.
   * Handles undefined specially since JSON.stringify(undefined) returns undefined (not a string).
   */
  private successResult<T>(data: T): { content: Array<{ type: "text"; text: string }> } {
    return {
      content: [
        {
          type: "text",
          text: data === undefined ? "null" : JSON.stringify(data),
        },
      ],
    };
  }

  /**
   * Create an error result for MCP tools.
   */
  private errorResult(
    code: McpError["code"],
    message: string
  ): { content: Array<{ type: "text"; text: string }>; isError: true } {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code, message } }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Handle errors from API calls.
   */
  private handleError(error: unknown): {
    content: Array<{ type: "text"; text: string }>;
    isError: true;
  } {
    const message = getErrorMessage(error);
    this.logger.error("Tool error", { error: message });
    return this.errorResult("internal-error", message);
  }
}

// =============================================================================
// McpServerManager (module-private implementation)
// =============================================================================

/**
 * Configuration options for McpServerManager.
 */
export interface McpServerManagerConfig {
  /** Optional MCP server factory for testing */
  serverFactory?: McpServerFactory;
}

/**
 * Manages the MCP server lifecycle.
 *
 * Responsibilities:
 * - Allocate a dynamic port for the MCP server
 * - Start/stop the MCP server
 * - Provide the port for OpenCodeServerManager
 */
export class McpServerManager implements IDisposable {
  private readonly portManager: PortManager;
  private readonly dispatcher: Dispatcher;
  private readonly logger: Logger;
  private readonly serverFactory: McpServerFactory;

  private mcpServer: McpServer | null = null;
  private port: number | null = null;

  constructor(
    portManager: PortManager,
    dispatcher: Dispatcher,
    logger?: Logger,
    config?: McpServerManagerConfig
  ) {
    this.portManager = portManager;
    this.dispatcher = dispatcher;
    this.logger = logger ?? SILENT_LOGGER;
    this.serverFactory = config?.serverFactory ?? createDefaultMcpServer;
  }

  /**
   * Start the MCP server on an OS-assigned free port.
   *
   * @returns The port the server is listening on
   * @throws Error if server fails to start
   */
  async start(): Promise<number> {
    if (this.mcpServer?.isRunning()) {
      this.logger.warn("Server already running");
      return this.port!;
    }

    try {
      // Create and start the MCP server
      this.mcpServer = new McpServer(
        this.dispatcher,
        this.portManager,
        this.serverFactory,
        this.logger
      );
      this.port = await this.mcpServer.start();

      this.logger.info("Manager started", {
        port: this.port,
      });

      return this.port;
    } catch (error) {
      // Clean up on failure
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (this.mcpServer) {
      await this.mcpServer.stop();
      this.mcpServer = null;
    }

    this.port = null;
    this.logger.info("Manager stopped");
  }

  /**
   * Dispose the manager (alias for stop).
   */
  async dispose(): Promise<void> {
    await this.stop();
  }
}

// =============================================================================
// Dependencies
// =============================================================================

export interface McpModuleDeps {
  readonly portManager: PortManager;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly config?: McpServerManagerConfig;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createMcpModule(deps: McpModuleDeps): IntentModule {
  const mcpServerManager = new McpServerManager(
    deps.portManager,
    deps.dispatcher,
    deps.logger,
    deps.config
  );

  return {
    name: "mcp",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<HookOutput> => {
            const mcpPort = await mcpServerManager.start();
            return { provides: { mcpPort } };
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await mcpServerManager.dispose();
          },
        },
      },
    },
  };
}
