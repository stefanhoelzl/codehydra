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
import { wireModules } from "../intents/infrastructure/wire";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "../operations/update-available";
import type { UpdateAvailableIntent } from "../operations/update-available";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
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

  const windowTitleModule = createWindowTitleModule(setTitle, titleVersion ?? "main");

  wireModules([windowTitleModule], hookRegistry, dispatcher);

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
});
