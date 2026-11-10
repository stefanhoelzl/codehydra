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

import { AsyncLogScopeStore } from "../boundaries/platform/log-scope";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import type { IntentModule } from "../intents/lib/module";
import { ANY_VALUE, type HookContext, type HookOutput } from "../intents/lib/operation";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { projPath, wsPath, workspaceRefIn } from "../shared/test-fixtures";
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
import {
  createWorkspaceLifecycleModule,
  WORKSPACE_CLAIMED_CAPABILITY,
} from "./workspace-lifecycle-module";
import type { WorkspaceClosing } from "../intents/contract";
import {
  AppShutdownOperation,
  APP_SHUTDOWN_OPERATION_ID,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../intents/app-shutdown";
import { createWindowTitleModule } from "./window-title-module";
import { ShellError } from "../shared/errors/shell-errors";
import { testProjectTypes } from "../intents/project-type-options.test-utils";

// =============================================================================
// Fixtures
// =============================================================================

const PROJECT_PATH = projPath("/test/project");
const WORKSPACE_PATH = wsPath("/test/project/.worktrees/feature-1");
const OTHER_WORKSPACE_PATH = wsPath("/test/project/.worktrees/feature-2");
const WORKSPACE_REF = workspaceRefIn(PROJECT_PATH, "feature-1");
const CLAIMED = { [WORKSPACE_CLAIMED_CAPABILITY]: ANY_VALUE };

/**
 * Register the lifecycle module plus enough infrastructure for the real
 * teardown operations to run, and a probe that records what `closing` says at
 * each hook point.
 *
 * The probe's "shutdown" handlers require the claim, as production teardown
 * does, and are registered *before* the lifecycle module: the capability, not
 * registration order, is what puts them after it.
 */
function setup(options?: {
  deleteError?: string;
  hibernateShutdownError?: string;
  /** Runs inside the delete's "delete" hook point, while the worktree is being removed. */
  duringDelete?: (dispatcher: Dispatcher) => Promise<void>;
  drainTimeoutMs?: number;
}) {
  const dispatcher = new Dispatcher({ logger: SILENT_LOGGER, logScope: new AsyncLogScopeStore() });
  dispatcher.registerOperation(new DeleteWorkspaceOperation(testProjectTypes()));
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

  /** What `closing` reported at each hook point, in execution order. */
  const observed: Array<{ hook: string; closing: WorkspaceClosing | null }> = [];
  const record =
    (hook: string) =>
    async (ctx: HookContext): Promise<HookOutput<Record<string, never>>> => {
      const { workspacePath } = ctx as HookContext & { workspacePath: string };
      observed.push({ hook, closing: await closingOf(dispatcher, workspacePath) });
      return { result: {} };
    };

  const probe: IntentModule = {
    name: "probe",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        shutdown: { requires: CLAIMED, handler: record("delete:shutdown") },
        release: { handler: record("delete:release") },
        delete: {
          handler: async (ctx: HookContext): Promise<HookOutput<DeleteHookResult>> => {
            await record("delete:delete")(ctx);
            await options?.duringDelete?.(dispatcher);
            return { result: options?.deleteError ? { error: options.deleteError } : {} };
          },
        },
        detect: { handler: record("delete:detect") },
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        shutdown: {
          requires: CLAIMED,
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
  dispatcher.registerModule(
    createWorkspaceLifecycleModule({
      logger: SILENT_LOGGER,
      ...(options?.drainTimeoutMs !== undefined && { drainTimeoutMs: options.drainTimeoutMs }),
    })
  );

  return { dispatcher, observed };
}

/** Read `closing` the way any consumer does: off a workspace:resolve result. */
async function closingOf(
  dispatcher: Dispatcher,
  workspacePath: string
): Promise<WorkspaceClosing | null> {
  const result = (await dispatcher.dispatch({
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspacePath },
  } as ResolveWorkspaceIntent)) as ResolveWorkspaceResult;
  return result.closing;
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
      workspaceRef: WORKSPACE_REF,

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
      const { dispatcher, observed } = setup();

      expect(await closingOf(dispatcher, WORKSPACE_PATH)).toBeNull();

      await dispatcher.dispatch(deleteIntent());

      // Every hook point from shutdown onwards saw the claim. This is the
      // invariant the fix rests on: nothing may touch the worktree after this.
      expect(observed).toEqual([
        { hook: "delete:shutdown", closing: "delete" },
        { hook: "delete:release", closing: "delete" },
        { hook: "delete:delete", closing: "delete" },
      ]);
      expect(await closingOf(dispatcher, WORKSPACE_PATH)).toBeNull();
    });

    it("releases the claim when the delete fails, so the surviving workspace works again", async () => {
      const { dispatcher, observed } = setup({ deleteError: "Permission denied" });

      await dispatcher.dispatch(deleteIntent());

      // Detection runs after the failure and must still see the claim.
      expect(observed.at(-1)).toEqual({ hook: "delete:detect", closing: "delete" });
      // Leaving it set would gate this workspace's status reads and its
      // sidekick until the app restarts.
      expect(await closingOf(dispatcher, WORKSPACE_PATH)).toBeNull();
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
      const { dispatcher, observed } = setup();
      const hibernated = waitForEvent(dispatcher, EVENT_WORKSPACE_HIBERNATED);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspaceRef: WORKSPACE_REF },
      } as HibernateWorkspaceIntent);
      await hibernated;

      expect(observed).toEqual([
        { hook: "hibernate:shutdown", closing: "hibernate" },
        { hook: "hibernate:release", closing: "hibernate" },
      ]);
      expect(await closingOf(dispatcher, WORKSPACE_PATH)).toBeNull();
    });

    it("releases the claim even when the background teardown fails", async () => {
      const { dispatcher } = setup({ hibernateShutdownError: "pty host hung" });
      const hibernated = waitForEvent(dispatcher, EVENT_WORKSPACE_HIBERNATED);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspaceRef: WORKSPACE_REF },
      } as HibernateWorkspaceIntent);
      await hibernated;

      // workspace:hibernated is emitted from a `finally`, so a stuck teardown
      // can never strand the claim and permanently gate the workspace.
      expect(await closingOf(dispatcher, WORKSPACE_PATH)).toBeNull();
    });
  });

  it("tracks workspaces independently", async () => {
    const { dispatcher } = setup();
    const other = wsPath("/test/project/.worktrees/feature-2");

    await dispatcher.dispatch(deleteIntent());

    expect(await closingOf(dispatcher, other)).toBeNull();
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
        payload: { workspaceRef: WORKSPACE_REF, focus: false },
      } as SwitchWorkspaceIntent);

      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(true);
      expect(await isActive(dispatcher, OTHER_WORKSPACE_PATH)).toBe(false);
    });

    it("answers get-active-workspace with the switched-to ref", async () => {
      const { dispatcher } = setup();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspaceRef: WORKSPACE_REF, focus: false },
      } as SwitchWorkspaceIntent);

      expect(await activeRef(dispatcher)).toEqual({
        ref: WORKSPACE_REF,
        projectId: "test-project-12345678",
        workspaceName: "feature-1",
      });
    });

    it("clears the active surface when the workspace is deleted", async () => {
      const { dispatcher } = setup();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspaceRef: WORKSPACE_REF, focus: false },
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
        payload: { workspaceRef: WORKSPACE_REF, focus: false },
      } as SwitchWorkspaceIntent);

      await dispatcher.dispatch({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspaceRef: WORKSPACE_REF },
      } as HibernateWorkspaceIntent);
      await hibernated;

      // A hibernating workspace can still be the active one; if that stuck,
      // switching back on wake would short-circuit as already-active and the
      // workspace would never reopen.
      expect(await isActive(dispatcher, WORKSPACE_PATH)).toBe(false);
    });
  });

  describe("app shutdown", () => {
    /**
     * The app's shutdown as far as this race goes: app:shutdown, whose "stop"
     * destroys the window, and window-title, which retitles it on every
     * workspace:switched — throwing, as the real window boundary does, once the
     * window is gone.
     */
    function withShutdown(dispatcher: Dispatcher) {
      const window = { destroyed: false, titlesAfterDestroy: [] as string[] };
      dispatcher.registerOperation(new AppShutdownOperation());
      dispatcher.registerModule(
        createWindowTitleModule({
          windowManager: {
            setTitle: (title: string): void => {
              if (!window.destroyed) return;
              window.titlesAfterDestroy.push(title);
              throw new ShellError("WINDOW_NOT_FOUND", "Window window-1 not found", "window-1");
            },
          },
          titleVersion: undefined,
        })
      );
      dispatcher.registerModule({
        name: "test-view",
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            stop: {
              handler: async (): Promise<void> => {
                window.destroyed = true;
              },
            },
          },
        },
      });
      const shutdown = async (): Promise<void> => {
        await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent);
      };
      return { window, shutdown };
    }

    /** Resolves after `ms`, so a step can give the shutdown a chance to run. */
    const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it("lets a deletion still running finish, last switch included, before the window goes", async () => {
      // The race behind "Window window-1 not found": the user deletes
      // feature-1, lands on it again while it is being removed (another
      // deletion's auto-switch picked it), and closes the window. A shutdown
      // that did not wait destroyed the window while the deletion ran; the
      // deletion then switched away from feature-1 into a window that was gone
      // — or, had the app exited first, never finished at all.
      let shutdownDone: Promise<unknown> = Promise.resolve();
      let destroyedDuringDelete: boolean | undefined;
      const { dispatcher } = setup({
        duringDelete: async (d) => {
          await d.dispatch({
            type: INTENT_SWITCH_WORKSPACE,
            payload: { workspaceRef: WORKSPACE_REF, focus: false },
          } as SwitchWorkspaceIntent);
          shutdownDone = shutdown();
          await settle(20);
          destroyedDuringDelete = window.destroyed;
        },
      });
      const { window, shutdown } = withShutdown(dispatcher);
      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspaceRef: workspaceRefIn(PROJECT_PATH, "feature-2"), focus: false },
      } as SwitchWorkspaceIntent);

      await dispatcher.dispatch(deleteIntent());
      await shutdownDone;

      expect(destroyedDuringDelete).toBe(false);
      expect(window.destroyed).toBe(true);
      expect(window.titlesAfterDestroy).toEqual([]);
    });

    it("stops waiting for a deletion that does not finish in time", async () => {
      let releaseDelete = (): void => {};
      const deleteHangs = new Promise<void>((resolve) => (releaseDelete = resolve));
      const { dispatcher } = setup({ drainTimeoutMs: 10, duringDelete: () => deleteHangs });
      const { window, shutdown } = withShutdown(dispatcher);

      const deletion = dispatcher.dispatch(deleteIntent());
      await settle(0);
      await shutdown();

      expect(window.destroyed).toBe(true);
      releaseDelete();
      await deletion;
    });

    it("does not wait when no deletion is running", async () => {
      const { dispatcher } = setup({ drainTimeoutMs: 60_000 });
      const { window, shutdown } = withShutdown(dispatcher);

      await shutdown();

      expect(window.destroyed).toBe(true);
    });
  });
});
