/**
 * Agent registry entries.
 *
 * Note the pairing that used to be conflated: `agent.open` / `agent.close` are
 * COMMANDS that actually open and close the terminal tab (via the sidekick's
 * `codehydra.openAgent` / `codehydra.closeAgent`), while `agent.lifecycle` is
 * the EVENT reporting that it happened. Only the sidekick can send the event
 * truthfully, so it is the one entry restricted to a single adapter.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps } from "./deps";
import { workspacePathSchema, type WorkspacePath } from "../../intents/contract";

import { INTENT_GET_AGENT_SESSION } from "../../intents/get-agent-session";
import type { GetAgentSessionIntent } from "../../intents/get-agent-session";
import { INTENT_RESTART_AGENT } from "../../intents/restart-agent";
import type { RestartAgentIntent } from "../../intents/restart-agent";
import { INTENT_UPDATE_AGENT_STATUS } from "../../intents/update-agent-status";
import type { UpdateAgentStatusIntent } from "../../intents/update-agent-status";
import { INTENT_AGENT_LIFECYCLE } from "../../intents/agent-lifecycle";
import type { AgentLifecycleIntent } from "../../intents/agent-lifecycle";
import { INTENT_VSCODE_COMMAND } from "../../intents/vscode-command";
import type { VscodeCommandIntent } from "../../intents/vscode-command";
import { INTENT_SEND_AGENT_MESSAGE } from "../../intents/send-agent-message";
import type { SendAgentMessageIntent } from "../../intents/send-agent-message";
import { Path } from "../../utils/path/path";

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

/**
 * Who a message is from, as the receiving agent sees it: the calling
 * workspace when there is one, otherwise the CLI outside any workspace. Taken
 * from the connection, never from the input, so a caller cannot sign as
 * someone else.
 */
export function messageSender(ctx: OperationContext): string {
  return ctx.workspacePath === null
    ? "CodeHydra · ch"
    : `CodeHydra · workspace ${new Path(ctx.workspacePath).basename}`;
}

export function agentEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;

  const runVscodeCommand = (workspacePath: WorkspacePath, command: string) =>
    dispatcher.dispatch<VscodeCommandIntent>({
      type: INTENT_VSCODE_COMMAND,
      payload: { workspacePath, command, args: undefined },
    });

  const session = defineEntry({
    name: "agent.session",
    kind: "command",
    description: "Get the agent server's port and session id for a workspace.",
    instructions:
      "Returns the address of the agent's OWN http server, so a caller can talk to the agent " +
      "directly rather than through CodeHydra. Null when the server is not running — the " +
      "workspace is hibernated, or the agent has not started yet.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      dispatcher.dispatch<GetAgentSessionIntent>({
        type: INTENT_GET_AGENT_SESSION,
        payload: { workspacePath: targetOf(ctx, input.workspacePath) },
      }),
  });

  const restart = defineEntry({
    name: "agent.restart",
    kind: "command",
    description: "Restart a workspace's agent server, preserving its port.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await dispatcher.dispatch<RestartAgentIntent>({
        type: INTENT_RESTART_AGENT,
        payload: { workspacePath: targetOf(ctx, input.workspacePath) },
      });
      if (result === undefined) throw new Error("Restart agent returned no result");
      return result;
    },
  });

  const open = defineEntry({
    name: "agent.open",
    kind: "command",
    description: "Open the agent terminal tab in the workspace's editor.",
    instructions: "Focuses the existing terminal when one is already open.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      runVscodeCommand(targetOf(ctx, input.workspacePath), "codehydra.openAgent"),
  });

  const close = defineEntry({
    name: "agent.close",
    kind: "command",
    description: "Close the agent terminal tab in the workspace's editor.",
    instructions:
      "Returns { closed } reporting whether a terminal existed at all, NOT whether it has " +
      "finished closing — closing is asynchronous and completes afterwards.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      runVscodeCommand(targetOf(ctx, input.workspacePath), "codehydra.closeAgent"),
  });

  const message = defineEntry({
    name: "agent.message",
    kind: "command",
    description: "Send a message to a workspace's running agent.",
    instructions:
      "For the AGENT, not the user: the text lands in the agent's conversation, the way one " +
      "agent session messages another, and the agent reads it at its next opportunity (a busy " +
      "agent between steps, an idle one starts a turn on it). To reach the user instead, use a " +
      "notification or the status bar. The sender is named from where the call comes from " +
      "(the calling workspace, else the CLI). Returns once the agent has taken the message — " +
      "sent, not read. Fails as not found when the workspace has no running agent (hibernated, " +
      "or its agent terminal closed) unless wake is set, which wakes it or reopens the agent " +
      "terminal and waits for the agent to start. A Claude Code session that bypasses permission prompts " +
      "holds the message until its user approves it.",
    input: z.object({
      workspacePath: targetWorkspace,
      text: z.string().min(1).describe("The message; `-` on the command line reads standard input"),
      wake: z
        .boolean()
        .optional()
        .default(false)
        .describe("Wake a hibernated workspace, or reopen a closed agent terminal, first"),
    }),
    // Reachable from outside any workspace with an explicit target: the
    // handler resolves the target itself, and signs such a call as the CLI.
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const result = await dispatcher.dispatch<SendAgentMessageIntent>({
        type: INTENT_SEND_AGENT_MESSAGE,
        payload: {
          workspacePath: targetOf(ctx, input.workspacePath),
          text: input.text,
          from: messageSender(ctx),
          wake: input.wake,
        },
      });
      // No agent to take it: the caller named something that is not there.
      if (!result.sent) {
        throw new ApiError("not-found", result.reason ?? "The workspace has no running agent.");
      }
      return null;
    },
  });

  const statusSet = defineEntry({
    name: "agent.status.set",
    kind: "command",
    description: "Report this workspace's agent status as idle or busy.",
    instructions:
      "A one-shot report, not a pinned override: the value stands until the agent provider " +
      "next pushes a status change of its own. Because the provider only pushes on change, a " +
      "nudge sent while the agent is idle sticks until the agent next does something; one sent " +
      "mid-turn is replaced by the next hook event.",
    input: z.object({
      workspacePath: targetWorkspace,
      status: z.enum(["idle", "busy"]).describe("Status to report"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const busy = input.status === "busy";
      await dispatcher.dispatch<UpdateAgentStatusIntent>({
        type: INTENT_UPDATE_AGENT_STATUS,
        payload: {
          workspacePath: targetOf(ctx, input.workspacePath),
          status: {
            status: input.status,
            counts: { idle: busy ? 0 : 1, busy: busy ? 1 : 0 },
          },
        },
      });
      return null;
    },
  });

  const lifecycle = defineEntry({
    name: "agent.lifecycle",
    kind: "event",
    description: "Report that the agent terminal opened or closed.",
    instructions:
      "Sent by the sidekick when it observes the terminal event. It brackets the agent status " +
      "stream and is the completion signal teardown waits on before removing a worktree, so " +
      "only an observer that actually witnessed the terminal event may send it.",
    input: z.object({ event: z.enum(["open", "close"]) }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const intent: AgentLifecycleIntent = {
        type: INTENT_AGENT_LIFECYCLE,
        payload: { workspacePath: targetOf(ctx, undefined), event: input.event },
      };
      void dispatcher.dispatch(intent);
      return null;
    },
    // Event: restricted to the observer that can witness it.
  });

  return [session, restart, open, close, message, statusSet, lifecycle];
}
