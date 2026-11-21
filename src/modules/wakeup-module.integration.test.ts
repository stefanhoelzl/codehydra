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
  EVENT_WORKSPACE_HIBERNATED,
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateWorkspaceIntent,
} from "../intents/hibernate-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
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
import { gitProjectRef } from "./git/ref";
import { createPollModule } from "./poll-module";
import {
  createWakeupModule,
  decodeWakeup,
  describeWakeup,
  WAKEUP_METADATA_KEY,
  WAKEUP_TAG_KEY,
} from "./wakeup-module";
import type { ScriptRequest, ScriptRunner } from "./scripts/script-runner";
import { createRegistry } from "../api/entries";
import type { OperationName } from "../api/names";
import type { OperationContext as EntryContext } from "../api/types";
import { Path } from "../utils/path/path";

const MINUTE = 60_000;
const DAY_SECONDS = 24 * 60 * 60;
const PROJECT_PATH = projPath(testPath("/projects/repo").toString());
const PROJECT_REF = gitProjectRef(PROJECT_PATH);

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
    (intent, emit) => {
      const workspace = get(intent.payload.workspaceRef);
      workspace.metadata["hibernated"] = "true";
      workspace.metadata["hibernated-at"] = new Date().toISOString();
      emit({
        type: EVENT_WORKSPACE_HIBERNATED,
        payload: {
          projectId: "project-1",
          workspaceName: workspace.name,
          workspaceRef: workspace.ref,
          projectRef: PROJECT_REF,
        },
      });
    },
    { [EVENT_WORKSPACE_HIBERNATED]: z.custom() }
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
    // A send with `wake` wakes a hibernated workspace first, as the real one does.
    (intent, emit) => {
      const workspace = get(intent.payload.workspaceRef);
      if (intent.payload.wake === true && workspace.metadata["hibernated"] === "true") {
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
      }
      return { sent: true };
    }
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
  const prints: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = {};
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
          stderr: outcome.stderr ?? "",
        },
        finish: async () => new Path(request.logDir, "run.log"),
      };
    },
  };

  const poll = createPollModule({
    dispatcher,
    config,
    logger: createBehavioralLogger(),
    runner,
    appLayer: { openPath: async () => {} },
  });
  const wakeup = createWakeupModule({
    dispatcher,
    logger: createBehavioralLogger(),
    pathProvider: createMockPathProvider(),
    pollErrors: (owner) => poll.errors(owner),
    markWaiting: (job) => poll.markWaiting(job),
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
      processes: { list: async () => null },
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
    /** Delete a workspace: gone from the list, then the event (a real deletion, or a project's teardown). */
    remove: async (workspace: StoredWorkspace, worktreeRemoved = true): Promise<void> => {
      workspaces.delete(workspace.ref);
      await wakeup.events![EVENT_WORKSPACE_DELETED]!.handler({
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: "project-1" as ProjectId,
          workspaceName: workspace.name as WorkspaceName,
          workspaceRef: workspace.ref,
          projectRef: PROJECT_REF,
          worktreeRemoved,
        },
      });
    },
    /** The texts sent to agents, by workspace name. */
    sent: (): { name: string; text: string }[] =>
      messageOp.dispatched.map((intent) => ({
        name: get(intent.payload.workspaceRef).name,
        text: intent.payload.text,
      })),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("wakeup entries", () => {
  it("sets a script with its shell and variables, without a sidebar tag", async () => {
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
      timeoutSeconds: 14 * DAY_SECONDS,
    });
    expect(JSON.parse(ws.metadata[WAKEUP_METADATA_KEY]!)).toEqual({
      script: "gh pr checks 12",
      shell: "bash",
      env: { GH_HOST: "github.com", EMPTY: "" },
    });
    expect(ws.metadata[WAKEUP_TAG_KEY]).toBeUndefined();
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

  it("clears the script and a tag an older version set", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.wakeup.set", ws.ref, { script: "x" });
    ws.metadata[WAKEUP_TAG_KEY] = JSON.stringify({ label: "x" });

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

  it("wakes on a failed run, telling its agent what went wrong, and announces it", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { exitCode: 6, stderr: "gh: not logged in" };

    await setup.start();
    await setup.settle();

    const [sent] = setup.messageOp.dispatched;
    expect(sent?.payload).toMatchObject({ workspaceRef: ws.ref, wake: true });
    expect(sent?.payload.text).toContain("Your wakeup script failed (exit 6)");
    expect(sent?.payload.text).toContain("gh: not logged in");
    expect(setup.cards).toEqual([
      expect.objectContaining({
        title: "Wakeup script failed",
        message: "wakeup pr-12: exit 6 — see ch ws wakeup show",
      }),
    ]);
  });

  it("wakes on output that is not a verdict, showing its agent the output", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { stdout: '{"action":"delete"}' };

    await setup.start();
    await setup.settle();

    const text = setup.messageOp.dispatched[0]?.payload.text ?? "";
    expect(text).toContain('printed JSON that is not {"action": "wake" | "keep"');
    expect(text).toContain('{"action":"delete"}');
    expect(setup.cards.map((card) => card.message)).toEqual([
      'wakeup pr-12: printed JSON that is not {"action": "wake" | "keep", "message"?: string} — see ch ws wakeup show',
    ]);
  });

  it("stays asleep through temporary failures until they have gone on for ten minutes", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check" });
    setup.prints["check"] = { exitCode: 75 };

    await setup.start();
    for (let minute = 0; minute < 9; minute++) await setup.tick();
    expect(setup.messageOp.dispatched).toHaveLength(0);
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      lastRun: { outcome: "failed" },
    });

    await setup.tick();
    await setup.tick();
    expect(setup.messageOp.dispatched.map((intent) => intent.payload.text)).toEqual([
      expect.stringContaining("Your wakeup script failed (temporary failure (exit 75))"),
    ]);
  });

  it("includes the script in the workspace's status", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.wakeup.set", ws.ref, { script: "check" });

    await expect(setup.call("workspace.status", ws.ref)).resolves.toEqual({
      isDirty: false,
      hibernated: false,
      hibernatedAt: null,
      wakeup: { script: "check", shell: "bash", env: {}, timeoutSeconds: 14 * DAY_SECONDS },
    });
    await setup.call("workspace.wakeup.clear", ws.ref);
    await expect(setup.call("workspace.status", ws.ref)).resolves.toEqual({
      isDirty: false,
      hibernated: false,
      hibernatedAt: null,
      wakeup: null,
    });
  });

  it("includes whether and since when the workspace is hibernated in its status", async () => {
    const setup = createSetup();
    const at = "2026-10-27T14:02:11.000Z";
    const timed = setup.add("timed", { hibernated: "true", "hibernated-at": at });
    // Without a valid time (the backfill failed, a hand edit) it reads as now.
    const garbled = setup.add("garbled", { hibernated: "true", "hibernated-at": "soon" });
    // A stray time without the flag is not a hibernation.
    const awake = setup.add("awake", { "hibernated-at": at });

    await expect(setup.call("workspace.status", timed.ref)).resolves.toMatchObject({
      hibernated: true,
      hibernatedAt: at,
    });
    const before = Date.now();
    const status = (await setup.call("workspace.status", garbled.ref)) as {
      hibernated: boolean;
      hibernatedAt: string;
    };
    expect(status.hibernated).toBe(true);
    expect(Date.parse(status.hibernatedAt)).toBeGreaterThanOrEqual(before);
    await expect(setup.call("workspace.status", awake.ref)).resolves.toMatchObject({
      hibernated: false,
      hibernatedAt: null,
    });
  });
});

