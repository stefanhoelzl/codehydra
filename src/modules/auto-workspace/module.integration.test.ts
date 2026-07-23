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
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
  HookContext,
} from "../../intents/lib/operation";
import type { Project, ProjectId } from "../../shared/api/types";
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
import {
  createFileSystemMock,
  file,
  directory,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { createAutoWorkspaceModule } from "./module";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState, type MockStateService } from "../../boundaries/platform/state.test-utils";
import { projPath } from "../../shared/test-fixtures";

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
  async execute(
    ctx: OperationContext<IntentOf<typeof openProjectSchemas>, typeof openProjectSchemas>
  ): Promise<Project> {
    this.dispatched.push(ctx.intent);
    const pathStr = ctx.intent.payload.path?.toString() ?? "/home/user/projects/repo";
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

interface CmdControl {
  items: unknown[];
  exitCode: number;
}

function createSetup(options?: {
  sources?: string | null;
  configDefaults?: Record<string, unknown>;
  legacyStateFileContent?: string;
  existingEntries?: Record<string, StateEntry>;
}) {
  const cmd: CmdControl = { items: [], exitCode: 0 };
  const processRunner = createMockProcessRunner({
    onSpawn: () => ({ exitCode: cmd.exitCode, stdout: JSON.stringify(cmd.items) }),
  });

  const fsEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/data": directory(),
  };
  if (options?.legacyStateFileContent !== undefined) {
    fsEntries["/data/auto-workspaces.json"] = file(options.legacyStateFileContent);
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

  const module = createAutoWorkspaceModule({
    fs,
    logger: SILENT_LOGGER,
    legacyStateFilePath: "/data/auto-workspaces.json",
    dispatcher,
    processRunner,
    configService: mockConfig,
    stateService: state,
  });
  dispatcher.registerModule(module);

  return { dispatcher, fs, state, cmd, mockConfig, openProjectOp, openWorkspaceOp, setMetaOp };
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
