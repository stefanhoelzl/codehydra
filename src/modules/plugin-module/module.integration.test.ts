// @vitest-environment node
/**
 * Integration tests for the plugin module's hooks.
 *
 * Runs against the real OpenWorkspaceOperation and DeleteWorkspaceOperation so
 * the assertions cover the seams that matter: a hook's environment reaching the
 * agent's start and the terminals' config, a setup hook's title and tags folding
 * into `workspace:created`, a refusal stopping the deletion pipeline — and, new
 * with plugins, several plugins composing on one entry.
 *
 * The filesystem and the process runner are behavioural mocks. A test says what
 * a script *does* by keying an outcome on its body: the runner writes each body
 * to a temp file, and the mock reads it back at spawn time. What running a real
 * script takes is the script runner's boundary test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState, type MockStateService } from "../../boundaries/platform/state.test-utils";
import { createBehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { createMockPathProvider } from "../../boundaries/platform/path-provider.test-utils";
import {
  registerTestInfrastructure,
  createTestViewManager,
} from "../../intents/operations.test-utils";
import {
  OpenWorkspaceOperation,
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type CreateHookResult,
  type FinalizeHookResult,
  type FinalizeHookInput,
  type SetupHookInput,
  type SetupHookResult,
  type WorkspaceCreatedEvent,
} from "../../intents/open-workspace";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletionProgressEvent,
} from "../../intents/delete-workspace";
import type { IntentModule } from "../../intents/lib/module";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import type { DomainEvent } from "../../intents/lib/types";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  type SetMetadataIntent,
} from "../../intents/set-metadata";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import type { DialogConfig } from "../../shared/dialog-types";
import type { NotificationConfig } from "../../shared/notification-types";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import { projPath, wsPath, testPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import type { RunningHook } from "../presentation/presentation-module";
import { createPluginModule, type PluginModule } from "./module";
import { z } from "zod/v4";
import { OperationRegistry } from "../../api/registry";
import { defineEntry } from "../../api/types";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import type { Config } from "../../boundaries/platform/config";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
} from "../../intents/vscode-show-message";
import type { Operation, OperationContext, OperationSchemas } from "../../intents/lib/operation";
import type { HookOutputSink } from "./output-sink";

const PROJECT_ROOT = projPath("/project");
const PROJECT_ID = "project-ea0135bc" as ProjectId;
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_URL = "http://127.0.0.1:25448/?folder=/workspaces/feature-x";
const HOME = testPath("/home");
const LOCAL_PLUGINS = new Path(HOME, "plugins");
const WORKSPACE_PLUGINS = new Path(WORKSPACE_PATH, ".codehydra", "plugins");

/** The script the migration writes for a legacy source named `gh`. */
const MIGRATED_SCRIPT = '{\nfetch\n} | ch plugin render "$CH_PLUGIN_DIR/templates/gh.yaml"';

/** What the agent module contributes to the agent terminal's environment. */
const AGENT_ENV = { _CH_WORKSPACE_PATH: WORKSPACE_PATH };

interface ScriptOutcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Never exits on its own — only a kill ends it. */
  readonly hangs?: boolean;
}

interface SetupOptions {
  /** Local plugins: file name (`x.yaml`) → manifest text. */
  readonly local?: Record<string, string>;
  /** The worktree's plugins: file name → manifest text. */
  readonly workspace?: Record<string, string>;
  /** What each script does, keyed by its body (trimmed). */
  readonly outcomes?: Record<string, ScriptOutcome>;
  readonly enabled?: boolean;
  /** Seeds `plugins.state`. */
  readonly pluginsEnabled?: Record<string, boolean>;
  /** Seeds the pre-plugin `hooks.trusted`. */
  readonly legacyTrusted?: Record<string, boolean>;
  /** How the trust dialog answers: an action id plus unchecked plugin names. */
  readonly trustAnswer?: { action: string; unchecked?: string[] };
  /** Seeds the pre-plugin `auto-workspace.sources` setting. */
  readonly legacySources?: string;
  /** Seeds `auto-workspaces` tracking entries. */
  readonly tracking?: Record<string, unknown>;
  /** Old hook files in the worktree's `.codehydra/hooks`. */
  readonly legacyHooks?: readonly string[];
  /** What the editor's notification answers (a button, or null for dismissed). */
  readonly editorAnswer?: string | null;
}

