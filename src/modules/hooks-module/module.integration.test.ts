// @vitest-environment node
/**
 * Integration tests for the repository-hooks module.
 *
 * Runs against the real OpenWorkspaceOperation and DeleteWorkspaceOperation so
 * the assertions cover the seams that actually matter: an open hook's
 * environment reaching the agent's start and the terminals' config, a setup
 * hook's title and tags folding into the `workspace:created` snapshot, and a
 * refusal stopping the deletion pipeline before the worktree is removed.
 *
 * The filesystem and the process runner are behavioural mocks — what a hook
 * *is* (a file that gets spawned through a shell) is covered by the boundary
 * test, which runs real scripts.
 */

import { describe, it, expect } from "vitest";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createMockState } from "../../boundaries/platform/state.test-utils";
import { createBehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import type { BehavioralLogger } from "../../boundaries/platform/logging.test-utils";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
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
  type OpenWorkspacePayload,
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
import { projPath, wsPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import type { RunningHook } from "../presentation/presentation-module";
import { createHooksModule } from "./module";
import type { HookOutputSink } from "./runner";

const PROJECT_ROOT = projPath("/project");
const PROJECT_ID = "project-ea0135bc" as ProjectId;
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_URL = "http://127.0.0.1:25448/?folder=/workspaces/feature-x";

const SETUP_HOOK = "/workspaces/feature-x/.codehydra/hooks/after-worktree-created";
const OPEN_HOOK = "/workspaces/feature-x/.codehydra/hooks/before-workspace-opened";
const DELETE_HOOK = "/workspaces/feature-x/.codehydra/hooks/before-worktree-deleted";
const EVENT_HOOK = "/workspaces/feature-x/.codehydra/hooks/on-workspace-opened";
const HOOKS_DIR = "/workspaces/feature-x/.codehydra/hooks";

/** What the agent module contributes to the agent terminal's environment. */
const AGENT_ENV = { _CH_WORKSPACE_PATH: WORKSPACE_PATH };

interface SpawnOutcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Never exits on its own — only a kill ends it. */
  readonly hangs?: boolean;
}

interface TestSetup {
  readonly dispatcher: Dispatcher;
  readonly createdEvents: WorkspaceCreatedEvent[];
  readonly progress: WorkspaceDeletionProgressEvent[];
  /** envVars the finalize hook point saw — the agent terminal's environment. */
  readonly finalizeEnv: Array<Record<string, string>>;
  /** workspaceEnv the finalize hook point saw — what the editor's terminals get. */
  readonly terminalEnv: Array<Record<string, string>>;
  /** workspaceEnv the setup hook point saw — what the agent server starts with. */
  readonly agentStartEnv: Array<Record<string, string>>;
  readonly notifications: readonly NotificationConfig[];
  readonly dialogs: DialogConfig[];
  /** The open options each dialog was raised with, in order. */
  readonly dialogOptions: Array<{ workspacePath?: string; projectPath?: string } | undefined>;
  readonly sinkLines: Array<{ entry: string; line: string }>;
  /** Metadata written through the real SetMetadataOperation, in order. */
  readonly metadataWrites: Array<{ key: string; value: string | null }>;
  /** Answer the next trust dialog with this action id. */
  answerTrust(actionId: string): void;
  /** Text each spawn was handed on stdin, in order. */
  readonly stdin: string[];
  /** Command line of each spawn, in order, with `/` separators. */
  readonly spawned: string[];
  /** How many spawned processes were killed. */
  killedCount(): number;
  /** Hooks currently offered for cancel (registered and not yet finished). */
  readonly runningHooks: RunningHook[];
  /** `opening` / `closed` calls on the output sink, in order. */
  readonly sinkCalls: Array<{ call: "opening" | "closed"; workspacePath: string }>;
  readonly logger: BehavioralLogger;
}

interface SetupOptions {
  /** Files present under the worktree. Keys are absolute paths. */
  readonly hooks?: Record<string, SpawnOutcome>;
  readonly enabled?: boolean;
  /** Seeds `hooks.trusted`; absent means the gate will ask. */
  readonly trusted?: Record<string, boolean>;
  /** Action id the trust dialog answers with. Default: Always. */
  readonly trustAnswer?: string;
  /** Directories sitting in the hooks directory. Keys are absolute paths. */
  readonly hookDirectories?: readonly string[];
  /** The platform whose suffixed hook files apply. Default: this process's. */
  readonly platform?: NodeJS.Platform;
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
  const dialogOptions: TestSetup["dialogOptions"] = [];
  const sinkLines: Array<{ entry: string; line: string }> = [];
  const metadataWrites: Array<{ key: string; value: string | null }> = [];
  const stdin: string[] = [];
  const runningHooks: RunningHook[] = [];
  const sinkCalls: Array<{ call: "opening" | "closed"; workspacePath: string }> = [];
  const logger = createBehavioralLogger();
  let trustAnswer = options?.trustAnswer ?? "always";

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

  const hookFiles = options?.hooks ?? {};

  // Only the directories a hook was declared in exist, so "no hooks directory"
  // is the default and stays the cheap path it is in production.
  const entries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    [PROJECT_ROOT]: directory(),
    [WORKSPACE_PATH]: directory(),
  };
  for (const path of Object.keys(hookFiles)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    entries[dir] = directory();
    entries[path] = file("#!/bin/sh\n", { executable: true });
  }
  for (const path of options?.hookDirectories ?? []) {
    entries[path.slice(0, path.lastIndexOf("/"))] = directory();
    entries[path] = directory();
  }

  const fileSystem = createFileSystemMock({ entries });

  const processRunner = createMockProcessRunner({
    onSpawn: (command) => {
      // The command line carries a *native* path, so on Windows it is
      // backslash-separated while these keys are POSIX. Comparing them raw made
      // every hook fall through to the default empty outcome — the hook still
      // "ran", it just never said anything, so stdin assertions passed while
      // every assertion about output failed.
      const line = command.replace(/\\/g, "/");
      // Anchored on the closing quote, so `x` does not also match `x.sh`.
      const match = Object.entries(hookFiles).find(
        ([path]) => line.includes(`${path}'`) || line.includes(`${path}"`)
      );
      if (!match) {
        // Loud on purpose. A silent default here reads as "the hook ran and
        // said nothing", which is indistinguishable from a real empty result —
        // and that is precisely how the separator bug above hid.
        throw new Error(`test spawned a command matching no declared hook: ${command}`);
      }
      const outcome = match[1];
      if (outcome.hangs === true) return { untilKilled: true };
      return {
        exitCode: outcome.exitCode ?? 0,
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
      };
    },
  });

  const sink: HookOutputSink = {
    write: (_workspacePath, entry, line) => sinkLines.push({ entry, line }),
    opening: (workspacePath) => sinkCalls.push({ call: "opening", workspacePath }),
    closed: (workspacePath) => sinkCalls.push({ call: "closed", workspacePath }),
  };

  const ui = {
    dialog: (config: DialogConfig, options?: { workspacePath?: string; projectPath?: string }) => {
      dialogs.push(config);
      dialogOptions.push(options);
      return makeDialogStub(() => trustAnswer);
    },
    trackRunningHook: (hook: RunningHook) => {
      runningHooks.push(hook);
      return () => {
        runningHooks.splice(runningHooks.indexOf(hook), 1);
      };
    },
  };

  // Stands in for the git-worktree / agent / ide-server hooks on workspace:open,
  // and records the environment the hook contributed.
  const openWorkspaceHost: IntentModule = {
    name: "test-open-workspace-host",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        // Mirrors GitWorktreeWorkspaceModule: a reopen reports the branch it
        // was handed (null when detached) and the base its metadata records.
        create: {
          handler: async (ctx: HookContext): Promise<HookOutput<CreateHookResult>> => {
            const existing = (ctx.intent as OpenWorkspaceIntent).payload.existingWorkspace;
            if (existing) {
              const recordedBase = existing.metadata["base"];
              return {
                result: {
                  workspacePath: WORKSPACE_PATH,
                  branch: existing.branch,
                  metadata: existing.metadata,
                  ...(recordedBase !== undefined && { resolvedBase: recordedBase }),
                },
              };
            }
            return {
              result: {
                workspacePath: WORKSPACE_PATH,
                branch: "feature-x",
                metadata: { base: "main" },
                resolvedBase: "main",
              },
            };
          },
        },
        // Stands in for the agent module: records the environment its server
        // would start with, and contributes CodeHydra's own terminal variables.
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
      // Stands in for GitWorktreeProvider: the branch-config store metadata lands in.
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
  dispatcher.registerModule(
    createHooksModule({
      fileSystem,
      processRunner,
      logger,
      config: createMockConfig({ defaults: { "hooks.enabled": options?.enabled ?? true } }),
      stateService: createMockState({
        values: { "hooks.trusted": options?.trusted ?? {} },
      }),
      dispatcher,
      ui,
      binDir: new Path("/data/bin"),
      sink,
      ...(options?.platform !== undefined && { platform: options.platform }),
    })
  );

  // The mock records what each spawn was handed; read it lazily so assertions
  // see everything spawned by the time they run.
  const stdinProxy = new Proxy(stdin, {
    get(target, prop) {
      if (prop === "length" || typeof prop === "string") {
        target.length = 0;
        for (let i = 0; i < processRunner.$.spawnedCount; i++) {
          target.push(processRunner.$.spawned(i).$.input ?? "");
        }
      }
      return Reflect.get(target, prop) as unknown;
    },
  });

  return {
    dispatcher,
    createdEvents,
    progress,
    finalizeEnv,
    terminalEnv,
    agentStartEnv,
    get notifications() {
      return cards.notifications.map((card) => card.opened);
    },
    dialogs,
    dialogOptions,
    sinkLines,
    metadataWrites,
    stdin: stdinProxy,
    get spawned() {
      return Array.from({ length: processRunner.$.spawnedCount }, (_, i) =>
        processRunner.$.spawned(i).$.command.replace(/\\/g, "/")
      );
    },
    killedCount: () =>
      Array.from({ length: processRunner.$.spawnedCount }, (_, i) =>
        processRunner.$.spawned(i)
      ).filter((proc) => proc.$.killCalls.length > 0).length,
    runningHooks,
    sinkCalls,
    logger,
    answerTrust: (actionId: string) => {
      trustAnswer = actionId;
    },
  };
}

/** A DialogHandle that answers nextEvent() with a fixed action. */
function makeDialogStub(answer: () => string) {
  return {
    id: "dlg-1",
    update: () => {},
    close: () => {},
    onEvent: () => () => {},
    onChange: () => () => {},
    onDismiss: () => () => {},
    nextEvent: async () => ({ dialogId: "dlg-1", actionId: answer() }),
    closed: Promise.resolve(),
  };
}

function openPayload(): OpenWorkspacePayload {
  return { workspaceName: "feature-x", projectPath: PROJECT_ROOT };
}

async function openWorkspace(setup: TestSetup): Promise<void> {
  await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
    type: INTENT_OPEN_WORKSPACE,
    payload: openPayload(),
  });
}

