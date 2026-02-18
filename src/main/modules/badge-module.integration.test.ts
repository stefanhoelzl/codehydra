// @vitest-environment node
/**
 * Integration tests for BadgeModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> UpdateAgentStatusOperation -> domain event -> BadgeModule -> BadgeManager.updateBadge()
 *
 * Test plan items covered:
 * #4: App icon shows busy indicator when agent becomes busy
 * #5: Mixed workspaces show mixed badge
 * #6: Deleting workspace clears stale badge entry
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  UpdateAgentStatusOperation,
  UPDATE_AGENT_STATUS_OPERATION_ID,
  INTENT_UPDATE_AGENT_STATUS,
} from "../operations/update-agent-status";
import type {
  UpdateAgentStatusIntent,
  ResolveHookResult,
  ResolveProjectHookResult,
  ResolveHookInput,
  ResolveProjectHookInput,
} from "../operations/update-agent-status";
import { EVENT_WORKSPACE_DELETED, INTENT_DELETE_WORKSPACE } from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../operations/delete-workspace";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { IntentModule } from "../intents/infrastructure/module";
import { createBadgeModule } from "./badge-module";
import { BadgeManager } from "../managers/badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import { createAppLayerMock, type MockAppLayer } from "../../services/platform/app.state-mock";
import { createImageLayerMock } from "../../services/platform/image.state-mock";
import type { WindowManager } from "../managers/window-manager";
import type { ImageHandle } from "../../services/platform/types";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Mock WindowManager
// =============================================================================

function createMockWindowManager(): {
  setOverlayIcon: (image: ImageHandle | null, description: string) => void;
} {
  return {
    setOverlayIcon: () => {},
  };
}

/**
 * Minimal delete operation that only emits EVENT_WORKSPACE_DELETED.
 * Used to trigger workspace:deleted events through the public dispatcher API
 * without needing the full DeleteWorkspaceOperation pipeline.
 */
class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, { started: true }> {
  readonly id = "delete-workspace";

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;
    const event: WorkspaceDeletedEvent = {
      type: EVENT_WORKSPACE_DELETED,
      payload: {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        workspacePath: payload.workspacePath,
        projectPath: payload.projectPath,
      },
    };
    ctx.emit(event);
    return { started: true };
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  appLayer: MockAppLayer;
  badgeManager: BadgeManager;
}

/**
 * Mock resolve module that provides workspace resolution for the
 * update-agent-status operation (replaces the old payload fields).
 * Uses workspacePath as-is to derive projectPath and workspaceName.
 */
function createMockResolveModule(): IntentModule {
  return {
    hooks: {
      [UPDATE_AGENT_STATUS_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath } = ctx as ResolveHookInput;
            return {
              projectPath: "/projects/test",
              workspaceName: workspacePath.split("/").pop() as WorkspaceName,
            };
          },
        },
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            void (ctx as ResolveProjectHookInput);
            return { projectId: "test-project" as ProjectId };
          },
        },
      },
    },
  };
}

function createTestSetup(): TestSetup {
  const platformInfo = createMockPlatformInfo({ platform: "darwin" });
  const appLayer = createAppLayerMock({ platform: "darwin" });
  const imageLayer = createImageLayerMock();
  const windowManager = createMockWindowManager();

  const badgeManager = new BadgeManager(
    platformInfo,
    appLayer,
    imageLayer,
    windowManager as unknown as WindowManager,
    SILENT_LOGGER
  );

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new MinimalDeleteOperation());

  const badgeModule = createBadgeModule(badgeManager);
  const resolveModule = createMockResolveModule();

  wireModules([badgeModule, resolveModule], hookRegistry, dispatcher);

  return { dispatcher, appLayer, badgeManager };
}

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      status,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("BadgeModule Integration", () => {
  describe("app icon shows busy indicator when agent becomes busy (#4)", () => {
    it("shows all-working badge when single workspace becomes busy", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 2 } })
      );

      expect(appLayer).toHaveDockBadge("\u25CF"); // ●
    });

    it("clears badge when workspace becomes idle", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      // First make busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Then become idle
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      expect(appLayer).toHaveDockBadge("");
    });
  });

  describe("mixed workspaces show mixed badge (#5)", () => {
    it("shows mixed badge when some workspaces idle, some busy", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 2, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );

      expect(appLayer).toHaveDockBadge("\u25D0"); // ◐
    });

    it("transitions from mixed to all-working when idle workspace becomes busy", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      // Mixed state
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");

      // Workspace 1 becomes busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");
    });

    it("transitions from all-working to mixed when workspace becomes idle", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      // All working
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Workspace 1 becomes idle
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");
    });
  });

  describe("deleting workspace clears stale badge entry (#6)", () => {
    it("clears badge when the only busy workspace is deleted", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      // One busy workspace
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25CF");

      // Dispatch a delete intent through the public API to trigger workspace:deleted event
      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "ws1" as WorkspaceName,
          workspacePath: "/workspace/1",
          projectPath: "/projects/test",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);

      expect(appLayer).toHaveDockBadge("");
    });

    it("shows correct badge after busy workspace is deleted and idle workspace remains", async () => {
      const { dispatcher, appLayer } = createTestSetup();

      // Mixed state: one idle, one busy
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/1", { status: "idle", counts: { idle: 1, busy: 0 } })
      );
      await dispatcher.dispatch(
        updateStatusIntent("/workspace/2", { status: "busy", counts: { idle: 0, busy: 1 } })
      );
      expect(appLayer).toHaveDockBadge("\u25D0");

      // Dispatch a delete intent through the public API to trigger workspace:deleted event
      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "ws2" as WorkspaceName,
          workspacePath: "/workspace/2",
          projectPath: "/projects/test",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);

      // Only idle workspace remains - should clear badge
      expect(appLayer).toHaveDockBadge("");
    });
  });
});
