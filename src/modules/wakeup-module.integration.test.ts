// @vitest-environment node
/**
 * Integration tests for wakeup scripts: the wakeup module driven by the real
 * poll module and `poll:tick`, and the `workspace.wakeup.*` / `workspace.hibernate`
 * registry entries that set them.
 *
 * Workspaces live in a small in-memory store the fake operations read and
 * write (list, metadata, resolve, hibernate, wake, message); a fake script
 * runner answers each script with what the test set it to print.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { createBehavioralLogger, SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { createMockNotificationManager } from "./presentation/notification-manager.state-mock";
import type {
  IntentOf,
  Operation,
  OperationContext,
  OperationSchemas,
} from "../intents/lib/operation";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../intents/list-projects";
import { INTENT_GET_METADATA, type GetMetadataIntent } from "../intents/get-metadata";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../intents/set-metadata";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
  type ResolveWorkspaceResult,
} from "../intents/resolve-workspace";
import {
  EVENT_WORKSPACE_WOKEN,
  INTENT_WAKE_WORKSPACE,
  type WakeWorkspaceIntent,
} from "../intents/wake-workspace";
import {
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateWorkspaceIntent,
} from "../intents/hibernate-workspace";
import {
  INTENT_SEND_AGENT_MESSAGE,
  type SendAgentMessageIntent,
  type SendAgentMessageResult,
} from "../intents/send-agent-message";
import { PollTickOperation } from "../intents/poll-tick";
import {
  INTENT_GET_WORKSPACE_STATUS,
  type GetWorkspaceStatusIntent,
} from "../intents/get-workspace-status";
import type { Project, ProjectId, WorkspaceName } from "../shared/api/types";
import type { WorkspaceRef } from "../intents/contract";
import { projPath, wsPath, testPath, workspaceRefIn } from "../shared/test-fixtures";
import { projectRefFor } from "../utils/ref";
import { createPollModule } from "./poll-module";
import { createWakeupModule, WAKEUP_METADATA_KEY, WAKEUP_TAG_KEY } from "./wakeup-module";
import type { ScriptRequest, ScriptRunner } from "./scripts/script-runner";
import { createRegistry } from "../api/entries";
import type { OperationName } from "../api/names";
import type { OperationContext as EntryContext } from "../api/types";
import { Path } from "../utils/path/path";

const MINUTE = 60_000;
const PROJECT_PATH = projPath(testPath("/projects/repo").toString());
const PROJECT_REF = projectRefFor(PROJECT_PATH);

interface StoredWorkspace {
  readonly name: string;
  readonly ref: WorkspaceRef;
  readonly path: string;
  metadata: Record<string, string>;
}

/** An operation that only records its intents and answers with `answer`. */
function fakeOperation<I extends { type: string; payload: unknown }, R>(
  type: I["type"],
  id: string,
  answer: (intent: I, emit: (event: { type: string; payload: unknown }) => void) => R | Promise<R>,
  events: Record<string, z.ZodType> = {}
) {
  const schemas = {
    type,
    payload: z.custom<I["payload"]>(),
    result: z.custom<R>(),
    events,
  } satisfies OperationSchemas;
  return new (class implements Operation<typeof schemas> {
    readonly id = id;
    readonly schemas = schemas;
    readonly dispatched: I[] = [];
    async execute(ctx: OperationContext<IntentOf<typeof schemas>, typeof schemas>): Promise<R> {
      const intent = ctx.intent as unknown as I;
      this.dispatched.push(intent);
      return answer(intent, (event) => void ctx.emit(event as never));
    }
  })();
}

