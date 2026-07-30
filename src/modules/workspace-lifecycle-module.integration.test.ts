// @vitest-environment node
/**
 * Integration tests for WorkspaceLifecycleModule.
 *
 * Drives the real delete-workspace and hibernate-workspace operations through a
 * dispatcher and asserts on the `closing` claim they produce, because the whole
 * point of the claim is *when* it is visible relative to the rest of the
 * teardown — a state test in isolation would prove nothing.
 *
 * Covered:
 * - claimed for the whole teardown, from "shutdown" onwards
 * - released on every terminal event (deleted, delete-failed, hibernated,
 *   hibernate-failed), so a workspace that survives a failed delete works again
 * - reason distinguishes delete / close (removeWorktree: false) / hibernate
 * - surfaced on workspace:resolve
 * - active-workspace tracking (moved here from view-module): switch records it,
 *   resolve and get-active-workspace report it, delete and hibernate clear it
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { projPath, wsPath } from "../shared/test-fixtures";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import {
  DeleteWorkspaceOperation,
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type DeleteHookResult,
} from "../intents/delete-workspace";
import {
  HibernateWorkspaceOperation,
  HIBERNATE_WORKSPACE_OPERATION_ID,
  INTENT_HIBERNATE_WORKSPACE,
  EVENT_WORKSPACE_HIBERNATED,
  type HibernateWorkspaceIntent,
} from "../intents/hibernate-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
  type ResolveWorkspaceResult,
} from "../intents/resolve-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "../intents/switch-workspace";
import {
  INTENT_GET_ACTIVE_WORKSPACE,
  type GetActiveWorkspaceIntent,
} from "../intents/get-active-workspace";
import { registerTestInfrastructure } from "../intents/operations.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { SET_METADATA_OPERATION_ID, INTENT_SET_METADATA } from "../intents/set-metadata";
import { createWorkspaceLifecycleModule } from "./workspace-lifecycle-module";
import type { WorkspaceClosingQuery } from "./workspace-lifecycle-module";
import type { WorkspaceClosing } from "../intents/contract";

// =============================================================================
// Fixtures
// =============================================================================

const PROJECT_PATH = projPath("/test/project");
const WORKSPACE_PATH = wsPath("/test/project/.worktrees/feature-1");
const OTHER_WORKSPACE_PATH = wsPath("/test/project/.worktrees/feature-2");

/**
 * Register the lifecycle module plus enough infrastructure for the real
 * teardown operations to run, and a probe that records what `closing` says at
 * each hook point.
 *
 * The lifecycle module is registered before the probe, mirroring production:
 * handlers in a hook point run in registration order, so the probe observes the
 * claim exactly as a real consumer would.
 */
function setup(options?: { deleteError?: string; hibernateShutdownError?: string }) {
  const dispatcher = new Dispatcher({ logger: SILENT_LOGGER });
  dispatcher.registerOperation(new DeleteWorkspaceOperation());
  dispatcher.registerOperation(new HibernateWorkspaceOperation());
  // Hibernation records the hibernated flag in workspace metadata.
  dispatcher.registerOperation(
    createMinimalOperation(SET_METADATA_OPERATION_ID, INTENT_SET_METADATA, "set")
  );

  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [WORKSPACE_PATH]: {
        projectPath: PROJECT_PATH,
        workspaceName: "feature-1" as WorkspaceName,
      },
      [OTHER_WORKSPACE_PATH]: {
        projectPath: PROJECT_PATH,
        workspaceName: "feature-2" as WorkspaceName,
      },
    },
    projects: {
      [PROJECT_PATH]: { projectId: "test-project-12345678" as ProjectId },
    },
  });

  const lifecycle = createWorkspaceLifecycleModule();
  dispatcher.registerModule(lifecycle.module);

  /** What `closing` reported at each hook point, in execution order. */
  const observed: Array<{ hook: string; closing: WorkspaceClosing | null }> = [];
  const record =
    (hook: string) =>
    async (ctx: HookContext): Promise<HookOutput<Record<string, never>>> => {
      const { workspacePath } = ctx as HookContext & { workspacePath: string };
      observed.push({ hook, closing: lifecycle.closing.get(workspacePath) });
      return { result: {} };
    };

  const probe: IntentModule = {
    name: "probe",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: { handler: record("delete:shutdown") },
        release: { handler: record("delete:release") },
        delete: {
          handler: async (ctx: HookContext): Promise<HookOutput<DeleteHookResult>> => {
            await record("delete:delete")(ctx);
            return { result: options?.deleteError ? { error: options.deleteError } : {} };
          },
        },
        detect: { handler: record("delete:detect") },
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          handler: async (ctx: HookContext): Promise<HookOutput<Record<string, never>>> => {
            await record("hibernate:shutdown")(ctx);
            if (options?.hibernateShutdownError) throw new Error(options.hibernateShutdownError);
            return { result: {} };
          },
        },
        release: { handler: record("hibernate:release") },
      },
    },
  };
  dispatcher.registerModule(probe);

  return { dispatcher, closing: lifecycle.closing as WorkspaceClosingQuery, observed };
}

