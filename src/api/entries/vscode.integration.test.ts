// @vitest-environment node
/**
 * The editor forms of `vscode.*` — the toast, the status bar and the questions
 * (ask, select, input, pick-file) — run through the real registry, with the
 * `vscode:show-message` / `vscode:cancel-message` operations standing in for the
 * API server module: what reaches the editor, what the caller gets back, and
 * what happens when the caller goes away.
 *
 * `vscode.ask` with `sidebar` lives with the notification entries, since it is
 * a sidebar card (notification.integration.test.ts).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspaceRef } from "../../intents/contract";
import { projPath, wsPath, workspaceRefIn } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import type { Operation, OperationContext as IntentContext } from "../../intents/lib/operation";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
  type VscodeShowMessagePayload,
  type VscodeShowMessageResult,
} from "../../intents/vscode-show-message";
import {
  INTENT_VSCODE_CANCEL_MESSAGE,
  VSCODE_CANCEL_MESSAGE_OPERATION_ID,
} from "../../intents/vscode-cancel-message";
import { Path } from "../../utils/path/path";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const anySchemas = (type: string) => ({ type, payload: z.unknown(), result: z.unknown() });

/** Nothing is listed: a workspace named by its full ref is taken at its word. */
class ListNoProjectsOp implements Operation<ReturnType<typeof anySchemas>> {
  readonly id = "list-projects";
  readonly schemas = anySchemas(INTENT_LIST_PROJECTS);
  async execute(): Promise<unknown[]> {
    return [];
  }
}

const PROJECT = projPath("/projects/app");
const FEAT_PATH = wsPath("/projects/app/workspaces/feat");
const FEAT = workspaceRefIn(PROJECT, "feat");

/**
 * The editor, as the registry sees it: every message shown, answered from
 * `answers` — or, for a question with no answer queued, held until cancelled.
 */
function createEditor() {
  const shown: VscodeShowMessagePayload[] = [];
  const cancelled: string[] = [];
  const answers: VscodeShowMessageResult[] = [];
  const held = new Map<string, (answer: VscodeShowMessageResult) => void>();

  const show: Operation<ReturnType<typeof anySchemas>> = {
    id: VSCODE_SHOW_MESSAGE_OPERATION_ID,
    schemas: anySchemas(INTENT_VSCODE_SHOW_MESSAGE),
    async execute(ctx: IntentContext<{ type: string; payload: unknown }>) {
      const payload = ctx.intent.payload as VscodeShowMessagePayload;
      shown.push(payload);
      if (answers.length > 0) return answers.shift() ?? null;
      if (payload.waiter === undefined) return null;
      return new Promise<VscodeShowMessageResult>((resolve) => held.set(payload.waiter!, resolve));
    },
  };
  const cancel: Operation<ReturnType<typeof anySchemas>> = {
    id: VSCODE_CANCEL_MESSAGE_OPERATION_ID,
    schemas: anySchemas(INTENT_VSCODE_CANCEL_MESSAGE),
    async execute(ctx: IntentContext<{ type: string; payload: unknown }>) {
      const { waiter } = ctx.intent.payload as { waiter: string };
      cancelled.push(waiter);
      held.get(waiter)?.(null);
    },
  };
  return { show, cancel, shown, cancelled, answers };
}

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new ListNoProjectsOp());
  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [FEAT_PATH]: { projectPath: PROJECT, workspaceName: "feat" as WorkspaceName },
    },
    projects: { [PROJECT]: { projectId: "app-1" as ProjectId } },
  });
  const editor = createEditor();
  dispatcher.registerOperation(editor.show);
  dispatcher.registerOperation(editor.cancel);
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );

  const call = (
    name: OperationName,
    input: Record<string, unknown>,
    options: { signal?: AbortSignal; cwd?: string; workspace?: WorkspaceRef } = {}
  ): Promise<unknown> => {
    const ctx: OperationContext = {
      workspaceRef: options.workspace ?? FEAT,
      cwd: options.cwd ?? null,
      signal: options.signal ?? new AbortController().signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, editor };
}

/** What a payload says, without the token minted per call. */
function withoutWaiter(payload: VscodeShowMessagePayload | undefined): object {
  return Object.fromEntries(Object.entries(payload ?? {}).filter(([key]) => key !== "waiter"));
}

describe("vscode.notify and vscode.status-bar", () => {
  it("shows a toast that waits for nothing", async () => {
    const { call, editor } = setup();

    await expect(call("vscode.notify", { message: "Built", level: "warning" })).resolves.toBe(null);

    expect(editor.shown).toEqual([{ workspaceRef: FEAT, type: "warning", message: "Built" }]);
  });

  it("sets and clears the status bar", async () => {
    const { call, editor } = setup();

    await call("vscode.status-bar", { message: "$(sync~spin) Building", hint: "tests" });
    await call("vscode.status-bar", { message: null });

    expect(editor.shown).toEqual([
      { workspaceRef: FEAT, type: "status", message: "$(sync~spin) Building", hint: "tests" },
      { workspaceRef: FEAT, type: "status", message: null },
    ]);
  });

  it("vscode.message has no questions any more", async () => {
    const { call } = setup();

    await expect(
      call("vscode.message", { type: "select", message: "Which?" })
    ).rejects.toMatchObject({ category: "usage" });
  });
});