/**
 * Reopen the workspace the way app start, project open and wake do: through
 * `existingWorkspace`, with whatever git reports for it.
 */
async function reopenWorkspace(
  setup: TestSetup,
  existing?: { branch?: string | null; metadata?: Record<string, string> }
): Promise<void> {
  await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
    type: INTENT_OPEN_WORKSPACE,
    payload: {
      ...openPayload(),
      existingWorkspace: {
        path: WORKSPACE_PATH,
        name: "feature-x",
        branch: existing?.branch === undefined ? "feature-x" : existing.branch,
        metadata: existing?.metadata ?? { base: "main" },
      },
    },
  });
}

async function deleteWorkspace(setup: TestSetup): Promise<void> {
  await setup.dispatcher.dispatch<DeleteWorkspaceIntent>({
    type: INTENT_DELETE_WORKSPACE,
    payload: {
      workspacePath: WORKSPACE_PATH,
      keepBranch: false,
      removeWorktree: true,
      force: false,
    },
  });
}

/** Wait until a hook is offered for cancel, i.e. its process is running. */
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
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("no hooks defined", () => {
  it("opens a workspace without spawning anything", async () => {
    const setup = createTestSetup();
    await openWorkspace(setup);
    expect(setup.stdin).toHaveLength(0);
    expect(setup.createdEvents).toHaveLength(1);
  });

  it("deletes a workspace with no repository-hook progress row", async () => {
    const setup = createTestSetup();
    await deleteWorkspace(setup);
    const rows = setup.progress.flatMap((event) => event.payload.operations.map((op) => op.id));
    expect(rows).not.toContain("repo-hook");
  });
});

