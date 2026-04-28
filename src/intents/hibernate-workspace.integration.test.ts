/**
 * Smoke integration tests for HibernateWorkspaceOperation and
 * WakeWorkspaceOperation.
 *
 * Verifies the orchestration: resolve → capture → shutdown → set-metadata for
 * hibernate; resolve → set-metadata → cleanup for wake. Uses minimal stub
 * modules that record interactions; no provider boundaries are exercised.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";
import type { IntentModule } from "./lib/module";
import type { DomainEvent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
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
import type { ProjectId, WorkspaceName } from "../shared/api/types";

const PROJECT_PATH = "/test/project";
const PROJECT_ID = Buffer.from(PROJECT_PATH).toString("base64url") as ProjectId;
const WORKSPACE_PATH = "/test/project/workspaces/feature-a";
const WORKSPACE_NAME = "feature-a" as WorkspaceName;

interface Recorder {
  captureCalled: boolean;
  shutdownCalled: boolean;
  releaseCalled: boolean;
  cleanupCalled: boolean;
  callOrder: string[];
  metadataWrites: Array<{ key: string; value: string | null }>;
  events: DomainEvent[];
}

function createRecorder(): Recorder {
  return {
    captureCalled: false,
    shutdownCalled: false,
    releaseCalled: false,
    cleanupCalled: false,
    callOrder: [],
    metadataWrites: [],
    events: [],
  };
}

function createResolveModule(): IntentModule {
  return {
    name: "test-resolve",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveWorkspaceHookResult> => ({
            projectPath: PROJECT_PATH,
            workspaceName: WORKSPACE_NAME,
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
          },
        },
      },
    },
  };
}

function createHibernateHookModule(
  recorder: Recorder,
  opts: { wasActive?: boolean; releaseThrows?: boolean } = {}
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
            return { captured: true };
          },
        },
        shutdown: {
          handler: async (): Promise<HibernateShutdownHookResult> => {
            recorder.shutdownCalled = true;
            recorder.callOrder.push("shutdown");
            return opts.wasActive ? { wasActive: true } : {};
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

function buildHarness(buildHookModules: (recorder: Recorder) => IntentModule[]): {
  dispatcher: Dispatcher;
  recorder: Recorder;
} {
  const recorder = createRecorder();
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_HIBERNATE_WORKSPACE, new HibernateWorkspaceOperation());
  dispatcher.registerOperation(INTENT_WAKE_WORKSPACE, new WakeWorkspaceOperation());

  dispatcher.registerModule(createResolveModule());
  dispatcher.registerModule(createMetadataModule(recorder));
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

  return { dispatcher, recorder };
}

describe("workspace:hibernate", () => {
  it("runs capture + shutdown + release, persists hibernated metadata, emits hibernated event", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [createHibernateHookModule(r)]);

    const intent: HibernateWorkspaceIntent = {
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    await dispatcher.dispatch(intent);

    expect(recorder.captureCalled).toBe(true);
    expect(recorder.shutdownCalled).toBe(true);
    expect(recorder.releaseCalled).toBe(true);
    expect(recorder.callOrder).toEqual(["capture", "shutdown", "release"]);
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

  it("tolerates shutdown errors (silent-on-busy semantics)", async () => {
    const { dispatcher, recorder } = buildHarness(() => [
      {
        name: "tolerant-hibernate-hooks",
        hooks: {
          [HIBERNATE_WORKSPACE_OPERATION_ID]: {
            capture: {
              handler: async (): Promise<CaptureHookResult> => ({ captured: false }),
            },
            shutdown: {
              // Real shutdown handlers swallow errors and return wasActive only;
              // simulate that here to confirm the operation still completes.
              handler: async (): Promise<HibernateShutdownHookResult> => ({}),
            },
          },
        },
      },
    ]);

    const intent: HibernateWorkspaceIntent = {
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    await dispatcher.dispatch(intent);

    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeDefined();
    expect(
      recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATE_FAILED)
    ).toBeUndefined();
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: "true" }]);
  });

  it("hibernate completes when release throws (best-effort)", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [
      createHibernateHookModule(r, { releaseThrows: true }),
    ]);

    const intent: HibernateWorkspaceIntent = {
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    await dispatcher.dispatch(intent);

    expect(recorder.releaseCalled).toBe(true);
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: "true" }]);
    expect(recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATED)).toBeDefined();
    expect(
      recorder.events.find((e) => e.type === EVENT_WORKSPACE_HIBERNATE_FAILED)
    ).toBeUndefined();
  });
});

describe("workspace:wake", () => {
  it("clears hibernated metadata, runs cleanup, emits woken event", async () => {
    const { dispatcher, recorder } = buildHarness((r) => [createWakeHookModule(r)]);

    const intent: WakeWorkspaceIntent = {
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspacePath: WORKSPACE_PATH },
    };
    await dispatcher.dispatch(intent);

    expect(recorder.cleanupCalled).toBe(true);
    expect(recorder.metadataWrites).toEqual([{ key: HIBERNATED_METADATA_KEY, value: null }]);

    const woken = recorder.events.find((e) => e.type === EVENT_WORKSPACE_WOKEN);
    expect(woken).toBeDefined();
  });
});
