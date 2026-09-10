// @vitest-environment node
/**
 * Integration tests for the repository-hooks module.
 *
 * Runs against the real OpenWorkspaceOperation and DeleteWorkspaceOperation so
 * the assertions cover the seams that actually matter: a hook's returned
 * environment reaching `envVars`, its title and tags folding into the
 * `workspace:created` snapshot, and a refusal stopping the deletion pipeline
 * before the worktree is removed.
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
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
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
import { projPath, wsPath } from "../../shared/test-fixtures";
import { Path } from "../../utils/path/path";
import { createHooksModule } from "./module";
import type { HookOutputSink } from "./runner";

const PROJECT_ROOT = projPath("/project");
const PROJECT_ID = "project-ea0135bc" as ProjectId;
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_URL = "http://127.0.0.1:25448/?folder=/workspaces/feature-x";

const SETUP_HOOK = "/workspaces/feature-x/.codehydra/hooks/after-worktree-created";
const DELETE_HOOK = "/workspaces/feature-x/.codehydra/hooks/before-worktree-deleted";
const EVENT_HOOK = "/workspaces/feature-x/.codehydra/events/on-workspace-created";

interface SpawnOutcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface TestSetup {
  readonly dispatcher: Dispatcher;
  readonly createdEvents: WorkspaceCreatedEvent[];
  readonly progress: WorkspaceDeletionProgressEvent[];
  /** envVars the finalize hook point saw — i.e. what a hook's `env` produced. */
  readonly finalizeEnv: Array<Record<string, string>>;
  readonly notifications: NotificationConfig[];
  readonly dialogs: DialogConfig[];
  readonly sinkLines: Array<{ entry: string; line: string }>;
  /** Metadata written through the real SetMetadataOperation, in order. */
  readonly metadataWrites: Array<{ key: string; value: string | null }>;
  /** Answer the next trust dialog with this action id. */
  answerTrust(actionId: string): void;
  /** Text each spawn was handed on stdin, in order. */
  readonly stdin: string[];
}

interface SetupOptions {
  /** Files present under the worktree. Keys are absolute paths. */
  readonly hooks?: Record<string, SpawnOutcome>;
  readonly enabled?: boolean;
  /** Seeds `hooks.trusted`; absent means the gate will ask. */
  readonly trusted?: Record<string, boolean>;
  /** Action id the trust dialog answers with. Default: Always. */
  readonly trustAnswer?: string;
  readonly keepFilesPresent?: boolean;
}

function createTestSetup(options?: SetupOptions): TestSetup {
  const dispatcher = createMockDispatcher();
  const createdEvents: WorkspaceCreatedEvent[] = [];
  const progress: WorkspaceDeletionProgressEvent[] = [];
  const finalizeEnv: Array<Record<string, string>> = [];
  const notifications: NotificationConfig[] = [];
  const dialogs: DialogConfig[] = [];
  const sinkLines: Array<{ entry: string; line: string }> = [];
  const metadataWrites: Array<{ key: string; value: string | null }> = [];
  const stdin: string[] = [];
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
  if (options?.keepFilesPresent) {
    entries[`${PROJECT_ROOT}/.keepfiles`] = file(".env\n");
  }

  const fileSystem = createFileSystemMock({ entries });

  const processRunner = createMockProcessRunner({
    onSpawn: (command) => {
      const match = Object.entries(hookFiles).find(([path]) => command.includes(path));
      const outcome = match?.[1] ?? {};
      return {
        exitCode: outcome.exitCode ?? 0,
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
      };
    },
  });

  const sink: HookOutputSink = {
    write: (_workspacePath, entry, line) => sinkLines.push({ entry, line }),
  };

  const ui = {
    dialog: (config: DialogConfig) => {
      dialogs.push(config);
      return makeDialogStub(() => trustAnswer);
    },
    notification: (config: NotificationConfig) => {
      notifications.push(config);
      return { id: "n1", update: () => {}, close: () => {}, onEvent: () => () => {} };
    },
  };

  // Stands in for the git-worktree / agent / ide-server hooks on workspace:open,
  // and records the environment the hook contributed.
  const openWorkspaceHost: IntentModule = {
    name: "test-open-workspace-host",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (): Promise<HookOutput<CreateHookResult>> => ({
            result: {
              workspacePath: WORKSPACE_PATH,
              branch: "feature-x",
              metadata: { base: "main" },
              resolvedBase: "main",
            },
          }),
        },
        finalize: {
          handler: async (ctx: HookContext): Promise<HookOutput<FinalizeHookResult>> => {
            finalizeEnv.push({ ...(ctx as FinalizeHookInput).envVars });
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
      logger: SILENT_LOGGER,
      config: createMockConfig({ defaults: { "hooks.enabled": options?.enabled ?? true } }),
      stateService: createMockState({
        values: { "hooks.trusted": options?.trusted ?? {} },
      }),
      dispatcher,
      ui,
      binDir: new Path("/data/bin"),
      sink,
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
    notifications,
    dialogs,
    sinkLines,
    metadataWrites,
    stdin: stdinProxy,
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

  it("merges returned env into the workspace environment", async () => {
    const setup = createTestSetup({
      hooks: {
        [SETUP_HOOK]: { stdout: JSON.stringify({ env: { DATABASE_URL: "postgres://x" } }) },
      },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    expect(setup.finalizeEnv[0]).toMatchObject({ DATABASE_URL: "postgres://x" });
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
    expect(setup.notifications.map((n) => n.type)).toContain("error");
  });

  it("rejects output that is not the declared shape", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: { stdout: JSON.stringify({ envs: { A: "1" } }) } },
      trusted: { [PROJECT_ROOT]: true },
    });
    await openWorkspace(setup);

    // A misspelled key must not be dropped in silence — an environment that
    // quietly never arrived is the worst version of this failure.
    expect(setup.notifications.map((n) => n.title)).toContain("Repository hook failed");
    expect(setup.finalizeEnv[0]).toEqual({});
  });

  it("does not run for a re-opened workspace", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
    });
    await setup.dispatcher.dispatch<OpenWorkspaceIntent>({
      type: INTENT_OPEN_WORKSPACE,
      payload: {
        ...openPayload(),
        existingWorkspace: {
          path: WORKSPACE_PATH,
          name: "feature-x",
          branch: "feature-x",
          metadata: { base: "main" },
        },
      },
    });
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

describe("on-workspace-created", () => {
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

describe("trust", () => {
  it("asks before running an untrusted repository's hook", async () => {
    const setup = createTestSetup({ hooks: { [SETUP_HOOK]: {} } });
    await openWorkspace(setup);

    expect(setup.dialogs).toHaveLength(1);
    expect(setup.dialogs[0]!.needsAttention).toBe(true);
    expect(setup.stdin).toHaveLength(1);
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

describe("kill switch and migration", () => {
  it("runs nothing when hooks.enabled is false", async () => {
    const setup = createTestSetup({
      hooks: { [SETUP_HOOK]: {} },
      trusted: { [PROJECT_ROOT]: true },
      enabled: false,
    });
    await openWorkspace(setup);

    expect(setup.stdin).toHaveLength(0);
  });

  it("warns once about a stale .keepfiles instead of copying it", async () => {
    const setup = createTestSetup({ keepFilesPresent: true });
    await openWorkspace(setup);
    await openWorkspace(setup);

    const warnings = setup.notifications.filter((n) =>
      n.title.includes(".keepfiles is no longer supported")
    );
    expect(warnings).toHaveLength(1);
  });
});
