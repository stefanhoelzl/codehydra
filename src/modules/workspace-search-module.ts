/**
 * WorkspaceSearchModule - find a workspace by typing, and switch to it.
 *
 * Opened two ways, like the settings dialog:
 *   - Alt+X then F: the shortcut-key domain event (key "f").
 *   - the sidebar magnifier: the renderer's `open-workspace-search` ui event,
 *     forwarded by the presenter through the injected onOpenWorkspaceSearch
 *     callback (main.ts wires it to openSearch).
 *
 * The dialog is one inline dropdown listing every ready workspace — hibernated
 * ones too, even while the sidebar hides them — grouped by project in sidebar
 * order and drawn as sidebar rows. The filter matches the row's title (else
 * name) plus hidden keywords: name, project, and each tag's name, label and
 * description. The list follows every snapshot push while the dialog is open.
 *
 * A pick switches to the workspace and, when it is hibernated, wakes it too.
 * A pick whose workspace has gone (or is no longer ready) just closes.
 */

import type { IntentModule } from "../intents/lib/module";
import type { IDispatcher } from "../intents/lib/dispatcher";
import type { DialogHandle } from "./presentation/sessions";
import type { ProjectWorkspaceRow, UiPresenter } from "./presentation/presentation-module";
import type { Logger } from "../boundaries/platform/logging";
import type { DialogConfig, DropdownOption, DropdownSuggestionGroup } from "../shared/dialog-types";
import { EVENT_SHORTCUT_KEY_PRESSED } from "../intents/shortcut-key";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "../intents/switch-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../intents/wake-workspace";
import { defineEvents } from "../intents/declarations";
import { asWorkspaceRef } from "../utils/ref";
import { getErrorMessage } from "../shared/error-utils";

const FIELD_WORKSPACE = "workspace";
const ACTION_CANCEL = "cancel";

/** The shortcut-mode key that opens the search. */
export const WORKSPACE_SEARCH_KEY = "f";

export interface WorkspaceSearchModuleDeps {
  readonly ui: Pick<UiPresenter, "dialog" | "workspaceRows" | "onPush">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly logger: Logger;
}

export interface WorkspaceSearchModule {
  readonly module: IntentModule;
  /** Open the search dialog; a no-op while one is already open. */
  openSearch(): void;
}

/** Only ready workspaces are listed: the rest have nothing to switch to yet. */
function listedRows(rows: readonly ProjectWorkspaceRow[]): ProjectWorkspaceRow[] {
  return rows.filter(({ row }) => row.status === "ready");
}

function toOption({ projectName, row }: ProjectWorkspaceRow): DropdownOption {
  const keywords = [
    row.name,
    projectName,
    ...row.tags.flatMap((tag) => [tag.name, tag.label ?? "", tag.description ?? ""]),
  ]
    .filter((word) => word !== "")
    .join("\n");
  return {
    value: row.key,
    label: row.title ?? row.name,
    keywords,
    row: {
      name: row.name,
      ...(row.title !== undefined && { title: row.title }),
      hibernated: row.hibernated,
      ...(row.hibernatedAt !== undefined && { hibernatedAt: row.hibernatedAt }),
      agent: row.agent,
      tags: row.tags,
    },
  };
}

/** One suggestion group per project, in the order the rows come (sidebar order). */
function toGroups(rows: readonly ProjectWorkspaceRow[]): DropdownSuggestionGroup[] {
  const groups = new Map<string, DropdownOption[]>();
  for (const entry of rows) {
    const items = groups.get(entry.projectName) ?? [];
    items.push(toOption(entry));
    groups.set(entry.projectName, items);
  }
  return [...groups].map(([header, items]) => ({ header, items }));
}

function buildConfig(rows: readonly ProjectWorkspaceRow[]): DialogConfig {
  const listed = listedRows(rows);
  return {
    layout: "form",
    sections: [
      { type: "text", content: "Find workspace", style: "heading" },
      {
        type: "dropdown",
        id: FIELD_WORKSPACE,
        suggestions: toGroups(listed),
        placeholder: listed.length === 0 ? "No workspaces" : "Search workspaces, tags…",
        inline: true,
        autofocus: true,
        changeEvent: true,
      },
      {
        type: "group",
        items: [{ type: "button", id: ACTION_CANCEL, label: "Cancel", role: "cancel" }],
      },
    ],
  };
}

export function createWorkspaceSearchModule(
  deps: WorkspaceSearchModuleDeps
): WorkspaceSearchModule {
  const { ui, dispatcher, logger } = deps;

  let activeHandle: DialogHandle | null = null;

  function dispatchDetached(intent: SwitchWorkspaceIntent | WakeWorkspaceIntent): void {
    void dispatcher.dispatch(intent).catch((error: unknown) => {
      logger.debug("workspace search dispatch rejected", {
        intent: intent.type,
        error: getErrorMessage(error),
      });
    });
  }

  /** Switch to the picked workspace, waking it when it sleeps. */
  function pick(key: string): void {
    const entry = listedRows(ui.workspaceRows()).find(({ row }) => row.key === key);
    const workspaceRef = asWorkspaceRef(key);
    if (entry === undefined || workspaceRef === null) return;
    dispatchDetached({ type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef } });
    if (entry.row.hibernated) {
      dispatchDetached({
        type: INTENT_WAKE_WORKSPACE,
        payload: { workspaceRef, source: "ui-ipc" },
      });
    }
  }

  function openSearch(): void {
    if (activeHandle) return;
    const handle = ui.dialog(buildConfig(ui.workspaceRows()));
    activeHandle = handle;

    // Follow the workspaces while open. An unchanged config is a no-op update,
    // so the pushes this dialog's own updates cause settle at once.
    const unsubscribe = ui.onPush(() => handle.update(buildConfig(ui.workspaceRows())));

    handle.onChange((event) => {
      if (event.fieldId !== FIELD_WORKSPACE) return;
      const key = event.data[FIELD_WORKSPACE];
      handle.close();
      if (key !== undefined) pick(key);
    });
    handle.onEvent((event) => {
      if (event.actionId === ACTION_CANCEL) handle.close();
    });
    void handle.closed.then(() => {
      unsubscribe();
      activeHandle = null;
    });
  }

  const module: IntentModule = {
    name: "workspace-search",
    events: defineEvents({
      [EVENT_SHORTCUT_KEY_PRESSED]: {
        handler: async (event): Promise<void> => {
          if (event.payload.key === WORKSPACE_SEARCH_KEY) openSearch();
        },
      },
    }),
  };

  return { module, openSearch };
}
