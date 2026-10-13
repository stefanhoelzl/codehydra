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

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import { ApiError } from "../errors";
import type { EntryDeps } from "./deps";
import { createTargetResolver, targetFields } from "./target";
import type { WorkspaceRef } from "../../intents/contract";
import { Path } from "../../utils/path/path";

import { INTENT_VSCODE_COMMAND } from "../../intents/vscode-command";
import type { VscodeCommandIntent } from "../../intents/vscode-command";
import { INTENT_VSCODE_SHOW_MESSAGE } from "../../intents/vscode-show-message";
import type {
  VscodeShowMessageIntent,
  VscodeShowMessagePayload,
  VscodeShowMessageResult,
} from "../../intents/vscode-show-message";
import { INTENT_VSCODE_CANCEL_MESSAGE } from "../../intents/vscode-cancel-message";
import type { VscodeCancelMessageIntent } from "../../intents/vscode-cancel-message";
import {
  INTENT_SHOW_NOTIFICATION,
  type ShowNotificationIntent,
} from "../../intents/show-notification";
import {
  INTENT_CLOSE_NOTIFICATION,
  type CloseNotificationIntent,
} from "../../intents/close-notification";

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
  const targetOf = createTargetResolver(dispatcher);

  const run = (workspaceRef: WorkspaceRef, command: string, args?: readonly unknown[]) =>
    dispatcher.dispatch<VscodeCommandIntent>({
      type: INTENT_VSCODE_COMMAND,
      payload: { workspaceRef, command, args: args as unknown[] | undefined },
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
      ...targetFields,
      command: z.string().min(1).max(256).describe("VS Code command identifier"),
      args: z.array(z.unknown()).optional().describe("Command arguments, $vscode form supported"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => run(await targetOf(ctx, input), input.command, input.args),
  });

  const show = (
    payload: Omit<VscodeShowMessagePayload, "workspaceRef">,
    workspaceRef: WorkspaceRef
  ) =>
    dispatcher.dispatch<VscodeShowMessageIntent>({
      type: INTENT_VSCODE_SHOW_MESSAGE,
      payload: { workspaceRef, ...payload },
    });

  /**
   * Put a question and wait for the answer, for as long as the caller is there:
   * when its connection goes (Ctrl+C on `ch`, an aborted agent turn) the
   * question is cancelled and the answer is null.
   */
  const question = async (
    ctx: OperationContext,
    workspaceRef: WorkspaceRef,
    payload: Omit<VscodeShowMessagePayload, "workspaceRef" | "waiter">
  ): Promise<{ answer: VscodeShowMessageResult }> => {
    if (ctx.signal.aborted) return { answer: null };
    const waiter = `question-${randomUUID()}`;
    const cancel = (): void => {
      void dispatcher
        .dispatch<VscodeCancelMessageIntent>({
          type: INTENT_VSCODE_CANCEL_MESSAGE,
          payload: { waiter },
        })
        .catch(() => undefined);
    };
    ctx.signal.addEventListener("abort", cancel, { once: true });
    try {
      return { answer: await show({ ...payload, waiter }, workspaceRef) };
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
  };

  const timeoutField = z
    .number()
    .positive()
    .optional()
    .describe("Give up after this many seconds; the answer is then null");

  const message = defineEntry({
    name: "vscode.message",
    kind: "command",
    description: "Show the user a notification or status-bar text in the workspace's editor.",
    instructions:
      "For the USER watching the editor — the agent never sees it; to tell the agent " +
      "something, use agent.message. Never waits: info/warning/error show a toast; status " +
      'updates the status bar and supports codicon syntax "$(icon-name) text", with a null ' +
      "message clearing it. To ask the user something, use ask, select, input or pick-file.",
    input: z.object({
      ...targetFields,
      type: z.enum(["info", "warning", "error", "status"]),
      message: z.string().max(1000).nullable().describe("Display text; null clears the status bar"),
      hint: z.string().max(200).optional().describe("Tooltip for status"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      await show(
        {
          type: input.type,
          message: input.message,
          ...(input.hint !== undefined && { hint: input.hint }),
        },
        await targetOf(ctx, input)
      );
      return null;
    },
  });

  /** Who the forms below are for — the other half of agent.message. */
  const FOR_THE_USER =
    "For the USER watching the editor — the agent never sees it. To tell the agent " +
    "something, use agent.message.";

  const notify = defineEntry({
    name: "vscode.notify",
    kind: "command",
    description: "Show the user a toast notification in the workspace's editor.",
    instructions: `${FOR_THE_USER} Never waits and takes no answer: to ask, use ask.`,
    input: z.object({
      ...targetFields,
      message: z.string().min(1).max(1000),
      level: z.enum(["info", "warning", "error"]).optional().default("info"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      await show({ type: input.level, message: input.message }, await targetOf(ctx, input));
      return null;
    },
  });

  const statusBar = defineEntry({
    name: "vscode.status-bar",
    kind: "command",
    description: "Set or clear the workspace's status-bar text, for the user.",
    instructions:
      `${FOR_THE_USER} Supports codicon syntax "$(icon-name) text"; a null message ` + "clears it.",
    input: z.object({
      ...targetFields,
      message: z.string().max(1000).nullable(),
      hint: z.string().max(200).optional().describe("Tooltip"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      await show(
        {
          type: "status",
          message: input.message,
          ...(input.hint !== undefined && { hint: input.hint }),
        },
        await targetOf(ctx, input)
      );
      return null;
    },
  });

  // Waits on a sidebar card are named per registry: tokens only have to be
  // unique among live waits.
  let sidebarWaiterSeq = 0;

  const ask = defineEntry({
    name: "vscode.ask",
    kind: "command",
    description: "Ask the user a question with buttons and wait for the answer.",
    instructions:
      `${FOR_THE_USER} Shows a dialog in the workspace's editor, or with sidebar a card in ` +
      "CodeHydra's sidebar, which the user sees from any workspace. A Cancel is always there " +
      "(the dialog's Cancel button, the card's dismiss X): do not pass one as an option. " +
      "Returns { answer }: the clicked option, or null if cancelled, timed out or the caller " +
      "went away. The workspace shows as waiting on the user while it is open. For free " +
      "text, more than 5 options or long labels, use select or input.",
    input: z.object({
      ...targetFields,
      message: z.string().min(1).max(200).describe("The question"),
      detail: z.string().max(1000).optional().describe("Secondary text under the question"),
      options: z
        .array(z.string().min(1).max(50))
        .min(1)
        .max(5)
        .describe("The buttons, 1 to 5; Cancel is added by itself"),
      level: z.enum(["info", "warning", "error"]).optional().default("info"),
      sidebar: z
        .boolean()
        .optional()
        .describe("Show it as a card in CodeHydra's sidebar instead of the editor"),
      timeout: timeoutField,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const workspaceRef = await targetOf(ctx, input);
      const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
      if (!input.sidebar) {
        return question(ctx, workspaceRef, {
          type: "ask",
          message: input.message,
          severity: input.level,
          options: input.options,
          ...(input.detail !== undefined && { detail: input.detail }),
          ...(timeoutMs !== undefined && { timeoutMs }),
        });
      }

      if (ctx.signal.aborted) return { answer: null };
      const waiter = `ask-${++sidebarWaiterSeq}`;
      const release = (): void => {
        void dispatcher
          .dispatch<CloseNotificationIntent>({
            type: INTENT_CLOSE_NOTIFICATION,
            payload: { waiter },
          })
          .catch(() => undefined);
      };
      ctx.signal.addEventListener("abort", release, { once: true });
      try {
        const result = await dispatcher.dispatch<ShowNotificationIntent>({
          type: INTENT_SHOW_NOTIFICATION,
          payload: {
            config: {
              title: input.message,
              type: input.level,
              dismissible: true,
              ...(input.detail !== undefined && { message: input.detail }),
              actions: input.options.map((label) => ({ id: label, label })),
            },
            workspaceRef,
            wait: true,
            waiter,
            ...(timeoutMs !== undefined && { timeoutMs }),
          },
        });
        return { answer: "choice" in result ? result.choice : null };
      } finally {
        ctx.signal.removeEventListener("abort", release);
      }
    },
  });

  const select = defineEntry({
    name: "vscode.select",
    kind: "command",
    description: "Let the user pick from a list in the workspace's editor and wait for it.",
    instructions:
      `${FOR_THE_USER} A filterable quick pick: for long lists, long labels or several ` +
      "choices (many); for a few short options, use ask. An option is a label, or " +
      "{ label, description?, detail?, picked? } (picked = ticked in advance, with many). " +
      "Returns { answer }: the label, every ticked label with many, or null if dismissed, " +
      "timed out or the caller went away. Escape cancels.",
    input: z.object({
      ...targetFields,
      message: z.string().max(200).optional().describe("Title of the list"),
      options: z
        .array(
          z.union([
            z.string().min(1).max(500),
            z.object({
              label: z.string().min(1).max(500),
              description: z.string().max(500).optional(),
              detail: z.string().max(1000).optional(),
              picked: z.boolean().optional(),
            }),
          ])
        )
        .min(1)
        .max(1000)
        .describe("The entries: a label, or a JSON object with label, description, detail, picked"),
      many: z.boolean().optional().describe("Tick several; the answer is a list"),
      hint: z.string().max(200).optional().describe("Placeholder in the filter box"),
      timeout: timeoutField,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
      return question(ctx, await targetOf(ctx, input), {
        type: "select",
        message: input.message ?? null,
        items: input.options.map((option) =>
          typeof option === "string"
            ? { label: option }
            : {
                label: option.label,
                ...(option.description !== undefined && { description: option.description }),
                ...(option.detail !== undefined && { detail: option.detail }),
                ...(option.picked !== undefined && { picked: option.picked }),
              }
        ),
        ...(input.many !== undefined && { many: input.many }),
        ...(input.hint !== undefined && { hint: input.hint }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });
    },
  });

  const inputEntry = defineEntry({
    name: "vscode.input",
    kind: "command",
    description: "Ask the user for text in the workspace's editor and wait for it.",
    instructions:
      `${FOR_THE_USER} An input box. Returns { answer }: the text (possibly empty), or null ` +
      "if dismissed, timed out or the caller went away. Escape cancels.",
    input: z.object({
      ...targetFields,
      message: z.string().max(500).optional().describe("Prompt under the box"),
      value: z.string().max(10000).optional().describe("Text the box starts with"),
      password: z.boolean().optional().describe("Mask what is typed"),
      hint: z.string().max(200).optional().describe("Placeholder"),
      timeout: timeoutField,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
      return question(ctx, await targetOf(ctx, input), {
        type: "input",
        message: input.message ?? null,
        ...(input.value !== undefined && { value: input.value }),
        ...(input.password !== undefined && { password: input.password }),
        ...(input.hint !== undefined && { hint: input.hint }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });
    },
  });

  const pickFile = defineEntry({
    name: "vscode.pick-file",
    kind: "command",
    description: "Let the user pick a file or folder in the workspace's editor and wait for it.",
    instructions:
      `${FOR_THE_USER} An open dialog, or with save a save dialog (a path that need not ` +
      "exist). It browses the machine the workspace runs on. Returns { answer }: the path, " +
      "every path with many, or null if cancelled, timed out or the caller went away.",
    input: z.object({
      ...targetFields,
      message: z.string().max(200).optional().describe("Dialog title"),
      folders: z.boolean().optional().describe("Pick folders instead of files"),
      many: z.boolean().optional().describe("Pick several; the answer is a list"),
      save: z.boolean().optional().describe("A save dialog instead of an open dialog"),
      filters: z
        .record(z.string().min(1), z.array(z.string().min(1)))
        .optional()
        .describe('File types, name → extensions without the dot: {"Images":["png","jpg"]}'),
      start: z.string().min(1).optional().describe("Where the dialog starts: a folder or file"),
      timeout: timeoutField,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      if (input.save && (input.many || input.folders)) {
        throw new ApiError("usage", "save picks one file: drop many and folders.");
      }
      let start: string | undefined;
      if (input.start !== undefined) {
        // Relative to where a shell stands; other callers have nowhere to stand.
        const base = isAbsolute(input.start) ? null : ctx.cwd;
        if (base === null && !isAbsolute(input.start)) {
          throw new ApiError("usage", "start must be an absolute path.");
        }
        start = (base === null ? new Path(input.start) : new Path(base, input.start)).toNative();
      }
      const timeoutMs = input.timeout !== undefined ? input.timeout * 1000 : undefined;
      return question(ctx, await targetOf(ctx, input), {
        type: "pick-file",
        message: input.message ?? null,
        ...(input.folders !== undefined && { folders: input.folders }),
        ...(input.many !== undefined && { many: input.many }),
        ...(input.save !== undefined && { save: input.save }),
        ...(input.filters !== undefined && { filters: input.filters }),
        ...(start !== undefined && { start }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });
    },
  });

  const browser = defineEntry({
    name: "vscode.browser",
    kind: "command",
    description: "Open a url in the workspace's built-in simple browser.",
    input: z.object({
      ...targetFields,
      url: z.url().describe("Url to open"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(await targetOf(ctx, input), "simpleBrowser.show", [input.url]),
  });

  const diff = defineEntry({
    name: "vscode.diff",
    kind: "command",
    description: "Open a diff of two files in the workspace's editor.",
    input: z.object({
      ...targetFields,
      left: z.string().min(1).describe("Path of the left-hand file"),
      right: z.string().min(1).describe("Path of the right-hand file"),
      title: z.string().min(1).optional().describe("Editor tab title"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(await targetOf(ctx, input), "vscode.diff", [
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
      ...targetFields,
      location: z.string().min(1).describe("Path, or 'path:line' / 'path:line:column'"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const { path, line, character } = parseLocation(input.location);
      const target = await targetOf(ctx, input);
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
      ...targetFields,
      path: z.string().min(1).describe("Path of the markdown file"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      run(await targetOf(ctx, input), "markdown.showPreview", [uri(input.path)]),
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

  return [
    raw,
    message,
    notify,
    statusBar,
    ask,
    select,
    inputEntry,
    pickFile,
    browser,
    diff,
    goto,
    preview,
    systemPath,
  ];
}
