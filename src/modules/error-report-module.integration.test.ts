// @vitest-environment node
/**
 * Integration tests for ErrorReportModule — the unified owner of the manual bug
 * report dialog AND the automatic crash handlers.
 *
 * Covers three surfaces:
 *  - the "b" shortcut dialog (dispatches bug-report:submit with the description)
 *  - the bug-report:submitted capture (reads logs + redacted config/state, unconditional)
 *  - the process error handlers (log always; report gated on telemetry; flush+exit)
 */

import { gunzipSync } from "node:zlib";
import { describe, it, expect, vi } from "vitest";
import { createErrorReportModule, type ErrorReportModuleDeps } from "./error-report-module";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  APP_START_ERROR_HOOK,
  INTENT_APP_START,
  type AppStartIntent,
  type AppStartErrorHookContext,
  type AppStartPhase,
} from "../intents/app-start";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import {
  EVENT_BUG_REPORT_SUBMITTED,
  type BugReportSubmittedEvent,
} from "../intents/submit-bug-report";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { createMockPostHogBoundary } from "../boundaries/platform/posthog.state-mock";
import { createMockConfig, createMockAccessor } from "../boundaries/platform/config.test-utils";
import { createMockState } from "../boundaries/platform/state.test-utils";
import { createViewBoundaryMock } from "../boundaries/shell/view.state-mock";
import { createBehavioralDialogBoundary } from "../boundaries/shell/dialog.test-utils";
import { createMockViewManager } from "../boundaries/shell/view-manager.test-utils";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { DialogMessageBoxOptions } from "../boundaries/shell/dialog";
import type { HookContext } from "../intents/lib/operation";
import { createMockDialogHandle } from "./presentation/dialog-manager.state-mock";
import type { DialogConfig } from "../shared/dialog-types";

// =============================================================================
// Helpers
// =============================================================================

function defaultReadFile(path: string): Promise<string> {
  if (path === "/logs/test-session.log") return Promise.resolve("test log content\nline 2");
  if (path === "/logs/electron.log") return Promise.resolve("electron log content");
  return Promise.reject(new Error("ENOENT"));
}

interface SetupOverrides {
  telemetryEnabled?: boolean;
  configOverrides?: Record<string, unknown>;
  stateOverrides?: Record<string, unknown>;
  dispatch?: (intent: unknown) => Promise<void>;
}

function setup(overrides?: SetupOverrides) {
  const handle = createMockDialogHandle("dlg-test");
  const boundary = createMockPostHogBoundary();
  const logger = createMockLogger();
  const exits: number[] = [];
  const viewLayer = createViewBoundaryMock();
  const uiViewHandle = viewLayer.adoptWindowWebContents({
    id: "window-1",
    __brand: "WindowHandle",
  });
  const dialogBoundary = createBehavioralDialogBoundary();

  const deps: ErrorReportModuleDeps = {
    ui: {
      dialog: vi.fn().mockReturnValue(handle.handle),
    } as unknown as ErrorReportModuleDeps["ui"],
    fileSystem: { readFile: vi.fn().mockImplementation(defaultReadFile) },
    loggingService: {
      getLogFilePath: vi.fn().mockReturnValue("/logs/test-session.log"),
      getElectronLogFilePath: vi.fn().mockReturnValue("/logs/electron.log"),
    },
    dispatcher: {
      dispatch: vi.fn(overrides?.dispatch ?? (async () => {})),
    } as unknown as ErrorReportModuleDeps["dispatcher"],
    boundary,
    configService: createMockConfig({
      ...(overrides?.configOverrides !== undefined && { overrides: overrides.configOverrides }),
    }),
    stateService: createMockState({
      ...(overrides?.stateOverrides !== undefined && { overrides: overrides.stateOverrides }),
    }),
    telemetryEnabled: createMockAccessor<boolean>(
      "telemetry.enabled",
      overrides?.telemetryEnabled ?? true
    ),
    dialogBoundary,
    viewLayer,
    viewManager: createMockViewManager({ overrides: { getUIViewHandle: () => uiViewHandle } }),
    logger,
    exit: (code: number) => exits.push(code),
  };

  const module = createErrorReportModule(deps);
  return { module, deps, handle, boundary, logger, exits, viewLayer, uiViewHandle, dialogBoundary };
}

