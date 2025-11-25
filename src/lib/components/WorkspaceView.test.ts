import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import WorkspaceView from './WorkspaceView.svelte';
import { projects, activeWorkspace } from '$lib/stores/projects';
import { agentCounts } from '$lib/stores/agentStatus';
import type { Project, Workspace } from '$lib/types/project';

// Mock the tauri API
vi.mock('$lib/api/tauri', () => ({
  ensureCodeServerRunning: vi.fn(),
  getWorkspaceUrl: vi.fn(),
}));

import * as tauri from '$lib/api/tauri';

const mockEnsureCodeServerRunning = vi.mocked(tauri.ensureCodeServerRunning);
const mockGetWorkspaceUrl = vi.mocked(tauri.getWorkspaceUrl);

// ============================================================
// Test Constants
// ============================================================
const TEST_PROJECT_HANDLE = 'test-handle';
const TEST_PROJECT_PATH = '/path/to/project';

// Use data URLs to avoid network requests in tests
const MOCK_DATA_URL_MAIN = 'data:text/html,<html><body>Main Workspace</body></html>';
const MOCK_DATA_URL_FEATURE = 'data:text/html,<html><body>Feature Workspace</body></html>';
const MOCK_DATA_URL_NEW = 'data:text/html,<html><body>New Workspace</body></html>';

// ============================================================
// Helper Functions
// ============================================================

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: 'main',
    path: '/path/to/workspace',
    branch: 'main',
    port: 8080,
    url: MOCK_DATA_URL_MAIN,
    ...overrides,
  };
}

function createMockProject(workspaces: Workspace[]): Project {
  return {
    handle: TEST_PROJECT_HANDLE,
    path: TEST_PROJECT_PATH,
    workspaces,
  };
}

/**
 * Get the iframe container for a workspace.
 * The container holds the iframe and the initializing overlay.
 */
function getIframeContainer(iframe: HTMLElement): HTMLElement | null {
  return iframe.parentElement;
}

