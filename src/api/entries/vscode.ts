/**
 * VS Code registry entries: the raw command passthrough, and the composed
 * commands built on top of it.
 *
 * The composed ones exist because several VS Code commands take class instances
 * (Uri, Position, Range, Selection) that cannot cross a JSON boundary, so
 * callers currently hand-write the `$vscode` wrapper form documented at length
 * in docs/API.md. Building the wrapper here means a caller passes a path or a
 * url and never sees that encoding.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps } from "./deps";
import { workspacePathSchema, type WorkspacePath } from "../../intents/contract";
import type { OperationName } from "../names";
import { Path } from "../../utils/path/path";

import { INTENT_VSCODE_COMMAND } from "../../intents/vscode-command";
import type { VscodeCommandIntent } from "../../intents/vscode-command";
import { INTENT_VSCODE_SHOW_MESSAGE } from "../../intents/vscode-show-message";
import type { VscodeShowMessageIntent } from "../../intents/vscode-show-message";

const targetWorkspace = workspacePathSchema
  .min(1)
  .optional()
  .describe("Workspace to act on. Omit to target the current workspace.");

function targetOf(ctx: OperationContext, explicit: WorkspacePath | undefined): WorkspacePath {
  const target = explicit ?? ctx.workspacePath;
  if (target === null || target === undefined) {
    throw new ApiError("no-workspace", "No workspace to act on.");
  }
  return target;
}

/** The `$vscode` wrapper form the sidekick deserializes into a real Uri. */
function uri(filePath: string): unknown {
  return { $vscode: "Uri", value: `file://${new Path(filePath).toString()}` };
}

/** A zero-width selection at a 1-based line/column, as VS Code Position objects. */
function selection(line: number, character: number): unknown {
  const position = { $vscode: "Position", line: line - 1, character: Math.max(0, character - 1) };
  return { $vscode: "Selection", anchor: position, active: position };
}

/** Split `file:line:col`, tolerating a bare path and a Windows drive letter. */
function parseLocation(spec: string): { path: string; line?: number; character?: number } {
  // Match from the right so `C:\src\a.ts:12:3` keeps its drive letter intact.
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(spec);
  if (!match || !match[1]) return { path: spec };
  return {
    path: match[1],
    ...(match[2] !== undefined && { line: Number(match[2]) }),
    ...(match[3] !== undefined && { character: Number(match[3]) }),
  };
}

