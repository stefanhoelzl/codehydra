/**
 * Integration tests for the sidekick extension's agent terminal lifecycle emits.
 *
 * Verifies that opening the agent terminal emits api:workspace:agentLifecycle
 * { event: "open" } and closing it emits { event: "close" } over the API server
 * socket (replacing the wrapper's WrapperStart/WrapperEnd POSTs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createdTerminals,
  closeHandlers,
  commands,
  createdQuickInputs,
  env as vscodeEnv,
  resetVscodeFake,
  shellExecutionStartHandlers,
  window as vscodeWindow,
  type FakeTerminal,
} from "../../../__mocks__/vscode";

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

// Shared vscode fake (no factory) — see __mocks__/vscode.ts. The captured
// terminal state (createdTerminals, closeHandlers) is imported from the fake.
vi.mock("vscode");

import { io } from "socket.io-client";
import { activate, deactivate } from "./extension";

/** Stands in for VS Code's EnvironmentVariableCollection: what new terminals get. */
function makeEnvCollection() {
  const values = new Map<string, string>();
  return {
    persistent: true,
    values,
    clear: vi.fn(() => values.clear()),
    replace: vi.fn((name: string, value: string) => values.set(name, value)),
  };
}

function makeContext(envCollection = makeEnvCollection()) {
  return {
    subscriptions: { push: vi.fn() },
    workspaceState: {
      get: vi.fn((_key: string, def: unknown) => def),
      update: vi.fn(),
    },
    environmentVariableCollection: envCollection,
  } as unknown as Parameters<typeof activate>[0];
}

function getSocket(): FakeSocket {
  const mockedIo = vi.mocked(io);
  return mockedIo.mock.results[mockedIo.mock.results.length - 1]!.value as FakeSocket;
}

const CONFIG = {
  isDevelopment: false,
  env: { _CH_WORKSPACE: "ch::local::/workspace::feature-a", _CH_BRIDGE_PORT: "9000" },
  workspaceEnv: null,
  agentType: "claude" as const,
  resetWorkspace: true,
};

