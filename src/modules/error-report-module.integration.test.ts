// @vitest-environment node
/**
 * Integration tests for ErrorReportModule — the unified owner of the manual bug
 * report dialog AND the automatic crash handlers.
 *
 * Covers three surfaces:
 *  - the "b" shortcut dialog (reads logs, dispatches bug-report:submit)
 *  - the bug-report:submitted capture (logs + redacted config/state, unconditional)
 *  - the process error handlers (log always; report gated on telemetry; flush+exit)
 */

import { describe, it, expect, vi } from "vitest";
import { createErrorReportModule, type ErrorReportModuleDeps } from "./error-report-module";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
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
import type { DialogHandle } from "./dialog-manager";
import type { DialogUserEvent, DialogConfig } from "../shared/dialog-types";

// =============================================================================
// Helpers
// =============================================================================

function createMockHandle(): DialogHandle & { _emitEvent(event: DialogUserEvent): void } {
  const listeners = new Set<(event: DialogUserEvent) => void>();
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  return {
    id: "dlg-test",
    closed: closedPromise,
    update: vi.fn(),
    close: vi.fn(() => closedResolve()),
    onEvent: vi.fn((handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    nextEvent: vi.fn(),
    _emitEvent(event: DialogUserEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

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
  const handle = createMockHandle();
  const boundary = createMockPostHogBoundary();
  const logger = createMockLogger();
  const exits: number[] = [];

  const deps: ErrorReportModuleDeps = {
    dialogManager: {
      open: vi.fn().mockReturnValue(handle),
      routeEvent: vi.fn(),
    } as unknown as ErrorReportModuleDeps["dialogManager"],
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
    logger,
    exit: (code: number) => exits.push(code),
  };

  const module = createErrorReportModule(deps);
  return { module, deps, handle, boundary, logger, exits };
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

// =============================================================================
// Dialog flow
// =============================================================================

describe("ErrorReportModule — bug report dialog", () => {
  it("opens the dialog on 'b' with the expected config", async () => {
    const { module, deps } = setup();
    await emitKey(module, "b");

    expect(deps.dialogManager.open).toHaveBeenCalledOnce();
    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    expect(config.sections[0]).toMatchObject({ type: "text", content: "Report a Bug" });
    expect(config.sections[1]).toMatchObject({ type: "input", id: "description", multiline: true });
  });

  it("ignores non-'b' keys", async () => {
    const { module, deps } = setup();
    await emitKey(module, "d");
    await emitKey(module, "enter");
    expect(deps.dialogManager.open).not.toHaveBeenCalled();
  });

  it("prevents multiple simultaneous dialogs", async () => {
    const { module, deps } = setup();
    await emitKey(module, "b");
    await emitKey(module, "b");
    expect(deps.dialogManager.open).toHaveBeenCalledOnce();
  });

  it("reads logs and dispatches bug-report:submit on 'send'", async () => {
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { description: "It broke" },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            description: "It broke",
            logs: "test log content\nline 2",
            electronLogs: "electron log content",
          },
        })
      );
    });
    expect(handle.close).toHaveBeenCalled();
  });

  it("closes without dispatching on 'cancel'", async () => {
    const { module, deps, handle } = setup();
    await emitKey(module, "b");
    handle._emitEvent({ dialogId: "dlg-test", actionId: "cancel" });
    expect(handle.close).toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("includes rotated archive log alongside the current log", async () => {
    const { module, deps, handle } = setup();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/logs/test-session.log") return Promise.resolve("CURRENT");
      if (path === "/logs/test-session.old.log") return Promise.resolve("ARCHIVE\n");
      return Promise.reject(new Error("ENOENT"));
    });
    await emitKey(module, "b");
    handle._emitEvent({ dialogId: "dlg-test", actionId: "send", data: { description: "x" } });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ logs: "ARCHIVE\nCURRENT" }) })
      );
    });
  });

  it("tolerates a log read failure", async () => {
    const { module, deps, handle } = setup();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    await emitKey(module, "b");
    handle._emitEvent({ dialogId: "dlg-test", actionId: "send", data: { description: "x" } });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ logs: "" }) })
      );
    });
  });
});

// =============================================================================
// Manual report capture
// =============================================================================

describe("ErrorReportModule — bug-report:submitted capture", () => {
  it("captures a BugReport $exception with compressed logs + redacted config/state", async () => {
    const { module, boundary } = setup({
      configOverrides: { agent: "claude", "log.level": "debug" },
      stateOverrides: { "auto-workspaces": { "github/1": { workspaceName: "pr-1" } } },
    });

    await emitBugReport(module, {
      description: "It crashed",
      logs: "app logs here",
      electronLogs: "electron logs here",
    });

    const captured = boundary.$.capturedEvents.find((e) => e.event === "$exception");
    expect(captured).toBeDefined();
    const props = captured!.properties;
    expect(props["$exception_list"]).toEqual([{ type: "BugReport", value: "It crashed" }]);
    expect(props["logs_format"]).toBe("gzip+base64");
    expect(props["config"]).toEqual({ agent: "claude", "log.level": "debug" });
    expect(props["state"]).toEqual({
      "auto-workspaces": { "github/1": { workspaceName: "pr-1" } },
    });
  });

  it("flushes after a manual report for prompt delivery", async () => {
    const { module, boundary } = setup();
    await emitBugReport(module, { description: "x", logs: "l", electronLogs: "e" });
    expect(boundary.$.flushCount).toBe(1);
  });

  it("sends the manual report even when telemetry is disabled (explicit consent)", async () => {
    const { module, boundary } = setup({ telemetryEnabled: false });
    await emitBugReport(module, { description: "still sends", logs: "l", electronLogs: "" });
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
