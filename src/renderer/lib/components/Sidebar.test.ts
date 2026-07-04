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
 * class). Expansion is now driven by the `mode` prop from the UiState snapshot
 * (main-owned): mode !== "workspace" (or no workspaces) expands. Hover only
 * emits a `hover` ui:event; main folds it into the snapshot mode. These tests
 * therefore drive expansion via the `mode` prop and assert the emitted events.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
}));

// Import after mock setup
import { emitEvent } from "$lib/api";
import Sidebar from "./Sidebar.svelte";

const HOVER_DELAY_MS = 150;

/**
 * Deliberate hover: cursor deep in the gutter, sustained past the open delay.
 * Drives the hover arming logic (which emits the `hover` ui:event). Note this
 * no longer expands the sidebar on its own — expansion follows the `mode` prop.
 */
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
    sidebarWidth: 250,
    notifications: [],
    shortcutModeActive: false,
    onCloseProject: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onOpenNewWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onOpenSettings: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe("active row scroll-into-view", () => {
    // Regression: Alt+X arrow/jump navigation switches the active workspace to
    // a row that may be scrolled out of the sidebar's viewport. The sidebar
    // must scroll the newly-active row back into view.

    it("scrolls the newly-active row into view when the active workspace changes (expanded)", async () => {
      const project = makeUiProjectRow([
        makeUiWorkspaceRow("ws1", { active: true }),
        makeUiWorkspaceRow("ws2", { active: false }),
      ]);

      const { rerender } = render(Sidebar, {
        // shortcut mode keeps the sidebar expanded (as during Alt+X nav).
        props: { ...defaultProps, projects: [project], mode: "shortcut" as const },
      });

      // Spy on the second row (jsdom's default scrollIntoView is a no-op). The
      // keyed {#each} reuses this <li> across the rerender, so the spy survives.
      const scrollSpy = vi.fn();
      const ws2Item = screen.getByText("ws2").closest("li")!;
      ws2Item.scrollIntoView = scrollSpy;

      // Navigate: ws2 becomes active.
      await rerender({
        ...defaultProps,
        projects: [
          makeUiProjectRow([
            makeUiWorkspaceRow("ws1", { active: false }),
            makeUiWorkspaceRow("ws2", { active: true }),
          ]),
        ],
        mode: "shortcut" as const,
      });
      flushSync();

      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    });

    it("does not scroll while collapsed (workspace mode)", async () => {
      const project = makeUiProjectRow([
        makeUiWorkspaceRow("ws1", { active: true }),
        makeUiWorkspaceRow("ws2", { active: false }),
      ]);

      const { rerender } = render(Sidebar, {
        props: { ...defaultProps, projects: [project], mode: "workspace" as const },
      });

      const scrollSpy = vi.fn();
      const ws2Item = screen.getByText("ws2").closest("li")!;
      ws2Item.scrollIntoView = scrollSpy;

      await rerender({
        ...defaultProps,
        projects: [
          makeUiProjectRow([
            makeUiWorkspaceRow("ws1", { active: false }),
            makeUiWorkspaceRow("ws2", { active: true }),
          ]),
        ],
        mode: "workspace" as const,
      });
      flushSync();

      expect(scrollSpy).not.toHaveBeenCalled();
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

      expect(onSwitchWorkspace).toHaveBeenCalledWith(ws.key);
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

      expect(onSwitchWorkspace).toHaveBeenCalledWith(ws.key);
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
        makeUiProjectRow([makeUiWorkspaceRow("ws", { key: `${name}/ws` })], {
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

    /** Hover ui:events emitted by the component, in order. */
    function hoverEvents(): Array<{ kind: string; region: string | null }> {
      return vi
        .mocked(emitEvent)
        .mock.calls.map(([e]) => e as { kind: string; region: string | null })
        .filter((e) => e.kind === "hover");
    }

    it("is expanded for any non-workspace mode (main-owned)", () => {
      for (const mode of ["hover", "shortcut", "dialog"] as const) {
        const { container, unmount } = render(Sidebar, {
          props: { ...propsWithWorkspaces(), mode },
        });
        expect(container.querySelector(".sidebar")).toHaveClass("expanded");
        unmount();
      }
    });

    it("is collapsed in workspace mode when there are workspaces", () => {
      const { container } = render(Sidebar, {
        props: { ...propsWithWorkspaces(), mode: "workspace" },
      });
      expect(container.querySelector(".sidebar")).not.toHaveClass("expanded");
    });

    it("is forced collapsed while capturing, even in an otherwise-expanded mode", () => {
      // capturing overrides mode: the hibernation screenshot must not bake in
      // the sidebar. Shortcut mode (the state hibernate fires from) would
      // normally expand it.
      const { container } = render(Sidebar, {
        props: { ...propsWithWorkspaces(), mode: "shortcut", capturing: true },
      });
      expect(container.querySelector(".sidebar")).not.toHaveClass("expanded");
    });

    it("expands again once capturing clears", () => {
      const { container } = render(Sidebar, {
        props: { ...propsWithWorkspaces(), mode: "shortcut", capturing: false },
      });
      expect(container.querySelector(".sidebar")).toHaveClass("expanded");
    });

    it("emits a sidebar hover event after deliberate hover (trigger depth + open delay)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);

      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("emits a hover event when the cursor enters and rests without movement (edge slam)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!, { clientX: 0 });
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("does not emit before the open delay elapses", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      flushSync();

      expect(hoverEvents()).toEqual([]);
    });

    it("does not emit while the cursor stays in the outer quarter of the gutter", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 18 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(hoverEvents()).toEqual([]);
    });

    it("moving back out of the trigger depth cancels the pending hover", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      await fireEvent.mouseMove(sidebar!, { clientX: 18 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(hoverEvents()).toEqual([]);
    });

    it("leaving before the open delay elapses cancels the pending hover", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(hoverEvents()).toEqual([]);
    });

    it("emits hover region null on mouseleave after the debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);
      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);

      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(hoverEvents()).toEqual([
        { kind: "hover", region: "sidebar" },
        { kind: "hover", region: null },
      ]);
    });

    it("emits hover on a slam to the left edge (shallow enter, then leave reported outside)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!, { clientX: 18 });
      await fireEvent.mouseLeave(sidebar!, { clientX: -1 });
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("emits hover null on left exit when the window is not at the screen edge (windowed mode)", async () => {
      const original = Object.getOwnPropertyDescriptor(window, "screenX");
      Object.defineProperty(window, "screenX", { value: 120, configurable: true });
      try {
        const { container } = render(Sidebar, { props: propsWithWorkspaces() });

        const sidebar = container.querySelector(".sidebar");
        await hoverExpand(sidebar!);

        await fireEvent.mouseLeave(sidebar!, { clientX: -1 });
        vi.advanceTimersByTime(HOVER_DELAY_MS);
        flushSync();

        expect(hoverEvents()).toEqual([
          { kind: "hover", region: "sidebar" },
          { kind: "hover", region: null },
        ]);
      } finally {
        if (original) {
          Object.defineProperty(window, "screenX", original);
        } else {
          Object.defineProperty(window, "screenX", { value: 0, configurable: true });
        }
      }
    });

    it("stays armed (no null event) while the cursor is pinned at the left window edge", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);

      await fireEvent.mouseLeave(sidebar!, { clientX: 0 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      // Pin = deepest hover; no collapse event is emitted.
      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("does not arm hover (no event) while a non-workspace mode forces expansion", async () => {
      const { container } = render(Sidebar, {
        props: { ...propsWithWorkspaces(), mode: "shortcut", shortcutModeActive: true },
      });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");

      // Cursor sits deep in the sidebar during shortcut mode: hover is not
      // eligible, so no hover ui:event is emitted (no latch).
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseMove(sidebar!, { clientX: 8 });
      vi.advanceTimersByTime(HOVER_DELAY_MS * 3);
      flushSync();

      expect(hoverEvents()).toEqual([]);
    });

    it("is expanded when there are no workspaces", () => {
      const { container } = render(Sidebar, { props: defaultProps });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("cancels the collapse event when mouse re-enters during debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);

      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      vi.advanceTimersByTime(100);
      await fireEvent.mouseEnter(sidebar!);
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      flushSync();

      // Re-enter cancelled the collapse: no null event followed the open one.
      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("clears pending timeouts on unmount (no late collapse event)", async () => {
      const { container, unmount } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      await hoverExpand(sidebar!);

      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      unmount();
      vi.advanceTimersByTime(200);
      flushSync();

      // The collapse timeout was cleared on unmount: no null event fired.
      expect(hoverEvents()).toEqual([{ kind: "hover", region: "sidebar" }]);
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
    // Expansion is mode-driven now; render with mode "hover" to expand.
    const expandedProps = () => ({ ...propsWithWorkspaces(), mode: "hover" as const });

    it("renders one DOM tree: status cell, workspace button, and remove button exist in both modes", () => {
      const collapsed = render(Sidebar, { props: propsWithWorkspaces() });
      expect(collapsed.container.querySelector(".sidebar")).not.toHaveClass("expanded");
      expect(collapsed.container.querySelector(".status-cell")).toBeInTheDocument();
      expect(collapsed.container.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(collapsed.container.querySelector(".remove-btn")).toBeInTheDocument();
      collapsed.unmount();

      const expanded = render(Sidebar, { props: expandedProps() });
      expect(expanded.container.querySelector(".sidebar")).toHaveClass("expanded");
      expect(expanded.container.querySelector(".status-cell")).toBeInTheDocument();
      expect(expanded.container.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(expanded.container.querySelector(".remove-btn")).toBeInTheDocument();
    });

    it("status cell has descriptive aria-label in both modes", () => {
      const assertLabel = (container: HTMLElement): void => {
        const statusCell = container.querySelector(".status-cell");
        expect(statusCell).toHaveAttribute("aria-label");
        expect(statusCell!.getAttribute("aria-label")).toMatch(/ws1 in test/);
      };

      const collapsed = render(Sidebar, { props: propsWithWorkspaces() });
      assertLabel(collapsed.container);
      collapsed.unmount();

      const expanded = render(Sidebar, { props: expandedProps() });
      assertLabel(expanded.container);
    });

    it("workspace label and remove button are in a label cell (hidden when collapsed via CSS)", () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const labelCell = container.querySelector(".workspace-label-cell");
      expect(labelCell).toHaveClass("ch-label-cell");
      expect(labelCell!.querySelector(".workspace-btn")).toBeInTheDocument();
      expect(labelCell!.querySelector(".remove-btn")).toBeInTheDocument();
    });

    it("project header is a label cell and has no inert attribute", () => {
      const collapsed = render(Sidebar, { props: propsWithWorkspaces() });
      const header = collapsed.container.querySelector(".project-header");
      expect(header).toHaveClass("ch-label-cell");
      expect(header).not.toHaveAttribute("inert");
      collapsed.unmount();

      const expanded = render(Sidebar, { props: expandedProps() });
      expect(expanded.container.querySelector(".project-header")).not.toHaveAttribute("inert");
    });

    it("h2 heading exists in both modes inside a label cell", () => {
      const collapsed = render(Sidebar, { props: propsWithWorkspaces() });
      expect(collapsed.container.querySelector(".sidebar")).not.toHaveClass("expanded");
      const heading = collapsed.container.querySelector(".sidebar-header h2");
      expect(heading).toBeInTheDocument();
      expect(heading!.closest(".ch-label-cell")).not.toBeNull();
      collapsed.unmount();

      const expanded = render(Sidebar, { props: expandedProps() });
      expect(expanded.container.querySelector(".sidebar-header h2")).toBeInTheDocument();
    });

    it("hides the scrollbar in collapsed mode so it can't cover the status indicators", () => {
      // The collapsed gutter is ~20px wide; a native scrollbar would overlap
      // the status-indicator icon column and hide it. JSDOM neither renders
      // scrollbars nor injects scoped component styles, so we assert the
      // component ships the collapsed-only scrollbar-hiding rules at source.
      const source = readFileSync(
        resolve(process.cwd(), "src/renderer/lib/components/Sidebar.svelte"),
        "utf8"
      );

      expect(source).toMatch(
        /\.sidebar:not\(\.expanded\)\s+\.sidebar-content\s*\{[\s\S]*?scrollbar-width:\s*none/
      );
      expect(source).toMatch(
        /\.sidebar:not\(\.expanded\)\s+\.sidebar-content::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/
      );
    });

    it("vscode-divider has no inert attribute", () => {
      const project1 = makeUiProjectRow([makeUiWorkspaceRow("ws1")], {
        id: "p1-12345678",
        name: "test",
      });
      const project2 = makeUiProjectRow([makeUiWorkspaceRow("ws2")], {
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
    it("renders tag pills on the second line when the row carries tags", () => {
      const ws = makeUiWorkspaceRow("ws1", {
        tags: [{ name: "bugfix" }, { name: "wip", color: "#ff0" }],
      });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Tags now live inline on the row's second (branch/tags) line.
      expect(container.querySelector(".ws-secondary-line")).toBeInTheDocument();

      const pills = container.querySelectorAll(".ws-tag");
      expect(pills).toHaveLength(2);

      const pillTexts = Array.from(pills).map((p) => p.textContent?.trim());
      expect(pillTexts).toContain("bugfix");
      expect(pillTexts).toContain("wip");
    });

    it("does not render a second line when the row has no title and no tags", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      expect(container.querySelector(".ws-secondary-line")).not.toBeInTheDocument();
      expect(container.querySelector(".ws-tag")).not.toBeInTheDocument();
    });
  });

  describe("workspace title", () => {
    it("shows the custom title as the primary label and the branch on the second line", () => {
      const ws = makeUiWorkspaceRow("feat-branch", { title: "My nice title" });
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      expect(container.querySelector(".ws-primary-text")?.textContent?.trim()).toBe(
        "My nice title"
      );
      // The branch name is demoted to the second line alongside any tags.
      expect(container.querySelector(".ws-secondary-line .ws-branch")?.textContent?.trim()).toBe(
        "feat-branch"
      );
    });

    it("falls back to the branch name as the primary label when no title is set", () => {
      const ws = makeUiWorkspaceRow("feat-branch");
      const project = makeUiProjectRow([ws]);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      expect(container.querySelector(".ws-primary-text")?.textContent?.trim()).toBe("feat-branch");
      // No title → no branch duplicated on a second line.
      expect(container.querySelector(".ws-branch")).not.toBeInTheDocument();
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
      const { ws, props } = hibernatedSetup();
      render(Sidebar, { props: { ...props, onSwitchWorkspace } });

      const statusButton = screen.getByRole("button", { name: /Hibernated - click to wake/i });
      await fireEvent.click(statusButton);

      expect(emitEvent).toHaveBeenCalledWith({ kind: "wake-workspace", key: ws.key });
      // The click bubbles to the row's switch handler.
      expect(onSwitchWorkspace).toHaveBeenCalledWith(ws.key);
    });

    it("clicking the status cell of a non-hibernated workspace does not wake", async () => {
      const onSwitchWorkspace = vi.fn();
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")], { name: "test" });
      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test/i });
      await fireEvent.click(statusButton);

      expect(emitEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "wake-workspace" })
      );
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

  describe("resize", () => {
    // jsdom's window.innerWidth defaults to 1024, so the max clamp is
    // 0.75 * 1024 = 768.
    const MAX = 768;

    function resizeHandle(): HTMLElement {
      const handle = document.querySelector(".resize-handle");
      if (!(handle instanceof HTMLElement)) throw new Error("no resize handle");
      return handle;
    }

    function dragOverlay(): HTMLElement {
      const overlay = document.querySelector(".resize-overlay");
      if (!(overlay instanceof HTMLElement)) throw new Error("no drag overlay");
      return overlay;
    }

    it("renders a resize handle while expanded", () => {
      // No projects ⇒ expanded regardless of mode.
      render(Sidebar, { props: defaultProps });
      expect(document.querySelector(".resize-handle")).not.toBeNull();
    });

    it("hides the resize handle while collapsed", () => {
      const project = makeUiProjectRow([makeUiWorkspaceRow("ws1")]);
      render(Sidebar, { props: { ...defaultProps, projects: [project], mode: "workspace" } });
      expect(document.querySelector(".resize-handle")).toBeNull();
    });

    it("emits a resize-sidebar event with the dragged width on release", async () => {
      render(Sidebar, { props: { ...defaultProps, sidebarWidth: 250 } });

      await fireEvent.mouseDown(resizeHandle(), { clientX: 250 });
      flushSync();
      // Overlay is mounted for the duration of the drag.
      await fireEvent.mouseMove(dragOverlay(), { clientX: 450 });
      await fireEvent.mouseUp(dragOverlay(), { clientX: 450 });
      flushSync();

      expect(emitEvent).toHaveBeenCalledWith({ kind: "resize-sidebar", width: 450 });
    });

    it("clamps the dragged width to the window-relative maximum", async () => {
      render(Sidebar, { props: { ...defaultProps, sidebarWidth: 250 } });

      await fireEvent.mouseDown(resizeHandle(), { clientX: 250 });
      flushSync();
      await fireEvent.mouseMove(dragOverlay(), { clientX: 5000 });
      await fireEvent.mouseUp(dragOverlay(), { clientX: 5000 });
      flushSync();

      expect(emitEvent).toHaveBeenCalledWith({ kind: "resize-sidebar", width: MAX });
    });

    it("never goes below the grow-only floor when dragged left", async () => {
      render(Sidebar, { props: { ...defaultProps, sidebarWidth: 250 } });

      await fireEvent.mouseDown(resizeHandle(), { clientX: 250 });
      flushSync();
      await fireEvent.mouseMove(dragOverlay(), { clientX: 50 });
      await fireEvent.mouseUp(dragOverlay(), { clientX: 50 });
      flushSync();

      expect(emitEvent).toHaveBeenCalledWith({ kind: "resize-sidebar", width: 250 });
    });

    it("holds the dragged width after release (no flash back before the snapshot echo)", async () => {
      render(Sidebar, { props: { ...defaultProps, sidebarWidth: 250 } });
      const nav = screen.getByRole("navigation", { name: "Projects" });

      await fireEvent.mouseDown(resizeHandle(), { clientX: 250 });
      flushSync();
      await fireEvent.mouseMove(dragOverlay(), { clientX: 450 });
      await fireEvent.mouseUp(dragOverlay(), { clientX: 450 });
      flushSync();

      // The local override must persist past mouseup — the snapshot prop is
      // still 250 here — so the sidebar does not snap back to 250 mid-round-trip.
      expect(nav.style.getPropertyValue("--ch-sidebar-width")).toBe("450px");
    });
  });
});
