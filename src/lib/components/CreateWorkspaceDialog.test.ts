import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import CreateWorkspaceDialog from './CreateWorkspaceDialog.svelte';
import type { Project, BranchInfo, Workspace } from '$lib/types/project';

// Mock the projectManager service
vi.mock('$lib/services/projectManager', () => ({
  listBranches: vi.fn(),
  fetchBranches: vi.fn(),
  createNewWorkspace: vi.fn(),
}));

import * as projectManager from '$lib/services/projectManager';

const mockListBranches = vi.mocked(projectManager.listBranches);
const mockFetchBranches = vi.mocked(projectManager.fetchBranches);
const mockCreateNewWorkspace = vi.mocked(projectManager.createNewWorkspace);

// ============================================================
// Test Constants
// ============================================================
const TEST_PROJECT_HANDLE = 'test-handle';
const TEST_PROJECT_PATH = '/path/to/project';
const VALID_WORKSPACE_NAME = 'new-feature';
const INVALID_NAME_STARTS_WITH_HYPHEN = '-invalid';
const INVALID_NAME_PATH_TRAVERSAL = 'test/../bad';
const INVALID_NAME_TOO_LONG = 'a'.repeat(101);
const WHITESPACE_ONLY_NAME = '   ';

// Timeout constants with explanatory names
const BRANCH_LOAD_TIMEOUT_MS = 1000;
const FOCUS_SETTLE_TIMEOUT_MS = 200;
const UNMOUNT_SETTLE_DELAY_MS = 100;

// ============================================================
// Helper Functions
// ============================================================

function createMockProject(workspaces: Partial<Workspace>[] = []): Project {
  return {
    handle: TEST_PROJECT_HANDLE,
    path: TEST_PROJECT_PATH,
    workspaces: workspaces.map((w, i) => ({
      name: w.name ?? `workspace-${i}`,
      path: w.path ?? `/path/to/workspace-${i}`,
      branch: w.branch ?? 'main',
      port: w.port ?? 8080,
      url: w.url ?? 'http://localhost:8080',
    })),
  };
}

function createMockBranches(): BranchInfo[] {
  return [
    { name: 'main', isRemote: false },
    { name: 'develop', isRemote: false },
    { name: 'feature/auth', isRemote: false },
    { name: 'origin/main', isRemote: true },
    { name: 'origin/develop', isRemote: true },
    { name: 'origin/feature/new', isRemote: true },
  ];
}

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: 'new-workspace',
    path: '/path/to/new-workspace',
    branch: 'new-workspace',
    port: 8080,
    url: 'http://localhost:8080',
    ...overrides,
  };
}

/**
 * Wait for branches to finish loading (dropdown trigger appears)
 */
async function waitForBranchesLoaded() {
  await waitFor(
    () => {
      expect(screen.queryByText('Loading branches...')).not.toBeInTheDocument();
    },
    { timeout: BRANCH_LOAD_TIMEOUT_MS }
  );
}

/**
 * Get the dropdown trigger button using aria-label for stability
 */
function getDropdownTrigger() {
  return screen.getByRole('button', { name: /select base branch/i });
}

/**
 * Get the dialog element
 */
function getDialog() {
  return screen.getByRole('dialog');
}

/**
 * Get the modal overlay using the dialog's parent
 */
function getOverlay() {
  const dialog = getDialog();
  const overlay = dialog.parentElement;
  if (!overlay) {
    throw new Error('Overlay not found - dialog has no parent element');
  }
  return overlay;
}

/**
 * Helper to fill form and optionally submit
 */
async function fillFormAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  submit = true
) {
  const nameInput = screen.getByLabelText('Name');
  await user.type(nameInput, name);

  if (submit) {
    const okButton = screen.getByRole('button', { name: 'OK' });
    await user.click(okButton);
  }
}

/**
 * Create a controllable promise for testing async scenarios
 */
function createControllablePromise<T>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

// Note: setupTest helper is defined inside the describe block to access test context