describe("wakeup: waiting for other workspaces", () => {
  it("wakes the moment a watched workspace is deleted, telling its agent why", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const closer = setup.add("closer");
    await setup.call("workspace.hibernate", sleeper.ref, { untilDeleted: ["closer"] });
    expect(JSON.parse(sleeper.metadata[WAKEUP_METADATA_KEY]!)).toEqual({
      watch: [{ workspace: closer.ref, until: "deleted" }],
    });

    await setup.start();
    expect(setup.sent()).toEqual([]);
    expect(setup.requests).toEqual([]); // no script, nothing to run

    await setup.remove(closer);
    expect(setup.sent()).toEqual([
      { name: "sleeper", text: "Woken because closer was deleted (or its project closed)." },
    ]);
  });

  it("leaves a project's teardown to the next tick", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const closer = setup.add("closer");
    await setup.call("workspace.hibernate", sleeper.ref, { untilDeleted: ["closer"] });
    await setup.start();

    await setup.remove(closer, false);
    expect(setup.sent()).toEqual([]);
    await setup.tick();
    expect(setup.sent()).toHaveLength(1);
  });

  it("wakes when a watched workspace hibernates, or a hibernated one wakes", async () => {
    const setup = createSetup();
    const a = setup.add("a");
    const b = setup.add("b");
    const other = setup.add("other");
    const sleeping = setup.add("sleeping", { hibernated: "true" });
    await setup.call("workspace.hibernate", a.ref, { untilHibernated: ["other"] });
    await setup.call("workspace.hibernate", b.ref, { untilWoken: ["sleeping"] });
    await setup.start();

    await setup.call("workspace.hibernate", other.ref);
    await setup.settle();
    expect(setup.sent()).toEqual([{ name: "a", text: "Woken because other hibernated." }]);

    await setup.call("workspace.wake", sleeping.ref);
    await setup.settle();
    expect(setup.sent()).toContainEqual({ name: "b", text: "Woken because sleeping woke." });
  });

  it("with all, waits for every watched workspace, counting one that left its state again", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const a = setup.add("a");
    const b = setup.add("b");
    await setup.call("workspace.hibernate", sleeper.ref, {
      untilHibernated: ["a", "b"],
      all: true,
    });
    await setup.start();

    await setup.call("workspace.hibernate", a.ref);
    await setup.settle();
    await setup.call("workspace.wake", a.ref);
    await setup.settle();
    expect(setup.sent()).toEqual([]);
    await expect(setup.call("workspace.wakeup.show", sleeper.ref)).resolves.toMatchObject({
      all: true,
      watch: [
        { workspace: a.ref, until: "hibernated", reachedAt: expect.any(String) },
        { workspace: b.ref, until: "hibernated" },
      ],
    });

    await setup.call("workspace.hibernate", b.ref);
    await setup.settle();
    expect(setup.sent()).toEqual([
      {
        name: "sleeper",
        text: "Woken because every workspace this one waited for reached its state: a hibernated; b hibernated.",
      },
    ]);
  });

  it("counts a watched workspace that is gone as having reached any state", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const other = setup.add("other");
    await setup.call("workspace.hibernate", sleeper.ref, { untilHibernated: ["other"] });
    await setup.start();

    await setup.remove(other);
    expect(setup.sent()[0]?.text).toContain("other is gone");
  });

  it("combines with a script: whichever comes first wakes it", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const closer = setup.add("closer");
    await setup.call("workspace.hibernate", sleeper.ref, {
      wakeup: "check",
      untilDeleted: ["closer"],
    });
    await setup.start();
    expect(setup.requests).toHaveLength(1);
    expect(setup.sent()).toEqual([]);

    await setup.remove(closer);
    await setup.settle();
    expect(setup.sent()).toHaveLength(1);
    expect(sleeper.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
    await setup.tick();
    expect(setup.requests).toHaveLength(1); // cleared with the wake
  });

  it("wakes at hibernation when a condition armed while awake is met by then", async () => {
    const setup = createSetup();
    const sleeper = setup.add("sleeper");
    const closer = setup.add("closer");
    await setup.start();
    await setup.call("workspace.wakeup.set", sleeper.ref, { untilDeleted: ["closer"] });
    await setup.remove(closer);
    expect(setup.sent()).toEqual([]); // awake: nothing to wake

    await setup.call("workspace.hibernate", sleeper.ref);
    await setup.settle();
    expect(setup.sent()).toHaveLength(1);
  });

  it("refuses what could never mean what was asked", async () => {
    const setup = createSetup();
    const ws = setup.add("ws");
    setup.add("awake");
    setup.add("asleep", { hibernated: "true" });
    const set = (input: Record<string, unknown>) =>
      setup.call("workspace.wakeup.set", ws.ref, input);

    await expect(set({ untilDeleted: ["ws"] })).rejects.toMatchObject({ category: "usage" });
    await expect(set({ untilDeleted: ["nope"] })).rejects.toMatchObject({
      category: "not-found",
    });
    await expect(set({ untilHibernated: ["asleep"] })).rejects.toMatchObject({
      category: "conflict",
    });
    await expect(set({ untilWoken: ["awake"] })).rejects.toMatchObject({ category: "conflict" });
    await expect(set({ all: true })).rejects.toMatchObject({ category: "usage" });
    await expect(set({})).rejects.toMatchObject({ category: "usage" });
    await expect(set({ shell: "bash", untilDeleted: ["awake"] })).rejects.toMatchObject({
      category: "usage",
    });
    await expect(
      setup.call("workspace.hibernate", ws.ref, { untilHibernated: ["asleep"] })
    ).rejects.toMatchObject({ category: "conflict" });
    expect(setup.hibernateOp.dispatched).toHaveLength(0);
    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
  });
});

