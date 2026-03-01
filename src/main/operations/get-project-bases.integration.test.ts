// @vitest-environment node
/**
 * Integration tests for get-project-bases operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> hooks -> event -> result.
 *
 * Test plan items covered:
 * - Dispatch with list hook returns cached bases
 * - Emits bases:updated domain event with fresh data (after fire-and-forget refresh)
 * - Refresh hook failure does not fail the operation
 * - No refresh when refresh flag is false/omitted
 * - project:resolve failure propagates
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  GetProjectBasesOperation,
  INTENT_GET_PROJECT_BASES,
  GET_PROJECT_BASES_OPERATION_ID,
  EVENT_BASES_UPDATED,
} from "./get-project-bases";
import type {
  GetProjectBasesIntent,
  GetProjectBasesResult,
  ListBasesHookResult,
  BasesUpdatedEvent,
} from "./get-project-bases";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type {
  ResolveHookResult as ResolveProjectHookResult,
  ResolveHookInput as ResolveProjectHookInput,
} from "./resolve-project";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { ProjectId } from "../../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ID = "project-ea0135bc" as ProjectId;
const PROJECT_ROOT = "/project";
const CACHED_BASES = [
  { name: "main", isRemote: false },
  { name: "origin/main", isRemote: true },
] as const;
const FRESH_BASES = [
  { name: "main", isRemote: false },
  { name: "origin/main", isRemote: true },
  { name: "origin/feature-x", isRemote: true },
] as const;

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetupOptions {
  refreshThrows?: boolean;
  freshBases?: readonly { name: string; isRemote: boolean }[];
  unknownProject?: boolean;
}

interface TestSetup {
  dispatcher: Dispatcher;
  refreshCalled: { value: boolean };
}

function createTestSetup(opts?: TestSetupOptions): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_GET_PROJECT_BASES, new GetProjectBasesOperation());

  // Shared project:resolve module
  const resolveProjectModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as ResolveProjectHookInput;
            if (opts?.unknownProject || projectPath !== PROJECT_ROOT) {
              return {};
            }
            return { projectId: PROJECT_ID, projectName: "test" };
          },
        },
      },
    },
  };

  // Track whether refresh was called
  const refreshCalled = { value: false };
  const freshBases = opts?.freshBases ?? FRESH_BASES;

  // List hook returns cached bases (first call) or fresh bases (after refresh)
  let listCallCount = 0;
  const listModule: IntentModule = {
    name: "test",
    hooks: {
      [GET_PROJECT_BASES_OPERATION_ID]: {
        list: {
          handler: async (): Promise<ListBasesHookResult> => {
            listCallCount++;
            // First call returns cached, subsequent calls return fresh
            const bases = listCallCount === 1 ? [...CACHED_BASES] : [...freshBases];
            return { bases, defaultBaseBranch: "main" };
          },
        },
        refresh: {
          handler: async (): Promise<void> => {
            if (opts?.refreshThrows) {
              throw new Error("git fetch failed");
            }
            refreshCalled.value = true;
          },
        },
      },
    },
  };

  dispatcher.registerModule(resolveProjectModule);
  dispatcher.registerModule(listModule);

  return { dispatcher, refreshCalled };
}

function createIntent(
  projectPath = PROJECT_ROOT,
  opts?: { refresh?: boolean; wait?: boolean }
): GetProjectBasesIntent {
  return {
    type: INTENT_GET_PROJECT_BASES,
    payload: {
      projectPath,
      ...(opts?.refresh !== undefined && { refresh: opts.refresh }),
      ...(opts?.wait !== undefined && { wait: opts.wait }),
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetProjectBases Operation", () => {
  describe("dispatch with list hook returns cached bases", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup();
    });

    it("returns cached bases, defaultBaseBranch, projectPath, and projectId", async () => {
      const result = (await setup.dispatcher.dispatch(
        createIntent(PROJECT_ROOT, { refresh: true })
      )) as GetProjectBasesResult;

      expect(result.bases).toEqual(CACHED_BASES);
      expect(result.defaultBaseBranch).toBe("main");
      expect(result.projectPath).toBe(PROJECT_ROOT);
      expect(result.projectId).toBe(PROJECT_ID);
    });
  });

  describe("emits bases:updated domain event with fresh data after refresh", () => {
    it("emits event after fire-and-forget refresh completes", async () => {
      const setup = createTestSetup();
      const events: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_BASES_UPDATED, (event) => {
        events.push(event);
      });

      await setup.dispatcher.dispatch(createIntent(PROJECT_ROOT, { refresh: true }));

      // Wait for fire-and-forget to complete
      await vi.waitFor(() => {
        expect(events.length).toBe(1);
      });

      const freshEvent = events[0] as BasesUpdatedEvent;
      expect(freshEvent.type).toBe(EVENT_BASES_UPDATED);
      expect(freshEvent.payload.projectId).toBe(PROJECT_ID);
      expect(freshEvent.payload.projectPath).toBe(PROJECT_ROOT);
      expect(freshEvent.payload.bases).toEqual(FRESH_BASES);
    });
  });

  describe("no refresh when flag is omitted", () => {
    it("does not call refresh hook and emits no events", async () => {
      const setup = createTestSetup();
      const events: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_BASES_UPDATED, (event) => {
        events.push(event);
      });

      const result = (await setup.dispatcher.dispatch(createIntent())) as GetProjectBasesResult;

      // Returns cached bases
      expect(result.bases).toEqual(CACHED_BASES);

      // Wait a tick to confirm no fire-and-forget ran
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No refresh called, no events emitted
      expect(setup.refreshCalled.value).toBe(false);
      expect(events).toHaveLength(0);
    });
  });

  describe("refresh hook failure does not fail the operation", () => {
    it("returns cached bases even when refresh throws", async () => {
      const setup = createTestSetup({ refreshThrows: true });
      const events: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_BASES_UPDATED, (event) => {
        events.push(event);
      });

      const result = (await setup.dispatcher.dispatch(
        createIntent(PROJECT_ROOT, { refresh: true })
      )) as GetProjectBasesResult;

      // Operation succeeds with cached data
      expect(result.bases).toEqual(CACHED_BASES);
      expect(result.projectId).toBe(PROJECT_ID);

      // Wait a tick to let the fire-and-forget try/catch complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No events emitted (refresh failed before re-list)
      expect(events).toHaveLength(0);
    });
  });

  describe("wait flag awaits refresh and returns fresh data", () => {
    it("returns fresh bases when wait is true", async () => {
      const setup = createTestSetup();
      const events: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_BASES_UPDATED, (event) => {
        events.push(event);
      });

      const result = (await setup.dispatcher.dispatch(
        createIntent(PROJECT_ROOT, { refresh: true, wait: true })
      )) as GetProjectBasesResult;

      // Returns fresh bases (after refresh + re-list)
      expect(result.bases).toEqual(FRESH_BASES);
      expect(result.projectPath).toBe(PROJECT_ROOT);
      expect(result.projectId).toBe(PROJECT_ID);

      // No events emitted (caller gets fresh data directly)
      expect(events).toHaveLength(0);
    });

    it("falls back to cached bases when refresh throws", async () => {
      const setup = createTestSetup({ refreshThrows: true });

      const result = (await setup.dispatcher.dispatch(
        createIntent(PROJECT_ROOT, { refresh: true, wait: true })
      )) as GetProjectBasesResult;

      // Falls back to cached data
      expect(result.bases).toEqual(CACHED_BASES);
      expect(result.projectId).toBe(PROJECT_ID);
    });
  });

  describe("project:resolve failure propagates", () => {
    it("throws when project is not found", async () => {
      const setup = createTestSetup({ unknownProject: true });

      await expect(setup.dispatcher.dispatch(createIntent())).rejects.toThrow(
        "Project not found for path: /project"
      );
    });

    it("throws for unrecognized project path", async () => {
      const setup = createTestSetup();

      await expect(setup.dispatcher.dispatch(createIntent("/nonexistent/project"))).rejects.toThrow(
        "Project not found for path: /nonexistent/project"
      );
    });
  });
});