export function vscodeEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher, appLayer } = deps;

  const run = (workspacePath: WorkspacePath, command: string, args?: readonly unknown[]) =>
    dispatcher.dispatch<VscodeCommandIntent>({
      type: INTENT_VSCODE_COMMAND,
      payload: { workspacePath, command, args: args as unknown[] | undefined },
    });

  const raw = defineEntry({
    name: "vscode.command",
    kind: "command",
    description: "Execute a VS Code command in a workspace.",
    instructions:
      "Most commands return undefined. Arguments needing VS Code objects use the $vscode " +
      'wrapper form, e.g. { "$vscode": "Uri", "value": "file:///path/to/file.ts" }. Prefer a ' +
      "composed command (browser, diff, goto, preview, reveal, launch) where one exists.",
    input: z.object({
      workspacePath: targetWorkspace,
      command: z.string().min(1).max(256).describe("VS Code command identifier"),
      args: z.array(z.unknown()).optional().describe("Command arguments, $vscode form supported"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(targetOf(ctx, input.workspacePath), input.command, input.args),
  });

  const message = defineEntry({
    name: "vscode.message",
    kind: "command",
    description: "Show a notification, status-bar text, or a picker in the workspace's editor.",
    instructions:
      "Types: info/warning/error show a notification (add options for action buttons, which " +
      "blocks until clicked or dismissed); status updates the status bar and supports codicon " +
      'syntax "$(icon-name) text", with a null message clearing it; select shows a quick pick ' +
      "when options are given and a free-text input when they are not. Returns { result }: the " +
      "selected option, clicked button, entered text, or null if dismissed.",
    input: z.object({
      workspacePath: targetWorkspace,
      type: z.enum(["info", "warning", "error", "status", "select"]),
      message: z.string().max(1000).nullable().describe("Display text; null clears the status bar"),
      hint: z.string().max(200).optional().describe("Tooltip for status, placeholder for select"),
      options: z.array(z.string()).max(100).optional().describe("Buttons, or selection items"),
      timeout: z.number().positive().optional().describe("Timeout in seconds for interactive use"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
      const result = await dispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath: targetOf(ctx, input.workspacePath),
          type: input.type,
          message: input.message,
          ...(input.hint !== undefined && { hint: input.hint }),
          ...(input.options !== undefined && { options: input.options }),
          ...(timeoutMs !== undefined && { timeoutMs }),
        },
      });
      return { result };
    },
  });

  /** Build one of the three CLI-facing forms of vscode.message. */
  const messageForm = (
    name: OperationName,
    description: string,
    build: (
      level: "info" | "warning" | "error"
    ) => "info" | "warning" | "error" | "status" | "select"
  ) =>
    defineEntry({
      name,
      kind: "command",
      description,
      input: z.object({
        workspacePath: targetWorkspace,
        message: z.string().max(1000).nullable(),
        hint: z.string().max(200).optional(),
        options: z.array(z.string()).max(100).optional(),
        timeout: z.number().positive().optional(),
        level: z.enum(["info", "warning", "error"]).optional().default("info"),
      }),
      requiresWorkspace: true,
      handler: async (ctx, input) => {
        const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
        const result = await dispatcher.dispatch<VscodeShowMessageIntent>({
          type: INTENT_VSCODE_SHOW_MESSAGE,
          payload: {
            workspacePath: targetOf(ctx, input.workspacePath),
            type: build(input.level),
            message: input.message,
            ...(input.hint !== undefined && { hint: input.hint }),
            ...(input.options !== undefined && { options: input.options }),
            ...(timeoutMs !== undefined && { timeoutMs }),
          },
        });
        return { result };
      },
    });

  const notify = messageForm(
    "vscode.notify",
    "Show a notification in the workspace's editor.",
    (level) => level
  );

  const statusBar = messageForm(
    "vscode.status-bar",
    "Set or clear the workspace's status-bar text.",
    () => "status"
  );

  const ask = messageForm(
    "vscode.ask",
    "Ask for a choice or free text in the workspace's editor.",
    () => "select"
  );

  const browser = defineEntry({
    name: "vscode.browser",
    kind: "command",
    description: "Open a url in the workspace's built-in simple browser.",
    input: z.object({
      workspacePath: targetWorkspace,
      url: z.url().describe("Url to open"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(targetOf(ctx, input.workspacePath), "simpleBrowser.show", [input.url]),
  });

  const diff = defineEntry({
    name: "vscode.diff",
    kind: "command",
    description: "Open a diff of two files in the workspace's editor.",
    input: z.object({
      workspacePath: targetWorkspace,
      left: z.string().min(1).describe("Path of the left-hand file"),
      right: z.string().min(1).describe("Path of the right-hand file"),
      title: z.string().min(1).optional().describe("Editor tab title"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(targetOf(ctx, input.workspacePath), "vscode.diff", [
        uri(input.left),
        uri(input.right),
        ...(input.title !== undefined ? [input.title] : []),
      ]),
  });

  const goto = defineEntry({
    name: "vscode.goto",
    kind: "command",
    description: "Open a file in the editor, optionally at a line and column.",
    instructions:
      "Accepts either separate fields or a 'file:line:column' location string. Line and column " +
      "are 1-based, matching what compilers and grep print.",
    input: z.object({
      workspacePath: targetWorkspace,
      location: z.string().min(1).describe("Path, or 'path:line' / 'path:line:column'"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const { path, line, character } = parseLocation(input.location);
      const target = targetOf(ctx, input.workspacePath);
      if (line === undefined) return run(target, "vscode.open", [uri(path)]);
      return run(target, "vscode.open", [
        uri(path),
        { selection: selection(line, character ?? 1) },
      ]);
    },
  });

  const preview = defineEntry({
    name: "vscode.preview",
    kind: "command",
    description: "Open a markdown preview in the workspace's editor.",
    input: z.object({
      workspacePath: targetWorkspace,
      path: z.string().min(1).describe("Path of the markdown file"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(targetOf(ctx, input.workspacePath), "markdown.showPreview", [uri(input.path)]),
  });

  const systemPath = defineEntry({
    name: "system.open",
    kind: "command",
    description: "Open a path with the OS, or reveal it in the file manager.",
    input: z.object({
      path: z.string().min(1).describe("Absolute path to a file or folder"),
      reveal: z
        .boolean()
        .optional()
        .default(false)
        .describe("Show it in the file manager instead of opening it"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const target = new Path(input.path);
      // Revealing a file means opening the folder that contains it; revealing a
      // folder means opening the folder itself.
      await appLayer.openPath(input.reveal ? target.dirname.toNative() : target.toNative());
      return null;
    },
  });

  return [raw, message, notify, statusBar, ask, browser, diff, goto, preview, systemPath];
}