interface TestSetup {
  readonly dispatcher: Dispatcher;
  readonly module: PluginModule;
  readonly fileSystem: ReturnType<typeof createFileSystemMock>;
  readonly stateService: MockStateService;
  readonly createdEvents: WorkspaceCreatedEvent[];
  readonly progress: WorkspaceDeletionProgressEvent[];
  readonly finalizeEnv: Array<Record<string, string>>;
  readonly terminalEnv: Array<Record<string, string>>;
  readonly agentStartEnv: Array<Record<string, string>>;
  readonly notifications: readonly NotificationConfig[];
  readonly dialogs: DialogConfig[];
  readonly sinkLines: Array<{ source: string; line: string }>;
  readonly metadataWrites: Array<{ key: string; value: string | null }>;
  /** Bodies of the scripts run, in order. */
  readonly ran: string[];
  /** Parsed stdin of each script run, in order. */
  readonly stdin: unknown[];
  /** Env of each script run, in order. */
  readonly envs: NodeJS.ProcessEnv[];
  readonly runningHooks: RunningHook[];
  /** Inputs the registry's `log` entry was invoked with, by automations. */
  readonly logged: unknown[];
  readonly config: Config;
  killedCount(): number;
  /** Start the app's automations (and stop them again when the test ends). */
  startApp(): Promise<void>;
  /** The workspace's editor connects. */
  connectEditor(): Promise<void>;
  /** Messages shown in the workspace's editor, in order. */
  readonly editorMessages: VscodeShowMessageIntent["payload"][];
}

function manifestEntries(
  dir: Path,
  manifests: Record<string, string> | undefined
): Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> {
  const entries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {};
  if (manifests === undefined) return entries;
  entries[dir.toString()] = directory();
  for (const [name, text] of Object.entries(manifests)) {
    const path = new Path(dir, name);
    entries[path.dirname.toString()] = directory();
    entries[path.toString()] = file(text);
  }
  return entries;
}

