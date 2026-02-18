/**
 * MCP Server implementation.
 *
 * Provides MCP (Model Context Protocol) server functionality for AI agent integration.
 * Uses the @modelcontextprotocol/sdk for protocol handling.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  McpServer as McpServerSdk,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IMcpServer, McpResolvedWorkspace, McpError, McpRequestCallback } from "./types";
import type { ICoreApi } from "../../shared/api/interfaces";
import type { Logger, LogContext } from "../logging";
import { SILENT_LOGGER, logAtLevel } from "../logging";
import type { LogLevel } from "../logging/types";
import { Path } from "../platform/path";
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
 * Tool handler context providing workspace resolution.
 */
interface ToolContext {
  readonly workspacePath: string;
  readonly resolved: McpResolvedWorkspace | null;
}

/**
 * Factory function type for creating MCP SDK instances.
 * Used for dependency injection and testability.
 */
export type McpServerFactory = () => McpServerSdk;

/**
 * Default factory that creates an MCP SDK server instance.
 */
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
].join("\n");

export function createDefaultMcpServer(): McpServerSdk {
  return new McpServerSdk(
    { name: "codehydra", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );
}

/**
 * MCP Server implementation.
 *
 * Provides HTTP-based MCP server that exposes workspace tools to AI agents.
 */
export class McpServer implements IMcpServer {
  private readonly api: ICoreApi;
  private readonly serverFactory: McpServerFactory;
  private readonly logger: Logger;
  private readonly onRequest: McpRequestCallback | undefined;
  private readonly workspaces = new Map<string, McpResolvedWorkspace>();

  private mcpServer: McpServerSdk | null = null;
  private httpServer: HttpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private running = false;

  // Store registered tools for cleanup
  private registeredTools: RegisteredTool[] = [];

  constructor(
    api: ICoreApi,
    serverFactory: McpServerFactory = createDefaultMcpServer,
    logger?: Logger,
    onRequest?: McpRequestCallback
  ) {
    this.api = api;
    this.serverFactory = serverFactory;
    this.logger = logger ?? SILENT_LOGGER;
    this.onRequest = onRequest;
  }

  /**
   * Register a workspace for tool resolution.
   */
  registerWorkspace(identity: McpResolvedWorkspace): void {
    this.workspaces.set(new Path(identity.workspacePath).toString(), identity);
  }

  /**
   * Unregister a workspace from tool resolution.
   */
  unregisterWorkspace(workspacePath: string): void {
    this.workspaces.delete(new Path(workspacePath).toString());
  }

  /**
   * Start the MCP server on the specified port.
   */
  async start(port: number): Promise<void> {
    if (this.running) {
      this.logger.warn("Server already running");
      return;
    }

    // Create MCP server instance
    this.mcpServer = this.serverFactory();

    // Register tools
    this.registerTools();

    // Create transport (stateless mode for per-request handling)
    // Empty options = stateless mode (no session ID generation)
    this.transport = new StreamableHTTPServerTransport({});

    // Connect MCP server to transport
    // Cast needed due to exactOptionalPropertyTypes mismatch between SDK types
    await this.mcpServer.connect(this.transport as Parameters<typeof this.mcpServer.connect>[0]);

    // Create HTTP server to handle incoming requests
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res);
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
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info("Stopping");

    // Close MCP server
    if (this.mcpServer) {
      await this.mcpServer.close();
      this.mcpServer = null;
    }

    // Close transport
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.registeredTools = [];
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
   * Handle incoming HTTP requests.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only handle POST requests to /mcp
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // Extract workspace path from header for context
    const workspacePath = this.getWorkspacePath(req);
    if (!workspacePath) {
      this.logger.warn("Request missing X-Workspace-Path header");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Workspace-Path header" }));
      return;
    }

    this.logger.debug("Handling request", { workspacePath });

    // Notify callback of incoming request (fire-and-forget)
    if (this.onRequest) {
      try {
        this.onRequest(workspacePath);
      } catch (error) {
        this.logger.error("onRequest callback error", { error: getErrorMessage(error) });
      }
    }

    // Attach auth info with workspace path to the request
    // The MCP SDK's StreamableHTTPServerTransport.handleRequest() accepts req.auth of type AuthInfo
    // which has an extra field for custom data that gets passed to tool handlers
    const reqWithAuth = req as IncomingMessage & {
      auth?: { token: string; clientId: string; scopes: string[]; extra?: Record<string, unknown> };
    };
    reqWithAuth.auth = {
      token: "codehydra",
      clientId: "codehydra",
      scopes: [],
      extra: { workspacePath },
    };

    // Delegate to transport
    this.transport!.handleRequest(reqWithAuth, res);
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
   * Create a workspace tool handler that resolves workspace and handles errors.
   */
  private createWorkspaceHandler<TArgs, TResult>(
    fn: (resolved: McpResolvedWorkspace, args: TArgs) => Promise<TResult>
  ): (
    args: TArgs,
    extra: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    return async (args: TArgs, extra: unknown) => {
      const context = await this.getToolContext(extra);
      if (!context.resolved) {
        return this.errorResult(
          "workspace-not-found",
          `Workspace not found: ${context.workspacePath}`
        );
      }

      try {
        const result = await fn(context.resolved, args);
        return this.successResult(result);
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Register all MCP tools.
   */
  private registerTools(): void {
    if (!this.mcpServer) {
      return;
    }

    // workspace_get_status
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_get_status",
        {
          description: "Get the current workspace status including dirty flag and agent status",
          inputSchema: z.object({}),
        },
        this.createWorkspaceHandler(async (resolved) =>
          this.api.workspaces.getStatus(resolved.projectId, resolved.workspaceName)
        )
      )
    );

    // workspace_get_metadata
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_get_metadata",
        {
          description: "Get all metadata for the current workspace",
          inputSchema: z.object({}),
        },
        this.createWorkspaceHandler(async (resolved) =>
          this.api.workspaces.getMetadata(resolved.projectId, resolved.workspaceName)
        )
      )
    );

    // workspace_set_metadata
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_set_metadata",
        {
          description: "Set or delete a metadata key for the current workspace",
          inputSchema: z.object({
            key: z
              .string()
              .describe(
                "Metadata key (must start with letter, contain only letters/digits/hyphens)"
              ),
            value: z
              .union([z.string(), z.null()])
              .describe("Value to set, or null to delete the key"),
          }),
        },
        this.createWorkspaceHandler(
          async (resolved, args: { key: string; value: string | null }) => {
            await this.api.workspaces.setMetadata(
              resolved.projectId,
              resolved.workspaceName,
              args.key,
              args.value
            );
            return null;
          }
        )
      )
    );

    // workspace_get_agent_session
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_get_agent_session",
        {
          description: "Get the agent session info (port and session ID) for the current workspace",
          inputSchema: z.object({}),
        },
        this.createWorkspaceHandler(async (resolved) =>
          this.api.workspaces.getAgentSession(resolved.projectId, resolved.workspaceName)
        )
      )
    );

    // workspace_restart_agent_server
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_restart_agent_server",
        {
          description:
            "Restart the agent server for the current workspace, preserving the same port",
          inputSchema: z.object({}),
        },
        this.createWorkspaceHandler(async (resolved) =>
          this.api.workspaces.restartAgentServer(resolved.projectId, resolved.workspaceName)
        )
      )
    );

    // workspace_create
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_create",
        {
          description:
            "Create a new workspace in the same project as the caller. Returns the created workspace.",
          inputSchema: z.object({
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
            keepInBackground: z
              .boolean()
              .optional()
              .describe(
                "If true, don't switch to the new workspace (default: true = stay in background for API calls)"
              ),
          }),
        },
        async (args, extra) => {
          const context = await this.getToolContext(extra);
          if (!context.resolved) {
            return this.errorResult(
              "workspace-not-found",
              `Workspace not found: ${context.workspacePath}`
            );
          }

          try {
            const resolved = context.resolved;
            const name = args.name as string;
            const base = args.base as string;
            const rawInitialPrompt = args.initialPrompt as
              | string
              | { prompt: string; agent?: string; model?: PromptModel }
              | undefined;
            // Default to true for API calls (keep in background)
            const keepInBackground = (args.keepInBackground as boolean | undefined) ?? true;

            // If initialPrompt provided, resolve model from caller's session if not specified
            let finalPrompt: { prompt: string; agent?: string; model?: PromptModel } | undefined;
            if (rawInitialPrompt !== undefined) {
              const normalized = normalizeInitialPrompt(rawInitialPrompt);

              // If no model specified, try to get caller's current model
              let model = normalized.model;
              if (!model) {
                model = await this.getCallerModel(resolved);
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

            // Create workspace with options
            const result = await this.api.workspaces.create(resolved.projectId, name, base, {
              ...(finalPrompt !== undefined && { initialPrompt: finalPrompt }),
              ...(keepInBackground && { keepInBackground }),
            });
            return this.successResult(result);
          } catch (error) {
            return this.handleError(error);
          }
        }
      )
    );

    // workspace_delete
    this.registeredTools.push(
      this.mcpServer.registerTool(
        "workspace_delete",
        {
          description: "Delete the current workspace. This will terminate the OpenCode session.",
          inputSchema: z.object({
            keepBranch: z
              .boolean()
              .optional()
              .default(false)
              .describe("If true, keep the git branch after deleting the worktree"),
          }),
        },
        this.createWorkspaceHandler(async (resolved, args: { keepBranch: boolean }) =>
          this.api.workspaces.remove(resolved.projectId, resolved.workspaceName, {
            keepBranch: args.keepBranch,
          })
        )
      )
    );

    // workspace_execute_command
    this.registeredTools.push(
      this.mcpServer.registerTool(
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
          async (resolved, args: { command: string; args?: unknown[] | undefined }) =>
            this.api.workspaces.executeCommand(
              resolved.projectId,
              resolved.workspaceName,
              args.command,
              args.args
            )
        )
      )
    );

    // log - different pattern, doesn't require workspace resolution
    this.registeredTools.push(
      this.mcpServer.registerTool(
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
          const context = await this.getToolContext(extra);
          const level = args.level as LogLevel;
          const logContext: LogContext = {
            ...(args.context ?? {}),
            workspace: context.workspacePath,
          };

          logAtLevel(this.logger, level, args.message, logContext);

          return this.successResult(null);
        }
      )
    );

    this.logger.debug("Registered tools", { count: this.registeredTools.length });
  }

  /**
   * Get tool context from extra info.
   * The workspace path is passed via req.auth.extra.workspacePath which becomes
   * extra.authInfo.extra.workspacePath in tool handlers.
   */
  private async getToolContext(extra: unknown): Promise<ToolContext> {
    let workspacePath = "";

    // Extract from extra.authInfo.extra.workspacePath
    if (extra && typeof extra === "object" && "authInfo" in extra) {
      const authInfo = (extra as { authInfo?: unknown }).authInfo;
      if (authInfo && typeof authInfo === "object" && "extra" in authInfo) {
        const authExtra = (authInfo as { extra?: unknown }).extra;
        if (authExtra && typeof authExtra === "object" && "workspacePath" in authExtra) {
          workspacePath = String((authExtra as { workspacePath: unknown }).workspacePath);
        }
      }
    }

    // Resolve workspace from internal registry
    let resolved: McpResolvedWorkspace | null = null;
    if (workspacePath) {
      try {
        const key = new Path(workspacePath).toString();
        resolved = this.workspaces.get(key) ?? null;
      } catch {
        resolved = null;
      }
    }

    return {
      workspacePath,
      resolved,
    };
  }

  /**
   * Get the model from the caller's current OpenCode session.
   * Used to propagate the model when creating a new workspace with an initial prompt.
   *
   * @param resolved - The resolved workspace info for the caller
   * @returns The model from the most recent user message, or undefined if not available
   */
  private async getCallerModel(resolved: McpResolvedWorkspace): Promise<PromptModel | undefined> {
    try {
      // Get caller's OpenCode session
      const session = await this.api.workspaces.getAgentSession(
        resolved.projectId,
        resolved.workspaceName
      );

      if (!session) {
        this.logger.debug("Cannot determine model: no OpenCode session running", {
          projectId: resolved.projectId,
          workspaceName: resolved.workspaceName,
        });
        return undefined;
      }

      // Query caller's OpenCode for current session's model
      const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${session.port}` });
      const sessions = await sdk.session.list();
      const activeSession = sessions.data?.[0];

      if (!activeSession) {
        this.logger.debug("Cannot determine model: no active session in caller workspace", {
          projectId: resolved.projectId,
          workspaceName: resolved.workspaceName,
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
          projectId: resolved.projectId,
          workspaceName: resolved.workspaceName,
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
        projectId: resolved.projectId,
        workspaceName: resolved.workspaceName,
        model: `${model.providerID}/${model.modelID}`,
      });

      return model;
    } catch (error) {
      this.logger.warn("Failed to get caller model", {
        projectId: resolved.projectId,
        workspaceName: resolved.workspaceName,
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
