// @vitest-environment node
/**
 * Integration tests for app:ready operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook execution.
 * The app:ready operation collects project paths from modules, dispatches
 * project:open for each, and emits EVENT_APP_STARTED.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  AppReadyOperation,
  INTENT_APP_READY,
  APP_READY_OPERATION_ID,
  EVENT_APP_STARTED,
} from "./app-ready";
import type { AppReadyIntent, LoadProjectsResult } from "./app-ready";
import { INTENT_OPEN_PROJECT } from "./open-project";
import type { OpenProjectIntent } from "./open-project";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Project } from "../../shared/api/types";

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

function createProjectModule(projectPaths: readonly string[]): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_READY_OPERATION_ID]: {
        "load-projects": {
          handler: async (): Promise<LoadProjectsResult> => {
            return { projectPaths };
          },
        },
      },
    },
  };
}

function createProjectOpenStub(
  state: TestState,
  options?: { failForPath?: string }
): Operation<OpenProjectIntent, Project> {
  return {
    id: "open-project",
    async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project> {
      const pathStr = ctx.intent.payload.path?.toString() ?? "";
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
  stub: Operation<OpenProjectIntent, Project>
): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_READY, new AppReadyOperation());
  dispatcher.registerOperation(INTENT_OPEN_PROJECT, stub);

  for (const m of modules) dispatcher.registerModule(m);

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
        [createProjectModule(["/project-a", "/project-b"])],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual(["/project-a", "/project-b"]);
    });

    it("merges paths from multiple modules", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [createProjectModule(["/project-a"]), createProjectModule(["/project-b"])],
        stub
      );

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual(["/project-a", "/project-b"]);
    });

    it("skips invalid projects without aborting", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state, { failForPath: "/invalid" });
      const { dispatcher } = createTestSetup([createProjectModule(["/invalid", "/valid"])], stub);

      await dispatcher.dispatch(appReadyIntent());

      expect(state.openedProjectPaths).toEqual(["/valid"]);
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

  describe("app:started event", () => {
    it("emits app:started after project:open dispatches complete", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [createProjectModule(["/project-a", "/project-b"])],
        stub
      );

      dispatcher.subscribe(EVENT_APP_STARTED, () => {
        state.executionOrder.push("app:started");
      });

      await dispatcher.dispatch(appReadyIntent());

      expect(state.executionOrder).toEqual([
        "project-open:/project-a",
        "project-open:/project-b",
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
              handler: async (): Promise<LoadProjectsResult> => {
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
