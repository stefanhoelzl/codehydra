/**
 * The `ui:*` requests CodeHydra sends the sidekick: modal notifications,
 * output channel lines, status bar items, quick picks and input boxes — each
 * shown with the VS Code API in this workspace's editor.
 *
 * Owns what those requests create (status bar items, output channels) so
 * deactivation can dispose it.
 */
import * as vscode from "vscode";
import { getErrorMessage } from "../../../src/shared/error-utils";
import type {
  ApiResult,
  AppendOutputRequest,
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
}

const state: UiState = {
  statusBarItems: new Map(),
  outputChannels: new Map(),
  logChannels: new Map(),
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

  // Ack only once the modal is dismissed, with or without actions: CodeHydra
  // shows the workspace as waiting on the user until then.
  const actions = [...(request.actions ?? [])];
  void showFn(request.message, { modal: true }, ...actions).then((selected) => {
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

function showQuickPick(
  request: ShowQuickPickRequest,
  ack: (result: ApiResult<ShowQuickPickResponse>) => void
): void {
  const items: vscode.QuickPickItem[] = request.items.map((i) => ({
    label: i.label,
    ...(i.description !== undefined && { description: i.description }),
    ...(i.detail !== undefined && { detail: i.detail }),
  }));

  void vscode.window
    .showQuickPick(items, {
      ...(request.title !== undefined && { title: request.title }),
      ...(request.placeholder !== undefined && { placeHolder: request.placeholder }),
    })
    .then((selected) => {
      ack({ success: true, data: { selected: selected?.label ?? null } });
    });
}

function showInputBox(
  request: ShowInputBoxRequest,
  ack: (result: ApiResult<ShowInputBoxResponse>) => void
): void {
  void vscode.window
    .showInputBox({
      ...(request.title !== undefined && { title: request.title }),
      ...(request.prompt !== undefined && { prompt: request.prompt }),
      ...(request.placeholder !== undefined && { placeHolder: request.placeholder }),
      ...(request.value !== undefined && { value: request.value }),
      ...(request.password !== undefined && { password: request.password }),
    })
    .then((value) => {
      ack({ success: true, data: { value: value ?? null } });
    });
}

/** Register the `ui:*` request handlers on the API server socket. */
export function registerUiHandlers(socket: TypedSocket): void {
  socket.on("ui:showNotification", showNotification);
  socket.on("ui:appendOutput", appendOutput);
  socket.on("ui:statusBarUpdate", updateStatusBar);
  socket.on("ui:statusBarDispose", disposeStatusBar);
  socket.on("ui:showQuickPick", showQuickPick);
  socket.on("ui:showInputBox", showInputBox);
}

/** Dispose every status bar item and output channel the handlers created. */
export function disposeUiHandlers(): void {
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
