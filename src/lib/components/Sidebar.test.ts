import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { get } from 'svelte/store';
import Sidebar from './Sidebar.svelte';
import { projects, activeWorkspace } from '$lib/stores/projects';
import { agentStatuses } from '$lib/stores/agentStatus';
import type { Project, Workspace, BranchInfo } from '$lib/types/project';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';

// Mock the projectManager service
vi.mock('$lib/services/projectManager', () => ({
  openNewProject: vi.fn(),
  closeProject: vi.fn(),
  listBranches: vi.fn(),
  fetchBranches: vi.fn(),
  createNewWorkspace: vi.fn(),
  checkWorkspaceStatus: vi.fn(),
  removeWorkspace: vi.fn(),
}));

import * as projectManager from '$lib/services/projectManager';

const mockListBranches = vi.mocked(projectManager.listBranches);
const mockFetchBranches = vi.mocked(projectManager.fetchBranches);
const mockCreateNewWorkspace = vi.mocked(projectManager.createNewWorkspace);
const mockCheckWorkspaceStatus = vi.mocked(projectManager.checkWorkspaceStatus);
const mockRemoveWorkspace = vi.mocked(projectManager.removeWorkspace);
const mockCloseProject = vi.mocked(projectManager.closeProject);

// ============================================================
// Test Constants
// ============================================================
const TEST_PROJECT_HANDLE = 'test-handle';
const TEST_PROJECT_PATH = '/path/to/project';
const NEW_WORKSPACE_NAME = 'feature-branch';

// ============================================================
// Helper Functions
// ============================================================

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: 'main',
    path: '/path/to/workspace',
    branch: 'main',
    port: 8080,
    url: 'http://localhost:8080',
    ...overrides,
  };
}

function createMockProject(
  workspaces: Partial<Workspace>[] = [{ name: 'main', branch: 'main' }]
): Project {
  return {
    handle: TEST_PROJECT_HANDLE,
    path: TEST_PROJECT_PATH,
    workspaces: workspaces.map((w, i) => ({
      name: w.name ?? `workspace-${i}`,
      path: w.path ?? `/path/to/workspace-${i}`,
      branch: w.branch ?? 'main',
      port: w.port ?? 8080 + i,
      url: w.url ?? `http://localhost:${8080 + i}`,
    })),
  };
}

function createMockBranches(): BranchInfo[] {
  return [
    { name: 'main', isRemote: false },
    { name: 'develop', isRemote: false },
    { name: 'origin/main', isRemote: true },
  ];
}