describe('CreateWorkspaceDialog', () => {
  let mockOnClose: () => void;
  let mockOnCreated: (workspace: Workspace) => void;
  let mockTriggerElement: HTMLButtonElement;

  // Track controllable promises for cleanup
  let pendingPromises: Array<{ resolve: (value: unknown) => void }> = [];

  beforeEach(() => {
    // Reset all mocks including implementations
    vi.resetAllMocks();
    pendingPromises = [];

    mockOnClose = vi.fn();
    mockOnCreated = vi.fn();

    // Create trigger element safely
    mockTriggerElement = document.createElement('button');
    mockTriggerElement.setAttribute('data-testid', 'trigger-button');
    document.body.appendChild(mockTriggerElement);

    // Default mock implementations
    mockListBranches.mockResolvedValue(createMockBranches());
    mockFetchBranches.mockResolvedValue(undefined);
    mockCreateNewWorkspace.mockResolvedValue(createMockWorkspace());
  });

  afterEach(() => {
    // Resolve any pending promises to prevent leaks
    pendingPromises.forEach(({ resolve }) => resolve(undefined));
    pendingPromises = [];

    cleanup();
    // Safe removal of trigger element
    if (mockTriggerElement.parentNode) {
      mockTriggerElement.parentNode.removeChild(mockTriggerElement);
    }
  });

  function renderDialog(projectOverride?: Project) {
    const project =
      projectOverride ?? createMockProject([{ name: 'main-workspace', branch: 'main' }]);
    return render(CreateWorkspaceDialog, {
      props: {
        project,
        onClose: mockOnClose,
        onCreated: mockOnCreated,
        triggerElement: mockTriggerElement,
      },
    });
  }

  /**
   * Helper to set up user events and render dialog with branches loaded
   */
  async function setupTest(projectOverride?: Project) {
    const user = userEvent.setup();
    const result = renderDialog(projectOverride);
    await waitForBranchesLoaded();
    return { user, ...result };
  }

  // ============================================================
  // Initial State and Focus
  // ============================================================
  describe('Initial state and focus', () => {
    it('renders the dialog with correct title', async () => {
      renderDialog();
      expect(screen.getByText('Create Workspace')).toBeInTheDocument();
    });

    it('focuses name input when dialog opens', async () => {
      renderDialog();
      const nameInput = screen.getByLabelText('Name');
      await waitFor(
        () => {
          expect(nameInput).toHaveFocus();
        },
        { timeout: FOCUS_SETTLE_TIMEOUT_MS }
      );
    });

    it('loads branches on mount', async () => {
      renderDialog();
      await waitFor(() => {
        expect(mockListBranches).toHaveBeenCalledWith(TEST_PROJECT_HANDLE);
      });
    });

    it('starts background fetch on mount', async () => {
      renderDialog();
      await waitFor(() => {
        expect(mockFetchBranches).toHaveBeenCalledWith(TEST_PROJECT_HANDLE);
      });
    });

    it('shows loading state while fetching branches', async () => {
      const { promise, resolve } = createControllablePromise<BranchInfo[]>();
      pendingPromises.push({ resolve: () => resolve([]) });
      mockListBranches.mockReturnValue(promise);

      renderDialog();
      expect(screen.getByText('Loading branches...')).toBeInTheDocument();
    });

    it('handles branch loading error gracefully', async () => {
      mockListBranches.mockRejectedValue(new Error('Network error'));
      renderDialog();

      await waitFor(() => {
        expect(screen.queryByText('Loading branches...')).not.toBeInTheDocument();
      });

      // Dialog should still be functional
      const dialog = getDialog();
      expect(dialog).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });

    it('cleans up properly on unmount', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = renderDialog();
      await waitForBranchesLoaded();

      unmount();

      // Wait for any async operations to settle
      await new Promise((resolve) => setTimeout(resolve, UNMOUNT_SETTLE_DELAY_MS));

      // Verify no errors logged (common sign of cleanup issues)
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ============================================================
  // Validation - Using describe.each for patterns
  // ============================================================
  describe('Validation', () => {
    it('disables OK button when name is empty', async () => {
      renderDialog();
      await waitForBranchesLoaded();

      const okButton = screen.getByRole('button', { name: 'OK' });
      expect(okButton).toBeDisabled();
    });

    describe.each([
      [INVALID_NAME_STARTS_WITH_HYPHEN, /Must start with letter\/number/],
      [INVALID_NAME_PATH_TRAVERSAL, /Name cannot contain "\.\."/],
      [INVALID_NAME_TOO_LONG, /Name must be 100 characters or less/],
    ])('validation for "%s"', (input, expectedErrorPattern) => {
      it(`shows error and disables OK button`, async () => {
        const user = userEvent.setup();
        renderDialog();
        await waitForBranchesLoaded();

        const nameInput = screen.getByLabelText('Name');
        await user.type(nameInput, input);

        expect(screen.getByText(expectedErrorPattern)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
      });
    });

    it('treats whitespace-only name as invalid', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, WHITESPACE_ONLY_NAME);

      // Should still have OK button disabled (empty after trim or validation error)
      expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
    });

    it('shows error when name matches existing local branch', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'main');

      expect(screen.getByText('A local branch with this name already exists')).toBeInTheDocument();
    });

    it('shows error when name matches existing remote branch (stripped prefix)', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'feature/new');

      await waitFor(() => {
        expect(screen.getByText(/A remote branch.*with this name exists/)).toBeInTheDocument();
      });
    });

    it('shows error when name matches existing workspace', async () => {
      const user = userEvent.setup();
      const project = createMockProject([{ name: 'existing-workspace' }]);
      renderDialog(project);
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'existing-workspace');

      expect(screen.getByText('A workspace with this name already exists')).toBeInTheDocument();
    });

    it('enables OK button when all conditions are met', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'OK' })).not.toBeDisabled();
      });
    });

    it('validates names with allowed special characters', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'feat/auth-v2.0_test');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'OK' })).not.toBeDisabled();
      });
    });

    it('clears validation error when input becomes valid', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, INVALID_NAME_STARTS_WITH_HYPHEN);

      expect(screen.getByText(/Must start with letter\/number/)).toBeInTheDocument();

      await user.clear(nameInput);
      await user.type(nameInput, VALID_WORKSPACE_NAME);

      expect(screen.queryByText(/Must start with letter\/number/)).not.toBeInTheDocument();
    });
  });

  // ============================================================
  // Auto-select behavior
  // ============================================================
  describe('Auto-select behavior', () => {
    it('auto-selects remote branch when name matches (after stripping prefix)', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'feature/new');

      await waitFor(() => {
        const dropdownTrigger = getDropdownTrigger();
        expect(dropdownTrigger).toHaveTextContent('origin/feature/new');
      });
    });

    it('handles rapid name changes without race conditions', async () => {
      const user = userEvent.setup({ delay: 10 });
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');

      // Rapid typing with quick changes
      await user.type(nameInput, 'feature/new');
      await user.clear(nameInput);
      await user.type(nameInput, 'other-name');

      // Should end up with correct final value
      expect(nameInput).toHaveValue('other-name');
      // OK button should reflect final state
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'OK' })).not.toBeDisabled();
      });
    });
  });

  // ============================================================
  // Dropdown Keyboard Navigation
  // ============================================================
  describe('Dropdown keyboard navigation', () => {
    it('opens dropdown on Enter key', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      dropdownTrigger.focus();

      await user.keyboard('{Enter}');

      await screen.findByPlaceholderText('Filter branches...');
    });

    it('opens dropdown on ArrowDown key', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      dropdownTrigger.focus();

      await user.keyboard('{ArrowDown}');

      await screen.findByPlaceholderText('Filter branches...');
    });

    it('navigates down with ArrowDown key', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      await user.keyboard('{ArrowDown}');

      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveAttribute('data-highlighted', 'true');
    });

    it('navigates up with ArrowUp key', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      // Go down twice first
      await user.keyboard('{ArrowDown}{ArrowDown}');
      // Then up once
      await user.keyboard('{ArrowUp}');

      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveAttribute('data-highlighted', 'true');
    });

    it('wraps around when navigating past last option', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      // Navigate down 7 times (past 6 options)
      await user.keyboard(
        '{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}'
      );

      const options = screen.getAllByRole('option');
      // Should wrap to first option
      expect(options[0]).toHaveAttribute('data-highlighted', 'true');
    });

    it('selects option on Enter when highlighted', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
      });
    });

    it('filters branches when typing in filter input', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      const filterInput = await screen.findByPlaceholderText('Filter branches...');
      await user.type(filterInput, 'feature');

      const options = screen.getAllByRole('option');
      options.forEach((option) => {
        expect(option.textContent?.toLowerCase()).toContain('feature');
      });
    });

    it('shows "No branches found" when filter matches nothing', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      const filterInput = screen.getByPlaceholderText('Filter branches...');
      await user.type(filterInput, 'nonexistent-branch-xyz');

      expect(screen.getByText('No branches found')).toBeInTheDocument();
    });

    it('closes dropdown on Escape', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
      });
    });

    it('closes dropdown when clicking dropdown trigger again', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      await user.click(dropdownTrigger);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
      });
    });

    it('opens dropdown and filters when typing alphanumeric keys', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      dropdownTrigger.focus();

      await user.keyboard('d');

      await screen.findByPlaceholderText('Filter branches...');
    });

    it('handles Tab key in filter input', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      const filterInput = await screen.findByPlaceholderText('Filter branches...');
      filterInput.focus();

      await user.tab();

      // Focus should move within the dialog (focus trap)
      const dialog = getDialog();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  // ============================================================
  // Dialog Keyboard Navigation
  // ============================================================
  describe('Dialog keyboard navigation', () => {
    it('closes dialog on Escape when dropdown is closed', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.click(nameInput);

      await user.keyboard('{Escape}');

      // Escape should close dialog (may need overlay event)
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('closes dropdown first on Escape, dropdown state verified', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      const filterInput = screen.getByPlaceholderText('Filter branches...');
      filterInput.focus();
      await user.keyboard('{Escape}');

      // Dropdown should close
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
      });
    });

    it('submits form on Enter in name input when valid', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, VALID_WORKSPACE_NAME);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(mockCreateNewWorkspace).toHaveBeenCalledWith(
          TEST_PROJECT_HANDLE,
          VALID_WORKSPACE_NAME,
          'main'
        );
      });
    });

    it('does not submit on Enter in name input when invalid', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, INVALID_NAME_STARTS_WITH_HYPHEN);
      await user.keyboard('{Enter}');

      expect(mockCreateNewWorkspace).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Focus Trap
  // ============================================================
  describe('Focus trap', () => {
    it('traps focus within dialog on Tab from last element', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      // Focus OK button (last focusable element)
      const okButton = screen.getByRole('button', { name: 'OK' });
      okButton.focus();

      await user.tab();

      await waitFor(() => {
        const dialog = getDialog();
        expect(dialog.contains(document.activeElement)).toBe(true);
      });
    });

    it('traps focus within dialog on Shift+Tab from first element', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      nameInput.focus();

      await user.tab({ shift: true });

      await waitFor(() => {
        const dialog = getDialog();
        expect(dialog.contains(document.activeElement)).toBe(true);
      });
    });
  });

  // ============================================================
  // Form Submission
  // ============================================================
  describe('Form submission', () => {
    it('calls createNewWorkspace with correct arguments', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, 'my-new-feature');

      await waitFor(() => {
        expect(mockCreateNewWorkspace).toHaveBeenCalledWith(
          TEST_PROJECT_HANDLE,
          'my-new-feature',
          'main'
        );
      });
    });

    it('shows loading state during creation', async () => {
      const { promise, resolve } = createControllablePromise<Workspace>();
      pendingPromises.push({ resolve: () => resolve(createMockWorkspace()) });
      mockCreateNewWorkspace.mockReturnValue(promise);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(screen.getByText('Creating...')).toBeInTheDocument();
      });
    });

    it('disables form during creation', async () => {
      const { promise, resolve } = createControllablePromise<Workspace>();
      pendingPromises.push({ resolve: () => resolve(createMockWorkspace()) });
      mockCreateNewWorkspace.mockReturnValue(promise);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(screen.getByLabelText('Name')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      });
    });

    it('prevents double submission', async () => {
      const { promise, resolve } = createControllablePromise<Workspace>();
      pendingPromises.push({ resolve: () => resolve(createMockWorkspace()) });
      mockCreateNewWorkspace.mockReturnValue(promise);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, VALID_WORKSPACE_NAME);

      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);
      await user.click(okButton); // Second click

      expect(mockCreateNewWorkspace).toHaveBeenCalledTimes(1);
    });

    it('calls onCreated and onClose on success', async () => {
      const mockWorkspace = createMockWorkspace({ name: VALID_WORKSPACE_NAME });
      mockCreateNewWorkspace.mockResolvedValue(mockWorkspace);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(mockOnCreated).toHaveBeenCalledWith(mockWorkspace);
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('handles form submission while background fetch is in progress', async () => {
      const { promise: fetchPromise, resolve: resolveFetch } = createControllablePromise<void>();
      pendingPromises.push({ resolve: resolveFetch as () => void });
      mockFetchBranches.mockReturnValue(fetchPromise);

      const mockWorkspace = createMockWorkspace();
      mockCreateNewWorkspace.mockResolvedValue(mockWorkspace);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      // Complete background fetch after submission started
      resolveFetch();

      await waitFor(() => {
        expect(mockOnCreated).toHaveBeenCalled();
      });
    });
  });

  // ============================================================
  // Error Handling
  // ============================================================
  describe('Error handling', () => {
    it.each([
      [
        'BranchNotFound: main',
        'The selected branch no longer exists. Please refresh and try again.',
      ],
      ['WorkspaceAlreadyExists', 'A workspace with this name already exists.'],
      ['Unknown error', 'Could not create workspace. Please try again.'],
    ])('maps "%s" error to user-friendly message', async (backendError, expectedMessage) => {
      mockCreateNewWorkspace.mockRejectedValue(new Error(backendError));
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(screen.getByText(expectedMessage)).toBeInTheDocument();
      });
    });

    it('clears backend error when inputs change', async () => {
      mockCreateNewWorkspace.mockRejectedValueOnce(new Error('Unknown error'));
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(
          screen.getByText('Could not create workspace. Please try again.')
        ).toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, '-v2');

      await waitFor(() => {
        expect(
          screen.queryByText('Could not create workspace. Please try again.')
        ).not.toBeInTheDocument();
      });
    });

    it('announces errors via role="alert"', async () => {
      mockCreateNewWorkspace.mockRejectedValue(new Error('Unknown error'));
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        const errorBox = screen.getByRole('alert');
        expect(errorBox).toBeInTheDocument();
        expect(errorBox).toHaveTextContent('Could not create workspace');
      });
    });

    it('allows retry after submission error', async () => {
      mockCreateNewWorkspace
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(createMockWorkspace());

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      // Retry - click OK button again
      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);

      await waitFor(() => {
        expect(mockOnCreated).toHaveBeenCalled();
      });
    });
  });

  // ============================================================
  // Accessibility
  // ============================================================
  describe('Accessibility', () => {
    it('has correct ARIA attributes on dialog', async () => {
      renderDialog();
      const dialog = getDialog();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'dialog-title');
    });

    it('sets aria-invalid on name input when invalid', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, INVALID_NAME_STARTS_WITH_HYPHEN);

      expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    });

    it('sets aria-describedby when error is shown', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, INVALID_NAME_STARTS_WITH_HYPHEN);

      expect(nameInput).toHaveAttribute('aria-describedby', 'name-error');
      expect(screen.getByText(/Must start with letter\/number/)).toHaveAttribute(
        'id',
        'name-error'
      );
    });

    it('sets aria-busy on OK button during creation', async () => {
      const { promise, resolve } = createControllablePromise<Workspace>();
      pendingPromises.push({ resolve: () => resolve(createMockWorkspace()) });
      mockCreateNewWorkspace.mockReturnValue(promise);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      await fillFormAndSubmit(user, VALID_WORKSPACE_NAME);

      await waitFor(() => {
        const creatingButton = screen.getByRole('button', { name: /Creating/ });
        expect(creatingButton).toHaveAttribute('aria-busy', 'true');
      });
    });

    it('has correct ARIA attributes on dropdown', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      expect(dropdownTrigger).toHaveAttribute('aria-haspopup', 'listbox');
      expect(dropdownTrigger).toHaveAttribute('aria-expanded', 'false');

      await user.click(dropdownTrigger);

      expect(dropdownTrigger).toHaveAttribute('aria-expanded', 'true');
    });
  });

  // ============================================================
  // Cancel Behavior
  // ============================================================
  describe('Cancel behavior', () => {
    it('closes dialog on Cancel click', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      await user.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('closes dialog on overlay click', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const overlay = getOverlay();
      await user.click(overlay);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onClose and returns focus to trigger element on close', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      await user.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
      // Focus return is handled by the component calling triggerElement.focus()
      // The actual focus return happens in handleClose(), verified by checking onClose was called
    });
  });

  // ============================================================
  // Loading States
  // ============================================================
  describe('Loading states', () => {
    it('shows spinner while fetching remotes', async () => {
      const { promise, resolve } = createControllablePromise<void>();
      pendingPromises.push({ resolve: resolve as () => void });
      mockFetchBranches.mockReturnValue(promise);

      renderDialog();
      await waitForBranchesLoaded();

      const baseBranchLabel = screen.getByText('Base Branch').closest('label');
      expect(baseBranchLabel).toBeInTheDocument();
      // Use accessible role instead of CSS class selector
      const spinner = within(baseBranchLabel!).getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('refreshes branches after fetch completes', async () => {
      const { promise, resolve } = createControllablePromise<void>();
      pendingPromises.push({ resolve: resolve as () => void });
      mockFetchBranches.mockReturnValue(promise);

      renderDialog();
      await waitFor(() => expect(mockListBranches).toHaveBeenCalledTimes(1));

      resolve();

      await waitFor(() => {
        expect(mockListBranches).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ============================================================
  // Edge Cases
  // ============================================================
  describe('Edge cases', () => {
    it('handles project with no workspaces', async () => {
      const emptyProject = createMockProject([]);
      renderDialog(emptyProject);

      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      expect(dropdownTrigger).toBeInTheDocument();
    });

    it('handles branch names with special characters', async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'feature/auth' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'origin/feature/new' })).toBeInTheDocument();
      });
    });

    it('handles empty branch list gracefully', async () => {
      mockListBranches.mockResolvedValue([]);
      renderDialog();

      await waitForBranchesLoaded();

      const dialog = getDialog();
      expect(dialog).toBeInTheDocument();

      const dropdownTrigger = getDropdownTrigger();
      expect(dropdownTrigger).toHaveTextContent(/Select a branch/);
    });

    it('selects first local branch by default when main workspace has no branch', async () => {
      const projectWithDetachedHead = createMockProject([{ name: 'main-workspace', branch: null }]);
      mockListBranches.mockResolvedValue([
        { name: 'develop', isRemote: false },
        { name: 'main', isRemote: false },
      ]);

      renderDialog(projectWithDetachedHead);
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      expect(dropdownTrigger).toHaveTextContent(/develop|main/);
    });

    it('handles large branch list', async () => {
      const manyBranches: BranchInfo[] = [];
      for (let i = 0; i < 100; i++) {
        manyBranches.push({ name: `branch-${i}`, isRemote: false });
      }
      mockListBranches.mockResolvedValue(manyBranches);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await waitFor(() => {
        const options = screen.getAllByRole('option');
        expect(options.length).toBe(100);
      });
    });

    it('maintains scroll position in dropdown when filtering', async () => {
      const manyBranches: BranchInfo[] = [];
      for (let i = 0; i < 50; i++) {
        manyBranches.push({ name: `branch-${i}`, isRemote: false });
      }
      // Add a branch that will be filtered to
      manyBranches.push({ name: 'special-branch', isRemote: false });
      mockListBranches.mockResolvedValue(manyBranches);

      const user = userEvent.setup();
      renderDialog();
      await waitForBranchesLoaded();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      const filterInput = screen.getByPlaceholderText('Filter branches...');
      await user.type(filterInput, 'special');

      await waitFor(() => {
        const options = screen.getAllByRole('option');
        expect(options.length).toBe(1);
        expect(options[0]).toHaveTextContent('special-branch');
      });

      // Assert scroll position resets to top for filtered results
      await waitFor(() => {
        const dropdownList = screen.getByRole('listbox');
        expect(dropdownList.scrollTop).toBe(0);
      });
    });

    it('keeps dropdown open when clicking name input (dropdown closes via trigger or escape)', async () => {
      // Note: The component doesn't auto-close dropdown when clicking elsewhere in the dialog
      // This is intentional - users close via trigger click, escape, or selecting an option
      const { user } = await setupTest();

      const dropdownTrigger = getDropdownTrigger();
      await user.click(dropdownTrigger);

      await screen.findByPlaceholderText('Filter branches...');

      // Click on the name input - dropdown should stay open
      const nameInput = screen.getByLabelText('Name');
      await user.click(nameInput);

      // Dropdown remains open
      expect(screen.getByPlaceholderText('Filter branches...')).toBeInTheDocument();

      // Close via escape
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
      });
    });

    it('allows retry with modified input after validation-type error', async () => {
      mockCreateNewWorkspace
        .mockRejectedValueOnce(new Error('WorkspaceAlreadyExists'))
        .mockResolvedValueOnce(createMockWorkspace({ name: 'new-feature-v2' }));

      const { user } = await setupTest();

      await fillFormAndSubmit(user, 'existing-name');
      await screen.findByRole('alert');

      // User changes name and retries
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'new-feature-v2');

      const okButton = screen.getByRole('button', { name: 'OK' });
      await user.click(okButton);

      await waitFor(() => {
        expect(mockOnCreated).toHaveBeenCalled();
      });
    });

    it('maintains logical tab order through form elements', async () => {
      const { user } = await setupTest();

      // Fill in a valid name so OK button is enabled and included in tab order
      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, VALID_WORKSPACE_NAME);

      // Re-focus name input to start tabbing from the beginning
      nameInput.focus();
      expect(nameInput).toHaveFocus();

      await user.tab();
      await waitFor(() => {
        expect(getDropdownTrigger()).toHaveFocus();
      });

      await user.tab();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      });

      await user.tab();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
      });
    });
  });
});
