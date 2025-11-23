import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  projects,
  activeWorkspace,
  activeProjectHandle,
  removeWorkspaceFromProject,
  setActiveWorkspace,
} from './projects';
import type { Project, Workspace } from '$lib/types/project';

// Helper to create mock workspace
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

// Helper to create mock project
function createMockProject(workspaces: Partial<Workspace>[] = []): Project {
  return {
    handle: 'test-handle',
    path: '/path/to/project',
    workspaces: workspaces.map((w, i) => ({
      name: w.name ?? `workspace-${i}`,
      path: w.path ?? `/path/to/workspace-${i}`,
      branch: w.branch ?? 'main',
      port: w.port ?? 8080 + i,
      url: w.url ?? `http://localhost:${8080 + i}`,
    })),
  };
}

describe('removeWorkspaceFromProject', () => {
  beforeEach(() => {
    // Reset stores to initial state
    projects.set([]);
    activeWorkspace.set(null);
    activeProjectHandle.set(null);
  });

  it('removes workspace from project workspaces array', () => {
    const project = createMockProject([
      { name: 'main', path: '/project/main' },
      { name: 'feature', path: '/project/feature' },
    ]);
    projects.set([project]);

    removeWorkspaceFromProject('test-handle', '/project/feature');

    const allProjects = get(projects);
    const updatedProject = allProjects.find((p) => p.handle === 'test-handle');
    expect(updatedProject?.workspaces).toHaveLength(1);
    expect(updatedProject?.workspaces[0].path).toBe('/project/main');
  });

  it('does not affect other projects', () => {
    const project1 = createMockProject([
      { name: 'main', path: '/project1/main' },
      { name: 'feature', path: '/project1/feature' },
    ]);
    const project2: Project = {
      handle: 'other-handle',
      path: '/path/to/other',
      workspaces: [createMockWorkspace({ name: 'other-main', path: '/project2/main' })],
    };
    projects.set([project1, project2]);

    removeWorkspaceFromProject('test-handle', '/project1/feature');

    const allProjects = get(projects);
    const otherProject = allProjects.find((p) => p.handle === 'other-handle');
    expect(otherProject?.workspaces).toHaveLength(1);
  });

  it('switches to main workspace if removed workspace was active', () => {
    const project = createMockProject([
      { name: 'main', path: '/project/main' },
      { name: 'feature', path: '/project/feature' },
    ]);
    projects.set([project]);
    setActiveWorkspace('test-handle', '/project/feature');

    // Verify feature workspace is active
    expect(get(activeWorkspace)?.workspacePath).toBe('/project/feature');

    removeWorkspaceFromProject('test-handle', '/project/feature');

    // Should switch to main workspace
    const active = get(activeWorkspace);
    expect(active?.workspacePath).toBe('/project/main');
    expect(active?.projectHandle).toBe('test-handle');
  });

  it('does not change activeWorkspace if different workspace was active', () => {
    const project = createMockProject([
      { name: 'main', path: '/project/main' },
      { name: 'feature1', path: '/project/feature1' },
      { name: 'feature2', path: '/project/feature2' },
    ]);
    projects.set([project]);
    setActiveWorkspace('test-handle', '/project/feature1');

    removeWorkspaceFromProject('test-handle', '/project/feature2');

    // Active workspace should still be feature1
    const active = get(activeWorkspace);
    expect(active?.workspacePath).toBe('/project/feature1');
  });

  it('handles removing from project that does not exist gracefully', () => {
    const project = createMockProject([{ name: 'main', path: '/project/main' }]);
    projects.set([project]);

    // Should not throw
    removeWorkspaceFromProject('nonexistent-handle', '/project/main');

    // Original project should be unchanged
    const allProjects = get(projects);
    expect(allProjects).toHaveLength(1);
    expect(allProjects[0].workspaces).toHaveLength(1);
  });
});
