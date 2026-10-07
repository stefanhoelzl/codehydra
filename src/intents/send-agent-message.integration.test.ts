// @vitest-environment node
/**
 * Integration tests for the send-agent-message operation through the Dispatcher.
 *
 * The agent module is a behavioral stand-in for the "send" hook; wake is
 * recorded (and cancelled) by an interceptor, and the status and vscode-command
 * operations run for real over test hook modules.
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import type { Dispatcher } from "./lib/dispatcher";
import {
  AGENT_READY_TIMEOUT_MS,
  INTENT_SEND_AGENT_MESSAGE,
  SEND_AGENT_MESSAGE_OPERATION_ID,
  SendAgentMessageOperation,
  type SendAgentMessageIntent,
  type SendHookInput,
  type SendHookResult,
} from "./send-agent-message";
import { INTENT_WAKE_WORKSPACE } from "./wake-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  GetWorkspaceStatusOperation,
  type GetStatusHookResult,
} from "./get-workspace-status";
import {
  VSCODE_COMMAND_OPERATION_ID,
  VscodeCommandOperation,
  type VscodeCommandIntent,
} from "./vscode-command";
import { registerTestInfrastructure } from "./operations.test-utils";
import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { Intent } from "./lib/types";
import type { WorkspaceName } from "../shared/api/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import { projPath, wsPath, workspaceRefIn } from "../shared/test-fixtures";
import type { WorkspacePath } from "./contract";
import type { WorkspaceRef } from "./contract";

const PROJECT_ROOT = projPath("/project");
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_REF = workspaceRefIn(PROJECT_ROOT, "feature-x");

interface Delivery {
  readonly workspacePath: WorkspacePath;
  readonly text: string;
  readonly from: string;
  readonly waitMs: number;
}

interface Setup {
  readonly dispatcher: Dispatcher;
  readonly delivered: Delivery[];
  readonly woken: WorkspaceRef[];
  readonly commands: string[];
}

function createSetup(opts: {
  hibernated?: boolean;
  agentStatus?: AggregatedAgentStatus["status"];
  /** No agent module answers the send hook (no agent resolved for the workspace). */
  noAgent?: boolean;
  sendError?: Error;
  /** The agent is unreachable: the hook answers "not sent" with this reason. */
  notSent?: string;
  /** The workspace's editor is not connected (yet). Default: connected. */
  editorDisconnected?: boolean;
  /** Running a command in the editor fails. */
  commandError?: Error;
}): Setup {
  const delivered: Delivery[] = [];
  const woken: WorkspaceRef[] = [];
  const commands: string[] = [];
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new SendAgentMessageOperation());
  dispatcher.registerOperation(new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(new VscodeCommandOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [WORKSPACE_PATH]: {
        projectPath: PROJECT_ROOT,
        workspaceName: "feature-x" as WorkspaceName,
        ...(opts.hibernated === true && { metadata: { [HIBERNATED_METADATA_KEY]: "true" } }),
      },
    },
  });

  // Waking is its own pipeline; here it only has to be asked for.
  dispatcher.addInterceptor({
    id: "record-wake",
    async before(intent: Intent): Promise<Intent | null> {
      if (intent.type !== INTENT_WAKE_WORKSPACE) return intent;
      woken.push((intent.payload as { workspaceRef: WorkspaceRef }).workspaceRef);
      return null;
    },
  });

  const status = opts.agentStatus ?? "idle";
  const agentModule: IntentModule = {
    name: "test-agent",
    hooks: {
      [SEND_AGENT_MESSAGE_OPERATION_ID]: opts.noAgent
        ? {}
        : {
            send: {
              handler: async (ctx: HookContext): Promise<HookOutput<SendHookResult>> => {
                const { workspacePath, waitMs } = ctx as SendHookInput;
                if (opts.sendError) throw opts.sendError;
                if (opts.notSent !== undefined) {
                  return { result: { sent: false, reason: opts.notSent } };
                }
                const { text, from } = (ctx.intent as SendAgentMessageIntent).payload;
                delivered.push({ workspacePath, text, from, waitMs });
                return { result: { sent: true } };
              },
            },
          },
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (): Promise<HookOutput<GetStatusHookResult>> => ({
            result: {
              agentStatus: {
                status,
                counts: { idle: status === "idle" ? 1 : 0, busy: status === "busy" ? 1 : 0 },
              } as AggregatedAgentStatus,
            },
          }),
        },
      },
      [VSCODE_COMMAND_OPERATION_ID]: {
        execute: {
          handler: async (ctx: HookContext) => {
            commands.push((ctx.intent as VscodeCommandIntent).payload.command);
            if (opts.commandError) throw opts.commandError;
            return { result: {} };
          },
        },
      },
    },
  };
  dispatcher.registerModule(agentModule);

  // The API server's answer: whether the workspace's editor is connected.
  const editorModule: IntentModule = {
    name: "test-editor",
    hooks: {
      [SEND_AGENT_MESSAGE_OPERATION_ID]: {
        editor: {
          handler: async () => ({ result: { connected: opts.editorDisconnected !== true } }),
        },
      },
    },
  };
  dispatcher.registerModule(editorModule);

  return { dispatcher, delivered, woken, commands };
}

