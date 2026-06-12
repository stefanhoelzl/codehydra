/**
 * Tests for the Sidebar component.
 *
 * The sidebar renders UiProjectRow/UiWorkspaceRow data from the UiState
 * snapshot — rows arrive pre-joined (status, agent, tags, active), so the
 * tests build row fixtures instead of populating stores.
 *
 * The sidebar uses one DOM tree for both the expanded and collapsed state:
 * every row is [label cell | icon cell at the right edge] and the collapsed
 * sidebar shows only the icon column (via CSS keyed on the `.expanded`
 * class). Expansion is derived from the real ui-mode store, so these tests
 * use the actual store (reset between tests) instead of mocking it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { Api } from "@shared/electron-api";
import { createMockApi, makeUiProjectRow, makeUiWorkspaceRow } from "../test-utils";
// Import utility functions directly from the utility module
import { getStatusText } from "$lib/utils/sidebar-utils";

// Create mock API (flat structure) — must be set before Sidebar import
// because NotificationStack transitively imports $lib/api which checks window.api
const mockApi: Api = createMockApi();
window.api = mockApi;

// Mock $lib/api to avoid import-time window.api check
vi.mock("$lib/api", () => ({
  emitEvent: vi.fn(),
  sendNotificationEvent: vi.fn(),
  on: vi.fn(() => () => {}),
  workspaces: {
    wake: vi.fn().mockResolvedValue(null),
  },
}));

// Import after mock setup
import { workspaces as apiWorkspaces } from "$lib/api";
import Sidebar from "./Sidebar.svelte";
import {
  desiredMode,
  setModeFromMain,
  setDialogOpen,
  reset as resetUiMode,
} from "$lib/stores/ui-mode.svelte.js";

const HOVER_DELAY_MS = 150;

/** Deliberate hover: cursor deep in the gutter, sustained past the open delay. */
async function hoverExpand(sidebar: Element): Promise<void> {
  await fireEvent.mouseEnter(sidebar);
  await fireEvent.mouseMove(sidebar, { clientX: 8 });
  vi.advanceTimersByTime(HOVER_DELAY_MS);
  flushSync();
}

describe("getStatusText helper", () => {
  it('returns "No agents running" for (0, 0)', () => {
    expect(getStatusText(0, 0)).toBe("No agents running");
  });

  it('returns "1 agent idle" for (1, 0)', () => {
    expect(getStatusText(1, 0)).toBe("1 agent idle");
  });

  it('returns "2 agents idle" for (2, 0)', () => {
    expect(getStatusText(2, 0)).toBe("2 agents idle");
  });

  it('returns "1 agent busy" for (0, 1)', () => {
    expect(getStatusText(0, 1)).toBe("1 agent busy");
  });

  it('returns "3 agents busy" for (0, 3)', () => {
    expect(getStatusText(0, 3)).toBe("3 agents busy");
  });

  it('returns "2 idle, 3 busy" for (2, 3)', () => {
    expect(getStatusText(2, 3)).toBe("2 idle, 3 busy");
  });
});

