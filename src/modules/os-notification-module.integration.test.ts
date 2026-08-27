// @vitest-environment node
/**
 * Integration tests for OsNotificationModule.
 *
 * Tests verify, through the real dispatcher pipeline
 * (UpdateAgentStatusOperation -> agent:status-updated -> module):
 * - the three `notification` modes, including that the key is re-read live
 * - the background gate (nothing fires while the window has focus)
 * - the idle-increase trigger, matching the renderer chime's rule
 * - first-workspace's all-busy precondition and its self-rearming
 * - clicking focuses the window and switches to the workspace
 * - workspace deletion evicts state
 * - shutdown closes outstanding notifications
 */

import { describe, it, expect, vi } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Dispatcher } from "../intents/lib/dispatcher";

import { UpdateAgentStatusOperation } from "../intents/update-agent-status";
import { INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { AppShutdownOperation } from "../intents/app-shutdown";
import { createDeleteEventOperation } from "../intents/lib/operation.test-utils";
import { registerTestInfrastructure, updateStatusIntent } from "../intents/operations.test-utils";
import {
  createOsNotificationModule,
  NOTIFICATION_MODES,
  type NotificationMode,
} from "./os-notification-module";
import { storeEnum } from "../boundaries/platform/store-definition";
import {
  createOsNotificationBoundaryMock,
  type MockOsNotificationBoundary,
} from "../boundaries/shell/os-notification.state-mock";
import {
  createMockWindowManager,
  type MockWindowManager,
} from "../boundaries/shell/window-manager.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import type { Config } from "../boundaries/platform/config";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { projPath, wsPath } from "../shared/test-fixtures";

const TITLE = "CodeHydra agent needs your attention";

const BUSY = { status: "busy", counts: { idle: 0, busy: 1 } } as const;
const IDLE = { status: "idle", counts: { idle: 1, busy: 0 } } as const;
const MIXED = { status: "mixed", counts: { idle: 1, busy: 1 } } as const;
const NONE = { status: "none", counts: { idle: 0, busy: 0 } } as const;

/**
 * Re-register the key the module owns, to read or change it from a test.
 * The mock config keys on the name, so this hands back the same value.
 */
function modeAccessor(configService: Config) {
  return configService.register<NotificationMode>("notification", {
    default: "first-workspace",
    ...storeEnum(NOTIFICATION_MODES),
  });
}

interface Setup {
  readonly dispatcher: Dispatcher;
  readonly osNotificationLayer: MockOsNotificationBoundary;
  readonly windowManager: MockWindowManager;
  readonly configService: Config;
}

/**
 * @param mode - Initial `notification` config value
 * @param focused - Whether the window starts focused (default: background)
 */
function createSetup(mode: NotificationMode = "each-workspace", focused = false): Setup {
  const osNotificationLayer = createOsNotificationBoundaryMock();
  const windowManager = createMockWindowManager({ focused });
  const configService = createMockConfig({ defaults: { notification: mode } });

  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new UpdateAgentStatusOperation());
  dispatcher.registerOperation(createDeleteEventOperation());
  dispatcher.registerOperation(new AppShutdownOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath) => ({
      projectPath: projPath("/projects/test"),
      workspaceName: workspacePath.split("/").pop() as WorkspaceName,
    }),
    projects: () => ({ projectId: "test-project" as ProjectId }),
  });

  dispatcher.registerModule(
    createOsNotificationModule({
      osNotificationLayer,
      windowManager,
      dispatcher,
      configService,
      logger: SILENT_LOGGER,
    })
  );

  return { dispatcher, osNotificationLayer, windowManager, configService };
}