function createTestSetup(options?: SetupOptions): TestSetup {
  const dispatcher = createMockDispatcher();
  const createdEvents: WorkspaceCreatedEvent[] = [];
  const progress: WorkspaceDeletionProgressEvent[] = [];
  const finalizeEnv: Array<Record<string, string>> = [];
  const terminalEnv: Array<Record<string, string>> = [];
  const agentStartEnv: Array<Record<string, string>> = [];
  const cards = createMockNotificationManager();
  cards.register(dispatcher);
  const dialogs: DialogConfig[] = [];
  const sinkLines: Array<{ source: string; line: string }> = [];
  const metadataWrites: Array<{ key: string; value: string | null }> = [];
  const ran: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const runningHooks: RunningHook[] = [];
  const trustAnswer = options?.trustAnswer ?? { action: "remember" };

  const views = createTestViewManager(null);
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: PROJECT_ROOT,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
      branch: "feature-x",
      metadata: { base: "main" },
    }),
    projects: { [PROJECT_ROOT]: { projectId: PROJECT_ID } },
    activeWorkspaceRef: null,
    viewManager: views.viewManager,
  });
  dispatcher.registerOperation(new OpenWorkspaceOperation());
  dispatcher.registerOperation(new DeleteWorkspaceOperation());
  dispatcher.registerOperation(new SetMetadataOperation());

  const fileSystem = createFileSystemMock({
    entries: {
      [PROJECT_ROOT]: directory(),
      [WORKSPACE_PATH]: directory(),
      [HOME.toString()]: directory(),
      ...manifestEntries(LOCAL_PLUGINS, options?.local),
      ...manifestEntries(WORKSPACE_PLUGINS, options?.workspace),
      ...manifestEntries(
        new Path(WORKSPACE_PATH, ".codehydra", "hooks"),
        options?.legacyHooks === undefined
          ? undefined
          : Object.fromEntries(options.legacyHooks.map((name) => [name, "#!/bin/sh\n"]))
      ),
    },
  });

  const editorMessages: VscodeShowMessageIntent["payload"][] = [];
  const showMessageSchemas = {
    type: INTENT_VSCODE_SHOW_MESSAGE,
    payload: z.custom<VscodeShowMessageIntent["payload"]>(),
    result: z.string().nullable(),
  } satisfies OperationSchemas;
  class ShowMessageOp implements Operation<typeof showMessageSchemas> {
    readonly id = "vscode-show-message";
    readonly schemas = showMessageSchemas;
    async execute(
      ctx: OperationContext<VscodeShowMessageIntent, typeof showMessageSchemas>
    ): Promise<string | null> {
      editorMessages.push(ctx.intent.payload);
      return ctx.intent.payload.options === undefined ? null : (options?.editorAnswer ?? null);
    }
  }
  dispatcher.registerOperation(new ShowMessageOp());
  const connected: Array<(workspacePath: string) => void> = [];

  const outcomes = options?.outcomes ?? {};
  const processRunner = createMockProcessRunner({
    onSpawn: (_command, args, _cwd, env) => {
      const scriptFile = new Path(args.at(-1)!);
      const entry = fileSystem.$.entries.get(scriptFile.toString());
      const body = entry?.type === "file" ? String(entry.content).trim() : "";
      ran.push(body);
      envs.push(env ?? {});
      const outcome = outcomes[body];
      if (outcome === undefined) {
        // Loud on purpose: a silent default reads as "ran and said nothing".
        throw new Error(`test ran a script with no declared outcome: ${body}`);
      }
      if (outcome.hangs === true) return { untilKilled: true };
      return {
        exitCode: outcome.exitCode ?? 0,
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
      };
    },
  });

  const sink: HookOutputSink = {
    write: (_workspacePath, source, line) => sinkLines.push({ source, line }),
    opening: () => {},
    closed: () => {},
  };

  const ui = {
    dialog: (config: DialogConfig) => {
      dialogs.push(config);
      const data: Record<string, string> = {};
      for (const section of config.sections) {
        if (section.type === "checkbox") {
          const name = section.id.slice("plugin:".length);
          data[section.id] = trustAnswer.unchecked?.includes(name) ? "false" : "true";
        }
      }
      return {
        id: "dlg-1",
        update: () => {},
        close: () => {},
        onEvent: () => () => {},
        onChange: () => () => {},
        onDismiss: () => () => {},
        nextEvent: async () => ({ dialogId: "dlg-1", actionId: trustAnswer.action, data }),
        closed: Promise.resolve(),
      };
    },
    trackRunningHook: (hook: RunningHook) => {
      runningHooks.push(hook);
      return () => {
        runningHooks.splice(runningHooks.indexOf(hook), 1);
      };
    },
  };

  const openWorkspaceHost: IntentModule = {
    name: "test-open-workspace-host",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<HookOutput<CreateHookResult>> => {
            const existing = (ctx.intent as OpenWorkspaceIntent).payload.existingWorkspace;
            return {
              result: {
                workspacePath: WORKSPACE_PATH,
                branch: existing ? existing.branch : "feature-x",
                metadata: existing?.metadata ?? { base: "main" },
                resolvedBase: "main",
              },
            };
          },
        },
        setup: {
          handler: async (ctx: HookContext): Promise<HookOutput<SetupHookResult>> => {
            agentStartEnv.push({ ...(ctx as SetupHookInput).workspaceEnv });
            return { result: { envVars: AGENT_ENV, agentType: "opencode" } };
          },
        },
        finalize: {
          handler: async (ctx: HookContext): Promise<HookOutput<FinalizeHookResult>> => {
            finalizeEnv.push({ ...(ctx as FinalizeHookInput).envVars });
            terminalEnv.push({ ...(ctx as FinalizeHookInput).workspaceEnv });
            return { result: { workspaceUrl: WORKSPACE_URL } };
          },
        },
      },
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: { handler: async (): Promise<void> => {} },
      },
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<void> => {
            const { payload } = ctx.intent as SetMetadataIntent;
            metadataWrites.push({ key: payload.key, value: payload.value });
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          createdEvents.push(event as WorkspaceCreatedEvent);
        },
      },
      [EVENT_WORKSPACE_DELETION_PROGRESS]: {
        handler: async (event: DomainEvent): Promise<void> => {
          progress.push(event as WorkspaceDeletionProgressEvent);
        },
      },
    },
  };
  dispatcher.registerModule(openWorkspaceHost);

  const stateService = createMockState({
    values: {
      "plugins.state": options?.pluginsEnabled ?? {},
      "hooks.trusted": options?.legacyTrusted ?? {},
      ...(options?.tracking !== undefined && { "auto-workspaces": options.tracking }),
    },
  });
  const logged: unknown[] = [];
  const registry = new OperationRegistry([
    // The fields an automation's create item takes here; the real ones are
    // workspace.create's (items.integration.test.ts).
    defineEntry({
      name: "workspace.create",
      kind: "command",
      description: "test create",
      input: z.object({
        project: z.string().optional(),
        name: z.string(),
        stealFocus: z.boolean().optional().default(false),
      }),
      requiresWorkspace: false,
      handler: async () => undefined,
    }),
    defineEntry({
      name: "log",
      kind: "command",
      description: "test log",
      input: z.object({ message: z.string() }).strict(),
      requiresWorkspace: false,
      handler: async (_ctx, input) => {
        logged.push(input);
      },
    }),
  ]);
  const config = createMockConfig({
    defaults: {
      "plugins.enabled": options?.enabled ?? true,
      "paths.bash": null,
      ...(options?.legacySources !== undefined && {
        "auto-workspace.sources": options.legacySources,
      }),
    },
  });
  const module = createPluginModule({
    fileSystem,
    processRunner,
    logger: createBehavioralLogger(),
    config,
    stateService,
    dispatcher,
    ui,
    pathProvider: createMockPathProvider({ homeRootDir: HOME }),
    binDir: new Path(testPath("/data/bin")),
    sink,
    workspaceConnected: (listener) => {
      connected.push(listener);
      return () => {};
    },
    registry: () => registry,
    platform: "linux",
    env: { PATH: "/usr/bin" },
  });
  dispatcher.registerModule(module);

  return {
    dispatcher,
    module,
    fileSystem,
    stateService,
    createdEvents,
    progress,
    finalizeEnv,
    terminalEnv,
    agentStartEnv,
    get notifications() {
      return cards.notifications.map((card) => card.opened);
    },
    dialogs,
    sinkLines,
    metadataWrites,
    ran,
    get stdin() {
      return Array.from({ length: processRunner.$.spawnedCount }, (_, i) =>
        JSON.parse(processRunner.$.spawned(i).$.input ?? "null")
      );
    },
    envs,
    runningHooks,
    logged,
    config,
    startApp: async () => {
      await module.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} });
      stoppers.push(() =>
        module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({
          intent: { type: "app:shutdown", payload: {} },
        })
      );
    },
    editorMessages,
    connectEditor: async () => {
      for (const listener of connected) listener(WORKSPACE_PATH);
      await settle();
    },
    killedCount: () =>
      Array.from({ length: processRunner.$.spawnedCount }, (_, i) =>
        processRunner.$.spawned(i)
      ).filter((proc) => proc.$.killCalls.length > 0).length,
  };
}

