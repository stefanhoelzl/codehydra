// @vitest-environment node
/**
 * Integration tests for the auto-tagging module.
 *
 * Runs against the real OpenWorkspaceOperation, SetMetadataOperation and
 * SwitchWorkspaceOperation so the assertions cover the actual seam the feature
 * depends on: a setup-hook metadata write folding into the workspace:created
 * payload, and workspace:switched clearing the tag.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import {
  registerTestInfrastructure,
  createTestViewManager,
  type TestViewManagerHarness,
} from "../intents/operations.test-utils";
import {
  OpenWorkspaceOperation,
  OPEN_WORKSPACE_OPERATION_ID,
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type OpenWorkspacePayload,
  type CreateHookResult,
  type FinalizeHookResult,
  type WorkspaceCreatedEvent,
} from "../intents/open-workspace";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
  type SetMetadataIntent,
} from "../intents/set-metadata";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "../intents/switch-workspace";
import {
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  type GetActiveWorkspaceHookResult,
} from "../intents/get-active-workspace";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { createAutoTaggingModule } from "./auto-tagging-module";

const PROJECT_ROOT = "/project";
const PROJECT_ID = "project-ea0135bc" as ProjectId;
const WORKSPACE_PATH = "/workspaces/feature-x";
const OTHER_WORKSPACE_PATH = "/workspaces/feature-y";
const WORKSPACE_URL = "http://127.0.0.1:25448/?folder=/workspaces/feature-x";
const NEW_TAG_KEY = "tags.new";
const NEW_TAG_VALUE = JSON.stringify({ color: "#3498db" });

interface TestSetup {
  readonly dispatcher: Dispatcher;
  /** Metadata written through the real SetMetadataOperation's "set" hook. */
  readonly metadata: Map<string, Map<string, string>>;
  /** Every set-metadata intent that reached the operation, in order. */
  readonly writes: Array<{ workspacePath: string; key: string; value: string | null }>;
  readonly createdEvents: WorkspaceCreatedEvent[];
  readonly views: TestViewManagerHarness;
}

function metadataFor(setup: TestSetup, workspacePath: string): Record<string, string> {
  return Object.fromEntries(setup.metadata.get(workspacePath) ?? new Map());
}

function createTestSetup(options?: { enabled?: boolean; activeWorkspace?: string }): TestSetup {
  const dispatcher = createMockDispatcher();
  const metadata = new Map<string, Map<string, string>>();
  const writes: TestSetup["writes"] = [];
  const createdEvents: WorkspaceCreatedEvent[] = [];
  const views = createTestViewManager(options?.activeWorkspace ?? null);

  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: string) => ({
      projectPath: PROJECT_ROOT,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
    }),
    projects: { [PROJECT_ROOT]: { projectId: PROJECT_ID } },
    viewManager: views.viewManager,
  });

  dispatcher.registerOperation(new OpenWorkspaceOperation());
  dispatcher.registerOperation(new SetMetadataOperation());

  // get-active-workspace, driven by the view manager so it stays live across
  // switches (registerTestInfrastructure only wires a static ref).
  const activeWorkspaceModule: IntentModule = {
    name: "test-active-workspace",
    hooks: {
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<HookOutput<GetActiveWorkspaceHookResult>> => {
            const path = views.activeWorkspace.path;
            return {
              result: {
                workspaceRef:
                  path === null
                    ? null
                    : {
                        projectId: PROJECT_ID,
                        workspaceName: path.slice(path.lastIndexOf("/") + 1) as WorkspaceName,
                        path,
                      },
              },
            };
          },
        },
      },
    },
  };

  // Stands in for GitWorktreeProvider: the branch-config store the tag lands in.
  const metadataStoreModule: IntentModule = {
    name: "test-metadata-store",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<void> => {
            const { payload } = ctx.intent as SetMetadataIntent;
            writes.push({ ...payload });
            const store = metadata.get(payload.workspacePath) ?? new Map<string, string>();
            if (payload.value === null) store.delete(payload.key);
            else store.set(payload.key, payload.value);
            metadata.set(payload.workspacePath, store);
          },
        },
      },
    },
  };

  // Stands in for the git-worktree / agent / ide-server hooks on workspace:open.
  const openWorkspaceHostModule: IntentModule = {
    name: "test-open-workspace-host",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        create: {
          handler: async (ctx: HookContext): Promise<HookOutput<CreateHookResult>> => {
            const { payload } = ctx.intent as OpenWorkspaceIntent;
            const existing = payload.existingWorkspace;
            const workspacePath = existing?.path ?? WORKSPACE_PATH;
            return {
              result: {
                workspacePath,
                branch: existing?.branch ?? "feature-x",
                metadata: existing?.metadata ?? { base: "main" },
                resolvedBase: "main",
              },
            };
          },
        },
        finalize: {
          handler: async (): Promise<HookOutput<FinalizeHookResult>> => ({
            result: { workspaceUrl: WORKSPACE_URL },
          }),
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          createdEvents.push(event as WorkspaceCreatedEvent);
        },
      },
    },
  };

  dispatcher.registerModule(activeWorkspaceModule);
  dispatcher.registerModule(metadataStoreModule);
  dispatcher.registerModule(openWorkspaceHostModule);
  dispatcher.registerModule(
    createAutoTaggingModule({
      dispatcher,
      configService: createMockConfig({ defaults: { "auto-tag.new": options?.enabled ?? true } }),
      logger: SILENT_LOGGER,
    })
  );

  return { dispatcher, metadata, writes, createdEvents, views };
}

