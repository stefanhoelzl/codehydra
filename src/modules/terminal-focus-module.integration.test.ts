// @vitest-environment node
/**
 * Integration tests for TerminalFocusModule through the Dispatcher.
 *
 * Status updates run the real UpdateAgentStatusOperation and modal edges the
 * real VscodeModalChangedOperation. A fake agent module stands in for the
 * provider: on a modal edge it re-reports the workspace's status without
 * awaiting it — "idle" while a modal is open, the agent's own status after —
 * the way the real provider does. The sidekick command is a fake tryCommand
 * whose answer each test controls; a vscode:command operation is registered
 * only to show the module never dispatches one.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Operation, OperationSchemas, HookContext } from "../intents/lib/operation";
import { ANY_VALUE } from "../intents/lib/operation";
import type { IntentModule } from "../intents/lib/module";
import { createDeleteEventOperation } from "../intents/lib/operation.test-utils";
import { createTestMockModule, updateStatusIntent } from "../intents/operations.test-utils";
import { ResolveWorkspaceOperation } from "../intents/resolve-workspace";
import { ResolveProjectOperation } from "../intents/resolve-project";
import { UpdateAgentStatusOperation } from "../intents/update-agent-status";
import {
  VscodeModalChangedOperation,
  VSCODE_MODAL_CHANGED_OPERATION_ID,
  INTENT_VSCODE_MODAL_CHANGED,
  type ModalHookInput,
  type ModalSource,
  type VscodeModalChangedIntent,
} from "../intents/vscode-modal-changed";
import { INTENT_VSCODE_COMMAND } from "../intents/vscode-command";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "../intents/delete-workspace";
import type { Intent } from "../intents/lib/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { projPath, wsPath } from "../shared/test-fixtures";
import { createTerminalFocusModule } from "./terminal-focus-module";
import { makeWorkspaceRef, workspaceNameOf } from "../utils/ref";
import { gitProjectRef } from "./git/ref";
import type { WorkspaceRef } from "../intents/contract";

const PROJECT = gitProjectRef(projPath("/projects/test"));
const WS = makeWorkspaceRef(PROJECT, "alpha");
const OTHER = makeWorkspaceRef(PROJECT, "beta");

const idle: AggregatedAgentStatus = { status: "idle", counts: { idle: 1, busy: 0 } };
const busy: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 1 } };
const none: AggregatedAgentStatus = { status: "none", counts: { idle: 0, busy: 0 } };

// =============================================================================
// Minimal operations
// =============================================================================

const permissive = (type: string) =>
  ({ type, payload: z.unknown(), result: z.unknown() }) satisfies OperationSchemas;
type Permissive = ReturnType<typeof permissive>;

interface CommandCall {
  readonly workspaceRef: string;
  readonly command: string;
  settle(delivered: boolean): void;
}

/** vscode:command that only counts: the module must send past the intent pipeline. */
function createCommandOperation(intents: { count: number }): Operation<Permissive> {
  return {
    id: "vscode-command",
    schemas: permissive(INTENT_VSCODE_COMMAND),
    async execute(): Promise<unknown> {
      intents.count++;
      return undefined;
    },
  };
}

/** workspace:get-status answering with the agent's current status. */
function createStatusOperation(agentType: () => string): Operation<Permissive> {
  return {
    id: "get-workspace-status",
    schemas: permissive(INTENT_GET_WORKSPACE_STATUS),
    async execute(): Promise<unknown> {
      return { isDirty: false, unmergedCommits: 0, agent: { type: agentType() } };
    },
  };
}

const INTENT_TEST_SWITCH = "workspace:switch" as const;

/** workspace:switch that only emits workspace:switched for the given path. */
const switchOperation: Operation<Permissive> = {
  id: "switch-workspace",
  schemas: permissive(INTENT_TEST_SWITCH),
  async execute(ctx): Promise<void> {
    const ref = ctx.intent.payload as WorkspaceRef;
    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: {
        projectId: "test-project" as ProjectId,
        projectName: "test",
        projectRef: PROJECT,
        workspaceName: workspaceNameOf(ref) as WorkspaceName,
        workspaceRef: ref,
        metadata: {},
      },
    };
    ctx.emit(event);
  },
};