/** A manifest with one document holding these hooks. */
function hooksManifest(hooks: Record<string, string>, extra = ""): string {
  const lines = Object.entries(hooks).map(
    ([entry, script]) => `  ${entry}: ${JSON.stringify(script)}`
  );
  return `${extra}hooks:\n${lines.join("\n")}\n`;
}

async function openWorkspace(setup: TestSetup): Promise<void> {
  await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
    type: INTENT_OPEN_WORKSPACE,
    payload: { workspaceName: "feature-x", projectPath: PROJECT_ROOT },
  });
}

async function reopenWorkspace(setup: TestSetup): Promise<void> {
  await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
    type: INTENT_OPEN_WORKSPACE,
    payload: {
      workspaceName: "feature-x",
      projectPath: PROJECT_ROOT,
      existingWorkspace: {
        path: WORKSPACE_PATH,
        name: "feature-x",
        branch: "feature-x",
        metadata: { base: "main" },
      },
    },
  });
}

async function deleteWorkspace(setup: TestSetup, force = false): Promise<void> {
  await setup.dispatcher.dispatch<DeleteWorkspaceIntent>({
    type: INTENT_DELETE_WORKSPACE,
    payload: { workspacePath: WORKSPACE_PATH, keepBranch: false, removeWorktree: true, force },
  });
}

function rowOf(setup: TestSetup): { status: string; error?: string | undefined } | undefined {
  const last = setup.progress.at(-1);
  return last?.payload.operations.find((op) => op.id === "repo-hook");
}

async function untilHookRunning(setup: TestSetup): Promise<RunningHook> {
  for (let i = 0; i < 50 && setup.runningHooks.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const hook = setup.runningHooks[0];
  if (!hook) throw new Error("no hook was offered for cancel");
  return hook;
}

/** Lets fire-and-forget event subscribers finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// The plugin's own env is under test here. With the variable already in the
// app's environment the operation adds none of its defaults.
beforeEach(() => {
  vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
});

/** Stops polling started by a test's startApp(). */
const stoppers: Array<() => unknown> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const stop of stoppers.splice(0)) await stop();
});

// =============================================================================

describe("no plugins", () => {
  it("opens and deletes a workspace without running anything", async () => {
    const setup = createTestSetup();
    await openWorkspace(setup);
    await deleteWorkspace(setup);

    expect(setup.ran).toEqual([]);
    expect(setup.createdEvents).toHaveLength(1);
    expect(rowOf(setup)).toBeUndefined();
  });
});