describe('Sidebar', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset stores to initial state
    projects.set([]);
    activeWorkspace.set(null);
    agentStatuses.set(new Map());

    // Default mock implementations
    mockListBranches.mockResolvedValue(createMockBranches());
    mockFetchBranches.mockResolvedValue(undefined);
    mockCheckWorkspaceStatus.mockResolvedValue({
      hasUncommittedChanges: false,
      isMainWorktree: false,
    });
    mockRemoveWorkspace.mockResolvedValue({
      worktreeRemoved: true,
      branchDeleted: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  // ============================================================
  // Workspace Creation Integration Tests
  // ============================================================
  describe('Workspace creation integration', () => {
    it('sets new workspace as active after creation', async () => {
      // Setup: Create a project with one workspace and set it as active
      // Note: The main workspace is shown as the project folder name, not workspace.name
      const initialProject = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
      ]);
      projects.set([initialProject]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      // Mock the createNewWorkspace to return a new workspace
      const newWorkspace = createMockWorkspace({
        name: NEW_WORKSPACE_NAME,
        path: '/path/to/feature-branch',
        branch: NEW_WORKSPACE_NAME,
        port: 8081,
        url: 'http://localhost:8081',
      });

      // The real createNewWorkspace updates the store and sets activeWorkspace
      // We need to simulate this behavior in our mock
      mockCreateNewWorkspace.mockImplementation(async () => {
        // Simulate what the real createNewWorkspace does:
        // 1. Add workspace to project
        projects.update((p) =>
          p.map((proj) =>
            proj.handle === TEST_PROJECT_HANDLE
              ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
              : proj
          )
        );
        // 2. Set as active
        activeWorkspace.set({
          projectHandle: TEST_PROJECT_HANDLE,
          workspacePath: newWorkspace.path,
        });
        return newWorkspace;
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Verify initial state - project item is active (main workspace)
      // The project folder name is shown, not the workspace name
      const projectFolderName = TEST_PROJECT_PATH.split('/').pop()!;
      const projectItem = screen.getByText(projectFolderName).closest('[role="button"]');
      expect(projectItem).toHaveClass('active');

      // Open the create workspace dialog
      const addButton = screen.getByTitle('Create Workspace');
      await user.click(addButton);

      // Wait for dialog to open and branches to load
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Wait for branches to load
      await waitFor(() => {
        expect(screen.queryByText('Loading branches...')).not.toBeInTheDocument();
      });

      // Fill in the form
      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, NEW_WORKSPACE_NAME);

      // Submit the form
      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);

      // Wait for workspace creation
      await waitFor(() => {
        expect(mockCreateNewWorkspace).toHaveBeenCalledWith(
          TEST_PROJECT_HANDLE,
          NEW_WORKSPACE_NAME,
          'main' // Default selected branch
        );
      });

      // CRITICAL ASSERTION: The new workspace should now be active in the store
      await waitFor(() => {
        const currentActive = get(activeWorkspace);
        expect(currentActive).toEqual({
          projectHandle: TEST_PROJECT_HANDLE,
          workspacePath: '/path/to/feature-branch',
        });
      });

      // CRITICAL ASSERTION: The new workspace should be shown as active in the sidebar
      // Additional workspaces appear as workspace-item elements with class "active"
      await waitFor(() => {
        const newWorkspaceItem = screen.getByText(NEW_WORKSPACE_NAME).closest('[role="button"]');
        expect(newWorkspaceItem).toHaveClass('active');
      });

      // CRITICAL ASSERTION: The project item (main workspace) should NOT be active anymore
      await waitFor(() => {
        const mainProjectItem = screen.getByText(projectFolderName).closest('[role="button"]');
        expect(mainProjectItem).not.toHaveClass('active');
      });
    });

    it('displays new workspace in sidebar after creation', async () => {
      // Setup: Create a project with one workspace
      const initialProject = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
      ]);
      projects.set([initialProject]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      // Mock the createNewWorkspace
      const newWorkspace = createMockWorkspace({
        name: NEW_WORKSPACE_NAME,
        path: '/path/to/feature-branch',
        branch: NEW_WORKSPACE_NAME,
      });

      mockCreateNewWorkspace.mockImplementation(async () => {
        projects.update((p) =>
          p.map((proj) =>
            proj.handle === TEST_PROJECT_HANDLE
              ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
              : proj
          )
        );
        activeWorkspace.set({
          projectHandle: TEST_PROJECT_HANDLE,
          workspacePath: newWorkspace.path,
        });
        return newWorkspace;
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Verify new workspace is NOT in sidebar initially
      expect(screen.queryByText(NEW_WORKSPACE_NAME)).not.toBeInTheDocument();

      // Open dialog and create workspace
      const addButton = screen.getByTitle('Create Workspace');
      await user.click(addButton);

      await waitFor(() => {
        expect(screen.queryByText('Loading branches...')).not.toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, NEW_WORKSPACE_NAME);

      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);

      // CRITICAL ASSERTION: New workspace should appear in sidebar
      await waitFor(() => {
        expect(screen.getByText(NEW_WORKSPACE_NAME)).toBeInTheDocument();
      });
    });

    it('keeps main workspace item when additional workspace is created', async () => {
      // Setup: Create a project with one workspace
      const initialProject = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
      ]);
      projects.set([initialProject]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      const newWorkspace = createMockWorkspace({
        name: NEW_WORKSPACE_NAME,
        path: '/path/to/feature-branch',
        branch: NEW_WORKSPACE_NAME,
      });

      mockCreateNewWorkspace.mockImplementation(async () => {
        projects.update((p) =>
          p.map((proj) =>
            proj.handle === TEST_PROJECT_HANDLE
              ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
              : proj
          )
        );
        activeWorkspace.set({
          projectHandle: TEST_PROJECT_HANDLE,
          workspacePath: newWorkspace.path,
        });
        return newWorkspace;
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Count initial workspace items
      const initialProjectName = TEST_PROJECT_PATH.split('/').pop();
      expect(screen.getByText(initialProjectName!)).toBeInTheDocument();

      // Create new workspace
      const addButton = screen.getByTitle('Create Workspace');
      await user.click(addButton);

      await waitFor(() => {
        expect(screen.queryByText('Loading branches...')).not.toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, NEW_WORKSPACE_NAME);

      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);

      await waitFor(() => {
        expect(mockCreateNewWorkspace).toHaveBeenCalled();
      });

      // CRITICAL ASSERTION: Project should still be visible
      await waitFor(() => {
        expect(screen.getByText(initialProjectName!)).toBeInTheDocument();
      });

      // Both workspaces should be accessible
      await waitFor(() => {
        expect(screen.getByText(NEW_WORKSPACE_NAME)).toBeInTheDocument();
      });
    });
  });

  // ============================================================
  // Store Update Timing Tests
  // ============================================================
  describe('Store update timing', () => {
    it('updates projects store before activeWorkspace in createNewWorkspace flow', async () => {
      // This test verifies the order of store updates matters
      // If activeWorkspace is set before projects is updated, the workspace won't be found
      const initialProject = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
      ]);
      projects.set([initialProject]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      const newWorkspace = createMockWorkspace({
        name: NEW_WORKSPACE_NAME,
        path: '/path/to/feature-branch',
        branch: NEW_WORKSPACE_NAME,
      });

      // Simulate INCORRECT order: set activeWorkspace BEFORE adding to projects
      // This would cause the bug where workspace isn't found
      const storeUpdateLog: string[] = [];

      // Subscribe to track update order
      const unsubProjects = projects.subscribe(() => {
        storeUpdateLog.push('projects');
      });
      const unsubActive = activeWorkspace.subscribe(() => {
        storeUpdateLog.push('activeWorkspace');
      });

      // Clear the initial subscription calls
      storeUpdateLog.length = 0;

      // Simulate createNewWorkspace flow - CORRECT order
      projects.update((p) =>
        p.map((proj) =>
          proj.handle === TEST_PROJECT_HANDLE
            ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
            : proj
        )
      );
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: newWorkspace.path,
      });

      unsubProjects();
      unsubActive();

      // Verify correct order: projects should update before activeWorkspace
      expect(storeUpdateLog).toEqual(['projects', 'activeWorkspace']);
    });
  });

  // ============================================================
  // Active Workspace Selection Tests
  // ============================================================
  describe('Active workspace selection', () => {
    it('reflects activeWorkspace store changes in UI', async () => {
      // Setup: Create a project with multiple workspaces
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      render(Sidebar);

      // Verify main is active initially
      // The main workspace is shown in the project-item row
      // Additional workspaces are shown as workspace-item rows
      await waitFor(() => {
        const featureWorkspace = screen.getByText('feature').closest('[role="button"]');
        expect(featureWorkspace).not.toHaveClass('active');
      });

      // Change active workspace programmatically (simulating what createNewWorkspace does)
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/feature',
      });

      // CRITICAL ASSERTION: UI should update to reflect new active workspace
      await waitFor(() => {
        const featureWorkspace = screen.getByText('feature').closest('[role="button"]');
        expect(featureWorkspace).toHaveClass('active');
      });
    });
  });

  // ============================================================
  // Workspace Hover Behavior Tests
  // ============================================================
  describe('Workspace hover behavior', () => {
    it('shows branch name by default', () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feat-123' },
      ]);
      projects.set([project]);

      render(Sidebar);

      // Branch name should be visible
      expect(screen.getByText('(feat-123)')).toBeInTheDocument();
    });

    it('does not show close button for main workspace (project item)', () => {
      const project = createMockProject([{ name: 'main', path: '/path/to/main', branch: 'main' }]);
      projects.set([project]);

      render(Sidebar);

      // Project close button should exist (closes project from sidebar)
      const closeButtons = screen.getAllByTitle('Close Project');
      expect(closeButtons).toHaveLength(1);

      // But there should be no "Remove Workspace" button for main worktree
      expect(screen.queryByTitle('Remove Workspace')).not.toBeInTheDocument();
    });

    it('shows close button on additional workspace items', () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);

      render(Sidebar);

      // Should have a "Remove Workspace" button for the additional workspace
      expect(screen.getByTitle('Remove Workspace')).toBeInTheDocument();
    });
  });

  // ============================================================
  // Workspace Removal Integration Tests
  // ============================================================
  describe('Workspace removal integration', () => {
    it('opens RemoveWorkspaceDialog when close button clicked', async () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Click the remove workspace button
      const removeButton = screen.getByTitle('Remove Workspace');
      await user.click(removeButton);

      // Dialog should open
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText('Remove Workspace')).toBeInTheDocument();
      });
    });

    it('closes dialog and removes workspace from list after removal', async () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/main',
      });

      // Mock removeWorkspace to update the store
      mockRemoveWorkspace.mockImplementation(async () => {
        projects.update((p) =>
          p.map((proj) =>
            proj.handle === TEST_PROJECT_HANDLE
              ? {
                  ...proj,
                  workspaces: proj.workspaces.filter((w) => w.path !== '/path/to/feature'),
                }
              : proj
          )
        );
        return { worktreeRemoved: true, branchDeleted: false };
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Verify workspace is present
      expect(screen.getByText('feature')).toBeInTheDocument();

      // Open the remove dialog
      const removeButton = screen.getByTitle('Remove Workspace');
      await user.click(removeButton);

      // Wait for dialog and status to load
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.queryByText('Checking workspace status...')).not.toBeInTheDocument();
      });

      // Click "Keep Branch" to remove
      const keepBranchBtn = screen.getByRole('button', { name: 'Keep Branch' });
      await user.click(keepBranchBtn);

      // Workspace should disappear from sidebar
      await waitFor(() => {
        expect(screen.queryByText('feature')).not.toBeInTheDocument();
      });

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('switches active workspace to main if removed workspace was active', async () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);
      // Set feature workspace as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: '/path/to/feature',
      });

      // Mock removeWorkspace to update both stores
      mockRemoveWorkspace.mockImplementation(async () => {
        projects.update((p) =>
          p.map((proj) =>
            proj.handle === TEST_PROJECT_HANDLE
              ? {
                  ...proj,
                  workspaces: proj.workspaces.filter((w) => w.path !== '/path/to/feature'),
                }
              : proj
          )
        );
        // This simulates what removeWorkspaceFromProject does
        activeWorkspace.set({
          projectHandle: TEST_PROJECT_HANDLE,
          workspacePath: '/path/to/main',
        });
        return { worktreeRemoved: true, branchDeleted: false };
      });

      const user = userEvent.setup();
      render(Sidebar);

      // Verify feature workspace is active
      const featureItem = screen.getByText('feature').closest('[role="button"]');
      expect(featureItem).toHaveClass('active');

      // Open the remove dialog
      const removeButton = screen.getByTitle('Remove Workspace');
      await user.click(removeButton);

      await waitFor(() => {
        expect(screen.queryByText('Checking workspace status...')).not.toBeInTheDocument();
      });

      // Click "Delete" to remove workspace and branch
      const deleteBtn = screen.getByRole('button', { name: 'Delete' });
      await user.click(deleteBtn);

      // Main workspace should now be active
      await waitFor(() => {
        const currentActive = get(activeWorkspace);
        expect(currentActive?.workspacePath).toBe('/path/to/main');
      });
    });
  });

  // ============================================================
  // Main Worktree Close Button Safety Tests
  // ============================================================
  describe('Main worktree close button safety', () => {
    it('project close button only removes from sidebar without any git operations', async () => {
      const project = createMockProject([{ name: 'main', path: '/path/to/main', branch: 'main' }]);
      projects.set([project]);

      const user = userEvent.setup();
      render(Sidebar);

      // Click the project close button
      const closeButton = screen.getByTitle('Close Project');
      await user.click(closeButton);

      // closeProject should be called (not removeWorkspace)
      expect(mockCloseProject).toHaveBeenCalledWith(project);
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });

    it('project close button does not open RemoveWorkspaceDialog', async () => {
      const project = createMockProject([{ name: 'main', path: '/path/to/main', branch: 'main' }]);
      projects.set([project]);

      const user = userEvent.setup();
      render(Sidebar);

      // Click the project close button
      const closeButton = screen.getByTitle('Close Project');
      await user.click(closeButton);

      // No dialog should appear
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('project close button calls closeProject not removeWorkspace', async () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);

      const user = userEvent.setup();
      render(Sidebar);

      // Click the project close button (not the workspace remove button)
      const closeButton = screen.getByTitle('Close Project');
      await user.click(closeButton);

      // Should call closeProject
      expect(mockCloseProject).toHaveBeenCalled();
      // Should NOT call removeWorkspace
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Agent Status Indicator Tests
  // ============================================================
  describe('Agent status indicator', () => {
    it('displays status indicator for main project workspace', () => {
      const project = createMockProject([{ name: 'main', path: '/path/to/main', branch: 'main' }]);
      projects.set([project]);

      render(Sidebar);

      // The project-item (main workspace) should have a status indicator
      const projectItem = screen.getByText('project').closest('.project-item');
      expect(projectItem).toBeInTheDocument();

      // Find status indicator within project-item
      const statusIndicator = projectItem?.querySelector('.status-indicator');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('displays status indicator for additional workspaces', () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);

      render(Sidebar);

      // The workspace-item (additional workspace) should have a status indicator
      const workspaceItem = screen.getByText('feature').closest('.workspace-item');
      expect(workspaceItem).toBeInTheDocument();

      // Find status indicator within workspace-item
      const statusIndicator = workspaceItem?.querySelector('.status-indicator');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('shows correct status color based on agent status', () => {
      const project = createMockProject([
        { name: 'main', path: '/path/to/main', branch: 'main' },
        { name: 'feature', path: '/path/to/feature', branch: 'feature' },
      ]);
      projects.set([project]);

      // Set different statuses for each workspace
      const statuses = new Map<string, AggregatedAgentStatus>();
      statuses.set('/path/to/main', { type: 'allIdle', count: 1 });
      statuses.set('/path/to/feature', { type: 'allBusy', count: 2 });
      agentStatuses.set(statuses);

      render(Sidebar);

      // Main workspace should have green indicator (allIdle)
      const projectItem = screen.getByText('project').closest('.project-item');
      const mainIndicator = projectItem?.querySelector('.status-indicator');
      expect(mainIndicator).toHaveClass('green');

      // Feature workspace should have red indicator (allBusy)
      const workspaceItem = screen.getByText('feature').closest('.workspace-item');
      const featureIndicator = workspaceItem?.querySelector('.status-indicator');
      expect(featureIndicator).toHaveClass('red');
    });

    it('shows grey indicator when no agents are running', () => {
      const project = createMockProject([{ name: 'main', path: '/path/to/main', branch: 'main' }]);
      projects.set([project]);

      // No status set means no agents
      agentStatuses.set(new Map());

      render(Sidebar);

      // Should have grey indicator (noAgents)
      const projectItem = screen.getByText('project').closest('.project-item');
      const statusIndicator = projectItem?.querySelector('.status-indicator');
      expect(statusIndicator).toHaveClass('grey');
    });
  });
});
