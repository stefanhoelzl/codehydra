/**
 * BugReportModule - Opens a bug report dialog via Alt+X+B shortcut.
 *
 * Subscribes to shortcut:key-pressed and handles "b" key entirely in the
 * main process (same pattern as DevtoolsModule handling "d" and "w").
 *
 * The dialog collects a description from the user, then reads the current
 * session log file and dispatches a SubmitBugReportIntent with both.
 *
 * Events:
 * - shortcut:key-pressed: opens bug report dialog when key is "b"
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { IDispatcher } from "../intents/lib/dispatcher";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logging, Logger } from "../boundaries/platform/logging";
import type { Config } from "../boundaries/platform/config";
import type { DialogConfig } from "../shared/dialog-types";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { INTENT_SUBMIT_BUG_REPORT, type SubmitBugReportIntent } from "../intents/submit-bug-report";
import { buildConfigBlock } from "./bug-report-config-block";

/** Maximum log content to send via PostHog (~1MB). */
const MAX_LOG_SIZE = 1_000_000;

export interface BugReportModuleDeps {
  readonly dialogManager: DialogManager;
  readonly fileSystem: Pick<FileSystemBoundary, "readFile">;
  readonly loggingService: Pick<Logging, "getLogFilePath">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly config: Pick<Config, "getDefinitions" | "getEffective" | "getDefaults">;
  readonly logger: Logger;
}

function buildDialogConfig(initial: { value: string; cursorOffset: number }): DialogConfig {
  return {
    sections: [
      { type: "text", content: "Report a Bug", style: "heading", icon: "bug" },
      {
        type: "input",
        id: "description",
        placeholder: "Describe the issue...",
        multiline: true,
        initialValue: initial.value,
        cursorOffset: initial.cursorOffset,
      },
      {
        type: "text",
        content:
          "Your non-default config is included below — review for sensitive values before sending.",
        style: "subtitle",
      },
      {
        type: "text",
        content: "Application logs will be included with your report.",
        style: "subtitle",
      },
    ],
    actions: [
      { id: "send", label: "Send", variant: "primary" },
      { id: "cancel", label: "Cancel", variant: "secondary" },
    ],
    modal: true,
  };
}

export function createBugReportModule(deps: BugReportModuleDeps): IntentModule {
  let activeHandle: DialogHandle | null = null;

  async function readLogContent(): Promise<string> {
    try {
      const logPath = deps.loggingService.getLogFilePath();
      const content = await deps.fileSystem.readFile(logPath);
      if (content.length > MAX_LOG_SIZE) {
        return content.slice(-MAX_LOG_SIZE);
      }
      return content;
    } catch {
      deps.logger.warn("Failed to read log file");
      return "";
    }
  }

  function openDialog(): void {
    if (activeHandle) return;

    const initial = buildConfigBlock(deps.config);
    const handle = deps.dialogManager.open(buildDialogConfig(initial));
    activeHandle = handle;

    handle.onEvent((event) => {
      if (event.actionId === "send") {
        void (async () => {
          const logs = await readLogContent();
          const inputs = (event.data?.inputs ?? {}) as Record<string, string>;
          const description = inputs["description"] ?? "";

          void deps.dispatcher.dispatch({
            type: INTENT_SUBMIT_BUG_REPORT,
            payload: { description, logs },
          } as SubmitBugReportIntent);

          handle.close();
          activeHandle = null;
        })();
      } else if (event.actionId === "cancel") {
        handle.close();
        activeHandle = null;
      }
    });

    // Clean up if dialog is closed externally
    void handle.closed.then(() => {
      activeHandle = null;
    });
  }

  return {
    name: "bug-report",
    events: {
      [EVENT_SHORTCUT_KEY_PRESSED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { key } = (event as ShortcutKeyPressedEvent).payload;
          if (key === "b") {
            openDialog();
          }
        },
      },
    },
  };
}
