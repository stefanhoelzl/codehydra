// @vitest-environment node
/**
 * Integration tests for PowerModule.
 *
 * Tests verify, through the full dispatcher pipeline
 * (UpdateAgentStatusOperation -> domain event -> PowerModule):
 * - The OS sleep blocker engages while any workspace is busy/mixed.
 * - It releases when all workspaces are idle/none, deleted, or hibernated.
 * - Repeated busy updates don't thrash the blocker (idempotency).
 * - The `experimental.prevent-sleep` config gates the behavior.
 * - The blocker is released on app shutdown.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "../intents/update-agent-status";
import type { UpdateAgentStatusIntent } from "../intents/update-agent-status";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "../intents/resolve-workspace";
import type {
  ResolveHookResult as ResolveWorkspaceHookResult,
  ResolveHookInput as ResolveWorkspaceHookInput,
} from "../intents/resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "../intents/resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "../intents/resolve-project";
import { EVENT_WORKSPACE_DELETED, INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../intents/delete-workspace";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import type { Operation, OperationContext, HookContext } from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { IntentModule } from "../intents/lib/module";
import { createPowerModule } from "./power-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createAppBoundaryMock, type MockAppBoundary } from "../boundaries/shell/app.state-mock";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import type { WorkspacePath, AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Minimal delete operation that only emits EVENT_WORKSPACE_DELETED, so tests can
 * trigger workspace:deleted through the public dispatcher API without the full
 * DeleteWorkspaceOperation pipeline.
 */
class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, { started: true }> {
  readonly id = "delete-workspace";

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const event: WorkspaceDeletedEvent = {
      type: EVENT_WORKSPACE_DELETED,
      payload: {
        projectId: "test-12345678" as ProjectId,
        workspaceName: "ws" as WorkspaceName,
        workspacePath: ctx.intent.payload.workspacePath ?? "",
        projectPath: "/projects/test",
      },
    };
    ctx.emit(event);
    return { started: true };
  }
}

/**
 * Mock resolve module providing workspace/project resolution for the
 * update-agent-status operation.
 */
function createMockResolveModule(): IntentModule {
  return {
    name: "test-resolve",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { workspacePath } = ctx as ResolveWorkspaceHookInput;
            return {
              projectPath: "/projects/test",
              workspaceName: workspacePath.split("/").pop() as WorkspaceName,
            };
          },
        },
      },
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveProjectHookResult> => {
            return { projectId: "test-project" as ProjectId };
          },
        },
      },
    },
  };
}

interface ModuleTestSetup {
  dispatcher: Dispatcher;
  appLayer: MockAppBoundary;
}

function createModuleTestSetup(options?: { enabled?: boolean }): ModuleTestSetup {
  const appLayer = createAppBoundaryMock();
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new MinimalDeleteOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  const configService =
    options?.enabled === false
      ? createMockConfig({ defaults: { "experimental.prevent-sleep": false } })
      : createMockConfig();

  const powerModule = createPowerModule({ appLayer, configService, logger: SILENT_LOGGER });
  dispatcher.registerModule(powerModule);
  dispatcher.registerModule(createMockResolveModule());

  return { dispatcher, appLayer };
}

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: { workspacePath: workspacePath as WorkspacePath, status },
  };
}

const busy = (n = 1): AggregatedAgentStatus => ({ status: "busy", counts: { idle: 0, busy: n } });
const idle = (n = 1): AggregatedAgentStatus => ({ status: "idle", counts: { idle: n, busy: 0 } });
const mixed = (): AggregatedAgentStatus => ({ status: "mixed", counts: { idle: 1, busy: 1 } });
const none = (): AggregatedAgentStatus => ({ status: "none", counts: { idle: 0, busy: 0 } });

// =============================================================================
// Tests
// =============================================================================

describe("PowerModule Integration", () => {
  describe("blocks sleep while a workspace is busy", () => {
    it("does not prevent sleep when a workspace is idle", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", idle()));
      expect(appLayer).not.toBePreventingSleep();
    });

    it("prevents sleep when a workspace becomes busy", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy(2)));
      expect(appLayer).toBePreventingSleep();
    });

    it("prevents sleep for a mixed workspace", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", mixed()));
      expect(appLayer).toBePreventingSleep();
    });

    it("releases the blocker when the busy workspace becomes idle", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      expect(appLayer).toBePreventingSleep();

      await dispatcher.dispatch(updateStatusIntent("/workspace/1", idle()));
      expect(appLayer).not.toBePreventingSleep();
    });

    it("keeps blocking while at least one of several workspaces is busy", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      await dispatcher.dispatch(updateStatusIntent("/workspace/2", busy()));
      expect(appLayer).toBePreventingSleep();

      // One goes idle - the other is still busy.
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", idle()));
      expect(appLayer).toBePreventingSleep();

      // Both idle now - release.
      await dispatcher.dispatch(updateStatusIntent("/workspace/2", idle()));
      expect(appLayer).not.toBePreventingSleep();
    });
  });

  describe("offline workspaces allow sleep", () => {
    it("releases when the only busy workspace goes to status none (hibernation teardown)", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      expect(appLayer).toBePreventingSleep();

      // Hibernation stops the agent server, which fires status "none".
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", none()));
      expect(appLayer).not.toBePreventingSleep();
    });

    it("releases when the only busy workspace is deleted", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      expect(appLayer).toBePreventingSleep();

      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspace/1",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);
      expect(appLayer).not.toBePreventingSleep();
    });

    it("keeps blocking when a busy workspace remains after another is deleted", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      await dispatcher.dispatch(updateStatusIntent("/workspace/2", idle()));
      expect(appLayer).toBePreventingSleep();

      // Delete the idle one - the busy one remains.
      const deleteIntent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspace/2",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      };
      await dispatcher.dispatch(deleteIntent);
      expect(appLayer).toBePreventingSleep();
    });
  });

  describe("idempotency", () => {
    it("does not start a second blocker on repeated busy updates", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy(3)));
      await dispatcher.dispatch(updateStatusIntent("/workspace/2", busy()));

      expect(appLayer).toBePreventingSleep();
      expect(appLayer).toHaveSleepBlockerStartCount(1);
    });
  });

  describe("config gating", () => {
    it("never engages the blocker when experimental.prevent-sleep is false", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup({ enabled: false });
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));

      expect(appLayer).not.toBePreventingSleep();
      expect(appLayer).toHaveSleepBlockerStartCount(0);
    });
  });

  describe("shutdown", () => {
    it("releases the blocker on app shutdown", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      expect(appLayer).toBePreventingSleep();

      dispatcher.registerOperation(
        INTENT_APP_SHUTDOWN,
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );
      await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent);

      expect(appLayer).not.toBePreventingSleep();
    });
  });
});
