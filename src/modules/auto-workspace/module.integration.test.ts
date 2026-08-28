// @vitest-environment node
/**
 * Integration tests for AutoWorkspaceModule through the Dispatcher.
 *
 * The module polls user-defined command sources: a mock ProcessRunner supplies
 * each cmd's stdout, and `auto-workspace.sources` config drives which sources
 * run. A chained timer re-reads config and polls, waiting
 * `auto-workspace.poll-interval` seconds (default 60) between the end of one
 * cycle and the start of the next; tests drive it with fake timers.
 */

import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createBehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
  HookContext,
} from "../../intents/lib/operation";
import type { Project, ProjectId, Workspace, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../../intents/app-start";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../../intents/app-shutdown";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../intents/open-project";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
  type GetProjectBasesResult,
} from "../../intents/get-project-bases";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
  type ResolveWorkspaceResult,
} from "../../intents/resolve-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../../intents/wake-workspace";
import {
  INTENT_SWITCH_WORKSPACE,
  type SwitchWorkspaceIntent,
} from "../../intents/switch-workspace";
import { HIBERNATED_METADATA_KEY } from "../../intents/hibernate-workspace";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { createAutoWorkspaceModule } from "./module";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState, type MockStateService } from "../../boundaries/platform/state.test-utils";
import { projPath, wsPath, testPath } from "../../shared/test-fixtures";

const DEFAULT_INTERVAL_MS = 60 * 1000;

type StateEntry = { workspaceName: string; createdAt: string };
function entriesOf(state: MockStateService): Record<string, StateEntry> {
  return (state.getEffective()["auto-workspaces"] ?? {}) as Record<string, StateEntry>;
}

// ---- Minimal operations ----

const activateSchemas = { type: INTENT_APP_START, payload: z.unknown() } satisfies OperationSchemas;
class MinimalActivateOperation implements Operation<typeof activateSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = activateSchemas;
  async execute(
    ctx: OperationContext<IntentOf<typeof activateSchemas>, typeof activateSchemas>
  ): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect("start", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    await ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
  }
}

const openProjectSchemas = {
  type: INTENT_OPEN_PROJECT,
  payload: z.custom<OpenProjectIntent["payload"]>(),
  result: z.custom<Project>(),
} satisfies OperationSchemas;
class OpenProjectOp implements Operation<typeof openProjectSchemas> {
  readonly id = "open-project";
  readonly schemas = openProjectSchemas;
  readonly dispatched: IntentOf<typeof openProjectSchemas>[] = [];
  /** Git URLs whose open throws (unreachable remote, bad path, …). */
  readonly failFor = new Set<string>();
  async execute(
    ctx: OperationContext<IntentOf<typeof openProjectSchemas>, typeof openProjectSchemas>
  ): Promise<Project> {
    this.dispatched.push(ctx.intent);
    const git = ctx.intent.payload.git;
    if (git !== undefined && this.failFor.has(git)) throw new Error(`clone failed for ${git}`);
    const pathStr =
      ctx.intent.payload.path?.toString() ?? testPath("/home/user/projects/repo").toNative();
    return { id: "project-1" as ProjectId, name: "repo", path: projPath(pathStr), workspaces: [] };
  }
}

interface WsResult {
  projectId: string;
  name: string;
  path: string;
  branch: string;
  metadata: Record<string, string>;
}
const openWorkspaceSchemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: z.custom<OpenWorkspaceIntent["payload"]>(),
  result: z.custom<WsResult>(),
} satisfies OperationSchemas;
class OpenWorkspaceOp implements Operation<typeof openWorkspaceSchemas> {
  readonly id = "open-workspace";
  readonly schemas = openWorkspaceSchemas;
  readonly dispatched: IntentOf<typeof openWorkspaceSchemas>[] = [];
  readonly failFor = new Set<string>();
  /** Set to a pending promise to hold creation open (simulates a slow cycle). */
  gate: Promise<void> | null = null;
  async execute(
    ctx: OperationContext<IntentOf<typeof openWorkspaceSchemas>, typeof openWorkspaceSchemas>
  ): Promise<WsResult> {
    this.dispatched.push(ctx.intent);
    if (this.gate) await this.gate;
    const name = ctx.intent.payload.workspaceName ?? "ws";
    if (this.failFor.has(name)) throw new Error(`open failed for ${name}`);
    return {
      projectId: "project-1",
      name,
      path: `/home/user/projects/repo/${name}`,
      branch: "feature",
      metadata: {},
    };
  }
}

