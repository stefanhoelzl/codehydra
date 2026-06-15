/**
 * ErrorReportModule - the single owner of error reporting, automatic and manual.
 *
 * Merges the former error-handler-module (log + crash) and bug-report-module
 * (manual "Report a Bug" dialog). One module owns every `process.on` error
 * handler, so there is no collision over the fatal uncaughtException path, and
 * crash reports can read logs → capture → flush → exit cleanly.
 *
 * Hooks:
 * - app:start / before-ready: register the sole process error handlers.
 *     unhandledRejection → log; report (if telemetry on); never exits (Electron
 *       runs --unhandled-rejections=warn, so the process survives).
 *     uncaughtException  → log; report + flush (if telemetry on, with timeout);
 *       ALWAYS exit(1). Logging + exit are unconditional (crash behavior is
 *       preserved with telemetry off); only the telemetry report is gated.
 * - app:start / init (after "ui-ready"): subscribe the UI renderer crash guard
 *     on the UI view. An uncaught exception in the UI renderer (e.g. a Svelte
 *     effect loop killing the effect runtime) bricks the UI silently, so:
 *     uncaught exception / render-process-gone → log; report (if telemetry on);
 *       show a quit-only native dialog (the UI itself can't be trusted to
 *       render anything), then dispatch app:shutdown.
 *     unhandled rejection → log; report (if telemetry on); no dialog —
 *       rejections rarely brick the UI and may even be handled later.
 *     unresponsive → log only.
 *
 * Events:
 * - shortcut:key-pressed "b": open the bug report dialog.
 * - bug-report:submitted: capture the manual report (UNCONDITIONAL — the user
 *     explicitly asked to send it — plus a flush for prompt delivery).
 *
 * All reports go through the shared PostHogBoundary, which stamps version /
 * platform / arch / agent and gates nothing.
 */

import { gzipSync } from "node:zlib";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { IDispatcher } from "../intents/lib/dispatcher";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logging, Logger } from "../boundaries/platform/logging";
import type { DialogConfig } from "../shared/dialog-types";
import type { PostHogBoundary } from "../boundaries/platform/posthog";
import type { Config } from "../boundaries/platform/config";
import type { StateService } from "../boundaries/platform/state-service";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { DialogBoundary } from "../boundaries/shell/dialog";
import type { ViewBoundary, UncaughtExceptionDetails } from "../boundaries/shell/view";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import { ANY_VALUE } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { INTENT_APP_SHUTDOWN, type AppShutdownIntent } from "../intents/app-shutdown";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { INTENT_SUBMIT_BUG_REPORT, type SubmitBugReportIntent } from "../intents/submit-bug-report";
import {
  EVENT_BUG_REPORT_SUBMITTED,
  type BugReportSubmittedEvent,
} from "../intents/submit-bug-report";

// =============================================================================
// Constants
// =============================================================================

/** Maximum raw log bytes captured per report (compressed before send). */
const MAX_LOG_SIZE = 20 * 1024 * 1024;

const DESCRIPTION_INITIAL = "# describe your issue";

/**
 * Per-field compressed cap for log payloads. With two log streams (app +
 * electron) this gives ~900 KB combined, leaving ~148 KB under PostHog's 1 MB
 * hard cap for description, metadata, and SDK overhead.
 */
const LOG_FIELD_COMPRESSED_CAP = 450_000;
const COMPRESS_SAFETY_FACTOR = 0.95;

/** How long to wait for a flush before forcing the process to exit on a crash. */
const FLUSH_TIMEOUT_MS = 2000;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compress `raw` with gzip+base64 and, if the result exceeds the cap, trim the
 * raw input from the front (keeping the most recent tail) and re-compress.
 */
