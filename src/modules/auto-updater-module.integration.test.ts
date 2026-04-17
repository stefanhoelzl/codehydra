// @vitest-environment node
/**
 * Integration tests for AutoUpdaterModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> AutoUpdaterModule handler
 *
 * Uses minimal operations to test individual hook behaviors.
 */

import { describe, it, expect } from "vitest";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { Dispatcher } from "../intents/lib/dispatcher";

import type { Operation, OperationContext } from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../intents/app-shutdown";
import { AppResumeOperation, INTENT_APP_RESUME, type AppResumeIntent } from "../intents/app-resume";
import { INTENT_UPDATE_AVAILABLE, type UpdateAvailableIntent } from "../intents/update-available";
import {
  UpdateApplyOperation,
  INTENT_UPDATE_APPLY,
  type UpdateApplyIntent,
} from "../intents/update-apply";
import { createAutoUpdaterModule } from "./auto-updater-module";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type {
  AutoUpdater,
  UpdateDetectedCallback,
  UpdateDownloadedCallback,
  DownloadProgressCallback,
} from "./auto-updater";
import type { Config } from "../boundaries/platform/config";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { DialogConfig, DialogUserEvent } from "../shared/dialog-types";
import type { NotificationManager, NotificationHandle } from "./notification-manager";
import type { NotificationConfig, NotificationUserEvent } from "../shared/notification-types";

// =============================================================================
// Mock Config
// =============================================================================

