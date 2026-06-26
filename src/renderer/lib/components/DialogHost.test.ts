/**
 * Tests for DialogHost surface routing: it renders a DialogView per open MODAL
 * dialog from the ui:state snapshot and leaves panel-surface sessions to
 * MainView's PanelView.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { DialogConfig } from "@shared/dialog-types";
import type { UiDialog, UiState } from "@shared/ui-state";

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
import { setUiState, resetUiState } from "$lib/stores/ui-state.svelte.js";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

/** Push a snapshot carrying the given open dialogs. */
function showDialogs(dialogs: UiDialog[]): void {
  setUiState({
    sidebar: { projects: [] },
    frames: {},
    main: { kind: "creation" },
    theme: "dark",
    mode: "hover",
    dialogs,
    notifications: [],
  } satisfies UiState);
}

describe("DialogHost surface routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUiState();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetUiState();
  });

  it("renders a DialogView for a modal entry", () => {
    render(DialogHost);

    showDialogs([{ id: "dlg-1", surface: "modal", config: createConfig("Modal") }]);
    flushSync();

    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });

  it("does not render panel-surface entries", () => {
    render(DialogHost);

    showDialogs([{ id: "dlg-1", surface: "panel", config: createConfig("Panel form") }]);
    flushSync();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders only the modal entry when both surfaces are active", () => {
    render(DialogHost);

    showDialogs([
      { id: "dlg-1", surface: "modal", config: createConfig("Modal") },
      { id: "dlg-2", surface: "panel", config: createConfig("Panel form") },
    ]);
    flushSync();

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });
});
