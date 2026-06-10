/**
 * Tests for the HibernatedOverlay component.
 *
 * The overlay shows a pause icon at rest; CSS swaps it to a play icon while
 * the indicator button is hovered (the swap itself is CSS-only and not
 * observable in happy-dom — the tests assert both icons are in the DOM).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { Api } from "@shared/electron-api";
import { createMockApi } from "../test-utils";

// Must be set before component import because $lib/api checks window.api
const mockApi: Api = createMockApi();
window.api = mockApi;

vi.mock("$lib/api", () => ({
  workspaces: {
    getScreenshot: vi.fn().mockResolvedValue({ url: null }),
  },
}));

vi.mock("$lib/stores/shortcuts.svelte", () => ({
  handleHibernateToggle: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock setup
import HibernatedOverlay from "./HibernatedOverlay.svelte";
import { handleHibernateToggle } from "$lib/stores/shortcuts.svelte";
import type { WorkspaceRef } from "@shared/api/types";

const workspaceRef = {
  projectId: "test-12345678",
  workspaceName: "ws1",
  path: "/test/.worktrees/ws1",
} as WorkspaceRef;

describe("HibernatedOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders both pause and play icons inside the wake button", () => {
    const { container } = render(HibernatedOverlay, { props: { workspaceRef } });

    const indicator = container.querySelector(".indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator!.querySelector(".icon-pause vscode-icon")).toBeInTheDocument();
    expect(indicator!.querySelector(".icon-play vscode-icon")).toBeInTheDocument();
  });

  it("shows the hibernated label and wake hint", () => {
    render(HibernatedOverlay, { props: { workspaceRef } });

    expect(screen.getByText("Hibernated")).toBeInTheDocument();
    expect(screen.getByText(/Alt\+X H/)).toBeInTheDocument();
  });

  it("clicking the indicator wakes the workspace", async () => {
    render(HibernatedOverlay, { props: { workspaceRef } });

    const button = screen.getByRole("button", { name: /wake workspace/i });
    await fireEvent.click(button);

    expect(handleHibernateToggle).toHaveBeenCalled();
  });
});