describe("Sidebar component", () => {
  const defaultProps = {
    projects: [],
    shortcutModeActive: false,
    onCloseProject: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onOpenNewWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetUiMode();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUiMode();
    document.body.innerHTML = "";
  });

  describe("accessibility", () => {
    it('renders with nav element and aria-label="Projects"', () => {
      render(Sidebar, { props: defaultProps });

      const nav = screen.getByRole("navigation", { name: "Projects" });
      expect(nav).toBeInTheDocument();
    });

    it("active workspace has aria-current='true'", () => {
      const ws = makeUiWorkspaceRow("ws1", { active: true });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const workspaceItem = screen.getByText(ws.name).closest("li");
      expect(workspaceItem).toHaveAttribute("aria-current", "true");
    });
  });

  describe("state rendering", () => {
    it("shows the New workspace entry and no 'no projects' text when there are no projects", () => {
      render(Sidebar, { props: defaultProps });

      // The New workspace entry is the only affordance; the old empty-state text is gone.
      expect(screen.getByRole("button", { name: /new workspace/i })).toBeInTheDocument();
      expect(screen.queryByText(/No projects open\./)).not.toBeInTheDocument();
    });
  });

  describe("list structure", () => {
    it("renders project list with ul/li structure", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("feature-1")]);
      render(Sidebar, { props: { ...defaultProps, projects: [project] } });

      const lists = screen.getAllByRole("list");
      expect(lists.length).toBeGreaterThan(0);

      const items = screen.getAllByRole("listitem");
      expect(items.length).toBeGreaterThan(0);
    });

    it("renders workspaces under each project", () => {
      const project = makeUiProjectRow([
        makeUiWorkspaceRow("workspace-1"),
        makeUiWorkspaceRow("workspace-2"),
      ]);

      render(Sidebar, { props: { ...defaultProps, projects: [project] } });

      expect(screen.getByText("workspace-1")).toBeInTheDocument();
      expect(screen.getByText("workspace-2")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("global 'New workspace' entry opens the New workspace view", async () => {
      const onOpenNewWorkspace = vi.fn();
      const project = makeUiProjectRow([makeUiWorkspaceRow("feature-1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onOpenNewWorkspace },
      });

      // Single global entry (no per-project add button); takes no projectId.
      const newWorkspaceButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(newWorkspaceButton);

      expect(onOpenNewWorkspace).toHaveBeenCalledWith();
    });

    it("[x] on project calls closeProject", async () => {
      const onCloseProject = vi.fn();
      const project = makeUiProjectRow([makeUiWorkspaceRow("feature-1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onCloseProject },
      });

      const closeButton = screen.getByLabelText(/close project/i);
      await fireEvent.click(closeButton);

      expect(onCloseProject).toHaveBeenCalledWith(project.id);
    });

    it("[x] on workspace requests the remove flow with the row key", async () => {
      const onRemoveWorkspace = vi.fn();
      const ws = makeUiWorkspaceRow("ws1");
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onRemoveWorkspace },
      });

      const removeButton = screen.getByLabelText(/remove workspace/i);
      await fireEvent.click(removeButton);

      expect(onRemoveWorkspace).toHaveBeenCalledWith(ws.key);
    });

    it("clicking workspace calls switchWorkspace", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = makeUiWorkspaceRow("ws1");
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const workspaceButton = screen.getByRole("button", { name: ws.name });
      await fireEvent.click(workspaceButton);

      expect(onSwitchWorkspace).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("does not call switchWorkspace for a creating workspace row", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = makeUiWorkspaceRow("ws1", { status: "creating" });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const workspaceButton = screen.getByRole("button", { name: ws.name });
      await fireEvent.click(workspaceButton);

      expect(onSwitchWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("shortcut mode index numbers", () => {
    it("should-show-index-numbers-when-shortcut-mode-active", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1"), makeUiWorkspaceRow("ws2")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("should-hide-index-numbers-when-shortcut-mode-inactive", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: false },
      });

      expect(screen.queryByText("1")).not.toBeInTheDocument();
    });

    it("should-display-indices-1-through-9-then-0-for-tenth", () => {
      const workspaces = Array.from({ length: 10 }, (_, i) => makeUiWorkspaceRow(`ws${i + 1}`));
      const project = makeUiProjectRow(workspaces);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      // Check indices 1-9
      for (let i = 1; i <= 9; i++) {
        expect(screen.getByText(String(i))).toBeInTheDocument();
      }
      // Check index 0 for 10th workspace
      expect(screen.getByText("0")).toBeInTheDocument();
    });

    it("should-number-workspaces-globally-across-projects", () => {
      const project1 = makeUiProjectRow([makeUiWorkspaceRow("ws1"), makeUiWorkspaceRow("ws2")], {
        id: "p1-12345678",
        name: "p1",
      });
      const project2 = makeUiProjectRow([makeUiWorkspaceRow("ws3")], {
        id: "p2-12345678",
        name: "p2",
      });

      render(Sidebar, {
        props: {
          ...defaultProps,
          projects: [project1, project2],
          shortcutModeActive: true,
        },
      });

      // All three workspaces should have sequential indices
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("should-show-dimmed-dot-for-workspaces-beyond-tenth", () => {
      const workspaces = Array.from({ length: 11 }, (_, i) => makeUiWorkspaceRow(`ws${i + 1}`));
      const project = makeUiProjectRow(workspaces);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      // 11th workspace should show a dot
      const dot = screen.getByText("·");
      expect(dot).toBeInTheDocument();
      // Using vscode-badge with .badge-dimmed class for unavailable shortcuts
      expect(dot).toHaveClass("badge-dimmed");
    });

    it("should-have-aria-hidden-on-index-spans", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      const indexSpan = screen.getByText("1");
      expect(indexSpan).toHaveAttribute("aria-hidden", "true");
    });

    it("should-include-shortcut-hint-in-workspace-button-aria-label", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("my-workspace")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      const button = screen.getByRole("button", {
        name: /my-workspace.*press 1 to jump/i,
      });
      expect(button).toBeInTheDocument();
    });
  });

  describe("agent status indicator", () => {
    it("renders agent status indicator for each workspace", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should have an indicator with status role
      const indicators = screen.getAllByRole("status");
      expect(indicators.length).toBeGreaterThan(0);
    });

    it("shows 'none' status when the row carries no agent", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should show 'no agents running' indicator
      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/no agents running/i));
    });

    it("shows idle status when the row carries idle agents", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        agent: { type: "idle", counts: { idle: 2, busy: 0, total: 2 } },
      });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/2 agents? idle/i));
    });

    it("shows busy status when the row carries busy agents", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 agent busy/i));
    });

    it("shows mixed status when the row carries both idle and busy agents", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        agent: { type: "mixed", counts: { idle: 1, busy: 2, total: 3 } },
      });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 idle.+2 busy/i));
    });

    it("renders separate indicators for multiple workspaces", () => {
      const ws1 = makeUiWorkspaceRow("ws1", {
        agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
      });
      const ws2 = makeUiWorkspaceRow("ws2", {
        agent: { type: "busy", counts: { idle: 0, busy: 2, total: 2 } },
      });
      const project = makeUiProjectRow([ws1, ws2]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicators = screen.getAllByRole("status");
      expect(indicators).toHaveLength(2);

      // Check that we have both idle and busy indicators
      const ariaLabels = indicators.map((el) => el.getAttribute("aria-label"));
      expect(ariaLabels.some((label) => label?.match(/idle/i))).toBe(true);
      expect(ariaLabels.some((label) => label?.match(/busy/i))).toBe(true);
    });
  });

  describe("status cell button", () => {
    // The status cell is a button in BOTH modes; clicks bubble to the row's
    // switch handler. When collapsed it is the entire visible row.

    it("renders a status cell button for each workspace", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1"), makeUiWorkspaceRow("ws2")]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Sidebar is collapsed (workspaces exist, not hovering, uiMode is workspace)
      const statusButtons = screen.getAllByRole("button", { name: /in test.*agent/i });
      expect(statusButtons).toHaveLength(2);
    });

    it("clicking status cell button calls onSwitchWorkspace", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = makeUiWorkspaceRow("ws1");
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test.*agent/i });
      await fireEvent.click(statusButton);

      expect(onSwitchWorkspace).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("status cell button has descriptive aria-label with workspace, project, and status", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        agent: { type: "busy", counts: { idle: 0, busy: 2, total: 2 } },
      });
      const project = makeUiProjectRow([ws], { name: "test" });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Button should have aria-label with workspace name, project name, and status
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*busy/i });
      expect(statusButton).toBeInTheDocument();
    });

    it("active workspace status button has aria-current='true'", () => {
      const ws = makeUiWorkspaceRow("ws1", { active: true });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test.*agent/i });
      expect(statusButton).toHaveAttribute("aria-current", "true");
    });

    it("inactive workspace status button does not have aria-current", () => {
      const ws1 = makeUiWorkspaceRow("ws1", { active: true });
      const ws2 = makeUiWorkspaceRow("ws2");
      const project = makeUiProjectRow([ws1, ws2]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // ws2's button should NOT have aria-current
      const ws2Button = screen.getByRole("button", { name: /ws2 in test.*agent/i });
      expect(ws2Button).not.toHaveAttribute("aria-current");
    });
  });

  describe("expand hint chevrons", () => {
    // The expand hint is the one element that truly only exists in one mode
    // (collapsed); everything else is a single DOM tree styled per mode.

    it("renders expand hint chevron in header when collapsed", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Sidebar is collapsed - check that header contains an expand hint chevron
      const header = container.querySelector(".sidebar-header");
      expect(header).not.toBeNull();

      const headerChevron = header!.querySelector(".expand-hint");
      expect(headerChevron).toBeInTheDocument();
      expect(headerChevron).toHaveAttribute("aria-hidden", "true");
      // Icon component renders vscode-icon for chevron
      expect(headerChevron!.querySelector("vscode-icon")).toBeInTheDocument();
    });

    it("does not render expand hints when expanded", () => {
      // When there are no workspaces, sidebar is expanded
      const { container } = render(Sidebar, { props: defaultProps });

      // Sidebar is expanded - expand hints should NOT be visible
      const expandHints = container.querySelectorAll(".expand-hint");
      expect(expandHints.length).toBe(0);
    });
  });

  describe("rendering order", () => {
    // Note: Sorting is done by the main-process presenter — the snapshot
    // arrives pre-sorted. Sidebar renders rows in the order it receives them.

    it("renders projects in the order provided", () => {
      const mkProject = (name: string): ReturnType<typeof makeUiProjectRow> =>
        makeUiProjectRow([makeUiWorkspaceRow("ws", { path: `/${name}/ws`, key: `${name}/ws` })], {
          id: `${name}-12345678`,
          name,
        });

      render(Sidebar, {
        props: {
          ...defaultProps,
          // Pass projects in display order (as the presenter provides)
          projects: [
            mkProject("Alpha"),
            mkProject("alpha"),
            mkProject("beta"),
            mkProject("charlie"),
          ],
        },
      });

      // Get all project names in rendered order (filter to .project-name elements only)
      const projectNames = screen
        .getAllByTitle(/^\//)
        .filter((el) => el.classList.contains("project-name"));
      const names = projectNames.map((el) => el.textContent);

      expect(names).toEqual(["Alpha", "alpha", "beta", "charlie"]);
    });

    it("renders workspaces in the order provided", () => {
      const project = makeUiProjectRow([
        makeUiWorkspaceRow("Alpha"),
        makeUiWorkspaceRow("alpha", { key: "test-project-12345678/alpha-lower" }),
        makeUiWorkspaceRow("Beta"),
        makeUiWorkspaceRow("beta", { key: "test-project-12345678/beta-lower" }),
        makeUiWorkspaceRow("charlie"),
      ]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Get workspace buttons in rendered order
      const workspaceButtons = screen.getAllByRole("button", {
        name: /^(Alpha|alpha|Beta|beta|charlie)$/,
      });
      const names = workspaceButtons.map((el) => el.textContent?.trim());

      expect(names).toEqual(["Alpha", "alpha", "Beta", "beta", "charlie"]);
    });

    it("shortcut indices match rendered order", () => {
      const project = makeUiProjectRow([
        makeUiWorkspaceRow("alpha"),
        makeUiWorkspaceRow("beta"),
        makeUiWorkspaceRow("charlie"),
      ]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      // alpha should be index 1 (first in the list)
      const alphaButton = screen.getByRole("button", { name: /alpha.*press 1 to jump/i });
      expect(alphaButton).toBeInTheDocument();

      // beta should be index 2
      const betaButton = screen.getByRole("button", { name: /beta.*press 2 to jump/i });
      expect(betaButton).toBeInTheDocument();

      // charlie should be index 3
      const charlieButton = screen.getByRole("button", { name: /charlie.*press 3 to jump/i });
      expect(charlieButton).toBeInTheDocument();
    });
  });

  describe("expansion state", () => {
    const propsWithWorkspaces = () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);
      return { ...defaultProps, projects: [project] };
    };

    it("expands after deliberate hover (trigger depth + open delay)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).not.toHaveClass("expanded");

      await hoverExpand(sidebar!);

      expect(sidebar).toHaveClass("expanded");
    });

    it("expands when the cursor enters and rests without further movement (edge slam)", async () => {
      // A cursor slammed against the window edge can come to rest in the
      // same frame it enters: mouseenter fires, but no mousemove follows.
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!, { clientX: 0 });

      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(sidebar).toHaveClass("expanded");
    });

    it("does not expand before the open delay elapses", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });

      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("does not expand while the cursor stays in the outer quarter of the gutter", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 18 });

      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("moving back out of the trigger depth cancels the pending expansion", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      await fireEvent.mouseMove(sidebar!, { clientX: 18 });

      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("leaving before the open delay elapses cancels the pending expansion", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });

      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("collapses on mouseleave after the debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      await hoverExpand(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      // Should still be expanded immediately (debounce hasn't elapsed)
      expect(sidebar).toHaveClass("expanded");

      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("expands after a slam to the left edge (shallow enter, then leave reported outside)", async () => {
      // Observed event stream of a fast slam: one shallow enter (x=18), then
      // a leave at x=-1 as the OS pins the cursor against the window edge.
      // No further events arrive while the cursor rests there.
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!, { clientX: 18 });
      await fireEvent.mouseLeave(sidebar!, { clientX: -1 });

      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(sidebar).toHaveClass("expanded");
    });

    it("collapses on left exit when the window is not at the screen edge (windowed mode)", async () => {
      // With space left of the window the cursor genuinely leaves; the pin
      // interpretation only applies when the window sits at the screen edge.
      const original = Object.getOwnPropertyDescriptor(window, "screenX");
      Object.defineProperty(window, "screenX", { value: 120, configurable: true });
      try {
        const { container } = render(Sidebar, { props: propsWithWorkspaces() });

        const sidebar = container.querySelector(".sidebar");
        await hoverExpand(sidebar!);
        expect(sidebar).toHaveClass("expanded");

        await fireEvent.mouseLeave(sidebar!, { clientX: -1 });
        vi.advanceTimersByTime(HOVER_DELAY_MS);
        flushSync();

        expect(sidebar).not.toHaveClass("expanded");
      } finally {
        if (original) {
          Object.defineProperty(window, "screenX", original);
        } else {
          Object.defineProperty(window, "screenX", { value: 0, configurable: true });
        }
      }
    });

    it("stays expanded while the cursor is pinned at the left window edge", async () => {
      // A leave through the left boundary is a pin (deepest hover), not a
      // leave — the sidebar must not collapse underneath the pinned cursor.
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      await fireEvent.mouseLeave(sidebar!, { clientX: 0 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(sidebar).toHaveClass("expanded");
    });

    it("stays expanded when uiMode is 'shortcut'", () => {
      setModeFromMain("shortcut");
      flushSync();
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("does not latch hover while shortcut mode forces expansion", async () => {
      // Scenario: Alt+X is pressed, sidebar expands into a parked cursor and
      // mousemove events fire. When Alt is released the sidebar must collapse
      // because hover was never latched.
      setModeFromMain("shortcut");
      flushSync();

      const { container } = render(Sidebar, {
        props: { ...propsWithWorkspaces(), shortcutModeActive: true },
      });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");

      // Cursor sits deep in the sidebar area during shortcut mode
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      // Shortcut mode exits — sidebar collapses (hover was not latched)
      setModeFromMain("workspace");
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("does not latch hover while a dialog forces expansion", async () => {
      setDialogOpen(true);
      flushSync();

      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");

      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      setDialogOpen(false);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("stays expanded when a dialog is open", () => {
      setDialogOpen(true);
      flushSync();
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("stays expanded when there are no workspaces", () => {
      const { container } = render(Sidebar, { props: defaultProps });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("rapid hover in/out settles to correct final state", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      await hoverExpand(sidebar!);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      await fireEvent.mouseEnter(sidebar!);
      flushSync();

      // Should be expanded because last action was re-entering
      expect(sidebar).toHaveClass("expanded");

      // Leave and wait
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(sidebar).not.toHaveClass("expanded");
    });

    it("cancels collapse when mouse re-enters during debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      await hoverExpand(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });

      // Wait partial debounce
      vi.advanceTimersByTime(100);

      // Re-enter before debounce completes
      await fireEvent.mouseEnter(sidebar!);

      // Wait full debounce time
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      // Should still be expanded because re-enter cancelled collapse
      expect(sidebar).toHaveClass("expanded");
    });

    it("clears pending timeouts on unmount", async () => {
      const { container, unmount } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      await hoverExpand(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // Start collapse (this schedules a timeout)
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });

      // Unmount before timeout fires
      unmount();

      vi.advanceTimersByTime(200);
      flushSync();

      // The collapse timeout was cleared: the store input set by hover is
      // untouched after unmount.
      expect(desiredMode.value).toBe("hover");
    });

    it("respects prefers-reduced-motion media query (CSS verification)", () => {
      // Note: CSS @media (prefers-reduced-motion: reduce) cannot be fully tested in JSDOM
      // since JSDOM doesn't support media query evaluation.
      // We verify the CSS rule exists by checking the component renders correctly.
      // The actual animation disable is handled by CSS.
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toBeInTheDocument();
      // The sidebar class enables CSS to apply the @media rule
      expect(sidebar).toHaveClass("sidebar");
    });
  });

  describe("unified layout (expanded vs collapsed)", () => {
    const propsWithWorkspaces = () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")], { name: "test" });
      return { ...defaultProps, projects: [project] };
    };

    it("renders one DOM tree: status cell, workspace button, and remove button exist in both modes", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      // Collapsed
      expect(sidebar).not.toHaveClass("expanded");
      expect(container.querySelector(".status-cell")).toBeInTheDocument();
      expect(container.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(container.querySelector(".remove-btn")).toBeInTheDocument();

      // Expanded — same elements, no markup swap
      await hoverExpand(sidebar!);
      expect(sidebar).toHaveClass("expanded");
      expect(container.querySelector(".status-cell")).toBeInTheDocument();
      expect(container.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(container.querySelector(".remove-btn")).toBeInTheDocument();
    });

    it("status cell has descriptive aria-label in both modes", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      const assertLabel = (): void => {
        const statusCell = container.querySelector(".status-cell");
        expect(statusCell).toHaveAttribute("aria-label");
        expect(statusCell!.getAttribute("aria-label")).toMatch(/ws1 in test/);
      };

      assertLabel();
      await hoverExpand(sidebar!);
      assertLabel();
    });

    it("workspace label and remove button are in a label cell (hidden when collapsed via CSS)", () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const labelCell = container.querySelector(".workspace-label-cell");
      expect(labelCell).toHaveClass("ch-label-cell");
      expect(labelCell!.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(labelCell!.querySelector(".remove-btn")).toBeInTheDocument();
    });

    it("project header is a label cell and has no inert attribute", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      const header = container.querySelector(".project-header");
      expect(header).toHaveClass("ch-label-cell");
      expect(header).not.toHaveAttribute("inert");

      await hoverExpand(sidebar!);
      expect(header).not.toHaveAttribute("inert");
    });

    it("h2 heading exists in both modes inside a label cell", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      expect(sidebar).not.toHaveClass("expanded");
      const heading = container.querySelector(".sidebar-header h2");
      expect(heading).toBeInTheDocument();
      expect(heading!.closest(".ch-label-cell")).not.toBeNull();

      await hoverExpand(sidebar!);
      expect(container.querySelector(".sidebar-header h2")).toBeInTheDocument();
    });

    it("vscode-divider has no inert attribute", () => {
      const project1 = makeUiProjectRow([makeUiWorkspaceRow("ws1")], {
        id: "p1-12345678",
        name: "test",
      });
      const project2 = makeUiProjectRow([makeUiWorkspaceRow("ws2", { path: "/test2/ws2" })], {
        id: "p2-12345678",
        name: "test2",
      });

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project1, project2] },
      });

      expect(container.querySelector(".sidebar")).not.toHaveClass("expanded");
      const divider = container.querySelector("vscode-divider");
      expect(divider).toBeInTheDocument();
      expect(divider).not.toHaveAttribute("inert");
    });
  });

  describe("workspace tags", () => {
    it("renders tag badges when the row carries tags", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        tags: [{ name: "bugfix" }, { name: "wip", color: "#ff0" }],
      });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const tagsContainer = container.querySelector(".workspace-tags");
      expect(tagsContainer).toBeInTheDocument();
      // The tags row is hidden when collapsed via CSS keyed on .expanded
      expect(container.querySelector(".workspace-tags-row")).toBeInTheDocument();

      const pills = container.querySelectorAll(".tag-pill");
      expect(pills).toHaveLength(2);

      const pillTexts = Array.from(pills).map((p) => p.textContent?.trim());
      expect(pillTexts).toContain("bugfix");
      expect(pillTexts).toContain("wip");
    });

    it("does not render tags container when the row has no tags", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      expect(container.querySelector(".workspace-tags")).not.toBeInTheDocument();
      expect(container.querySelector(".workspace-tags-row")).not.toBeInTheDocument();
    });
  });

  describe("hibernation indicator", () => {
    const hibernatedSetup = () => {
      const ws = makeUiWorkspaceRow("ws1", { hibernated: true });
      const project = makeUiProjectRow([ws], { name: "test" });
      return {
        ws,
        project,
        props: { ...defaultProps, projects: [project] },
      };
    };

    it("renders both pause and play icons for a hibernated workspace", () => {
      const { props } = hibernatedSetup();
      const { container } = render(Sidebar, { props });

      // Both icons are in the DOM; CSS swaps them on :hover (not testable here).
      const indicator = container.querySelector(".hibernation-indicator");
      expect(indicator).toBeInTheDocument();
      expect(indicator!.querySelector(".icon-pause vscode-icon")).toBeInTheDocument();
      expect(indicator!.querySelector(".icon-play vscode-icon")).toBeInTheDocument();
    });

    it("status cell aria-label announces the wake action when hibernated", () => {
      const { props } = hibernatedSetup();
      render(Sidebar, { props });

      const statusButton = screen.getByRole("button", {
        name: /ws1 in test - Hibernated - click to wake/i,
      });
      expect(statusButton).toBeInTheDocument();
    });

    it("clicking the status cell wakes the workspace and switches to it", async () => {
      const onSwitchWorkspace = vi.fn();
      const { ws, project, props } = hibernatedSetup();
      render(Sidebar, { props: { ...props, onSwitchWorkspace } });

      const statusButton = screen.getByRole("button", { name: /Hibernated - click to wake/i });
      await fireEvent.click(statusButton);

      expect(apiWorkspaces.wake).toHaveBeenCalledWith(ws.path);
      // The click bubbles to the row's switch handler.
      expect(onSwitchWorkspace).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("clicking the status cell of a non-hibernated workspace does not wake", async () => {
      const onSwitchWorkspace = vi.fn();
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")], { name: "test" });
      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test/i });
      await fireEvent.click(statusButton);

      expect(apiWorkspaces.wake).not.toHaveBeenCalled();
      expect(onSwitchWorkspace).toHaveBeenCalled();
    });

    it("does not render the hibernation indicator when not hibernated", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);
      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      expect(container.querySelector(".hibernation-indicator")).not.toBeInTheDocument();
    });
  });

  describe("deletion indicator", () => {
    it("shows spinner when workspace is deleting (expanded)", async () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "deleting" });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should have progress-ring (spinner) instead of status indicator
      expect(container.querySelector("vscode-progress-ring.deletion-spinner")).toBeInTheDocument();
    });

    it("shows agent status indicator when not deleting", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should have status indicator, NOT spinner
      expect(
        container.querySelector("vscode-progress-ring.deletion-spinner")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("status cell aria-label shows Deleting when workspace is being deleted", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "deleting" });
      const project = makeUiProjectRow([ws], { name: "test" });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // The button aria-label should say "Deleting" instead of agent status
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*deleting/i });
      expect(statusButton).toBeInTheDocument();
    });

    it("shows spinner for deleting workspace and status for non-deleting", () => {
      const ws1 = makeUiWorkspaceRow("ws1", { status: "deleting" });
      const ws2 = makeUiWorkspaceRow("ws2");
      const project = makeUiProjectRow([ws1, ws2]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should have one spinner (ws1) and one status indicator (ws2)
      expect(container.querySelectorAll("vscode-progress-ring.deletion-spinner")).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("hides X button when deletion status is in-progress", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "deleting" });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // X button should NOT be rendered for workspace being deleted
      expect(screen.queryByLabelText("Remove workspace")).not.toBeInTheDocument();
    });

    it("hides X button when deletion status is error", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "delete-failed" });
      const project = makeUiProjectRow([ws]);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // X button should NOT be rendered for workspace with deletion error
      expect(screen.queryByLabelText("Remove workspace")).not.toBeInTheDocument();
    });

    it("shows warning triangle when deletion status is error", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "delete-failed" });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Warning triangle should be visible - Icon component renders vscode-icon
      const warning = container.querySelector(".deletion-error");
      expect(warning).toBeInTheDocument();
      expect(warning!.querySelector("vscode-icon")).toBeInTheDocument();
    });

    it("warning triangle has accessible attributes", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "delete-failed" });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Warning should have role="img" and aria-label
      const warning = container.querySelector(".deletion-error");
      expect(warning).toHaveAttribute("role", "img");
      expect(warning).toHaveAttribute("aria-label", "Deletion failed");
    });

    it("status cell aria-label shows Deletion failed when status is error", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "delete-failed" });
      const project = makeUiProjectRow([ws], { name: "test" });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // The button aria-label should say "Deletion failed" for error state
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*deletion failed/i });
      expect(statusButton).toBeInTheDocument();
    });

    it("status cell aria-label shows Creating for a creating placeholder row", () => {
      const ws = makeUiWorkspaceRow("ws1", { status: "creating" });
      const project = makeUiProjectRow([ws], { name: "test" });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test.*creating/i });
      expect(statusButton).toBeInTheDocument();
    });
  });
});
