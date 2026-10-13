import { vi } from "vitest";

/**
 * Shared `vscode` fake for the `extensions` vitest project.
 *
 * Under `isolate: false` a source module is evaluated once per worker and its
 * `vscode` import binding is permanently wired to whatever this module exported
 * on first evaluation. A per-file `vi.mock("vscode", factory)` would hand each
 * file a *different* object that the shared consumer modules are not connected
 * to, so every file instead does `vi.mock("vscode")` with no factory and shares
 * this single instance.
 *
 * `mockReset: true` (vitest.config.ts) restores the implementation passed to
 * `vi.fn(impl)` before each test but discards anything set via
 * `.mockReturnValue()`. Every mock here therefore uses `vi.fn(() => value)`,
 * never `vi.fn().mockReturnValue(value)`. Per-file return values a test needs
 * are configured in that file's `beforeEach` via `vi.mocked(...)`, and shared
 * captured state is cleared with `resetVscodeFake()`.
 */

// --- captured state (cleared by resetVscodeFake) ---------------------------

export interface FakeTerminal {
  name: string;
  creationOptions: unknown;
  show: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Terminals created via `window.createTerminal`, in creation order. */
export const createdTerminals: FakeTerminal[] = [];

/** Callbacks registered via `window.onDidCloseTerminal`, in registration order. */
export const closeHandlers: Array<(terminal: FakeTerminal) => void> = [];

/** Callbacks registered via `window.onDidStartTerminalShellExecution`. */
export const shellExecutionStartHandlers: Array<(event: { terminal: FakeTerminal }) => void> = [];

export interface FakeStatusBarItem {
  text: string;
  tooltip: string;
  command: unknown;
  color: unknown;
  backgroundColor: unknown;
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** The single status bar item returned by `window.createStatusBarItem`. */
export const mockStatusBarItem: FakeStatusBarItem = {
  text: "",
  tooltip: "",
  command: undefined,
  color: undefined,
  backgroundColor: undefined,
  show: vi.fn(),
  dispose: vi.fn(),
};

/**
 * A quick pick or input box made by `window.createQuickPick` / `createInputBox`.
 * `accept()` and `hide()` stand in for the user pressing Enter and Escape.
 */
export interface FakeQuickInput {
  readonly kind: "pick" | "input";
  items: readonly { label: string }[];
  selectedItems: readonly { label: string }[];
  activeItems: readonly { label: string }[];
  canSelectMany: boolean;
  title: string | undefined;
  placeholder: string | undefined;
  prompt: string | undefined;
  value: string;
  password: boolean;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
  accept(): void;
  onDidAccept(callback: () => void): { dispose: () => void };
  onDidHide(callback: () => void): { dispose: () => void };
}

/** Quick picks and input boxes created so far, in creation order. */
export const createdQuickInputs: FakeQuickInput[] = [];

function createQuickInput(kind: "pick" | "input"): FakeQuickInput {
  const accepted: Array<() => void> = [];
  const hidden: Array<() => void> = [];
  const input: FakeQuickInput = {
    kind,
    items: [],
    selectedItems: [],
    activeItems: [],
    canSelectMany: false,
    title: undefined,
    placeholder: undefined,
    prompt: undefined,
    value: "",
    password: false,
    visible: false,
    disposed: false,
    show: () => {
      input.visible = true;
    },
    hide: () => {
      if (!input.visible) return;
      input.visible = false;
      for (const callback of hidden) callback();
    },
    dispose: () => {
      input.disposed = true;
    },
    accept: () => {
      for (const callback of accepted) callback();
    },
    onDidAccept: (callback) => {
      accepted.push(callback);
      return { dispose: () => {} };
    },
    onDidHide: (callback) => {
      hidden.push(callback);
      return { dispose: () => {} };
    },
  };
  createdQuickInputs.push(input);
  return input;
}

// --- classes / enums (static, unaffected by mockReset) ---------------------

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export const ViewColumn = { Active: 1, One: 1, Two: 2, Beside: -2 } as const;

export interface FakeUri {
  readonly scheme: string;
  readonly authority: string;
  readonly fsPath: string;
  with(change: { scheme?: string; authority?: string }): FakeUri;
  toString(): string;
}

function fakeUri(scheme: string, authority: string, fsPath: string): FakeUri {
  return {
    scheme,
    authority,
    fsPath,
    with: (change) => fakeUri(change.scheme ?? scheme, change.authority ?? authority, fsPath),
    toString: () => `${scheme}://${authority}${fsPath}`,
  };
}

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
  file: (fsPath: string) => fakeUri("file", "", fsPath),
};

// --- namespaces ------------------------------------------------------------

export const window = {
  createTerminal: vi.fn((options: { name?: string }) => {
    const terminal: FakeTerminal = {
      name: options?.name ?? "",
      creationOptions: options,
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    };
    createdTerminals.push(terminal);
    return terminal;
  }),
  onDidCloseTerminal: vi.fn((callback: (terminal: FakeTerminal) => void) => {
    closeHandlers.push(callback);
    return { dispose: vi.fn() };
  }),
  onDidStartTerminalShellExecution: vi.fn(
    (callback: (event: { terminal: FakeTerminal }) => void) => {
      shellExecutionStartHandlers.push(callback);
      return { dispose: vi.fn() };
    }
  ),
  terminals: [] as FakeTerminal[],
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  createQuickPick: vi.fn(() => createQuickInput("pick")),
  createInputBox: vi.fn(() => createQuickInput("input")),
  createStatusBarItem: vi.fn(() => mockStatusBarItem),
  // Plain and log channels alike: a log channel (`{ log: true }`) also has level methods.
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  })),
  activeTextEditor: undefined as unknown,
};

export const commands = {
  registerCommand: vi.fn<
    (id: string, handler: (...args: unknown[]) => unknown) => { dispose: () => void }
  >(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(() => Promise.resolve()),
};

export const env = {
  shell: "/bin/bash",
};

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: "/workspace/feature-a" } }] as unknown,
  updateWorkspaceFolders: vi.fn(),
};

// --- reset -----------------------------------------------------------------

/**
 * Clears the shared captured state so it cannot leak between test files (which,
 * under `isolate: false`, all share this single module instance). Call it in
 * each test file's `beforeEach`. Does not touch `window.activeTextEditor`,
 * which tests redefine per-case via `Object.defineProperty`.
 */
export function resetVscodeFake(): void {
  createdTerminals.length = 0;
  closeHandlers.length = 0;
  shellExecutionStartHandlers.length = 0;
  window.terminals.length = 0;
  createdQuickInputs.length = 0;
  mockStatusBarItem.text = "";
  mockStatusBarItem.tooltip = "";
  mockStatusBarItem.command = undefined;
  mockStatusBarItem.color = undefined;
  mockStatusBarItem.backgroundColor = undefined;
  workspace.workspaceFolders = [{ uri: { fsPath: "/workspace/feature-a" } }];
  env.shell = "/bin/bash";
}