describe("sidekick agent lifecycle emits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
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

  // The terminal must close when the agent exits: its close is what teardown
  // waits for, and a shell left at its prompt keeps it open.
  it.each([
    ["/bin/bash", "exec ch claude"],
    ["/usr/bin/fish", "exec ch claude"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "try { ch claude } finally { exit }"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "try { ch claude } finally { exit }",
    ],
    ["C:\\Windows\\System32\\cmd.exe", "ch claude & exit"],
  ])("launches the agent so the %s shell exits with it", async (shell, line) => {
    vscodeEnv.shell = shell;
    activate(makeContext());
    const socket = getSocket();
    await socket._handlers.config!(CONFIG);

    expect(createdTerminals[0]!.sendText).toHaveBeenCalledWith(line);
  });

  function closeAgent(): unknown {
    const registration = vi
      .mocked(commands.registerCommand)
      .mock.calls.find(([id]) => id === "codehydra.closeAgent");
    return registration![1]();
  }

  // Ctrl+C before the shell has run the launch line flushes that line from the
  // tty: the agent never starts and the terminal never closes.
  it("disposes the terminal when the agent has not started yet", async () => {
    activate(makeContext());
    const socket = getSocket();
    await socket._handlers.config!(CONFIG);
    const terminal = createdTerminals[0]!;

    expect(closeAgent()).toEqual({ closed: true });

    expect(terminal.dispose).toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalledWith("\x03", false);
  });

  it("sends Ctrl+C once the shell has started the agent", async () => {
    activate(makeContext());
    const socket = getSocket();
    await socket._handlers.config!(CONFIG);
    const terminal = createdTerminals[0]!;
    shellExecutionStartHandlers[0]!({ terminal });

    expect(closeAgent()).toEqual({ closed: true });

    expect(terminal.sendText).toHaveBeenCalledWith("\x03", false);
    expect(terminal.dispose).not.toHaveBeenCalled();
    closeHandlers.forEach((handler) => handler(terminal));
  });

  // After an extension host restart the window still holds the agent terminal,
  // and the agent in it is still running. A second launch would be a second agent.
  describe("with an agent terminal that outlived the extension host", () => {
    function existingTerminal(creationOptions: unknown): FakeTerminal {
      const terminal: FakeTerminal = {
        name: "",
        creationOptions,
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      };
      vscodeWindow.terminals.push(terminal);
      return terminal;
    }

    const RESTART_CONFIG = { ...CONFIG, resetWorkspace: false };
    let agent: FakeTerminal;
    let duplicate: FakeTerminal;

    beforeEach(() => {
      existingTerminal({ name: "bash" });
      agent = existingTerminal({ name: "Claude", env: CONFIG.env });
      duplicate = existingTerminal({ name: "Claude", env: CONFIG.env });
    });

    it("adopts it instead of launching a second agent", async () => {
      activate(makeContext());
      const socket = getSocket();
      await socket._handlers.config!(RESTART_CONFIG);

      expect(createdTerminals).toHaveLength(0);
      expect(socket.emit).not.toHaveBeenCalledWith("api:workspace:agentLifecycle", {
        event: "open",
      });
      expect(agent.show).not.toHaveBeenCalled();
      expect(agent.sendText).not.toHaveBeenCalled();
      expect(duplicate.dispose).not.toHaveBeenCalled();
    });

    it("stops the adopted agent with Ctrl+C", async () => {
      activate(makeContext());
      const socket = getSocket();
      await socket._handlers.config!(RESTART_CONFIG);

      expect(closeAgent()).toEqual({ closed: true });

      expect(agent.sendText).toHaveBeenCalledWith("\x03", false);
      expect(agent.dispose).not.toHaveBeenCalled();
      expect(duplicate.sendText).not.toHaveBeenCalled();
      closeHandlers.forEach((handler) => handler(agent));
    });
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

describe("sidekick workspace environment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
  });

  it("gives terminals the user opens the workspace environment, without persisting it", async () => {
    const collection = makeEnvCollection();
    collection.values.set("STALE", "from-a-previous-open");
    activate(makeContext(collection));
    const socket = getSocket();

    await socket._handlers.config!({ ...CONFIG, workspaceEnv: { DATABASE_URL: "postgres://x" } });

    expect(collection.persistent).toBe(false);
    expect(Object.fromEntries(collection.values)).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("gives terminals nothing when the workspace has no environment", async () => {
    const collection = makeEnvCollection();
    activate(makeContext(collection));
    const socket = getSocket();

    await socket._handlers.config!(CONFIG);

    expect(collection.values.size).toBe(0);
  });
});

// CodeHydra shows a workspace as waiting on the user until a modal's ack
// arrives, so the ack must follow the dismissal. A toast waits for nothing.
describe("sidekick notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
  });

  it("shows a toast and acks it at once", () => {
    vscodeWindow.showWarningMessage.mockReturnValueOnce(new Promise(() => {}));
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showNotification"]!({ severity: "warning", message: "Hi" }, ack);

    expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith("Hi");
    expect(ack).toHaveBeenCalledWith({ success: true, data: { action: null } });
  });

  it.each([
    ["clicked", "Yes", "Yes"],
    ["cancelled", undefined, null],
  ])("acks a modal only once it is %s", async (_label, clicked, answer) => {
    let dismiss: (selected: string | undefined) => void = () => {};
    vscodeWindow.showInformationMessage.mockReturnValueOnce(
      new Promise<string | undefined>((resolve) => (dismiss = resolve))
    );
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showNotification"]!(
      { severity: "info", message: "Hi", modal: true, detail: "more", actions: ["Yes", "No"] },
      ack
    );
    await Promise.resolve();
    expect(vscodeWindow.showInformationMessage).toHaveBeenCalledWith(
      "Hi",
      { modal: true, detail: "more" },
      "Yes",
      "No"
    );
    expect(ack).not.toHaveBeenCalled();

    dismiss(clicked);
    await vi.waitFor(() =>
      expect(ack).toHaveBeenCalledWith({ success: true, data: { action: answer } })
    );
  });
});