function compressAndTrim(raw: string): { compressed: string; rawBytesKept: number } {
  let kept = raw;
  let compressed = kept ? gzipSync(kept).toString("base64") : "";
  while (compressed.length > LOG_FIELD_COMPRESSED_CAP && kept.length > 0) {
    const scaled = Math.floor(
      (kept.length * LOG_FIELD_COMPRESSED_CAP * COMPRESS_SAFETY_FACTOR) / compressed.length
    );
    const nextLen = Math.max(0, Math.min(scaled, kept.length - 1));
    kept = nextLen > 0 ? kept.slice(kept.length - nextLen) : "";
    compressed = kept ? gzipSync(kept).toString("base64") : "";
  }
  return { compressed, rawBytesKept: kept.length };
}

function buildDialogConfig(): DialogConfig {
  return {
    sections: [
      { type: "text", content: "Report a Bug", style: "heading", icon: "bug" },
      {
        type: "input",
        id: "description",
        placeholder: "Describe the issue...",
        multiline: true,
        initialValue: DESCRIPTION_INITIAL,
        selectInitialValue: true,
      },
      {
        type: "text",
        content: "Your current config and application logs will be included with your report.",
        style: "subtitle",
      },
      {
        type: "group",
        items: [
          { type: "button", id: "send", label: "Send", variant: "primary" },
          { type: "button", id: "cancel", label: "Cancel", variant: "secondary", role: "cancel" },
        ],
      },
    ],
    modal: true,
  };
}

// =============================================================================
// Dependencies
// =============================================================================

export interface ErrorReportModuleDeps {
  readonly dialogManager: DialogManager;
  readonly fileSystem: Pick<FileSystemBoundary, "readFile">;
  readonly loggingService: Pick<Logging, "getLogFilePath" | "getElectronLogFilePath">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  /** The shared PostHog sink. */
  readonly boundary: PostHogBoundary;
  readonly configService: Pick<Config, "getRedactedOverrides">;
  readonly stateService: Pick<StateService, "getRedactedOverrides">;
  /** Accessor for telemetry.enabled (registered in the composition root). */
  readonly telemetryEnabled: PersistedAccessor<boolean>;
  /** Native message box for the UI crash dialog (the UI itself may be dead). */
  readonly dialogBoundary: Pick<DialogBoundary, "showMessageBox">;
  /** View events the UI renderer crash guard subscribes to. */
  readonly viewLayer: Pick<
    ViewBoundary,
    "onUncaughtException" | "onRenderProcessGone" | "onUnresponsive"
  >;
  /** Source of the UI view handle (valid once "ui-ready" is provided). */
  readonly viewManager: Pick<IViewManager, "getUIViewHandle">;
  readonly logger: Logger;
  /** Terminate the process. Injected for tests; defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

// =============================================================================
// Module
// =============================================================================

export function createErrorReportModule(deps: ErrorReportModuleDeps): IntentModule {
  let activeHandle: DialogHandle | null = null;
  let errorHandlersRegistered = false;
  const exit = deps.exit ?? ((code: number): void => void process.exit(code));

  // ---------------------------------------------------------------------------
  // Log reading
  // ---------------------------------------------------------------------------

  async function readLogContent(): Promise<string> {
    const logPath = deps.loggingService.getLogFilePath();

    // electron-log rotates `<name>.log` to `<name>.old.log` once it exceeds
    // maxSize. Include the archive so reports after a rotation still carry context.
    const dot = logPath.lastIndexOf(".");
    const archivePath =
      dot >= 0 ? `${logPath.slice(0, dot)}.old${logPath.slice(dot)}` : `${logPath}.old`;

    const archive = await deps.fileSystem.readFile(archivePath).catch(() => "");
    const current = await deps.fileSystem.readFile(logPath).catch((): string => {
      deps.logger.warn("Failed to read log file");
      return "";
    });

    const combined = archive ? `${archive}${current}` : current;
    return combined.length > MAX_LOG_SIZE ? combined.slice(-MAX_LOG_SIZE) : combined;
  }

  async function readElectronLogContent(): Promise<string> {
    const path = deps.loggingService.getElectronLogFilePath();
    const content = await deps.fileSystem.readFile(path).catch(() => {
      deps.logger.warn("Failed to read electron log file");
      return "";
    });
    return content.length > MAX_LOG_SIZE ? content.slice(-MAX_LOG_SIZE) : content;
  }

  // ---------------------------------------------------------------------------
  // Incident capture (shared by crashes and manual reports)
  // ---------------------------------------------------------------------------

  /**
   * Compress logs, attach redacted config + state, and send the exception
   * through the boundary. The boundary stamps version/platform/arch/agent.
   */
  function captureIncident(
    error: Error,
    logs: string,
    electronLogs: string,
    extraProps?: Record<string, unknown>
  ): void {
    const appLogs = compressAndTrim(logs);
    const electronLogsBlob = compressAndTrim(electronLogs);

    deps.boundary.captureException(error, {
      ...extraProps,
      logs: appLogs.compressed,
      logs_format: appLogs.compressed ? "gzip+base64" : "none",
      logs_raw_bytes: appLogs.rawBytesKept,
      logs_raw_bytes_dropped: logs.length - appLogs.rawBytesKept,
      electron_logs: electronLogsBlob.compressed,
      electron_logs_format: electronLogsBlob.compressed ? "gzip+base64" : "none",
      electron_logs_raw_bytes: electronLogsBlob.rawBytesKept,
      electron_logs_raw_bytes_dropped: electronLogs.length - electronLogsBlob.rawBytesKept,
      config: deps.configService.getRedactedOverrides(),
      state: deps.stateService.getRedactedOverrides(),
    });
  }

