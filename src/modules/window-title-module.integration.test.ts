// @vitest-environment node
/**
 * Integration tests for WindowTitleModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> operation -> domain event -> WindowTitleModule -> setTitle()
 *
 * Uses minimal operations that emit workspace:switched.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import type { Operation, OperationContext } from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { Intent } from "../intents/lib/types";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../intents/app-start";
import { createWindowTitleModule } from "./window-title-module";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

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
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  setTitle: ReturnType<typeof vi.fn>;
}

function createTestSetup(titleVersion?: string): TestSetup {
  const setTitle = vi.fn();

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_MINIMAL_SWITCH, new MinimalSwitchOperation());
  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );

  const windowTitleModule = createWindowTitleModule({
    windowManager: { setTitle },
    titleVersion: titleVersion ?? "main",
  });

  dispatcher.registerModule(windowTitleModule);

  return { dispatcher, setTitle };
}

function switchIntent(payload: MinimalSwitchPayload | null): MinimalSwitchIntent {
  return {
    type: INTENT_MINIMAL_SWITCH,
    payload,
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
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(
      INTENT_APP_START,
      createMinimalOperation(APP_START_OPERATION_ID, "start")
    );

    const windowTitleModule = createWindowTitleModule({
      windowManager: { setTitle },
      titleVersion: undefined,
    });
    dispatcher.registerModule(windowTitleModule);

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra");
  });
});
