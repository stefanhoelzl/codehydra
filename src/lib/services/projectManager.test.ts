import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { projects, activeWorkspace, activeProjectHandle } from '$lib/stores/projects';
import {
  restorePersistedProjects,
  createNewWorkspace,
  checkWorkspaceStatus,
  removeWorkspace,
} from './projectManager';
import type { Workspace, RemovalResult, WorkspaceStatus } from '$lib/types/project';

// Get the mocked invoke function
const mockInvoke = vi.mocked(invoke);

describe('projectManager', () => {
  beforeEach(() => {
    // Reset stores to initial state
    projects.set([]);
    activeWorkspace.set(null);
    activeProjectHandle.set(null);

    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('restorePersistedProjects', () => {
    it('should NOT reset activeWorkspace if one is already set', async () => {
      // Setup: We have a project with two workspaces, and the second one is active
      const existingProject = {
        handle: 'existing-project',
        path: '/path/to/project',
        workspaces: [
          {
            name: 'main',
            path: '/path/to/project',
            branch: 'main',
            port: 3000,
            url: 'http://localhost:3000',
          },
          {
            name: 'feature',
            path: '/path/to/project/.worktrees/feature',
            branch: 'feature',
            port: 3001,
            url: 'http://localhost:3001',
          },
        ],
      };

      // Pre-populate the store with the project
      projects.set([existingProject]);
      activeProjectHandle.set('existing-project');

      // Set the SECOND workspace as active (simulating user created a new workspace)
      activeWorkspace.set({
        projectHandle: 'existing-project',
        workspacePath: '/path/to/project/.worktrees/feature',
      });

      // Mock the backend to return the same project path
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'load_persisted_projects') {
          return ['/path/to/project'];
        }
        if (cmd === 'open_project') {
          return 'existing-project';
        }
        if (cmd === 'discover_workspaces') {
          return existingProject.workspaces;
        }
        return null;
      });

      // Act: Call restorePersistedProjects (simulating what happens on hot reload)
      await restorePersistedProjects();

      // Assert: The activeWorkspace should STILL be the feature workspace, not reset to main
      const active = get(activeWorkspace);
      expect(active).not.toBeNull();
      expect(active?.workspacePath).toBe('/path/to/project/.worktrees/feature');
    });

    it('should set activeWorkspace to first workspace when none is set', async () => {
      // Setup: No active workspace set initially
      const workspace: Workspace = {
        name: 'main',
        path: '/path/to/project',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'load_persisted_projects') {
          return ['/path/to/project'];
        }
        if (cmd === 'open_project') {
          return 'project-handle';
        }
        if (cmd === 'discover_workspaces') {
          return [workspace];
        }
        return null;
      });

      // Act
      await restorePersistedProjects();

      // Assert: Should set active workspace since none was set
      const active = get(activeWorkspace);
      expect(active).not.toBeNull();
      expect(active?.workspacePath).toBe('/path/to/project');
    });

    it('should preserve activeWorkspace even when project is re-opened', async () => {
      // This simulates the exact scenario:
      // 1. User has a project open with main workspace active
      // 2. User creates a new workspace, which becomes active
      // 3. Hot reload happens (restorePersistedProjects is called again)
      // 4. The new workspace should REMAIN active

      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };

      const newWorkspace: Workspace = {
        name: 'new-feature',
        path: '/project/.worktrees/new-feature',
        branch: 'new-feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      // Initial state: project exists with both workspaces, new workspace is active
      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, newWorkspace],
        },
      ]);
      activeProjectHandle.set('proj-1');
      activeWorkspace.set({
        projectHandle: 'proj-1',
        workspacePath: newWorkspace.path,
      });

      // Mock backend - this is what happens on restore
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'load_persisted_projects') {
          return ['/project'];
        }
        if (cmd === 'open_project') {
          return 'proj-1-new'; // Note: handle might change on re-open
        }
        if (cmd === 'discover_workspaces') {
          return [mainWorkspace, newWorkspace];
        }
        return null;
      });

      // Act: Simulate hot reload
      await restorePersistedProjects();

      // Assert: The new-feature workspace should still be active
      const active = get(activeWorkspace);
      expect(active?.workspacePath).toBe('/project/.worktrees/new-feature');
    });
  });

  describe('createNewWorkspace', () => {
    it('should set new workspace as active after creation', async () => {
      // Setup: Project with main workspace, main is active
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace],
        },
      ]);
      activeProjectHandle.set('proj-1');
      activeWorkspace.set({
        projectHandle: 'proj-1',
        workspacePath: mainWorkspace.path,
      });

      const createdWorkspace: Workspace = {
        name: 'feature-x',
        path: '/project/.worktrees/feature-x',
        branch: 'feature-x',
        port: 3002,
        url: 'http://localhost:3002',
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_workspace') {
          return createdWorkspace;
        }
        return null;
      });

      // Act
      await createNewWorkspace('proj-1', 'feature-x', 'main');

      // Assert: New workspace should be active
      const active = get(activeWorkspace);
      expect(active?.workspacePath).toBe('/project/.worktrees/feature-x');

      // Assert: Workspace should be added to project
      const allProjects = get(projects);
      const project = allProjects.find((p) => p.handle === 'proj-1');
      expect(project?.workspaces).toHaveLength(2);
      expect(project?.workspaces[1].name).toBe('feature-x');
    });

    it('should keep new workspace active even if restorePersistedProjects runs after', async () => {
      // This is the key integration test for the bug
      // Setup
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace],
        },
      ]);
      activeProjectHandle.set('proj-1');
      activeWorkspace.set({
        projectHandle: 'proj-1',
        workspacePath: mainWorkspace.path,
      });

      const createdWorkspace: Workspace = {
        name: 'feature-y',
        path: '/project/.worktrees/feature-y',
        branch: 'feature-y',
        port: 3003,
        url: 'http://localhost:3003',
      };

      // Mock for createWorkspace
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_workspace') {
          return createdWorkspace;
        }
        if (cmd === 'load_persisted_projects') {
          return ['/project'];
        }
        if (cmd === 'open_project') {
          return 'proj-1';
        }
        if (cmd === 'discover_workspaces') {
          // Return current state of workspaces from the store
          const currentProjects = get(projects);
          const proj = currentProjects.find((p) => p.handle === 'proj-1');
          return proj?.workspaces ?? [mainWorkspace];
        }
        return null;
      });

      // Act 1: Create workspace
      await createNewWorkspace('proj-1', 'feature-y', 'main');

      // Verify it's active
      expect(get(activeWorkspace)?.workspacePath).toBe('/project/.worktrees/feature-y');

      // Act 2: Simulate hot reload (this is what causes the bug)
      await restorePersistedProjects();

      // Assert: New workspace should STILL be active
      const active = get(activeWorkspace);
      expect(active?.workspacePath).toBe('/project/.worktrees/feature-y');
    });
  });

  describe('checkWorkspaceStatus', () => {
    it('returns status from backend API', async () => {
      const expectedStatus: WorkspaceStatus = {
        hasUncommittedChanges: true,
        isMainWorktree: false,
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'check_workspace_status') {
          return expectedStatus;
        }
        return null;
      });

      const result = await checkWorkspaceStatus('proj-1', '/path/to/workspace');

      expect(mockInvoke).toHaveBeenCalledWith('check_workspace_status', {
        handle: 'proj-1',
        workspacePath: '/path/to/workspace',
      });
      expect(result).toEqual(expectedStatus);
    });

    it('propagates backend errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Backend error'));

      await expect(checkWorkspaceStatus('proj-1', '/path/to/workspace')).rejects.toThrow(
        'Backend error'
      );
    });
  });

  describe('removeWorkspace', () => {
    it('calls backend API with correct parameters for keep branch', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);

      const expectedResult: RemovalResult = {
        worktreeRemoved: true,
        branchDeleted: false,
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'remove_workspace') {
          return expectedResult;
        }
        return null;
      });

      const result = await removeWorkspace('proj-1', '/project/feature', false);

      expect(mockInvoke).toHaveBeenCalledWith('remove_workspace', {
        handle: 'proj-1',
        workspacePath: '/project/feature',
        deleteBranch: false,
      });
      expect(result).toEqual(expectedResult);
    });

    it('calls backend API with correct parameters for delete branch', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);

      const expectedResult: RemovalResult = {
        worktreeRemoved: true,
        branchDeleted: true,
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'remove_workspace') {
          return expectedResult;
        }
        return null;
      });

      const result = await removeWorkspace('proj-1', '/project/feature', true);

      expect(mockInvoke).toHaveBeenCalledWith('remove_workspace', {
        handle: 'proj-1',
        workspacePath: '/project/feature',
        deleteBranch: true,
      });
      expect(result).toEqual(expectedResult);
      expect(result.branchDeleted).toBe(true);
    });

    it('removes workspace from store after successful API call', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'remove_workspace') {
          return { worktreeRemoved: true, branchDeleted: false };
        }
        return null;
      });

      await removeWorkspace('proj-1', '/project/feature', false);

      const allProjects = get(projects);
      const project = allProjects.find((p) => p.handle === 'proj-1');
      expect(project?.workspaces).toHaveLength(1);
      expect(project?.workspaces[0].path).toBe('/project/main');
    });

    it('switches to main workspace if removed workspace was active', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);
      activeWorkspace.set({
        projectHandle: 'proj-1',
        workspacePath: '/project/feature',
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'remove_workspace') {
          return { worktreeRemoved: true, branchDeleted: false };
        }
        return null;
      });

      await removeWorkspace('proj-1', '/project/feature', false);

      const active = get(activeWorkspace);
      expect(active?.workspacePath).toBe('/project/main');
    });

    it('throws error and does not update store if API call fails', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);

      mockInvoke.mockRejectedValue(new Error('Backend error'));

      await expect(removeWorkspace('proj-1', '/project/feature', false)).rejects.toThrow(
        'Backend error'
      );

      // Store should not be updated
      const allProjects = get(projects);
      const project = allProjects.find((p) => p.handle === 'proj-1');
      expect(project?.workspaces).toHaveLength(2);
    });

    it('returns RemovalResult from backend', async () => {
      const mainWorkspace: Workspace = {
        name: 'main',
        path: '/project/main',
        branch: 'main',
        port: 3000,
        url: 'http://localhost:3000',
      };
      const featureWorkspace: Workspace = {
        name: 'feature',
        path: '/project/feature',
        branch: 'feature',
        port: 3001,
        url: 'http://localhost:3001',
      };

      projects.set([
        {
          handle: 'proj-1',
          path: '/project',
          workspaces: [mainWorkspace, featureWorkspace],
        },
      ]);

      const expectedResult: RemovalResult = {
        worktreeRemoved: true,
        branchDeleted: false,
      };

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'remove_workspace') {
          return expectedResult;
        }
        return null;
      });

      const result = await removeWorkspace('proj-1', '/project/feature', false);
      expect(result).toEqual(expectedResult);
    });
  });
});
