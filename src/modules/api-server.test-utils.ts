/**
 * Test utilities for API server module testing.
 *
 * Provides helpers for creating test environments with real Socket.IO
 * (polling transport) and mock dispatchers for boundary and integration tests.
 */

import { vi, type Mock } from "vitest";
import { z } from "zod/v4";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import type { OperationRegistry } from "../api/registry";
import type { DomainEvent } from "../intents/lib/types";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ApiResult,
  CommandRequest,
  AgentType,
} from "../shared/api-protocol";
import {
  createApiServerModule,
  type ApiServerModuleDeps,
  type ApiServerOptions,
} from "./api-server-module";
import { DefaultNetworkLayer } from "../boundaries/platform/network";
import { createFileSystemMock } from "../boundaries/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { Dispatcher, IntentHandle, type DispatchOptions } from "../intents/lib/dispatcher";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
import { APP_START_OPERATION_ID, INTENT_APP_START } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  finalizeResultSchema,
} from "../intents/open-workspace";
import type { FinalizeHookInput } from "../intents/open-workspace";
import {
  VSCODE_COMMAND_OPERATION_ID,
  INTENT_VSCODE_COMMAND,
  type VscodeCommandIntent,
} from "../intents/vscode-command";
import { executeHookResultSchema } from "../intents/vscode-command";
import type { ExecuteHookInput, ExecuteHookResult } from "../intents/vscode-command";
import {
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
  type VscodeShowMessageType,
  showHookResultSchema,
} from "../intents/vscode-show-message";
import type { ShowHookInput, ShowHookResult } from "../intents/vscode-show-message";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { workspacePathSchema, type WorkspacePath, type WorkspaceRef } from "../intents/contract";
import { parseWorkspaceRef, projectRefFor } from "../utils/ref";
import { testWorkspaceRef } from "../shared/test-fixtures";
import { Path } from "../utils/path/path";
import type { LogScopeStore } from "../boundaries/platform/logging-types";
import type { Intent } from "../intents/lib/types";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";

// ============================================================================
// Mock Socket Types
// ============================================================================

/**
 * Typed client socket for connecting to the API server in tests.
 */
export type TestClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

// ============================================================================
// Test Client Factory
// ============================================================================

/**
 * Options for creating a test client.
 */
export interface TestClientOptions {
  /** Workspace path to send in auth */
  readonly workspacePath: WorkspacePath;
  /** Whether to connect immediately. Default: false */
  readonly autoConnect?: boolean;
  /** Raw handshake auth, for presenting a non-sidekick client kind. */
  readonly auth?: Record<string, unknown>;
}

/**
 * Create a Socket.IO client for testing the API server.
 *
 * @param port - Port to connect to
 * @param options - Client configuration
 * @returns Socket.IO client instance
 */
export function createTestClient(port: number, options: TestClientOptions): TestClientSocket {
  return ioClient(`http://127.0.0.1:${port}`, {
    transports: ["polling"],
    autoConnect: options.autoConnect ?? false,
    // `auth` lets a test present a non-sidekick handshake (a `ch` client kind
    // plus token); without it the sidekick's original shape is sent.
    auth: options.auth ?? { workspacePath: options.workspacePath },
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
  });
}

/**
 * Wait for a client to connect.
 */
export async function waitForConnect(client: TestClientSocket, timeoutMs = 5000): Promise<void> {
  if (client.connected) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });

    client.once("connect_error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.connect();
  });
}

/**
 * Wait for a client to disconnect.
 */