/**
 * Lets fire-and-forget event subscribers finish.
 *
 * Operations emit domain events without awaiting them (`ctx.emit`), so a
 * subscriber's own dispatch — the tag write here — settles after the originating
 * dispatch resolves. Draining the macrotask queue a few times covers the
 * emit → handler → dispatch → hook chain.
 */
async function flushEvents(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Switches, then lets the workspace:switched subscribers run. */
async function switchTo(setup: TestSetup, workspacePath: string | null): Promise<void> {
  await setup.dispatcher.dispatch({
    type: INTENT_SWITCH_WORKSPACE,
    payload: { workspacePath },
  } as SwitchWorkspaceIntent);
  await flushEvents();
}

function openIntent(payload: Partial<OpenWorkspacePayload> = {}): OpenWorkspaceIntent {
  return {
    type: INTENT_OPEN_WORKSPACE,
    payload: {
      projectPath: PROJECT_ROOT,
      workspaceName: "feature-x",
      base: "main",
      ...payload,
    },
  } as OpenWorkspaceIntent;
}

describe("AutoTaggingModule", () => {
  describe("tagging background creations", () => {
    it("tags a background create and carries the tag in the workspace:created event", async () => {
      // An active workspace means the operation won't switch — the realistic
      // background case (an agent creating a workspace while you work elsewhere).
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });

      const workspace = await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBe(NEW_TAG_VALUE);
      // The event's metadata is what builds the sidebar row, so the tag has to be
      // in it — a write alone would not surface until a restart re-read git config.
      expect(setup.createdEvents[0]?.payload.metadata[NEW_TAG_KEY]).toBe(NEW_TAG_VALUE);
      expect(setup.createdEvents[0]?.payload.metadata["base"]).toBe("main");
      // The operation's return value reports the same metadata as the event.
      expect(workspace.metadata[NEW_TAG_KEY]).toBe(NEW_TAG_VALUE);
    });

    it("does not tag a foreground create (stealFocus omitted)", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });

      await setup.dispatcher.dispatch(openIntent());

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
      expect(setup.writes).toHaveLength(0);
    });

    it("does not tag when stealFocus is true", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });

      await setup.dispatcher.dispatch(openIntent({ stealFocus: true }));

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
    });

    it("does not tag an existing workspace (wake / startup re-discovery)", async () => {
      // project:open and workspace:wake both re-run workspace:open with
      // stealFocus false; neither is a new workspace.
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });

      await setup.dispatcher.dispatch(
        openIntent({
          stealFocus: false,
          existingWorkspace: {
            path: WORKSPACE_PATH,
            name: "feature-x",
            branch: "feature-x",
            metadata: { base: "main" },
          },
        })
      );

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
      expect(setup.writes).toHaveLength(0);
    });

    it("does not tag when auto-tag.new is off", async () => {
      const setup = createTestSetup({
        enabled: false,
        activeWorkspace: OTHER_WORKSPACE_PATH,
      });

      await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
      expect(setup.createdEvents[0]?.payload.metadata[NEW_TAG_KEY]).toBeUndefined();
    });

    it("tags then clears when nothing is active, since the operation switches anyway", async () => {
      // stealFocus false still switches when no workspace is active, so the user
      // lands on the workspace and the tag self-corrects rather than lying.
      const setup = createTestSetup();

      await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));
      await flushEvents();

      expect(setup.writes.map((w) => w.value)).toEqual([NEW_TAG_VALUE, null]);
      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
    });
  });

  describe("clearing on switch", () => {
    it("clears the tag on the first switch to a tagged workspace", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });
      await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));
      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBe(NEW_TAG_VALUE);

      await switchTo(setup, WORKSPACE_PATH);

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
      expect(setup.writes.at(-1)).toEqual({
        workspacePath: WORKSPACE_PATH,
        key: NEW_TAG_KEY,
        value: null,
      });
    });

    it("does not write on a switch to an untagged workspace", async () => {
      // Keyboard nav switches on every arrow key; an untagged workspace must not
      // spawn a git process.
      const setup = createTestSetup({ activeWorkspace: WORKSPACE_PATH });

      await switchTo(setup, OTHER_WORKSPACE_PATH);

      expect(setup.writes).toHaveLength(0);
    });

    it("clears the tag only once across repeated switches", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });
      await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));

      await switchTo(setup, WORKSPACE_PATH);
      await switchTo(setup, OTHER_WORKSPACE_PATH);
      await switchTo(setup, WORKSPACE_PATH);

      expect(setup.writes.filter((w) => w.value === null)).toHaveLength(1);
    });

    it("clears a tag written by an earlier run (survives restart)", async () => {
      // Startup re-discovery replays workspace:created with the metadata read from
      // git config; that is what re-seeds the tracking set.
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });
      setup.metadata.set(WORKSPACE_PATH, new Map([[NEW_TAG_KEY, NEW_TAG_VALUE]]));

      await setup.dispatcher.dispatch(
        openIntent({
          stealFocus: false,
          existingWorkspace: {
            path: WORKSPACE_PATH,
            name: "feature-x",
            branch: "feature-x",
            metadata: { base: "main", [NEW_TAG_KEY]: NEW_TAG_VALUE },
          },
        })
      );

      await switchTo(setup, WORKSPACE_PATH);

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
    });

    it("still clears tags when auto-tag.new is off", async () => {
      // Config gates tagging only — turning it off must not strand a tag.
      const setup = createTestSetup({ enabled: false, activeWorkspace: OTHER_WORKSPACE_PATH });
      setup.metadata.set(WORKSPACE_PATH, new Map([[NEW_TAG_KEY, NEW_TAG_VALUE]]));

      await setup.dispatcher.dispatch(
        openIntent({
          stealFocus: false,
          existingWorkspace: {
            path: WORKSPACE_PATH,
            name: "feature-x",
            branch: "feature-x",
            metadata: { [NEW_TAG_KEY]: NEW_TAG_VALUE },
          },
        })
      );
      await switchTo(setup, WORKSPACE_PATH);

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
    });

    it("ignores a deselect (null switched payload)", async () => {
      const setup = createTestSetup({ activeWorkspace: WORKSPACE_PATH });

      await expect(
        setup.dispatcher.dispatch({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspacePath: null },
        } as SwitchWorkspaceIntent)
      ).resolves.not.toThrow();
    });
  });

  describe("manual tag edits", () => {
    it("does not re-clear a tag the user removed by hand", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });
      await setup.dispatcher.dispatch(openIntent({ stealFocus: false }));

      // Simulates sidekick/MCP deleting the tag.
      await setup.dispatcher.dispatch({
        type: INTENT_SET_METADATA,
        payload: { workspacePath: WORKSPACE_PATH, key: NEW_TAG_KEY, value: null },
      } as SetMetadataIntent);
      await flushEvents();
      const writesBeforeSwitch = setup.writes.length;

      await switchTo(setup, WORKSPACE_PATH);

      expect(setup.writes).toHaveLength(writesBeforeSwitch);
    });

    it("clears a tag the user added by hand", async () => {
      const setup = createTestSetup({ activeWorkspace: OTHER_WORKSPACE_PATH });

      await setup.dispatcher.dispatch({
        type: INTENT_SET_METADATA,
        payload: { workspacePath: WORKSPACE_PATH, key: NEW_TAG_KEY, value: NEW_TAG_VALUE },
      } as SetMetadataIntent);
      await flushEvents();

      await switchTo(setup, WORKSPACE_PATH);

      expect(metadataFor(setup, WORKSPACE_PATH)[NEW_TAG_KEY]).toBeUndefined();
    });
  });
});
