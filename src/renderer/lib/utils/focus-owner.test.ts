/**
 * Tests for the focus-ownership derivation (pure function over the snapshot).
 * The rule it encodes: modals outrank everything and each other (last in open
 * order wins); below them `main` decides which single non-modal surface is on
 * screen, mirroring MainView's render conditions.
 */

import { describe, it, expect } from "vitest";
import type { UiDialog, UiMainView } from "@shared/ui-state";
import type { DialogKind } from "@shared/dialog-types";
import { focusOwnerId, topmostModalId } from "./focus-owner";

function dialog(id: string, kind: DialogKind): UiDialog {
  return { id, kind, config: { sections: [] } };
}

const WORKSPACE: UiMainView = { kind: "workspace", frameKey: "p1/ws" };
const CREATION: UiMainView = { kind: "creation" };

describe("topmostModalId", () => {
  it("returns null when no modal is open", () => {
    expect(topmostModalId([dialog("panel-1", "panel"), dialog("create-1", "modeless")])).toBeNull();
  });

  it("returns the last modal in open order (the topmost one)", () => {
    const dialogs = [
      dialog("create-1", "modeless"),
      dialog("bug-report", "modal"),
      dialog("settings", "modal"),
    ];

    expect(topmostModalId(dialogs)).toBe("settings");
  });

  it("ignores non-modal sessions opened after the modal", () => {
    const dialogs = [dialog("bug-report", "modal"), dialog("panel-1", "panel")];

    expect(topmostModalId(dialogs)).toBe("bug-report");
  });
});

describe("focusOwnerId", () => {
  it("gives the frame ownership (null) when only workspace content is showing", () => {
    expect(focusOwnerId({ dialogs: [], main: WORKSPACE })).toBeNull();
  });

  // The reported bug: a panel appearing behind an open modal must not own
  // focus, so its form never autofocuses over the dialog the user is typing in.
  it("keeps ownership on the modal when a panel opens behind it", () => {
    const dialogs = [dialog("bug-report", "modal"), dialog("panel-1", "panel")];

    expect(focusOwnerId({ dialogs, main: WORKSPACE })).toBe("bug-report");
  });

  it("keeps ownership on the modal when main falls back to the creation panel", () => {
    const dialogs = [dialog("create-1", "modeless"), dialog("bug-report", "modal")];

    expect(focusOwnerId({ dialogs, main: CREATION })).toBe("bug-report");
  });

  it("hands ownership to the panel once the modal above it closes", () => {
    const dialogs = [dialog("panel-1", "panel")];

    expect(focusOwnerId({ dialogs, main: WORKSPACE })).toBe("panel-1");
  });

  it("hands ownership to the creation panel in the creation ground state", () => {
    const dialogs = [dialog("create-1", "modeless")];

    expect(focusOwnerId({ dialogs, main: CREATION })).toBe("create-1");
  });

  // The creation session is always alive, so it is in the snapshot even while
  // a workspace is showing — it only owns focus when main actually renders it.
  it("does not give the always-alive creation session ownership while a workspace shows", () => {
    const dialogs = [dialog("create-1", "modeless")];

    expect(focusOwnerId({ dialogs, main: WORKSPACE })).toBeNull();
  });

  it("does not give a panel ownership while main shows the creation ground state", () => {
    const dialogs = [dialog("panel-1", "panel")];

    expect(focusOwnerId({ dialogs, main: CREATION })).toBeNull();
  });

  it("gives nobody ownership on the hibernated and startup screens", () => {
    const dialogs = [dialog("create-1", "modeless"), dialog("panel-1", "panel")];

    expect(focusOwnerId({ dialogs, main: { kind: "hibernated", screenshot: null } })).toBeNull();
    expect(focusOwnerId({ dialogs, main: { kind: "starting" } })).toBeNull();
  });
});