export async function waitForDisconnect(client: TestClientSocket, timeoutMs = 5000): Promise<void> {
  if (!client.connected) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Disconnect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.once("disconnect", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ============================================================================
// Mock Command Handler
// ============================================================================

/**
 * Options for mock command handler.
 */
export interface MockCommandHandlerOptions {
  /** Default result to return. Default: { success: true, data: undefined } */
  readonly defaultResult?: ApiResult<unknown>;
  /** Map of command names to specific results */
  readonly commandResults?: Record<string, ApiResult<unknown>>;
  /** Delay before responding in ms. Default: 0 */
  readonly delayMs?: number;
}

/**
 * Create a mock command handler for testing.
 */
export function createMockCommandHandler(
  options?: MockCommandHandlerOptions
): Mock<(request: CommandRequest, ack: (result: ApiResult<unknown>) => void) => void> {
  const defaultResult = options?.defaultResult ?? { success: true, data: undefined };
  const commandResults = options?.commandResults ?? {};
  const delayMs = options?.delayMs ?? 0;

  return vi.fn((request: CommandRequest, ack: (result: ApiResult<unknown>) => void) => {
    const result = commandResults[request.command] ?? defaultResult;

    if (delayMs > 0) {
      setTimeout(() => ack(result), delayMs);
    } else {
      ack(result);
    }
  });
}

/** Server options as the module takes them: the harness keeps `logScope` for its dispatcher. */
function withoutLogScope(
  options: (ApiServerOptions & { readonly logScope?: LogScopeStore }) | undefined
): ApiServerOptions {
  if (options === undefined) return {};
  const { logScope: _logScope, ...rest } = options;
  return rest;
}

// ============================================================================
// Workspace refs
// ============================================================================

/** The path a ref made by {@link testWorkspaceRef} stands for. */
function testWorkspacePath(workspaceRef: WorkspaceRef): WorkspacePath {
  const parts = parseWorkspaceRef(workspaceRef);
  if (parts === null) throw new Error(`Not a workspace ref: ${workspaceRef}`);
  return workspacePathSchema.parse(new Path(parts.project, parts.name).toString());
}

// ============================================================================
// Mock Dispatcher
// ============================================================================

/**
 * Create a mock dispatch function that returns IntentHandle with configurable results.
 */
function createMockDispatch(resolveWith?: unknown, options?: { accepted?: boolean }): Mock {
  return vi.fn().mockImplementation(() => {
    const handle = new IntentHandle();
    handle.signalAccepted(options?.accepted ?? true);
    if (resolveWith instanceof Error) {
      handle.reject(resolveWith);
    } else {
      handle.resolve(resolveWith);
    }
    return handle;
  });
}

// ============================================================================
// Minimal Test Operations
// ============================================================================

/** The app:start "start" hook point, returning the `apiPort` capability (or null). */
export function createMinimalStartOperation(): Operation<OperationSchemas> {
  return createMinimalOperation<number | null>(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
    hookContext: (ctx) => ({ intent: ctx.intent }),
    select: ({ capabilities }) => (capabilities.apiPort as number | null) ?? null,
  });
}

const finalizeSchemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: z.unknown(),
  hooks: { finalize: { result: finalizeResultSchema } },
} satisfies OperationSchemas;

/**
 * Minimal finalize operation that reads hook input from a mutable `hookInput`
 * property. The dispatcher invokes `execute` detached from the object, so `this`
 * is unavailable — `execute` reads the property off the captured `op` reference.
 */
function createMinimalFinalizeOperation(): Operation<typeof finalizeSchemas> & {
  hookInput: Partial<FinalizeHookInput>;
} {
  const op = {
    id: OPEN_WORKSPACE_OPERATION_ID,
    schemas: finalizeSchemas,
    hookInput: {} as Partial<FinalizeHookInput>,
    async execute(
      ctx: OperationContext<IntentOf<typeof finalizeSchemas>, typeof finalizeSchemas>
    ): Promise<void> {
      // What the real operation's resolve step does before finalize runs.
      ctx.setLogTarget({
        project: "project",
        ws: "test",
        path: op.hookInput.workspacePath ?? "/test/workspace",
      });
      const { errors } = await ctx.hooks.collect("finalize", {
        intent: ctx.intent,
        workspaceRef: testWorkspaceRef("/test/workspace"),
        workspacePath: "/test/workspace",
        envVars: {},
        agentType: "opencode" as const,
        ...op.hookInput,
      });
      if (errors.length > 0) throw errors[0]!;
    },
  };
  return op;
}

/** Minimal vscode-command operation that skips workspace resolution. */
function createMinimalCommandOperation(): Operation<OperationSchemas> {
  return createMinimalOperation<unknown, ExecuteHookResult>(
    VSCODE_COMMAND_OPERATION_ID,
    INTENT_VSCODE_COMMAND,
    "execute",
    {
      hookSchemas: { result: executeHookResultSchema },
      hookContext: (ctx): ExecuteHookInput => {
        const payload = ctx.intent.payload as VscodeCommandIntent["payload"];
        return {
          intent: ctx.intent,
          workspaceRef: payload.workspaceRef,
          workspacePath: testWorkspacePath(payload.workspaceRef),
        };
      },
      select: ({ results }) => results.findLast((r) => r.result !== undefined)?.result,
    }
  );
}

/** Minimal vscode-show-message operation that skips workspace resolution. */
function createMinimalShowMessageOperation(): Operation<OperationSchemas> {
  return createMinimalOperation<string | null, ShowHookResult>(
    VSCODE_SHOW_MESSAGE_OPERATION_ID,
    INTENT_VSCODE_SHOW_MESSAGE,
    "show",
    {
      hookSchemas: { result: showHookResultSchema },
      hookContext: (ctx): ShowHookInput => {
        const payload = ctx.intent.payload as VscodeShowMessageIntent["payload"];
        return {
          intent: ctx.intent,
          workspaceRef: payload.workspaceRef,
          workspacePath: testWorkspacePath(payload.workspaceRef),
        };
      },
      select: ({ results }) => results.findLast((r) => r.result !== undefined)?.result ?? null,
    }
  );
}

