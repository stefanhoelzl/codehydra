/**
 * Focus ownership: which open surface is entitled to place DOM focus.
 *
 * Every surface that can move focus (each `Form`, and the workspace frames)
 * obeys one rule: place focus only while you own it. Without that rule a
 * surface appearing UNDERNEATH an open dialog still ran its mount autofocus
 * and yanked the caret out of the dialog the user was typing in — the
 * "bug report dialog looses focus" report (PostHog 019fb2cb).
 *
 * Ownership is a pure derivation over the snapshot; there is no renderer-side
 * focus state. The snapshot already carries everything needed:
 *   - `dialogs` is in open order, so the LAST modal is the topmost one, and
 *     modals (DialogView, z-index 1000) outrank every non-modal surface.
 *   - `main` decides which single non-modal surface is on screen, mirroring
 *     MainView's render conditions: "creation" shows the modeless creation
 *     panel, "workspace" may show a "panel" session (deletion progress or the
 *     mid-session loading spinner) over the frame.
 *
 * `null` means no dialog surface owns focus — the workspace frame does, which
 * WorkspaceFrames already gates on `mode === "workspace"`.
 *
 * NOTE: this governs focus moves that go through our code. A workspace iframe
 * whose VSCodium focuses itself on load is outside it by design; that class is
 * handled (if at all) main-side, by not making such a workspace active.
 */

import type { UiDialog, UiState } from "@shared/ui-state";

/**
 * The topmost open modal's id, or null when none is open. Modals stack above
 * everything else and above each other, so this alone decides ownership among
 * modal surfaces — which is why DialogHost can use it without consulting
 * `main`.
 */
export function topmostModalId(dialogs: readonly UiDialog[]): string | null {
  for (let index = dialogs.length - 1; index >= 0; index--) {
    const dialog = dialogs[index];
    if (dialog?.kind === "modal") return dialog.id;
  }
  return null;
}

/**
 * The id of the dialog session entitled to place focus, or null when none is
 * (the workspace frame owns it).
 */
export function focusOwnerId(ui: Pick<UiState, "dialogs" | "main">): string | null {
  const modal = topmostModalId(ui.dialogs);
  if (modal !== null) return modal;
  // Below the modals exactly one non-modal surface is rendered, and `main`
  // says which — the two branches mirror MainView's `{#if}` conditions.
  if (ui.main.kind === "creation") {
    return ui.dialogs.find((dialog) => dialog.kind === "modeless")?.id ?? null;
  }
  if (ui.main.kind === "workspace") {
    return ui.dialogs.find((dialog) => dialog.kind === "panel")?.id ?? null;
  }
  return null;
}