describe("after-worktree-created", () => {
  it("hands a local plugin's script its workspace, with the plugin dirs in its env", async () => {
    const setup = createTestSetup({
      local: { "setup/plugin.yaml": hooksManifest({ "after-worktree-created": "echo setup" }) },
      outcomes: { "echo setup": {} },
    });
    await openWorkspace(setup);

    expect(setup.stdin[0]).toEqual({
      workspaceName: "feature-x",
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_ROOT,
      branch: "feature-x",
      base: "main",
    });
    expect(new Path(setup.envs[0]!.CH_PLUGIN_DIR!).equals(new Path(LOCAL_PLUGINS, "setup"))).toBe(
      true
    );
    expect(new Path(setup.envs[0]!.CH_WORKSPACE_DIR!).equals(new Path(WORKSPACE_PATH))).toBe(true);
  });

  it("merges titles and tags across plugins, later plugins winning", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      workspace: { "b.yaml": hooksManifest({ "after-worktree-created": "echo b" }) },
      pluginsEnabled: { [`workspace:${PROJECT_ROOT}:b`]: true },
      outcomes: {
        "echo a": {
          stdout: JSON.stringify({ title: "From A", tags: { a: {}, both: { label: "a" } } }),
        },
        "echo b": { stdout: JSON.stringify({ title: "From B", tags: { both: { label: "b" } } }) },
      },
    });
    await openWorkspace(setup);

    // Local plugins run before the workspace's.
    expect(setup.ran).toEqual(["echo a", "echo b"]);
    const metadata = setup.createdEvents[0]!.payload.metadata;
    expect(metadata["title"]).toBe("From B");
    expect(metadata["tags.a"]).toBe("{}");
    expect(metadata["tags.both"]).toBe(JSON.stringify({ label: "b" }));
  });

  it("still opens the workspace when a plugin fails, runs the next one, and says so", async () => {
    const setup = createTestSetup({
      local: {
        "a.yaml": hooksManifest({ "after-worktree-created": "exit 3" }),
        "b.yaml": hooksManifest({ "after-worktree-created": "echo b" }),
      },
      outcomes: {
        "exit 3": { exitCode: 3, stderr: "token=secret boom" },
        "echo b": { stdout: JSON.stringify({ title: "B" }) },
      },
    });
    await openWorkspace(setup);

    expect(setup.createdEvents).toHaveLength(1);
    expect(setup.createdEvents[0]!.payload.metadata["title"]).toBe("B");
    const card = setup.notifications.find((n) => n.title === "Plugin failed");
    expect(card?.message).toMatch(/local:a after-worktree-created: exit 3 — log: /);
    // What the script printed stays in its log, never in the card.
    expect(card?.message).not.toContain("secret");

    const [error] = setup.module.api.errors();
    expect(error).toMatchObject({ plugin: "local:a", entry: "after-worktree-created" });
    const log = await setup.fileSystem.readFile(new Path(error!.logPath!));
    expect(log).toContain("token=secret boom");
  });

  it("rejects output that is not the declared shape", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": { stdout: JSON.stringify({ titel: "typo" }) } },
    });
    await openWorkspace(setup);

    expect(setup.metadataWrites).toEqual([]);
    expect(setup.module.api.errors()[0]?.message).toMatch(/does not match its contract/);
  });

  it("does not run for a re-opened workspace", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": {} },
    });
    await reopenWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });

  it("shows the script's output in the workspace, tagged with its plugin", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": { stderr: "installing\n" } },
    });
    await openWorkspace(setup);

    expect(setup.sinkLines).toEqual([
      { source: "local:a after-worktree-created stderr", line: "installing" },
    ]);
  });
});

describe("before-workspace-opened", () => {
  it("runs on every open and merges env across plugins, minus CodeHydra's own", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "before-workspace-opened": "echo a" }) },
      workspace: { "b.yaml": hooksManifest({ "before-workspace-opened": "echo b" }) },
      pluginsEnabled: { [`workspace:${PROJECT_ROOT}:b`]: true },
      outcomes: {
        "echo a": { stdout: JSON.stringify({ env: { A: "1", SHARED: "a" } }) },
        "echo b": { stdout: JSON.stringify({ env: { SHARED: "b", _CH_X: "no" } }) },
      },
    });
    await reopenWorkspace(setup);

    expect(setup.stdin[0]).toMatchObject({ reopened: true });
    expect(setup.agentStartEnv[0]).toMatchObject({ A: "1", SHARED: "b" });
    expect(setup.agentStartEnv[0]).not.toHaveProperty("_CH_X");
    expect(setup.terminalEnv[0]).toMatchObject({ A: "1", SHARED: "b" });
  });
});

describe("before-worktree-deleted", () => {
  it("stops at the first refusal and shows its reason on the row", async () => {
    const setup = createTestSetup({
      local: {
        "a.yaml": hooksManifest({ "before-worktree-deleted": "echo a" }),
        "b.yaml": hooksManifest({ "before-worktree-deleted": "echo b" }),
      },
      outcomes: {
        "echo a": { stdout: JSON.stringify({ blocked: true, reason: "unpushed work" }) },
        "echo b": {},
      },
    });
    await deleteWorkspace(setup);

    expect(setup.ran).toEqual(["echo a"]);
    expect(rowOf(setup)).toMatchObject({ status: "error", error: "unpushed work" });
    // The worktree removal never ran.
    const last = setup.progress.at(-1)!.payload;
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });

  it("fails closed when a gate breaks", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "before-worktree-deleted": "exit 1" }) },
      outcomes: { "exit 1": { exitCode: 1 } },
    });
    await deleteWorkspace(setup);

    expect(rowOf(setup)?.status).toBe("error");
    const last = setup.progress.at(-1)!.payload;
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });

  it("is skipped in force mode", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "before-worktree-deleted": "echo a" }) },
      outcomes: { "echo a": { stdout: JSON.stringify({ blocked: true }) } },
    });
    await deleteWorkspace(setup, true);

    expect(setup.ran).toEqual([]);
  });
});

