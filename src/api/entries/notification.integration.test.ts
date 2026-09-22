// @vitest-environment node
/**
 * The `notification.*` registry entries, run through the real registry, the
 * real notification operations and the presenter's own hook handlers over a
 * real NotificationManager — so the flat CLI/MCP input, attachment, waiting and
 * disconnect are asserted as a caller sees them.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import { createMockNotificationManager } from "../../modules/presentation/notification-manager.state-mock";
import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const PROJECT = projPath("/projects/app");
const FEAT = wsPath("/projects/app/workspaces/feat");

function setup() {
  const dispatcher = createMockDispatcher();
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: PROJECT,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
    }),
    projects: { [PROJECT]: { projectId: "app-1" as ProjectId } },
  });
  const cards = createMockNotificationManager();
  cards.register(dispatcher);
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
    },
    SILENT_LOGGER
  );

  const call = (
    name: OperationName,
    workspace: WorkspacePath | null,
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<unknown> => {
    const ctx: OperationContext = { workspacePath: workspace, cwd: null, signal };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, cards };
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
    expect(cards.lastNotification!.workspacePath).toBeUndefined();
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

    expect(cards.lastNotification!.workspacePath).toBe(FEAT);
  });

  it("attaches to an explicit workspace from anywhere", async () => {
    const { call, cards } = setup();

    await call("notification.show", null, { title: "Tests green", workspacePath: FEAT });

    expect(cards.lastNotification!.workspacePath).toBe(FEAT);
  });

  it("needs a workspace to attach to", async () => {
    const { call } = setup();

    await expect(
      call("notification.show", null, { title: "Tests green", attach: true })
    ).rejects.toMatchObject({ category: "no-workspace" });
  });

  it("returns the clicked action when waiting, and the card is gone", async () => {
    const { call, cards } = setup();

    const answer = call("notification.show", null, {
      title: "Deploy?",
      actions: ["Deploy", "Skip"],
      wait: true,
    });
    await cards.settle();
    expect(cards.lastNotification!.opened.actions).toEqual([
      { id: "Deploy", label: "Deploy" },
      { id: "Skip", label: "Skip" },
    ]);
    cards.emitEvent(0, { actionId: "Skip" });

    await expect(answer).resolves.toEqual({ choice: "Skip" });
    expect(cards.lastNotification!.closed).toBe(true);
  });

  it("releases a wait when its caller disconnects", async () => {
    const { call, cards } = setup();
    const connection = new AbortController();

    const answer = call(
      "notification.show",
      null,
      { title: "Deploy?", actions: ["Deploy"], wait: true },
      connection.signal
    );
    await cards.settle();
    connection.abort();

    await expect(answer).resolves.toEqual({ choice: null });
    expect(cards.lastNotification!.closed).toBe(true);
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
