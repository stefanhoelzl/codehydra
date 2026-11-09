// @vitest-environment node
/**
 * Integration tests for app:ready operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook execution.
 * The app:ready operation collects project paths from modules, dispatches
 * project:open for each, and emits EVENT_APP_STARTED.
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { projPath, testPath } from "../shared/test-fixtures";
import { Dispatcher } from "./lib/dispatcher";

import {
  AppReadyOperation,
  INTENT_APP_READY,
  APP_READY_OPERATION_ID,
  EVENT_APP_STARTED,
} from "./app-ready";
import type { AppReadyIntent, LoadProjectsResult, RestoreProjectResult } from "./app-ready";
import { defineHooks } from "./declarations";
import { INTENT_OPEN_PROJECT } from "./open-project";
import type { OpenProjectIntent } from "./open-project";
import type { IntentModule } from "./lib/module";
import { z } from "zod/v4";
import type { HookOutput, Operation, OperationSchemas } from "./lib/operation";
import type { Project } from "../shared/api/types";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { projectSchema } from "./contract";
import { Path } from "../utils/path/path";

// =============================================================================
// Test Helpers
// =============================================================================

interface TestState {
  openedProjectPaths: string[];
  executionOrder: string[];
}

function createTestState(): TestState {
  return {
    openedProjectPaths: [],
    executionOrder: [],
  };
}

/** The project type the test restorer answers for. */
const TEST_TYPE = "test";

/** A store stand-in: saved projects of `type`, each described by its path. */
function createProjectModule(projectPaths: readonly string[], type = TEST_TYPE): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_READY_OPERATION_ID]: {
        "load-projects": {
          handler: async (): Promise<HookOutput<LoadProjectsResult>> => {
            return {
              result: { projects: projectPaths.map((path) => ({ type, config: { path } })) },
            };
          },
        },
      },
    },
  };
}

/**
 * A type module stand-in: restores saved projects of TEST_TYPE by their path,
 * and throws for one whose config says so.
 */
function createRestorerModule(): IntentModule {
  return {
    name: "test-restorer",
    hooks: defineHooks({
      [APP_READY_OPERATION_ID]: {
        restore: {
          handler: async (ctx): Promise<HookOutput<RestoreProjectResult>> => {
            if (ctx.type !== TEST_TYPE) return { result: {} };
            if (ctx.config.broken === true) throw new Error("Unreadable record");
            const path = ctx.config.path;
            if (typeof path !== "string") return { result: {} };
            return { result: { payload: { path: projPath(path) } } };
          },
        },
      },
    }),
  };
}

const openProjectStubSchemas = {
  type: INTENT_OPEN_PROJECT,
  payload: z.unknown(),
  result: projectSchema,
} satisfies OperationSchemas;

function createProjectOpenStub(
  state: TestState,
  /** Matched against the *normalized* payload path the operation receives. */
  options?: { failForPath?: string }
): Operation<typeof openProjectStubSchemas> {
  return {
    id: "open-project",
    schemas: openProjectStubSchemas,
    async execute(ctx): Promise<Project> {
      const payload = ctx.intent.payload as OpenProjectIntent["payload"];
      const pathStr = payload.path?.toString() ?? "";
      if (options?.failForPath === pathStr) {
        throw new Error(`Project not found: ${pathStr}`);
      }
      state.openedProjectPaths.push(pathStr);
      state.executionOrder.push(`project-open:${pathStr}`);
      return {
        id: `id-${pathStr}`,
        path: pathStr,
        name: "test",
        workspaces: [],
      } as unknown as Project;
    },
  };
}

function createTestSetup(
  modules: IntentModule[],
  stub: Operation<typeof openProjectStubSchemas>
): { dispatcher: Dispatcher } {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(
    new AppReadyOperation(createMockAccessor<ConfigAgentType>("agent", "claude"))
  );
  dispatcher.registerOperation(stub);

  for (const m of [createRestorerModule(), ...modules]) dispatcher.registerModule(m);

  return { dispatcher };
}

