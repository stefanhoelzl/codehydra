/**
 * The `ui:*` requests CodeHydra sends the sidekick: notifications (toasts and
 * modals), output channel lines, status bar items, quick picks, input boxes and
 * file dialogs — each shown with the VS Code API in this workspace's editor.
 *
 * Owns what those requests create (status bar items, output channels, open
 * quick picks and input boxes) so deactivation can dispose it.
 */
import * as vscode from "vscode";
import { getErrorMessage } from "../../../src/shared/error-utils";
import type {
  ApiResult,
  AppendOutputRequest,
  CancelUiRequest,
  ShowFileDialogRequest,
  ShowFileDialogResponse,
  ShowInputBoxRequest,
  ShowInputBoxResponse,
  ShowNotificationRequest,
  ShowNotificationResponse,
  ShowQuickPickRequest,
  ShowQuickPickResponse,
  StatusBarDisposeRequest,
  StatusBarUpdateRequest,
  TypedSocket,
} from "./types";

interface UiState {
  /** Status bar items created via ui:statusBarUpdate, keyed by id. */
  statusBarItems: Map<string, vscode.StatusBarItem>;
  /**
   * Output channels CodeHydra writes into, by name. Created on first use and
   * kept for the session: a channel disposed and recreated loses its
   * scrollback, and these hold a record the user may come back to.
   */
  outputChannels: Map<string, vscode.OutputChannel>;
  /** Log channels (`LogOutputChannel`) by name; kept like the plain ones. */
  logChannels: Map<string, vscode.LogOutputChannel>;
  /** Open quick picks and input boxes by request id, so `ui:cancel` can close them. */
  prompts: Map<string, vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox>;
}

const state: UiState = {
  statusBarItems: new Map(),
  outputChannels: new Map(),
  logChannels: new Map(),
  prompts: new Map(),
};

function getOutputChannel(name: string): vscode.OutputChannel {
  let channel = state.outputChannels.get(name);
  if (!channel) {
    channel = vscode.window.createOutputChannel(name);
    state.outputChannels.set(name, channel);
  }
  return channel;
}

function getLogChannel(name: string): vscode.LogOutputChannel {
  let channel = state.logChannels.get(name);
  if (!channel) {
    channel = vscode.window.createOutputChannel(name, { log: true });
    state.logChannels.set(name, channel);
  }
  return channel;
}

function showNotification(
  request: ShowNotificationRequest,
  ack: (result: ApiResult<ShowNotificationResponse>) => void
): void {
  const showFn =
    request.severity === "error"
      ? vscode.window.showErrorMessage
      : request.severity === "warning"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;

  if (!request.modal) {
    // A toast answers nothing and holds nobody up: ack at once.
    void showFn(request.message);
    ack({ success: true, data: { action: null } });
    return;
  }

  // Ack only once the modal is dismissed: CodeHydra shows the workspace as
  // waiting on the user until then. VS Code adds a Cancel button of its own,
  // which answers undefined like closing it.
  const actions = [...(request.actions ?? [])];
  const options: vscode.MessageOptions = {
    modal: true,
    ...(request.detail !== undefined && { detail: request.detail }),
  };
  void showFn(request.message, options, ...actions).then((selected) => {
    ack({ success: true, data: { action: selected ?? null } });
  });
}

function appendOutput(request: AppendOutputRequest): void {
  // No ack: this is output on its way to a human, and dropping a line must
  // never be able to fail anything upstream. Nothing here may log: CodeHydra's
  // own log lines arrive through this event, and a line about them would
  // come straight back.
  try {
    if (request.log) {
      // A log channel stamps time and level itself, and drops what is below
      // the level the user set on it.
      const channel = getLogChannel(request.channel);
      for (const line of request.lines) {
        channel[line.level ?? "info"](line.text);
      }
      return;
    }
    const channel = getOutputChannel(request.channel);
    for (const line of request.lines) {
      channel.appendLine(`[${line.source}] ${line.text}`);
    }
  } catch {
    // A channel we cannot write to is not worth reporting anywhere the user
    // would see it — the same text is already in CodeHydra's log file.
  }
}

function updateStatusBar(
  request: StatusBarUpdateRequest,
  ack: (result: ApiResult<void>) => void
): void {
  try {
    let item = state.statusBarItems.get(request.id);
    if (!item) {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
      state.statusBarItems.set(request.id, item);
    }
    item.text = request.text;
    if (request.tooltip !== undefined) item.tooltip = request.tooltip;
    if (request.command !== undefined) item.command = request.command;
    if (request.color !== undefined) {
      item.color = request.color;
    }
    item.show();
    ack({ success: true, data: undefined });
  } catch (err) {
    ack({ success: false, error: getErrorMessage(err) });
  }
}

function disposeStatusBar(
  request: StatusBarDisposeRequest,
  ack: (result: ApiResult<void>) => void
): void {
  const item = state.statusBarItems.get(request.id);
  if (item) {
    item.dispose();
    state.statusBarItems.delete(request.id);
  }
  ack({ success: true, data: undefined });
}

/**
 * Track a quick pick or input box under its request id until it hides, so
 * `ui:cancel` can close it. Hiding it (by the user or by a cancel) answers
 * `onHide`'s value unless `accept` already answered.
 */
