import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  codehydraShortcutActive,
  modalOpen,
  flatWorkspaceList,
  navigateUp,
  navigateDown,
  jumpToIndex,
  getWorkspaceIndex,
  isActiveWorkspaceMain,
  resetKeyboardNavigationState,
} from './keyboardNavigation';
import { projects, activeWorkspace, setActiveWorkspace } from './projects';
import type { Project } from '$lib/types/project';

// Helper to create test projects
function createTestProject(
  handle: string,
  workspaces: Array<{ name: string; path: string; branch?: string }>
): Project {
  return {
    handle,
    path: `/projects/${handle}`,
    workspaces: workspaces.map((w) => ({
      name: w.name,
      path: w.path,
      branch: w.branch ?? 'main',
      port: 8080,
      url: `http://localhost:8080/?folder=${w.path}`,
    })),
  };
}

describe('keyboardNavigation', () => {
  beforeEach(() => {
    // Reset all stores to initial state
    resetKeyboardNavigationState();
    projects.set([]);
    activeWorkspace.set(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('codehydraShortcutActive', () => {
    it('starts as false', () => {
      expect(get(codehydraShortcutActive)).toBe(false);
    });

    it('can be toggled on and off', () => {
      codehydraShortcutActive.set(true);
      expect(get(codehydraShortcutActive)).toBe(true);

      codehydraShortcutActive.set(false);
      expect(get(codehydraShortcutActive)).toBe(false);
    });
  });

  describe('modalOpen', () => {
    it('starts as false', () => {
      expect(get(modalOpen)).toBe(false);
    });

    it('can be toggled on and off', () => {
      modalOpen.set(true);
      expect(get(modalOpen)).toBe(true);

      modalOpen.set(false);
      expect(get(modalOpen)).toBe(false);
    });
  });

  describe('flatWorkspaceList', () => {
    it('returns empty array when no projects', () => {
      expect(get(flatWorkspaceList)).toEqual([]);
    });

    it('flattens workspaces across all projects', () => {
      const project1 = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature-a', path: '/p1/feature-a' },
      ]);
      const project2 = createTestProject('p2', [
        { name: 'main', path: '/p2/main' },
        { name: 'bugfix', path: '/p2/bugfix' },
      ]);

      projects.set([project1, project2]);

      const flat = get(flatWorkspaceList);
      expect(flat).toHaveLength(4);
      expect(flat[0].workspace.path).toBe('/p1/main');
      expect(flat[1].workspace.path).toBe('/p1/feature-a');
      expect(flat[2].workspace.path).toBe('/p2/main');
      expect(flat[3].workspace.path).toBe('/p2/bugfix');
    });

    it('updates when projects change', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project1]);
      expect(get(flatWorkspaceList)).toHaveLength(1);

      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);
      expect(get(flatWorkspaceList)).toHaveLength(2);
    });

    it('handles projects with 0 workspaces', () => {
      const emptyProject: Project = {
        handle: 'empty',
        path: '/empty',
        workspaces: [],
      };
      projects.set([emptyProject]);
      expect(get(flatWorkspaceList)).toHaveLength(0);
    });

    it('includes project handle in each entry', () => {
      const project = createTestProject('test-handle', [{ name: 'main', path: '/test/main' }]);
      projects.set([project]);

      const flat = get(flatWorkspaceList);
      expect(flat[0].projectHandle).toBe('test-handle');
    });
  });

  describe('navigateUp', () => {
    it('does nothing when no workspaces', () => {
      navigateUp();
      expect(get(activeWorkspace)).toBe(null);
    });

    it('selects previous workspace', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/feature');

      navigateUp();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });

    it('crosses project boundary', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);
      setActiveWorkspace('p2', '/p2/main');

      navigateUp();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
      expect(get(activeWorkspace)?.projectHandle).toBe('p1');
    });

    it('wraps to last workspace when at first', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      navigateUp();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/feature');
    });

    it('wraps to last workspace across projects', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);
      setActiveWorkspace('p1', '/p1/main');

      navigateUp();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p2/main');
      expect(get(activeWorkspace)?.projectHandle).toBe('p2');
    });

    it('selects first workspace if none active', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);

      navigateUp();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });
  });

  describe('navigateDown', () => {
    it('does nothing when no workspaces', () => {
      navigateDown();
      expect(get(activeWorkspace)).toBe(null);
    });

    it('selects next workspace', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/feature');
    });

    it('crosses project boundary', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);
      setActiveWorkspace('p1', '/p1/main');

      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p2/main');
      expect(get(activeWorkspace)?.projectHandle).toBe('p2');
    });

    it('wraps to first workspace when at last', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/feature');

      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });

    it('wraps to first workspace across projects', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);
      setActiveWorkspace('p2', '/p2/main');

      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
      expect(get(activeWorkspace)?.projectHandle).toBe('p1');
    });

    it('selects first workspace if none active', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);

      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });
  });

  describe('jumpToIndex', () => {
    it('selects correct workspace by index', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature-1', path: '/p1/feature-1' },
        { name: 'feature-2', path: '/p1/feature-2' },
      ]);
      projects.set([project]);

      jumpToIndex(2);
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/feature-1');
    });

    it('works for 10th workspace (index 10)', () => {
      const workspaces = Array.from({ length: 10 }, (_, i) => ({
        name: `ws-${i + 1}`,
        path: `/p1/ws-${i + 1}`,
      }));
      const project = createTestProject('p1', workspaces);
      projects.set([project]);

      jumpToIndex(10);
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/ws-10');
    });

    it('does nothing for invalid index', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      jumpToIndex(5); // Only 1 workspace
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });

    it('does nothing for index 0', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      jumpToIndex(0);
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });

    it('does nothing for negative index', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      jumpToIndex(-1);
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/main');
    });
  });

  describe('getWorkspaceIndex', () => {
    it('returns correct 1-based index', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);

      expect(getWorkspaceIndex('/p1/main')).toBe(1);
      expect(getWorkspaceIndex('/p1/feature')).toBe(2);
    });

    it('returns null for non-existent workspace', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);

      expect(getWorkspaceIndex('/nonexistent')).toBe(null);
    });

    it('indexes across projects', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [{ name: 'main', path: '/p2/main' }]);
      projects.set([project1, project2]);

      expect(getWorkspaceIndex('/p1/main')).toBe(1);
      expect(getWorkspaceIndex('/p2/main')).toBe(2);
    });
  });

  // Note: handleActionKey tests were removed because action handling
  // has moved to +layout.svelte via Tauri events. The individual
  // navigation functions (navigateUp, navigateDown, jumpToIndex) are
  // still tested above.

  describe('navigation throttling', () => {
    it('throttles rapid navigation calls', () => {
      vi.useFakeTimers();

      const project = createTestProject('p1', [
        { name: 'ws-1', path: '/p1/ws-1' },
        { name: 'ws-2', path: '/p1/ws-2' },
        { name: 'ws-3', path: '/p1/ws-3' },
        { name: 'ws-4', path: '/p1/ws-4' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/ws-1');

      // First call should work
      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/ws-2');

      // Rapid second call should be throttled
      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/ws-2'); // No change

      // After throttle period, should work again
      vi.advanceTimersByTime(100);
      navigateDown();
      expect(get(activeWorkspace)?.workspacePath).toBe('/p1/ws-3');
    });
  });

  describe('isActiveWorkspaceMain', () => {
    it('returns false when no active workspace', () => {
      expect(isActiveWorkspaceMain()).toBe(false);
    });

    it('returns false when active workspace not found in projects', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);
      setActiveWorkspace('nonexistent', '/nonexistent/main');

      expect(isActiveWorkspaceMain()).toBe(false);
    });

    it('returns true for main workspace (first in project)', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      expect(isActiveWorkspaceMain()).toBe(true);
    });

    it('returns false for additional workspaces', () => {
      const project = createTestProject('p1', [
        { name: 'main', path: '/p1/main' },
        { name: 'feature', path: '/p1/feature' },
      ]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/feature');

      expect(isActiveWorkspaceMain()).toBe(false);
    });

    it('returns true for main workspace in multi-project setup', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [
        { name: 'main', path: '/p2/main' },
        { name: 'feature', path: '/p2/feature' },
      ]);
      projects.set([project1, project2]);
      setActiveWorkspace('p2', '/p2/main');

      expect(isActiveWorkspaceMain()).toBe(true);
    });

    it('returns false for additional workspace in multi-project setup', () => {
      const project1 = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      const project2 = createTestProject('p2', [
        { name: 'main', path: '/p2/main' },
        { name: 'feature', path: '/p2/feature' },
      ]);
      projects.set([project1, project2]);
      setActiveWorkspace('p2', '/p2/feature');

      expect(isActiveWorkspaceMain()).toBe(false);
    });

    it('handles project with only one workspace', () => {
      const project = createTestProject('p1', [{ name: 'main', path: '/p1/main' }]);
      projects.set([project]);
      setActiveWorkspace('p1', '/p1/main');

      expect(isActiveWorkspaceMain()).toBe(true);
    });
  });

  // Note: Modal-open shortcut blocking is now handled in +layout.svelte
  // when listening for Tauri events (checks modalOpen before executing actions)
});