/** Resolve once `eventType` is emitted. */
function waitForEvent(dispatcher: Dispatcher, eventType: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = dispatcher.subscribe(eventType, () => {
      unsubscribe();
      resolve();
    });
  });
}

function deleteIntent(
  overrides?: Partial<DeleteWorkspaceIntent["payload"]>
): DeleteWorkspaceIntent {
  return {
    type: INTENT_DELETE_WORKSPACE,
    payload: {
      workspacePath: WORKSPACE_PATH,
      keepBranch: true,
      force: false,
      removeWorktree: true,
      ...overrides,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("WorkspaceLifecycleModule", () => {
  describe("delete", () => {
    it("claims the workspace for the whole teardown and releases it on success", async () => {
      const { dispatcher, closing, observed } = setup();

      expect(closing.get(WORKSPACE_PATH)).toBeNull();

      await dispatcher.dispatch(deleteIntent());

      // Every hook point from shutdown onwards saw the claim. This is the
      // invariant the fix rests on: nothing may touch the worktree after this.
      expect(observed).toEqual([
        { hook: "delete:shutdown", closing: "delete" },
        { hook: "delete:release", closing: "delete" },
        { hook: "delete:delete", closing: "delete" },
      ]);
      expect(closing.get(WORKSPACE_PATH)).toBeNull();
    });

    it("releases the claim when the delete fails, so the surviving workspace works again", async () => {
      const { dispatcher, closing, observed } = setup({ deleteError: "Permission denied" });

      await dispatcher.dispatch(deleteIntent());

      // Detection runs after the failure and must still see the claim.
      expect(observed.at(-1)).toEqual({ hook: "delete:detect", closing: "delete" });
      // Leaving it set would gate this workspace's status reads and its
      // sidekick until the app restarts.
      expect(closing.get(WORKSPACE_PATH)).toBeNull();
    });

    it('claims as "close" for a runtime-only teardown (project:close)', async () => {
      const { dispatcher, observed } = setup();

      await dispatcher.dispatch(deleteIntent({ removeWorktree: false }));

      expect(observed).toEqual([{ hook: "delete:shutdown", closing: "close" }]);
    });

    it("surfaces the claim on workspace:resolve", async () => {
      const { dispatcher } = setup();
      const resolved: Array<ResolveWorkspaceResult["closing"]> = [];

      dispatcher.registerModule({
        name: "resolve-probe",
        hooks: {
          [DELETE_WORKSPACE_OPERATION_ID]: {
            release: {
              handler: async (): Promise<HookOutput<Record<string, never>>> => {
                const result = (await dispatcher.dispatch({
                  type: INTENT_RESOLVE_WORKSPACE,
                  payload: { workspacePath: WORKSPACE_PATH },
                } as ResolveWorkspaceIntent)) as ResolveWorkspaceResult;
                resolved.push(result.closing);
                return { result: {} };
              },
            },
          },
        },
      });

      const before = (await dispatcher.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH },
      } as ResolveWorkspaceIntent)) as ResolveWorkspaceResult;
      expect(before.closing).toBeNull();

      await dispatcher.dispatch(deleteIntent());

      expect(resolved).toEqual(["delete"]);
    });
  });

  // Hibernation runs its shutdown/release hooks in a detached background task
  // and returns `{ started: true }` immediately, so these tests wait for the
  // terminal event rather than for the dispatch.
  describe("hibernate", () => {
    it('claims as "hibernate" for the background teardown and releases when it ends', async () => {
      const { dispatcher, closing, observed } = setup();
      const hibernated = waitForEvent(dispatcher, EVENT_WORKSPACE_HIBERNATED);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH },
      } as HibernateWorkspaceIntent);
      await hibernated;

      expect(observed).toEqual([
        { hook: "hibernate:shutdown", closing: "hibernate" },
        { hook: "hibernate:release", closing: "hibernate" },
      ]);
      expect(closing.get(WORKSPACE_PATH)).toBeNull();
    });

    it("releases the claim even when the background teardown fails", async () => {
      const { dispatcher, closing } = setup({ hibernateShutdownError: "pty host hung" });
      const hibernated = waitForEvent(dispatcher, EVENT_WORKSPACE_HIBERNATED);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH },
      } as HibernateWorkspaceIntent);
      await hibernated;

      // workspace:hibernated is emitted from a `finally`, so a stuck teardown
      // can never strand the claim and permanently gate the workspace.
      expect(closing.get(WORKSPACE_PATH)).toBeNull();
    });
  });

  it("tracks workspaces independently", async () => {
    const { dispatcher, closing } = setup();
    const other = wsPath("/test/project/.worktrees/feature-2");

    await dispatcher.dispatch(deleteIntent());

    expect(closing.get(other)).toBeNull();
  });

  // ===========================================================================
  // Active-workspace tracking (moved here from view-module, which used to keep
  // its own copy alongside two others).
  // ===========================================================================

  describe("active workspace", () => {
    /** Ask workspace:resolve whether a workspace is the active one. */
    async function isActive(dispatcher: Dispatcher, workspacePath: string): Promise<boolean> {
      const result = (await dispatcher.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
      } as ResolveWorkspaceIntent)) as ResolveWorkspaceResult;
      return result.active;
    }

    async function activeRef(dispatcher: Dispatcher): Promise<unknown> {
      return await dispatcher.dispatch({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {},
      } as GetActiveWorkspaceIntent);
    }

    it("records the workspace a switch activated", async () => {
      const { dispatcher } = setup();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH, focus: false },
      } as SwitchWorkspaceIntent);

      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(true);
      expect(await isActive(dispatcher, OTHER_WORKSPACE_PATH)).toBe(false);
    });

    it("answers get-active-workspace with the switched-to ref", async () => {
      const { dispatcher } = setup();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH, focus: false },
      } as SwitchWorkspaceIntent);

      expect(await activeRef(dispatcher)).toEqual({
        projectId: "test-project-12345678",
        workspaceName: "feature-1",
        path: WORKSPACE_PATH,
      });
    });

    it("clears the active surface when the workspace is deleted", async () => {
      const { dispatcher } = setup();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH, focus: false },
      } as SwitchWorkspaceIntent);
      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(true);

      await dispatcher.dispatch(deleteIntent());

      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(false);
    });

    it("clears the active surface when the workspace hibernates, so wake is not short-circuited", async () => {
      const { dispatcher } = setup();
      const hibernated = waitForEvent(dispatcher, EVENT_WORKSPACE_HIBERNATED);

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH, focus: false },
      } as SwitchWorkspaceIntent);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspacePath: WORKSPACE_PATH },
      } as HibernateWorkspaceIntent);
      await hibernated;

      // fallbackToCurrent can leave a hibernating workspace "active" for the
      // overlay; if that stuck, switching back on wake would short-circuit as
      // already-active and the workspace would never reopen.
      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(false);
    });
  });
});
