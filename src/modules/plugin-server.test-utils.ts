/**
 * Test utilities for plugin server module testing.
 *
 * Provides helpers for creating test environments with real Socket.IO
 * (polling transport) and mock dispatchers for boundary and integration tests.
 */

import { vi, type Mock } from "vitest";
import { z } from "zod/v4";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  PluginResult,
  CommandRequest,
  AgentType,
} from "../shared/plugin-protocol";
import {
  createPluginServerModule,
  type PluginServerModuleDeps,
  type PluginServerOptions,
} from "./plugin-server-module";
import { DefaultNetworkLayer } from "../boundaries/platform/network";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { Dispatcher, IntentHandle } from "../intents/lib/dispatcher";
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
import type { ExecuteHookInput } from "../intents/vscode-command";
import {
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
  type VscodeShowMessageType,
  showHookResultSchema,
} from "../intents/vscode-show-message";
import type { ShowHookInput } from "../intents/vscode-show-message";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { WorkspacePath } from "../intents/contract";

// ============================================================================
// Mock Socket Types
// ============================================================================

/**
 * Typed client socket for connecting to the plugin server in tests.
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
}

/**
 * Create a Socket.IO client for testing the plugin server.
 *
 * @param port - Port to connect to
 * @param options - Client configuration
 * @returns Socket.IO client instance
 */
export function createTestClient(port: number, options: TestClientOptions): TestClientSocket {
  return ioClient(`http://127.0.0.1:${port}`, {
    transports: ["polling"],
    autoConnect: options.autoConnect ?? false,
    auth: {
      workspacePath: options.workspacePath,
    },
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
  readonly defaultResult?: PluginResult<unknown>;
  /** Map of command names to specific results */
  readonly commandResults?: Record<string, PluginResult<unknown>>;
  /** Delay before responding in ms. Default: 0 */
  readonly delayMs?: number;
}

/**
 * Create a mock command handler for testing.
 */
export function createMockCommandHandler(
  options?: MockCommandHandlerOptions
): Mock<(request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void> {
  const defaultResult = options?.defaultResult ?? { success: true, data: undefined };
  const commandResults = options?.commandResults ?? {};
  const delayMs = options?.delayMs ?? 0;

  return vi.fn((request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => {
    const result = commandResults[request.command] ?? defaultResult;

    if (delayMs > 0) {
      setTimeout(() => ack(result), delayMs);
    } else {
      ack(result);
    }
  });
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

const startSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<number | null>(),
} satisfies OperationSchemas;

class MinimalStartOperation implements Operation<typeof startSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = startSchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof startSchemas>, typeof startSchemas>
  ): Promise<number | null> {
    const { errors, capabilities } = await ctx.hooks.collect("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return (capabilities.pluginPort as number | null) ?? null;
  }
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
      const { errors } = await ctx.hooks.collect("finalize", {
        intent: ctx.intent,
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

const commandSchemas = {
  type: INTENT_VSCODE_COMMAND,
  payload: z.unknown(),
  result: z.custom<unknown>(),
  hooks: { execute: { result: executeHookResultSchema } },
} satisfies OperationSchemas;

/** Minimal vscode-command operation that skips workspace resolution. */
class MinimalCommandOperation implements Operation<typeof commandSchemas> {
  readonly id = VSCODE_COMMAND_OPERATION_ID;
  readonly schemas = commandSchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof commandSchemas>, typeof commandSchemas>
  ): Promise<unknown> {
    const payload = ctx.intent.payload as VscodeCommandIntent["payload"];
    const executeCtx: ExecuteHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect("execute", executeCtx);
    if (errors.length > 0) throw errors[0]!;

    let result: unknown;
    for (const r of results) {
      if (r.result !== undefined) result = r.result;
    }
    return result;
  }
}

const showMessageSchemas = {
  type: INTENT_VSCODE_SHOW_MESSAGE,
  payload: z.unknown(),
  result: z.custom<string | null>(),
  hooks: { show: { result: showHookResultSchema } },
} satisfies OperationSchemas;

/** Minimal vscode-show-message operation that skips workspace resolution. */
class MinimalShowMessageOperation implements Operation<typeof showMessageSchemas> {
  readonly id = VSCODE_SHOW_MESSAGE_OPERATION_ID;
  readonly schemas = showMessageSchemas;

  async execute(
    ctx: OperationContext<IntentOf<typeof showMessageSchemas>, typeof showMessageSchemas>
  ): Promise<string | null> {
    const payload = ctx.intent.payload as VscodeShowMessageIntent["payload"];
    const showCtx: ShowHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect("show", showCtx);
    if (errors.length > 0) throw errors[0]!;

    let result: string | null | undefined;
    for (const r of results) {
      if (r.result !== undefined) result = r.result;
    }
    return result ?? null;
  }
}

// ============================================================================
// Plugin Server Test Environment
// ============================================================================

/**
 * Create a plugin server test environment with real Socket.IO (polling transport).
 *
 * The server is started via the module's app:start hook, just like in production.
 * A mock dispatcher is injected so that API calls can be verified without real operations.
 *
 * Provides helper methods to drive server-to-client operations through hooks:
 * - sendCommand: dispatches VscodeCommandIntent
 * - showMessage: dispatches VscodeShowMessageIntent
 * - setWorkspaceConfig: dispatches workspace:open finalize
 */
export async function createPluginServerEnv(options?: PluginServerOptions) {
  const networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);
  const mockDispatch = createMockDispatch();
  const mockDispatcher = { dispatch: mockDispatch } as unknown as Dispatcher;

  const moduleDeps: PluginServerModuleDeps = {
    portManager: networkLayer,
    dispatcher: mockDispatcher,
    appLayer: { openPath: async () => {} },
    logger: SILENT_LOGGER,
    options: {
      transports: ["polling"],
      ...options,
    },
  };

  const module = createPluginServerModule(moduleDeps);

  // Wire up a real dispatcher to drive the module through hooks
  const testDispatcher = new Dispatcher({ logger: createMockLogger() });
  testDispatcher.registerModule(module);
  testDispatcher.registerOperation(new MinimalStartOperation());
  testDispatcher.registerOperation(
    createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
      throwOnError: false,
    })
  );
  testDispatcher.registerOperation(new MinimalCommandOperation());
  testDispatcher.registerOperation(new MinimalShowMessageOperation());

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
    networkLayer,
    testDispatcher,

    createClient(workspacePath: WorkspacePath): TestClientSocket {
      const client = createTestClient(this.port, { workspacePath });
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
      resetWorkspace: boolean
    ): Promise<void> {
      // Update the mutable hook input for the finalize operation
      finalizeOp.hookInput = {
        workspacePath,
        envVars: env,
        agentType,
      };

      await testDispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
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
        payload: { workspacePath, command, args },
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
          workspacePath,
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
          workspacePath,
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
          workspacePath,
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
          workspacePath,
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
          workspacePath,
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
