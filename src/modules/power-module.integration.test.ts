// @vitest-environment node
/**
 * Integration tests for PowerModule.
 *
 * Tests verify, through the full dispatcher pipeline
 * (UpdateAgentStatusOperation -> domain event -> PowerModule):
 * - The OS sleep blocker engages while any workspace is busy/mixed.
 * - It releases when all workspaces are idle/none, deleted, or hibernated.
 * - Repeated busy updates don't thrash the blocker (idempotency).
 * - The blocker is released on app shutdown.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { UpdateAgentStatusOperation } from "../intents/update-agent-status";
import { INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import {
  createDeleteEventOperation,
  createMinimalOperation,
} from "../intents/lib/operation.test-utils";
import { registerTestInfrastructure, updateStatusIntent } from "../intents/operations.test-utils";
import { createPowerModule } from "./power-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createAppBoundaryMock, type MockAppBoundary } from "../boundaries/shell/app.state-mock";
import type { AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// Helpers
// =============================================================================

interface ModuleTestSetup {
  dispatcher: Dispatcher;
  appLayer: MockAppBoundary;
}

function createModuleTestSetup(): ModuleTestSetup {
  const appLayer = createAppBoundaryMock();
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new UpdateAgentStatusOperation());
  dispatcher.registerOperation(createDeleteEventOperation());

  // Every workspace path resolves; workspaceName derives from the path basename.
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath) => ({
      projectPath: "/projects/test",
      workspaceName: workspacePath.split("/").pop() as WorkspaceName,
    }),
    projects: () => ({ projectId: "test-project" as ProjectId }),
  });

  const powerModule = createPowerModule({ appLayer, logger: SILENT_LOGGER });
  dispatcher.registerModule(powerModule);

  return { dispatcher, appLayer };
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

  describe("shutdown", () => {
    it("releases the blocker on app shutdown", async () => {
      const { dispatcher, appLayer } = createModuleTestSetup();
      await dispatcher.dispatch(updateStatusIntent("/workspace/1", busy()));
      expect(appLayer).toBePreventingSleep();

      dispatcher.registerOperation(
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
      );
      await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} } as AppShutdownIntent);

      expect(appLayer).not.toBePreventingSleep();
    });
  });
});
