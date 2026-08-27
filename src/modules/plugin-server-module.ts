/**
 * PluginServerModule - Socket.IO server for VS Code extension communication.
 *
 * Closure-based module that manages the full plugin server lifecycle:
 * - Socket.IO server start/stop
 * - Client connection handling and authentication
 * - Per-workspace config management
 * - Plugin API event handlers that dispatch intents
 * - VS Code UI event proxying (notifications, status bar, quick pick, input box)
 * - VS Code command execution
 *
 * Provides `pluginPort` capability for ide-server-module.
 */

import { Server, type Socket } from "socket.io";
import { createServer, type Server as HttpServer } from "node:http";
import { dirname } from "node:path";
import { stat } from "node:fs/promises";

import type { OperationRegistry } from "../api/registry";
import { attachPluginAdapter, type ClientKind } from "../api/adapters/plugin";
import { EVENT_CHANNEL, FORWARDED_EVENTS, eventWorkspacePath } from "../api/events";
import type { DomainEvent } from "../intents/lib/types";
import {
  allWorkspaces,
  findWorkspaceContaining,
  resolveWorkspaceReference,
  type ProjectLocation,
} from "../api/workspace-lookup";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";
import type { ListProjectsIntent } from "../intents/list-projects";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Logger } from "../boundaries/platform/logging-types";
import { SILENT_LOGGER, logAtLevel } from "../boundaries/platform/logging";
import { LogLevel } from "../boundaries/platform/logging-types";
import type { PortManager } from "../boundaries/platform/network";
import type { Workspace, WorkspaceStatus } from "../shared/api/types";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketData,
  CommandRequest,
  PluginResult,
  PluginConfig,
  AgentType,
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  GetWorkspaceStatusRequest,
  LogContext,
  ShowNotificationRequest,
  ShowNotificationResponse,
  StatusBarUpdateRequest,
  StatusBarDisposeRequest,
  ShowQuickPickRequest,
  ShowQuickPickResponse,
  ShowInputBoxRequest,
  ShowInputBoxResponse,
} from "../shared/plugin-protocol";
import {
  COMMAND_TIMEOUT_MS,
  validateSetMetadataRequest,
  validateDeleteWorkspaceRequest,
  validateExecuteCommandRequest,
  validateOpenSystemPathRequest,
  validateWorkspaceCreateRequest,
  validateGetWorkspaceStatusRequest,
  validateLogRequest,
  validateAgentLifecycleRequest,
} from "../shared/plugin-protocol";
import type { OpenSystemPathRequest } from "../shared/plugin-protocol";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../intents/open-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import type {
  DeleteHookResult,
  DeletePipelineHookInput,
  ShutdownHookResult,
} from "../intents/delete-workspace";
import type { GetWorkspaceStatusIntent } from "../intents/get-workspace-status";
import type { GetAgentSessionIntent } from "../intents/get-agent-session";
import type { RestartAgentIntent } from "../intents/restart-agent";
import type { GetMetadataIntent } from "../intents/get-metadata";
import type { SetMetadataIntent } from "../intents/set-metadata";
import type { ResolveWorkspaceIntent } from "../intents/resolve-workspace";
import type { VscodeShowMessageIntent } from "../intents/vscode-show-message";
import type { ShowHookInput, ShowHookResult } from "../intents/vscode-show-message";
import type { VscodeCommandIntent } from "../intents/vscode-command";
import type { ExecuteHookInput, ExecuteHookResult } from "../intents/vscode-command";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../intents/delete-workspace";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../intents/get-agent-session";
import { INTENT_RESTART_AGENT } from "../intents/restart-agent";
import type { AgentLifecycleIntent } from "../intents/agent-lifecycle";
import { INTENT_AGENT_LIFECYCLE } from "../intents/agent-lifecycle";
import { INTENT_GET_METADATA } from "../intents/get-metadata";
import { INTENT_SET_METADATA } from "../intents/set-metadata";
import { INTENT_RESOLVE_WORKSPACE } from "../intents/resolve-workspace";
import { VSCODE_SHOW_MESSAGE_OPERATION_ID } from "../intents/vscode-show-message";
import { VSCODE_COMMAND_OPERATION_ID } from "../intents/vscode-command";
import { INTENT_VSCODE_COMMAND } from "../intents/vscode-command";
import type { AppBoundary } from "../boundaries/shell/app";
import { getErrorMessage } from "../shared/errors/service-errors";
import { Path } from "../utils/path/path";
import { workspacePathSchema } from "../intents/contract";
import type { WorkspacePath } from "../intents/contract";

// =============================================================================
// Types
// =============================================================================

/** Socket.IO Server type with typed events. */
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/** Socket.IO Socket type with typed events. */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// =============================================================================
// Constants
// =============================================================================

/** Fixed status bar item ID -- single entry per workspace. */
const STATUS_BAR_ID = "mcp";

/** Sidekick command that Ctrl+Cs the agent terminal and disposes it. */
const CLOSE_AGENT_COMMAND = "codehydra.closeAgent";

/**
 * How long to wait for the agent terminal to actually close during teardown.
 *
 * Must exceed the extension's own force-dispose deadline (3s, see
 * AGENT_CLOSE_TIMEOUT_MS in extensions/sidekick) so the graceful path gets to
 * finish before we give up on it — after that the terminal is disposed either
 * way and waiting longer only delays the teardown.
 */