describe("OsNotificationModule", () => {
  describe("config key", () => {
    it("defaults to first-workspace", () => {
      const configService = createMockConfig();
      createOsNotificationModule({
        osNotificationLayer: createOsNotificationBoundaryMock(),
        windowManager: createMockWindowManager(),
        dispatcher: { dispatch: vi.fn() },
        configService,
        logger: SILENT_LOGGER,
      });

      expect(modeAccessor(configService).get()).toBe("first-workspace");
    });
  });

  describe("background gate", () => {
    it("notifies when the window does not have focus", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("each-workspace", false);

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ title: TITLE, body: "alpha" }]);
    });

    it("stays silent while the user is looking at CodeHydra", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("each-workspace", true);

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });

    it("samples focus at the transition, not at construction", async () => {
      const { dispatcher, osNotificationLayer, windowManager } = createSetup(
        "each-workspace",
        true
      );

      windowManager.setFocused(false);
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });
  });

  describe("idle-increase trigger", () => {
    it("notifies on the first report when it already has idle agents", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("does not notify when a workspace first reports as busy", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });

    it("notifies on busy -> idle", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("notifies when one of several agents finishes (busy -> mixed)", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(
        updateStatusIntent(wsPath("/ws/alpha"), { status: "busy", counts: { idle: 0, busy: 2 } })
      );
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), MIXED));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("does not notify when the idle count is unchanged", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("does not notify when the idle count falls", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(
        updateStatusIntent(wsPath("/ws/alpha"), { status: "idle", counts: { idle: 2, busy: 0 } })
      );
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("does not notify when the agent goes away", async () => {
      const { dispatcher, osNotificationLayer } = createSetup();

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), NONE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });
  });

  describe("mode: disabled", () => {
    it("never notifies", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("disabled");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });

    it("still tracks counts, so enabling it later does not fire for past transitions", async () => {
      const { dispatcher, osNotificationLayer, configService } = createSetup("disabled");
      const mode = modeAccessor(configService);

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await mode.set("each-workspace");
      // Same counts as before: nothing new became idle.
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });
  });

  describe("mode: each-workspace", () => {
    it("notifies once per workspace that goes idle", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("each-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }, { body: "beta" }]);
    });

    it("notifies even when other workspaces were already idle", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("each-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }, { body: "beta" }]);
    });
  });

  describe("mode: first-workspace", () => {
    it("notifies when the only workspace finishes", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("notifies for the first of several busy workspaces, then goes quiet", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/gamma"), BUSY));

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/gamma"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "beta" }]);
    });

    it("re-arms once every workspace is busy again", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);

      // Everything busy again...
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      // ...so the next one to finish is once again the first one free.
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }, { body: "beta" }]);
    });

    it("stays quiet while another workspace is already idle", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      // alpha arrives idle with nothing busy, so it is not a "first one free"
      // moment either — and it then keeps beta from being one.
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });

    it("ignores agentless workspaces when deciding whether all were busy", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      // A hibernated workspace reports "none" and must neither count as work in
      // progress nor block the notification forever.
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/sleeping"), NONE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });

    it("does not fire when nothing was busy at all", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      // A lone workspace whose agent connects idle: nothing was in progress, so
      // there is no "first one free" moment to report.
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([]);
    });
  });

  describe("live config", () => {
    it("honours a mode change on the very next transition", async () => {
      const { dispatcher, osNotificationLayer, configService } = createSetup("disabled");
      const mode = modeAccessor(configService);

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), BUSY));
      await mode.set("each-workspace");
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "alpha" }]);
    });
  });

  describe("click", () => {
    it("brings the window forward and switches to the workspace", async () => {
      const { dispatcher, osNotificationLayer, windowManager } = createSetup();
      const dispatchSpy = vi.spyOn(dispatcher, "dispatch");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      osNotificationLayer.$.click(0);

      expect(windowManager.focus).toHaveBeenCalledOnce();
      expect(windowManager.isFocused()).toBe(true);
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workspace:switch",
          payload: { workspacePath: wsPath("/ws/alpha"), focus: true },
        })
      );
    });
  });

  describe("workspace deletion", () => {
    it("forgets a deleted workspace, so a same-named successor starts fresh", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("first-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), BUSY));
      // While alpha exists and is idle, beta finishing is not "the first free".
      await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: INTENT_DELETE_WORKSPACE,
        payload: { workspacePath: wsPath("/ws/alpha") },
      } as DeleteWorkspaceIntent);
      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/beta"), IDLE));

      expect(osNotificationLayer).toHaveShownNotifications([{ body: "beta" }]);
    });
  });

  describe("shutdown", () => {
    it("closes notifications still on screen", async () => {
      const { dispatcher, osNotificationLayer } = createSetup("each-workspace");

      await dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE));
      expect(osNotificationLayer).toHaveOpenNotificationCount(1);

      await dispatcher.dispatch<AppShutdownIntent>({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(osNotificationLayer).toHaveOpenNotificationCount(0);
    });
  });

  describe("unsupported platform", () => {
    it("carries on when the OS cannot show notifications", async () => {
      const osNotificationLayer = createOsNotificationBoundaryMock({ supported: false });
      const dispatcher = createMockDispatcher();
      dispatcher.registerOperation(new UpdateAgentStatusOperation());
      registerTestInfrastructure(dispatcher, {
        workspaces: (workspacePath) => ({
          projectPath: projPath("/projects/test"),
          workspaceName: workspacePath.split("/").pop() as WorkspaceName,
        }),
        projects: () => ({ projectId: "test-project" as ProjectId }),
      });
      dispatcher.registerModule(
        createOsNotificationModule({
          osNotificationLayer,
          windowManager: createMockWindowManager({ focused: false }),
          dispatcher,
          configService: createMockConfig({ defaults: { notification: "each-workspace" } }),
          logger: SILENT_LOGGER,
        })
      );

      await expect(
        dispatcher.dispatch(updateStatusIntent(wsPath("/ws/alpha"), IDLE))
      ).resolves.not.toThrow();
      expect(osNotificationLayer).toHaveShownNotifications([]);
    });
  });
});
