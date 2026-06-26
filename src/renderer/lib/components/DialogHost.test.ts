/**
 * Tests for DialogHost surface routing: it renders a DialogView per open MODAL
 * dialog from the ui:state snapshot and leaves panel-surface sessions to
 * MainView's PanelView.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { DialogConfig } from "@shared/dialog-types";
import type { UiDialog } from "@shared/ui-state";

// Mock setup - must be hoisted
const { mockSendDialogEvent } = vi.hoisted(() => ({
  mockSendDialogEvent: vi.fn(),
}));

vi.mock("$lib/api", () => ({
  sendDialogEvent: mockSendDialogEvent,
  on: vi.fn(() => vi.fn()),
}));

// Import after mock setup
import DialogHost from "./DialogHost.svelte";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

/** Render DialogHost with the given open dialogs as props. */
function renderDialogs(dialogs: UiDialog[]): void {
  render(DialogHost, { props: { dialogs } });
}

describe("DialogHost surface routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a DialogView for a modal entry", () => {
    renderDialogs([{ id: "dlg-1", surface: "modal", config: createConfig("Modal") }]);

    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });

  it("does not render panel-surface entries", () => {
    renderDialogs([{ id: "dlg-1", surface: "panel", config: createConfig("Panel form") }]);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders only the modal entry when both surfaces are active", () => {
    renderDialogs([
      { id: "dlg-1", surface: "modal", config: createConfig("Modal") },
      { id: "dlg-2", surface: "panel", config: createConfig("Panel form") },
    ]);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });
});