const AGENT_CLOSE_TIMEOUT_MS = 5_000;

// =============================================================================
// Dependency Interfaces
// =============================================================================

export interface PluginServerModuleDeps {
  readonly portManager: Pick<PortManager, "listenOnFreePort">;
  readonly dispatcher: Dispatcher;
  readonly appLayer: Pick<AppBoundary, "openPath">;
  readonly logger: Logger;
  /**
   * Registry-backed operations, mounted for every connection.
   *
   * Optional so existing callers (and the boundary tests) can stand the server
   * up without one; when absent, only the hand-written channels are served.
   */
  readonly registry?: OperationRegistry;
  /**
   * The shared secret `ch` and the MCP shim must present.
   *
   * Read lazily because it is generated during app:start, after this module is
   * constructed. Returning null refuses every non-sidekick connection, which is
   * the correct posture before a token exists.
   */
  readonly cliToken?: () => string | null;
  readonly options?: PluginServerOptions;
}

export interface PluginServerOptions {
  /** Socket.IO transports to use. Default: ["websocket"] */
  readonly transports?: readonly ("polling" | "websocket")[];
  /** Whether the app is running in development mode. Default: false */
  readonly isDevelopment?: boolean;
  /** Logger for extension-side logs. Default: SILENT_LOGGER */
  readonly extensionLogger?: Logger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * The module plus a runtime readiness probe.
 *
 * `isReady()` exists for callers that fire a *best-effort* vscode command and
 * already treat "not connected yet" as normal — terminal focus on first idle,
 * notably. Dispatching anyway works, but the intent rejects and the dispatcher
 * logs that rejection at error level, so an expected startup condition ends up
 * in the log (and in every bug report) looking like a fault. Asking first keeps
 * the log honest; the caller's own retry-on-next-trigger still covers it.
 *
 * Do NOT use this to pre-check a command whose failure actually matters — the
 * hook still throws, and that error is the real signal.
 */
export interface PluginServerModuleHandle {
  readonly module: IntentModule;
  /** True once the Socket.IO server is listening (workspaces may still be connecting). */
  isReady(): boolean;
  /** The bound port, or null before the server has started. */
  port(): number | null;
}

export function createPluginServerModule(deps: PluginServerModuleDeps): PluginServerModuleHandle {
  const { portManager, dispatcher, appLayer, logger } = deps;
  const transports: readonly ("polling" | "websocket")[] = deps.options?.transports ?? [
    "websocket",
  ];
  const isDevelopment = deps.options?.isDevelopment ?? false;
  const extensionLogger: Logger = deps.options?.extensionLogger ?? SILENT_LOGGER;

  // ---------------------------------------------------------------------------
  // Closure state (replaces PluginServer class fields)
  // ---------------------------------------------------------------------------

  let httpServer: HttpServer | null = null;
  let io: TypedServer | null = null;
  let port: number | null = null;
  const connections = new Map<string, TypedSocket>();
  const workspaceConfigs = new Map<
    string,
    { env: Record<string, string>; agentType: AgentType; resetWorkspace: boolean }
  >();
  /**
   * Workspaces whose delete "shutdown" handler is currently running.
   *
   * Narrowly scoped on purpose. What makes a sidekick open an agent terminal is
   * receiving a complete config, and that is already prevented for the whole
   * teardown by `removeWorkspaceConfig` — the first thing the handler does. A
   * client connecting afterwards gets `env: null, agentType: null` and arms
   * nothing.
   *
   * What this set adds is protection for the window *inside* the handler, where
   * it asks the sidekick to close its agent terminal and waits for the report on
   * that socket. A reconnect in that window would be treated as a duplicate and
   * would hang up on the very socket being waited on — the report would never
   * arrive, the wait would burn its full timeout, and the agent process tree
   * would survive into the worktree removal.
   *
   * Held only for the handler's own execution and cleared in a `finally`, so
   * unlike a teardown-wide flag it cannot strand a workspace as permanently
   * unconnectable if a terminal event is ever missed.
   */
  const closingWorkspaces = new Set<string>();

  // ---------------------------------------------------------------------------
  // Server lifecycle functions
  // ---------------------------------------------------------------------------

  async function start(): Promise<number> {
    if (io) {
      return port!;
    }

    httpServer = createServer();
    io = new Server(httpServer, {
      transports: [...transports],
      cors: { origin: false },
    });

    setupEventHandlers();

    // One subscription per forwarded event for the life of the server, rather
    // than per connection: subscribe() leaks its handler on unsubscribe, so a
    // per-client subscription would accumulate one per `ch` invocation.
    eventSubscriptions = FORWARDED_EVENTS.map((type) =>
      dispatcher.subscribe(type, (event: DomainEvent) => forwardEvent(event))
    );

    // Bind and discover in one step; a port discovered up front can be lost
    // again before listen() reaches it.
    const assignedPort = await portManager.listenOnFreePort(httpServer, "127.0.0.1");
    port = assignedPort;
    logger.info("Started", { port: assignedPort });

    return assignedPort;
  }

  async function close(): Promise<void> {
    if (!io) {
      return;
    }

    for (const unsubscribe of eventSubscriptions) unsubscribe();
    eventSubscriptions = [];
    eventClients.clear();

    logger.info("Closing");

    for (const socket of connections.values()) {
      socket.disconnect(true);
    }
    connections.clear();
    workspaceConfigs.clear();

    await new Promise<void>((resolve) => {
      io!.close(() => {
        resolve();
      });
    });

    httpServer!.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer!.close(() => {
        resolve();
      });
    });