// ============================================================================
// API Server Test Environment
// ============================================================================

/**
 * Create a API server test environment with real Socket.IO (polling transport).
 *
 * The server is started via the module's app:start hook, just like in production.
 * A mock dispatcher is injected so that API calls can be verified without real operations.
 *
 * Provides helper methods to drive server-to-client operations through hooks:
 * - sendCommand: dispatches VscodeCommandIntent
 * - showMessage: dispatches VscodeShowMessageIntent
 * - setWorkspaceConfig: dispatches workspace:open finalize
 */
export async function createApiServerEnv(
  options?: ApiServerOptions & { readonly logScope?: LogScopeStore },
  extra?: { registry?: OperationRegistry; cliToken?: string | null }
) {
  const networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
  const mockDispatch = createMockDispatch();

  // The module subscribes to domain events at start, so the mock needs a real
  // subscription registry — and the test needs a way to fire one.
  const subscribers = new Map<string, Set<(event: DomainEvent) => void>>();
  /** Every origin a connection tagged its packets' work with, in order. */
  const origins: DispatchOptions[] = [];
  /**
   * The workspaces clients have connected for. The server looks a sidekick's
   * folder up in `project:list`, which is answered from these rather than by
   * `mockDispatch`, so what tests assert on stays what they caused.
   */
  const known = new Set<string>();
  /** What `setProjects` put in place of the listing built from `known`. */
  let projects: readonly unknown[] | undefined;
  const listing = (): readonly unknown[] => {
    if (projects !== undefined) return projects;
    const byProject = new Map<string, string[]>();
    for (const path of known) {
      const dir = new Path(path).dirname.toString();
      byProject.set(dir, [...(byProject.get(dir) ?? []), path]);
    }
    return [...byProject].map(([dir, paths]) => ({
      ref: projectRefFor(dir),
      name: new Path(dir).basename,
      path: dir,
      workspaces: paths.map((path) => ({
        ref: testWorkspaceRef(path),
        name: new Path(path).basename,
        path,
      })),
    }));
  };
  const mockDispatcher = {
    dispatch: (...args: [Intent, DispatchOptions?]) => {
      // Forwarded as called, so assertions on `mockDispatch` see the same arguments.
      if (args[0].type !== INTENT_LIST_PROJECTS) return mockDispatch(...args);
      const handle = new IntentHandle();
      handle.signalAccepted(true);
      handle.resolve(listing());
      return handle;
    },
    withOrigin: <T>(options: DispatchOptions, fn: () => T): T => {
      origins.push(options);
      return fn();
    },
    subscribe: (type: string, handler: (event: DomainEvent) => void) => {
      const forType = subscribers.get(type) ?? new Set();
      forType.add(handler);
      subscribers.set(type, forType);
      return () => forType.delete(handler);
    },
  } as unknown as Dispatcher;

  /** The file system `api:workspace:openSystemPath` probes; seed it per test. */
  const fileSystem = createFileSystemMock();
  /** Every path the module asked the OS to open, in order. */
  const openedPaths: string[] = [];

  const moduleDeps: ApiServerModuleDeps = {
    portManager: networkLayer,
    dispatcher: mockDispatcher,
    appLayer: {
      openPath: async (path: string) => {
        openedPaths.push(path);
      },
    },
    fileSystem,
    logger: SILENT_LOGGER,
    ...(extra?.registry !== undefined && { registry: extra.registry }),
    ...(extra?.cliToken !== undefined && { cliToken: () => extra.cliToken ?? null }),
    options: {
      transports: ["polling"],
      ...withoutLogScope(options),
    },
  };

  const apiServer = createApiServerModule(moduleDeps);
  const { module } = apiServer;
  const logScope = options?.logScope;

  // Wire up a real dispatcher to drive the module through hooks
  const testDispatcher = new Dispatcher({
    logger: createMockLogger(),
    ...(logScope !== undefined && { logScope }),
  });
  testDispatcher.registerModule(module);
  testDispatcher.registerOperation(createMinimalStartOperation());
  testDispatcher.registerOperation(
    createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
      throwOnError: false,
    })
  );
  testDispatcher.registerOperation(createMinimalCommandOperation());
  testDispatcher.registerOperation(createMinimalShowMessageOperation());

  // Register finalize operation with mutable hook input (shared across setWorkspaceConfig calls)
  const finalizeOp = createMinimalFinalizeOperation();
  testDispatcher.registerOperation(finalizeOp);

  // Start the server via the hook
  const port = (await testDispatcher.dispatch({
    type: "app:start",
    payload: {},
  })) as number;

  const clients: TestClientSocket[] = [];

  return {
    port,
    mockDispatch,
    origins,
    networkLayer,
    fileSystem,
    openedPaths,
    testDispatcher,
    /** The module handle, for probes like `isConnected` that read live state. */
    apiServer,

    createClient(workspacePath: WorkspacePath): TestClientSocket {
      known.add(new Path(workspacePath).toString());
      const client = createTestClient(this.port, { workspacePath });
      clients.push(client);
      return client;
    },

    /**
     * Answer the server's `project:list` with these projects from now on,
     * instead of the ones the connected clients' folders make up.
     */
    setProjects(listed: readonly unknown[]): void {
      projects = listed;
    },

    /** Fire a domain event at whatever the module subscribed with. */
    emitDomainEvent(event: DomainEvent): void {
      for (const handler of subscribers.get(event.type) ?? []) handler(event);
    },

    /** A `ch`-style client, which authenticates and may name no workspace. */
    createCliClient(auth: Record<string, unknown>): TestClientSocket {
      const client = createTestClient(this.port, {
        workspacePath: "" as WorkspacePath,
        auth,
      });
      clients.push(client);
      return client;
    },

    /**
     * Set workspace config by dispatching workspace:open finalize hook.
     */
    async setWorkspaceConfig(
      workspacePath: WorkspacePath,
      env: Record<string, string>,
      agentType: AgentType,
      resetWorkspace: boolean,
      workspaceEnv: Record<string, string> = {}
    ): Promise<void> {
      // Update the mutable hook input for the finalize operation
      finalizeOp.hookInput = {
        workspaceRef: testWorkspaceRef(workspacePath),
        workspacePath,
        envVars: env,
        workspaceEnv,
        agentType,
        fresh: resetWorkspace,
      };

      await testDispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectRef: projectRefFor("/test/project"),
          workspaceName: "test",
          base: "main",
          ...(resetWorkspace
            ? {}
            : {
                existingWorkspace: {
                  path: workspacePath,
                  name: "test",
                  branch: "test",
                  metadata: {},
                },
              }),
        },
      } as OpenWorkspaceIntent);
    },

    /**
     * Send a VS Code command to a workspace via the vscode-command hook.
     */
    async sendCommand(
      workspacePath: WorkspacePath,
      command: string,
      args?: readonly unknown[]
    ): Promise<unknown> {
      return testDispatcher.dispatch<VscodeCommandIntent>({
        type: INTENT_VSCODE_COMMAND,
        payload: { workspaceRef: testWorkspaceRef(workspacePath), command, args },
      });
    },

    /**
     * Show a notification in a workspace via the vscode-show-message hook.
     */
    async showNotification(
      workspacePath: WorkspacePath,
      request: { severity: "info" | "warning" | "error"; message: string; actions?: string[] },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef: testWorkspaceRef(workspacePath),
          type: request.severity as VscodeShowMessageType,
          message: request.message,
          options: request.actions,
          timeoutMs,
        },
      });
      return result as string | null;
    },

    /**
     * Update a status bar item via the vscode-show-message hook.
     */
    async updateStatusBar(
      workspacePath: WorkspacePath,
      request: { text: string; tooltip?: string }
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef: testWorkspaceRef(workspacePath),
          type: "status" as VscodeShowMessageType,
          message: request.text,
          hint: request.tooltip,
        },
      });
      return result as string | null;
    },

    /**
     * Dispose a status bar item via the vscode-show-message hook.
     */
    async disposeStatusBar(workspacePath: WorkspacePath): Promise<string | null> {
      const result = await testDispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef: testWorkspaceRef(workspacePath),
          type: "status" as VscodeShowMessageType,
          message: null,
        },
      });
      return result as string | null;
    },

    /**
     * Show a quick pick via the vscode-show-message hook.
     */
    async showQuickPick(
      workspacePath: WorkspacePath,
      request: {
        items: readonly { label: string; description?: string; detail?: string }[];
        title?: string;
        placeholder?: string;
      },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef: testWorkspaceRef(workspacePath),
          type: "select" as VscodeShowMessageType,
          message: null,
          hint: request.placeholder,
          options: request.items.map((i) => i.label),
          timeoutMs,
        },
      });
      return result as string | null;
    },

    /**
     * Show an input box via the vscode-show-message hook.
     */
    async showInputBox(
      workspacePath: WorkspacePath,
      request: { title?: string; prompt?: string; placeholder?: string; value?: string },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef: testWorkspaceRef(workspacePath),
          type: "select" as VscodeShowMessageType,
          message: request.prompt ?? null,
          hint: request.placeholder,
          timeoutMs,
        },
      });
      return result as string | null;
    },

    async cleanup(): Promise<void> {
      for (const client of clients) {
        if (client.connected) client.disconnect();
      }
      clients.length = 0;
      await testDispatcher.dispatch({ type: "app:shutdown", payload: {} });
    },
  };
}