function sendIntent(wake: boolean): SendAgentMessageIntent {
  return {
    type: INTENT_SEND_AGENT_MESSAGE,
    payload: {
      workspaceRef: WORKSPACE_REF,
      text: "the build is green",
      from: "CodeHydra · workspace other",
      wake,
    },
  };
}

describe("SendAgentMessage Operation", () => {
  it("hands the message to the agent without waiting", async () => {
    const setup = createSetup({});

    const result = await setup.dispatcher.dispatch(sendIntent(false));

    expect(result).toEqual({ sent: true });
    expect(setup.delivered).toEqual([
      {
        workspacePath: WORKSPACE_PATH,
        text: "the build is green",
        from: "CodeHydra · workspace other",
        waitMs: 0,
      },
    ]);
    expect(setup.woken).toEqual([]);
    expect(setup.commands).toEqual([]);
  });

  it("does not touch a running agent even with wake", async () => {
    const setup = createSetup({ agentStatus: "busy" });

    await setup.dispatcher.dispatch(sendIntent(true));

    expect(setup.woken).toEqual([]);
    expect(setup.commands).toEqual([]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([0]);
  });

  it("reports a hibernated workspace as not sent without wake", async () => {
    const setup = createSetup({ hibernated: true });

    const result = await setup.dispatcher.dispatch(sendIntent(false));

    expect(result).toEqual({ sent: false, reason: expect.stringMatching(/hibernated/) });
    expect(setup.woken).toEqual([]);
    expect(setup.delivered).toEqual([]);
  });

  it("wakes a hibernated workspace and waits for its agent", async () => {
    const setup = createSetup({ hibernated: true });

    await setup.dispatcher.dispatch(sendIntent(true));

    expect(setup.woken).toEqual([WORKSPACE_REF]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([AGENT_READY_TIMEOUT_MS]);
  });

  it("reopens a closed agent terminal and waits for the agent", async () => {
    const setup = createSetup({ agentStatus: "none" });

    await setup.dispatcher.dispatch(sendIntent(true));

    expect(setup.commands).toEqual(["codehydra.openAgent"]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([AGENT_READY_TIMEOUT_MS]);
  });

  it("waits for the agent of an editor still connecting, without running a command", async () => {
    // Just woken: the agent reports "none" and the editor is not connected yet.
    const setup = createSetup({ agentStatus: "none", editorDisconnected: true });

    const result = await setup.dispatcher.dispatch(sendIntent(true));

    expect(result).toEqual({ sent: true });
    expect(setup.commands).toEqual([]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([AGENT_READY_TIMEOUT_MS]);
  });

  it("still waits for the agent when reopening its terminal fails", async () => {
    const setup = createSetup({ agentStatus: "none", commandError: new Error("gone") });

    const result = await setup.dispatcher.dispatch(sendIntent(true));

    expect(result).toEqual({ sent: true });
    expect(setup.commands).toEqual(["codehydra.openAgent"]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([AGENT_READY_TIMEOUT_MS]);
  });

  it("leaves a closed agent terminal alone without wake", async () => {
    const setup = createSetup({ agentStatus: "none" });

    await setup.dispatcher.dispatch(sendIntent(false));

    expect(setup.commands).toEqual([]);
    expect(setup.delivered.map((d) => d.waitMs)).toEqual([0]);
  });

  it("propagates a failed hand-over", async () => {
    const setup = createSetup({ sendError: new Error("connect ECONNREFUSED") });

    await expect(setup.dispatcher.dispatch(sendIntent(false))).rejects.toThrow("ECONNREFUSED");
  });

  it("passes on the agent's reason for not taking it", async () => {
    const setup = createSetup({ notSent: "No Claude session is running" });

    const result = await setup.dispatcher.dispatch(sendIntent(false));

    expect(result).toEqual({ sent: false, reason: "No Claude session is running" });
  });

  it("reports not sent when no agent answers at all", async () => {
    const setup = createSetup({ noAgent: true });

    const result = await setup.dispatcher.dispatch(sendIntent(false));

    expect(result).toEqual({
      sent: false,
      reason: expect.stringMatching(/no agent to take the message/),
    });
  });

  it("fails for an unknown workspace", async () => {
    const setup = createSetup({});

    await expect(
      setup.dispatcher.dispatch({
        ...sendIntent(false),
        payload: {
          ...sendIntent(false).payload,
          workspaceRef: workspaceRefIn(PROJECT_ROOT, "nonexistent"),
        },
      })
    ).rejects.toThrow(/Workspace not found/);
  });
});
