/**
 * The add-project worktree picker: offers a repository's pre-existing
 * worktrees for adoption when a local project is added interactively.
 */

import type { UnmanagedWorktree } from "../../boundaries/platform/git-types";
import type { UiPresenter } from "../presentation/presentation-module";
import type { DialogSection } from "../../shared/dialog-types";

/**
 * Show the picker and return the worktrees the user ticked, or null if they
 * canceled (which aborts the whole project add).
 */
export type WorktreePicker = (
  projectPath: string,
  unmanaged: readonly UnmanagedWorktree[]
) => Promise<UnmanagedWorktree[] | null>;

export function createWorktreePicker(ui: Pick<UiPresenter, "dialog">): WorktreePicker {
  const ACTION_CONTINUE = "continue";
  const ACTION_CANCEL = "cancel";
  const SELECT_ALL_ID = "select-all";
  const CHECKBOX_ID_PREFIX = "wt-";

  /**
   * One line identifying a worktree: the name the workspace would take (its
   * branch), then where it lives.
   */
  function worktreeLabel(wt: UnmanagedWorktree): string {
    return `${wt.name} — ${wt.path.toString()}`;
  }

  /**
   * Build the picker's sections from the current selection.
   *
   * One checkbox per worktree, nothing else: a separate line of detail per row
   * would be centered by the dialog's default layout and separated from its own
   * checkbox by a full section gap, which reads as two unrelated things.
   *
   * Every checkbox echoes the module's own model value on every render. That is what
   * the controlled-value contract requires to force a box: the renderer adopts a
   * pushed value it has not seen yet, so "Select all" only re-ticks a box the user
   * unticked if the value it last saw was the untick.
   */
  function buildPickerSections(
    projectPath: string,
    unmanaged: readonly UnmanagedWorktree[],
    selected: ReadonlySet<number>
  ): DialogSection[] {
    const sections: DialogSection[] = [
      { type: "text", content: "Open existing worktrees?", style: "heading" },
      { type: "text", content: projectPath, style: "subtitle" },
      {
        type: "checkbox",
        id: SELECT_ALL_ID,
        label: "Select all",
        // Reflects the rows rather than driving them alone: unticking one row
        // unticks this too, which is what a select-all box is expected to do.
        value: unmanaged.length > 0 && selected.size === unmanaged.length,
        changeEvent: true,
      },
    ];

    unmanaged.forEach((wt, index) => {
      sections.push({
        type: "checkbox",
        id: `${CHECKBOX_ID_PREFIX}${index}`,
        label: worktreeLabel(wt),
        value: selected.has(index),
        changeEvent: true,
      });
    });

    sections.push({
      type: "group",
      reverse: true,
      items: [
        { type: "button", id: ACTION_CONTINUE, label: "Continue", variant: "primary" },
        {
          type: "button",
          id: ACTION_CANCEL,
          label: "Cancel",
          variant: "secondary",
          role: "cancel",
        },
      ],
    });

    return sections;
  }

  /** Map a checkbox field id back to its index in the unmanaged list. */
  function checkboxIndex(fieldId: string): number | undefined {
    if (!fieldId.startsWith(CHECKBOX_ID_PREFIX)) return undefined;
    const index = Number(fieldId.slice(CHECKBOX_ID_PREFIX.length));
    return Number.isInteger(index) ? index : undefined;
  }

  /**
   * Show the picker and return the worktrees the user ticked, or null if they
   * canceled (which aborts the whole project add).
   */
  async function runPicker(
    projectPath: string,
    unmanaged: readonly UnmanagedWorktree[]
  ): Promise<UnmanagedWorktree[] | null> {
    const selected = new Set<number>();

    const setAll = (checked: boolean): void => {
      selected.clear();
      if (!checked) return;
      unmanaged.forEach((_wt, index) => {
        selected.add(index);
      });
    };

    const applyValues = (data: Readonly<Record<string, string>> | undefined): void => {
      if (!data) return;
      for (const [fieldId, value] of Object.entries(data)) {
        const index = checkboxIndex(fieldId);
        if (index === undefined) continue;
        if (value === "true") selected.add(index);
        else selected.delete(index);
      }
    };

    const dialog = ui.dialog({
      sections: buildPickerSections(projectPath, unmanaged, selected),
    });
    const rerender = (): void => {
      dialog.update({ sections: buildPickerSections(projectPath, unmanaged, selected) });
    };

    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.onChange((event) => {
        if (event.fieldId === SELECT_ALL_ID) setAll(event.data[SELECT_ALL_ID] === "true");
        else applyValues(event.data);
        rerender();
      });
      dialog.onEvent((event) => {
        if (event.actionId === ACTION_CONTINUE) {
          // The submit payload is the authority: a debounced change event for the
          // last toggle may still be in flight.
          applyValues(event.data);
          resolve(true);
          return;
        }
        resolve(false);
      });
      dialog.onDismiss(() => {
        resolve(false);
      });
    });
    dialog.close();

    if (!confirmed) return null;
    return unmanaged.filter((_wt, index) => selected.has(index));
  }

  return runPicker;
}
