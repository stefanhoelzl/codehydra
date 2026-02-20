// @vitest-environment node
/**
 * Integration tests for WindowTitleModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> operation -> domain event -> WindowTitleModule -> setTitle()
 *
 * Uses minimal operations that emit the required events
 * (workspace:switched and update:available).
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "../operations/update-available";
import type { UpdateAvailableIntent } from "../operations/update-available";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
  type StartHookResult,
} from "../operations/app-start";
import { createWindowTitleModule } from "./window-title-module";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Minimal switch operation that emits workspace:switched
// =============================================================================

const INTENT_MINIMAL_SWITCH = "workspace:switch" as const;

interface MinimalSwitchPayload {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}

interface MinimalSwitchIntent extends Intent<void> {
  readonly type: typeof INTENT_MINIMAL_SWITCH;
  readonly payload: MinimalSwitchPayload | null;
}

class MinimalSwitchOperation implements Operation<MinimalSwitchIntent, void> {
  readonly id = "switch-workspace";

  async execute(ctx: OperationContext<MinimalSwitchIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: payload
        ? {
            projectId: payload.projectId,
            projectName: payload.projectName,
            projectPath: "/projects/test",
            workspaceName: payload.workspaceName,
            path: payload.path,
          }
        : null,
    };
    ctx.emit(event);
  }
}

// =============================================================================
// Minimal start operation that runs the "start" hook point
// =============================================================================

/**
 * Minimal start operation that only runs the "start" hook point.
 * Avoids the full AppStartOperation pipeline while exercising the
 * window title module's start hook through the dispatcher.
 */
class MinimalStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { errors } = await ctx.hooks.collect<StartHookResult>("start", hookCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  setTitle: ReturnType<typeof vi.fn>;
}

function createTestSetup(titleVersion?: string): TestSetup {
  const setTitle = vi.fn();

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_MINIMAL_SWITCH, new MinimalSwitchOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());
  dispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());

  const windowTitleModule = createWindowTitleModule(setTitle, titleVersion ?? "main");

  dispatcher.registerModule(windowTitleModule);

  return { dispatcher, setTitle };
}

function switchIntent(payload: MinimalSwitchPayload | null): MinimalSwitchIntent {
  return {
    type: INTENT_MINIMAL_SWITCH,
    payload,
  };
}

function updateAvailableIntent(version = "1.2.3"): UpdateAvailableIntent {
  return {
    type: INTENT_UPDATE_AVAILABLE,
    payload: { version },
  };
}

function startIntent(): AppStartIntent {
  return {
    type: INTENT_APP_START,
    payload: {} as AppStartIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("WindowTitleModule Integration", () => {
  it("sets title with project/workspace on workspace switch", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(
      switchIntent({
        projectId: "test-project" as ProjectId,
        projectName: "MyProject",
        workspaceName: "feature-branch" as WorkspaceName,
        path: "/workspaces/feature-branch",
      })
    );

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - MyProject / feature-branch - (main)");
  });

  it("sets title with no-workspace format on null payload", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent(null));

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - (main)");
  });

  it("sets title with (update available) suffix after update:available event", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(updateAvailableIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - (main) - (update available)");
  });

  it("persists hasUpdate flag across subsequent workspace switches", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    // First: mark update available
    await dispatcher.dispatch(updateAvailableIntent());
    setTitle.mockClear();

    // Then switch workspace -- should still show update suffix
    await dispatcher.dispatch(
      switchIntent({
        projectId: "test-project" as ProjectId,
        projectName: "MyProject",
        workspaceName: "feature-branch" as WorkspaceName,
        path: "/workspaces/feature-branch",
      })
    );

    expect(setTitle).toHaveBeenCalledWith(
      "CodeHydra - MyProject / feature-branch - (main) - (update available)"
    );
  });

  it("includes workspace info when update arrives after workspace switch", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    // First switch to a workspace
    await dispatcher.dispatch(
      switchIntent({
        projectId: "test-project" as ProjectId,
        projectName: "MyProject",
        workspaceName: "feature-branch" as WorkspaceName,
        path: "/workspaces/feature-branch",
      })
    );
    setTitle.mockClear();

    // Then receive update available
    await dispatcher.dispatch(updateAvailableIntent());

    expect(setTitle).toHaveBeenCalledWith(
      "CodeHydra - MyProject / feature-branch - (main) - (update available)"
    );
  });

  it("handles null workspace then update available", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    // Switch to null (no active workspace)
    await dispatcher.dispatch(switchIntent(null));
    setTitle.mockClear();

    // Then receive update available
    await dispatcher.dispatch(updateAvailableIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - (main) - (update available)");
  });

  it("sets initial title with version during app:start", async () => {
    const { dispatcher, setTitle } = createTestSetup("1.0.0");

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - (1.0.0)");
  });

  it("sets initial title with dev branch during app:start", async () => {
    const { dispatcher, setTitle } = createTestSetup("my-branch");

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra - (my-branch)");
  });

  it("sets initial title without version when titleVersion is undefined", async () => {
    const setTitle = vi.fn();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalStartOperation());

    const windowTitleModule = createWindowTitleModule(setTitle, undefined);
    dispatcher.registerModule(windowTitleModule);

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra");
  });
});
