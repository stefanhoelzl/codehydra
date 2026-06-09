// @vitest-environment node
/**
 * Integration tests for AutoUpdaterModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> Operation -> hook point -> AutoUpdaterModule handler
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

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
import { createAutoUpdaterModule } from "./auto-updater-module";
import type { AutoUpdater, UpdateDetectedCallback, DownloadProgressCallback } from "./auto-updater";
import {
  createMockConfig as createBaseMockConfig,
  type CreateMockConfigOptions,
} from "../boundaries/platform/config.test-utils";
import { createMockState } from "../boundaries/platform/state.test-utils";
import { createStateMigrationRegistry } from "./state-module";
import type { Config } from "../boundaries/platform/config";
import type { StateService } from "../boundaries/platform/state-service";
import {
  createMockNotificationManager,
  type MockNotificationManager,
} from "./notification-manager.state-mock";

/**
 * Auto-updater tests expect `update.notification` to default to true unless
 * the test explicitly sets it. Seed it on top of the shared helper.
 */
function createMockConfig(options?: CreateMockConfigOptions): Config {
  return createBaseMockConfig({
    defaults: { "update.notification": true, ...(options?.defaults ?? {}) },
    ...(options?.overrides !== undefined && { overrides: options.overrides }),
  });
}

// =============================================================================
// Mock AutoUpdater
// =============================================================================

interface MockAutoUpdater {
  mock: AutoUpdater;
  startCalled: boolean;
  disposeCalled: boolean;
  checkForUpdatesCallCount: number;
  downloadCalled: boolean;
  quitAndInstallCalled: boolean;
  capturedDetectedCb: UpdateDetectedCallback | null;
  capturedProgressCb: DownloadProgressCallback | null;
  resolveDownload: (() => void) | null;
  rejectDownload: ((error: Error) => void) | null;
  setCheckResult: (found: boolean, version?: string) => void;
}

