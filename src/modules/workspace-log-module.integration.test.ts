// @vitest-environment node
/**
 * Integration tests for the workspace log: which lines reach a workspace's
 * "CodeHydra Log" channel, how they read, and what is held while its IDE is away.
 */

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import type { LogLine, LogScope } from "../boundaries/platform/logging-types";
import type { AppendOutputRequest } from "../shared/api-protocol";
import type { DomainEvent } from "../intents/lib/types";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { EVENT_WORKSPACE_CREATE_FAILED, EVENT_WORKSPACE_CREATED } from "../intents/open-workspace";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";
import type { WorkspaceRef } from "../intents/contract";
import { testPath } from "../shared/test-fixtures";
import {
  createWorkspaceLogModule,
  formatWorkspaceLogLine,
  WORKSPACE_LOG_CHANNEL,
} from "./workspace-log-module";

const PROJECT = projectRefFor(testPath("/repos/proj").toString());
const WS = makeWorkspaceRef(PROJECT, "feat");
const TARGET: LogScope = {
  project: "proj",
  ws: "feat",
  path: testPath("/workspaces/feat").toString(),
};

function setup() {
  const connected = new Set<WorkspaceRef>();
  const shown: Array<{ workspaceRef: WorkspaceRef; request: AppendOutputRequest }> = [];
  let onConnected: (workspaceRef: WorkspaceRef) => void = () => {};
  let emit: (line: LogLine) => void = () => {};
  const { module } = createWorkspaceLogModule({
    logging: {
      onLine: (listener) => {
        emit = listener;
        return () => {};
      },
    },
    transport: {
      appendOutput: (workspaceRef, request) => {
        if (!connected.has(workspaceRef)) return false;
        shown.push({ workspaceRef, request });
        return true;
      },
      onWorkspaceConnected: (listener) => {
        onConnected = listener;
        return () => {};
      },
    },
    logger: SILENT_LOGGER,
  });
  const log = (overrides: Partial<LogLine> & { scope: LogScope | undefined }): void =>
    emit({
      level: "info",
      logger: "git",
      message: "msg",
      context: undefined,
      error: undefined,
      ...overrides,
    });
  const texts = (): string[] => shown.flatMap((s) => s.request.lines.map((l) => l.text));
  /** Let the per-tick batch go out. */
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const fire = (event: DomainEvent): Promise<void> =>
    module.events![event.type]!.handler(event) as Promise<void>;
  return {
    log,
    shown,
    texts,
    tick,
    fire,
    /** The workspace finished opening: from here on its lines are routed to it. */
    open: (): Promise<void> =>
      fire({
        type: EVENT_WORKSPACE_CREATED,
        payload: { workspaceRef: WS, projectRef: PROJECT, workspaceName: "feat" },
      }),
    connect(ref = WS): void {
      connected.add(ref);
      onConnected(ref);
    },
  };
}

describe("workspace log", () => {
  it("sends a workspace's lines to its log channel, levelled, batched per tick", async () => {
    const t = setup();
    await t.open();
    t.connect();

    t.log({ scope: { trace: "7f3a01", ...TARGET }, message: "one" });
    t.log({ scope: TARGET, message: "two", level: "warn" });
    await t.tick();

    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]!.workspaceRef).toBe(WS);
    expect(t.shown[0]!.request).toEqual({
      channel: WORKSPACE_LOG_CHANNEL,
      log: true,
      lines: [
        { source: "git", level: "info", text: "(git) [7f3a01] one" },
        { source: "git", level: "warn", text: "(git) two" },
      ],
    });
  });

  it("sends nothing for lines about no workspace, and nothing at silly", async () => {
    const t = setup();
    await t.open();
    t.connect();

    t.log({ scope: undefined });
    t.log({ scope: { trace: "7f3a01", intent: "app:start" } });
    t.log({ scope: TARGET, level: "silly" });
    await t.tick();

    expect(t.shown).toEqual([]);
  });

  it("holds lines until the workspace's IDE connects", async () => {
    const t = setup();
    await t.open();

    t.log({ scope: TARGET, message: "early" });
    await t.tick();
    expect(t.shown).toEqual([]);

    t.connect();
    expect(t.texts()).toEqual(["(git) early"]);
  });

  it("holds an opening workspace's lines by name until it has opened", async () => {
    const t = setup();
    t.connect();

    t.log({ scope: { project: "proj", ws: "feat" }, message: "before the worktree" });
    t.log({ scope: TARGET, message: "path known, still opening" });
    await t.tick();
    expect(t.shown).toEqual([]);

    await t.open();
    t.log({ scope: { project: "proj", ws: "feat" }, message: "opened" });
    await t.tick();

    expect(t.texts()).toEqual([
      "(git) before the worktree",
      "(git) path known, still opening",
      "(git) opened",
    ]);
  });

  it("drops what it held for a deleted workspace, and holds nothing more", async () => {
    const t = setup();
    await t.open();
    t.log({ scope: TARGET, message: "held" });
    await t.tick();

    await t.fire({
      type: EVENT_WORKSPACE_DELETED,
      payload: { workspaceRef: WS, projectRef: PROJECT, workspaceName: "feat" },
    });
    t.log({ scope: TARGET, message: "straggler" });
    await t.tick();
    t.connect();

    expect(t.shown).toEqual([]);
  });

  it("holds again for a deleted workspace that is opened again", async () => {
    const t = setup();
    await t.open();
    await t.fire({
      type: EVENT_WORKSPACE_DELETED,
      payload: { workspaceRef: WS, projectRef: PROJECT, workspaceName: "feat" },
    });

    t.log({ scope: { ...TARGET, intent: "workspace:open" }, message: "reopened" });
    await t.open();
    await t.tick();
    t.connect();

    expect(t.texts()).toEqual(["(git) [workspace:open] reopened"]);
  });

  it("forgets a failed creation's held lines", async () => {
    const t = setup();
    t.connect();
    t.log({ scope: { project: "proj", ws: "feat" }, message: "doomed" });

    await t.fire({
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: { projectRef: PROJECT, workspaceName: "feat", error: "boom" },
    });
    t.log({ scope: TARGET, message: "a new workspace of that name" });
    await t.open();
    await t.tick();

    expect(t.texts()).toEqual(["(git) a new workspace of that name"]);
  });
});

describe("formatWorkspaceLogLine", () => {
  it("leaves the workspace out of the block and adds context and error", () => {
    expect(
      formatWorkspaceLogLine({
        level: "error",
        logger: "agent",
        scope: {
          trace: "7f3a01",
          intent: "workspace:open",
          module: "claude-agent",
          hook: "setup",
          origin: "ui",
          ...TARGET,
        },
        message: "Failed",
        context: { port: 1 },
        error: new Error("boom"),
      })
    ).toBe("(agent) [7f3a01 workspace:open@claude-agent/setup ui] Failed port=1 error=boom");
  });
});
