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
  createMockGitClient,
  fakeCommit,
  type MockGitClient,
} from "../../boundaries/platform/git-client.state-mock";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import { remoteDirName } from "./remotes";
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
import type { DialogConfig } from "../../shared/dialog-types";
import type { NotificationConfig } from "../../shared/notification-types";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import { projPath, wsPath, testPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import type { RunningHook } from "../presentation/presentation-module";
import { createPluginModule, type PluginModule } from "./module";
import { createScripts } from "../scripts/scripts";
import { createPollModule } from "../poll-module";
import { PollTickOperation } from "../../intents/poll-tick";
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
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import type { ProjectRef, WorkspaceRef } from "../../intents/contract";
import { APP_START_OPERATION_ID } from "../../intents/app-start";

const PROJECT_ROOT = projPath("/project");
const PROJECT_ID = "project-ea0135bc" as ProjectId;
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const PROJECT_REF = projectRefFor(PROJECT_ROOT);
const WORKSPACE_REF = makeWorkspaceRef(PROJECT_REF, "feature-x");
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
  /** The project refs the startup migration knows, by path. */
  readonly projectRefs?: ReadonlyMap<string, ProjectRef>;
  /** How the trust dialog answers: an action id plus unchecked plugin names. */
  readonly trustAnswer?: { action: string; unchecked?: string[] };
  /** Seeds the pre-plugin `auto-workspace.sources` setting. */
  readonly legacySources?: string;
  /** The platform the module runs on (default linux). */
  readonly platform?: NodeJS.Platform;
  /** Seeds `auto-workspaces` tracking entries. */
  readonly tracking?: Record<string, unknown>;
  /** Old hook files in the worktree's `.codehydra/hooks`. */
  readonly legacyHooks?: readonly string[];
  /** What the editor's notification answers (a button, or null for dismissed). */
  readonly editorAnswer?: string | null;
  /** Seeds `plugins.config`. */
  readonly sources?: string;
  /** Other folders' plugins: folder → file name → manifest text. */
  readonly folders?: Record<string, Record<string, string>>;
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
  readonly git: MockGitClient;
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
    workspaces: {
      [WORKSPACE_PATH]: {
        projectPath: PROJECT_ROOT,
        workspaceName: "feature-x" as WorkspaceName,
        branch: "feature-x",
        metadata: { base: "main" },
      },
    },
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
      ...Object.assign(
        {},
        ...Object.entries(options?.folders ?? {}).map(([dir, manifests]) =>
          manifestEntries(new Path(dir), manifests)
        )
      ),
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
  const connected: Array<(workspaceRef: WorkspaceRef) => void> = [];

  const outcomes = options?.outcomes ?? {};
  const processRunner = createMockProcessRunner({
    onSpawn: (command, args, _cwd, env) => {
      // cmd gets the script as its (quoted) command, every other shell as its last argument.
      const scriptFile = new Path(args.at(-1) ?? command.replace(/^"|"$/g, ""));
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
  const git = createMockGitClient({ fileSystem });
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
      "plugins.config": options?.sources ?? "",
      ...(options?.legacySources !== undefined && {
        "auto-workspace.sources": options.legacySources,
      }),
    },
  });
  const pathProvider = createMockPathProvider({ homeRootDir: HOME });
  const runner = createScripts({
    config,
    fileSystem,
    processRunner,
    logger: createBehavioralLogger(),
    tempDir: pathProvider.tempPath("plugins"),
    binDir: new Path(testPath("/data/bin")),
    platform: options?.platform ?? "linux",
    env: { PATH: "/usr/bin" },
  });
  // Automations run through the poll, as in the app.
  const poll = createPollModule({ dispatcher, config, logger: createBehavioralLogger(), runner });
  dispatcher.registerOperation(new PollTickOperation());
  dispatcher.registerModule(poll);
  const module = createPluginModule({
    fileSystem,
    runner,
    pollErrors: (owner) => poll.errors(owner),
    logger: createBehavioralLogger(),
    config,
    stateService,
    dispatcher,
    ui,
    pathProvider: createMockPathProvider({ homeRootDir: HOME }),
    git,
    sink,
    workspaceConnected: (listener) => {
      connected.push(listener);
      return () => {};
    },
    projectRefs: async () => options?.projectRefs ?? new Map(),
    registry: () => registry,
    platform: options?.platform ?? "linux",
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
    git,
    startApp: async () => {
      await poll.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} });
      stoppers.push(() =>
        poll.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({
          intent: { type: "app:shutdown", payload: {} },
        })
      );
    },
    editorMessages,
    connectEditor: async () => {
      for (const listener of connected) listener(WORKSPACE_REF);
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
    payload: { workspaceName: "feature-x", projectRef: PROJECT_REF },
  });
}