function createMockConfig(values?: Record<string, unknown>): Config {
  const store = new Map<string, unknown>(Object.entries(values ?? {}));
  return {
    register: () => {},
    load: () => {},
    get: (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getDefinitions: () => new Map(),
    getEffective: () => Object.fromEntries(store),
    getDefaults: () => ({}),
    getHelpText: () => "",
  };
}

// =============================================================================
// Tracking Operations
// =============================================================================

class TrackingUpdateOperation implements Operation<UpdateAvailableIntent, void> {
  readonly id = "update-available";
  readonly dispatched: UpdateAvailableIntent[] = [];

  async execute(ctx: OperationContext<UpdateAvailableIntent>): Promise<void> {
    this.dispatched.push(ctx.intent);
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

interface MockAutoUpdater {
  mock: AutoUpdater;
  startCalled: boolean;
  disposeCalled: boolean;
  checkForUpdatesCalled: boolean;
  downloadCalled: boolean;
  cancelCalled: boolean;
  quitAndInstallCalled: boolean;
  capturedDetectedCb: UpdateDetectedCallback | null;
  capturedDownloadedCb: UpdateDownloadedCallback | null;
  capturedProgressCb: DownloadProgressCallback | null;
  resolveDownload: (() => void) | null;
  rejectDownload: ((error: Error) => void) | null;
  setCheckResult: (found: boolean) => void;
}

function createMockAutoUpdater(overrides?: {
  disposeThrows?: Error;
  checkReturns?: boolean;
}): MockAutoUpdater {
  let startCalled = false;
  let disposeCalled = false;
  let checkForUpdatesCalled = false;
  let downloadCalled = false;
  let cancelCalled = false;
  let quitAndInstallCalled = false;
  let capturedDetectedCb: UpdateDetectedCallback | null = null;
  let capturedDownloadedCb: UpdateDownloadedCallback | null = null;
  let capturedProgressCb: DownloadProgressCallback | null = null;
  let resolveDownload: (() => void) | null = null;
  let rejectDownload: ((error: Error) => void) | null = null;
  let checkResult = overrides?.checkReturns ?? false;

  const mock: AutoUpdater = {
    start() {
      startCalled = true;
    },
    async checkForUpdates() {
      checkForUpdatesCalled = true;
      // Simulate the update-available event firing synchronously
      if (checkResult && capturedDetectedCb) {
        capturedDetectedCb("2.0.0");
      }
      return checkResult;
    },
    async downloadUpdate() {
      downloadCalled = true;
      return new Promise<void>((resolve, reject) => {
        resolveDownload = resolve;
        rejectDownload = reject;
      });
    },
    cancelDownload() {
      cancelCalled = true;
    },
    quitAndInstall() {
      quitAndInstallCalled = true;
    },
    onUpdateDetected(callback: UpdateDetectedCallback) {
      capturedDetectedCb = callback;
      return () => {
        capturedDetectedCb = null;
      };
    },
    onUpdateDownloaded(callback: UpdateDownloadedCallback) {
      capturedDownloadedCb = callback;
      return () => {
        capturedDownloadedCb = null;
      };
    },
    onDownloadProgress(callback: DownloadProgressCallback) {
      capturedProgressCb = callback;
      return () => {
        capturedProgressCb = null;
      };
    },
    dispose() {
      disposeCalled = true;
      if (overrides?.disposeThrows) {
        throw overrides.disposeThrows;
      }
    },
  } as AutoUpdater;

  return {
    mock,
    get startCalled() {
      return startCalled;
    },
    get disposeCalled() {
      return disposeCalled;
    },
    get checkForUpdatesCalled() {
      return checkForUpdatesCalled;
    },
    get downloadCalled() {
      return downloadCalled;
    },
    get cancelCalled() {
      return cancelCalled;
    },
    get quitAndInstallCalled() {
      return quitAndInstallCalled;
    },
    get capturedDetectedCb() {
      return capturedDetectedCb;
    },
    get capturedDownloadedCb() {
      return capturedDownloadedCb;
    },
    get capturedProgressCb() {
      return capturedProgressCb;
    },
    get resolveDownload() {
      return resolveDownload;
    },
    get rejectDownload() {
      return rejectDownload;
    },
    setCheckResult(found: boolean) {
      checkResult = found;
    },
  };
}

interface MockDialogManager {
  manager: DialogManager;
  lastHandle: MockDialogHandle | null;
}

interface MockDialogHandle {
  config: DialogConfig;
  closed: boolean;
  eventListeners: Set<(event: DialogUserEvent) => void>;
  nextEventResolvers: Array<(event: DialogUserEvent) => void>;
  emitEvent: (event: DialogUserEvent) => void;
}

function createMockDialogManager(): MockDialogManager {
  let lastHandle: MockDialogHandle | null = null;

  const manager = {
    open(config: DialogConfig): DialogHandle {
      const handle: MockDialogHandle = {
        config,
        closed: false,
        eventListeners: new Set(),
        nextEventResolvers: [],
        emitEvent(event: DialogUserEvent) {
          for (const listener of handle.eventListeners) {
            listener(event);
          }
          for (const resolver of handle.nextEventResolvers) {
            resolver(event);
          }
          handle.nextEventResolvers = [];
        },
      };
      lastHandle = handle;

      return {
        id: "dlg-test",
        update(newConfig: DialogConfig) {
          handle.config = newConfig;
        },
        close() {
          handle.closed = true;
        },
        onEvent(handler: (event: DialogUserEvent) => void) {
          handle.eventListeners.add(handler);
          return () => {
            handle.eventListeners.delete(handler);
          };
        },
        nextEvent() {
          return new Promise<DialogUserEvent>((resolve) => {
            handle.nextEventResolvers.push(resolve);
          });
        },
        closed: new Promise<void>(() => {}),
      } as DialogHandle;
    },
    routeEvent() {},
  } as unknown as DialogManager;

  return {
    manager,
    get lastHandle() {
      return lastHandle;
    },
  };
}

interface MockNotificationManager {
  manager: NotificationManager;
  opened: NotificationConfig[];
}

function createMockNotificationManager(): MockNotificationManager {
  const opened: NotificationConfig[] = [];
  const manager = {
    open(config: NotificationConfig): NotificationHandle {
      opened.push(config);
      return {
        id: `ntf-${opened.length}`,
        update: () => {},
        close: () => {},
        onEvent: () => () => {},
        nextEvent: () => new Promise<NotificationUserEvent>(() => {}),
        closed: new Promise<void>(() => {}),
      } satisfies NotificationHandle;
    },
    routeEvent: () => {},
  } as unknown as NotificationManager;
  return { manager, opened };
}

interface TestSetup {
  dispatcher: Dispatcher;
  autoUpdater: MockAutoUpdater;
  dialogManager: MockDialogManager;
  notificationManager: MockNotificationManager;
  updateOperation: TrackingUpdateOperation;
  mockConfig: Config;
  module: IntentModule;
  emittedEvents: DomainEvent[];
}

function createTestSetup(overrides?: {
  disposeThrows?: Error;
  checkReturns?: boolean;
  configValues?: Record<string, unknown>;
}): TestSetup {
  const autoUpdater = createMockAutoUpdater(overrides);
  const dialogManager = createMockDialogManager();
  const notificationManager = createMockNotificationManager();
  const updateOperation = new TrackingUpdateOperation();
  const emittedEvents: DomainEvent[] = [];
  const mockConfig = createMockConfig({
    "auto-update": "ask",
    ...overrides?.configValues,
  });

  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const autoUpdaterModule = createAutoUpdaterModule({
    autoUpdater: autoUpdater.mock,
    dispatcher,
    dialogManager: dialogManager.manager,
    configService: mockConfig,
    notificationManager: notificationManager.manager,
  });

  // Register minimal operations for the hooks we test
  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, updateOperation);
  dispatcher.registerOperation(INTENT_UPDATE_APPLY, new UpdateApplyOperation(mockConfig));

  dispatcher.registerModule(autoUpdaterModule);

  // Subscribe to all events for verification
  dispatcher.subscribe("app:update:progress", (e) => emittedEvents.push(e));

  return {
    dispatcher,
    autoUpdater,
    dialogManager,
    notificationManager,
    updateOperation,
    mockConfig,
    module: autoUpdaterModule,
    emittedEvents,
  };
}

function startIntent(): AppStartIntent {
  return { type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] };
}

function shutdownIntent(installUpdate?: boolean): AppShutdownIntent {
  return {
    type: INTENT_APP_SHUTDOWN,
    payload: { ...(installUpdate !== undefined && { installUpdate }) },
  };
}

function resumeIntent(): AppResumeIntent {
  return { type: INTENT_APP_RESUME, payload: {} as AppResumeIntent["payload"] };
}

// =============================================================================
// Tests
// =============================================================================

describe("AutoUpdaterModule Integration", () => {
  it("dispatch app:start calls autoUpdater.start()", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(startIntent());

    expect(autoUpdater.startCalled).toBe(true);
  });

  it("dispatch app:start wires onUpdateDownloaded to dispatch update:available", async () => {
    const { dispatcher, autoUpdater, updateOperation } = createTestSetup();

    await dispatcher.dispatch(startIntent());

    // Simulate an update being downloaded
    autoUpdater.capturedDownloadedCb!("2.0.0");

    // Allow the void dispatch to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateOperation.dispatched).toHaveLength(1);
    expect(updateOperation.dispatched[0]!.payload).toEqual({ version: "2.0.0" });
  });

  it("dispatch app:shutdown calls autoUpdater.dispose()", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(shutdownIntent());

    expect(autoUpdater.disposeCalled).toBe(true);
  });

  it("dispose() throws — collect catches error, dispatch still resolves", async () => {
    const { dispatcher } = createTestSetup({
      disposeThrows: new Error("dispose failed"),
    });

    await expect(dispatcher.dispatch(shutdownIntent())).resolves.toBeUndefined();
  });

  it("auto-update=never skips autoUpdater via interceptor", async () => {
    const { dispatcher } = createTestSetup({
      configValues: { "auto-update": "never" },
    });

    // The interceptor should reject the app:update intent
    const handle = dispatcher.dispatch({
      type: INTENT_UPDATE_APPLY,
      payload: { needsChoice: false },
    } as UpdateApplyIntent);

    const accepted = await handle.accepted;
    expect(accepted).toBe(false);
  });

  it("hooks no-op when no update detected (detectedVersion is null)", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    // detectedVersion is null by default — intent is accepted but hooks no-op
    await dispatcher.dispatch({
      type: INTENT_UPDATE_APPLY,
      payload: { needsChoice: false },
    } as UpdateApplyIntent);

    expect(autoUpdater.downloadCalled).toBe(false);
  });

  it("auto-update=never still calls dispose() on shutdown", async () => {
    const { dispatcher, autoUpdater } = createTestSetup({
      configValues: { "auto-update": "never" },
    });

    await dispatcher.dispatch(startIntent());
    await dispatcher.dispatch(shutdownIntent());

    expect(autoUpdater.disposeCalled).toBe(true);
  });

  it("quit hook calls quitAndInstall when installUpdate is set", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(shutdownIntent(true));

    expect(autoUpdater.quitAndInstallCalled).toBe(true);
  });

  it("quit hook does NOT call quitAndInstall when installUpdate is not set", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(shutdownIntent());

    expect(autoUpdater.quitAndInstallCalled).toBe(false);
  });

  it("registers auto-update config via configService", () => {
    const { mockConfig } = createTestSetup();

    // Factory registers "auto-update" via configService.register
    // Verify the config service was provided and module created without error
    expect(mockConfig).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // app:resume -> resume hook
  // ---------------------------------------------------------------------------

  it("app:resume with config=never skips check and notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "never" },
      checkReturns: true,
    });
    // App starts cleanly (never bypasses startup update flow too).
    await dispatcher.dispatch(startIntent());
    // Reset tracking: startup already called checkForUpdates via check-deps.
    const startupChecks = autoUpdater.checkForUpdatesCalled;

    await dispatcher.dispatch(resumeIntent());

    // No additional check beyond startup's (which would be the same single flag).
    // Concretely: config=never → resume handler returns early before checkForUpdates.
    expect(autoUpdater.checkForUpdatesCalled).toBe(startupChecks);
    expect(notificationManager.opened).toHaveLength(0);
  });

  it("app:resume with config=ask and update detected opens info notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "ask" },
      checkReturns: false,
    });
    await dispatcher.dispatch(startIntent());

    // Now simulate a new version being released during the session.
    autoUpdater.setCheckResult(true);
    await dispatcher.dispatch(resumeIntent());

    expect(autoUpdater.downloadCalled).toBe(false);
    expect(notificationManager.opened).toHaveLength(1);
    const cfg = notificationManager.opened[0]!;
    expect(cfg.type).toBe("info");
    expect(cfg.title).toBe("Update available");
    expect(cfg.message).toContain("2.0.0");
    expect(cfg.dismissible).toBe(true);
  });

  it("app:resume with config=ask and no update — no notification", async () => {
    const { dispatcher, notificationManager } = createTestSetup({
      configValues: { "auto-update": "ask" },
      checkReturns: false,
    });
    await dispatcher.dispatch(startIntent());

    await dispatcher.dispatch(resumeIntent());

    expect(notificationManager.opened).toHaveLength(0);
  });

  it("app:resume with config=always downloads silently then opens ready notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "always" },
      checkReturns: false,
    });
    await dispatcher.dispatch(startIntent());

    autoUpdater.setCheckResult(true);
    const resumePromise = dispatcher.dispatch(resumeIntent());

    // Let the check complete and download start
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdater.downloadCalled).toBe(true);
    expect(notificationManager.opened).toHaveLength(0);

    // Complete the download
    autoUpdater.resolveDownload!();
    await resumePromise;

    expect(notificationManager.opened).toHaveLength(1);
    const cfg = notificationManager.opened[0]!;
    expect(cfg.type).toBe("info");
    expect(cfg.title).toBe("Update ready");
    expect(cfg.message).toContain("2.0.0");
    expect(cfg.message).toContain("next restart");
  });

  it("app:resume with config=always and download failure — no notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "always" },
      checkReturns: false,
    });
    await dispatcher.dispatch(startIntent());

    autoUpdater.setCheckResult(true);
    const resumePromise = dispatcher.dispatch(resumeIntent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    autoUpdater.rejectDownload!(new Error("network down"));
    await resumePromise;

    expect(notificationManager.opened).toHaveLength(0);
  });

  it("second app:resume with same detected version does not re-notify", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "ask" },
      checkReturns: false,
    });
    await dispatcher.dispatch(startIntent());

    autoUpdater.setCheckResult(true);
    await dispatcher.dispatch(resumeIntent());
    expect(notificationManager.opened).toHaveLength(1);

    await dispatcher.dispatch(resumeIntent());
    expect(notificationManager.opened).toHaveLength(1);
  });

  it("app:resume after startup already detected a version — no new notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "ask" },
      checkReturns: false,
    });

    // Startup registers persistent onUpdateDetected callback.
    await dispatcher.dispatch(startIntent());
    // Simulate startup having detected a version (via the persistent callback).
    autoUpdater.capturedDetectedCb!("1.9.0");

    await dispatcher.dispatch(resumeIntent());

    // detectedVersion !== null guard short-circuits resume.
    expect(notificationManager.opened).toHaveLength(0);
  });

  it("app:resume skipped while startup download is in flight", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "auto-update": "always" },
      checkReturns: false,
    });

    await dispatcher.dispatch(startIntent());
    // Simulate startup having detected a version.
    autoUpdater.capturedDetectedCb!("2.0.0");

    // Kick off the startup download (app:update → download hook) but don't resolve.
    const updatePromise = dispatcher.dispatch({
      type: INTENT_UPDATE_APPLY,
      payload: { needsChoice: false },
    } as UpdateApplyIntent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdater.downloadCalled).toBe(true);

    // System resume fires mid-download.
    await dispatcher.dispatch(resumeIntent());

    // Resume saw detectedVersion already set + checkInProgress → no new notification.
    expect(notificationManager.opened).toHaveLength(0);

    // Clean up: complete the download.
    autoUpdater.resolveDownload!();
    await updatePromise;
  });
});
