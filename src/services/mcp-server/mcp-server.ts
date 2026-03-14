/**
 * MCP Server implementation.
 *
 * Provides MCP (Model Context Protocol) server functionality for AI agent integration.
 * Uses the @modelcontextprotocol/sdk for protocol handling.
 *
 * Each connecting client (one per workspace) gets its own MCP session with a dedicated
 * transport + McpServerSdk pair. Sessions are created on-demand when a client sends an
 * initialize request, and cleaned up when the client disconnects or the server stops.
 *
 * Workspace resolution is handled by the intent system — the MCP server passes
 * workspacePath directly to API methods. For `create`, the agent provides
 * projectPath directly (discovered via `project_list` tool).
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
import type { IMcpServer, McpError, McpApiHandlers } from "./types";
import type { Logger, LogContext } from "../logging";
import { SILENT_LOGGER, logAtLevel } from "../logging";
import type { LogLevel } from "../logging/types";
import { getErrorMessage } from "../errors";
import {
  initialPromptSchema,
  normalizeInitialPrompt,
  type PromptModel,
} from "../../shared/api/types";

import { createOpencodeClient } from "@opencode-ai/sdk";

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
  "When creating a workspace with workspace_create, the initialPrompt parameter controls what the new workspace's agent will do.",
  "Use the object form { prompt, agent } to control the agent's permission mode:",
  '- agent: "plan" — the agent starts in read-only/plan mode. Use this when the task requires planning, research, or exploration before making changes.',
  "- No agent field — the agent starts with full permissions. Use this when the task should proceed directly to implementation.",
  "",
  "The model is automatically propagated from your current session — you do not need to specify it.",
  "",
  "When working with tool results, write down any important information you might need later in your response,",
  "as the original tool result may be cleared later.",
  "",
  "ui_show_message is a unified tool for all VS Code UI interactions. The type field controls the behavior:",
  '- "info", "warning", "error" — show a notification. Add options for action buttons.',
  '- "status" — update the status bar (single entry per workspace). Set message to null to clear it. hint is the tooltip.',
  '- "select" — show a selection dialog. With options: quick pick list. Without options: free text input. hint is the placeholder.',
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
export class McpServer implements IMcpServer {
  private readonly handlers: McpApiHandlers;
  private readonly serverFactory: McpServerFactory;
  private readonly logger: Logger;

  private httpServer: HttpServer | null = null;
  private running = false;

  /** Per-client MCP sessions, keyed by MCP session ID. */
  private sessions = new Map<string, McpSession>();

  constructor(
    handlers: McpApiHandlers,
    serverFactory: McpServerFactory = createDefaultMcpServer,
    logger?: Logger
  ) {
    this.handlers = handlers;
    this.serverFactory = serverFactory;
    this.logger = logger ?? SILENT_LOGGER;
  }

  /**
   * Start the MCP server on the specified port.
   * Only creates the HTTP server — MCP sessions are created on-demand per client.
   */
  async start(port: number): Promise<void> {
    if (this.running) {
      this.logger.warn("Server already running");
      return;
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

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, "127.0.0.1", () => {
        this.running = true;
        this.logger.info("Started", { port });
        resolve();
      });
      this.httpServer!.on("error", reject);
    });
  }

  /**
   * Stop the MCP server and close all sessions.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info("Stopping");

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
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
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
   * Dispose the server (alias for stop).
   */
  async dispose(): Promise<void> {
    await this.stop();
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
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) => this.handlers.getStatus(workspacePath))
    );

    // workspace_get_metadata
    mcpServer.registerTool(
      "workspace_get_metadata",
      {
        description:
          "Get all metadata for the current workspace. Always includes a 'base' key with the base branch name.",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) => this.handlers.getMetadata(workspacePath))
    );

    // workspace_set_metadata
    mcpServer.registerTool(
      "workspace_set_metadata",
      {
        description:
          "Set or delete a metadata key for the current workspace. " +
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
          await this.handlers.setMetadata(workspacePath, args.key, args.value);
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
      this.createWorkspaceHandler(async (workspacePath) =>
        this.handlers.getAgentSession(workspacePath)
      )
    );

    // workspace_restart_agent_server
    mcpServer.registerTool(
      "workspace_restart_agent_server",
      {
        description: "Restart the agent server for the current workspace, preserving the same port",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (workspacePath) =>
        this.handlers.restartAgentServer(workspacePath)
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
          const projects = await this.handlers.listProjects();
          return this.successResult(projects);
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
          initialPrompt: initialPromptSchema
            .optional()
            .describe(
              "Optional initial prompt to send after workspace is created. " +
                "Can be a string or { prompt, agent? }. " +
                'Set agent to "plan" for read-only/planning mode, ' +
                "or omit agent for full-permission implementation mode."
            ),
          stealFocus: z
            .boolean()
            .optional()
            .describe(
              "If true, switch to the new workspace (default: false = stay in background for API calls)"
            ),
        }),
      },
      async (args, extra) => {
        const workspacePath = this.getWorkspacePathFromExtra(extra);

        try {
          const projectPath = args.projectPath as string;
          const name = args.name as string;
          const base = args.base as string;
          const rawInitialPrompt = args.initialPrompt as
            | string
            | { prompt: string; agent?: string; model?: PromptModel }
            | undefined;
          // Default to false for API calls (stay in background)
          const stealFocus = (args.stealFocus as boolean | undefined) ?? false;

          // If initialPrompt provided, resolve model from caller's session if not specified
          let finalPrompt: { prompt: string; agent?: string; model?: PromptModel } | undefined;
          if (rawInitialPrompt !== undefined) {
            const normalized = normalizeInitialPrompt(rawInitialPrompt);

            // If no model specified, try to get caller's current model
            let model = normalized.model;
            if (!model && workspacePath) {
              model = await this.getCallerModel(workspacePath);
            }

            // Build final prompt with model if available
            finalPrompt = { prompt: normalized.prompt };
            if (normalized.agent !== undefined) {
              finalPrompt = { ...finalPrompt, agent: normalized.agent };
            }
            if (model !== undefined) {
              finalPrompt = { ...finalPrompt, model };
            }
          }

          const result = await this.handlers.createWorkspace({
            projectPath,
            name,
            base,
            ...(finalPrompt !== undefined && { initialPrompt: finalPrompt }),
            stealFocus,
          });
          return this.successResult(result);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // workspace_delete
    mcpServer.registerTool(
      "workspace_delete",
      {
        description: "Delete the current workspace. This will terminate the OpenCode session.",
        inputSchema: z.object({
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
        async (workspacePath, args: { keepBranch: boolean; ignoreWarnings: boolean }) => {
          return this.handlers.deleteWorkspace(workspacePath, {
            keepBranch: args.keepBranch,
            ignoreWarnings: args.ignoreWarnings,
          });
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
        async (workspacePath, args: { command: string; args?: unknown[] | undefined }) =>
          this.handlers.executeCommand(workspacePath, args.command, args.args)
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
          const result = await this.handlers.showMessage(workspacePath, {
            type: args.type,
            message: args.message,
            ...(args.hint !== undefined && { hint: args.hint }),
            ...(args.options !== undefined && { options: args.options }),
            ...(timeoutMs !== undefined && { timeoutMs }),
          });
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

    this.logger.debug("Registered tools", { count: 11 });
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
   * Get the model from the caller's current OpenCode session.
   * Used to propagate the model when creating a new workspace with an initial prompt.
   *
   * @param workspacePath - The workspace path of the caller
   * @returns The model from the most recent user message, or undefined if not available
   */
  private async getCallerModel(workspacePath: string): Promise<PromptModel | undefined> {
    try {
      // Get caller's OpenCode session
      const session = await this.handlers.getAgentSession(workspacePath);

      if (!session) {
        this.logger.debug("Cannot determine model: no OpenCode session running", {
          workspace: workspacePath,
        });
        return undefined;
      }

      // Query caller's OpenCode for current session's model
      const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${session.port}` });
      const sessions = await sdk.session.list();
      const activeSession = sessions.data?.[0];

      if (!activeSession) {
        this.logger.debug("Cannot determine model: no active session in caller workspace", {
          workspace: workspacePath,
        });
        return undefined;
      }

      const messages = await sdk.session.messages({ path: { id: activeSession.id } });
      const lastUserMessage = messages.data?.findLast((m) => m.info.role === "user");

      // SDK types don't include model field, but OpenCode returns it
      type UserMessageInfo = {
        role: string;
        model?: { providerID: string; modelID: string };
      };
      const userInfo = lastUserMessage?.info as UserMessageInfo | undefined;

      if (!userInfo?.model) {
        this.logger.debug("Cannot determine model: no user messages with model in caller session", {
          workspace: workspacePath,
          sessionId: activeSession.id,
        });
        return undefined;
      }

      // Extract model from the message info
      const model: PromptModel = {
        providerID: userInfo.model.providerID,
        modelID: userInfo.model.modelID,
      };

      this.logger.debug("Retrieved caller model", {
        workspace: workspacePath,
        model: `${model.providerID}/${model.modelID}`,
      });

      return model;
    } catch (error) {
      this.logger.warn("Failed to get caller model", {
        workspace: workspacePath,
        error: getErrorMessage(error),
      });
      return undefined;
    }
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
