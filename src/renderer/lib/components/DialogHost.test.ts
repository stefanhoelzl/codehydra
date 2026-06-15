/**
 * Tests for DialogHost surface routing: it renders a DialogView per active
 * MODAL dialog and leaves panel-surface sessions to MainView's PanelView.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { DialogConfig } from "@shared/dialog-types";

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
import { processCommand, reset } from "$lib/stores/dialog-framework.svelte.js";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

describe("DialogHost surface routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    reset();
  });

  it("renders a DialogView for a modal entry", () => {
    render(DialogHost);

    processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Modal") });
    flushSync();

    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });

  it("does not render panel-surface entries", () => {
    render(DialogHost);

    processCommand({
      action: "open",
      dialogId: "dlg-1",
      config: createConfig("Panel form"),
      surface: "panel",
    });
    flushSync();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders only the modal entry when both surfaces are active", () => {
    render(DialogHost);

    processCommand({ action: "open", dialogId: "dlg-1", config: createConfig("Modal") });
    processCommand({
      action: "open",
      dialogId: "dlg-2",
      config: createConfig("Panel form"),
      surface: "panel",
    });
    flushSync();

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Modal" })).toBeInTheDocument();
  });
});