describe("wakeup: sidebar description", () => {
  it("is the script alone when that is all, else each condition", () => {
    const ref = (name: string) => workspaceRefIn(PROJECT_PATH, name);
    const describe = (value: object) => describeWakeup(decodeWakeup(JSON.stringify(value))!);

    expect(describe({ script: "check", shell: "bash", env: {} })).toBe("check");
    expect(
      describe({
        script: "check",
        shell: "bash",
        env: {},
        watch: [
          { workspace: ref("a"), until: "deleted" },
          { workspace: ref("b"), until: "woken" },
        ],
      })
    ).toBe("when a is deleted or b wakes · or script: check");
    expect(
      describe({
        watch: [
          { workspace: ref("a"), until: "hibernated" },
          { workspace: ref("b"), until: "hibernated" },
        ],
        all: true,
      })
    ).toBe("when a hibernates and b hibernates");
  });
});

describe("wakeup: timeouts", () => {
  it("wakes a workspace with a wakeup after 14 days by default, telling its agent why", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    setup.add("closer");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check", untilDeleted: ["closer"] });
    const hibernatedAt = ws.metadata["hibernated-at"]!;
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      timeoutSeconds: 14 * DAY_SECONDS,
      deadline: new Date(Date.parse(hibernatedAt) + 14 * DAY_SECONDS * 1000).toISOString(),
    });
    await setup.start();

    vi.setSystemTime(Date.parse(hibernatedAt) + 14 * DAY_SECONDS * 1000 - 2 * MINUTE);
    await setup.tick(); // one minute short of it: the script still runs
    expect(setup.sent()).toEqual([]);
    expect(setup.requests).toHaveLength(2);

    await setup.tick();
    expect(setup.sent()).toEqual([
      {
        name: "pr-12",
        text:
          `Woken because its timeout of 14d (the default) passed since it hibernated at ` +
          `${hibernatedAt}, before what it waited for came (until closer is deleted, or its ` +
          "wakeup script says so).",
      },
    ]);
    expect(setup.requests).toHaveLength(2); // timed out: its script no longer runs
  });

  it("takes a timeout alone, and one in other units", async () => {
    const setup = createSetup();
    const ws = setup.add("nap");
    await setup.call("workspace.hibernate", ws.ref, { timeout: "2h" });
    expect(JSON.parse(ws.metadata[WAKEUP_METADATA_KEY]!)).toEqual({ timeoutSeconds: 7200 });
    await setup.start();

    await vi.advanceTimersByTimeAsync(119 * MINUTE);
    expect(setup.sent()).toEqual([]);
    await setup.tick();
    expect(setup.sent()[0]?.text).toMatch(/^Woken because its timeout of 2h passed since/);
  });

  it("never times out with timeout never", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check", timeout: "never" });
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      timeoutSeconds: null,
    });
    await setup.start();

    vi.setSystemTime(Date.now() + 365 * DAY_SECONDS * 1000);
    await setup.tick();
    expect(setup.sent()).toEqual([]);
  });

  it("gives a plain hibernation no timeout", async () => {
    const setup = createSetup();
    const ws = setup.add("plain");
    await setup.call("workspace.hibernate", ws.ref);
    await setup.start();

    vi.setSystemTime(Date.now() + 30 * DAY_SECONDS * 1000);
    await setup.tick();
    expect(setup.sent()).toEqual([]);
    expect(setup.wakeOp.dispatched).toEqual([]);
  });

  it("refuses a timeout that is not a duration, and never on its own", async () => {
    const setup = createSetup();
    const ws = setup.add("ws");
    for (const timeout of ["10x", "0d", "d", "-1h", "never"]) {
      await expect(setup.call("workspace.wakeup.set", ws.ref, { timeout })).rejects.toMatchObject({
        category: "usage",
      });
    }
    expect(ws.metadata[WAKEUP_METADATA_KEY]).toBeUndefined();
  });

  it("describes a timeout given in the sidebar, not the default", () => {
    const describe = (value: object) => describeWakeup(decodeWakeup(JSON.stringify(value))!);
    expect(describe({ timeoutSeconds: 7200 })).toBe("after 2h");
    expect(describe({ script: "check", timeoutSeconds: 10 * DAY_SECONDS })).toBe(
      "check · or at the latest after 10d"
    );
  });
});