function track<T extends vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox>(
  id: string | undefined,
  widget: T,
  answer: (value: "hidden" | "accepted") => void
): void {
  if (id !== undefined) state.prompts.set(id, widget);
  let answered = false;
  widget.onDidAccept(() => {
    if (answered) return;
    answered = true;
    answer("accepted");
    widget.hide();
  });
  widget.onDidHide(() => {
    if (id !== undefined && state.prompts.get(id) === widget) state.prompts.delete(id);
    if (!answered) {
      answered = true;
      answer("hidden");
    }
    widget.dispose();
  });
  widget.show();
}

function showQuickPick(
  request: ShowQuickPickRequest,
  ack: (result: ApiResult<ShowQuickPickResponse>) => void
): void {
  const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
  const items: vscode.QuickPickItem[] = request.items.map((i) => ({
    label: i.label,
    ...(i.description !== undefined && { description: i.description }),
    ...(i.detail !== undefined && { detail: i.detail }),
  }));
  pick.items = items;
  pick.canSelectMany = request.canPickMany === true;
  if (pick.canSelectMany) {
    pick.selectedItems = items.filter((_, index) => request.items[index]?.picked === true);
  }
  if (request.title !== undefined) pick.title = request.title;
  if (request.placeholder !== undefined) pick.placeholder = request.placeholder;

  track(request.id, pick, (how) => {
    if (how === "hidden") {
      ack({ success: true, data: { selected: null } });
      return;
    }
    if (pick.canSelectMany) {
      ack({ success: true, data: { selected: pick.selectedItems.map((item) => item.label) } });
      return;
    }
    const chosen = pick.selectedItems[0] ?? pick.activeItems[0];
    ack({ success: true, data: { selected: chosen?.label ?? null } });
  });
}

function showInputBox(
  request: ShowInputBoxRequest,
  ack: (result: ApiResult<ShowInputBoxResponse>) => void
): void {
  const box = vscode.window.createInputBox();
  if (request.title !== undefined) box.title = request.title;
  if (request.prompt !== undefined) box.prompt = request.prompt;
  if (request.placeholder !== undefined) box.placeholder = request.placeholder;
  if (request.value !== undefined) box.value = request.value;
  if (request.password !== undefined) box.password = request.password;

  track(request.id, box, (how) => {
    ack({ success: true, data: { value: how === "accepted" ? box.value : null } });
  });
}

function showFileDialog(
  request: ShowFileDialogRequest,
  ack: (result: ApiResult<ShowFileDialogResponse>) => void
): void {
  // The workspace's own scheme (vscode-remote in CodeHydra), so the dialog
  // browses the machine the workspace runs on.
  const scheme = vscode.workspace.workspaceFolders?.[0]?.uri.scheme ?? "file";
  const start =
    request.start !== undefined
      ? vscode.Uri.file(request.start).with({
          scheme,
          authority: vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "",
        })
      : undefined;
  const filters =
    request.filters !== undefined
      ? Object.fromEntries(Object.entries(request.filters).map(([name, ext]) => [name, [...ext]]))
      : undefined;
  const common = {
    ...(request.title !== undefined && { title: request.title }),
    ...(start !== undefined && { defaultUri: start }),
    ...(filters !== undefined && { filters }),
  };

  const answer = (uris: readonly vscode.Uri[] | undefined): void => {
    ack({
      success: true,
      data: { paths: uris === undefined || uris.length === 0 ? null : uris.map((u) => u.fsPath) },
    });
  };

  if (request.save) {
    void vscode.window
      .showSaveDialog(common)
      .then((uri) => answer(uri === undefined ? undefined : [uri]));
    return;
  }
  void vscode.window
    .showOpenDialog({
      ...common,
      canSelectFiles: !request.folders,
      canSelectFolders: request.folders === true,
      canSelectMany: request.many === true,
    })
    .then(answer);
}

function cancel(request: CancelUiRequest): void {
  // Hiding it answers the request with nothing (see `track`).
  state.prompts.get(request.id)?.hide();
}

/** Register the `ui:*` request handlers on the API server socket. */
export function registerUiHandlers(socket: TypedSocket): void {
  socket.on("ui:showNotification", showNotification);
  socket.on("ui:appendOutput", appendOutput);
  socket.on("ui:statusBarUpdate", updateStatusBar);
  socket.on("ui:statusBarDispose", disposeStatusBar);
  socket.on("ui:showQuickPick", showQuickPick);
  socket.on("ui:showInputBox", showInputBox);
  socket.on("ui:showFileDialog", showFileDialog);
  socket.on("ui:cancel", cancel);
}

/** Dispose every status bar item, output channel and open prompt the handlers created. */
export function disposeUiHandlers(): void {
  for (const prompt of [...state.prompts.values()]) {
    prompt.hide();
  }
  state.prompts.clear();
  for (const item of state.statusBarItems.values()) {
    item.dispose();
  }
  state.statusBarItems.clear();
  for (const channel of state.outputChannels.values()) {
    channel.dispose();
  }
  state.outputChannels.clear();
  for (const channel of state.logChannels.values()) {
    channel.dispose();
  }
  state.logChannels.clear();
}
