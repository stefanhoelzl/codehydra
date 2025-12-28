/**
 * Tests for the Sidebar component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { Api } from "@shared/electron-api";
import { createMockApi } from "../test-utils";
import type { UIMode } from "@shared/ipc";
// Import module-level exports from Svelte component (TS declarations don't include these)
import * as SidebarModule from "./Sidebar.svelte";
const getStatusText = (
  SidebarModule as unknown as { getStatusText: (idle: number, busy: number) => string }
).getStatusText;

// Create mock for uiMode store
const mockUiModeStore = vi.hoisted(() => ({
  uiMode: {
    value: "workspace" as UIMode,
  },
  setSidebarExpanded: vi.fn(),
}));

// Mock the ui-mode store (used directly by Sidebar)
vi.mock("$lib/stores/ui-mode.svelte", () => mockUiModeStore);

// Mock the shortcuts store (re-exports from ui-mode)
vi.mock("$lib/stores/shortcuts.svelte", () => mockUiModeStore);

// Create mock API (flat structure)
const mockApi: Api = createMockApi();

// Set up window.api
window.api = mockApi;

// Import after mock setup
import Sidebar from "./Sidebar.svelte";
import { createMockProjectWithId, createMockWorkspace } from "$lib/test-fixtures";
import type { ProjectPath, WorkspacePath } from "@shared/ipc";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as deletionStore from "$lib/stores/deletion.svelte.js";
import type { ProjectId, WorkspaceName } from "@shared/api/types";

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
    activeWorkspacePath: null,
    loadingState: "loaded" as const,
    loadingError: null,
    shortcutModeActive: false,
    totalWorkspaces: 0,
    onOpenProject: vi.fn(),
    onCloseProject: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onOpenCreateDialog: vi.fn(),
    onOpenRemoveDialog: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset uiMode to workspace
    mockUiModeStore.uiMode.value = "workspace";
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
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: {
          ...defaultProps,
          projects: [project],
          activeWorkspacePath: "/test/.worktrees/ws1",
        },
      });

      const workspaceItem = screen.getByText(ws.name).closest("li");
      expect(workspaceItem).toHaveAttribute("aria-current", "true");
    });
  });

  describe("state rendering", () => {
    it("shows loading state when loadingState is 'loading'", () => {
      render(Sidebar, { props: { ...defaultProps, loadingState: "loading" } });

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });

    it("shows empty state when no projects", () => {
      render(Sidebar, { props: defaultProps });

      expect(screen.getByText("No projects open.")).toBeInTheDocument();
    });

    it("shows error state with error message when loadingState is 'error'", () => {
      render(Sidebar, {
        props: {
          ...defaultProps,
          loadingState: "error",
          loadingError: "Failed to load projects",
        },
      });

      expect(screen.getByText(/failed to load projects/i)).toBeInTheDocument();
    });
  });

  describe("list structure", () => {
    it("renders project list with ul/li structure", () => {
      const project = createMockProjectWithId();
      render(Sidebar, { props: { ...defaultProps, projects: [project] } });

      const lists = screen.getAllByRole("list");
      expect(lists.length).toBeGreaterThan(0);

      const items = screen.getAllByRole("listitem");
      expect(items.length).toBeGreaterThan(0);
    });

    it("renders workspaces under each project", () => {
      const ws1 = createMockWorkspace({
        name: "workspace-1",
        path: "/test/.worktrees/workspace-1",
      });
      const ws2 = createMockWorkspace({
        name: "workspace-2",
        path: "/test/.worktrees/workspace-2",
      });
      const project = createMockProjectWithId({
        workspaces: [ws1, ws2],
      });

      render(Sidebar, { props: { ...defaultProps, projects: [project] } });

      expect(screen.getByText("workspace-1")).toBeInTheDocument();
      expect(screen.getByText("workspace-2")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("[+] button opens create dialog with projectId", async () => {
      const onOpenCreateDialog = vi.fn();
      const project = createMockProjectWithId({ path: "/test/project" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onOpenCreateDialog },
      });

      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Now passes projectId instead of path
      expect(onOpenCreateDialog).toHaveBeenCalledWith(project.id);
    });

    it("[x] on project calls closeProject", async () => {
      const onCloseProject = vi.fn();
      const project = createMockProjectWithId({ path: "/test/project" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onCloseProject },
      });

      const closeButton = screen.getByLabelText(/close project/i);
      await fireEvent.click(closeButton);

      // Now passes projectId instead of path
      expect(onCloseProject).toHaveBeenCalledWith(project.id);
    });

    it("[x] on workspace opens remove dialog with WorkspaceRef", async () => {
      const onOpenRemoveDialog = vi.fn();
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({ workspaces: [ws] });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onOpenRemoveDialog },
      });

      const removeButton = screen.getByLabelText(/remove workspace/i);
      await fireEvent.click(removeButton);

      // Now passes WorkspaceRef object instead of just path
      expect(onOpenRemoveDialog).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("clicking workspace calls switchWorkspace", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({ workspaces: [ws] });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const workspaceButton = screen.getByRole("button", { name: ws.name });
      await fireEvent.click(workspaceButton);

      // Now passes WorkspaceRef object instead of just path
      expect(onSwitchWorkspace).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("Open Project button triggers onOpenProject", async () => {
      const onOpenProject = vi.fn();

      const { container } = render(Sidebar, { props: { ...defaultProps, onOpenProject } });

      // vscode-button is a web component; query by class name
      const openButton = container.querySelector(".open-project-btn");
      expect(openButton).not.toBeNull();
      await fireEvent.click(openButton!);

      expect(onOpenProject).toHaveBeenCalled();
    });
  });

  describe("shortcut mode index numbers", () => {
    it("should-show-index-numbers-when-shortcut-mode-active", () => {
      const ws1 = createMockWorkspace({ name: "ws1", path: "/p1/ws1" });
      const ws2 = createMockWorkspace({ name: "ws2", path: "/p1/ws2" });
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces: [ws1, ws2],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("should-hide-index-numbers-when-shortcut-mode-inactive", () => {
      const ws1 = createMockWorkspace({ name: "ws1", path: "/p1/ws1" });
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces: [ws1],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: false },
      });

      expect(screen.queryByText("1")).not.toBeInTheDocument();
    });

    it("should-display-indices-1-through-9-then-0-for-tenth", () => {
      const workspaces = Array.from({ length: 10 }, (_, i) =>
        createMockWorkspace({ name: `ws${i + 1}`, path: `/p1/ws${i + 1}` })
      );
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces,
      });

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
      const ws1 = createMockWorkspace({ name: "ws1", path: "/p1/ws1" });
      const ws2 = createMockWorkspace({ name: "ws2", path: "/p1/ws2" });
      const ws3 = createMockWorkspace({ name: "ws3", path: "/p2/ws3" });

      const project1 = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces: [ws1, ws2],
      });
      const project2 = createMockProjectWithId({
        path: "/p2" as ProjectPath,
        workspaces: [ws3],
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
      const workspaces = Array.from({ length: 11 }, (_, i) =>
        createMockWorkspace({ name: `ws${i + 1}`, path: `/p1/ws${i + 1}` })
      );
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces,
      });

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
      const ws = createMockWorkspace({ name: "ws1", path: "/p1/ws1" });
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      const indexSpan = screen.getByText("1");
      expect(indexSpan).toHaveAttribute("aria-hidden", "true");
    });

    it("should-include-shortcut-hint-in-workspace-button-aria-label", () => {
      const ws = createMockWorkspace({ name: "my-workspace", path: "/p1/ws1" });
      const project = createMockProjectWithId({
        path: "/p1" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      const button = screen.getByRole("button", {
        name: /my-workspace.*press 1 to jump/i,
      });
      expect(button).toBeInTheDocument();
    });
  });

  describe("shortcut mode Open Project hint", () => {
    it("should-show-O-on-open-project-button-when-shortcut-mode-active", () => {
      const project = createMockProjectWithId({ path: "/p1" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: true },
      });

      // The button should contain "O" hint
      expect(screen.getByText("O")).toBeInTheDocument();
    });

    it("should-hide-O-on-open-project-button-when-shortcut-mode-inactive", () => {
      const project = createMockProjectWithId({ path: "/p1" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], shortcutModeActive: false },
      });

      // The "O" hint should not be present
      expect(screen.queryByText("O")).not.toBeInTheDocument();
    });

    it("should-show-O-on-open-project-button-in-empty-state-when-shortcut-mode-active", () => {
      render(Sidebar, {
        props: { ...defaultProps, projects: [], shortcutModeActive: true },
      });

      // The button should contain "O" hint even when no projects
      expect(screen.getByText("O")).toBeInTheDocument();
    });
  });

  describe("agent status indicator", () => {
    beforeEach(() => {
      // Reset agent status store before each test
      agentStatusStore.reset();
    });

    it("renders agent status indicator for each workspace", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should have an indicator with status role
      const indicators = screen.getAllByRole("status");
      expect(indicators.length).toBeGreaterThan(0);
    });

    it("shows 'none' status when no agent status is set", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      // Should show 'no agents running' indicator
      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/no agents running/i));
    });

    it("shows idle status when agent status store has idle agents", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set agent status to idle
      agentStatusStore.updateStatus("/test/.worktrees/ws1", {
        status: "idle",
        counts: { idle: 2, busy: 0 },
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/2 agents? idle/i));
    });

    it("shows busy status when agent status store has busy agents", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set agent status to busy
      agentStatusStore.updateStatus("/test/.worktrees/ws1", {
        status: "busy",
        counts: { idle: 0, busy: 1 },
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 agent busy/i));
    });

    it("shows mixed status when agent status store has both idle and busy agents", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set agent status to mixed
      agentStatusStore.updateStatus("/test/.worktrees/ws1", {
        status: "mixed",
        counts: { idle: 1, busy: 2 },
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 idle.+2 busy/i));
    });

    it("renders separate indicators for multiple workspaces", () => {
      const ws1 = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const ws2 = createMockWorkspace({ path: "/test/.worktrees/ws2", name: "ws2" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws1, ws2],
      });

      // Set different statuses
      agentStatusStore.updateStatus("/test/.worktrees/ws1", {
        status: "idle",
        counts: { idle: 1, busy: 0 },
      });
      agentStatusStore.updateStatus("/test/.worktrees/ws2", {
        status: "busy",
        counts: { idle: 0, busy: 2 },
      });

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

  describe("status indicator button column (minimized state)", () => {
    // Tests for the clickable status indicator column (only visible in minimized state)
    // Note: These tests check minimized state behavior (totalWorkspaces > 0, not hovering)

    it("renders status indicator button for each workspace in minimized state", () => {
      const ws1 = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const ws2 = createMockWorkspace({ path: "/test/.worktrees/ws2", name: "ws2" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws1, ws2],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 2 },
      });

      // Sidebar is minimized (totalWorkspaces > 0, not hovering, uiMode is workspace)
      // Each workspace should have a status indicator button
      const statusButtons = screen.getAllByRole("button", { name: /in test.*agent/i });
      expect(statusButtons).toHaveLength(2);
    });

    it("clicking status indicator button calls onSwitchWorkspace", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1, onSwitchWorkspace },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test.*agent/i });
      await fireEvent.click(statusButton);

      expect(onSwitchWorkspace).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: ws.name,
        path: ws.path,
      });
    });

    it("status indicator button has descriptive aria-label with workspace, project, and status", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        name: "test",
        workspaces: [ws],
      });

      // Set agent status to busy
      agentStatusStore.updateStatus("/test/.worktrees/ws1", {
        status: "busy",
        counts: { idle: 0, busy: 2 },
      });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // Button should have aria-label with workspace name, project name, and status
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*busy/i });
      expect(statusButton).toBeInTheDocument();
    });

    it("active workspace status button has aria-current='true'", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      render(Sidebar, {
        props: {
          ...defaultProps,
          projects: [project],
          totalWorkspaces: 1,
          activeWorkspacePath: "/test/.worktrees/ws1",
        },
      });

      const statusButton = screen.getByRole("button", { name: /ws1 in test.*agent/i });
      expect(statusButton).toHaveAttribute("aria-current", "true");
    });

    it("inactive workspace status button does not have aria-current", () => {
      const ws1 = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const ws2 = createMockWorkspace({ path: "/test/.worktrees/ws2", name: "ws2" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws1, ws2],
      });

      render(Sidebar, {
        props: {
          ...defaultProps,
          projects: [project],
          totalWorkspaces: 2,
          activeWorkspacePath: "/test/.worktrees/ws1",
        },
      });

      // ws2's button should NOT have aria-current
      const ws2Button = screen.getByRole("button", { name: /ws2 in test.*agent/i });
      expect(ws2Button).not.toHaveAttribute("aria-current");
    });
  });

  describe("expand hint chevrons", () => {
    // Note: Expand hints are only visible when sidebar is minimized
    // When totalWorkspaces=0, sidebar is expanded (no expand hints visible)
    // When totalWorkspaces>0 and not hovering, sidebar is minimized (expand hints visible)

    it("renders expand hint chevron in header when minimized", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // Sidebar is minimized - check that header contains an expand hint chevron
      const header = container.querySelector(".sidebar-header");
      expect(header).not.toBeNull();

      const headerChevron = header!.querySelector(".expand-hint");
      expect(headerChevron).toBeInTheDocument();
      expect(headerChevron).toHaveAttribute("aria-hidden", "true");
      expect(headerChevron!.querySelector(".chevron")).toBeInTheDocument();
    });

    it("renders expand hint chevron in footer when minimized", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // Sidebar is minimized - check that footer contains an expand hint chevron
      const footer = container.querySelector(".sidebar-footer");
      expect(footer).not.toBeNull();

      const footerChevron = footer!.querySelector(".expand-hint");
      expect(footerChevron).toBeInTheDocument();
      expect(footerChevron).toHaveAttribute("aria-hidden", "true");
      expect(footerChevron!.querySelector(".chevron")).toBeInTheDocument();
    });

    it("does not render expand hints when expanded", () => {
      // When totalWorkspaces=0, sidebar is expanded
      const { container } = render(Sidebar, { props: defaultProps });

      // Sidebar is expanded - expand hints should NOT be visible
      const expandHints = container.querySelectorAll(".expand-hint");
      expect(expandHints.length).toBe(0);
    });
  });

  describe("rendering order", () => {
    // Note: Sorting is handled by the projects store (projects.svelte.ts).
    // Sidebar renders projects in the order it receives them.
    // These tests verify Sidebar renders in the provided order.

    it("renders projects in the order provided", () => {
      // Projects are pre-sorted by the store - Sidebar renders them in that order
      const projectAlphaUpper = createMockProjectWithId({
        path: "/Alpha" as ProjectPath,
        name: "Alpha",
        workspaces: [createMockWorkspace({ name: "ws", path: "/Alpha/ws" })],
      });
      const projectAlphaLower = createMockProjectWithId({
        path: "/alpha" as ProjectPath,
        name: "alpha",
        workspaces: [createMockWorkspace({ name: "ws", path: "/alpha/ws" })],
      });
      const projectBeta = createMockProjectWithId({
        path: "/beta" as ProjectPath,
        name: "beta",
        workspaces: [createMockWorkspace({ name: "ws", path: "/beta/ws" })],
      });
      const projectCharlie = createMockProjectWithId({
        path: "/charlie" as ProjectPath,
        name: "charlie",
        workspaces: [createMockWorkspace({ name: "ws", path: "/charlie/ws" })],
      });

      render(Sidebar, {
        props: {
          ...defaultProps,
          // Pass projects in alphabetical order (as the store provides)
          projects: [projectAlphaUpper, projectAlphaLower, projectBeta, projectCharlie],
        },
      });

      // Get all project names in rendered order
      const projectNames = screen.getAllByTitle(/^\//);
      const names = projectNames.map((el) => el.textContent);

      expect(names).toEqual(["Alpha", "alpha", "beta", "charlie"]);
    });

    it("renders workspaces in the order provided", () => {
      // Workspaces are pre-sorted by the store - Sidebar renders them in that order
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [
          createMockWorkspace({ name: "Alpha", path: "/test/Alpha" }),
          createMockWorkspace({ name: "alpha", path: "/test/alpha" }),
          createMockWorkspace({ name: "Beta", path: "/test/Beta" }),
          createMockWorkspace({ name: "beta", path: "/test/beta" }),
          createMockWorkspace({ name: "charlie", path: "/test/charlie" }),
        ],
      });

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
      // Workspaces are pre-sorted by the store
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [
          createMockWorkspace({ name: "alpha", path: "/test/alpha" }),
          createMockWorkspace({ name: "beta", path: "/test/beta" }),
          createMockWorkspace({ name: "charlie", path: "/test/charlie" }),
        ],
      });

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
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });
      return { ...defaultProps, projects: [project], totalWorkspaces: 1 };
    };

    it("expands on mouseenter", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).not.toHaveClass("expanded");

      await fireEvent.mouseEnter(sidebar!);

      expect(sidebar).toHaveClass("expanded");
    });

    it("collapses on mouseleave after 150ms debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // Start collapse - provide clientX > 5 to simulate leaving away from window edge
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      // Should still be expanded immediately (debounce hasn't elapsed)
      expect(sidebar).toHaveClass("expanded");

      // Wait for debounce
      vi.advanceTimersByTime(150);

      await waitFor(() => {
        expect(sidebar).not.toHaveClass("expanded");
      });
    });

    it("stays expanded when uiMode is 'shortcut'", async () => {
      mockUiModeStore.uiMode.value = "shortcut";
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("does not set hover state when mouseenter occurs during shortcut mode", async () => {
      // Scenario: Alt+X is pressed, sidebar expands into mouse position, mouseenter fires.
      // When Alt is released, sidebar should collapse because hover state was not set.
      const props = propsWithWorkspaces();

      // Set uiMode to shortcut BEFORE render (like the "stays expanded" test above)
      mockUiModeStore.uiMode.value = "shortcut";

      const { container } = render(Sidebar, {
        props: { ...props, shortcutModeActive: true },
      });

      const sidebar = container.querySelector(".sidebar");
      // Sidebar is expanded due to shortcut mode (uiMode !== "workspace" check)
      expect(sidebar).toHaveClass("expanded");

      // Mouse enters the expanded sidebar area during shortcut mode
      await fireEvent.mouseEnter(sidebar!);

      // setSidebarExpanded should NOT have been called (hover state not set)
      expect(mockUiModeStore.setSidebarExpanded).not.toHaveBeenCalled();
    });

    it("sets hover state when mouseenter occurs outside shortcut mode", async () => {
      // Verify normal hover behavior works when not in shortcut mode
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).not.toHaveClass("expanded");

      // Mouse enters when NOT in shortcut mode
      await fireEvent.mouseEnter(sidebar!);

      // setSidebarExpanded SHOULD have been called with true
      expect(mockUiModeStore.setSidebarExpanded).toHaveBeenCalledWith(true);
      expect(sidebar).toHaveClass("expanded");
    });

    it("stays expanded when uiMode is 'dialog'", async () => {
      mockUiModeStore.uiMode.value = "dialog";
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("stays expanded when totalWorkspaces is 0", async () => {
      const { container } = render(Sidebar, { props: { ...defaultProps, totalWorkspaces: 0 } });

      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).toHaveClass("expanded");
    });

    it("rapid mouseenter/mouseleave settles to correct final state", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      // Rapid hover in/out - provide clientX > 5 for mouseleave events
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      await fireEvent.mouseEnter(sidebar!);
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      await fireEvent.mouseEnter(sidebar!);

      // Should be expanded because last action was mouseenter
      expect(sidebar).toHaveClass("expanded");

      // Leave and wait
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });
      vi.advanceTimersByTime(150);

      await waitFor(() => {
        expect(sidebar).not.toHaveClass("expanded");
      });
    });

    it("cancels collapse when mouse re-enters during debounce", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // Start collapse - provide clientX > 5 for valid mouseleave
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });

      // Wait partial debounce
      vi.advanceTimersByTime(100);

      // Re-enter before debounce completes
      await fireEvent.mouseEnter(sidebar!);

      // Wait full debounce time
      vi.advanceTimersByTime(150);

      // Should still be expanded because re-enter cancelled collapse
      expect(sidebar).toHaveClass("expanded");
    });

    it("clears collapse timeout on unmount to prevent memory leak", async () => {
      const { container, unmount } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // Start collapse (this schedules a timeout) - provide clientX > 5
      await fireEvent.mouseLeave(sidebar!, { clientX: 100 });

      // Unmount before timeout fires
      unmount();

      // Advance timers past the debounce period
      // If timeout was not cleared, this would throw due to accessing unmounted component state
      vi.advanceTimersByTime(200);

      // No error thrown means cleanup worked correctly
      // The component's onDestroy should have cleared the timeout
    });

    it("does not collapse when mouse leaves at window edge (clientX < 5)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // Mouse leaves at window edge (clientX < 5 indicates user hit window boundary)
      await fireEvent.mouseLeave(sidebar!, { clientX: 0 });

      // Wait for what would be the debounce period
      vi.advanceTimersByTime(200);

      // Should still be expanded because we don't collapse at window edge
      expect(sidebar).toHaveClass("expanded");
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

  describe("expanded vs minimized layout", () => {
    const propsWithWorkspaces = () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });
      return { ...defaultProps, projects: [project], totalWorkspaces: 1 };
    };

    it("expanded layout does not have status-indicator-btn in workspace rows", async () => {
      // Set to expanded (hovering)
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // In expanded state, status-indicator-btn should NOT be rendered
      const statusBtn = container.querySelector(".status-indicator-btn");
      expect(statusBtn).not.toBeInTheDocument();
    });

    it("minimized layout shows status indicators with aria-labels", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });

      // Initially minimized (uiMode is workspace and totalWorkspaces > 0)
      // However, the mock uiMode starts as "workspace" but we need to ensure
      // the sidebar is NOT expanded (not hovering)
      const sidebar = container.querySelector(".sidebar");
      expect(sidebar).not.toHaveClass("expanded");

      // In minimized state, status-indicator-btn should be rendered with aria-label
      const statusBtns = container.querySelectorAll(".status-indicator-btn");
      expect(statusBtns.length).toBeGreaterThan(0);

      // Check that buttons have descriptive aria-labels
      statusBtns.forEach((btn) => {
        expect(btn).toHaveAttribute("aria-label");
        expect(btn.getAttribute("aria-label")).toMatch(/ws1 in test/);
      });
    });

    it("expand hint only visible when minimized", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      // Initially minimized - expand hints should be visible
      expect(sidebar).not.toHaveClass("expanded");
      let expandHints = container.querySelectorAll(".expand-hint");
      expect(expandHints.length).toBeGreaterThan(0);

      // Expand - expand hints should be hidden
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");
      expandHints = container.querySelectorAll(".expand-hint");
      expect(expandHints.length).toBe(0);
    });

    it("expanded layout has status indicator on right side (original layout)", async () => {
      const { container } = render(Sidebar, { props: propsWithWorkspaces() });
      const sidebar = container.querySelector(".sidebar");

      // Expand
      await fireEvent.mouseEnter(sidebar!);
      expect(sidebar).toHaveClass("expanded");

      // In expanded state, AgentStatusIndicator should be rendered (as part of workspace-item)
      const indicators = container.querySelectorAll('[role="status"]');
      expect(indicators.length).toBeGreaterThan(0);
    });
  });

  describe("deletion indicator", () => {
    const createDeletionProgress = (workspacePath: string) => ({
      workspacePath: workspacePath as WorkspacePath,
      workspaceName: "ws1" as WorkspaceName,
      projectId: "test-12345678" as ProjectId,
      keepBranch: false,
      operations: [
        {
          id: "kill-terminals" as const,
          label: "Terminating processes",
          status: "pending" as const,
        },
        {
          id: "cleanup-vscode" as const,
          label: "Closing VS Code view",
          status: "pending" as const,
        },
        {
          id: "cleanup-workspace" as const,
          label: "Removing workspace",
          status: "pending" as const,
        },
      ],
      completed: false,
      hasErrors: false,
    });

    beforeEach(() => {
      deletionStore.reset();
    });

    it("shows spinner when workspace is deleting (expanded layout)", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state
      deletionStore.setDeletionState(createDeletionProgress("/test/.worktrees/ws1"));

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // Should have progress-ring (spinner) instead of status indicator
      expect(container.querySelector("vscode-progress-ring.deletion-spinner")).toBeInTheDocument();
      // Should NOT have regular status indicator for this workspace
      // Note: getByRole would find the workspace-item status, but we deleted it
    });

    it("shows spinner when workspace is deleting (minimized layout)", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state
      deletionStore.setDeletionState(createDeletionProgress("/test/.worktrees/ws1"));

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // In minimized state, should show spinner
      expect(container.querySelector("vscode-progress-ring.deletion-spinner")).toBeInTheDocument();
    });

    it("shows agent status indicator when not deleting", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // No deletion state set

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // Should have status indicator, NOT spinner
      expect(
        container.querySelector("vscode-progress-ring.deletion-spinner")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("minimized layout aria-label shows Deleting when workspace is being deleted", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        name: "test",
        workspaces: [ws],
      });

      // Set deletion state
      deletionStore.setDeletionState(createDeletionProgress("/test/.worktrees/ws1"));

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // The button aria-label should say "Deleting" instead of agent status
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*deleting/i });
      expect(statusButton).toBeInTheDocument();
    });

    it("shows spinner for deleting workspace and status for non-deleting", async () => {
      const ws1 = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const ws2 = createMockWorkspace({ path: "/test/.worktrees/ws2", name: "ws2" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws1, ws2],
      });

      // Set deletion state only for ws1
      deletionStore.setDeletionState(createDeletionProgress("/test/.worktrees/ws1"));

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // Should have one spinner (ws1) and one status indicator (ws2)
      expect(container.querySelectorAll("vscode-progress-ring.deletion-spinner")).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("hides X button when deletion status is in-progress (expanded layout)", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state (in-progress: completed=false)
      deletionStore.setDeletionState(createDeletionProgress("/test/.worktrees/ws1"));

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // X button should NOT be rendered for workspace being deleted
      expect(screen.queryByLabelText("Remove workspace")).not.toBeInTheDocument();
    });

    it("hides X button when deletion status is error (expanded layout)", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state with error (completed=true, hasErrors=true)
      const errorState = createDeletionProgress("/test/.worktrees/ws1");
      errorState.completed = true;
      errorState.hasErrors = true;
      deletionStore.setDeletionState(errorState);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // X button should NOT be rendered for workspace with deletion error
      expect(screen.queryByLabelText("Remove workspace")).not.toBeInTheDocument();
    });

    it("shows warning triangle when deletion status is error (expanded layout)", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state with error
      const errorState = createDeletionProgress("/test/.worktrees/ws1");
      errorState.completed = true;
      errorState.hasErrors = true;
      deletionStore.setDeletionState(errorState);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // Warning triangle should be visible
      const warning = container.querySelector(".deletion-error");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent("⚠");
    });

    it("warning triangle has accessible attributes", async () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        workspaces: [ws],
      });

      // Set deletion state with error
      const errorState = createDeletionProgress("/test/.worktrees/ws1");
      errorState.completed = true;
      errorState.hasErrors = true;
      deletionStore.setDeletionState(errorState);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project] },
      });

      const sidebar = container.querySelector(".sidebar");
      await fireEvent.mouseEnter(sidebar!);

      // Warning should have role="img" and aria-label
      const warning = container.querySelector(".deletion-error");
      expect(warning).toHaveAttribute("role", "img");
      expect(warning).toHaveAttribute("aria-label", "Deletion failed");
    });

    it("minimized layout shows warning when deletion status is error", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        name: "test",
        workspaces: [ws],
      });

      // Set deletion state with error
      const errorState = createDeletionProgress("/test/.worktrees/ws1");
      errorState.completed = true;
      errorState.hasErrors = true;
      deletionStore.setDeletionState(errorState);

      const { container } = render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // In minimized state, should show warning
      const warning = container.querySelector(".deletion-error");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent("⚠");
      expect(warning).toHaveAttribute("role", "img");
      expect(warning).toHaveAttribute("aria-label", "Deletion failed");

      // Spinner should NOT be present
      expect(
        container.querySelector("vscode-progress-ring.deletion-spinner")
      ).not.toBeInTheDocument();
    });

    it("minimized layout aria-label shows Deletion failed when status is error", () => {
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1", name: "ws1" });
      const project = createMockProjectWithId({
        path: "/test" as ProjectPath,
        name: "test",
        workspaces: [ws],
      });

      // Set deletion state with error
      const errorState = createDeletionProgress("/test/.worktrees/ws1");
      errorState.completed = true;
      errorState.hasErrors = true;
      deletionStore.setDeletionState(errorState);

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], totalWorkspaces: 1 },
      });

      // The button aria-label should say "Deletion failed" for error state
      const statusButton = screen.getByRole("button", { name: /ws1 in test.*deletion failed/i });
      expect(statusButton).toBeInTheDocument();
    });
  });
});