function createSetup() {
  const dispatcher = createMockDispatcher();
  const cards = createMockNotificationManager();
  cards.register(dispatcher);
  const config = createMockConfig();

  const workspaces = new Map<WorkspaceRef, StoredWorkspace>();
  const add = (name: string, metadata: Record<string, string> = {}): StoredWorkspace => {
    const ref = workspaceRefIn(PROJECT_PATH, name);
    const workspace = {
      name,
      ref,
      path: wsPath(`${PROJECT_PATH}/${name}`),
      metadata: { base: "main", ...metadata },
    };
    workspaces.set(ref, workspace);
    return workspace;
  };
  const get = (ref: WorkspaceRef): StoredWorkspace => {
    const workspace = workspaces.get(ref);
    if (!workspace) throw new Error(`unknown workspace ${ref}`);
    return workspace;
  };

  const listOp = fakeOperation<ListProjectsIntent, Project[]>(
    INTENT_LIST_PROJECTS,
    "list-projects",
    () => [
      {
        ref: PROJECT_REF,
        id: "project-1" as ProjectId,
        name: "repo",
        path: PROJECT_PATH,
        workspaces: [...workspaces.values()].map((w) => ({
          ref: w.ref,
          projectId: "project-1" as ProjectId,
          name: w.name as WorkspaceName,
          branch: w.name,
          metadata: { ...w.metadata },
          path: wsPath(w.path),
        })),
      },
    ]
  );
  const getMetaOp = fakeOperation<GetMetadataIntent, Record<string, string>>(
    INTENT_GET_METADATA,
    "get-metadata",
    (intent) => ({ ...get(intent.payload.workspaceRef).metadata })
  );
  const setMetaOp = fakeOperation<SetMetadataIntent, void>(
    INTENT_SET_METADATA,
    "set-metadata",
    (intent) => {
      const { workspaceRef, key, value } = intent.payload;
      const workspace = get(workspaceRef);
      if (value === null) delete workspace.metadata[key];
      else workspace.metadata[key] = value;
    }
  );
  const resolveOp = fakeOperation<ResolveWorkspaceIntent, ResolveWorkspaceResult>(
    INTENT_RESOLVE_WORKSPACE,
    "resolve-workspace",
    (intent) => {
      const workspace = get(intent.payload.workspaceRef!);
      return {
        workspaceRef: workspace.ref,
        workspacePath: wsPath(workspace.path),
        projectRef: PROJECT_REF,
        projectPath: PROJECT_PATH,
        workspaceName: workspace.name as WorkspaceName,
        active: false,
        branch: workspace.name,
        metadata: { ...workspace.metadata },
        closing: null,
      };
    }
  );
  const hibernateOp = fakeOperation<HibernateWorkspaceIntent, void>(
    INTENT_HIBERNATE_WORKSPACE,
    "hibernate-workspace",
    (intent) => {
      get(intent.payload.workspaceRef).metadata["hibernated"] = "true";
    }
  );
  const wakeOp = fakeOperation<WakeWorkspaceIntent, unknown>(
    INTENT_WAKE_WORKSPACE,
    "wake-workspace",
    (intent, emit) => {
      const workspace = get(intent.payload.workspaceRef);
      delete workspace.metadata["hibernated"];
      emit({
        type: EVENT_WORKSPACE_WOKEN,
        payload: {
          projectId: "project-1",
          workspaceName: workspace.name,
          workspaceRef: workspace.ref,
          projectRef: PROJECT_REF,
        },
      });
      return {};
    },
    { [EVENT_WORKSPACE_WOKEN]: z.custom() }
  );
  const messageOp = fakeOperation<SendAgentMessageIntent, SendAgentMessageResult>(
    INTENT_SEND_AGENT_MESSAGE,
    "send-agent-message",
    () => ({ sent: true })
  );
  const statusOp = fakeOperation<GetWorkspaceStatusIntent, { isDirty: boolean }>(
    INTENT_GET_WORKSPACE_STATUS,
    "get-workspace-status",
    () => ({ isDirty: false })
  );
  dispatcher.registerOperation(listOp);
  dispatcher.registerOperation(getMetaOp);
  dispatcher.registerOperation(setMetaOp);
  dispatcher.registerOperation(resolveOp);
  dispatcher.registerOperation(hibernateOp);
  dispatcher.registerOperation(wakeOp);
  dispatcher.registerOperation(messageOp);
  dispatcher.registerOperation(statusOp);

  /** What each script prints, by script body. Unset: nothing (keep). */
  const prints: Record<string, { stdout?: string; exitCode?: number }> = {};
  const requests: ScriptRequest[] = [];
  const runner: ScriptRunner = {
    async run(request) {
      requests.push(request);
      const outcome = prints[request.script] ?? {};
      return {
        result: {
          status: "exited",
          exitCode: outcome.exitCode ?? 0,
          stdout: outcome.stdout ?? "",
          stderr: "",
        },
        finish: async () => new Path(request.logDir, "run.log"),
      };
    },
  };

  const poll = createPollModule({ dispatcher, config, logger: createBehavioralLogger(), runner });
  const wakeup = createWakeupModule({
    dispatcher,
    logger: createBehavioralLogger(),
    pathProvider: createMockPathProvider(),
    pollErrors: (owner) => poll.errors(owner),
  });
  dispatcher.registerOperation(new PollTickOperation());
  dispatcher.registerModule(poll);
  dispatcher.registerModule(wakeup);

  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: {
        take: async () => ({ acquired: true, waitedMs: 0 }),
        release: () => {},
        list: () => [],
      },
      config,
      wakeups: wakeup.api,
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );
  /** Call an operation as the agent of `workspace` would. */
  const call = (
    name: OperationName,
    workspace: WorkspaceRef,
    input: Record<string, unknown> = {}
  ): Promise<unknown> => {
    const ctx: EntryContext = {
      workspaceRef: workspace,
      cwd: null,
      signal: new AbortController().signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return {
    dispatcher,
    wakeup,
    poll,
    add,
    get,
    call,
    prints,
    requests,
    wakeOp,
    messageOp,
    hibernateOp,
    get cards() {
      return cards.notifications.map((card) => card.opened);
    },
    settle: () => cards.settle(),
    start: async (): Promise<void> => {
      await poll.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} });
    },
    tick: () => vi.advanceTimersByTimeAsync(MINUTE),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("wakeup entries", () => {
  it("sets a script with its shell and variables, tagged in the sidebar", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");

    const shown = await setup.call("workspace.wakeup.set", ws.ref, {
      script: "gh pr checks 12",
      shell: "bash",
      env: ["GH_HOST=github.com", "EMPTY="],
    });

    expect(shown).toEqual({
      script: "gh pr checks 12",
      shell: "bash",
      env: { GH_HOST: "github.com", EMPTY: "" },
    });
    expect(JSON.parse(ws.metadata[WAKEUP_METADATA_KEY]!)).toEqual(shown);
    expect(JSON.parse(ws.metadata[WAKEUP_TAG_KEY]!)).toEqual({
      label: "⏰",
      description: "Wakeup script: gh pr checks 12",
    });
  });

  it("refuses a variable that is not KEY=VALUE, or one of CodeHydra's own", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");

    await expect(
      setup.call("workspace.wakeup.set", ws.ref, { script: "x", env: ["NOPE"] })
    ).rejects.toMatchObject({ category: "usage" });
    await expect(
      setup.call("workspace.wakeup.set", ws.ref, { script: "x", env: ["_CH_API_PORT=1"] })
    ).rejects.toMatchObject({ category: "usage" });
    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
  });

  it("clears the script and its tag", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.wakeup.set", ws.ref, { script: "x" });

    await setup.call("workspace.wakeup.clear", ws.ref);

    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
    expect(ws.metadata[WAKEUP_TAG_KEY]).toBeUndefined();
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toBeNull();
  });

  it("is not writable as plain metadata", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");

    await expect(
      setup.call("metadata.set", ws.ref, { key: WAKEUP_METADATA_KEY, value: "{}" })
    ).rejects.toMatchObject({ category: "usage" });
  });

  it("hibernates with a script in one call, and keeps an existing one without it", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");

    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check", env: ["A=1"] });
    expect(ws.metadata["hibernated"]).toBe("true");
    expect(JSON.parse(ws.metadata[WAKEUP_METADATA_KEY]!)).toMatchObject({
      script: "check",
      env: { A: "1" },
    });

    delete ws.metadata["hibernated"];
    await setup.call("workspace.hibernate", ws.ref);
    expect(JSON.parse(ws.metadata[WAKEUP_METADATA_KEY]!)).toMatchObject({ script: "check" });
  });

  it("refuses shell or env on hibernate without a script", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");

    await expect(setup.call("workspace.hibernate", ws.ref, { env: ["A=1"] })).rejects.toMatchObject(
      { category: "usage" }
    );
    expect(setup.hibernateOp.dispatched).toHaveLength(0);
  });
});

