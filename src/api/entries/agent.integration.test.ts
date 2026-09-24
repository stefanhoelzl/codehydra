// @vitest-environment node
/**
 * The `agent.message` registry entry, run through the real registry and the
 * real send-agent-message operation, with a test module standing in for the
 * agent's "send" hook — so targeting, the sender name and input validation are
 * asserted as a caller sees them.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  GetWorkspaceStatusOperation,
  type GetStatusHookResult,
} from "../../intents/get-workspace-status";
import {
  SEND_AGENT_MESSAGE_OPERATION_ID,
  SendAgentMessageOperation,
  type SendAgentMessageIntent,
  type SendHookResult,
} from "../../intents/send-agent-message";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const PROJECT = projPath("/projects/app");
const FEAT = wsPath("/projects/app/workspaces/feat");
const OTHER = wsPath("/projects/app/workspaces/other");

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new SendAgentMessageOperation());
  dispatcher.registerOperation(new GetWorkspaceStatusOperation());
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: PROJECT,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
    }),
    projects: { [PROJECT]: { projectId: "app-1" as ProjectId } },
  });

  const sent: SendAgentMessageIntent["payload"][] = [];
  let unreachable: string | null = null;
  dispatcher.registerModule({
    name: "test-agent",
    hooks: {
      [SEND_AGENT_MESSAGE_OPERATION_ID]: {
        send: {
          handler: async (ctx: HookContext): Promise<HookOutput<SendHookResult>> => {
            if (unreachable !== null) return { result: { sent: false, reason: unreachable } };
            sent.push((ctx.intent as SendAgentMessageIntent).payload);
            return { result: { sent: true } };
          },
        },
      },
      // A running agent: `wake` finds nothing to do.
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (): Promise<HookOutput<GetStatusHookResult>> => ({
            result: { agentStatus: { status: "idle", counts: { idle: 1, busy: 0 } } },
          }),
        },
      },
    },
  });

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

  const call = (workspace: WorkspacePath | null, input: Record<string, unknown>) => {
    const ctx: OperationContext = {
      workspacePath: workspace,
      cwd: null,
      signal: new AbortController().signal,
    };
    return registry.invoke(registry.get("agent.message"), ctx, input);
  };

  return {
    call,
    sent,
    setUnreachable: (reason: string) => {
      unreachable = reason;
    },
  };
}

describe("agent.message entry", () => {
  it("sends to the caller's own workspace, signed with its name", async () => {
    const { call, sent } = setup();

    const result = await call(FEAT, { text: "hello" });

    expect(result).toBeNull();
    expect(sent).toEqual([
      { workspacePath: FEAT, text: "hello", from: "CodeHydra · workspace feat", wake: false },
    ]);
  });

  it("signs a message to another workspace with the caller's name", async () => {
    const { call, sent } = setup();

    await call(FEAT, { workspacePath: OTHER, text: "hello", wake: true });

    expect(sent).toEqual([
      { workspacePath: OTHER, text: "hello", from: "CodeHydra · workspace feat", wake: true },
    ]);
  });

  it("signs as the CLI when the caller is in no workspace", async () => {
    const { call, sent } = setup();

    await call(null, { workspacePath: OTHER, text: "hello" });

    expect(sent[0]!.from).toBe("CodeHydra · ch");
  });

  it("refuses without a workspace to send to", async () => {
    const { call } = setup();

    await expect(call(null, { text: "hello" })).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.category === "no-workspace"
    );
  });

  it("refuses an empty message as a usage error", async () => {
    const { call, sent } = setup();

    await expect(call(FEAT, { text: "" })).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.category === "usage"
    );
    expect(sent).toEqual([]);
  });

  it("reports a workspace with no agent to take it as not found", async () => {
    const { call, setUnreachable } = setup();
    setUnreachable("No Claude session is running");

    await expect(call(FEAT, { text: "hello" })).rejects.toSatisfy(
      (error) =>
        error instanceof ApiError &&
        error.category === "not-found" &&
        error.message === "No Claude session is running"
    );
  });

  it("does not let the caller choose the sender", async () => {
    const { call, sent } = setup();

    await call(FEAT, { text: "hello", from: "someone else" });

    expect(sent[0]!.from).toBe("CodeHydra · workspace feat");
  });
});