  /** Read both log streams, then capture the crash. */
  async function captureCrash(error: Error, extraProps?: Record<string, unknown>): Promise<void> {
    const [logs, electronLogs] = await Promise.all([readLogContent(), readElectronLogContent()]);
    captureIncident(error, logs, electronLogs, extraProps);
  }

  /** Flush (and close) the boundary, but never block the exit beyond the cap. */
  function flushWithTimeout(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
      timer.unref?.();
      void deps.boundary.shutdown().then(finish, finish);
    });
  }

  // ---------------------------------------------------------------------------
  // Process error handlers (the sole owners)
  // ---------------------------------------------------------------------------

  function registerErrorHandlers(): void {
    if (errorHandlersRegistered) return;
    errorHandlersRegistered = true;

    // Electron runs --unhandled-rejections=warn, so the process survives. Log,
    // and report when telemetry is on; no flush/exit needed.
    process.on("unhandledRejection", (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
      deps.logger.error("Unhandled promise rejection", {}, error);
      if (deps.telemetryEnabled.get()) {
        void captureCrash(error).catch(() => {});
      }
    });

    // A listener suppresses Node's default crash, so we own the exit. Always log
    // and exit(1); report + flush only when telemetry is on.
    process.on("uncaughtException", (error: Error, origin: string) => {
      if (origin === "unhandledRejection") {
        deps.logger.error("Unhandled promise rejection", {}, error);
      } else {
        deps.logger.error("Uncaught exception", {}, error);
      }
      void (async (): Promise<void> => {
        try {
          if (deps.telemetryEnabled.get()) {
            await captureCrash(error);
            await flushWithTimeout();
          }
        } catch {
          // Best-effort: reporting must never block the crash exit.
        } finally {
          exit(1);
        }
      })();
    });
  }

  // ---------------------------------------------------------------------------
  // UI renderer crash guard
  // ---------------------------------------------------------------------------

  /** True once the (single) UI crash dialog has been shown. */
  let uiCrashDialogShown = false;

  function reportUiError(error: Error, source: string): void {
    if (deps.telemetryEnabled.get()) {
      void captureCrash(error, { crash_source: source }).catch(() => {});
    }
  }

  /**
   * Log + report, then show the quit-only native dialog. The UI renderer
   * can't be trusted to render anything at this point, and a reloaded UI
   * can't re-bootstrap mid-session — so the only recovery is a restart.
   * Further signals while the dialog is up are logged/reported, not stacked.
   */
  function handleUiCrash(error: Error, source: string): void {
    deps.logger.error("UI renderer crashed", { source }, error);
    reportUiError(error, source);

    if (uiCrashDialogShown) return;
    uiCrashDialogShown = true;
    void deps.dialogBoundary
      .showMessageBox({
        type: "error",
        title: "CodeHydra",
        message: "The CodeHydra UI hit an unexpected error and cannot recover.",
        detail: `${error.message}\n\nCodeHydra needs to quit. Please start it again.`,
        buttons: ["Quit CodeHydra"],
        defaultId: 0,
      })
      .then(() =>
        deps.dispatcher.dispatch({
          type: INTENT_APP_SHUTDOWN,
          payload: {},
        } as AppShutdownIntent)
      )
      .catch(() => {
        // Dialog failure must not mask the crash; log + report already happened.
      });
  }

  function toUiError(details: UncaughtExceptionDetails): Error {
    const error = new Error(details.message);
    error.name = details.isPromiseRejection ? "UIRendererRejection" : "UIRendererError";
    error.stack = details.stack;
    return error;
  }

  function subscribeUiCrashGuard(): void {
    const uiViewHandle = deps.viewManager.getUIViewHandle();

    deps.viewLayer.onUncaughtException(uiViewHandle, (details) => {
      const error = toUiError(details);
      if (details.isPromiseRejection) {
        deps.logger.error("Unhandled promise rejection in UI renderer", {}, error);
        reportUiError(error, "ui-renderer-rejection");
        return;
      }
      handleUiCrash(error, "ui-renderer-exception");
    });

    deps.viewLayer.onRenderProcessGone(uiViewHandle, ({ reason, exitCode }) => {
      const error = new Error(`UI renderer process gone: ${reason} (exit code ${exitCode})`);
      error.name = "UIRendererProcessGone";
      error.stack = "";
      handleUiCrash(error, "ui-renderer-process-gone");
    });

    deps.viewLayer.onUnresponsive(uiViewHandle, () => {
      deps.logger.warn("UI renderer unresponsive");
    });
  }

  // ---------------------------------------------------------------------------
  // Manual bug report dialog
  // ---------------------------------------------------------------------------

  function openDialog(): void {
    if (activeHandle) return;

    const handle = deps.dialogManager.open(buildDialogConfig());
    activeHandle = handle;

    handle.onEvent((event) => {
      if (event.actionId === "send") {
        void (async () => {
          const [logs, electronLogs] = await Promise.all([
            readLogContent(),
            readElectronLogContent(),
          ]);
          const description = event.data?.["description"] ?? "";

          void deps.dispatcher.dispatch({
            type: INTENT_SUBMIT_BUG_REPORT,
            payload: { description, logs, electronLogs },
          } as SubmitBugReportIntent);

          handle.close();
          activeHandle = null;
        })();
      } else if (event.actionId === "cancel") {
        handle.close();
        activeHandle = null;
      }
    });
    // Escape discards the draft: the Cancel button carries role "cancel", so
    // Escape clicks it through the action path above.

    void handle.closed.then(() => {
      activeHandle = null;
    });
  }

  return {
    name: "error-report",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<Record<string, never>> => {
            registerErrorHandlers();
            return {};
          },
        },
        // The UI view exists once the view module's init handler has run
        // (it provides "ui-ready"); subscribe the crash guard right after,
        // before the renderer mounts the Svelte app.
        init: {
          requires: { "ui-ready": ANY_VALUE },
          handler: async (): Promise<Record<string, never>> => {
            subscribeUiCrashGuard();
            return {};
          },
        },
      },
    },
    events: {
      [EVENT_SHORTCUT_KEY_PRESSED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { key } = (event as ShortcutKeyPressedEvent).payload;
          if (key === "b") {
            openDialog();
          }
        },
      },
      [EVENT_BUG_REPORT_SUBMITTED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { description, logs, electronLogs } = (event as BugReportSubmittedEvent).payload;

          // Synthetic error so the SDK formats it as $exception_list. Manual
          // reports always send (explicit consent), even with telemetry off.
          const bugError = new Error(description);
          bugError.name = "BugReport";
          bugError.stack = "";

          captureIncident(bugError, logs, electronLogs);
          await deps.boundary.flush();
        },
      },
    },
  };
}