describe("sidekick quick picks, input boxes and file dialogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
  });

  function lastInput() {
    return createdQuickInputs[createdQuickInputs.length - 1]!;
  }

  it("answers the accepted entry of a quick pick", () => {
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showQuickPick"]!(
      {
        id: "p1",
        title: "Branch",
        placeholder: "filter",
        items: [{ label: "main", description: "default" }, { label: "dev" }],
      },
      ack
    );
    const pick = lastInput();
    expect(pick).toMatchObject({ visible: true, title: "Branch", placeholder: "filter" });
    expect(pick.items).toEqual([{ label: "main", description: "default" }, { label: "dev" }]);
    pick.selectedItems = [pick.items[1]!];
    pick.accept();

    expect(ack).toHaveBeenCalledWith({ success: true, data: { selected: "dev" } });
    expect(pick.disposed).toBe(true);
  });

  it("answers every ticked entry with canPickMany, the picked ones ticked in advance", () => {
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showQuickPick"]!(
      {
        canPickMany: true,
        items: [{ label: "a", picked: true }, { label: "b" }, { label: "c", picked: true }],
      },
      ack
    );
    const pick = lastInput();
    expect(pick.canSelectMany).toBe(true);
    expect(pick.selectedItems.map((item) => item.label)).toEqual(["a", "c"]);
    pick.accept();

    expect(ack).toHaveBeenCalledWith({ success: true, data: { selected: ["a", "c"] } });
  });

  it("answers null when a quick pick is dismissed", () => {
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showQuickPick"]!({ items: [{ label: "a" }] }, ack);
    lastInput().hide();

    expect(ack).toHaveBeenCalledWith({ success: true, data: { selected: null } });
  });

  it("closes a quick pick or input box on ui:cancel, which answers null", () => {
    activate(makeContext());
    const pickAck = vi.fn();
    const inputAck = vi.fn();
    const socket = getSocket();

    socket._handlers["ui:showQuickPick"]!({ id: "p1", items: [{ label: "a" }] }, pickAck);
    socket._handlers["ui:showInputBox"]!({ id: "p2" }, inputAck);
    socket._handlers["ui:cancel"]!({ id: "p1" });
    socket._handlers["ui:cancel"]!({ id: "unknown" });

    expect(pickAck).toHaveBeenCalledWith({ success: true, data: { selected: null } });
    expect(createdQuickInputs[0]!.visible).toBe(false);
    expect(inputAck).not.toHaveBeenCalled();
    expect(createdQuickInputs[1]!.visible).toBe(true);
  });

  it("answers an input box's text, and null when it is dismissed", () => {
    activate(makeContext());
    const accepted = vi.fn();
    const dismissed = vi.fn();
    const socket = getSocket();

    socket._handlers["ui:showInputBox"]!(
      { prompt: "Name?", placeholder: "x", value: "draft", password: true },
      accepted
    );
    const box = lastInput();
    expect(box).toMatchObject({
      prompt: "Name?",
      placeholder: "x",
      value: "draft",
      password: true,
    });
    box.value = "final";
    box.accept();
    socket._handlers["ui:showInputBox"]!({}, dismissed);
    lastInput().hide();

    expect(accepted).toHaveBeenCalledWith({ success: true, data: { value: "final" } });
    expect(dismissed).toHaveBeenCalledWith({ success: true, data: { value: null } });
  });

  it("opens an open dialog on the workspace's machine and answers the paths", async () => {
    vscodeWindow.showOpenDialog.mockResolvedValueOnce([
      { fsPath: "/repo/a.png" },
      { fsPath: "/repo/b.png" },
    ]);
    activate(makeContext());
    const ack = vi.fn();

    getSocket()._handlers["ui:showFileDialog"]!(
      { title: "Images", many: true, filters: { Images: ["png"] }, start: "/repo" },
      ack
    );

    await vi.waitFor(() =>
      expect(ack).toHaveBeenCalledWith({
        success: true,
        data: { paths: ["/repo/a.png", "/repo/b.png"] },
      })
    );
    const options = vscodeWindow.showOpenDialog.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      title: "Images",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Images: ["png"] },
    });
    expect((options["defaultUri"] as { fsPath: string }).fsPath).toBe("/repo");
  });

  it("opens a save dialog with save, and answers null when cancelled", async () => {
    vscodeWindow.showSaveDialog.mockResolvedValueOnce({ fsPath: "/repo/out.txt" });
    vscodeWindow.showOpenDialog.mockResolvedValueOnce(undefined);
    activate(makeContext());
    const saved = vi.fn();
    const cancelled = vi.fn();
    const socket = getSocket();

    socket._handlers["ui:showFileDialog"]!({ save: true }, saved);
    socket._handlers["ui:showFileDialog"]!({ folders: true }, cancelled);

    await vi.waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ success: true, data: { paths: ["/repo/out.txt"] } })
    );
    await vi.waitFor(() =>
      expect(cancelled).toHaveBeenCalledWith({ success: true, data: { paths: null } })
    );
    expect(vscodeWindow.showOpenDialog.mock.calls[0]![0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
    });
  });
});

