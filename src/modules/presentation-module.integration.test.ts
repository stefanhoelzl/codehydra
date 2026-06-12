// @vitest-environment node
/**
 * Integration tests for PresentationModule (Phase A of the UI-state
 * architecture).
 *
 * Covers:
 * - ui:event intake: zod validation, invalid events dropped with a warning
 * - log events routed to the LoggingService (replacement for api:log:*)
 * - app:shutdown removes the ui:event listener
 */

import { describe, it, expect, vi } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import type { IntentModule } from "../intents/lib/module";
import { createMockLogging } from "../boundaries/platform/logging";
import { createBehavioralIpcBoundary } from "../boundaries/shell/ipc.test-utils";
import { ApiIpcChannels } from "../shared/ipc";
import { createPresentationModule } from "./presentation-module";

function createDeps() {
  return {
    ipcLayer: createBehavioralIpcBoundary(),
    loggingService: createMockLogging(),
  };
}

describe("PresentationModule - ui:event intake", () => {
  it("registers a listener on the ui:event channel", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(1);
  });

  it("debug-logs valid events", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "switch-workspace" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "panel-visibility", open: true });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "hover", region: "sidebar" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "close-project", projectId: "p-1234" });

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "switch-workspace" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "panel-visibility" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "hover" });
    expect(logger?.debug).toHaveBeenCalledWith("ui event", { kind: "close-project" });
    expect(logger?.warn).not.toHaveBeenCalled();
  });

  it("drops events with an unknown kind and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "not-a-real-event" });

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledTimes(1);
    expect(logger?.debug).not.toHaveBeenCalled();
  });

  it("drops events with invalid payload fields and warns", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "panel-visibility", open: "yes" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, { kind: "hover", region: "main" });
    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, "not an object");

    const logger = deps.loggingService.getLogger("presenter");
    expect(logger?.warn).toHaveBeenCalledTimes(3);
    expect(logger?.debug).not.toHaveBeenCalled();
  });
});

describe("PresentationModule - log routing", () => {
  it("delegates log events to the correct logger method", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "info",
      logger: "ui",
      message: "test message",
      context: { key: "value" },
    });

    expect(deps.loggingService.createLogger).toHaveBeenCalledWith("ui");
    const logger = deps.loggingService.getLogger("ui");
    expect(logger?.info).toHaveBeenCalledWith("test message", { key: "value" });
  });

  it("falls back to 'ui' logger for invalid logger names", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "warn",
      logger: "invalid-name",
      message: "fallback test",
    });

    const logger = deps.loggingService.getLogger("ui");
    expect(logger?.warn).toHaveBeenCalledWith("fallback test", undefined);
  });

  it("accepts 'api' as a valid renderer logger name", () => {
    const deps = createDeps();
    createPresentationModule(deps);

    deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
      kind: "log",
      level: "debug",
      logger: "api",
      message: "api log",
    });

    expect(deps.loggingService.createLogger).toHaveBeenCalledWith("api");
  });

  it("swallows errors from the logging service", () => {
    const deps = createDeps();
    createPresentationModule(deps);
    deps.loggingService.createLogger = vi.fn(() => {
      throw new Error("logging broke");
    });

    expect(() => {
      deps.ipcLayer._emit(ApiIpcChannels.UI_EVENT, {
        kind: "log",
        level: "error",
        logger: "ui",
        message: "should not crash",
      });
    }).not.toThrow();
  });
});

describe("PresentationModule - shutdown", () => {
  it("removes the ui:event listener on app:shutdown", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const deps = createDeps();
    const presentationModule = createPresentationModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(presentationModule);
    dispatcher.registerModule(quitModule);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(1);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    expect(deps.ipcLayer._getListeners(ApiIpcChannels.UI_EVENT)).toHaveLength(0);
  });
});
