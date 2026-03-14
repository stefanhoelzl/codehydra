/**
 * Test utilities for plugin server module testing.
 *
 * Provides helpers for creating test environments with real Socket.IO
 * (polling transport) and mock dispatchers for boundary and integration tests.
 */

import { vi, type Mock } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  PluginResult,
  CommandRequest,
  AgentType,
} from "../../shared/plugin-protocol";
import {
  createPluginServerModule,
  type PluginServerModuleDeps,
  type PluginServerOptions,
} from "./plugin-server-module";
import { DefaultNetworkLayer } from "../../services/platform/network";
import { SILENT_LOGGER } from "../../services/logging/logging.test-utils";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher, IntentHandle } from "../intents/infrastructure/dispatcher";
import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import { APP_START_OPERATION_ID, INTENT_APP_START } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
} from "../operations/open-workspace";
import type { FinalizeHookInput } from "../operations/open-workspace";
import {
  VSCODE_COMMAND_OPERATION_ID,
  INTENT_VSCODE_COMMAND,
  type VscodeCommandIntent,
} from "../operations/vscode-command";
import type { ExecuteHookInput, ExecuteHookResult } from "../operations/vscode-command";
import {
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
  type VscodeShowMessageType,
} from "../operations/vscode-show-message";
import type { ShowHookInput, ShowHookResult } from "../operations/vscode-show-message";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";

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
  readonly workspacePath: string;
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
export function createMockDispatch(resolveWith?: unknown, options?: { accepted?: boolean }): Mock {
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

class MinimalStartOperation implements Operation<Intent, number | null> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<number | null> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return (capabilities.pluginPort as number | null) ?? null;
  }
}

/** Minimal finalize operation that reads hook input from a mutable config. */
class MinimalFinalizeOperation implements Operation<OpenWorkspaceIntent, void> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  hookInput: Partial<FinalizeHookInput> = {};

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<void>("finalize", {
      intent: ctx.intent,
      workspacePath: "/test/workspace",
      envVars: {},
      agentType: "opencode" as const,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

/** Minimal vscode-command operation that skips workspace resolution. */
class MinimalCommandOperation implements Operation<VscodeCommandIntent, unknown> {
  readonly id = VSCODE_COMMAND_OPERATION_ID;

  async execute(ctx: OperationContext<VscodeCommandIntent>): Promise<unknown> {
    const { payload } = ctx.intent;
    const executeCtx: ExecuteHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ExecuteHookResult>("execute", executeCtx);
    if (errors.length > 0) throw errors[0]!;

    let result: unknown;
    for (const r of results) {
      if (r.result !== undefined) result = r.result;
    }
    return result;
  }
}

/** Minimal vscode-show-message operation that skips workspace resolution. */
class MinimalShowMessageOperation implements Operation<VscodeShowMessageIntent, string | null> {
  readonly id = VSCODE_SHOW_MESSAGE_OPERATION_ID;

  async execute(ctx: OperationContext<VscodeShowMessageIntent>): Promise<string | null> {
    const { payload } = ctx.intent;
    const showCtx: ShowHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ShowHookResult>("show", showCtx);
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
    logger: SILENT_LOGGER,
    options: {
      transports: ["polling"],
      ...options,
    },
  };

  const module = createPluginServerModule(moduleDeps);

  // Wire up a real dispatcher to drive the module through hooks
  const hookRegistry = new HookRegistry();
  const testDispatcher = new Dispatcher(hookRegistry);
  testDispatcher.registerModule(module);
  testDispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());
  testDispatcher.registerOperation(
    INTENT_APP_SHUTDOWN,
    createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
  );
  testDispatcher.registerOperation(INTENT_VSCODE_COMMAND, new MinimalCommandOperation());
  testDispatcher.registerOperation(INTENT_VSCODE_SHOW_MESSAGE, new MinimalShowMessageOperation());

  // Register finalize operation with mutable hook input (shared across setWorkspaceConfig calls)
  const finalizeOp = new MinimalFinalizeOperation();
  testDispatcher.registerOperation(INTENT_OPEN_WORKSPACE, finalizeOp);

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

    createClient(workspacePath: string): TestClientSocket {
      const client = createTestClient(this.port, { workspacePath });
      clients.push(client);
      return client;
    },

    /**
     * Set workspace config by dispatching workspace:open finalize hook.
     */
    async setWorkspaceConfig(
      workspacePath: string,
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
      workspacePath: string,
      command: string,
      args?: readonly unknown[]
    ): Promise<unknown> {
      return testDispatcher.dispatch({
        type: INTENT_VSCODE_COMMAND,
        payload: { workspacePath, command, args },
      } as VscodeCommandIntent);
    },

    /**
     * Show a notification in a workspace via the vscode-show-message hook.
     */
    async showNotification(
      workspacePath: string,
      request: { severity: "info" | "warning" | "error"; message: string; actions?: string[] },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath,
          type: request.severity as VscodeShowMessageType,
          message: request.message,
          options: request.actions,
          timeoutMs,
        },
      } as VscodeShowMessageIntent);
      return result as string | null;
    },

    /**
     * Update a status bar item via the vscode-show-message hook.
     */
    async updateStatusBar(
      workspacePath: string,
      request: { text: string; tooltip?: string }
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath,
          type: "status" as VscodeShowMessageType,
          message: request.text,
          hint: request.tooltip,
        },
      } as VscodeShowMessageIntent);
      return result as string | null;
    },

    /**
     * Dispose a status bar item via the vscode-show-message hook.
     */
    async disposeStatusBar(workspacePath: string): Promise<string | null> {
      const result = await testDispatcher.dispatch({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath,
          type: "status" as VscodeShowMessageType,
          message: null,
        },
      } as VscodeShowMessageIntent);
      return result as string | null;
    },

    /**
     * Show a quick pick via the vscode-show-message hook.
     */
    async showQuickPick(
      workspacePath: string,
      request: {
        items: readonly { label: string; description?: string; detail?: string }[];
        title?: string;
        placeholder?: string;
      },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath,
          type: "select" as VscodeShowMessageType,
          message: null,
          hint: request.placeholder,
          options: request.items.map((i) => i.label),
          timeoutMs,
        },
      } as VscodeShowMessageIntent);
      return result as string | null;
    },

    /**
     * Show an input box via the vscode-show-message hook.
     */
    async showInputBox(
      workspacePath: string,
      request: { title?: string; prompt?: string; placeholder?: string; value?: string },
      timeoutMs?: number
    ): Promise<string | null> {
      const result = await testDispatcher.dispatch({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath,
          type: "select" as VscodeShowMessageType,
          message: request.prompt ?? null,
          hint: request.placeholder,
          timeoutMs,
        },
      } as VscodeShowMessageIntent);
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