async function emitKey(module: ReturnType<typeof setup>["module"], key: string): Promise<void> {
  const event: ShortcutKeyPressedEvent = { type: EVENT_SHORTCUT_KEY_PRESSED, payload: { key } };
  await module.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);
}

async function emitBugReport(
  module: ReturnType<typeof setup>["module"],
  payload: BugReportSubmittedEvent["payload"]
): Promise<void> {
  const event: BugReportSubmittedEvent = { type: EVENT_BUG_REPORT_SUBMITTED, payload };
  await module.events![EVENT_BUG_REPORT_SUBMITTED]!.handler(event);
}

/** Decompress a gzip+base64 log blob back to its raw string. */
function decompressLog(blob: unknown): string {
  return typeof blob === "string" && blob ? gunzipSync(Buffer.from(blob, "base64")).toString() : "";
}

/** Stub process.on, dispatch app:start to register the crash handlers, return them. */
async function registerCrashHandlers(
  module: ReturnType<typeof setup>["module"]
): Promise<Map<string, (...args: unknown[]) => void>> {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on;
  process.on = ((event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on;

  try {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(
      INTENT_APP_START,
      createMinimalOperation(APP_START_OPERATION_ID, "before-ready")
    );
    dispatcher.registerModule(module);
    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {} as AppStartIntent["payload"],
    });
  } finally {
    process.on = originalOn;
  }
  return handlers;
}

/** Run the app:start "error" hook with a fatal error + phase (as the operation does). */
async function runStartupErrorHook(
  module: ReturnType<typeof setup>["module"],
  error: Error,
  phase: AppStartPhase
): Promise<void> {
  const ctx: AppStartErrorHookContext = {
    intent: { type: INTENT_APP_START, payload: {} } as AppStartIntent,
    error,
    phase,
  };
  await module.hooks![APP_START_OPERATION_ID]![APP_START_ERROR_HOOK]!.handler(ctx);
}

// =============================================================================
// Dialog flow
// =============================================================================