describe("vscode.ask in the editor", () => {
  it("puts the question as a modal and answers the clicked button", async () => {
    const { call, editor } = setup();
    editor.answers.push("Deploy");

    const answer = await call("vscode.ask", {
      message: "Deploy?",
      detail: "to staging",
      options: ["Deploy", "Skip"],
      timeout: 2,
    });

    expect(answer).toEqual({ answer: "Deploy" });
    expect(withoutWaiter(editor.shown[0])).toEqual({
      workspaceRef: FEAT,
      type: "ask",
      message: "Deploy?",
      severity: "info",
      detail: "to staging",
      options: ["Deploy", "Skip"],
      timeoutMs: 2000,
    });
  });

  it("answers null and cancels the question when its caller disconnects", async () => {
    const { call, editor } = setup();
    const connection = new AbortController();

    const answer = call(
      "vscode.ask",
      { message: "Deploy?", options: ["Deploy"] },
      {
        signal: connection.signal,
      }
    );
    await expect.poll(() => editor.shown.length).toBe(1);
    connection.abort();

    await expect(answer).resolves.toEqual({ answer: null });
    expect(editor.cancelled).toEqual([editor.shown[0]!.waiter]);
  });

  it("does not put a question for a caller already gone", async () => {
    const { call, editor } = setup();
    const connection = new AbortController();
    connection.abort();

    await expect(
      call("vscode.ask", { message: "Deploy?", options: ["Deploy"] }, { signal: connection.signal })
    ).resolves.toEqual({ answer: null });
    expect(editor.shown).toEqual([]);
  });

  it("needs at least one button", async () => {
    const { call } = setup();

    await expect(call("vscode.ask", { message: "Deploy?", options: [] })).rejects.toMatchObject({
      category: "usage",
    });
  });
});

describe("vscode.select", () => {
  it("lists labels and described entries, ticked ones with many", async () => {
    const { call, editor } = setup();
    editor.answers.push(["main", "dev"]);

    const answer = await call("vscode.select", {
      message: "Branches",
      options: ["main", { label: "dev", description: "nightly", detail: "ci", picked: true }],
      many: true,
      hint: "filter",
    });

    expect(answer).toEqual({ answer: ["main", "dev"] });
    expect(withoutWaiter(editor.shown[0])).toEqual({
      workspaceRef: FEAT,
      type: "select",
      message: "Branches",
      items: [
        { label: "main" },
        { label: "dev", description: "nightly", detail: "ci", picked: true },
      ],
      many: true,
      hint: "filter",
    });
  });

  it("answers null when dismissed", async () => {
    const { call, editor } = setup();
    editor.answers.push(null);

    await expect(call("vscode.select", { options: ["a"] })).resolves.toEqual({ answer: null });
    expect(editor.shown[0]).toMatchObject({ type: "select", message: null });
  });
});

describe("vscode.input", () => {
  it("asks for text, prefilled and masked", async () => {
    const { call, editor } = setup();
    editor.answers.push("s3cret");

    const answer = await call("vscode.input", {
      message: "Token",
      value: "draft",
      password: true,
      hint: "ghp_…",
    });

    expect(answer).toEqual({ answer: "s3cret" });
    expect(withoutWaiter(editor.shown[0])).toEqual({
      workspaceRef: FEAT,
      type: "input",
      message: "Token",
      value: "draft",
      password: true,
      hint: "ghp_…",
    });
  });
});

describe("vscode.pick-file", () => {
  it("opens a dialog with its options and answers the paths", async () => {
    const { call, editor } = setup();
    const start = new Path("/projects/app").toNative();
    editor.answers.push(["/projects/app/a.png"]);

    const answer = await call("vscode.pick-file", {
      message: "Image",
      many: true,
      filters: { Images: ["png"] },
      start,
    });

    expect(answer).toEqual({ answer: ["/projects/app/a.png"] });
    expect(withoutWaiter(editor.shown[0])).toEqual({
      workspaceRef: FEAT,
      type: "pick-file",
      message: "Image",
      many: true,
      filters: { Images: ["png"] },
      start,
    });
  });

  it("starts a relative start where the shell stands", async () => {
    const { call, editor } = setup();
    const cwd = new Path("/projects/app").toNative();
    editor.answers.push(null);

    await call("vscode.pick-file", { folders: true, start: "docs" }, { cwd });

    expect(editor.shown[0]).toMatchObject({
      folders: true,
      start: new Path("/projects/app/docs").toNative(),
    });
  });

  it("refuses a relative start from a caller standing nowhere", async () => {
    const { call } = setup();

    await expect(call("vscode.pick-file", { start: "docs" })).rejects.toMatchObject({
      category: "usage",
    });
  });

  it("refuses several paths or folders for a save dialog", async () => {
    const { call } = setup();

    await expect(call("vscode.pick-file", { save: true, many: true })).rejects.toMatchObject({
      category: "usage",
    });
    await expect(call("vscode.pick-file", { save: true, folders: true })).rejects.toMatchObject({
      category: "usage",
    });
  });
});