describe("on-workspace-opened", () => {
  it("fires without blocking the open, ignoring its stdout", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "on-workspace-opened": "echo a" }) },
      outcomes: { "echo a": { stdout: "not json at all" } },
    });
    await openWorkspace(setup);
    await settle();

    expect(setup.ran).toEqual(["echo a"]);
    expect(setup.module.api.errors()).toEqual([]);
  });
});

describe("cancel", () => {
  it("kills a canceled open hook and opens the workspace without it", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "sleep" }) },
      outcomes: { sleep: { hangs: true } },
    });
    const opening = openWorkspace(setup);
    const hook = await untilHookRunning(setup);
    expect(hook.entry).toBe("after-worktree-created (local:a)");
    hook.cancel();
    await opening;

    expect(setup.killedCount()).toBe(1);
    expect(setup.createdEvents).toHaveLength(1);
    expect(setup.module.api.errors()[0]?.message).toBe("canceled");
  });
});

describe("shutdown", () => {
  it("cancels a hook still running when the app quits, and raises nothing", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "sleep" }) },
      outcomes: { sleep: { hangs: true } },
    });
    const opening = openWorkspace(setup);
    await untilHookRunning(setup);

    await setup.module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({
      intent: { type: "app:shutdown", payload: {} },
    });
    await opening;

    expect(setup.killedCount()).toBe(1);
    expect(setup.notifications.filter((n) => n.title === "Plugin failed")).toEqual([]);
  });

  it("starts no hook once the app is quitting", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": {} },
    });

    await setup.module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({
      intent: { type: "app:shutdown", payload: {} },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });
});