async function reopenWorkspace(setup: TestSetup): Promise<void> {
  await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
    type: INTENT_OPEN_WORKSPACE,
    payload: {
      workspaceName: "feature-x",
      projectRef: PROJECT_REF,
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
    payload: { workspaceRef: WORKSPACE_REF, keepBranch: false, removeWorktree: true, force },
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
      workspace: WORKSPACE_REF,
      project: PROJECT_REF,
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
      pluginsEnabled: { [`project:${PROJECT_REF}:b`]: true },
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
    // No log path: each run has its own, and a card naming it would never join
    // the identical one already open.
    expect(card?.message).toBe(
      "local:default:a after-worktree-created: exit 3 — see ch plugin errors"
    );
    // What the script printed stays in its log, never in the card.
    expect(card?.message).not.toContain("secret");

    const [error] = setup.module.api.errors();
    expect(error).toMatchObject({ plugin: "local:default:a", entry: "after-worktree-created" });
    const log = await setup.fileSystem.readFile(new Path(error!.logPath!));
    expect(log).toContain("token=secret boom");
  });

  it("treats exit 75 like any other exit: only automations retry", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "exit 75" }) },
      outcomes: { "exit 75": { exitCode: 75 } },
    });
    await openWorkspace(setup);

    expect(setup.notifications.find((n) => n.title === "Plugin failed")?.message).toBe(
      "local:default:a after-worktree-created: exit 75 — see ch plugin errors"
    );
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
      { source: "local:default:a after-worktree-created stderr", line: "installing" },
    ]);
  });
});