describe("sidekick output channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
  });

  function lastChannel(): Record<string, ReturnType<typeof vi.fn>> {
    const results = vscodeWindow.createOutputChannel.mock.results;
    return results[results.length - 1]!.value as Record<string, ReturnType<typeof vi.fn>>;
  }

  it("writes a log request into a log channel at each line's level", () => {
    activate(makeContext());
    const socket = getSocket();

    socket._handlers["ui:appendOutput"]!({
      channel: "CodeHydra Log",
      log: true,
      lines: [
        { source: "git", level: "debug", text: "(git) ListBranches" },
        { source: "agent", level: "warn", text: "(agent) slow" },
      ],
    });

    expect(vscodeWindow.createOutputChannel).toHaveBeenCalledWith("CodeHydra Log", { log: true });
    const channel = lastChannel();
    expect(channel.debug).toHaveBeenCalledWith("(git) ListBranches");
    expect(channel.warn).toHaveBeenCalledWith("(agent) slow");
    expect(channel.appendLine).not.toHaveBeenCalled();
  });

  it("writes a plain request as [source] text", () => {
    activate(makeContext());
    const socket = getSocket();

    socket._handlers["ui:appendOutput"]!({
      channel: "CodeHydra Hooks",
      lines: [{ source: "after-worktree-created", text: "installing" }],
    });

    expect(vscodeWindow.createOutputChannel).toHaveBeenCalledWith("CodeHydra Hooks");
    expect(lastChannel().appendLine).toHaveBeenCalledWith("[after-worktree-created] installing");
  });
});

describe("sidekick tag commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVscodeFake();
    process.env._CH_API_PORT = "8123";
  });

  afterEach(() => {
    deactivate();
    delete process.env._CH_API_PORT;
  });

  function runCommand(id: string, arg: unknown): unknown {
    const registration = vi
      .mocked(commands.registerCommand)
      .mock.calls.find(([registered]) => registered === id);
    return registration![1](arg);
  }

  it.each([
    ["codehydra.setTag", { name: "review", color: "#8b949e" }, '{"color":"#8b949e"}'],
    ["codehydra.deleteTag", "review", null],
  ])("%s writes the tag's metadata key", (command, arg, value) => {
    activate(makeContext());
    const socket = getSocket();

    void runCommand(command, arg);

    expect(socket.emit).toHaveBeenCalledWith(
      "api:workspace:setMetadata",
      { key: "tags.review", value },
      expect.any(Function)
    );
  });
});
