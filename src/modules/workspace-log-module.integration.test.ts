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
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import { testPath } from "../shared/test-fixtures";
import {
  createWorkspaceLogModule,
  formatWorkspaceLogLine,
  WORKSPACE_LOG_CHANNEL,
} from "./workspace-log-module";

const PROJECT = testPath("/repos/proj").toString();
const WS = testPath("/workspaces/feat").toString();
const TARGET: LogScope = { project: "proj", ws: "feat", path: WS };

function setup() {
  const connected = new Set<string>();
  const shown: Array<{ workspacePath: string; request: AppendOutputRequest }> = [];
  let onConnected: (workspacePath: string) => void = () => {};
  let emit: (line: LogLine) => void = () => {};
  const { module } = createWorkspaceLogModule({
    logging: {
      onLine: (listener) => {
        emit = listener;
        return () => {};
      },
    },
    transport: {
      appendOutput: (workspacePath, request) => {
        if (!connected.has(workspacePath)) return false;
        shown.push({ workspacePath, request });
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
    connect(path = WS): void {
      connected.add(path);
      onConnected(path);
    },
  };
}

describe("workspace log", () => {
  it("sends a workspace's lines to its log channel, levelled, batched per tick", async () => {
    const t = setup();
    t.connect();

    t.log({ scope: { trace: "7f3a01", ...TARGET }, message: "one" });
    t.log({ scope: TARGET, message: "two", level: "warn" });
    await t.tick();

    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]!.workspacePath).toBe(WS);
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
    t.connect();

    t.log({ scope: undefined });
    t.log({ scope: { trace: "7f3a01", intent: "app:start" } });
    t.log({ scope: TARGET, level: "silly" });
    await t.tick();

    expect(t.shown).toEqual([]);
  });

  it("holds lines until the workspace's IDE connects", async () => {
    const t = setup();

    t.log({ scope: TARGET, message: "early" });
    await t.tick();
    expect(t.shown).toEqual([]);

    t.connect();
    expect(t.texts()).toEqual(["(git) early"]);
  });

  it("holds a creation's lines by name until a line brings the path", async () => {
    const t = setup();
    t.connect();

    t.log({ scope: { project: "proj", ws: "feat" }, message: "before the worktree" });
    await t.tick();
    expect(t.shown).toEqual([]);

    t.log({ scope: TARGET, message: "after" });
    t.log({ scope: { project: "proj", ws: "feat" }, message: "later, path now known" });
    await t.tick();

    expect(t.texts()).toEqual([
      "(git) before the worktree",
      "(git) after",
      "(git) later, path now known",
    ]);
  });

  it("drops what it held for a deleted workspace, and holds nothing more", async () => {
    const t = setup();
    t.log({ scope: TARGET, message: "held" });
    await t.tick();

    await t.fire({
      type: EVENT_WORKSPACE_DELETED,
      payload: { workspacePath: WS, projectPath: PROJECT, workspaceName: "feat" },
    });
    t.log({ scope: TARGET, message: "straggler" });
    await t.tick();
    t.connect();

    expect(t.shown).toEqual([]);
  });

  it("holds again for a deleted path that is opened again", async () => {
    const t = setup();
    await t.fire({
      type: EVENT_WORKSPACE_DELETED,
      payload: { workspacePath: WS, projectPath: PROJECT, workspaceName: "feat" },
    });

    t.log({ scope: { ...TARGET, intent: "workspace:open" }, message: "reopened" });
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
      payload: { projectPath: PROJECT, workspaceName: "feat", error: "boom" },
    });
    t.log({ scope: TARGET, message: "a new workspace of that name" });
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
