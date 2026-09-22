/**
 * HelpModule - the user guide, for `ch guide` and the in-app help dialog.
 *
 * The guide is docs/USER_GUIDE.md, shipped to the runtime bin dir beside the
 * system prompts (see vite.config.bin.ts). Read on every request rather than
 * cached: it is small, requests are rare, and a dev rebuild shows up at once.
 *
 * The dialog is opened by the sidebar's question mark: the renderer's
 * `open-help` ui event, forwarded by the presenter through the injected
 * onOpenHelp callback (main.ts wires it to openHelp).
 */

import type { UiPresenter } from "./presentation/presentation-module";
import type { DialogHandle } from "./presentation/sessions";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { Logger } from "../boundaries/platform/logging";
import { getErrorMessage } from "../shared/error-utils";

const ACTION_CLOSE = "close";

export interface HelpModuleDeps {
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly fileSystem: Pick<FileSystemBoundary, "readFile">;
  readonly pathProvider: Pick<PathProvider, "runtimePath">;
  readonly logger: Logger;
}

export interface HelpModule {
  /** The guide's markdown, as shipped. */
  readUserGuide(): Promise<string>;
  /** Open the guide in a dialog; a no-op while one is already open. */
  openHelp(): void;
}

export function createHelpModule(deps: HelpModuleDeps): HelpModule {
  const { ui, fileSystem, pathProvider, logger } = deps;

  let activeHandle: DialogHandle | null = null;
  let opening = false;

  function readUserGuide(): Promise<string> {
    return fileSystem.readFile(pathProvider.runtimePath("bin/USER_GUIDE.md"));
  }

  async function open(): Promise<void> {
    let content: string;
    try {
      content = await readUserGuide();
    } catch (error) {
      logger.warn("Could not read the user guide", { error: getErrorMessage(error) });
      return;
    }

    const handle = ui.dialog({
      layout: "form",
      sections: [
        { type: "markdown", content },
        {
          type: "group",
          items: [
            {
              type: "button",
              id: ACTION_CLOSE,
              label: "Close",
              variant: "primary",
              role: "cancel",
              autofocus: true,
            },
          ],
        },
      ],
    });
    activeHandle = handle;

    handle.onEvent((event) => {
      if (event.actionId === ACTION_CLOSE) handle.close();
    });
    void handle.closed.then(() => {
      activeHandle = null;
    });
  }

  function openHelp(): void {
    if (activeHandle || opening) return;
    opening = true;
    void open().finally(() => {
      opening = false;
    });
  }

  return { readUserGuide, openHelp };
}
