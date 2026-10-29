/**
 * WorkspaceSearchModule integration tests: the search dialog lists every ready
 * workspace (hibernated included) grouped by project, with hidden keywords for
 * metadata matches; a pick switches (and wakes a hibernated workspace); the
 * list follows presenter pushes; Cancel closes; Alt+X F opens it.
 */

import { describe, it, expect, vi } from "vitest";
import { createWorkspaceSearchModule } from "./workspace-search-module";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import type { ProjectWorkspaceRow } from "./presentation/presentation-module";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { INTENT_SWITCH_WORKSPACE } from "../intents/switch-workspace";
import { INTENT_WAKE_WORKSPACE } from "../intents/wake-workspace";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";
import type { UiWorkspaceRow } from "../shared/ui-state";
import type { DialogSection, DropdownSuggestionGroup } from "../shared/dialog-types";

const APP = projectRefFor("/repos/app");
const LIB = projectRefFor("/repos/lib");

function row(
  project: typeof APP,
  name: string,
  overrides: Partial<UiWorkspaceRow> = {}
): UiWorkspaceRow {
  return {
    key: makeWorkspaceRef(project, name),
    name,
    status: "ready",
    hibernated: false,
    agent: { type: "none" },
    tags: [],
    active: false,
    ...overrides,
  };
}

function setup(initial: ProjectWorkspaceRow[]) {
  let rows = initial;
  const pushListeners = new Set<() => void>();
  const dialogs = createMockDialogManager();
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const search = createWorkspaceSearchModule({
    ui: {
      dialog: dialogs.ui.dialog,
      workspaceRows: () => rows,
      onPush: (listener) => {
        pushListeners.add(listener);
        return () => {
          pushListeners.delete(listener);
        };
      },
    },
    dispatcher: { dispatch },
    logger: createMockLogger(),
  });
  /** Replace the presenter's rows and push, like a snapshot push would. */
  function pushRows(next: ProjectWorkspaceRow[]): void {
    rows = next;
    for (const listener of pushListeners) listener();
  }
  return { search, dialogs, dispatch, pushRows, pushListeners };
}

function dropdown(
  sections: readonly DialogSection[]
): Extract<DialogSection, { type: "dropdown" }> {
  const section = sections.find((s) => s.type === "dropdown");
  if (section?.type !== "dropdown") throw new Error("no dropdown section");
  return section;
}

function groups(sections: readonly DialogSection[]): readonly DropdownSuggestionGroup[] {
  return dropdown(sections).suggestions;
}

describe("WorkspaceSearchModule", () => {
  it("lists ready workspaces grouped by project in the given order", () => {
    const { search, dialogs } = setup([
      { projectName: "app", row: row(APP, "alpha") },
      { projectName: "app", row: row(APP, "beta", { hibernated: true }) },
      { projectName: "app", row: row(APP, "making", { status: "creating" }) },
      { projectName: "app", row: row(APP, "going", { status: "deleting" }) },
      { projectName: "lib", row: row(LIB, "gamma", { status: "open-failed" }) },
      { projectName: "lib", row: row(LIB, "delta") },
    ]);

    search.openSearch();

    const section = dropdown(dialogs.lastHandle!.config.sections);
    expect(section).toMatchObject({ inline: true, autofocus: true, changeEvent: true });
    expect(section.freeText).toBeUndefined();
    expect(
      section.suggestions.map((g) => ({ header: g.header, items: g.items.map((i) => i.label) }))
    ).toEqual([
      { header: "app", items: ["alpha", "beta"] },
      { header: "lib", items: ["delta"] },
    ]);
  });

  it("shows the title as label and matches name, project and tags via keywords", () => {
    const { search, dialogs } = setup([
      {
        projectName: "app",
        row: row(APP, "pr-12", {
          title: "PR #12 review",
          hibernated: true,
          agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
          tags: [{ name: "review", color: "#4b6de8", label: "Review", description: "needs eyes" }],
        }),
      },
    ]);

    search.openSearch();

    const [option] = groups(dialogs.lastHandle!.config.sections)[0]!.items;
    expect(option!.label).toBe("PR #12 review");
    expect(option!.keywords!.split("\n")).toEqual([
      "pr-12",
      "app",
      "review",
      "Review",
      "needs eyes",
    ]);
    expect(option!.row).toEqual({
      name: "pr-12",
      title: "PR #12 review",
      hibernated: true,
      agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
      tags: [{ name: "review", color: "#4b6de8", label: "Review", description: "needs eyes" }],
    });
  });

  it("switches to an awake pick and closes", () => {
    const alpha = row(APP, "alpha");
    const { search, dialogs, dispatch } = setup([{ projectName: "app", row: alpha }]);

    search.openSearch();
    dialogs.lastHandle!.emitChange("workspace", { workspace: alpha.key });

    expect(dialogs.lastHandle!.closed).toBe(true);
    expect(dispatch.mock.calls.map(([intent]) => intent)).toEqual([
      { type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef: alpha.key } },
    ]);
  });

  it("switches to and wakes a hibernated pick", () => {
    const beta = row(APP, "beta", { hibernated: true });
    const { search, dialogs, dispatch } = setup([{ projectName: "app", row: beta }]);

    search.openSearch();
    dialogs.lastHandle!.emitChange("workspace", { workspace: beta.key });

    expect(dispatch.mock.calls.map(([intent]) => intent)).toEqual([
      { type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef: beta.key } },
      { type: INTENT_WAKE_WORKSPACE, payload: { workspaceRef: beta.key, source: "ui-ipc" } },
    ]);
  });

  it("just closes on a pick whose workspace has gone meanwhile", () => {
    const alpha = row(APP, "alpha");
    const { search, dialogs, dispatch } = setup([{ projectName: "app", row: alpha }]);

    search.openSearch();
    const handle = dialogs.lastHandle!;
    // The renderer picked a row the presenter no longer has.
    handle.emitChange("workspace", { workspace: makeWorkspaceRef(APP, "gone") });

    expect(handle.closed).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("follows the workspaces while open and stops after closing", async () => {
    const alpha = row(APP, "alpha");
    const { search, dialogs, pushRows, pushListeners } = setup([
      { projectName: "app", row: alpha },
    ]);

    search.openSearch();
    const handle = dialogs.lastHandle!;
    pushRows([
      { projectName: "app", row: alpha },
      { projectName: "app", row: row(APP, "fresh") },
    ]);

    expect(groups(handle.config.sections)[0]!.items.map((i) => i.label)).toEqual([
      "alpha",
      "fresh",
    ]);

    handle.emitAction("cancel");
    expect(handle.closed).toBe(true);
    await Promise.resolve();
    expect(pushListeners.size).toBe(0);
  });

  it("does not stack a second dialog while one is open", () => {
    const { search, dialogs } = setup([{ projectName: "app", row: row(APP, "alpha") }]);

    search.openSearch();
    search.openSearch();

    expect(dialogs.handles).toHaveLength(1);
  });

  it("opens on Alt+X F and ignores other keys", async () => {
    const { search, dialogs } = setup([{ projectName: "app", row: row(APP, "alpha") }]);
    const handler = search.module.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler;
    const press = (key: string): ShortcutKeyPressedEvent => ({
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key },
    });

    await handler(press("s"));
    expect(dialogs.handles).toHaveLength(0);

    await handler(press("f"));
    expect(dialogs.handles).toHaveLength(1);
  });
});