const getBasesSchemas = {
  type: INTENT_GET_PROJECT_BASES,
  payload: z.custom<GetProjectBasesIntent["payload"]>(),
  result: z.custom<GetProjectBasesResult>(),
} satisfies OperationSchemas;
class GetBasesOp implements Operation<typeof getBasesSchemas> {
  readonly id = "get-project-bases";
  readonly schemas = getBasesSchemas;
  async execute(
    ctx: OperationContext<IntentOf<typeof getBasesSchemas>, typeof getBasesSchemas>
  ): Promise<GetProjectBasesResult> {
    return {
      bases: [],
      projectPath: ctx.intent.payload.projectPath,
      projectId: "project-1" as ProjectId,
    };
  }
}

const setMetaSchemas = {
  type: INTENT_SET_METADATA,
  payload: z.custom<SetMetadataIntent["payload"]>(),
} satisfies OperationSchemas;
class SetMetaOp implements Operation<typeof setMetaSchemas> {
  readonly id = "set-metadata";
  readonly schemas = setMetaSchemas;
  readonly dispatched: IntentOf<typeof setMetaSchemas>[] = [];
  async execute(
    ctx: OperationContext<IntentOf<typeof setMetaSchemas>, typeof setMetaSchemas>
  ): Promise<void> {
    this.dispatched.push(ctx.intent);
  }
}

/** The path OpenProjectOp resolves a `git:` template to. */
const PROJECT_PATH = testPath("/home/user/projects/repo").toNative();

/** The branded path a workspace of this project gets — normalized, as production mints it. */
function workspacePathOf(name: string): WorkspacePath {
  return wsPath(`${PROJECT_PATH}/${name}`);
}

function workspaceNamed(name: string, metadata: Record<string, string> = {}): Workspace {
  return {
    projectId: "project-1" as ProjectId,
    name: name as WorkspaceName,
    branch: name,
    metadata: { base: "main", ...metadata },
    path: workspacePathOf(name),
  };
}

const listProjectsSchemas = {
  type: INTENT_LIST_PROJECTS,
  payload: z.custom<ListProjectsIntent["payload"]>(),
  result: z.custom<Project[]>(),
} satisfies OperationSchemas;
class ListProjectsOp implements Operation<typeof listProjectsSchemas> {
  readonly id = "list-projects";
  readonly schemas = listProjectsSchemas;
  /** Workspaces the project is discovered to have. Tests push onto this. */
  readonly workspaces: Workspace[] = [];
  async execute(): Promise<Project[]> {
    return [
      {
        id: "project-1" as ProjectId,
        name: "repo",
        path: projPath(PROJECT_PATH),
        workspaces: [...this.workspaces],
      },
    ];
  }
}

const resolveWsSchemas = {
  type: INTENT_RESOLVE_WORKSPACE,
  payload: z.custom<ResolveWorkspaceIntent["payload"]>(),
  result: z.custom<ResolveWorkspaceResult>(),
} satisfies OperationSchemas;
class ResolveWorkspaceOp implements Operation<typeof resolveWsSchemas> {
  readonly id = "resolve-workspace";
  readonly schemas = resolveWsSchemas;
  /** Set by tests to put the matched workspace mid-teardown. */
  closing: ResolveWorkspaceResult["closing"] = null;
  constructor(private readonly projects: ListProjectsOp) {}
  async execute(
    ctx: OperationContext<IntentOf<typeof resolveWsSchemas>, typeof resolveWsSchemas>
  ): Promise<ResolveWorkspaceResult> {
    const path = ctx.intent.payload.workspacePath;
    const found = this.projects.workspaces.find((w) => w.path === path);
    if (!found) throw new Error(`unknown workspace ${path}`);
    return {
      projectPath: projPath(PROJECT_PATH),
      workspaceName: found.name,
      active: false,
      branch: found.branch,
      metadata: found.metadata,
      closing: this.closing,
    };
  }
}

