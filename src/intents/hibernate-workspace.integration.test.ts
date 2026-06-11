/**
 * Smoke integration tests for HibernateWorkspaceOperation and
 * WakeWorkspaceOperation.
 *
 * Hibernate splits foreground (resolve → capture → set-metadata → optional
 * switch) from background (shutdown → release → emit hibernated). Uses
 * minimal stub modules that record interactions; no provider boundaries
 * are exercised.
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";
import type { IntentModule } from "./lib/module";
import type { DomainEvent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import {
  HibernateWorkspaceOperation,
  HIBERNATE_WORKSPACE_OPERATION_ID,
  INTENT_HIBERNATE_WORKSPACE,
  EVENT_WORKSPACE_HIBERNATED,
  EVENT_WORKSPACE_HIBERNATE_FAILED,
  HIBERNATED_METADATA_KEY,
  type HibernateWorkspaceIntent,
  type CaptureHookResult,
  type HibernateShutdownHookResult,
  type HibernateReleaseHookResult,
  type HibernatePipelineHookInput,
} from "./hibernate-workspace";
import {
  WakeWorkspaceOperation,
  WAKE_WORKSPACE_OPERATION_ID,
  INTENT_WAKE_WORKSPACE,
  EVENT_WORKSPACE_WOKEN,
  type WakeWorkspaceIntent,
  type CleanupHookResult,
  type WakePipelineHookInput,
} from "./wake-workspace";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "./resolve-project";
import {
  SetMetadataOperation,
  INTENT_SET_METADATA,
  SET_METADATA_OPERATION_ID,
  EVENT_METADATA_CHANGED,
  type MetadataChangedEvent,
} from "./set-metadata";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
} from "./switch-workspace";
import { INTENT_GET_METADATA, GET_METADATA_OPERATION_ID } from "./get-metadata";
import {
  INTENT_OPEN_WORKSPACE,
  OPEN_WORKSPACE_OPERATION_ID,
  type OpenWorkspacePayload,
} from "./open-workspace";
import type { ProjectId, WorkspaceName, Workspace } from "../shared/api/types";

const PROJECT_PATH = "/test/project";
const PROJECT_ID = Buffer.from(PROJECT_PATH).toString("base64url") as ProjectId;
const WORKSPACE_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_NAME = "feature-a" as WorkspaceName;
const BRANCH = "feature-a-branch";
const CLEAN_METADATA: Readonly<Record<string, string>> = { base: "main" };
const REOPENED_WORKSPACE: Workspace = {
  projectId: PROJECT_ID,
  name: WORKSPACE_NAME,
  branch: BRANCH,
  metadata: CLEAN_METADATA,
  path: WORKSPACE_PATH,
};

interface Recorder {
  captureCalled: boolean;
  shutdownCalled: boolean;
  releaseCalled: boolean;
  cleanupCalled: boolean;
  switchCalled: boolean;
  callOrder: string[];
  metadataWrites: Array<{ key: string; value: string | null }>;
  events: DomainEvent[];
  openPayload?: OpenWorkspacePayload;
}

function createRecorder(): Recorder {
  return {
    captureCalled: false,
    shutdownCalled: false,
    releaseCalled: false,
    cleanupCalled: false,
    switchCalled: false,
    callOrder: [],
    metadataWrites: [],
    events: [],
  };
}

function createResolveModule(active: boolean): IntentModule {
  return {
    name: "test-resolve",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveWorkspaceHookResult> => ({
            projectPath: PROJECT_PATH,
            workspaceName: WORKSPACE_NAME,
            active,
            branch: BRANCH,
          }),
        },
      },
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveProjectHookResult> => ({
            projectId: PROJECT_ID,
            projectName: "test-project",
          }),
        },
      },
    },
  };
}

function createMetadataModule(recorder: Recorder): IntentModule {
  return {
    name: "test-metadata",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<void> => {
            const intent = ctx.intent as { payload: { key: string; value: string | null } };
            recorder.metadataWrites.push({
              key: intent.payload.key,
              value: intent.payload.value,
            });
            recorder.callOrder.push(`set-metadata:${intent.payload.value ?? "null"}`);
          },
        },
      },
    },
  };
}

function createSwitchModule(recorder: Recorder): IntentModule {
  return {
    name: "test-switch",
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<Record<string, never>> => {
            recorder.switchCalled = true;
            recorder.callOrder.push("switch");
            return {};
          },
        },
      },
    },
  };
}

function createHibernateHookModule(
  recorder: Recorder,
  opts: {
    releaseThrows?: boolean;
    shutdownGate?: Promise<void>;
  } = {}
): IntentModule {
  return {
    name: "test-hibernate-hooks",
    hooks: {
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        capture: {
          handler: async (ctx: HookContext): Promise<CaptureHookResult> => {
            const c = ctx as HibernatePipelineHookInput;
            expect(c.workspacePath).toBe(WORKSPACE_PATH);
            expect(c.projectId).toBe(PROJECT_ID);
            recorder.captureCalled = true;
            recorder.callOrder.push("capture");
            return {};
          },
        },
        shutdown: {
          handler: async (): Promise<HibernateShutdownHookResult> => {
            if (opts.shutdownGate) {
              await opts.shutdownGate;
            }
            recorder.shutdownCalled = true;
            recorder.callOrder.push("shutdown");
            return {};
          },
        },
        release: {
          handler: async (ctx: HookContext): Promise<HibernateReleaseHookResult> => {
            const c = ctx as HibernatePipelineHookInput;
            expect(c.workspacePath).toBe(WORKSPACE_PATH);
            recorder.releaseCalled = true;
            recorder.callOrder.push("release");
            if (opts.releaseThrows) {
              throw new Error("release boom");
            }
            return {};
          },
        },
      },
    },
  };
}

function createWakeHookModule(recorder: Recorder): IntentModule {
  return {
    name: "test-wake-hooks",
    hooks: {
      [WAKE_WORKSPACE_OPERATION_ID]: {
        cleanup: {
          handler: async (ctx: HookContext): Promise<CleanupHookResult> => {
            const c = ctx as WakePipelineHookInput;
            expect(c.workspacePath).toBe(WORKSPACE_PATH);
            recorder.cleanupCalled = true;
            return {};
          },
        },
      },
    },
  };
}

interface HarnessOpts {
  active?: boolean;
}

function buildHarness(
  buildHookModules: (recorder: Recorder) => IntentModule[],
  opts: HarnessOpts = {}
): {
  dispatcher: Dispatcher;
  recorder: Recorder;
  waitForBackground: () => Promise<void>;
} {
  const recorder = createRecorder();
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
  dispatcher.registerOperation(INTENT_HIBERNATE_WORKSPACE, new HibernateWorkspaceOperation());
  dispatcher.registerOperation(INTENT_WAKE_WORKSPACE, new WakeWorkspaceOperation());

  // Mock the get-metadata + open-workspace operations that wake now dispatches
  // internally to bring the workspace back online. (Hibernate never dispatches
  // these, so registering them is harmless for those tests.)
  dispatcher.registerOperation(INTENT_GET_METADATA, {
    id: GET_METADATA_OPERATION_ID,
    execute: async () => CLEAN_METADATA,
  });
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, {
    id: OPEN_WORKSPACE_OPERATION_ID,
    execute: async (ctx) => {
      recorder.openPayload = (ctx.intent as { payload: OpenWorkspacePayload }).payload;
      recorder.callOrder.push("open");
      return REOPENED_WORKSPACE;
    },
  });

  dispatcher.registerModule(createResolveModule(opts.active ?? false));
  dispatcher.registerModule(createMetadataModule(recorder));
  dispatcher.registerModule(createSwitchModule(recorder));
  for (const m of buildHookModules(recorder)) dispatcher.registerModule(m);

  for (const t of [
    EVENT_WORKSPACE_HIBERNATED,
    EVENT_WORKSPACE_HIBERNATE_FAILED,
    EVENT_WORKSPACE_WOKEN,
    EVENT_METADATA_CHANGED,
  ]) {
    dispatcher.subscribe(t, (event) => {
      recorder.events.push(event);
    });
  }

  // Register the backgroundDone resolver AFTER the recorder subscriber so it
  // fires last in the collect loop — guarantees recorder.events has the
  // hibernated event by the time waitForBackground() resolves.
  const backgroundDone = new Promise<void>((resolve) => {
    dispatcher.subscribe(EVENT_WORKSPACE_HIBERNATED, () => resolve());
  });

  return { dispatcher, recorder, waitForBackground: () => backgroundDone };
}

describe("workspace:hibernate", () => {
  it("runs full pipeline, persists hibernated metadata, emits hibernated event", async () => {
    const { dispatcher, recorder, waitForBackground } = buildHarness((r) => [
      createHibernateHookModule(r),
    ]);

    const intent: HibernateWorkspaceIntent = {
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    await dispatcher.dispatch(intent);
    await waitForBackground();

    expect(recorder.captureCalled).toBe(true);
    expect(recorder.shutdownCalled).toBe(true);
    expect(recorder.releaseCalled).toBe(true);
    expect(recorder.switchCalled).toBe(false);
    // Foreground: capture → set-metadata. Background: shutdown → release.
    expect(recorder.callOrder).toEqual(["capture", "set-metadata:true", "shutdown", "release"]);
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: "true" }]);

    const hibernated = recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED);
    expect(hibernated).toBeDefined();
    expect((hibernated as { payload: { workspacePath: string } }).payload.workspacePath).toBe(
      WORKSPACE_PATH
    );

    const metadataChanged = recorder.events.find((e) => e.type === EVENT_METADATA_CHANGED) as
      | MetadataChangedEvent
      | undefined;
    expect(metadataChanged?.payload.key).toBe(HIBERNATED_METADATA_KEY);
    expect(metadataChanged?.payload.value).toBe("true");
  });

  it("dispatches switch in foreground when the workspace was active", async () => {
    const { dispatcher, recorder, waitForBackground } = buildHarness(
      (r) => [createHibernateHookModule(r)],
      { active: true }
    );

    await dispatcher.dispatch({
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    } as HibernateWorkspaceIntent);
    await waitForBackground();

    // Switch happened in foreground, between set-metadata and shutdown.
    expect(recorder.callOrder).toEqual([
      "capture",
      "set-metadata:true",
      "switch",
      "shutdown",
      "release",
    ]);
  });

  it("flips hibernated metadata before background shutdown runs", async () => {
    let releaseShutdown: () => void = () => {};
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });

    const { dispatcher, recorder, waitForBackground } = buildHarness((r) => [
      createHibernateHookModule(r, { shutdownGate }),
    ]);

    await dispatcher.dispatch({
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    } as HibernateWorkspaceIntent);

    // Foreground done: metadata flipped, no shutdown yet.
    expect(recorder.callOrder).toEqual(["capture", "set-metadata:true"]);
    expect(recorder.shutdownCalled).toBe(false);
    expect(recorder.releaseCalled).toBe(false);
    expect(recorder.events.find((e) => e.type === EVENT_METADATA_CHANGED)).toBeDefined();
    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeUndefined();

    releaseShutdown();
    await waitForBackground();

    expect(recorder.callOrder).toEqual(["capture", "set-metadata:true", "shutdown", "release"]);
    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeDefined();
  });

  it("tolerates shutdown handlers that return empty", async () => {
    const { dispatcher, recorder, waitForBackground } = buildHarness(() => [
      {
        name: "tolerant-hibernate-hooks",
        hooks: {
          [HIBERNATE_WORKSPACE_OPERATION_ID]: {
            capture: {
              handler: async (): Promise<CaptureHookResult> => ({}),
            },
            shutdown: {
              handler: async (): Promise<HibernateShutdownHookResult> => ({}),
            },
          },
        },
      },
    ]);

    await dispatcher.dispatch({
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    } as HibernateWorkspaceIntent);
    await waitForBackground();

    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeDefined();
    expect(
      recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATE_FAILED)
    ).toBeUndefined();
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: "true" }]);
  });

  it("hibernate completes when release throws (best-effort)", async () => {
    const { dispatcher, recorder, waitForBackground } = buildHarness((r) => [
      createHibernateHookModule(r, { releaseThrows: true }),
    ]);

    await dispatcher.dispatch({
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    } as HibernateWorkspaceIntent);
    await waitForBackground();

    expect(recorder.releaseCalled).toBe(true);
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: "true" }]);
    // Background failures no longer surface as hibernate-failed — the user
    // already saw the overlay flip in the foreground. workspace:hibernated
    // still fires so the dispatcher's idempotency lock is released.
    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeDefined();
    expect(
      recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATE_FAILED)
    ).toBeUndefined();
  });
});

describe("workspace:wake", () => {
  it("clears hibernated metadata, runs cleanup, reopens, emits woken event", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [createWakeHookModule(r)]);

    const intent: WakeWorkspaceIntent = {
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    const result = await dispatcher.dispatch(intent);

    expect(recorder.cleanupCalled).toBe(true);
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: null }]);

    // Reopen dispatched with the resolved branch and the clean (post-clear)
    // metadata, via the existingWorkspace branch of workspace:open.
    expect(recorder.openPayload).toBeDefined();
    expect(recorder.openPayload?.projectPath).toBe(PROJECT_PATH);
    expect(recorder.openPayload?.workspaceName).toBe(WORKSPACE_NAME);
    expect(recorder.openPayload?.existingWorkspace).toEqual({
      path: WORKSPACE_PATH,
      name: WORKSPACE_NAME,
      branch: BRANCH,
      metadata: CLEAN_METADATA,
    });
    // Metadata is cleared before reopen runs.
    expect(recorder.callOrder).toEqual(["set-metadata:null", "open"]);

    // Returns the reopened workspace.
    expect(result).toEqual(REOPENED_WORKSPACE);

    const woken = recorder.events.find((e) => e.type === EVENT_WORKSPACE_WOKEN);
    expect(woken).toBeDefined();
  });

  it("forwards stealFocus and source to the internal open", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [createWakeHookModule(r)]);

    await dispatcher.dispatch({
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH, stealFocus: false, source: "mcp" },
    } as WakeWorkspaceIntent);

    expect(recorder.openPayload?.stealFocus).toBe(false);
    expect(recorder.openPayload?.source).toBe("mcp");
  });

  it("omits stealFocus/source when the caller does not set them", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [createWakeHookModule(r)]);

    await dispatcher.dispatch({
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    } as WakeWorkspaceIntent);

    expect(recorder.openPayload).toBeDefined();
    expect(recorder.openPayload).not.toHaveProperty("stealFocus");
    expect(recorder.openPayload).not.toHaveProperty("source");
  });
});
