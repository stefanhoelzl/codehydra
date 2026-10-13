// @vitest-environment node
/**
 * The `notification.*` registry entries — and `vscode.ask` with `sidebar`, which
 * puts its question on the same cards — run through the real registry, the real
 * notification operations and the presenter's own hook handlers over a real
 * NotificationManager, so the flat CLI/MCP input, attachment, waiting and
 * disconnect are asserted as a caller sees them.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspaceRef } from "../../intents/contract";
import { projPath, wsPath, workspaceRefIn } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import { createMockNotificationManager } from "../../modules/presentation/notification-manager.state-mock";
import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";
import { z } from "zod/v4";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { Operation, OperationSchemas } from "../../intents/lib/operation";

const listProjectsSchemas = {
  type: INTENT_LIST_PROJECTS,
  payload: z.unknown(),
  result: z.unknown(),
} satisfies OperationSchemas;

/** Nothing is listed: a workspace named by its full ref is taken at its word. */
class ListNoProjectsOp implements Operation<typeof listProjectsSchemas> {
  readonly id = "list-projects";
  readonly schemas = listProjectsSchemas;
  async execute(): Promise<unknown[]> {
    return [];
  }
}

const PROJECT = projPath("/projects/app");
const FEAT_PATH = wsPath("/projects/app/workspaces/feat");
const FEAT = workspaceRefIn(PROJECT, "feat");

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new ListNoProjectsOp());
  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [FEAT_PATH]: { projectPath: PROJECT, workspaceName: "feat" as WorkspaceName },
    },
    projects: { [PROJECT]: { projectId: "app-1" as ProjectId } },
  });
  const cards = createMockNotificationManager();
  /** The waiting edges a card attached to a workspace reports. */
  const waits: string[] = [];
  cards.register(dispatcher, {
    opened: (ref) => waits.push(`open ${ref}`),
    closed: (ref) => waits.push(`closed ${ref}`),
  });
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
    workspace: WorkspaceRef | null,
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<unknown> => {
    const ctx: OperationContext = {
      workspaceRef: workspace,
      cwd: null,
      signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, cards, waits };
}

describe("notification entries", () => {
  it("opens a dismissible info card from a bare title and returns its id", async () => {
    const { call, cards } = setup();

    const result = await call("notification.show", null, { title: "Build done" });

    expect(result).toEqual({ id: cards.lastNotification!.id });
    expect(cards.lastNotification!.opened).toEqual({
      title: "Build done",
      type: "info",
      dismissible: true,
    });
    expect(cards.lastNotification!.workspaceRef).toBeUndefined();
  });

  it("updates the card named by id", async () => {
    const { call, cards } = setup();
    const { id } = (await call("notification.show", null, {
      title: "Building",
      type: "spinner",
      percent: 10,
    })) as { id: string };

    await call("notification.show", null, {
      id,
      title: "Building",
      type: "spinner",
      percent: 60,
    });

    expect(cards.notifications).toHaveLength(1);
    expect(cards.lastNotification!.latestConfig.progress).toBe(0.6);
  });

  it("fails not-found when updating a card the user dismissed", async () => {
    const { call, cards } = setup();
    const { id } = (await call("notification.show", null, { title: "Heads up" })) as {
      id: string;
    };
    cards.emitEvent(id, { actionId: "dismiss" });

    const failure = call("notification.show", null, { id, title: "Still there?" });

    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ category: "not-found" });
  });

  it("attaches to the calling workspace", async () => {
    const { call, cards } = setup();

    await call("notification.show", FEAT, { title: "Tests green", attach: true });

    expect(cards.lastNotification!.workspaceRef).toBe(FEAT);
  });

  it("attaches to an explicit workspace from anywhere", async () => {
    const { call, cards } = setup();

    await call("notification.show", null, { title: "Tests green", workspace: FEAT });

    expect(cards.lastNotification!.workspaceRef).toBe(FEAT);
  });

  it("needs a workspace to attach to", async () => {
    const { call } = setup();

    await expect(
      call("notification.show", null, { title: "Tests green", attach: true })
    ).rejects.toMatchObject({ category: "no-workspace" });
  });

  it("has no buttons and never waits: a question is vscode.ask", async () => {
    const { call, cards } = setup();

    const result = await call("notification.show", null, {
      title: "Deploy?",
      actions: ["Deploy"],
      wait: true,
    });

    expect(result).toEqual({ id: cards.lastNotification!.id });
    expect(cards.lastNotification!.opened.actions).toBeUndefined();
  });

  it("closes a card by id, and ignores one that is gone", async () => {
    const { call, cards } = setup();
    const { id } = (await call("notification.show", null, { title: "Heads up" })) as {
      id: string;
    };

    await expect(call("notification.close", null, { id })).resolves.toEqual({ closed: true });
    expect(cards.lastNotification!.closed).toBe(true);
    await expect(call("notification.close", null, { id })).resolves.toEqual({ closed: true });
  });
});

describe("vscode.ask with sidebar", () => {
  const DEPLOY = { message: "Deploy?", options: ["Deploy", "Skip"], sidebar: true };

  it("puts the question on a card attached to the asking workspace, and answers the click", async () => {
    const { call, cards } = setup();

    const answer = call("vscode.ask", FEAT, { ...DEPLOY, detail: "to staging", level: "warning" });
    await cards.settle();
    expect(cards.lastNotification!.opened).toEqual({
      title: "Deploy?",
      message: "to staging",
      type: "warning",
      dismissible: true,
      actions: [
        { id: "Deploy", label: "Deploy" },
        { id: "Skip", label: "Skip" },
      ],
    });
    expect(cards.lastNotification!.workspaceRef).toBe(FEAT);
    cards.emitEvent(0, { actionId: "Skip" });

    await expect(answer).resolves.toEqual({ answer: "Skip" });
    expect(cards.lastNotification!.closed).toBe(true);
  });

  it("answers null when the card is dismissed: its X is the Cancel", async () => {
    const { call, cards } = setup();

    const answer = call("vscode.ask", FEAT, DEPLOY);
    await cards.settle();
    cards.emitEvent(0, { actionId: "dismiss" });

    await expect(answer).resolves.toEqual({ answer: null });
  });

  it("parks the workspace on the user while it waits", async () => {
    const { call, cards, waits } = setup();

    const answer = call("vscode.ask", FEAT, DEPLOY);
    await cards.settle();
    expect(waits).toEqual([`open ${FEAT}`]);
    cards.emitEvent(0, { actionId: "Deploy" });
    await answer;

    expect(waits).toEqual([`open ${FEAT}`, `closed ${FEAT}`]);
  });

  it("answers null and closes the card when its caller disconnects", async () => {
    const { call, cards, waits } = setup();
    const connection = new AbortController();

    const answer = call("vscode.ask", FEAT, DEPLOY, connection.signal);
    await cards.settle();
    connection.abort();

    await expect(answer).resolves.toEqual({ answer: null });
    expect(cards.lastNotification!.closed).toBe(true);
    expect(waits).toEqual([`open ${FEAT}`, `closed ${FEAT}`]);
  });

  it("refuses more than five buttons, and labels a button cannot hold", async () => {
    const { call } = setup();
    const six = ["a", "b", "c", "d", "e", "f"];

    await expect(
      call("vscode.ask", FEAT, { message: "Which?", options: six, sidebar: true })
    ).rejects.toMatchObject({ category: "usage" });
    await expect(
      call("vscode.ask", FEAT, { message: "Which?", options: ["x".repeat(51)] })
    ).rejects.toMatchObject({ category: "usage" });
  });
});