describe('WorkspaceView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset stores to initial state
    projects.set([]);
    activeWorkspace.set(null);
    agentCounts.set(new Map());

    // Default mock implementations - return data URLs to avoid network requests
    mockEnsureCodeServerRunning.mockResolvedValue(8080);
    mockGetWorkspaceUrl.mockImplementation(async (path) => {
      if (path.includes('main')) return MOCK_DATA_URL_MAIN;
      if (path.includes('feature')) return MOCK_DATA_URL_FEATURE;
      return MOCK_DATA_URL_NEW;
    });
  });

  afterEach(() => {
    cleanup();
  });

  // ============================================================
  // Iframe Stability Tests
  // ============================================================
  describe('Iframe stability when adding workspaces', () => {
    it('preserves existing iframe when new workspace is added to store', async () => {
      // Setup: Create a project with one workspace
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        branch: 'main',
        url: MOCK_DATA_URL_MAIN,
      });
      const project = createMockProject([mainWorkspace]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Wait for the iframe to appear
      await waitFor(() => {
        const iframe = screen.getByTitle('main - main');
        expect(iframe).toBeInTheDocument();
      });

      // Get reference to the original iframe element
      const originalIframe = screen.getByTitle('main - main');
      const originalSrc = originalIframe.getAttribute('src');

      // Simulate adding a new workspace (what createNewWorkspace does)
      const newWorkspace = createMockWorkspace({
        name: 'feature',
        path: '/path/to/feature',
        branch: 'feature',
        url: MOCK_DATA_URL_FEATURE,
      });

      // Update the store (this is what addWorkspaceToProject does)
      projects.update((p) =>
        p.map((proj) =>
          proj.handle === TEST_PROJECT_HANDLE
            ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
            : proj
        )
      );

      // Set the new workspace as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: newWorkspace.path,
      });

      // Wait for the new iframe to appear
      await waitFor(() => {
        const newIframe = screen.getByTitle('feature - feature');
        expect(newIframe).toBeInTheDocument();
      });

      // CRITICAL ASSERTION: The original iframe should still exist and have the same src
      // If src changed or iframe was recreated, this indicates a reload issue
      const mainIframeAfter = screen.getByTitle('main - main');
      expect(mainIframeAfter).toBeInTheDocument();
      expect(mainIframeAfter.getAttribute('src')).toBe(originalSrc);

      // The original iframe's container should now be hidden (not active)
      const mainContainer = getIframeContainer(mainIframeAfter);
      expect(mainContainer).toHaveClass('hidden');

      // The new iframe's container should be visible (active)
      const featureIframe = screen.getByTitle('feature - feature');
      const featureContainer = getIframeContainer(featureIframe);
      expect(featureContainer).not.toHaveClass('hidden');
    });

    it('shows iframe immediately for workspace with pre-populated URL', async () => {
      // Setup: Create a workspace with URL already set (from backend)
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        branch: 'main',
        url: MOCK_DATA_URL_MAIN,
      });
      const project = createMockProject([mainWorkspace]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // CRITICAL ASSERTION: Iframe should appear, not loading state
      // If loading state shows first, it means unnecessary network calls are being made
      await waitFor(() => {
        // Should NOT show loading state for workspace that already has URL
        expect(screen.queryByText('Starting code-server...')).not.toBeInTheDocument();
        // Should show iframe
        const iframe = screen.getByTitle('main - main');
        expect(iframe).toBeInTheDocument();
      });
    });
  });

  // ============================================================
  // Active Workspace Display Tests
  // ============================================================
  describe('Active workspace display', () => {
    it('shows active workspace iframe container as visible', async () => {
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        url: MOCK_DATA_URL_MAIN,
      });
      const featureWorkspace = createMockWorkspace({
        name: 'feature',
        path: '/path/to/feature',
        branch: 'feature',
        url: MOCK_DATA_URL_FEATURE,
      });
      const project = createMockProject([mainWorkspace, featureWorkspace]);
      projects.set([project]);

      // Set main as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      await waitFor(() => {
        const mainIframe = screen.getByTitle('main - main');
        const featureIframe = screen.getByTitle('feature - feature');

        // Main container should be visible (not hidden)
        const mainContainer = getIframeContainer(mainIframe);
        expect(mainContainer).not.toHaveClass('hidden');
        // Feature container should be hidden
        const featureContainer = getIframeContainer(featureIframe);
        expect(featureContainer).toHaveClass('hidden');
      });
    });

    it('updates visibility when activeWorkspace changes', async () => {
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        url: MOCK_DATA_URL_MAIN,
      });
      const featureWorkspace = createMockWorkspace({
        name: 'feature',
        path: '/path/to/feature',
        branch: 'feature',
        url: MOCK_DATA_URL_FEATURE,
      });
      const project = createMockProject([mainWorkspace, featureWorkspace]);
      projects.set([project]);

      // Start with main as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Verify initial state
      await waitFor(() => {
        const mainIframe = screen.getByTitle('main - main');
        const mainContainer = getIframeContainer(mainIframe);
        expect(mainContainer).not.toHaveClass('hidden');

        const featureIframe = screen.getByTitle('feature - feature');
        const featureContainer = getIframeContainer(featureIframe);
        expect(featureContainer).toHaveClass('hidden');
      });

      // Switch to feature workspace
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: featureWorkspace.path,
      });

      // CRITICAL ASSERTION: Visibility should update
      await waitFor(() => {
        const mainIframe = screen.getByTitle('main - main');
        const mainContainer = getIframeContainer(mainIframe);
        expect(mainContainer).toHaveClass('hidden');

        const featureIframe = screen.getByTitle('feature - feature');
        const featureContainer = getIframeContainer(featureIframe);
        expect(featureContainer).not.toHaveClass('hidden');
      });
    });
  });

  // ============================================================
  // New Workspace Integration Tests
  // ============================================================
  describe('New workspace integration', () => {
    it('immediately shows iframe for newly created workspace with URL', async () => {
      // Setup: Project with one workspace
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        url: MOCK_DATA_URL_MAIN,
      });
      const project = createMockProject([mainWorkspace]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Wait for initial render
      await waitFor(() => {
        expect(screen.getByTitle('main - main')).toBeInTheDocument();
      });

      // Simulate what createNewWorkspace does:
      // 1. Backend returns workspace with URL already set
      const newWorkspace = createMockWorkspace({
        name: 'new-feature',
        path: '/path/to/new-feature',
        branch: 'new-feature',
        url: MOCK_DATA_URL_NEW,
      });

      // 2. Add to store
      projects.update((p) =>
        p.map((proj) =>
          proj.handle === TEST_PROJECT_HANDLE
            ? { ...proj, workspaces: [...proj.workspaces, newWorkspace] }
            : proj
        )
      );

      // 3. Set as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: newWorkspace.path,
      });

      // CRITICAL ASSERTION: New workspace iframe should appear immediately
      // Should NOT show loading state since URL is already provided
      await waitFor(() => {
        expect(screen.queryByText('Starting code-server...')).not.toBeInTheDocument();
        const newIframe = screen.getByTitle('new-feature - new-feature');
        expect(newIframe).toBeInTheDocument();
        const container = getIframeContainer(newIframe);
        expect(container).not.toHaveClass('hidden');
      });
    });
  });

  // ============================================================
  // Workspace Initialization States Tests
  // ============================================================
  describe('Workspace initialization states', () => {
    it('shows "Starting code-server..." when state is loading', async () => {
      // Create workspace without URL - needs to fetch URL
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        branch: 'main',
        url: '', // No URL - triggers ensureWorkspaceReady
      });

      // Make the API call hang
      mockEnsureCodeServerRunning.mockImplementation(() => new Promise(() => {}));

      const project = createMockProject([mainWorkspace]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Should show loading state
      await waitFor(() => {
        expect(screen.getByText('Starting code-server...')).toBeInTheDocument();
      });
    });

    it('shows error message when state is error', async () => {
      // Create workspace without URL
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        branch: 'main',
        url: '', // No URL - triggers ensureWorkspaceReady
      });

      // Make the API call fail
      mockEnsureCodeServerRunning.mockRejectedValue(new Error('Connection refused'));

      const project = createMockProject([mainWorkspace]);
      projects.set([project]);
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Should show error state
      await waitFor(() => {
        expect(screen.getByText('Failed to start code-server')).toBeInTheDocument();
        expect(screen.getByText('Connection refused')).toBeInTheDocument();
      });
    });

    // Note: The "Initializing workspace..." overlay state is tested via the
    // workspaceInit.test.ts unit tests. Integration tests for the overlay
    // transitions require complex async/effect coordination that's difficult
    // to test in isolation. The core logic is validated by the service tests.
  });

  // ============================================================
  // Multiple Workspaces Tests
  // ============================================================
  describe('Multiple workspaces', () => {
    it('switching workspaces preserves state of previous workspace', async () => {
      const mainWorkspace = createMockWorkspace({
        name: 'main',
        path: '/path/to/main',
        url: MOCK_DATA_URL_MAIN,
      });
      const featureWorkspace = createMockWorkspace({
        name: 'feature',
        path: '/path/to/feature',
        branch: 'feature',
        url: MOCK_DATA_URL_FEATURE,
      });
      const project = createMockProject([mainWorkspace, featureWorkspace]);
      projects.set([project]);

      // Start with main as active
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      render(WorkspaceView);

      // Wait for both iframes to mount
      await waitFor(() => {
        expect(screen.getByTitle('main - main')).toBeInTheDocument();
        expect(screen.getByTitle('feature - feature')).toBeInTheDocument();
      });

      const mainIframeSrc = screen.getByTitle('main - main').getAttribute('src');

      // Switch to feature
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: featureWorkspace.path,
      });

      // Switch back to main
      activeWorkspace.set({
        projectHandle: TEST_PROJECT_HANDLE,
        workspacePath: mainWorkspace.path,
      });

      // Main should still have same src (not reloaded)
      await waitFor(() => {
        expect(screen.getByTitle('main - main').getAttribute('src')).toBe(mainIframeSrc);
      });
    });
  });
});