function createMockAutoUpdater(overrides?: {
  disposeThrows?: Error;
  checkReturns?: boolean;
}): MockAutoUpdater {
  let startCalled = false;
  let disposeCalled = false;
  let checkForUpdatesCallCount = 0;
  let downloadCalled = false;
  let quitAndInstallCalled = false;
  let capturedDetectedCb: UpdateDetectedCallback | null = null;
  let capturedProgressCb: DownloadProgressCallback | null = null;
  let resolveDownload: (() => void) | null = null;
  let rejectDownload: ((error: Error) => void) | null = null;
  let checkResult = overrides?.checkReturns ?? false;
  let detectedVersion = "2.0.0";

  const mock: AutoUpdater = {
    start() {
      startCalled = true;
    },
    async checkForUpdates() {
      checkForUpdatesCallCount++;
      if (checkResult && capturedDetectedCb) {
        capturedDetectedCb(detectedVersion);
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
    cancelDownload() {},
    quitAndInstall() {
      quitAndInstallCalled = true;
    },
    onUpdateDetected(callback: UpdateDetectedCallback) {
      capturedDetectedCb = callback;
      return () => {
        capturedDetectedCb = null;
      };
    },
    onUpdateDownloaded() {
      return () => {};
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
  } as unknown as AutoUpdater;

  return {
    mock,
    get startCalled() {
      return startCalled;
    },
    get disposeCalled() {
      return disposeCalled;
    },
    get checkForUpdatesCallCount() {
      return checkForUpdatesCallCount;
    },
    get downloadCalled() {
      return downloadCalled;
    },
    get quitAndInstallCalled() {
      return quitAndInstallCalled;
    },
    get capturedDetectedCb() {
      return capturedDetectedCb;
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
    setCheckResult(found: boolean, version?: string) {
      checkResult = found;
      if (version) detectedVersion = version;
    },
  };
}

interface TestSetup {
  dispatcher: Dispatcher;
  autoUpdater: MockAutoUpdater;
  notificationManager: MockNotificationManager;
  mockConfig: Config;
  mockState: StateService;
}

function createTestSetup(overrides?: {
  disposeThrows?: Error;
  checkReturns?: boolean;
  configValues?: Record<string, unknown>;
  config?: Config;
  state?: StateService;
}): TestSetup {
  const autoUpdater = createMockAutoUpdater(overrides);
  const notificationManager = createMockNotificationManager();
  const mockConfig =
    overrides?.config ?? createMockConfig({ defaults: overrides?.configValues ?? {} });
  // update.dismissed-version now lives in state.json (StateService), not config.
  const mockState = overrides?.state ?? createMockState();

  const dispatcher = createMockDispatcher();

  const autoUpdaterModule = createAutoUpdaterModule({
    autoUpdater: autoUpdater.mock,
    dispatcher,
    configService: mockConfig,
    stateService: mockState,
    stateMigrations: createStateMigrationRegistry(),
    notificationManager: notificationManager.manager,
  });

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_APP_RESUME, new AppResumeOperation());

  dispatcher.registerModule(autoUpdaterModule);

  return { dispatcher, autoUpdater, notificationManager, mockConfig, mockState };
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

// Tiny helper to flush microtasks (and the void runCheck() chain).
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================
// Tests
// =============================================================================

describe("AutoUpdaterModule Integration", () => {
  it("app:start calls autoUpdater.start() and runs initial check", async () => {
    const { dispatcher, autoUpdater } = createTestSetup();

    await dispatcher.dispatch(startIntent());
    await flush();

    expect(autoUpdater.startCalled).toBe(true);
    expect(autoUpdater.checkForUpdatesCallCount).toBe(1);
  });

  it("app:start with update.notification=false skips check and timer", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      configValues: { "update.notification": false },
      checkReturns: true,
    });

    await dispatcher.dispatch(startIntent());
    await flush();

    expect(autoUpdater.checkForUpdatesCallCount).toBe(0);
    expect(notificationManager.notifications).toHaveLength(0);
  });

  it("startup check finding an update opens 'Update available' notification", async () => {
    const { dispatcher, notificationManager } = createTestSetup({ checkReturns: true });

    await dispatcher.dispatch(startIntent());
    await flush();

    expect(notificationManager.notifications).toHaveLength(1);
    const cfg = notificationManager.notifications[0]!.opened;
    expect(cfg.type).toBe("info");
    expect(cfg.title).toBe("Update available");
    expect(cfg.message).toContain("2.0.0");
    expect(cfg.dismissible).toBe(true);
    expect(cfg.actions).toEqual([{ id: "install", label: "Install" }]);
  });

  it("clicking Install triggers download and surfaces 'Update ready' on completion", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();

    expect(autoUpdater.downloadCalled).toBe(true);
    // Notification updated to downloading state
    const slot = notificationManager.notifications[0]!;
    expect(slot.updates[0]!.title).toBe("Downloading update");

    // Download completes
    autoUpdater.resolveDownload!();
    await flush();

    const last = slot.updates[slot.updates.length - 1]!;
    expect(last.title).toBe("Update ready");
    expect(last.actions).toEqual([{ id: "restart", label: "Restart Now" }]);
    expect(last.dismissible).toBe(false);
  });

  it("download progress events update the notification with percent", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();

    autoUpdater.capturedProgressCb!({ percent: 50 });
    const slot = notificationManager.notifications[0]!;
    const progressUpdate = slot.updates.find((u) => u.progress === 0.5);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate!.title).toBe("Downloading update");
  });

  it("download failure swaps to 'Update failed' notification with retry", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();

    autoUpdater.rejectDownload!(new Error("network down"));
    await flush();

    const slot = notificationManager.notifications[0]!;
    const last = slot.updates[slot.updates.length - 1]!;
    expect(last.type).toBe("error");
    expect(last.title).toBe("Update failed");
    expect(last.actions).toEqual([{ id: "retry", label: "Retry" }]);
  });

  it("clicking Restart dispatches app:shutdown with installUpdate", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();
    autoUpdater.resolveDownload!();
    await flush();

    notificationManager.emitEvent(0, { actionId: "restart" });
    await flush();

    expect(autoUpdater.quitAndInstallCalled).toBe(true);
  });

  it("app:resume runs an update check", async () => {
    const { dispatcher, autoUpdater } = createTestSetup({ checkReturns: false });
    await dispatcher.dispatch(startIntent());
    await flush();
    const startupCount = autoUpdater.checkForUpdatesCallCount;

    await dispatcher.dispatch(resumeIntent());

    expect(autoUpdater.checkForUpdatesCallCount).toBe(startupCount + 1);
  });

  it("app:resume with update.notification=false does not check", async () => {
    const { dispatcher, autoUpdater } = createTestSetup({
      configValues: { "update.notification": false },
    });
    await dispatcher.dispatch(startIntent());

    await dispatcher.dispatch(resumeIntent());

    expect(autoUpdater.checkForUpdatesCallCount).toBe(0);
  });

  it("second check after a version was surfaced does not open another notification", async () => {
    const { dispatcher, notificationManager } = createTestSetup({ checkReturns: true });
    await dispatcher.dispatch(startIntent());
    await flush();
    expect(notificationManager.notifications).toHaveLength(1);

    await dispatcher.dispatch(resumeIntent());
    await flush();

    expect(notificationManager.notifications).toHaveLength(1);
  });

  it("a newer version on resume refreshes the existing notification in place", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();
    expect(notificationManager.notifications).toHaveLength(1);
    expect(notificationManager.notifications[0]!.opened.message).toContain("2.0.0");

    autoUpdater.setCheckResult(true, "3.0.0");
    await dispatcher.dispatch(resumeIntent());
    await flush();

    // Still a single notification, updated (not re-opened) to the newer version.
    expect(notificationManager.notifications).toHaveLength(1);
    const slot = notificationManager.notifications[0]!;
    const last = slot.updates[slot.updates.length - 1]!;
    expect(last.title).toBe("Update available");
    expect(last.message).toContain("3.0.0");
  });

  it("a newer version reverts a 'ready' notification back to 'Update available'", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    // Download to completion → "Update ready".
    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();
    autoUpdater.resolveDownload!();
    await flush();
    const slot = notificationManager.notifications[0]!;
    expect(slot.updates[slot.updates.length - 1]!.title).toBe("Update ready");

    // Newer version detected on resume reverts to "Update available".
    autoUpdater.setCheckResult(true, "3.0.0");
    await dispatcher.dispatch(resumeIntent());
    await flush();

    expect(notificationManager.notifications).toHaveLength(1);
    const last = slot.updates[slot.updates.length - 1]!;
    expect(last.title).toBe("Update available");
    expect(last.message).toContain("3.0.0");
    expect(last.actions).toEqual([{ id: "install", label: "Install" }]);
  });

  it("Install after a version refresh downloads the newer version", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    autoUpdater.setCheckResult(true, "3.0.0");
    await dispatcher.dispatch(resumeIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "install" });
    await flush();

    expect(autoUpdater.downloadCalled).toBe(true);
    const slot = notificationManager.notifications[0]!;
    const downloading = slot.updates.find((u) => u.title === "Downloading update");
    expect(downloading!.message).toContain("3.0.0");
  });

  it("dismissing then re-checking the same version stays silent", async () => {
    const { dispatcher, notificationManager } = createTestSetup({ checkReturns: true });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "dismiss" });

    await dispatcher.dispatch(resumeIntent());
    await flush();

    // No second notification opened for the already-dismissed version.
    expect(notificationManager.notifications).toHaveLength(1);
  });

  it("dismissing then a newer version re-surfaces the notification", async () => {
    const { dispatcher, autoUpdater, notificationManager } = createTestSetup({
      checkReturns: true,
    });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "dismiss" });

    autoUpdater.setCheckResult(true, "3.0.0");
    await dispatcher.dispatch(resumeIntent());
    await flush();

    // A fresh notification opened for the genuinely newer version.
    expect(notificationManager.notifications).toHaveLength(2);
    const newest = notificationManager.notifications[1]!;
    expect(newest.opened.title).toBe("Update available");
    expect(newest.opened.message).toContain("3.0.0");
  });

  it("dismissing closes the notification so the renderer removes it", async () => {
    const { dispatcher, notificationManager } = createTestSetup({ checkReturns: true });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "dismiss" });

    expect(notificationManager.notifications[0]!.closed).toBe(true);
  });

  it("dismissing persists the dismissed version to state", async () => {
    const { dispatcher, notificationManager, mockState } = createTestSetup({ checkReturns: true });
    await dispatcher.dispatch(startIntent());
    await flush();

    notificationManager.emitEvent(0, { actionId: "dismiss" });
    await flush();

    expect(mockState.getEffective()["update.dismissed-version"]).toBe("2.0.0");
  });

  it("a version dismissed in a previous run stays silent after restart", async () => {
    // First run: dismiss the surfaced version, which persists to the shared state.
    const state = createMockState();
    const first = createTestSetup({ checkReturns: true, state });
    await first.dispatcher.dispatch(startIntent());
    await flush();
    first.notificationManager.emitEvent(0, { actionId: "dismiss" });
    await flush();

    // Second run (fresh module + notifications) reusing the same persisted state.
    const second = createTestSetup({ checkReturns: true, state });
    await second.dispatcher.dispatch(startIntent());
    await flush();

    // The restored dismissed version silences the same-version notification.
    expect(second.notificationManager.notifications).toHaveLength(0);
  });

  it("app:shutdown calls autoUpdater.dispose()", async () => {
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
});