// =============================================================================
// Setup
// =============================================================================

interface Setup {
  readonly dispatcher: Dispatcher;
  readonly calls: CommandCall[];
  /** vscode:command intents dispatched; a rejected one is logged at error level. */
  readonly intents: { count: number };
  readonly state: {
    active: WorkspaceRef;
    connected: boolean;
    agent: AggregatedAgentStatus;
    viewFocus: number;
  };
}

function setup(): Setup {
  const dispatcher = createMockDispatcher();
  const calls: CommandCall[] = [];
  const intents = { count: 0 };
  const state: Setup["state"] = { active: WS, connected: true, agent: idle, viewFocus: 0 };

  dispatcher.registerOperation(new ResolveWorkspaceOperation());
  dispatcher.registerOperation(new ResolveProjectOperation());
  dispatcher.registerOperation(new UpdateAgentStatusOperation());
  dispatcher.registerOperation(new VscodeModalChangedOperation());
  dispatcher.registerOperation(createCommandOperation(intents));
  dispatcher.registerOperation(createStatusOperation(() => state.agent.status));
  dispatcher.registerOperation(switchOperation);
  dispatcher.registerOperation(createDeleteEventOperation());

  dispatcher.registerModule(
    createTestMockModule({
      workspaces: Object.fromEntries(
        ["alpha", "beta"].map((name) => [
          wsPath(`/projects/test/workspaces/${name}`),
          {
            projectPath: projPath("/projects/test"),
            workspaceName: name as WorkspaceName,
            get active(): boolean {
              return makeWorkspaceRef(PROJECT, name) === state.active;
            },
          },
        ])
      ),
      projects: () => ({ projectId: "test-project" as ProjectId }),
    })
  );

  // The workspace-agent resolver: provides the capability the agent modules wait on.
  const resolver: IntentModule = {
    name: "resolver",
    hooks: {
      [VSCODE_MODAL_CHANGED_OPERATION_ID]: {
        modal: { handler: async () => ({ provides: { agent: "claude" } }) },
      },
    },
  };
  // The agent provider: a modal edge re-reports the effective status, unawaited.
  const agent: IntentModule = {
    name: "agent",
    hooks: {
      [VSCODE_MODAL_CHANGED_OPERATION_ID]: {
        modal: {
          requires: { agent: ANY_VALUE },
          handler: async (ctx: HookContext): Promise<void> => {
            const { workspaceRef, open } = ctx as ModalHookInput;
            void dispatcher.dispatch(updateStatusIntent(workspaceRef, open ? idle : state.agent));
          },
        },
      },
    },
  };

  // Registration order as in main.ts: resolver, terminal focus, agent.
  dispatcher.registerModule(resolver);
  dispatcher.registerModule(
    createTerminalFocusModule({
      dispatcher,
      // A sidekick that is not connected answers false at once, as the real one does.
      tryCommand: (workspaceRef, command) =>
        state.connected
          ? new Promise((resolve) => calls.push({ workspaceRef, command, settle: resolve }))
          : Promise.resolve(false),
      viewManager: { focus: () => state.viewFocus++ },
    })
  );
  dispatcher.registerModule(agent);

  return { dispatcher, calls, intents, state };
}

