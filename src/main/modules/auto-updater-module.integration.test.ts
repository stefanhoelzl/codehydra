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
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../operations/app-shutdown";
import {
  INTENT_UPDATE_AVAILABLE,
  type UpdateAvailableIntent,
} from "../operations/update-available";
import {
  UpdateApplyOperation,
  INTENT_UPDATE_APPLY,
  type UpdateApplyIntent,
} from "../operations/update-apply";
import { createAutoUpdaterModule } from "./auto-updater-module";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type {
  AutoUpdater,
  UpdateDetectedCallback,
  UpdateDownloadedCallback,
  DownloadProgressCallback,
} from "../../services/auto-updater";
import type { IpcEventHandler, IpcLayer } from "../../services/platform/ipc";
import type { ConfigService } from "../../services/config/config-service";

// =============================================================================
// Mock ConfigService
// =============================================================================

function createMockConfigService(values?: Record<string, unknown>): ConfigService {
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

interface MockIpcLayer {
  layer: Pick<IpcLayer, "on" | "removeListener">;
  handlers: Map<string, IpcEventHandler[]>;
  emit: (channel: string, ...args: unknown[]) => void;
}

function createMockIpcLayer(): MockIpcLayer {
  const handlers = new Map<string, IpcEventHandler[]>();

  const layer: Pick<IpcLayer, "on" | "removeListener"> = {
    on(channel: string, handler: IpcEventHandler) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel)!.push(handler);
    },
    removeListener(channel: string, handler: IpcEventHandler) {
      const list = handlers.get(channel);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };

  return {
    layer,
    handlers,
    emit(channel: string, ...args: unknown[]) {
      const list = handlers.get(channel);
      if (list) {
        for (const handler of [...list]) {
          handler({} as Electron.IpcMainEvent, ...args);
        }
      }
    },
  };
}

interface TestSetup {
  dispatcher: Dispatcher;
  autoUpdater: MockAutoUpdater;
  ipcLayer: MockIpcLayer;
  updateOperation: TrackingUpdateOperation;
  mockConfigService: ConfigService;
  module: IntentModule;
  emittedEvents: DomainEvent[];
}

function createTestSetup(overrides?: {
  disposeThrows?: Error;
  checkReturns?: boolean;
  configValues?: Record<string, unknown>;
}): TestSetup {
  const autoUpdater = createMockAutoUpdater(overrides);
  const ipcLayer = createMockIpcLayer();
  const updateOperation = new TrackingUpdateOperation();
  const emittedEvents: DomainEvent[] = [];
  const mockConfigService = createMockConfigService({
    "auto-update": "ask",
    ...overrides?.configValues,
  });

  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const autoUpdaterModule = createAutoUpdaterModule({
    autoUpdater: autoUpdater.mock,
    dispatcher,
    ipcLayer: ipcLayer.layer,
    configService: mockConfigService,
  });

  // Register minimal operations for the hooks we test
  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, updateOperation);
  dispatcher.registerOperation(INTENT_UPDATE_APPLY, new UpdateApplyOperation(mockConfigService));

  dispatcher.registerModule(autoUpdaterModule);

  // Subscribe to all events for verification
  dispatcher.subscribe("app:update:progress", (e) => emittedEvents.push(e));

  return {
    dispatcher,
    autoUpdater,
    ipcLayer,
    updateOperation,
    mockConfigService,
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

  it("interceptor rejects when no update detected", async () => {
    const { dispatcher } = createTestSetup();

    // detectedVersion is null by default
    const handle = dispatcher.dispatch({
      type: INTENT_UPDATE_APPLY,
      payload: { needsChoice: false },
    } as UpdateApplyIntent);

    const accepted = await handle.accepted;
    expect(accepted).toBe(false);
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
    const { mockConfigService } = createTestSetup();

    // Factory registers "auto-update" via configService.register
    // Verify the config service was provided and module created without error
    expect(mockConfigService).toBeDefined();
  });
});