describe("before-workspace-opened", () => {
  it("runs on every open and merges env across plugins, minus CodeHydra's own", async () => {
    const setup = createTestSetup({
      local: { "a.yaml": hooksManifest({ "before-workspace-opened": "echo a" }) },
      workspace: { "b.yaml": hooksManifest({ "before-workspace-opened": "echo b" }) },
      pluginsEnabled: { [`project:${PROJECT_REF}:b`]: true },
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

    expect(rowOf(setup)).toMatchObject({
      status: "error",
      error: expect.stringMatching(/exit 1 — see ch plugin errors$/),
    });
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
    expect(hook.entry).toBe("after-worktree-created (local:default:a)");
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
      /local:default:broken: document 1: hooks: unknown key after-worktree-craeted/
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
      [`project:${PROJECT_REF}:a`]: true,
      [`project:${PROJECT_REF}:b`]: false,
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
      pluginsEnabled: { "local:default:a": false },
    });
    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
  });

  it("moves answers older versions stored to today's keys at app start", async () => {
    const gone = new Path(testPath("/gone")).toString();
    const setup = createTestSetup({
      pluginsEnabled: {
        [`workspace:${new Path(PROJECT_ROOT).toString()}:a`]: true,
        [`workspace:${gone}:b`]: false,
        [`workspace:${PROJECT_REF}:d`]: true,
        "local:c": false,
        // Already current: left alone.
        "remote:acme:e": false,
      },
      projectRefs: new Map([[new Path(PROJECT_ROOT).toString(), PROJECT_REF]]),
    });

    await setup.module.hooks![APP_START_OPERATION_ID]!["migrations"]!.handler({
      intent: { type: "app:start", payload: {} },
    });

    expect(setup.stateService.getEffective()["plugins.state"]).toEqual({
      [`project:${PROJECT_REF}:a`]: true,
      // An answer whose project has no record keeps its path; the project asks afresh.
      [`project:${gone}:b`]: false,
      [`project:${PROJECT_REF}:d`]: true,
      // Before sources, a local plugin was the default folder's.
      "local:default:c": false,
      "remote:acme:e": false,
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
  const scope = {
    workspace: {
      workspacePath: WORKSPACE_PATH,
      projectRef: PROJECT_REF,
      projectPath: PROJECT_ROOT,
    },
  };

  it("lists local and repository plugins with their state and platforms", async () => {
    const setup = createTestSetup({
      local: { "a/plugin.yaml": "platform: [linux, macos]\nhooks: {}\n" },
      workspace: { "b.yaml": "hooks: {}\n" },
    });

    const list = await setup.module.api.list(scope);

    expect(list.map((p) => [p.id, p.state, p.platforms])).toEqual([
      ["local:default:a", "enabled", ["linux", "macos"]],
      ["project:project:b", "ask", ["linux", "windows", "macos"]],
    ]);
    expect(new Path(list[0]!.path).equals(new Path(LOCAL_PLUGINS, "a"))).toBe(true);
  });

  it("disables and re-enables a plugin", async () => {
    const setup = createTestSetup({ workspace: { "b.yaml": "hooks: {}\n" } });

    await setup.module.api.setState(scope, "project:project:b", "enabled");
    expect((await setup.module.api.list(scope))[0]?.state).toBe("enabled");
    await setup.module.api.setState(scope, "project:project:b", "disabled");
    expect((await setup.module.api.list(scope))[0]?.state).toBe("disabled");
  });

  it("refuses a plugin that does not exist", async () => {
    const setup = createTestSetup();

    await expect(setup.module.api.setState(scope, "local:default:nope", "enabled")).rejects.toThrow(
      /No plugin local:default:nope/
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

  it("gives an automation the values of its plugin's settings", async () => {
    const setup = createTestSetup({
      sources: "default:\n  config:\n    notes: {token: t1}\n",
      local: {
        "notes.yaml": [
          "config:",
          "  token: {type: string, required: true}",
          "automations:",
          "  hello: list-notes",
        ].join("\n"),
      },
      outcomes: { "list-notes": { stdout: "[]" } },
    });

    await setup.startApp();

    expect(setup.envs[0]).toMatchObject({ CH_CONFIG_TOKEN: "t1" });
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
        plugin: "local:default:notes",
        entry: "automations.hello",
        message: "printed JSON that is not an array",
      },
    ]);
    expect(setup.module.api.errors()[0]?.logPath).toBeDefined();
  });

  describe("exit 75", () => {
    const POLL_MS = 60_000;
    const RETRYING = "temporary failure (exit 75), retrying";

    beforeEach(() => {
      // setImmediate stays real: the mocks settle on it.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function setupTemporary(): {
      setup: TestSetup;
      outcomes: Record<string, { exitCode?: number; stdout?: string }>;
    } {
      const outcomes: Record<string, { exitCode?: number; stdout?: string }> = {
        "list-notes": { exitCode: 75 },
      };
      const setup = createTestSetup({
        local: { "notes.yaml": ["automations:", "  hello: list-notes"].join("\n") },
        outcomes,
      });
      return { setup, outcomes };
    }
    const failedCards = (setup: TestSetup): readonly NotificationConfig[] =>
      setup.notifications.filter((n) => n.title === "Plugin failed");

    it("is listed as retrying, with no card, until it has lasted ten minutes", async () => {
      const { setup } = setupTemporary();
      await setup.startApp();

      expect(setup.module.api.errors()).toMatchObject([
        { plugin: "local:default:notes", entry: "automations.hello", message: RETRYING },
      ]);
      expect(failedCards(setup)).toEqual([]);

      await vi.advanceTimersByTimeAsync(9 * POLL_MS);
      expect(failedCards(setup)).toEqual([]);

      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(setup.module.api.errors()[0]?.message).toBe("exit 75");
      expect(failedCards(setup).map((card) => card.message)).toEqual([
        "local:default:notes automations.hello: exit 75 — see ch plugin errors",
      ]);

      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(failedCards(setup)).toHaveLength(1);
    });

    it("starts the ten minutes over after a success", async () => {
      const { setup, outcomes } = setupTemporary();
      await setup.startApp();

      await vi.advanceTimersByTimeAsync(8 * POLL_MS);
      outcomes["list-notes"] = { stdout: "[]" };
      await vi.advanceTimersByTimeAsync(POLL_MS);
      outcomes["list-notes"] = { exitCode: 75 };
      await vi.advanceTimersByTimeAsync(5 * POLL_MS);

      expect(setup.module.api.errors()[0]?.message).toBe(RETRYING);
      expect(failedCards(setup)).toEqual([]);
    });

    it("reports a real failure at once, and starts the ten minutes over after it", async () => {
      const { setup, outcomes } = setupTemporary();
      await setup.startApp();

      await vi.advanceTimersByTimeAsync(8 * POLL_MS);
      outcomes["list-notes"] = { exitCode: 1 };
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(failedCards(setup).map((card) => card.message)).toEqual([
        "local:default:notes automations.hello: exit 1 — see ch plugin errors",
      ]);

      outcomes["list-notes"] = { exitCode: 75 };
      await vi.advanceTimersByTimeAsync(5 * POLL_MS);
      expect(setup.module.api.errors()[0]?.message).toBe(RETRYING);
      expect(failedCards(setup)).toHaveLength(1);
    });
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
      "local:default:auto-workspaces/gh/1",
    ]);
    // The migrated automation ran, and found its item already handled.
    expect(setup.ran).toEqual([MIGRATED_SCRIPT]);
    // The setting is cleared, so the move happens once.
    expect(setup.config.getEffective()).not.toHaveProperty("auto-workspace.sources");
    expect(setup.notifications.map((n) => n.title)).toContain(
      "Auto-workspace sources are now a plugin"
    );
  });

  it("moves a Windows source's cmd into a batch file the automation pipes", async () => {
    // The runner writes cmd's `@echo off` prelude ahead of the body.
    const script =
      '@echo off\r\n"%CH_PLUGIN_DIR%\\sources\\gh.cmd" | ch plugin render "%CH_PLUGIN_DIR%\\templates\\gh.yaml"';
    const setup = createTestSetup({
      platform: "win32",
      legacySources: 'name: gh\ncmd: fetch ^(a^) %20 %PATH%\ntemplate:\n  name: "ws-{{ id }}"',
      outcomes: { [script]: { stdout: "[]" } },
    });

    await setup.startApp();

    expect(
      await setup.fileSystem.readFile(
        new Path(LOCAL_PLUGINS, "auto-workspaces", "sources", "gh.cmd")
      )
    ).toBe("@echo off\r\nfetch ^(a^) %%20 %PATH%\r\n");
    expect(setup.ran).toEqual([script]);
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

describe("sources", () => {
  const WORK = new Path(testPath("/work-plugins"));
  const REMOTE_URL = "https://example.com/acme/ch-plugins.git";
  const REMOTES = createMockPathProvider({ homeRootDir: HOME }).dataPath("plugins/remotes");
  const scope = {
    workspace: {
      workspacePath: WORKSPACE_PATH,
      projectRef: PROJECT_REF,
      projectPath: PROJECT_ROOT,
    },
  };

  /** Put a remote's plugins where its first checkout lands. */
  async function seedRemote(
    setup: TestSetup,
    manifests: Record<string, string>,
    key = "acme"
  ): Promise<void> {
    const tree = new Path(
      REMOTES,
      remoteDirName({ key, url: REMOTE_URL }),
      "trees",
      fakeCommit(REMOTE_URL, "main")
    );
    for (const [name, text] of Object.entries(manifests)) {
      const path = new Path(tree, name);
      await setup.fileSystem.mkdir(path.dirname);
      await setup.fileSystem.writeFile(path, text);
    }
  }

  it("runs another folder's plugins after the default folder's, named by its entry", async () => {
    const setup = createTestSetup({
      sources: `work:\n  path: ${JSON.stringify(WORK.toString())}\n`,
      local: { "a.yaml": hooksManifest({ "after-worktree-created": "echo a" }) },
      folders: {
        [WORK.toString()]: { "x.yaml": hooksManifest({ "after-worktree-created": "echo x" }) },
      },
      outcomes: { "echo a": {}, "echo x": {} },
    });

    await openWorkspace(setup);

    expect(setup.ran).toEqual(["echo a", "echo x"]);
    expect((await setup.module.api.list({ workspace: null })).map((p) => p.id)).toEqual([
      "local:default:a",
      "local:work:x",
    ]);
  });

  it("gives a plugin's scripts the values of its settings, and no one else's", async () => {
    const setup = createTestSetup({
      sources: "default:\n  config:\n    a: {token: t1}\n",
      local: {
        "a.yaml": hooksManifest(
          { "after-worktree-created": "echo a" },
          "config:\n  token: {type: string, required: true}\n  region: {type: enum, values: [eu, us], default: eu}\n"
        ),
        "b.yaml": hooksManifest({ "after-worktree-created": "echo b" }),
      },
      outcomes: { "echo a": {}, "echo b": {} },
    });
    // One inherited from CodeHydra's own environment never reaches a script.
    vi.stubEnv("CH_CONFIG_TOKEN", "leaked");

    await openWorkspace(setup);

    expect(setup.envs[0]).toMatchObject({ CH_CONFIG_TOKEN: "t1", CH_CONFIG_REGION: "eu" });
    expect(setup.envs[1]).not.toHaveProperty("CH_CONFIG_TOKEN");
    // Settings reach the script's environment, never its logged stdin.
    expect(JSON.stringify(setup.stdin[0])).not.toContain("t1");
  });

  it("does not run a plugin whose values do not fit its settings, and says why", async () => {
    const setup = createTestSetup({
      sources: "default:\n  config:\n    b: {x: 1}\n    ghost: {y: 2}\n",
      local: {
        "a.yaml": hooksManifest(
          { "after-worktree-created": "echo a" },
          "config:\n  token: {type: string, required: true}\n"
        ),
        "b.yaml": hooksManifest({ "after-worktree-created": "echo b" }),
      },
    });

    await openWorkspace(setup);

    expect(setup.ran).toEqual([]);
    expect(setup.module.api.errors().map((error) => [error.plugin, error.message])).toEqual([
      ["local:default:a", "config.token is required: set it in plugins.config"],
      ["local:default:b", "plugins.config sets x, which the plugin does not declare"],
      [
        "local:default:ghost",
        "plugins.config sets values for ghost, which local:default does not have",
      ],
    ]);
    expect(setup.notifications.map((card) => card.title)).toContain("Plugin cannot run");
  });

  it("gives a repository's plugins the values of the project entry naming it", async () => {
    const setup = createTestSetup({
      sources: `mine:\n  type: project\n  project: project\n  config:\n    b: {k: v}\n`,
      workspace: {
        "b.yaml": hooksManifest(
          { "after-worktree-created": "echo b" },
          "config:\n  k: {type: string}\n"
        ),
      },
      pluginsEnabled: { [`project:${PROJECT_REF}:b`]: true },
      outcomes: { "echo b": {} },
    });
    registerListProjects(setup);

    await openWorkspace(setup);

    expect(setup.envs[0]).toMatchObject({ CH_CONFIG_K: "v" });
    expect((await setup.module.api.list(scope)).map((p) => p.id)).toEqual(["project:project:b"]);
  });

  it("reports two project entries naming one project, using neither", async () => {
    const setup = createTestSetup({
      sources:
        "one:\n  type: project\n  project: project\n  config:\n    b: {k: v}\n" +
        `two:\n  type: project\n  project: ${JSON.stringify(PROJECT_ROOT)}\n`,
      workspace: {
        "b.yaml": hooksManifest(
          { "after-worktree-created": "echo b" },
          "config:\n  k: {type: string}\n"
        ),
      },
      pluginsEnabled: { [`project:${PROJECT_REF}:b`]: true },
      outcomes: { "echo b": {} },
    });
    registerListProjects(setup);

    await openWorkspace(setup);

    expect(setup.envs[0]).not.toHaveProperty("CH_CONFIG_K");
    expect(setup.module.api.errors()).toContainEqual(
      expect.objectContaining({ message: "one and two name the same project; keep one" })
    );
  });

  it("adds a repository, runs its plugins, and removes it with its clone", async () => {
    const setup = createTestSetup({
      outcomes: { "echo deploy": {} },
    });
    await seedRemote(setup, {
      "plugins/deploy.yaml": hooksManifest({ "after-worktree-created": "echo deploy" }),
    });

    const added = await setup.module.api.add({
      source: REMOTE_URL,
      name: "acme",
      path: "plugins",
      cwd: null,
    });

    expect(added).toMatchObject({
      id: "remote:acme",
      type: "remote",
      location: REMOTE_URL,
      status: `${fakeCommit(REMOTE_URL, "main").slice(0, 7)}, fetched just now`,
    });
    expect(String(setup.config.getEffective()["plugins.config"])).toContain("type: remote");

    await openWorkspace(setup);
    expect(setup.ran).toEqual(["echo deploy"]);
    const [deploy] = await setup.module.api.list({ workspace: null });
    expect(deploy).toMatchObject({ id: "remote:acme:deploy", source: "acme", state: "enabled" });

    await setup.module.api.remove("acme");

    expect(setup.config.getEffective()["plugins.config"]).toBe("");
    expect(
      setup.fileSystem.$.entries.has(
        new Path(REMOTES, remoteDirName({ key: "acme", url: REMOTE_URL })).toString()
      )
    ).toBe(false);
  });

  it("adds a folder by name, refusing a name already taken", async () => {
    const setup = createTestSetup({ folders: { [WORK.toString()]: { "x.yaml": "hooks: {}\n" } } });

    expect(await setup.module.api.add({ source: WORK.toString(), cwd: null })).toMatchObject({
      id: "local:work-plugins",
      type: "local",
    });
    expect((await setup.module.api.list({ workspace: null })).map((p) => p.id)).toEqual([
      "local:work-plugins:x",
    ]);
    await expect(
      setup.module.api.add({ source: WORK.toString(), cwd: null })
    ).rejects.toMatchObject({ category: "conflict" });
    await expect(
      setup.module.api.add({ source: WORK.toString(), ref: "main", cwd: null })
    ).rejects.toMatchObject({ category: "usage" });
  });

  it("updates remotes only, and never removes the default folder", async () => {
    const setup = createTestSetup({
      sources: `work:\n  path: ${JSON.stringify(WORK.toString())}\n`,
    });

    await expect(setup.module.api.update("work")).rejects.toMatchObject({ category: "usage" });
    await expect(setup.module.api.update("nope")).rejects.toMatchObject({
      category: "not-found",
    });
    await expect(setup.module.api.remove("default")).rejects.toMatchObject({ category: "usage" });
    expect(await setup.module.api.update()).toEqual([]);
  });

  it("lists a remote not checked out yet, saying so", async () => {
    const setup = createTestSetup({
      sources: `acme:\n  type: remote\n  url: ${REMOTE_URL}\n`,
    });

    const list = await setup.module.api.list({ workspace: null });

    expect(list).toEqual([expect.objectContaining({ id: "remote:acme:*", status: "cloning" })]);
  });

  it("names the default folder's automations by their source in tracking entries from before", async () => {
    const setup = createTestSetup({
      tracking: {
        "notes/hello/1": { workspaceName: "ws-1", createdAt: "2026-01-01T00:00:00.000Z" },
        "local:work:x/hello/2": { workspaceName: "ws-2", createdAt: "2026-01-01T00:00:00.000Z" },
      },
    });

    await setup.module.hooks![APP_START_OPERATION_ID]!["migrations"]!.handler({
      intent: { type: "app:start", payload: {} },
    });

    expect(Object.keys(setup.stateService.getEffective()["auto-workspaces"] as object)).toEqual([
      "local:default:notes/hello/1",
      "local:work:x/hello/2",
    ]);
  });
});

/** The open projects, as `project:list` answers: just this test's. */
function registerListProjects(setup: TestSetup): void {
  const schemas = {
    type: INTENT_LIST_PROJECTS,
    payload: z.unknown(),
    result: z.unknown(),
  } satisfies OperationSchemas;
  class ListProjectsOp implements Operation<typeof schemas> {
    readonly id = "list-projects";
    readonly schemas = schemas;
    async execute(): Promise<unknown> {
      return [{ ref: PROJECT_REF, name: "project", path: PROJECT_ROOT, workspaces: [] }];
    }
  }
  setup.dispatcher.registerOperation(new ListProjectsOp());
}