const wakeSchemas = {
  type: INTENT_WAKE_WORKSPACE,
  payload: z.custom<WakeWorkspaceIntent["payload"]>(),
  result: z.custom<WsResult>(),
} satisfies OperationSchemas;
class WakeWorkspaceOp implements Operation<typeof wakeSchemas> {
  readonly id = "wake-workspace";
  readonly schemas = wakeSchemas;
  readonly dispatched: IntentOf<typeof wakeSchemas>[] = [];
  async execute(
    ctx: OperationContext<IntentOf<typeof wakeSchemas>, typeof wakeSchemas>
  ): Promise<WsResult> {
    this.dispatched.push(ctx.intent);
    const path = ctx.intent.payload.workspacePath;
    return {
      projectId: "project-1",
      name: path.split("/").pop() ?? "ws",
      path,
      branch: "feature",
      metadata: {},
    };
  }
}

const switchSchemas = {
  type: INTENT_SWITCH_WORKSPACE,
  payload: z.custom<SwitchWorkspaceIntent["payload"]>(),
} satisfies OperationSchemas;
class SwitchWorkspaceOp implements Operation<typeof switchSchemas> {
  readonly id = "switch-workspace";
  readonly schemas = switchSchemas;
  readonly dispatched: IntentOf<typeof switchSchemas>[] = [];
  async execute(
    ctx: OperationContext<IntentOf<typeof switchSchemas>, typeof switchSchemas>
  ): Promise<void> {
    this.dispatched.push(ctx.intent);
  }
}

// ---- Setup ----

function sourceYaml(name = "gh"): string {
  return `name: ${name}
cmd: fetch
template:
  name: "ws-{{ id }}"
  key: "{{ id }}"
  git: "https://github.com/org/repo.git"
  prompt: "Work on {{ id }}"`;
}

/** An events-mode source. `focus` is appended verbatim when given. */
function eventsYaml(options?: { name?: string; focus?: boolean }): string {
  return `name: ${options?.name ?? "gh"}
type: cron
mode: events
cmd: fetch
template:
  name: "ws-{{ id }}"
  git: "https://github.com/org/repo.git"
  prompt: "Work on {{ id }}"
  metadata:
    title: "Event {{ id }}"${options?.focus === undefined ? "" : `\n  focus: ${String(options.focus)}`}`;
}

interface CmdControl {
  items: unknown[];
  exitCode: number;
  stderr: string;
}

function createSetup(options?: {
  sources?: string | null;
  configDefaults?: Record<string, unknown>;
  legacyStateFileContent?: string;
  existingEntries?: Record<string, StateEntry>;
}) {
  const cmd: CmdControl = { items: [], exitCode: 0, stderr: "" };
  const processRunner = createMockProcessRunner({
    onSpawn: () => ({
      exitCode: cmd.exitCode,
      stdout: JSON.stringify(cmd.items),
      stderr: cmd.stderr,
    }),
  });
  const logger = createBehavioralLogger();

  const fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/data": directory(),
  };
  if (options?.legacyStateFileContent !== undefined) {
    fsEntries[testPath("/data/auto-workspaces.json").toNative()] = file(
      options.legacyStateFileContent
    );
  }
  const fs = createFileSystemMock({ entries: fsEntries });

  const state = createMockState(
    options?.existingEntries
      ? { values: { "auto-workspaces": options.existingEntries } }
      : undefined
  );

  const dispatcher = createMockDispatcher();
  const openProjectOp = new OpenProjectOp();
  const openWorkspaceOp = new OpenWorkspaceOp();
  const getBasesOp = new GetBasesOp();
  const setMetaOp = new SetMetaOp();
  const listProjectsOp = new ListProjectsOp();
  const resolveWsOp = new ResolveWorkspaceOp(listProjectsOp);
  const wakeOp = new WakeWorkspaceOp();
  const switchOp = new SwitchWorkspaceOp();

  const configDefaults: Record<string, unknown> = { ...(options?.configDefaults ?? {}) };
  if (options?.sources !== undefined && options.sources !== null) {
    configDefaults["auto-workspace.sources"] = options.sources;
  }
  const mockConfig = createMockConfig({ defaults: configDefaults });

  dispatcher.registerOperation(new MinimalActivateOperation());
  dispatcher.registerOperation(new AppShutdownOperation());
  dispatcher.registerOperation(openProjectOp);
  dispatcher.registerOperation(openWorkspaceOp);
  dispatcher.registerOperation(getBasesOp);
  dispatcher.registerOperation(setMetaOp);
  dispatcher.registerOperation(listProjectsOp);
  dispatcher.registerOperation(resolveWsOp);
  dispatcher.registerOperation(wakeOp);
  dispatcher.registerOperation(switchOp);

  const module = createAutoWorkspaceModule({
    fs,
    logger,
    legacyStateFilePath: testPath("/data/auto-workspaces.json").toNative(),
    dispatcher,
    processRunner,
    configService: mockConfig,
    stateService: state,
  });
  dispatcher.registerModule(module);

  return {
    dispatcher,
    fs,
    state,
    cmd,
    logger,
    mockConfig,
    openProjectOp,
    openWorkspaceOp,
    setMetaOp,
    listProjectsOp,
    resolveWsOp,
    wakeOp,
    switchOp,
  };
}