describe("wakeup scripts: polling", () => {
  it("runs only hibernated workspaces' scripts, in their worktree", async () => {
    const setup = createSetup();
    const asleep = setup.add("asleep");
    const awake = setup.add("awake");
    await setup.call("workspace.wakeup.set", asleep.ref, { script: "check", env: ["A=1"] });
    await setup.call("workspace.wakeup.set", awake.ref, { script: "other" });
    asleep.metadata["hibernated"] = "true";

    await setup.start();

    expect(setup.requests).toHaveLength(1);
    const request = setup.requests[0]!;
    expect(request.script).toBe("check");
    expect(request.env).toEqual({ A: "1" });
    expect(request.cwd.equals(new Path(asleep.path))).toBe(true);
    expect(request.workspaceDir?.equals(new Path(asleep.path))).toBe(true);
    expect(request.input).toEqual({
      workspace: asleep.ref,
      project: PROJECT_REF,
      workspacePath: asleep.path,
    });
  });

  it("keeps a workspace asleep while its script prints nothing or keep", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });

    await setup.start();
    setup.prints["check"] = { stdout: '{"action":"keep"}' };
    await setup.tick();

    expect(setup.requests).toHaveLength(2);
    expect(setup.wakeOp.dispatched).toHaveLength(0);
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      script: "check",
      lastRun: { outcome: "keep" },
    });
  });

  it("wakes the workspace in place with its message, which the send delivers", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { stdout: '{"action":"wake","message":"CI is green"}' };

    await setup.start();

    // A send with `wake` wakes a hibernated workspace itself (no switch) and
    // waits for its agent, which a send right after a wake could not.
    expect(setup.messageOp.dispatched.map((intent) => intent.payload)).toEqual([
      { workspaceRef: ws.ref, text: "CI is green", from: "CodeHydra · wakeup", wake: true },
    ]);
    expect(setup.wakeOp.dispatched).toHaveLength(0);
  });

  it("wakes in place without a message, clears the script and runs it no more", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { stdout: '{"action":"wake"}' };

    await setup.start();
    await setup.settle();

    expect(setup.wakeOp.dispatched.map((intent) => intent.payload)).toEqual([
      { workspaceRef: ws.ref, stealFocus: false },
    ]);
    expect(setup.messageOp.dispatched).toHaveLength(0);
    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
    expect(ws.metadata[WAKEUP_TAG_KEY]).toBeUndefined();

    await setup.tick();
    expect(setup.requests).toHaveLength(1); // one-shot: nothing left to run
  });

  it("clears the script when something else wakes the workspace", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });

    await setup.call("workspace.wake", ws.ref);
    await setup.settle(); // the woken event is emitted, not awaited

    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
    expect(ws.metadata[WAKEUP_TAG_KEY]).toBeUndefined();
  });

  it("never wakes on a failed run, and announces it once with its log", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { exitCode: 1, stdout: '{"action":"wake"}' };

    await setup.start();
    await setup.tick();
    await setup.settle();

    expect(setup.wakeOp.dispatched).toHaveLength(0);
    expect(setup.cards).toEqual([
      expect.objectContaining({
        title: "Wakeup script failed",
        message: "wakeup pr-12: exit 1 — see ch ws wakeup show",
      }),
    ]);
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      lastRun: { outcome: "failed", message: "exit 1" },
      error: { message: "exit 1", logPath: expect.any(String) },
    });
  });

  it("reports output that is not a verdict, and stays asleep", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { stdout: '{"action":"delete"}' };

    await setup.start();
    await setup.settle();

    expect(setup.wakeOp.dispatched).toHaveLength(0);
    expect(setup.cards.map((card) => card.message)).toEqual([
      'wakeup pr-12: printed JSON that is not {"action": "wake" | "keep", "message"?: string} — see ch ws wakeup show',
    ]);
  });

  it("includes the script in the workspace's status", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.wakeup.set", ws.ref, { script: "check" });

    await expect(setup.call("workspace.status", ws.ref)).resolves.toEqual({
      isDirty: false,
      wakeup: { script: "check", shell: "bash", env: {} },
    });
    await setup.call("workspace.wakeup.clear", ws.ref);
    await expect(setup.call("workspace.status", ws.ref)).resolves.toEqual({
      isDirty: false,
      wakeup: null,
    });
  });
});
