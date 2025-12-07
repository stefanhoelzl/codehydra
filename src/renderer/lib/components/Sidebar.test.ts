/**
 * Tests for the Sidebar component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { Api } from "@shared/electron-api";

// Create mock API
const mockApi: Api = {
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue([]),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  setDialogMode: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
};

// Set up window.api
window.api = mockApi;

// Import after mock setup
import Sidebar from "./Sidebar.svelte";
import { createMockProject, createMockWorkspace } from "$lib/test-fixtures";
import type { ProjectPath } from "@shared/ipc";

describe("Sidebar component", () => {
  const defaultProps = {
    projects: [],
    activeWorkspacePath: null,
    loadingState: "loaded" as const,
    loadingError: null,
    onOpenProject: vi.fn(),
    onCloseProject: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onOpenCreateDialog: vi.fn(),
    onOpenRemoveDialog: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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
      const project = createMockProject({
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
      const project = createMockProject();
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
      const project = createMockProject({
        workspaces: [ws1, ws2],
      });

      render(Sidebar, { props: { ...defaultProps, projects: [project] } });

      expect(screen.getByText("workspace-1")).toBeInTheDocument();
      expect(screen.getByText("workspace-2")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("[+] button opens create dialog with projectPath", async () => {
      const onOpenCreateDialog = vi.fn();
      const project = createMockProject({ path: "/test/project" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onOpenCreateDialog },
      });

      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      expect(onOpenCreateDialog).toHaveBeenCalledWith("/test/project", expect.any(String));
    });

    it("[x] on project calls closeProject", async () => {
      const onCloseProject = vi.fn();
      const project = createMockProject({ path: "/test/project" as ProjectPath });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onCloseProject },
      });

      const closeButton = screen.getByLabelText(/close project/i);
      await fireEvent.click(closeButton);

      expect(onCloseProject).toHaveBeenCalledWith("/test/project");
    });

    it("[x] on workspace opens remove dialog with workspacePath", async () => {
      const onOpenRemoveDialog = vi.fn();
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProject({ workspaces: [ws] });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onOpenRemoveDialog },
      });

      const removeButton = screen.getByLabelText(/remove workspace/i);
      await fireEvent.click(removeButton);

      expect(onOpenRemoveDialog).toHaveBeenCalledWith("/test/.worktrees/ws1", expect.any(String));
    });

    it("clicking workspace calls switchWorkspace", async () => {
      const onSwitchWorkspace = vi.fn();
      const ws = createMockWorkspace({ path: "/test/.worktrees/ws1" });
      const project = createMockProject({ workspaces: [ws] });

      render(Sidebar, {
        props: { ...defaultProps, projects: [project], onSwitchWorkspace },
      });

      const workspaceButton = screen.getByRole("button", { name: ws.name });
      await fireEvent.click(workspaceButton);

      expect(onSwitchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws1");
    });

    it("Open Project button triggers onOpenProject", async () => {
      const onOpenProject = vi.fn();

      render(Sidebar, { props: { ...defaultProps, onOpenProject } });

      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      expect(onOpenProject).toHaveBeenCalled();
    });
  });
});