const startIntent = (): AppStartIntent => ({
  type: INTENT_APP_START,
  payload: {} as AppStartIntent["payload"],
});
const shutdownIntent = (): AppShutdownIntent => ({
  type: INTENT_APP_SHUTDOWN,
  payload: {} as AppShutdownIntent["payload"],
});
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const tick = async (): Promise<void> => {
  await advance(DEFAULT_INTERVAL_MS);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoWorkspaceModule Integration", () => {
  it("creates a workspace for a new item on the first tick", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, state, openProjectOp, openWorkspaceOp, setMetaOp } = createSetup({
      sources: sourceYaml(),
    });
    cmd.items = [{ id: "1" }];

    await dispatcher.dispatch(startIntent());

    expect(openProjectOp.dispatched).toHaveLength(1);
    expect(openProjectOp.dispatched[0]!.payload.git).toBe("https://github.com/org/repo.git");
    expect(openWorkspaceOp.dispatched).toHaveLength(1);
    expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("ws-1");
    expect(openWorkspaceOp.dispatched[0]!.payload.agent).toEqual({
      type: "default",
      prompt: "Work on 1",
    });
    expect(
      setMetaOp.dispatched.some((d) => d.payload.key === "source" && d.payload.value === "gh")
    ).toBe(true);
    expect(entriesOf(state)).toHaveProperty("gh/1");
  });

  it("does nothing when no sources are configured", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, openWorkspaceOp } = createSetup({ sources: null });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(openWorkspaceOp.dispatched).toHaveLength(0);
  });

  it("dedups an already-tracked item across ticks", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(openWorkspaceOp.dispatched).toHaveLength(1);

    await tick(); // same item present again
    expect(openWorkspaceOp.dispatched).toHaveLength(1);
  });

  it("forgets an entry when its item disappears, and recreates on reappearance", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, state, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(entriesOf(state)).toHaveProperty("gh/1");

    cmd.items = []; // item gone
    await tick();
    expect(entriesOf(state)).not.toHaveProperty("gh/1");

    cmd.items = [{ id: "1" }]; // item back
    await tick();
    expect(entriesOf(state)).toHaveProperty("gh/1");
    expect(openWorkspaceOp.dispatched).toHaveLength(2);
  });

  it("does not write an entry when creation fails, and retries next tick", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, state, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
    openWorkspaceOp.failFor.add("ws-1");
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(entriesOf(state)).not.toHaveProperty("gh/1");
    expect(openWorkspaceOp.dispatched).toHaveLength(1);

    openWorkspaceOp.failFor.clear(); // failure resolves
    await tick();
    expect(entriesOf(state)).toHaveProperty("gh/1");
    expect(openWorkspaceOp.dispatched).toHaveLength(2);
  });

  it("skips a tick when the cmd exits non-zero, staying active", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, state, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
    cmd.items = [{ id: "1" }];
    cmd.exitCode = 1;
    await dispatcher.dispatch(startIntent());
    expect(openWorkspaceOp.dispatched).toHaveLength(0);

    cmd.exitCode = 0; // cmd recovers
    await tick();
    expect(entriesOf(state)).toHaveProperty("gh/1");
  });

  it("keeps a failing cmd's stderr out of the warn line", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, logger } = createSetup({ sources: sourceYaml() });
    cmd.items = [{ id: "1" }];
    cmd.exitCode = 1;
    cmd.stderr = "401 Unauthorized: token perm-SECRET is expired";

    await dispatcher.dispatch(startIntent());

    // This line is emitted at the DEFAULT log level, so a cmd that echoes its
    // own credentials on failure would leak them to every bug report without
    // anyone enabling debug logging.
    const warned = logger.getMessagesByLevel("warn");
    const text = warned.map((m) => `${m.message} ${JSON.stringify(m.context ?? {})}`).join("\n");
    expect(text).toContain("Source cmd failed");
    expect(text).not.toContain("perm-SECRET");
    expect(text).toContain("46 bytes of stderr");
  });

  it("picks up a newly added source without a restart (each cycle re-reads config)", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, mockConfig, openWorkspaceOp } = createSetup({ sources: null });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(openWorkspaceOp.dispatched).toHaveLength(0);

    await mockConfig.set("auto-workspace.sources", sourceYaml()); // user edits settings
    await tick();
    expect(openWorkspaceOp.dispatched).toHaveLength(1);
  });

  it("forgets entries for a source removed from config (orphan cleanup)", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, state, mockConfig } = createSetup({ sources: sourceYaml("gh") });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    expect(entriesOf(state)).toHaveProperty("gh/1");

    cmd.items = [];
    await mockConfig.set("auto-workspace.sources", sourceYaml("other")); // gh removed
    await tick();
    expect(entriesOf(state)).not.toHaveProperty("gh/1");
  });

  it("contains a failing project open to its own item, finishing the cycle", async () => {
    vi.useFakeTimers();
    const broken = "https://github.com/org/broken.git";
    const { dispatcher, cmd, state, openProjectOp, openWorkspaceOp } = createSetup({
      sources: `name: bad
cmd: fetch
template:
  name: "bad-{{ id }}"
  key: "{{ id }}"
  git: "${broken}"
---
${sourceYaml("good")}`,
    });
    openProjectOp.failFor.add(broken);
    cmd.items = [{ id: "1" }];

    await dispatcher.dispatch(startIntent());

    // The later source still ran: one bad item must not abandon the cycle.
    expect(openWorkspaceOp.dispatched).toHaveLength(1);
    expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("ws-1");
    expect(entriesOf(state)).not.toHaveProperty("bad/1"); // unrecorded → retried next tick
    expect(entriesOf(state)).toHaveProperty("good/1");
  });

  describe("poll interval", () => {
    it("honors a configured interval instead of the 60s default", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, openWorkspaceOp } = createSetup({
        sources: sourceYaml(),
        configDefaults: { "auto-workspace.poll-interval": 10 },
      });
      cmd.items = [{ id: "1" }];
      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      cmd.items = [{ id: "1" }, { id: "2" }];
      await advance(9_000);
      expect(openWorkspaceOp.dispatched).toHaveLength(1); // not due yet
      await advance(1_000);
      expect(openWorkspaceOp.dispatched).toHaveLength(2);
    });

    it("picks up a changed interval on the next cycle (applies: live)", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, mockConfig, openWorkspaceOp } = createSetup({
        sources: sourceYaml(),
      });
      cmd.items = [{ id: "1" }];
      await dispatcher.dispatch(startIntent());

      // User edits the setting; the current 60s wait still has to elapse.
      await mockConfig.set("auto-workspace.poll-interval", 10);
      cmd.items = [{ id: "1" }, { id: "2" }];
      await advance(10_000);
      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      await tick();
      expect(openWorkspaceOp.dispatched).toHaveLength(2);

      // From here on the new value paces the loop.
      cmd.items = [{ id: "1" }, { id: "2" }, { id: "3" }];
      await advance(10_000);
      expect(openWorkspaceOp.dispatched).toHaveLength(3);
    });

    it("waits a full interval after a slow cycle ends, without stacking polls", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
      cmd.items = [{ id: "1" }];
      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      let release = (): void => {};
      openWorkspaceOp.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      cmd.items = [{ id: "1" }, { id: "2" }];
      await tick(); // cycle 2 starts and blocks mid-creation
      expect(openWorkspaceOp.dispatched).toHaveLength(2);

      cmd.items = [{ id: "1" }, { id: "2" }, { id: "3" }];
      await tick();
      await tick();
      expect(openWorkspaceOp.dispatched).toHaveLength(2); // no cycle stacked up behind it

      openWorkspaceOp.gate = null;
      release();
      await advance(0); // cycle 2 settles; only now is the next wait armed

      await advance(DEFAULT_INTERVAL_MS - 1);
      expect(openWorkspaceOp.dispatched).toHaveLength(2);
      await advance(1);
      expect(openWorkspaceOp.dispatched).toHaveLength(3);
    });
  });

  it("stops polling on shutdown", async () => {
    vi.useFakeTimers();
    const { dispatcher, cmd, openWorkspaceOp } = createSetup({ sources: sourceYaml() });
    cmd.items = [{ id: "1" }];
    await dispatcher.dispatch(startIntent());
    await dispatcher.dispatch(shutdownIntent());

    cmd.items = [{ id: "2" }];
    await tick();
    // No further work after shutdown: only the original item was created.
    expect(openWorkspaceOp.dispatched).toHaveLength(1);
  });

  describe("mode: events", () => {
    it("creates a workspace when nothing matches the rendered name", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, state, openWorkspaceOp, setMetaOp, wakeOp } = createSetup({
        sources: eventsYaml(),
      });
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("ws-1");
      expect(openWorkspaceOp.dispatched[0]!.payload.agent).toEqual({
        type: "default",
        prompt: "Work on 1",
      });
      expect(wakeOp.dispatched).toHaveLength(0);
      expect(
        setMetaOp.dispatched.some((d) => d.payload.key === "title" && d.payload.value === "Event 1")
      ).toBe(true);
      // An events source is defined as writing nothing.
      expect(entriesOf(state)).toEqual({});
    });

    it("wakes a hibernated match and re-applies metadata instead of creating", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, listProjectsOp, openWorkspaceOp, setMetaOp, wakeOp } = createSetup({
        sources: eventsYaml(),
      });
      listProjectsOp.workspaces.push(workspaceNamed("ws-1", { [HIBERNATED_METADATA_KEY]: "true" }));
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(wakeOp.dispatched).toHaveLength(1);
      expect(wakeOp.dispatched[0]!.payload.workspacePath).toBe(workspacePathOf("ws-1"));
      expect(wakeOp.dispatched[0]!.payload.stealFocus).toBe(false);
      // The metadata is the whole signal — no prompt reaches an existing agent.
      expect(
        setMetaOp.dispatched.some((d) => d.payload.key === "title" && d.payload.value === "Event 1")
      ).toBe(true);
      expect(
        setMetaOp.dispatched.some((d) => d.payload.key === "source" && d.payload.value === "gh")
      ).toBe(true);
    });

    it("only refreshes metadata when the match is awake", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, listProjectsOp, openWorkspaceOp, setMetaOp, wakeOp, switchOp } =
        createSetup({ sources: eventsYaml() });
      listProjectsOp.workspaces.push(workspaceNamed("ws-1"));
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(wakeOp.dispatched).toHaveLength(0);
      expect(switchOp.dispatched).toHaveLength(0); // focus defaults to false
      expect(setMetaOp.dispatched.map((d) => d.payload.key)).toContain("title");
    });

    it("switches to an awake match when the template asks for focus", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, listProjectsOp, switchOp } = createSetup({
        sources: eventsYaml({ focus: true }),
      });
      listProjectsOp.workspaces.push(workspaceNamed("ws-1"));
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(switchOp.dispatched).toHaveLength(1);
      expect(switchOp.dispatched[0]!.payload).toEqual({
        workspacePath: workspacePathOf("ws-1"),
        focus: true,
      });
    });

    it("skips an event whose workspace is mid-teardown", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, listProjectsOp, resolveWsOp, openWorkspaceOp, setMetaOp, wakeOp } =
        createSetup({ sources: eventsYaml() });
      listProjectsOp.workspaces.push(workspaceNamed("ws-1", { [HIBERNATED_METADATA_KEY]: "true" }));
      resolveWsOp.closing = "delete";
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(0);
      expect(wakeOp.dispatched).toHaveLength(0);
      expect(setMetaOp.dispatched).toHaveLength(0);
    });

    it("fires again for a repeated event — the cmd owns dedup", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, listProjectsOp, openWorkspaceOp, wakeOp } = createSetup({
        sources: eventsYaml(),
      });
      cmd.items = [{ id: "1" }];
      await dispatcher.dispatch(startIntent());
      expect(openWorkspaceOp.dispatched).toHaveLength(1);

      // The cmd re-emits it; nothing was tracked, so it is handled again — this
      // time as a match, because the workspace now exists.
      listProjectsOp.workspaces.push(workspaceNamed("ws-1"));
      await tick();
      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(wakeOp.dispatched).toHaveLength(0); // awake match: metadata only
    });

    it("drops an event whose project cannot be opened, without stopping the cycle", async () => {
      vi.useFakeTimers();
      const broken = "https://github.com/org/broken.git";
      const { dispatcher, cmd, state, openProjectOp, openWorkspaceOp } = createSetup({
        sources: `name: ev
mode: events
cmd: fetch
template:
  name: "ev-{{ id }}"
  git: "${broken}"
---
${sourceYaml("good")}`,
      });
      openProjectOp.failFor.add(broken);
      cmd.items = [{ id: "1" }];

      await dispatcher.dispatch(startIntent());

      expect(openWorkspaceOp.dispatched).toHaveLength(1);
      expect(openWorkspaceOp.dispatched[0]!.payload.workspaceName).toBe("ws-1");
      expect(entriesOf(state)).toEqual({ "good/1": expect.anything() }); // nothing from `ev`
    });

    it("forgets entries left behind when a source flips to events mode", async () => {
      vi.useFakeTimers();
      const { dispatcher, cmd, state, mockConfig } = createSetup({ sources: sourceYaml("gh") });
      cmd.items = [{ id: "1" }];
      await dispatcher.dispatch(startIntent());
      expect(entriesOf(state)).toHaveProperty("gh/1");

      await mockConfig.set("auto-workspace.sources", eventsYaml());
      cmd.items = [];
      await tick();
      expect(entriesOf(state)).not.toHaveProperty("gh/1");
    });
  });

  describe("retired experimental.* keys", () => {
    it("leaves them untouched and seeds nothing from them", async () => {
      vi.useFakeTimers();
      const template =
        "---\nname: pr-{{ number }}\ngit: https://github.com/o/r.git\n---\nReview {{ number }}";
      const { dispatcher, cmd, mockConfig, openWorkspaceOp } = createSetup({
        configDefaults: {
          "experimental.github.template": template,
          "experimental.github.query": "is:open is:pr",
        },
      });
      cmd.items = [{ number: 7, html_url: "https://github.com/o/r/pull/7" }];

      await dispatcher.dispatch(startIntent());

      // Still registered (so config.json is not stripped) and still readable,
      // but nothing drains them: sources stays unset and no workspace is created.
      const effective = mockConfig.getEffective();
      expect(effective["experimental.github.template"]).toBe(template);
      expect(effective["auto-workspace.sources"]).toBeNull();
      expect(openWorkspaceOp.dispatched).toHaveLength(0);
    });
  });

  describe("legacy state file import", () => {
    it("imports the legacy auto-workspaces.json into state", async () => {
      vi.useFakeTimers();
      const legacy = JSON.stringify({
        version: 1,
        entries: { "gh/old": { workspaceName: "old", createdAt: "2020-01-01T00:00:00Z" } },
      });
      const { dispatcher, cmd, state, openWorkspaceOp } = createSetup({
        sources: sourceYaml(),
        legacyStateFileContent: legacy,
      });
      cmd.items = [{ id: "old" }]; // item still active → imported entry is preserved (and deduped)
      await dispatcher.dispatch(startIntent());
      expect(entriesOf(state)).toHaveProperty("gh/old");
      expect(openWorkspaceOp.dispatched).toHaveLength(0); // not recreated — tracking survived
    });

    it("forgets an imported legacy entry whose item is no longer active", async () => {
      vi.useFakeTimers();
      const legacy = JSON.stringify({
        entries: { "gh/gone": { workspaceName: "gone", createdAt: "2020-01-01T00:00:00Z" } },
      });
      const { dispatcher, cmd, state } = createSetup({
        sources: sourceYaml(),
        legacyStateFileContent: legacy,
      });
      cmd.items = [];
      await dispatcher.dispatch(startIntent());
      expect(entriesOf(state)).not.toHaveProperty("gh/gone");
    });
  });
});