describe("ErrorReportModule — bug report dialog", () => {
  it("opens the dialog on 'b' with the expected config", async () => {
    const { module, deps } = setup();
    await emitKey(module, "b");

    expect(deps.ui.dialog).toHaveBeenCalledOnce();
    const config = (deps.ui.dialog as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DialogConfig;
    expect(config.sections[0]).toMatchObject({ type: "text", content: "Report a Bug" });
    expect(config.sections[1]).toMatchObject({ type: "input", id: "description", multiline: true });
  });

  it("ignores non-'b' keys", async () => {
    const { module, deps } = setup();
    await emitKey(module, "d");
    await emitKey(module, "enter");
    expect(deps.ui.dialog).not.toHaveBeenCalled();
  });

  it("prevents multiple simultaneous dialogs", async () => {
    const { module, deps } = setup();
    await emitKey(module, "b");
    await emitKey(module, "b");
    expect(deps.ui.dialog).toHaveBeenCalledOnce();
  });

  it("dispatches bug-report:submit with only the description on 'send'", async () => {
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle.emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { description: "It broke" },
    });

    expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { description: "It broke" } })
    );
    // Log-gathering now lives in the submitted handler, not the dialog.
    expect(deps.fileSystem.readFile).not.toHaveBeenCalled();
    expect(handle.handle.close).toHaveBeenCalled();
  });

  it("ignores a second 'send' while the first is in flight", async () => {
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle.emitEvent({ dialogId: "dlg-test", actionId: "send", data: { description: "x" } });
    handle.emitEvent({ dialogId: "dlg-test", actionId: "send", data: { description: "x" } });

    await vi.waitFor(() => expect(handle.handle.close).toHaveBeenCalled());
    expect(deps.dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("closes without dispatching on 'cancel'", async () => {
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle.emitEvent({ dialogId: "dlg-test", actionId: "cancel" });
    expect(handle.handle.close).toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("clears the active-handle guard on Cancel so the dialog can reopen", async () => {
    // Escape is routed to the Cancel button (role "cancel") by the form, so
    // discarding the draft is just the cancel action: close + clear the guard.
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle.emitEvent({ dialogId: "dlg-test", actionId: "cancel" });
    expect(handle.handle.close).toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();

    // The active-handle guard is cleared — 'b' opens a fresh dialog.
    await emitKey(module, "b");
    expect(deps.ui.dialog).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Manual report capture
// =============================================================================

describe("ErrorReportModule — bug-report:submitted capture", () => {
  it("reads logs itself and captures a BugReport $exception with redacted config/state", async () => {
    const { module, boundary } = setup({
      configOverrides: { agent: "claude", "log.level": "debug" },
      stateOverrides: { "auto-workspaces": { "github/1": { workspaceName: "pr-1" } } },
    });

    // The handler gathers logs from the filesystem; the event carries only the
    // description (defaultReadFile supplies the log/electron-log content).
    await emitBugReport(module, { description: "It crashed" });

    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured).toBeDefined();
    const props = captured!.properties;
    expect(props["$exception_list"]).toEqual([{ type: "BugReport", value: "It crashed" }]);
    expect(props["logs_format"]).toBe("gzip+base64");
    expect(decompressLog(props["logs"])).toBe("test log content\nline 2");
    expect(decompressLog(props["electron_logs"])).toBe("electron log content");
    expect(props["config"]).toEqual({ agent: "claude", "log.level": "debug" });
    expect(props["state"]).toEqual({
      "auto-workspaces": { "github/1": { workspaceName: "pr-1" } },
    });
  });

  it("includes the rotated archive log alongside the current log", async () => {
    const { module, boundary, deps } = setup();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/logs/test-session.log") return Promise.resolve("CURRENT");
      if (path === "/logs/test-session.old.log") return Promise.resolve("ARCHIVE\n");
      return Promise.reject(new Error("ENOENT"));
    });

    await emitBugReport(module, { description: "x" });

    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(decompressLog(captured!.properties["logs"])).toBe("ARCHIVE\nCURRENT");
  });

  it("tolerates a log read failure", async () => {
    const { module, boundary, deps } = setup();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    await emitBugReport(module, { description: "x" });

    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured).toBeDefined();
    expect(captured!.properties["logs_format"]).toBe("none");
    expect(decompressLog(captured!.properties["logs"])).toBe("");
  });

  it("flushes after a manual report for prompt delivery", async () => {
    const { module, boundary } = setup();
    await emitBugReport(module, { description: "x" });
    expect(boundary.$.flushCount).toBe(1);
  });

  it("sends the manual report even when telemetry is disabled (explicit consent)", async () => {
    const { module, boundary } = setup({ telemetryEnabled: false });
    await emitBugReport(module, { description: "still sends" });
    expect(boundary).toHaveCapturedError();
  });
});

// =============================================================================
// Crash handlers
// =============================================================================

describe("ErrorReportModule — crash handlers", () => {
  it("registers both process error handlers in before-ready", async () => {
    const { module } = setup();
    const handlers = await registerCrashHandlers(module);
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
  });

  it("uncaughtException: logs, reports with config/state, flushes, then exits", async () => {
    const { module, boundary, logger, exits } = setup({
      telemetryEnabled: true,
      configOverrides: { "log.level": "debug" },
    });
    const handlers = await registerCrashHandlers(module);

    handlers.get("uncaughtException")!(new Error("boom"), "uncaughtException");

    await vi.waitFor(() => expect(exits).toContain(1));
    expect(logger.error).toHaveBeenCalledWith("Uncaught exception", {}, expect.any(Error));
    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured!.properties["config"]).toEqual({ "log.level": "debug" });
    expect(captured!.properties["logs_format"]).toBe("gzip+base64");
    expect(boundary.$.shutdownCalled).toBe(true); // flushed before exit
  });

  it("uncaughtException: still logs + exits but does NOT report when telemetry is off", async () => {
    const { module, boundary, logger, exits } = setup({ telemetryEnabled: false });
    const handlers = await registerCrashHandlers(module);

    handlers.get("uncaughtException")!(new Error("boom"), "uncaughtException");

    await vi.waitFor(() => expect(exits).toContain(1));
    expect(logger.error).toHaveBeenCalled();
    expect(boundary.$.capturedEvents).toHaveLength(0);
    expect(boundary.$.shutdownCalled).toBe(false);
  });

  it("unhandledRejection: logs + reports but does NOT exit", async () => {
    const { module, boundary, logger, exits } = setup({ telemetryEnabled: true });
    const handlers = await registerCrashHandlers(module);

    handlers.get("unhandledRejection")!(new Error("rejected"));

    await vi.waitFor(() =>
      expect(boundary.$.capturedEvents.some((e) => e.event === "$exception")).toBe(true)
    );
    expect(logger.error).toHaveBeenCalledWith("Unhandled promise rejection", {}, expect.any(Error));
    expect(exits).toHaveLength(0);
  });

  it("unhandledRejection: wraps a non-Error reason", async () => {
    const { module, boundary } = setup({ telemetryEnabled: true });
    const handlers = await registerCrashHandlers(module);

    handlers.get("unhandledRejection")!("string reason");

    await vi.waitFor(() =>
      expect(boundary.$.capturedEvents.some((e) => e.event === "$exception")).toBe(true)
    );
    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured!.properties["$exception_list"]).toEqual([
      { type: "Error", value: "string reason" },
    ]);
  });

  it("does not report on unhandledRejection when telemetry is off", async () => {
    const { module, boundary } = setup({ telemetryEnabled: false });
    const handlers = await registerCrashHandlers(module);

    handlers.get("unhandledRejection")!(new Error("rejected"));
    await Promise.resolve();

    expect(boundary.$.capturedEvents).toHaveLength(0);
  });
});

// =============================================================================
// UI renderer crash guard
// =============================================================================

/** Run the app-start/init hook that subscribes the guard on the UI view. */
async function subscribeUiCrashGuard(module: ReturnType<typeof setup>["module"]): Promise<void> {
  const ctx: HookContext = {
    intent: { type: INTENT_APP_START, payload: {} } as AppStartIntent,
    capabilities: { "ui-ready": true },
  };
  await module.hooks![APP_START_OPERATION_ID]!["init"]!.handler(ctx);
}

const UI_EXCEPTION = {
  message: "Error: effect_update_depth_exceeded",
  stack: "Error: effect_update_depth_exceeded\n    at flush (file:///ui/main.js:1:1)",
  isPromiseRejection: false,
};

describe("ErrorReportModule — UI renderer crash guard", () => {
  it("requires the ui-ready capability before subscribing", () => {
    const { module } = setup();
    expect(module.hooks![APP_START_OPERATION_ID]!["init"]!.requires).toHaveProperty("ui-ready");
  });

  it("uncaught exception: logs + reports with crash_source + logs/config, but does NOT show a dialog or quit", async () => {
    const s = setup({ telemetryEnabled: true, configOverrides: { "log.level": "debug" } });
    await subscribeUiCrashGuard(s.module);

    s.viewLayer.$.triggerUncaughtException(s.uiViewHandle, UI_EXCEPTION);

    expect(s.logger.error).toHaveBeenCalledWith(
      "Uncaught exception in UI renderer",
      {},
      expect.any(Error)
    );
    await vi.waitFor(() => {
      const captured = s.boundary.$.capturedEvents.find((e) => e.event === "$exception");
      expect(captured).toBeDefined();
      expect(captured!.properties["crash_source"]).toBe("ui-renderer-exception");
      expect(captured!.properties["logs_format"]).toBe("gzip+base64");
      expect(captured!.properties["config"]).toEqual({ "log.level": "debug" });
    });

    // The renderer process is still alive — a single mid-session throw must NOT
    // force-quit the app (only render-process-gone does).
    expect(s.dialogBoundary._getState().messageBoxCount).toBe(0);
    expect(s.deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches app:shutdown once the quit dialog is dismissed (render-process-gone)", async () => {
    const s = setup();
    await subscribeUiCrashGuard(s.module);

    s.viewLayer.$.triggerRenderProcessGone(s.uiViewHandle, { reason: "crashed", exitCode: 1 });

    await vi.waitFor(() => {
      expect(s.deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_APP_SHUTDOWN })
      );
    });
  });

  it("uncaught exception: logs but does NOT report when telemetry is off, and never quits", async () => {
    const s = setup({ telemetryEnabled: false });
    await subscribeUiCrashGuard(s.module);

    s.viewLayer.$.triggerUncaughtException(s.uiViewHandle, UI_EXCEPTION);

    await Promise.resolve();
    expect(s.boundary.$.capturedEvents).toHaveLength(0);
    expect(s.dialogBoundary._getState().messageBoxCount).toBe(0);
    expect(s.deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("unhandled rejection: reports without a dialog", async () => {
    const s = setup({ telemetryEnabled: true });
    await subscribeUiCrashGuard(s.module);

    s.viewLayer.$.triggerUncaughtException(s.uiViewHandle, {
      message: "Error: lost in space",
      stack: "",
      isPromiseRejection: true,
    });

    await vi.waitFor(() => {
      const captured = s.boundary.$.capturedEvents.find((e) => e.event === "$exception");
      expect(captured).toBeDefined();
      expect(captured!.properties["crash_source"]).toBe("ui-renderer-rejection");
    });
    expect(s.dialogBoundary._getState().messageBoxCount).toBe(0);
    expect(s.deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("render-process-gone: shows the quit dialog and reports", async () => {
    const s = setup({ telemetryEnabled: true });
    await subscribeUiCrashGuard(s.module);

    s.viewLayer.$.triggerRenderProcessGone(s.uiViewHandle, { reason: "oom", exitCode: 137 });

    const state = s.dialogBoundary._getState();
    expect(state.messageBoxCount).toBe(1);
    const options = state.calls[0]!.options as DialogMessageBoxOptions;
    expect(options.type).toBe("error");
    expect(options.buttons).toEqual(["Quit CodeHydra"]);
    expect(options.detail).toContain("UI renderer process gone: oom (exit code 137)");
    await vi.waitFor(() => {
      const captured = s.boundary.$.capturedEvents.find((e) => e.event === "$exception");
      expect(captured).toBeDefined();
      expect(captured!.properties["crash_source"]).toBe("ui-renderer-process-gone");
      expect(captured!.properties["$exception_list"]).toEqual([
        { type: "UIRendererProcessGone", value: "UI renderer process gone: oom (exit code 137)" },
      ]);
    });
  });

  it("does not stack dialogs on repeated crash signals", async () => {
    const s = setup();
    await subscribeUiCrashGuard(s.module);

    // Uncaught exceptions never open a dialog; repeated render-process-gone
    // signals must not stack a second quit dialog on top of the first.
    s.viewLayer.$.triggerUncaughtException(s.uiViewHandle, UI_EXCEPTION);
    s.viewLayer.$.triggerRenderProcessGone(s.uiViewHandle, { reason: "crashed", exitCode: 1 });
    s.viewLayer.$.triggerRenderProcessGone(s.uiViewHandle, { reason: "crashed", exitCode: 1 });

    expect(s.dialogBoundary._getState().messageBoxCount).toBe(1);
  });
});

// =============================================================================
// Startup failure report (app:start "error" hook)
// =============================================================================

describe("ErrorReportModule — startup failure report", () => {
  it("reports crash_source:startup + phase with logs/config on a fatal startup failure", async () => {
    const { module, boundary } = setup({
      telemetryEnabled: true,
      configOverrides: { "log.level": "debug" },
    });

    await runStartupErrorHook(module, new Error("Failed to start code-server"), "start");

    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured).toBeDefined();
    expect(captured!.properties["crash_source"]).toBe("startup");
    expect(captured!.properties["phase"]).toBe("start");
    expect(captured!.properties["logs_format"]).toBe("gzip+base64");
    expect(captured!.properties["config"]).toEqual({ "log.level": "debug" });
    expect(captured!.properties["$exception_list"]).toEqual([
      { type: "Error", value: "Failed to start code-server" },
    ]);
    // flushed (shutdown) so the report lands before the app quits
    expect(boundary.$.shutdownCalled).toBe(true);
  });

  it("does NOT report when telemetry is off", async () => {
    const { module, boundary } = setup({ telemetryEnabled: false });

    await runStartupErrorHook(module, new Error("boom"), "start");

    expect(boundary.$.capturedEvents).toHaveLength(0);
    expect(boundary.$.shutdownCalled).toBe(false);
  });
});
