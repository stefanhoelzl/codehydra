import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import RemoveWorkspaceDialog from './RemoveWorkspaceDialog.svelte';
import type { Project, Workspace, WorkspaceStatus, RemovalResult } from '$lib/types/project';

// Mock the projectManager service
vi.mock('$lib/services/projectManager', () => ({
  checkWorkspaceStatus: vi.fn(),
  removeWorkspace: vi.fn(),
}));

import * as projectManager from '$lib/services/projectManager';

const mockCheckWorkspaceStatus = vi.mocked(projectManager.checkWorkspaceStatus);
const mockRemoveWorkspace = vi.mocked(projectManager.removeWorkspace);

// ============================================================
// Test Constants
// ============================================================
const TEST_PROJECT_HANDLE = 'test-handle';
const TEST_PROJECT_PATH = '/path/to/project';
const TEST_WORKSPACE_NAME = 'feature-branch';
const TEST_WORKSPACE_PATH = '/path/to/workspace';

// ============================================================
// Helper Functions
// ============================================================

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: TEST_WORKSPACE_NAME,
    path: TEST_WORKSPACE_PATH,
    branch: 'feature',
    port: 8080,
    url: 'http://localhost:8080',
    ...overrides,
  };
}

function createMockProject(workspaces: Workspace[] = []): Project {
  return {
    handle: TEST_PROJECT_HANDLE,
    path: TEST_PROJECT_PATH,
    workspaces:
      workspaces.length > 0
        ? workspaces
        : [
            createMockWorkspace({ name: 'main', path: '/path/to/main', branch: 'main' }),
            createMockWorkspace(),
          ],
  };
}

function createMockStatus(overrides: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return {
    hasUncommittedChanges: false,
    isMainWorktree: false,
    ...overrides,
  };
}

function createMockRemovalResult(overrides: Partial<RemovalResult> = {}): RemovalResult {
  return {
    worktreeRemoved: true,
    branchDeleted: false,
    ...overrides,
  };
}

interface RenderOptions {
  project?: Project;
  workspace?: Workspace;
  onClose?: () => void;
  onRemoved?: () => void;
  triggerElement?: HTMLElement | null;
}

function renderDialog(options: RenderOptions = {}) {
  const defaultProject = createMockProject();
  const defaultWorkspace = createMockWorkspace();

  const props = {
    project: options.project ?? defaultProject,
    workspace: options.workspace ?? defaultWorkspace,
    onClose: options.onClose ?? vi.fn(),
    onRemoved: options.onRemoved ?? vi.fn(),
    triggerElement: options.triggerElement ?? null,
  };

  return {
    ...render(RemoveWorkspaceDialog, { props }),
    props,
  };
}

/**
 * Wait for status to finish loading
 */
async function waitForStatusLoaded() {
  await waitFor(() => {
    expect(screen.queryByText('Checking workspace status...')).not.toBeInTheDocument();
  });
}