describe("documents and platforms", () => {
  it("runs every document that applies, in order, and skips the others", async () => {
    const setup = createTestSetup({
      local: {
        "a.yaml": [
          hooksManifest({ "after-worktree-created": "echo one" }),
          "---",
          hooksManifest(
            { "after-worktree-created": "echo win" },
            "platform: windows\nshell: cmd\n"
          ),
          "---",
          hooksManifest({ "after-worktree-created": "echo two" }, "platform: [linux, macos]\n"),
        ].join("\n"),
      },
      outcomes: { "echo one": {}, "echo two": {} },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual(["echo one", "echo two"]);
  });

  it("skips a plugin whose manifest is invalid, says why once, and runs the rest", async () => {
    const setup = createTestSetup({
      local: {
        "broken.yaml": "hooks:\n  after-worktree-craeted: echo x\n",
        "ok.yaml": hooksManifest({ "after-worktree-created": "echo ok" }),
      },
      outcomes: { "echo ok": {} },
    });
    await openWorkspace(setup);
    await reopenWorkspace(setup);

    expect(setup.ran).toEqual(["echo ok"]);
    const cards = setup.notifications.filter((n) => n.title === "Plugin cannot run");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.message).toMatch(
      /local:broken: document 1: hooks: unknown key after-worktree-craeted/
    );
  });
});

describe("trust", () => {
  it("asks once for every workspace plugin, all checked, and remembers the answer", async () => {
    const setup = createTestSetup({
      workspace: {
        "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }),
        "b.yaml": hooksManifest({ "after-worktree-created": "echo b" }),
      },
      outcomes: { "echo a": {}, "echo b": {} },
      trustAnswer: { action: "remember", unchecked: ["b"] },
    });
    await openWorkspace(setup);

    expect(setup.dialogs).toHaveLength(1);
    const boxes = setup.dialogs[0]!.sections.filter((section) => section.type === "checkbox");
    expect(boxes.map((box) => (box.type === "checkbox" ? [box.label, box.value] : null))).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(setup.ran).toEqual(["echo a"]);
    expect(setup.stateService.getEffective()["plugins.state"]).toEqual({
      [`workspace:${new Path(PROJECT_ROOT).toString()}:a`]: true,
      [`workspace:${new Path(PROJECT_ROOT).toString()}:b`]: false,
    });

    await reopenWorkspace(setup);
    expect(setup.dialogs).toHaveLength(1);
  });

  it("runs the checked plugins just this time, storing nothing", async () => {
    const setup = createTestSetup({
      workspace: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": {} },
      trustAnswer: { action: "once" },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual(["echo a"]);
    expect(setup.stateService.getEffective()["plugins.state"]).toEqual({});
  });

  it("takes a project's answer from before plugins for its workspace plugins", async () => {
    const setup = createTestSetup({
      workspace: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      outcomes: { "echo a": {} },
      legacyTrusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.dialogs).toEqual([]);
    expect(setup.ran).toEqual(["echo a"]);
  });

  it("never runs a disabled local plugin", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      pluginsEnabled: { "local:a": false },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });

  it("carries answers over to a project whose path moved", async () => {
    const moved = projPath("/moved");
    const setup = createTestSetup({
      pluginsEnabled: { [`workspace:${new Path(PROJECT_ROOT).toString()}:a`]: true },
    });
    await setup.module.moveProjects([{ from: PROJECT_ROOT, to: moved }]);

    expect(setup.stateService.getEffective()["plugins.state"]).toEqual({
      [`workspace:${new Path(moved).toString()}:a`]: true,
    });
  });
});

describe("kill switch", () => {
  it("runs no hooks when plugins.enabled is false", async () => {
    const setup = createTestSetup({
      enabled: false,
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });

  it("runs no automations either", async () => {
    const setup = createTestSetup({
      enabled: false,
      local: {
        "notes.yaml": "automations:\n  a: list\n",
      },
      outcomes: { list: { stdout: "[]" } },
    });

    await setup.startApp();

    expect(setup.ran).toEqual([]);
  });
});

describe("ch plugin", () => {
  const scope = { workspacePath: WORKSPACE_PATH, projectPath: PROJECT_ROOT };

  it("lists local and workspace plugins with their state and platforms", async () => {
    const setup = createTestSetup({
      local: { "a/plugin.yaml": "platform: [linux, macos]\nhooks: {}\n" },
      workspace: { "b.yaml": "hooks: {}\n" },
    });

    const list = await setup.module.api.list(scope);

    expect(list.map((p) => [p.id, p.state, p.platforms])).toEqual([
      ["local:a", "enabled", ["linux", "macos"]],
      ["workspace:b", "ask", ["linux", "windows", "macos"]],
    ]);
    expect(new Path(list[0]!.path).equals(new Path(LOCAL_PLUGINS, "a"))).toBe(true);
  });

  it("disables and re-enables a plugin", async () => {
    const setup = createTestSetup({ workspace: { "b.yaml": "hooks: {}\n" } });

    await setup.module.api.setState(scope, "workspace:b", "enabled");
    expect((await setup.module.api.list(scope))[0]?.state).toBe("enabled");
    await setup.module.api.setState(scope, "workspace:b", "disabled");
    expect((await setup.module.api.list(scope))[0]?.state).toBe("disabled");
  });

  it("refuses a plugin that does not exist", async () => {
    const setup = createTestSetup();

    await expect(setup.module.api.setState(scope, "local:nope", "enabled")).rejects.toThrow(
      /No plugin local:nope/
    );
  });

  it("renders items through a template file, leaving empty fields out", async () => {
    const setup = createTestSetup({
      local: { "tpl.yaml": 'action: workspace.create\nname: "pr-{{ n }}"\nprompt: "{{ body }}"\n' },
    });

    const rendered = await setup.module.api.render(
      new Path(LOCAL_PLUGINS, "tpl.yaml").toNative(),
      JSON.stringify([{ n: 1, body: "Review" }, { n: 2 }])
    );

    expect(rendered).toEqual([
      { action: "workspace.create", name: "pr-1", prompt: "Review" },
      { action: "workspace.create", name: "pr-2" },
    ]);
  });

  it("refuses to render anything but a JSON array, so a failed command is not an empty list", async () => {
    const setup = createTestSetup({ local: { "tpl.yaml": "name: x\n" } });
    const template = new Path(LOCAL_PLUGINS, "tpl.yaml").toNative();

    await expect(setup.module.api.render(template, "")).rejects.toThrow(/not JSON/);
    await expect(setup.module.api.render(template, '{"a":1}')).rejects.toThrow(/JSON array/);
  });

  it("describes the items an automation prints as JSON Schema", () => {
    const schema = createTestSetup().module.api.schema("items");

    expect(schema).toMatchObject({ type: "array" });
  });

  it("describes the manifest as JSON Schema", () => {
    const schema = createTestSetup().module.api.schema("manifest");

    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(schema["properties"] as object)).toEqual(
      expect.arrayContaining(["shell", "platform", "hooks", "automations"])
    );
  });
});

describe("automations", () => {
  it("runs an automation's action once per item its script prints", async () => {
    const setup = createTestSetup({
      local: {
        "notes/plugin.yaml": ["automations:", "  hello: list-notes"].join("\n"),
      },
      outcomes: {
        "list-notes": {
          stdout: JSON.stringify([
            { action: "log", message: "note 1" },
            { action: "log", message: "note 2" },
          ]),
        },
      },
    });

    await setup.startApp();

    expect(setup.logged).toEqual([{ message: "note 1" }, { message: "note 2" }]);
    // Run from the plugin's own directory, with ch on PATH.
    expect(new Path(setup.envs[0]!.CH_PLUGIN_DIR!).equals(new Path(LOCAL_PLUGINS, "notes"))).toBe(
      true
    );
  });

  it("reports a script that does not print an array, pointing at its log", async () => {
    const setup = createTestSetup({
      local: {
        "notes.yaml": ["automations:", "  hello: list-notes"].join("\n"),
      },
      outcomes: { "list-notes": { stdout: '{"not":"an array"}' } },
    });

    await setup.startApp();

    expect(setup.module.api.errors()).toMatchObject([
      {
        plugin: "local:notes",
        entry: "automations.hello",
        message: "printed JSON that is not an array",
      },
    ]);
    expect(setup.module.api.errors()[0]?.logPath).toBeDefined();
  });

  it("ignores a repository plugin's automations", async () => {
    const setup = createTestSetup({
      workspace: {
        "repo.yaml": "automations:\n  a: x\n",
      },
    });

    await setup.startApp();

    expect(setup.ran).toEqual([]);
  });

  it("moves the pre-plugin sources setting into a plugin, tracking entries included", async () => {
    const setup = createTestSetup({
      legacySources:
        'name: gh\ncmd: fetch\ntemplate:\n  name: "ws-{{ id }}"\n  key: "{{ id }}"\n  git: "https://x/y.git"',
      tracking: { "gh/1": { workspaceName: "ws-1", createdAt: "2026-01-01T00:00:00.000Z" } },
      outcomes: {
        // What `ch plugin render` would print for the item the cmd emitted.
        [MIGRATED_SCRIPT]: {
          stdout: JSON.stringify([
            { action: "workspace.create", name: "ws-1", key: "1", project: "https://x/y.git" },
          ]),
        },
      },
    });

    await setup.startApp();

    const manifest = await setup.fileSystem.readFile(
      new Path(LOCAL_PLUGINS, "auto-workspaces", "plugin.yaml")
    );
    expect(manifest).toContain("ch plugin render");
    expect(
      await setup.fileSystem.readFile(
        new Path(LOCAL_PLUGINS, "auto-workspaces", "templates", "gh.yaml")
      )
    ).toContain("action: workspace.create");
    expect(Object.keys(setup.stateService.getEffective()["auto-workspaces"] as object)).toEqual([
      "auto-workspaces/gh/1",
    ]);
    // The migrated automation ran, and found its item already handled.
    expect(setup.ran).toEqual([MIGRATED_SCRIPT]);
    // The setting is cleared, so the move happens once.
    expect(setup.config.getEffective()).not.toHaveProperty("auto-workspace.sources");
    expect(setup.notifications.map((n) => n.title)).toContain(
      "Auto-workspace sources are now a plugin"
    );
  });
});

describe("repository hooks from before plugins", () => {
  it("never runs them", async () => {
    const setup = createTestSetup({ legacyHooks: ["after-worktree-created"] });
    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });

  it("offers to migrate them in the editor, and writes the plugin on Migrate", async () => {
    const setup = createTestSetup({
      legacyHooks: ["after-worktree-created", "on-workspace-opened.win.cmd"],
      editorAnswer: "Migrate",
    });

    await setup.connectEditor();

    expect(setup.editorMessages[0]).toMatchObject({ type: "warning", options: ["Migrate"] });
    expect(setup.editorMessages[0]!.message).toContain(
      "after-worktree-created, on-workspace-opened.win.cmd"
    );
    const manifest = await setup.fileSystem.readFile(new Path(WORKSPACE_PLUGINS, "hooks.yaml"));
    expect(manifest).toContain("$CH_WORKSPACE_DIR/.codehydra/hooks/after-worktree-created");
    expect(setup.editorMessages[1]?.message).toMatch(/Wrote \.codehydra\/plugins\/hooks\.yaml/);
  });

  it("writes nothing when the offer is dismissed", async () => {
    const setup = createTestSetup({ legacyHooks: ["after-worktree-created"], editorAnswer: null });

    await setup.connectEditor();

    expect(setup.editorMessages).toHaveLength(1);
    await expect(
      setup.fileSystem.readFile(new Path(WORKSPACE_PLUGINS, "hooks.yaml"))
    ).rejects.toThrow();
  });

  it("stays quiet once the repository has a plugin", async () => {
    const setup = createTestSetup({
      legacyHooks: ["after-worktree-created"],
      workspace: { "setup.yaml": "hooks: {}\n" },
    });

    await setup.connectEditor();

    expect(setup.editorMessages).toEqual([]);
  });
});