function appReadyIntent(): AppReadyIntent {
  return {
    type: INTENT_APP_READY,
    payload: {} as AppReadyIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("AppReady Operation", () => {
  describe("project loading", () => {
    it("dispatches project:open for each path from load-projects hooks", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createProjectModule([
            testPath("/project-a").toNative(),
            testPath("/project-b").toNative(),
          ]),
        ],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([
        testPath("/project-a").toString(),
        testPath("/project-b").toString(),
      ]);
    });

    it("merges paths from multiple modules", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createProjectModule([testPath("/project-a").toNative()]),
          createProjectModule([testPath("/project-b").toNative()]),
        ],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([
        testPath("/project-a").toString(),
        testPath("/project-b").toString(),
      ]);
    });

    it("skips invalid projects without aborting", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state, { failForPath: testPath("/invalid").toString() });
      const { dispatcher } = createTestSetup(
        [createProjectModule([testPath("/invalid").toNative(), testPath("/valid").toNative()])],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([testPath("/valid").toString()]);
    });

    it("skips a saved project of a type no module restores", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createProjectModule([testPath("/unknown").toNative()], "unknown-type"),
          createProjectModule([testPath("/known").toNative()]),
        ],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([testPath("/known").toString()]);
    });

    it("skips a saved project whose restore fails, without aborting the rest", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const broken: IntentModule = {
        name: "broken-store",
        hooks: {
          [APP_READY_OPERATION_ID]: {
            "load-projects": {
              handler: async (): Promise<HookOutput<LoadProjectsResult>> => ({
                result: { projects: [{ type: TEST_TYPE, config: { broken: true } }] },
              }),
            },
          },
        },
      };
      const { dispatcher } = createTestSetup(
        [broken, createProjectModule([testPath("/valid").toNative()])],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([testPath("/valid").toString()]);
    });

    it("handles empty project paths", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup([createProjectModule([])], stub);

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([]);
    });

    it("handles no load-projects hooks", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup([], stub);

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual([]);
    });
  });

  describe("parallel dispatch", () => {
    it("dispatches project:open in parallel rather than sequentially", async () => {
      // Each stub execute blocks on a shared latch until all have started.
      // If dispatch were sequential, only one would ever start and the test
      // would deadlock (the latch resolves only after all N start).
      const paths = [
        testPath("/p1").toNative(),
        testPath("/p2").toNative(),
        testPath("/p3").toNative(),
        testPath("/p4").toNative(),
        testPath("/p5").toNative(),
      ];
      const started: string[] = [];
      let resolveLatch!: () => void;
      const latch = new Promise<void>((r) => {
        resolveLatch = r;
      });
      const stub: Operation<typeof openProjectStubSchemas> = {
        id: "open-project",
        schemas: openProjectStubSchemas,
        async execute(ctx): Promise<Project> {
          const payload = ctx.intent.payload as OpenProjectIntent["payload"];
          const p = payload.path?.toString() ?? "";
          started.push(p);
          if (started.length === paths.length) resolveLatch();
          await latch;
          return {
            id: `id-${p}`,
            path: p,
            name: "test",
            workspaces: [],
          } as unknown as Project;
        },
      };
      const { dispatcher } = createTestSetup([createProjectModule(paths)], stub);

      await dispatcher.dispatch(appReadyIntent());

      expect(started).toHaveLength(paths.length);
      // `started` records the normalized payload path, not the native input.
      expect(new Set(started)).toEqual(new Set(paths.map((p) => new Path(p).toString())));
    });
  });

  describe("app:started event", () => {
    it("emits app:started after project:open dispatches complete", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createProjectModule([
            testPath("/project-a").toNative(),
            testPath("/project-b").toNative(),
          ]),
        ],
        stub
      );

      dispatcher.subscribe(EVENT_APP_STARTED, () => {
        state.executionOrder.push("app:started");
      });

      await dispatcher.dispatch(appReadyIntent());

      expect(state.executionOrder).toEqual([
        `project-open:${testPath("/project-a").toString()}`,
        `project-open:${testPath("/project-b").toString()}`,
        "app:started",
      ]);
    });

    it("emits app:started even when no projects to open", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup([], stub);

      let eventFired = false;
      dispatcher.subscribe(EVENT_APP_STARTED, () => {
        eventFired = true;
      });

      await dispatcher.dispatch(appReadyIntent());

      expect(eventFired).toBe(true);
    });
  });

  describe("load-projects hook errors", () => {
    it("propagates load-projects hook errors", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const failingModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_READY_OPERATION_ID]: {
            "load-projects": {
              handler: async (): Promise<HookOutput<LoadProjectsResult>> => {
                throw new Error("Failed to load project configs");
              },
            },
          },
        },
      };
      const { dispatcher } = createTestSetup([failingModule], stub);

      await expect(dispatcher.dispatch(appReadyIntent())).rejects.toThrow(
        "Failed to load project configs"
      );
    });
  });
});