describe('RemoveWorkspaceDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default mock: clean workspace, not main
    mockCheckWorkspaceStatus.mockResolvedValue(createMockStatus());
    mockRemoveWorkspace.mockResolvedValue(createMockRemovalResult());
  });

  afterEach(() => {
    cleanup();
  });

  // ============================================================
  // Rendering and Content Tests
  // ============================================================
  describe('Rendering and content', () => {
    it('renders dialog with correct title', async () => {
      renderDialog();

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Remove Workspace')).toBeInTheDocument();
    });

    it('displays workspace name in confirmation message', async () => {
      const workspace = createMockWorkspace({ name: 'my-feature' });
      renderDialog({ workspace });

      expect(
        screen.getByText(/Are you sure you want to remove the workspace "my-feature"\?/)
      ).toBeInTheDocument();
    });

    it('renders all three buttons', async () => {
      renderDialog();
      await waitForStatusLoaded();

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Keep Branch' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });
  });

  // ============================================================
  // Status Fetching Tests
  // ============================================================
  describe('Status fetching', () => {
    it('fetches workspace status on mount', async () => {
      const project = createMockProject();
      const workspace = createMockWorkspace();
      renderDialog({ project, workspace });

      await waitForStatusLoaded();

      expect(mockCheckWorkspaceStatus).toHaveBeenCalledWith(project.handle, workspace.path);
    });

    it('shows loading state while fetching status', async () => {
      // Make status check hang
      mockCheckWorkspaceStatus.mockImplementation(() => new Promise(() => {}));

      renderDialog();

      expect(screen.getByText('Checking workspace status...')).toBeInTheDocument();
      expect(
        screen.getByRole('progressbar', { name: 'Checking workspace status' })
      ).toBeInTheDocument();
    });

    it('displays error message if status check fails', async () => {
      mockCheckWorkspaceStatus.mockRejectedValue(new Error('Network error'));

      renderDialog();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to check workspace status');
      });
    });
  });

  // ============================================================
  // Warning Display Tests
  // ============================================================
  describe('Warning display', () => {
    it('shows warning when workspace has uncommitted changes', async () => {
      mockCheckWorkspaceStatus.mockResolvedValue(createMockStatus({ hasUncommittedChanges: true }));

      renderDialog();
      await waitForStatusLoaded();

      const warning = screen.getByRole('alert');
      expect(warning).toHaveTextContent('Warning:');
      expect(warning).toHaveTextContent('uncommitted changes');
    });

    it('does not show warning when workspace is clean', async () => {
      mockCheckWorkspaceStatus.mockResolvedValue(
        createMockStatus({ hasUncommittedChanges: false })
      );

      renderDialog();
      await waitForStatusLoaded();

      expect(screen.queryByText(/uncommitted changes/)).not.toBeInTheDocument();
    });
  });

  // ============================================================
  // Button Behavior Tests
  // ============================================================
  describe('Button behaviors', () => {
    it('Cancel button closes dialog without action', async () => {
      const onClose = vi.fn();
      renderDialog({ onClose });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onClose).toHaveBeenCalled();
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });

    it('Keep Branch button calls removeWorkspace with deleteBranch=false', async () => {
      const project = createMockProject();
      const workspace = createMockWorkspace();
      renderDialog({ project, workspace });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Keep Branch' }));

      await waitFor(() => {
        expect(mockRemoveWorkspace).toHaveBeenCalledWith(project.handle, workspace.path, false);
      });
    });

    it('Delete button calls removeWorkspace with deleteBranch=true', async () => {
      const project = createMockProject();
      const workspace = createMockWorkspace();
      renderDialog({ project, workspace });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(mockRemoveWorkspace).toHaveBeenCalledWith(project.handle, workspace.path, true);
      });
    });

    it('calls onRemoved callback after successful removal', async () => {
      const onRemoved = vi.fn();
      renderDialog({ onRemoved });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Keep Branch' }));

      await waitFor(() => {
        expect(onRemoved).toHaveBeenCalled();
      });
    });
  });

  // ============================================================
  // Loading and Disabled State Tests
  // ============================================================
  describe('Loading and disabled states', () => {
    it('disables action buttons while loading status', async () => {
      // Make status check hang
      mockCheckWorkspaceStatus.mockImplementation(() => new Promise(() => {}));

      renderDialog();

      expect(screen.getByRole('button', { name: 'Keep Branch' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    });

    it('disables all buttons during removal', async () => {
      // Make remove hang
      mockRemoveWorkspace.mockImplementation(() => new Promise(() => {}));

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Keep Branch' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Keep Branch' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
      });
    });

    it('shows loading state during removal', async () => {
      // Make remove hang
      mockRemoveWorkspace.mockImplementation(() => new Promise(() => {}));

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Keep Branch' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Keep Branch' })).toHaveAttribute(
          'aria-busy',
          'true'
        );
      });
    });

    it('prevents double-click submission', async () => {
      let resolveRemove: (value: RemovalResult) => void;
      mockRemoveWorkspace.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRemove = resolve;
          })
      );

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      const keepBranchBtn = screen.getByRole('button', { name: 'Keep Branch' });

      // Click twice rapidly
      await user.click(keepBranchBtn);
      await user.click(keepBranchBtn);

      // Should only have been called once
      expect(mockRemoveWorkspace).toHaveBeenCalledTimes(1);

      // Resolve to clean up
      resolveRemove!(createMockRemovalResult());
    });
  });

  // ============================================================
  // Error Handling Tests
  // ============================================================
  describe('Error handling', () => {
    it('displays error message if removal fails', async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error('Removal failed'));

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Could not remove workspace');
      });
    });

    it('displays specific error for CannotRemoveMainWorktree', async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error('CannotRemoveMainWorktree'));

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Cannot remove main worktree');
      });
    });

    it('displays specific error for WorkspaceNotFound', async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error('WorkspaceNotFound'));

      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Workspace not found');
      });
    });
  });

  // ============================================================
  // Keyboard and Accessibility Tests
  // ============================================================
  describe('Keyboard and accessibility', () => {
    it('closes on Escape key press', async () => {
      const onClose = vi.fn();
      renderDialog({ onClose });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      // Focus an element within the dialog first
      const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
      cancelBtn.focus();
      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('triggers delete on Enter key press', async () => {
      const project = createMockProject();
      const workspace = createMockWorkspace();
      renderDialog({ project, workspace });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      // Focus an element within the dialog
      const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
      cancelBtn.focus();
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(mockRemoveWorkspace).toHaveBeenCalledWith(project.handle, workspace.path, true);
      });
    });

    it('does not trigger delete on Enter while loading status', async () => {
      // Make status check hang
      mockCheckWorkspaceStatus.mockImplementation(() => new Promise(() => {}));

      renderDialog();

      const user = userEvent.setup();
      // Try to trigger via Enter while loading
      const dialog = screen.getByRole('dialog');
      dialog.focus();
      await user.keyboard('{Enter}');

      // Should not have called removeWorkspace
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });

    it('closes when clicking outside dialog', async () => {
      const onClose = vi.fn();
      renderDialog({ onClose });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      // Click the overlay (modal-overlay class)
      const overlay = screen.getByRole('presentation');
      await user.click(overlay);

      expect(onClose).toHaveBeenCalled();
    });

    it('has correct aria attributes for accessibility', async () => {
      mockCheckWorkspaceStatus.mockResolvedValue(createMockStatus({ hasUncommittedChanges: true }));

      renderDialog();
      await waitForStatusLoaded();

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'dialog-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'warning-message');
    });

    it('does not have aria-describedby when no warning', async () => {
      mockCheckWorkspaceStatus.mockResolvedValue(
        createMockStatus({ hasUncommittedChanges: false })
      );

      renderDialog();
      await waitForStatusLoaded();

      const dialog = screen.getByRole('dialog');
      expect(dialog).not.toHaveAttribute('aria-describedby');
    });

    it('traps focus within dialog', async () => {
      renderDialog();
      await waitForStatusLoaded();

      const user = userEvent.setup();

      // Get all focusable buttons
      const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
      const deleteBtn = screen.getByRole('button', { name: 'Delete' });

      // Focus the last button
      deleteBtn.focus();
      expect(document.activeElement).toBe(deleteBtn);

      // Tab should wrap to first button
      await user.tab();
      expect(document.activeElement).toBe(cancelBtn);

      // Shift+Tab from first should wrap to last
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(deleteBtn);
    });

    it('returns focus to trigger element on close', async () => {
      const triggerElement = document.createElement('button');
      triggerElement.textContent = 'Trigger';
      document.body.appendChild(triggerElement);

      const onClose = vi.fn();
      renderDialog({ onClose, triggerElement });
      await waitForStatusLoaded();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(document.activeElement).toBe(triggerElement);

      // Cleanup
      document.body.removeChild(triggerElement);
    });
  });
});