describe("after-worktree-created", () => {
  it("hands the hook its workspace on stdin", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(JSON.parse(setup.stdin[0]!)).toEqual({
      workspaceName: "feature-x",
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_ROOT,
      branch: "feature-x",
      base: "main",
    });
  });

  it("no longer accepts env — that belongs to before-workspace-opened", async () => {
    const setup = createTestSetup({
      hooks: {
        [SETUP_HOOK]: { stdout: JSON.stringify({ env: { DATABASE_URL: "postgres://x" } }) },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    // Rejected loudly rather than dropped: a repository that has not moved its
    // env yet must find out, not open workspaces quietly without it.
    await settle();
    expect(setup.notifications.map((n) => n.title)).toContain("Repository hook failed");
    expect(setup.finalizeEnv[0]).toEqual(AGENT_ENV);
  });

  it("persists a returned title and tags as workspace metadata", async () => {
    const setup = createTestSetup({
      hooks: {
        [SETUP_HOOK]: {
          stdout: JSON.stringify({ title: "Feature X", tags: { review: { color: "#3498db" } } }),
        },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    // Written, not merely reported: WorktreeModule's finalize re-read folds in
    // after every setup result, so a title that exists only as a result is
    // superseded by that read a moment later.
    expect(setup.metadataWrites).toEqual([
      { key: "title", value: "Feature X" },
      { key: "tags.review", value: JSON.stringify({ color: "#3498db" }) },
    ]);
  });

  it("folds a returned title and tags into workspace:created", async () => {
    const setup = createTestSetup({
      hooks: {
        [SETUP_HOOK]: {
          stdout: JSON.stringify({
            title: "Feature X",
            tags: { review: { color: "#3498db", description: "Waiting on review" } },
          }),
        },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.createdEvents[0]!.payload.metadata).toMatchObject({
      title: "Feature X",
      "tags.review": JSON.stringify({ color: "#3498db", description: "Waiting on review" }),
    });
  });

  it("still opens the workspace when the hook fails, and says so", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { exitCode: 1, stderr: "pnpm install failed" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.createdEvents).toHaveLength(1);
    await settle();
    expect(setup.notifications.map((n) => n.type)).toContain("error");
  });

  it("rejects output that is not the declared shape", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { stdout: JSON.stringify({ titel: "Feature X" }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    // A misspelled key must not be dropped in silence — an environment that
    // quietly never arrived is the worst version of this failure.
    await settle();
    expect(setup.notifications.map((n) => n.title)).toContain("Repository hook failed");
    expect(setup.metadataWrites).toEqual([]);
  });

  it("rejects a tag name that could not be stored, naming it, and applies nothing", async () => {
    const setup = createTestSetup({
      hooks: {
        [SETUP_HOOK]: {
          stdout: JSON.stringify({ title: "Feature X", tags: { "1st-review": {}, wip: {} } }),
        },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    // It used to half-apply: the bad tag was not saved but still reached
    // workspace:created, so it showed until the next restart dropped it.
    const failure = setup.notifications.find((n) => n.title === "Repository hook failed");
    expect(failure?.message).toContain("tags.1st-review: not a valid tag name");
    expect(setup.metadataWrites).toEqual([]);
    expect(setup.createdEvents).toHaveLength(1);
    expect(setup.createdEvents[0]!.payload.metadata).not.toHaveProperty("title");
    expect(setup.createdEvents[0]!.payload.metadata).not.toHaveProperty("tags.wip");
  });

  it("does not run for a re-opened workspace", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup);
    expect(setup.stdin).toHaveLength(0);
  });

  it("sends the hook's stderr to the output sink", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { stderr: "copying .env\ninstalling\n" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.sinkLines.map((entry) => entry.line)).toEqual(["copying .env", "installing"]);
  });
});

describe("before-workspace-opened", () => {
  it("runs on a new workspace, after after-worktree-created", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {}, [OPEN_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.stdin).toHaveLength(2);
    // Order is the contract: setup work first, then the environment for the
    // agent that is about to start in the set-up tree.
    expect(JSON.parse(setup.stdin[0]!)).not.toHaveProperty("reopened");
    expect(JSON.parse(setup.stdin[1]!)).toEqual({
      workspaceName: "feature-x",
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_ROOT,
      branch: "feature-x",
      base: "main",
      reopened: false,
    });
  });

  // App start and project open both reopen discovered workspaces through
  // project:open; a wake reopens one — all as `existingWorkspace`.
  it("runs on every reopen — app start, project open, wake", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup);

    expect(setup.stdin).toHaveLength(1);
    expect(JSON.parse(setup.stdin[0]!)).toMatchObject({ reopened: true, base: "main" });
  });

  it("gives its env to the agent's start, before the agent server is spawned", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: { stdout: JSON.stringify({ env: { DATABASE_URL: "postgres://x" } }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.agentStartEnv[0]).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("gives its env to the agent terminal and to the editor's terminals", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: { stdout: JSON.stringify({ env: { DATABASE_URL: "postgres://x" } }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup);

    expect(setup.finalizeEnv[0]).toEqual({ ...AGENT_ENV, DATABASE_URL: "postgres://x" });
    // The editor's terminals get the workspace's own env, not the agent's.
    expect(setup.terminalEnv[0]).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("cannot override CodeHydra's own variables", async () => {
    const setup = createTestSetup({
      hooks: {
        [OPEN_HOOK]: {
          stdout: JSON.stringify({ env: { _CH_WORKSPACE_PATH: "/elsewhere", KEEP: "1" } }),
        },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.agentStartEnv[0]).toEqual({ KEEP: "1" });
    expect(setup.terminalEnv[0]).toEqual({ KEEP: "1" });
    expect(setup.finalizeEnv[0]).toEqual({ ...AGENT_ENV, KEEP: "1" });
  });

  it("still opens the workspace without env when the hook fails, and says so", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: { exitCode: 1, stderr: "vault unreachable" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup);

    expect(setup.createdEvents).toHaveLength(1);
    await settle();
    expect(setup.notifications.map((n) => n.title)).toContain("Repository hook failed");
    expect(setup.terminalEnv[0]).toEqual({});
  });

  it("rejects output that is not the declared shape", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: { stdout: JSON.stringify({ envs: { A: "1" } }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);
    await settle();

    expect(setup.notifications.map((n) => n.title)).toContain("Repository hook failed");
    expect(setup.agentStartEnv[0]).toEqual({});
  });

  it("omits branch on a detached HEAD and base when none is recorded", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup, { branch: null, metadata: {} });

    // Absent — never "" and never the workspace name standing in.
    const input = JSON.parse(setup.stdin[0]!) as Record<string, unknown>;
    expect(input).not.toHaveProperty("branch");
    expect(input).not.toHaveProperty("base");
    expect(input).toMatchObject({ workspaceName: "feature-x", reopened: true });
  });
});

describe("before-worktree-deleted", () => {
  it("lists its row from the first progress event, not once it starts", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    // A row that appears halfway down a list the user is already reading is
    // worse than one that sits there pending, so its presence is settled during
    // preflight — before any progress is emitted.
    const first = setup.progress[0]!.payload.operations;
    expect(first.find((op) => op.id === "repo-hook")).toBeDefined();
  });

  it("blocks the deletion and reports the reason on its row", async () => {
    const setup = createTestSetup({
      hooks: {
        [DELETE_HOOK]: { stdout: JSON.stringify({ blocked: true, reason: "CI lock #4821" }) },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    const last = setup.progress.at(-1)!.payload;
    expect(last.hasErrors).toBe(true);
    expect(last.operations.find((op) => op.id === "repo-hook")).toMatchObject({
      status: "error",
      error: "CI lock #4821",
    });
    // The worktree removal never ran.
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });

  it("fails closed when the hook itself breaks", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: { exitCode: 3, stderr: "Traceback" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    const last = setup.progress.at(-1)!.payload;
    expect(last.hasErrors).toBe(true);
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });

  it("lets the deletion through when the hook allows it", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: { stdout: "" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    const last = setup.progress.at(-1)!.payload;
    expect(last.hasErrors).toBe(false);
    expect(last.operations.find((op) => op.id === "repo-hook")?.status).toBe("done");
  });

  it("carries keepBranch in the hook's input", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await setup.dispatcher.dispatch<DeleteWorkspaceIntent>({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: WORKSPACE_PATH,
        keepBranch: true,
        removeWorktree: true,
        force: false,
      },
    });

    expect(JSON.parse(setup.stdin[0]!)).toMatchObject({ keepBranch: true });
  });

  it("is skipped in force mode, so Dismiss escapes a refusing hook", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: { stdout: JSON.stringify({ blocked: true, reason: "no" }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await setup.dispatcher.dispatch<DeleteWorkspaceIntent>({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: WORKSPACE_PATH,
        keepBranch: false,
        removeWorktree: true,
        force: true,
      },
    });

    expect(setup.stdin).toHaveLength(0);
  });

  it("does not run for a runtime-only teardown", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await setup.dispatcher.dispatch<DeleteWorkspaceIntent>({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: WORKSPACE_PATH,
        keepBranch: false,
        removeWorktree: false,
        force: false,
      },
    });

    expect(setup.stdin).toHaveLength(0);
  });
});

describe("on-workspace-opened", () => {
  it("fires without blocking the open, and reports whether it was a reopen", async () => {
    const setup = createTestSetup({
      hooks: { [EVENT_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);
    await settle();

    expect(JSON.parse(setup.stdin[0]!)).toMatchObject({
      workspaceName: "feature-x",
      reopened: false,
    });
  });

  it("fires on a reopen too, with the same branch/base rules", async () => {
    const setup = createTestSetup({
      hooks: { [EVENT_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await reopenWorkspace(setup, { branch: null, metadata: { base: "develop" } });
    await settle();

    const input = JSON.parse(setup.stdin[0]!) as Record<string, unknown>;
    expect(input).toMatchObject({ reopened: true, base: "develop" });
    expect(input).not.toHaveProperty("branch");
  });

  it("raises no notification when it fails", async () => {
    const setup = createTestSetup({
      hooks: { [EVENT_HOOK]: { exitCode: 1 } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);
    await settle();

    expect(setup.notifications).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("offers after-worktree-created for cancel while it runs, and only then", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { hangs: true } },
      trusted: { [PROJECT_ROOT]: true },
    });
    const opening = openWorkspace(setup);

    const hook = await untilHookRunning(setup);
    expect(hook).toMatchObject({
      entry: "after-worktree-created",
      phase: "open",
      workspaceName: "feature-x",
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_ROOT,
    });

    hook.cancel();
    await opening;
    expect(setup.runningHooks).toEqual([]);
  });

  it("kills a canceled open hook and opens the workspace without it, loudly", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { hangs: true }, [OPEN_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    const opening = openWorkspace(setup);
    (await untilHookRunning(setup)).cancel();
    await opening;

    expect(setup.killedCount()).toBe(1);
    expect(setup.notifications).toContainEqual(
      expect.objectContaining({
        type: "error",
        title: "Repository hook failed",
        message: "after-worktree-created was canceled",
      })
    );
    // Not fatal: the open went on — before-workspace-opened ran after it.
    expect(setup.createdEvents).toHaveLength(1);
    expect(setup.stdin).toHaveLength(2);
  });

  it("opens a workspace whose before-workspace-opened was canceled, without env", async () => {
    const setup = createTestSetup({
      hooks: { [OPEN_HOOK]: { hangs: true } },
      trusted: { [PROJECT_ROOT]: true },
    });
    const opening = reopenWorkspace(setup);
    (await untilHookRunning(setup)).cancel();
    await opening;

    expect(setup.createdEvents).toHaveLength(1);
    expect(setup.agentStartEnv).toEqual([{}]);
    expect(setup.notifications.map((n) => n.message)).toContain(
      "before-workspace-opened was canceled"
    );
  });

  it("fails a deletion closed when its before-worktree-deleted is canceled", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: { hangs: true } },
      trusted: { [PROJECT_ROOT]: true },
    });
    const deleting = deleteWorkspace(setup);

    const hook = await untilHookRunning(setup);
    expect(hook).toMatchObject({ entry: "before-worktree-deleted", phase: "delete" });
    hook.cancel();
    await deleting;

    expect(setup.killedCount()).toBe(1);
    expect(setup.runningHooks).toEqual([]);
    const last = setup.progress.at(-1)!.payload;
    expect(last).toMatchObject({ completed: true, hasErrors: true });
    expect(last.operations.find((op) => op.id === "repo-hook")).toMatchObject({
      status: "error",
      error: "before-worktree-deleted was canceled",
    });
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });
});

describe("which file is the hook", () => {
  it("prefers the file suffixed for this platform over the unsuffixed one", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {}, [`${SETUP_HOOK}.win.cmd`]: {} },
      trusted: { [PROJECT_ROOT]: true },
      platform: "win32",
    });
    await openWorkspace(setup);

    expect(setup.spawned).toHaveLength(1);
    expect(setup.spawned[0]).toContain(`${SETUP_HOOK}.win.cmd`);
  });

  it("runs the unsuffixed file where no file is suffixed for this platform", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {}, [`${SETUP_HOOK}.win.cmd`]: {} },
      trusted: { [PROJECT_ROOT]: true },
      platform: "linux",
    });
    await openWorkspace(setup);

    expect(setup.spawned).toHaveLength(1);
    expect(setup.spawned[0]).toMatch(new RegExp(`${SETUP_HOOK}['"]`));
  });

  it("never runs a file suffixed for another platform", async () => {
    const setup = createTestSetup({
      hooks: { [`${SETUP_HOOK}.mac.sh`]: {}, [`${SETUP_HOOK}.win.cmd`]: {} },
      trusted: { [PROJECT_ROOT]: true },
      platform: "linux",
    });
    await openWorkspace(setup);

    expect(setup.spawned).toEqual([]);
    expect(setup.notifications).toEqual([]);
  });

  it("runs nothing and names the files when two claim one entry", async () => {
    const setup = createTestSetup({
      hooks: { [`${SETUP_HOOK}.sh`]: {}, [`${SETUP_HOOK}.bak`]: {} },
      trusted: { [PROJECT_ROOT]: true },
      platform: "linux",
    });
    await openWorkspace(setup);

    // `.bak` sorts first and used to win in silence.
    expect(setup.spawned).toEqual([]);
    const failure = setup.notifications.find((n) => n.type === "error");
    expect(failure?.message).toContain("after-worktree-created.bak, after-worktree-created.sh");
    expect(setup.createdEvents).toHaveLength(1);
  });

  it("counts two files suffixed for the same platform as ambiguous too", async () => {
    const setup = createTestSetup({
      hooks: { [`${SETUP_HOOK}.win.cmd`]: {}, [`${SETUP_HOOK}.win.bat`]: {}, [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
      platform: "win32",
    });
    await openWorkspace(setup);

    expect(setup.spawned).toEqual([]);
    expect(setup.notifications.map((n) => n.message)).toContainEqual(
      expect.stringContaining("after-worktree-created.win.bat, after-worktree-created.win.cmd")
    );
  });

  it("fails a deletion closed when its gate is ambiguous", async () => {
    const setup = createTestSetup({
      hooks: { [`${DELETE_HOOK}.sh`]: {}, [`${DELETE_HOOK}.py`]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    expect(setup.spawned).toEqual([]);
    const last = setup.progress.at(-1)!.payload;
    expect(last.hasErrors).toBe(true);
    expect(last.operations.find((op) => op.id === "repo-hook")?.error).toContain(
      "several files claim it"
    );
    expect(last.operations.find((op) => op.id === "cleanup-workspace")?.status).toBe("pending");
  });

  it("lets a deletion through an ambiguous gate the project answered Never", async () => {
    const setup = createTestSetup({
      hooks: { [`${DELETE_HOOK}.sh`]: {}, [`${DELETE_HOOK}.py`]: {} },
      trusted: { [PROJECT_ROOT]: false },
    });
    await deleteWorkspace(setup);

    expect(setup.progress.at(-1)!.payload.hasErrors).toBe(false);
  });

  it("reports an ambiguous on-workspace-opened, though nothing waits on it", async () => {
    const setup = createTestSetup({
      hooks: { [`${EVENT_HOOK}.sh`]: {}, [`${EVENT_HOOK}.bak`]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);
    await settle();

    expect(setup.spawned).toEqual([]);
    expect(setup.notifications.map((n) => n.type)).toEqual(["error"]);
  });

  it("does not let a directory claim the entry from a real file", async () => {
    const setup = createTestSetup({
      hooks: { [`${SETUP_HOOK}.sh`]: {} },
      hookDirectories: [`${HOOKS_DIR}/after-worktree-created.d`],
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.spawned).toHaveLength(1);
    expect(setup.spawned[0]).toContain(`${SETUP_HOOK}.sh`);
  });
});

describe("hook output", () => {
  it("logs a hook's stderr at warn, when it succeeds too", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { stderr: "installed 42 packages" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.logger.getMessagesByLevel("warn")).toContainEqual(
      expect.objectContaining({
        message: "hook",
        context: { entry: "after-worktree-created", line: "installed 42 packages" },
      })
    );
  });

  it("expects the editor on every open, so output is held for it", async () => {
    const setup = createTestSetup();
    await reopenWorkspace(setup);

    expect(setup.sinkCalls).toContainEqual({ call: "opening", workspacePath: WORKSPACE_PATH });
  });

  it("holds no output for a deletion gate, whose editor is already gone", async () => {
    const setup = createTestSetup({
      hooks: { [DELETE_HOOK]: { stderr: "checking the lock" } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await deleteWorkspace(setup);

    // `closed` came before the hook wrote anything.
    expect(setup.sinkCalls[0]).toEqual({ call: "closed", workspacePath: WORKSPACE_PATH });
    expect(setup.sinkLines).toEqual([
      { entry: "before-worktree-deleted", line: "checking the lock" },
    ]);
  });

  it("drops a deleted workspace's output", async () => {
    const setup = createTestSetup();
    await deleteWorkspace(setup);
    await settle();

    expect(setup.sinkCalls).toContainEqual({ call: "closed", workspacePath: WORKSPACE_PATH });
  });
});

describe("trust", () => {
  it("asks before running an untrusted repository's hook", async () => {
    const setup = createTestSetup({ hooks: { [SETUP_HOOK]: {} } });
    await openWorkspace(setup);

    expect(setup.dialogs).toHaveLength(1);
    expect(setup.dialogs[0]!.needsAttention).toBe(true);
    expect(setup.stdin).toHaveLength(1);
  });

  it("names the workspace and its project, so a still-creating row can be marked", async () => {
    const setup = createTestSetup({ hooks: { [SETUP_HOOK]: {} } });
    await openWorkspace(setup);

    expect(setup.dialogOptions[0]).toMatchObject({
      workspacePath: WORKSPACE_PATH,
      projectPath: PROJECT_ROOT,
    });
  });

  it("does not run the hook when the answer is Skip", async () => {
    const setup = createTestSetup({ hooks: { [SETUP_HOOK]: {} }, trustAnswer: "skip" });
    await openWorkspace(setup);

    expect(setup.stdin).toHaveLength(0);
  });

  it("never asks again once answered Never", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: false },
    });
    await openWorkspace(setup);

    expect(setup.dialogs).toHaveLength(0);
    expect(setup.stdin).toHaveLength(0);
  });
});

describe("kill switch", () => {
  it("runs nothing when hooks.enabled is false", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
      enabled: false,
    });
    await openWorkspace(setup);

    expect(setup.stdin).toHaveLength(0);
  });
});