describe("wakeup scripts: cadence", () => {
  it("runs every tick for a day, then every 15 minutes, then every 2 hours after a week", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check", timeout: "never" });
    const hibernatedAt = Date.parse(ws.metadata["hibernated-at"]!);
    await setup.start();
    await setup.tick();
    expect(setup.requests).toHaveLength(2); // first day: every tick

    vi.setSystemTime(hibernatedAt + DAY_SECONDS * 1000);
    const runsIn = async (minutes: number): Promise<number> => {
      const before = setup.requests.length;
      for (let minute = 0; minute < minutes; minute++) await setup.tick();
      return setup.requests.length - before;
    };
    expect(await runsIn(30)).toBe(2); // after a day: every 15 minutes

    vi.setSystemTime(hibernatedAt + 7 * DAY_SECONDS * 1000);
    expect(await runsIn(1)).toBe(1); // overdue: its last run was days ago
    expect(await runsIn(119)).toBe(0); // after a week: every 2 hours
    expect(await runsIn(1)).toBe(1);
  });

  it("keeps a failing script's notification up while it is not due", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "check", timeout: "never" });
    vi.setSystemTime(Date.parse(ws.metadata["hibernated-at"]!) + 2 * DAY_SECONDS * 1000);
    setup.prints["check"] = { exitCode: 75 };
    await setup.start();
    await setup.tick();

    expect(setup.requests).toHaveLength(1);
    await expect(setup.call("workspace.wakeup.show", ws.ref)).resolves.toMatchObject({
      error: { message: "temporary failure (exit 75), retrying" },
    });
  });

  it("runs a script just set on the next tick, however long the workspace slept", async () => {
    const setup = createSetup();
    const ws = setup.add("pr-12");
    await setup.call("workspace.hibernate", ws.ref, { wakeup: "old", timeout: "never" });
    vi.setSystemTime(Date.parse(ws.metadata["hibernated-at"]!) + 8 * DAY_SECONDS * 1000);
    await setup.start();

    await setup.call("workspace.wakeup.set", ws.ref, { script: "new", timeout: "never" });
    await setup.tick();
    expect(setup.requests.map((request) => request.script)).toEqual(["old", "new"]);
  });
});
