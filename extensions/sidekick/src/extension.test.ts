/**
 * Integration tests for the sidekick extension's agent terminal lifecycle emits.
 *
 * Verifies that opening the agent terminal emits api:workspace:agentLifecycle
 * { event: "open" } and closing it emits { event: "close" } over the plugin
 * socket (replacing the wrapper's WrapperStart/WrapperEnd POSTs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Terminal, TerminalOptions } from "vscode";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FakeSocket {
  connected: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  _handlers: Record<string, (...args: unknown[]) => unknown>;
}

vi.mock("socket.io-client", () => {
  return {
    io: vi.fn((): FakeSocket => {
      const handlers: Record<string, (...args: unknown[]) => unknown> = {};
      const socket: FakeSocket = {
        connected: true,
        emit: vi.fn(),
        on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
          handlers[event] = cb;
          return socket;
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        _handlers: handlers,
      };
      return socket;
    }),
  };
});

// Captured terminal-close callbacks registered via window.onDidCloseTerminal.
let closeHandlers: Array<(t: Terminal) => void> = [];
// Terminals created via window.createTerminal.
let createdTerminals: Terminal[] = [];

vi.mock("vscode", () => {
  return {
    window: {
      createTerminal: vi.fn((opts: TerminalOptions): Terminal => {
        const terminal = {
          name: opts.name,
          creationOptions: opts,
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        } as unknown as Terminal;
        createdTerminals.push(terminal);
        return terminal;
      }),
      onDidCloseTerminal: vi.fn((cb: (t: Terminal) => void) => {
        closeHandlers.push(cb);
        return { dispose: vi.fn() };
      }),
      terminals: [],
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      createStatusBarItem: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
      executeCommand: vi.fn(() => Promise.resolve()),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace/feature-a" } }],
      updateWorkspaceFolders: vi.fn(),
    },
    ViewColumn: { Active: 1 },
    StatusBarAlignment: { Left: 1 },
    Uri: { file: (p: string) => ({ fsPath: p }), parse: (s: string) => ({ toString: () => s }) },
  };
});

import { io } from "socket.io-client";
import { activate, deactivate } from "./extension";

function makeContext() {
  return {
    subscriptions: { push: vi.fn() },
    workspaceState: {
      get: vi.fn((_key: string, def: unknown) => def),
      update: vi.fn(),
    },
  } as unknown as Parameters<typeof activate>[0];
}

function getSocket(): FakeSocket {
  const mockedIo = vi.mocked(io);
  return mockedIo.mock.results[mockedIo.mock.results.length - 1]!.value as FakeSocket;
}

const CONFIG = {
  isDevelopment: false,
  env: { _CH_WORKSPACE_PATH: "/workspace/feature-a", _CH_BRIDGE_PORT: "9000" },
  agentType: "claude" as const,
  resetWorkspace: true,
};

describe("sidekick agent lifecycle emits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeHandlers = [];
    createdTerminals = [];
    process.env._CH_PLUGIN_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_PLUGIN_PORT;
  });

  it("emits agentLifecycle 'open' when the agent terminal is created", async () => {
    activate(makeContext());
    const socket = getSocket();

    await socket._handlers.config!(CONFIG);

    expect(createdTerminals).toHaveLength(1);
    expect(socket.emit).toHaveBeenCalledWith("api:workspace:agentLifecycle", { event: "open" });
  });

  it("emits agentLifecycle 'close' when the agent terminal closes", async () => {
    activate(makeContext());
    const socket = getSocket();
    await socket._handlers.config!(CONFIG);

    socket.emit.mockClear();

    // Fire the terminal-close listener with the agent terminal.
    expect(closeHandlers.length).toBeGreaterThan(0);
    closeHandlers[0]!(createdTerminals[0]!);

    expect(socket.emit).toHaveBeenCalledWith("api:workspace:agentLifecycle", { event: "close" });
  });

  it("does not emit when the socket is disconnected", async () => {
    activate(makeContext());
    const socket = getSocket();
    await socket._handlers.config!(CONFIG);

    socket.emit.mockClear();
    socket.connected = false;

    closeHandlers[0]!(createdTerminals[0]!);

    expect(socket.emit).not.toHaveBeenCalledWith("api:workspace:agentLifecycle", {
      event: "close",
    });
  });
});