/** Let unawaited dispatches and their event handlers run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function report(s: Setup, path: WorkspaceRef, status: AggregatedAgentStatus): Promise<void> {
  await s.dispatcher.dispatch(updateStatusIntent(path, status));
  await settle();
}

async function modal(
  s: Setup,
  path: WorkspaceRef,
  open: boolean,
  source: ModalSource = "editor"
): Promise<void> {
  const intent: VscodeModalChangedIntent = {
    type: INTENT_VSCODE_MODAL_CHANGED,
    payload: { workspaceRef: path, source, open },
  };
  await s.dispatcher.dispatch(intent);
  await settle();
}

async function switchTo(s: Setup, path: WorkspaceRef): Promise<void> {
  s.state.active = path;
  await s.dispatcher.dispatch({ type: INTENT_TEST_SWITCH, payload: path } as Intent);
  await settle();
}

async function answer(s: Setup, delivered: boolean): Promise<void> {
  s.calls.at(-1)!.settle(delivered);
  await settle();
}

// =============================================================================
// Tests
// =============================================================================

describe("TerminalFocusModule", () => {
  it("focuses the terminal the first time the active workspace goes idle, then never again", async () => {
    const s = setup();

    await report(s, WS, idle);
    expect(s.calls.map((c) => [c.workspaceRef, c.command])).toEqual([
      [WS, "workbench.action.terminal.focus"],
    ]);
    await answer(s, true);
    expect(s.state.viewFocus).toBe(1);

    await report(s, WS, busy);
    await report(s, WS, idle);
    expect(s.calls).toHaveLength(1);
  });

  it("sends nothing for a busy, inactive or unconnected workspace", async () => {
    const s = setup();

    await report(s, WS, busy);
    await report(s, OTHER, idle);
    s.state.connected = false;
    await report(s, WS, idle);

    expect(s.calls).toHaveLength(0);
  });

  it("sends one focus for a burst of idle reports, and retries after a failure", async () => {
    const s = setup();

    await report(s, WS, idle);
    await report(s, WS, idle);
    expect(s.calls).toHaveLength(1);

    await answer(s, false);
    expect(s.state.viewFocus).toBe(0);

    await report(s, WS, idle);
    expect(s.calls).toHaveLength(2);
  });

  it("never dispatches a vscode:command intent, so a sidekick gone mid-send logs no failure", async () => {
    const s = setup();

    // Sent while connected, and the connection is gone by the time it is
    // answered: app shutdown or a deletion clearing it mid-flight.
    await report(s, WS, idle);
    s.state.connected = false;
    await answer(s, false);
    expect(s.state.viewFocus).toBe(0);

    // Not connected at all when it is sent.
    await report(s, WS, idle);
    expect(s.state.viewFocus).toBe(0);

    // It still focuses once the sidekick is back.
    s.state.connected = true;
    await report(s, WS, idle);
    await answer(s, true);
    expect(s.state.viewFocus).toBe(1);

    expect(s.intents.count).toBe(0);
  });

  it("ignores the idle a modal forces, and focuses once it closes on an idle agent", async () => {
    const s = setup();
    // No agent terminal yet: the agent itself reports nothing.
    s.state.agent = none;

    await modal(s, WS, true);
    expect(s.calls).toHaveLength(0);

    // The agent comes up while the modal is still open.
    s.state.agent = idle;
    await modal(s, WS, false);
    expect(s.calls).toHaveLength(1);
  });

  it("does not focus on a modal closing over a busy agent", async () => {
    const s = setup();
    s.state.agent = busy;

    await modal(s, WS, true);
    await modal(s, WS, false);

    expect(s.calls).toHaveLength(0);
  });

  it("focuses on switching to an idle workspace, but not to a busy one or behind a modal", async () => {
    const s = setup();
    s.state.active = OTHER;

    s.state.agent = busy;
    await switchTo(s, WS);
    expect(s.calls).toHaveLength(0);

    s.state.agent = idle;
    await modal(s, OTHER, true);
    await switchTo(s, OTHER);
    expect(s.calls).toHaveLength(0);

    await switchTo(s, WS);
    expect(s.calls.map((c) => c.workspaceRef)).toEqual([WS]);
  });

  it("focuses behind a waiting sidebar card, which is not in front of the terminal", async () => {
    const s = setup();
    s.state.active = OTHER;
    s.state.agent = idle;

    await modal(s, WS, true, "sidebar");
    await switchTo(s, WS);

    expect(s.calls.map((c) => c.workspaceRef)).toEqual([WS]);
  });

  it("focuses a workspace again after it was deleted", async () => {
    const s = setup();

    await report(s, WS, idle);
    await answer(s, true);

    const deletion: DeleteWorkspaceIntent = {
      type: INTENT_DELETE_WORKSPACE,
      payload: { workspaceRef: WS, force: false, removeWorktree: false },
    };
    await s.dispatcher.dispatch(deletion);
    await settle();

    await report(s, WS, idle);
    expect(s.calls).toHaveLength(2);
  });
});