    io = null;
    httpServer = null;
    port = null;

    logger.info("Closed");
  }

  // ---------------------------------------------------------------------------
  // Command sending
  // ---------------------------------------------------------------------------

  async function sendCommand(
    workspacePath: WorkspacePath,
    command: string,
    args?: readonly unknown[],
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<unknown>> {
    const normalized = new Path(workspacePath).toString();
    const socket = connections.get(normalized);

    if (!socket) {
      return { success: false, error: "Workspace not connected" };
    }

    if (!socket.connected) {
      connections.delete(normalized);
      return { success: false, error: "Workspace disconnected" };
    }

    const request: CommandRequest = args !== undefined ? { command, args } : { command };

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn("Command timeout", { workspace: normalized, command, timeoutMs });
        resolve({ success: false, error: "Command timed out" });
      }, timeoutMs);

      socket.emit("command", request, (result: PluginResult<unknown>) => {
        clearTimeout(timeoutId);
        logger.debug("Command result", {
          workspace: normalized,
          command,
          success: result.success,
        });
        resolve(result);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Graceful agent shutdown
  // ---------------------------------------------------------------------------

  /**
   * Clients that receive forwarded domain events.
   *
   * Separate from `connections`, which is the sidekick registry and carries
   * teardown meaning. A `ch` invocation is a guest: it must never appear there,
   * but it does want to hear what is happening while it waits.
   */
  const eventClients = new Set<{
    readonly socket: TypedSocket;
    readonly workspacePath: WorkspacePath | null;
  }>();

  /** Unsubscribe callbacks for the forwarded-event subscriptions. */
  let eventSubscriptions: (() => void)[] = [];

  /**
   * Forward one domain event to the clients it concerns.
   *
   * A client scoped to a workspace hears only that workspace's events; a
   * workspace-less client — a shell standing outside every worktree — hears
   * everything, which is what makes progress visible for `project open`.
   */
  function forwardEvent(event: DomainEvent): void {
    const eventWorkspace = eventWorkspacePath(event.payload);

    for (const client of eventClients) {
      if (
        eventWorkspace !== undefined &&
        client.workspacePath !== null &&
        client.workspacePath !== eventWorkspace
      ) {
        continue;
      }
      // The typed socket describes the sidekick's server-to-client events; this
      // channel exists only for CLI and MCP clients, so it is emitted untyped.
      (client.socket as unknown as { emit: (channel: string, payload: unknown) => void }).emit(
        EVENT_CHANNEL,
        { type: event.type, payload: event.payload }
      );
    }
  }

  /** Waiters for `api:workspace:agentLifecycle {event: "close"}`, by workspace. */
  const agentClosedWaiters = new Map<string, Set<() => void>>();

  /** Wake anything waiting for this workspace's agent terminal to close. */
  function resolveAgentClosed(workspacePath: WorkspacePath): void {
    const normalized = new Path(workspacePath).toString();
    const waiters = agentClosedWaiters.get(normalized);
    if (!waiters) return;
    agentClosedWaiters.delete(normalized);
    for (const waiter of waiters) waiter();
  }

  /**
   * Ask the sidekick to close its agent terminal, and wait for it to actually
   * go away.
   *
   * Teardown used to skip this entirely: nothing ever asked the agent to stop,
   * so the terminal — and the whole tree below it, the shell, the agent CLI, and
   * every MCP server the agent spawned — was still running with the workspace as
   * its CWD when the worktree removal began. The Windows fallback then had to
   * discover those processes with a ~10s scan and `taskkill /f` a list that had
   * already gone stale, which is one of the two ways deletion lost this race.
   *
   * Ctrl+C is strictly better than killing the tree: the agent exits cleanly and
   * takes its own MCP servers down with it, instead of us hunting their PIDs.
   *
   * Best-effort by construction — a workspace with no sidekick, no terminal, or
   * a wedged extension host must not block the teardown. The Windows CWD scan
   * remains as the backstop for whatever this does not reach.
   */
  async function closeAgentTerminal(workspacePath: WorkspacePath): Promise<void> {
    const normalized = new Path(workspacePath).toString();
    const socket = connections.get(normalized);
    if (!socket?.connected) return;

    // Register the waiter BEFORE sending: the extension can report the close
    // between the command returning and us starting to wait.
    let resolveWaiter!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    const waiters = agentClosedWaiters.get(normalized) ?? new Set<() => void>();
    waiters.add(resolveWaiter);
    agentClosedWaiters.set(normalized, waiters);

    try {
      const result = await sendCommand(
        workspacePath,
        CLOSE_AGENT_COMMAND,
        undefined,
        AGENT_CLOSE_TIMEOUT_MS
      );

      // The command resolves as soon as it is invoked, not when the terminal is
      // gone, so its payload only tells us whether there was anything to close.
      // `closed: false` means no terminal existed — waiting would just burn the
      // full timeout for nothing.
      const data = result.success ? (result.data as { closed?: boolean } | undefined) : undefined;
      if (!result.success || data?.closed !== true) {
        logger.debug("No agent terminal to close", {
          workspace: normalized,
          ...(result.success ? {} : { error: result.error }),
        });
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), AGENT_CLOSE_TIMEOUT_MS);
      });
      try {
        const outcome = await Promise.race([closed.then(() => "closed" as const), timedOut]);
        if (outcome === "timeout") {
          logger.warn("Agent terminal did not close in time; falling back to process cleanup", {
            workspace: normalized,
            timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
          });
        } else {
          logger.debug("Agent terminal closed", { workspace: normalized });
        }
      } finally {
        clearTimeout(timeoutId!);
      }
    } finally {
      const remaining = agentClosedWaiters.get(normalized);
      if (remaining) {
        remaining.delete(resolveWaiter);
        if (remaining.size === 0) agentClosedWaiters.delete(normalized);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UI event sending
  // ---------------------------------------------------------------------------

  async function sendUiEvent<TReq, TRes>(
    workspacePath: WorkspacePath,
    event: keyof ServerToClientEvents,
    request: TReq,
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<TRes>> {
    const normalized = new Path(workspacePath).toString();
    const socket = connections.get(normalized);

    if (!socket) {
      return { success: false, error: "Workspace not connected" };
    }

    if (!socket.connected) {
      connections.delete(normalized);
      return { success: false, error: "Workspace disconnected" };
    }

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          logger.warn("UI event timeout", { workspace: normalized, event, timeoutMs });
          resolve({ success: false, error: "UI event timed out" });
        }, timeoutMs);
      }

      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate generic event dispatch
      socket.emit(event, request, (result: PluginResult<TRes>) => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        logger.debug("UI event result", {
          workspace: normalized,
          event,
          success: result.success,
        });
        resolve(result);
      });
    });
  }

  async function showNotification(
    workspacePath: WorkspacePath,
    request: ShowNotificationRequest,
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<ShowNotificationResponse>> {
    return sendUiEvent(workspacePath, "ui:showNotification", request, timeoutMs);
  }

  async function updateStatusBar(
    workspacePath: WorkspacePath,
    request: StatusBarUpdateRequest
  ): Promise<PluginResult<void>> {
    return sendUiEvent(workspacePath, "ui:statusBarUpdate", request);
  }

  async function disposeStatusBar(
    workspacePath: WorkspacePath,
    request: StatusBarDisposeRequest
  ): Promise<PluginResult<void>> {
    return sendUiEvent(workspacePath, "ui:statusBarDispose", request);
  }

  async function showQuickPick(
    workspacePath: WorkspacePath,
    request: ShowQuickPickRequest,
    timeoutMs: number = 0
  ): Promise<PluginResult<ShowQuickPickResponse>> {
    return sendUiEvent(workspacePath, "ui:showQuickPick", request, timeoutMs);
  }

  async function showInputBox(
    workspacePath: WorkspacePath,
    request: ShowInputBoxRequest,
    timeoutMs: number = 0
  ): Promise<PluginResult<ShowInputBoxResponse>> {
    return sendUiEvent(workspacePath, "ui:showInputBox", request, timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Workspace config management
  // ---------------------------------------------------------------------------

  function setWorkspaceConfig(
    workspacePath: WorkspacePath,
    env: Record<string, string>,
    agentType: AgentType,
    resetWorkspace: boolean
  ): void {
    const normalized = new Path(workspacePath).toString();
    workspaceConfigs.set(normalized, { env, agentType, resetWorkspace });
  }

  function removeWorkspaceConfig(workspacePath: WorkspacePath): void {
    const normalized = new Path(workspacePath).toString();
    workspaceConfigs.delete(normalized);
  }

  // ---------------------------------------------------------------------------
  // Auth validation
  // ---------------------------------------------------------------------------

  /**
   * What a connection is allowed to do, decided entirely from its handshake.
   *
   * Two shapes arrive here. A sidekick presents a workspace path and nothing
   * else — unchanged, because that handshake is a published contract. `ch` and
   * the MCP shim present a client kind and a token, and may present a working
   * directory instead of a workspace path, because a shell knows where it is
   * standing but not which worktree that is.
   */
  interface Handshake {
    readonly kind: ClientKind;
    /** Explicit workspace, when the client named one. */
    readonly workspacePath?: string;
    /** Working directory to resolve into a workspace, when it did not. */
    readonly cwd?: string;
  }

  function readHandshake(auth: unknown): Handshake | { error: string } {
    if (typeof auth !== "object" || auth === null) {
      return { error: "invalid auth" };
    }
    const record = auth as Record<string, unknown>;
    const kind = record.client;

    // No client kind: the sidekick's original handshake.
    if (kind === undefined) {
      const workspacePath = record.workspacePath;
      if (typeof workspacePath !== "string" || workspacePath.length === 0) {
        return { error: "invalid auth" };
      }
      return { kind: "sidekick", workspacePath };
    }

    if (kind !== "cli" && kind !== "mcp") {
      return { error: `unknown client kind "${String(kind)}"` };
    }

    // The token is what separates a deliberate caller from any local process
    // that guessed the port. Its absence refuses the connection outright rather
    // than degrading to a workspace-less one.
    const expected = deps.cliToken?.() ?? null;
    if (expected === null) {
      return { error: "this CodeHydra is not accepting CLI connections" };
    }
    if (typeof record.token !== "string" || record.token !== expected) {
      return { error: "invalid token" };
    }

    return {
      kind,
      ...(typeof record.workspacePath === "string" &&
        record.workspacePath.length > 0 && { workspacePath: record.workspacePath }),
      ...(typeof record.cwd === "string" && record.cwd.length > 0 && { cwd: record.cwd }),
    };
  }

  /**
   * The workspace a connection acts on, or null when it acts on none.
   *
   * A path the client gave is normalized and used as-is; a working directory is
   * resolved through workspace:resolve, which matches the deepest workspace
   * containing it. Resolving to nothing is not an error for a CLI client — that
   * is simply a shell standing outside any worktree, and app-global commands
   * still work there.
   */
  async function resolveConnectionWorkspace(handshake: Handshake): Promise<WorkspacePath | null> {
    // A sidekick always presents its own workspace path, and has always been
    // taken at its word — it may name a workspace still being opened.
    if (handshake.kind === "sidekick") {
      if (handshake.workspacePath === undefined) return null;
      try {
        return workspacePathSchema.parse(new Path(handshake.workspacePath).toString());
      } catch {
        return null;
      }
    }

    const reference = handshake.workspacePath;
    if (reference === undefined && handshake.cwd === undefined) return null;

    // Deliberately NOT workspace:resolve: that intent throws when the path is
    // not a workspace, and the dispatcher logs the rejection at error level —
    // so a shell standing outside every worktree, which is a normal caller,
    // would write a fault into the log and into every bug report. Listing is
    // the non-throwing way to ask the same question, and it is also what lets a
    // caller name a workspace instead of pasting its path.
    let projects: readonly ProjectLocation[];
    try {
      projects = ((await dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {} as Record<string, never>,
      })) ?? []) as readonly ProjectLocation[];
    } catch (error) {
      logger.debug("Could not list projects to resolve a client's workspace", {
        error: getErrorMessage(error),
      });
      return null;
    }

    if (reference !== undefined) {
      const resolved = resolveWorkspaceReference(projects, reference);
      if ("error" in resolved) {
        logger.debug("Could not resolve the workspace a client named", {
          reference,
          error: resolved.error,
        });
        return null;
      }
      return workspacePathSchema.parse(resolved.path);
    }

    const match = findWorkspaceContaining(allWorkspaces(projects), handshake.cwd!);
    return match === null ? null : workspacePathSchema.parse(match);
  }

  // ---------------------------------------------------------------------------
  // Socket.IO event handlers
  // ---------------------------------------------------------------------------

  function setupEventHandlers(): void {
    io!.on("connection", (socket: TypedSocket) => {
      void acceptConnection(socket);
    });
  }

  /**
   * Admit one connection, or turn it away.
   *
   * Async because a CLI client hands over a working directory rather than a
   * workspace, and turning that into a workspace means asking the intent system.
   */
  async function acceptConnection(socket: TypedSocket): Promise<void> {
    const handshake = readHandshake(socket.handshake.auth as unknown);

    if ("error" in handshake) {
      logger.warn("Connection rejected", { socketId: socket.id, reason: handshake.error });
      socket.disconnect(true);
      return;
    }

    const resolved = await resolveConnectionWorkspace(handshake);

    // The socket may have gone while we were resolving.
    if (socket.disconnected) return;

    // Registry operations are mounted for every kind of client. Which operations
    // that is, and what they are called, follows the client kind.
    if (deps.registry) {
      attachPluginAdapter({
        socket: socket as unknown as Parameters<typeof attachPluginAdapter>[0]["socket"],
        registry: deps.registry,
        workspacePath: resolved,
        cwd: handshake.cwd ?? null,
        logger,
        kind: handshake.kind,
      });
    }

    // A CLI or MCP client is a guest: it never becomes the workspace's
    // registered socket, so it cannot displace the sidekick, and teardown's wait
    // for the agent to close is not something it can strand. That is what lets
    // it connect during teardown, and without a workspace at all.
    if (handshake.kind !== "sidekick") {
      const client = { socket, workspacePath: resolved };
      eventClients.add(client);
      socket.on("disconnect", () => eventClients.delete(client));

      logger.debug("Client connected", {
        kind: handshake.kind,
        workspace: resolved,
        socketId: socket.id,
      });
      return;
    }

    if (resolved === null) {
      logger.warn("Connection rejected: invalid path", { socketId: socket.id });
      socket.disconnect(true);
      return;
    }
    const workspacePath = resolved;

    {
      // This workspace's teardown is mid-flight and is waiting on its current
      // socket for the agent to report that it closed. Accepting would displace
      // that socket (see the duplicate-connection handling below) and strand the
      // wait.
      if (closingWorkspaces.has(workspacePath)) {
        logger.info("Connection rejected: workspace teardown in progress", {
          workspace: workspacePath,
          socketId: socket.id,
        });
        socket.disconnect(true);
        return;
      }

      socket.data.workspacePath = workspacePath;

      const existingSocket = connections.get(workspacePath);
      if (existingSocket) {
        logger.info("Disconnecting duplicate connection", {
          workspace: workspacePath,
          oldSocketId: existingSocket.id,
          newSocketId: socket.id,
        });
        existingSocket.disconnect(true);
      }

      connections.set(workspacePath, socket);
      logger.info("Client connected", {
        workspace: workspacePath,
        socketId: socket.id,
      });

      const storedConfig = workspaceConfigs.get(workspacePath);
      const env: Record<string, string> | null = storedConfig?.env ?? null;
      const agentTypeValue: AgentType | null = storedConfig?.agentType ?? null;
      const resetWorkspace: boolean = storedConfig?.resetWorkspace ?? true;

      const config: PluginConfig = {
        isDevelopment,
        env,
        agentType: agentTypeValue,
        resetWorkspace,
      };
      socket.emit("config", config);
      logger.debug("Config sent", {
        workspace: workspacePath,
        isDevelopment,
        hasEnv: env !== null,
        agentType: agentTypeValue,
      });

      socket.on("disconnect", (reason) => {
        const currentSocket = connections.get(workspacePath);
        if (currentSocket === socket) {
          connections.delete(workspacePath);
          logger.info("Client disconnected", {
            workspace: workspacePath,
            reason,
          });
        }
      });

      setupApiHandlers(socket, workspacePath);
    }
  }

  // ---------------------------------------------------------------------------
  // API event handler helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrap a dispatcher call with error handling, returning a PluginResult.
   */
  async function handlePluginApiCall<T>(
    workspacePath: WorkspacePath,
    operation: string,
    fn: () => Promise<T>,
    logContext?: Record<string, unknown>
  ): Promise<PluginResult<T>> {
    try {
      const result = await fn();
      logger.debug(`${operation} success`, { workspace: workspacePath, ...logContext });
      return { success: true, data: result };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`${operation} error`, {
        workspace: workspacePath,
        error: message,
        ...logContext,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Create a handler for no-argument API calls that dispatch intents directly.
   */
  function createNoArgHandler<R>(
    eventName: string,
    workspacePath: WorkspacePath,
    dispatchFn: () => Promise<R>
  ): (ack: (result: PluginResult<R>) => void) => void {
    return (ack) => {
      logger.debug("API call", { event: eventName, workspace: workspacePath });

      // handlePluginApiCall never rejects (it converts all errors into a
      // PluginResult), so this guard only covers ack() itself throwing.
      handlePluginApiCall(workspacePath, eventName, dispatchFn)
        .then((result) => ack(result))
        .catch(() => {});
    };
  }

  /**
   * Create a handler for validated API calls with request payload.
   */
  function createValidatedHandler<TReq, TValidated, R>(
    eventName: string,
    workspacePath: WorkspacePath,
    validator: (
      payload: unknown
    ) => { valid: true; request?: TValidated } | { valid: false; error: string },
    dispatchFn: (request: TValidated) => Promise<PluginResult<R>>,
    logContext?: (request: TReq) => Record<string, unknown>
  ): (request: TReq, ack: (result: PluginResult<R>) => void) => void {
    return (request, ack) => {
      const validation = validator(request);
      if (!validation.valid) {
        logger.warn("API call validation failed", {
          event: eventName,
          workspace: workspacePath,
          error: validation.error,
        });
        ack({ success: false, error: validation.error });
        return;
      }

      const validatedRequest = validation.request ?? (request as unknown as TValidated);
      logger.debug("API call", {
        event: eventName,
        workspace: workspacePath,
        ...logContext?.(request),
      });

      // Every dispatchFn resolves through handlePluginApiCall, which never
      // rejects, so this guard only covers ack() itself throwing.
      dispatchFn(validatedRequest)
        .then((result) => ack(result))
        .catch(() => {});
    };
  }

  // ---------------------------------------------------------------------------
  // API event handlers (dispatch intents directly)
  // ---------------------------------------------------------------------------

  function setupApiHandlers(socket: TypedSocket, workspacePath: WorkspacePath): void {
    // No-arg handlers
    socket.on(
      "api:workspace:getStatus",
      createValidatedHandler<
        GetWorkspaceStatusRequest | undefined,
        GetWorkspaceStatusRequest,
        WorkspaceStatus
      >("api:workspace:getStatus", workspacePath, validateGetWorkspaceStatusRequest, (req) =>
        handlePluginApiCall(workspacePath, "getStatus", async () => {
          const intent: GetWorkspaceStatusIntent = {
            type: INTENT_GET_WORKSPACE_STATUS,
            payload: {
              workspacePath,
              ...(req.refresh !== undefined && { refresh: req.refresh }),
            },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Get workspace status dispatch returned no result");
          }
          return result;
        })
      )
    );

    socket.on(
      "api:workspace:getAgentSession",
      createNoArgHandler("api:workspace:getAgentSession", workspacePath, async () => {
        const intent: GetAgentSessionIntent = {
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath },
        };
        return dispatcher.dispatch(intent);
      })
    );

    socket.on(
      "api:workspace:restartAgentServer",
      createNoArgHandler("api:workspace:restartAgentServer", workspacePath, async () => {
        const intent: RestartAgentIntent = {
          type: INTENT_RESTART_AGENT,
          payload: { workspacePath },
        };
        const result = await dispatcher.dispatch(intent);
        if (result === undefined) {
          throw new Error("Restart agent dispatch returned no result");
        }
        return result;
      })
    );

    socket.on(
      "api:workspace:getMetadata",
      createNoArgHandler("api:workspace:getMetadata", workspacePath, async () => {
        const intent: GetMetadataIntent = {
          type: INTENT_GET_METADATA,
          payload: { workspacePath },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Get metadata dispatch returned no result");
        }
        return result as Record<string, string>;
      })
    );

    // Validated handlers
    socket.on(
      "api:workspace:setMetadata",
      createValidatedHandler<SetMetadataRequest, SetMetadataRequest, void>(
        "api:workspace:setMetadata",
        workspacePath,
        validateSetMetadataRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "setMetadata", async () => {
            const intent: SetMetadataIntent = {
              type: INTENT_SET_METADATA,
              payload: {
                workspacePath,
                key: req.key,
                value: req.value,
              },
            };
            await dispatcher.dispatch(intent);
            return undefined;
          }),
        (req) => ({ key: req.key })
      )
    );

    socket.on(
      "api:workspace:delete",
      createValidatedHandler<
        DeleteWorkspaceRequest | undefined,
        DeleteWorkspaceRequest,
        DeleteWorkspaceResponse
      >(
        "api:workspace:delete",
        workspacePath,
        validateDeleteWorkspaceRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "delete", async () => {
            const intent: DeleteWorkspaceIntent = {
              type: INTENT_DELETE_WORKSPACE,
              payload: {
                workspacePath,
                keepBranch: req.keepBranch ?? true,
                force: false,
                removeWorktree: true,
              },
            };
            const handle = dispatcher.dispatch(intent);
            if (!(await handle.accepted)) {
              return { started: false };
            }
            void handle;
            return { started: true };
          }),
        (req) => ({ keepBranch: !!req?.keepBranch })
      )
    );

    socket.on(
      "api:workspace:executeCommand",
      createValidatedHandler<ExecuteCommandRequest, ExecuteCommandRequest, unknown>(
        "api:workspace:executeCommand",
        workspacePath,
        validateExecuteCommandRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "executeCommand", async () => {
            const intent: VscodeCommandIntent = {
              type: INTENT_VSCODE_COMMAND,
              payload: {
                workspacePath,
                command: req.command,
                args: req.args,
              },
            };
            return dispatcher.dispatch(intent);
          }),
        (req) => ({ command: req.command })
      )
    );

    socket.on(
      "api:workspace:openSystemPath",
      createValidatedHandler<OpenSystemPathRequest, OpenSystemPathRequest, void>(
        "api:workspace:openSystemPath",
        workspacePath,
        validateOpenSystemPathRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "openSystemPath", async () => {
            if (req.app === "explorer") {
              const isDir = await isDirectory(req.path);
              const target = isDir ? req.path : dirname(req.path);
              await appLayer.openPath(target);
            } else {
              await appLayer.openPath(req.path);
            }
          }),
        (req) => ({ app: req.app, path: req.path })
      )
    );

    socket.on(
      "api:workspace:create",
      createValidatedHandler<WorkspaceCreateRequest, WorkspaceCreateRequest, Workspace>(
        "api:workspace:create",
        workspacePath,
        validateWorkspaceCreateRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "create", async () => {
            const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
              type: INTENT_RESOLVE_WORKSPACE,
              payload: { workspacePath },
            });

            const intent: OpenWorkspaceIntent = {
              type: INTENT_OPEN_WORKSPACE,
              payload: {
                projectPath: resolved.projectPath,
                workspaceName: req.name,
                base: req.base,
                ...(req.agent !== undefined && {
                  agent: req.agent,
                }),
                ...(req.stealFocus !== undefined && {
                  stealFocus: req.stealFocus,
                }),
                source: "plugin-server",
              },
            };
            const result = await dispatcher.dispatch(intent);
            if (!result) {
              throw new Error("Create workspace dispatch returned no result");
            }
            return result as Workspace;
          }),
        (req) => ({ name: req.name, base: req.base })
      )
    );

    // Handle api:log (fire-and-forget - special case)
    socket.on("api:log", (request) => {
      const validation = validateLogRequest(request);
      if (!validation.valid) return;

      const context: LogContext = {
        ...(request.context ?? {}),
        workspace: workspacePath,
      };

      const level = request.level as LogLevel;
      logAtLevel(extensionLogger, level, request.message, context);
    });

    // Handle api:workspace:agentLifecycle (fire-and-forget) — drives agent
    // status open/close by dispatching the agent:lifecycle intent.
    socket.on("api:workspace:agentLifecycle", (request) => {
      const validation = validateAgentLifecycleRequest(request);
      if (!validation.valid) {
        logger.warn("Invalid agentLifecycle request", {
          workspace: workspacePath,
          error: validation.error,
        });
        return;
      }

      if (request.event === "close") {
        resolveAgentClosed(workspacePath);
      }

      const intent: AgentLifecycleIntent = {
        type: INTENT_AGENT_LIFECYCLE,
        payload: { workspacePath, event: request.event },
      };
      void dispatcher.dispatch(intent);
    });
  }

  // ---------------------------------------------------------------------------
  // Show message handler
  // ---------------------------------------------------------------------------

  async function handleShowMessage(
    workspacePath: WorkspacePath,
    type: string,
    message: string | null,
    hint: string | undefined,
    options: readonly string[] | undefined,
    timeoutMs: number | undefined
  ): Promise<string | null> {
    if (type === "status") {
      if (message === null) {
        const result = await disposeStatusBar(workspacePath, { id: STATUS_BAR_ID });
        if (!result.success) throw new Error(result.error);
        return null;
      }
      const result = await updateStatusBar(workspacePath, {
        id: STATUS_BAR_ID,
        text: message,
        ...(hint !== undefined && { tooltip: hint }),
      });
      if (!result.success) throw new Error(result.error);
      return null;
    }

    if (type === "info" || type === "warning" || type === "error") {
      const result = await showNotification(
        workspacePath,
        {
          severity: type,
          message: message!,
          ...(options !== undefined && { actions: [...options] }),
        },
        timeoutMs
      );
      if (!result.success) throw new Error(result.error);
      return result.data.action;
    }

    if (type === "select") {
      if (options !== undefined) {
        const result = await showQuickPick(
          workspacePath,
          {
            items: options.map((label) => ({ label })),
            ...(hint !== undefined && { placeholder: hint }),
          },
          timeoutMs
        );
        if (!result.success) throw new Error(result.error);
        return result.data.selected;
      }

      // No options = free text input
      const result = await showInputBox(
        workspacePath,
        {
          ...(message !== null && { prompt: message }),
          ...(hint !== undefined && { placeholder: hint }),
        },
        timeoutMs
      );
      if (!result.success) throw new Error(result.error);
      return result.data.value;
    }

    throw new Error(`Unknown show-message type: ${type}`);
  }

  // ---------------------------------------------------------------------------
  // Module definition
  // ---------------------------------------------------------------------------

  const module: IntentModule = {
    name: "plugin-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<HookOutput> => {
            // pluginPort stays null on failure; the key is still provided (null,
            // not undefined) so the IDE server's `requires: { pluginPort: ANY_VALUE }`
            // gate is satisfied and it runs in degraded mode.
            let pluginPort: number | null = null;

            try {
              pluginPort = await start();
              logger.info("Plugin server started", { port: pluginPort });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              logger.warn("PluginServer start failed", { error: message });
            }

            return { provides: { pluginPort } };
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await close();
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<void> => {
            const finalizeCtx = ctx as FinalizeHookInput;

            if (io && finalizeCtx.agentType) {
              const intent = ctx.intent as OpenWorkspaceIntent;
              const resetWs = intent.payload.existingWorkspace === undefined;
              setWorkspaceConfig(
                finalizeCtx.workspacePath,
                finalizeCtx.envVars,
                finalizeCtx.agentType,
                resetWs
              );
            }
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        // Runs long before the worktree is removed: close the workspace for
        // business so no sidekick can open a terminal in a directory that is
        // about to disappear, and stop the agent that is already running in it.
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const normalized = workspacePathSchema.parse(new Path(wsPath).toString());

            closingWorkspaces.add(normalized);
            // "agent-stopped" is provided on EVERY path — including the early
            // returns inside closeAgentTerminal (no sidekick socket, no terminal
            // to close), a close that timed out, and a thrown error. It does not
            // claim the agent died; it means "we are done trying".
            //
            // It must be unconditional because handlers gated on it (the
            // presenter's IDE-frame release) have to run for a workspace with no
            // sidekick too. A throwing handler never merges its `provides`
            // (dispatcher.ts) and its dependents are then skipped, so anything
            // conditional here would strand the frame mounted — which is exactly
            // the state that lets the agent survive the worktree removal.
            let error: string | undefined;
            try {
              // Drop the config first. From here on a connecting sidekick gets
              // `env: null, agentType: null` and arms nothing — this, not the
              // connection gate, is what closes the workspace for business.
              removeWorkspaceConfig(normalized);

              // Ask the agent to exit and wait for it, THEN hang up. The order
              // matters: the close command and the "terminal closed" report both
              // travel over this socket, so disconnecting first would leave the
              // agent process tree running inside the worktree being removed.
              //
              // This lives here rather than in the agent module because that
              // module's shutdown handler `requires` the agent capability, which
              // defers it to a later wave than this one — it cannot run while
              // the socket is still open.
              await closeAgentTerminal(normalized);

              connections.get(normalized)?.disconnect(true);
            } catch (err) {
              // Reported as a result error rather than rethrown: the operation
              // treats both the same way (mergeShutdown folds collect errors and
              // result errors together), but returning lets us still provide.
              error = getErrorMessage(err);
            } finally {
              closingWorkspaces.delete(normalized);
            }

            return {
              result: error === undefined ? {} : { error },
              provides: { "agent-stopped": true },
            };
          },
        },
        delete: {
          handler: async (ctx: HookContext): Promise<HookOutput<DeleteHookResult>> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              if (io) {
                removeWorkspaceConfig(wsPath);
              }
            } catch (error) {
              if (!payload.force) throw error;
              logger.warn("PluginServerModule: error in force mode (ignored)", {
                error: getErrorMessage(error),
              });
            }

            return { result: {} };
          },
        },
      },

      [VSCODE_SHOW_MESSAGE_OPERATION_ID]: {
        show: {
          handler: async (ctx: HookContext): Promise<HookOutput<ShowHookResult>> => {
            if (!io) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ShowHookInput;
            const intent = ctx.intent as VscodeShowMessageIntent;
            const { type, message, hint, options: msgOptions, timeoutMs } = intent.payload;

            return {
              result: {
                result: await handleShowMessage(
                  workspacePath,
                  type,
                  message,
                  hint,
                  msgOptions,
                  timeoutMs
                ),
              },
            };
          },
        },
      },

      [VSCODE_COMMAND_OPERATION_ID]: {
        execute: {
          handler: async (ctx: HookContext): Promise<HookOutput<ExecuteHookResult>> => {
            if (!io) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ExecuteHookInput;
            const intent = ctx.intent as VscodeCommandIntent;
            const { command, args } = intent.payload;

            const commandResult = await sendCommand(workspacePath, command, args);
            if (!commandResult.success) {
              throw new Error(commandResult.error);
            }

            return { result: { result: commandResult.data } };
          },
        },
      },
    },
  };

  return { module, isReady: () => io !== null, port: () => port };
}

// =============================================================================
// Helpers
// =============================================================================

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
