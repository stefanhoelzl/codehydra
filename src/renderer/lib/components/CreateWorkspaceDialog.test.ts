/**
 * Tests for the CreateWorkspaceDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { ProjectId } from "@shared/api/types";

// Create mock functions with vi.hoisted - using pattern from working ProjectDropdown tests
const {
  mockCreateWorkspace,
  mockFetchBases,
  mockCloseDialog,
  mockProjectsStore,
  mockGetProjectById,
  mockSwitchWorkspace,
} = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
  mockFetchBases: vi.fn(),
  mockCloseDialog: vi.fn(),
  mockProjectsStore: vi.fn(),
  mockGetProjectById: vi.fn(),
  mockSwitchWorkspace: vi.fn(),
}));

// Mock $lib/api - using v2 API
vi.mock("$lib/api", () => ({
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue({ projects: [], activeWorkspacePath: null }),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
  // Flat API structure
  workspaces: {
    create: mockCreateWorkspace,
  },
  projects: {
    fetchBases: mockFetchBases,
  },
  ui: {
    switchWorkspace: mockSwitchWorkspace,
  },
}));

// Mock $lib/stores/projects - using hoisted mock function pattern from ProjectDropdown tests
vi.mock("$lib/stores/projects.svelte.js", () => ({
  projects: {
    get value() {
      return mockProjectsStore();
    },
  },
  getProjectById: mockGetProjectById,
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  closeDialog: mockCloseDialog,
}));

// Import component after mocks
import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
import { workspaces } from "$lib/api";

// Test project IDs
const testProjectId = "test-project-12345678" as ProjectId;
const otherProjectId = "other-project-87654321" as ProjectId;

/**
 * Helper to get the name input (vscode-textfield).
 * Since vscode-textfield is a web component, getByLabelText doesn't work.
 * We query by ID instead.
 */
function getNameInput(): HTMLElement {
  const input = document.getElementById("workspace-name");
  if (!input) throw new Error("Name input not found");
  return input;
}

/**
 * Helper to get the project dropdown input.
 */
function getProjectDropdown(): HTMLElement {
  const dropdown = document.querySelector(".project-dropdown") as HTMLElement;
  if (!dropdown) throw new Error("Project dropdown not found");
  // Return the input inside the dropdown
  const input = dropdown.querySelector('input[role="combobox"]') as HTMLElement;
  if (!input) throw new Error("Project dropdown input not found");
  return input;
}

/**
 * Helper to get the branch dropdown input.
 * Since there are now two comboboxes (project and branch), we need to be more specific.
 */
function getBranchDropdown(): HTMLElement {
  const branchDropdown = document.querySelector(
    '.branch-dropdown input[role="combobox"]'
  ) as HTMLElement;
  if (!branchDropdown) throw new Error("Branch dropdown not found");
  return branchDropdown;
}

describe("CreateWorkspaceDialog component", () => {
  // Projects are defined in the mock factory:
  // - test-project (path: /test/project) with workspace "existing"
  // - other-project (path: /test/other-project) with workspace "ws1"

  const defaultProps = {
    open: true,
    projectId: testProjectId,
  };

  // Projects data used by tests (now with IDs)
  const mockProjectsList = [
    {
      id: testProjectId,
      path: "/test/project",
      name: "test-project",
      workspaces: [
        { path: "/test/project/.worktrees/existing", name: "existing", branch: "existing" },
      ],
    },
    {
      id: otherProjectId,
      path: "/test/other-project",
      name: "other-project",
      workspaces: [{ path: "/test/other-project/.worktrees/ws1", name: "ws1", branch: "main" }],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Setup projects store mock with both projects
    mockProjectsStore.mockReturnValue(mockProjectsList);
    // Setup getProjectById to return project when called
    mockGetProjectById.mockImplementation((id: ProjectId) =>
      mockProjectsList.find((p) => p.id === id)
    );
    // v2 API returns { bases: [...] }
    mockFetchBases.mockResolvedValue({
      bases: [
        { name: "main", isRemote: false },
        { name: "develop", isRemote: false },
      ],
    });
    // Return a workspace object with the name that was passed in
    mockCreateWorkspace.mockImplementation(async (_projectId, name) => ({
      name,
      path: `/test/project/.worktrees/${name}`,
      branch: name,
      projectId: _projectId,
    }));
    mockSwitchWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("structure", () => {
    it("uses Dialog base component", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("renders project dropdown, name input, and branch dropdown", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(getProjectDropdown()).toBeInTheDocument();
      expect(getNameInput()).toBeInTheDocument();
      expect(getBranchDropdown()).toBeInTheDocument();
    });

    it("renders project dropdown above name input in DOM order", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const projectDropdown = getProjectDropdown();
      const nameInput = getNameInput();

      // Check DOM order via compareDocumentPosition
      // DOCUMENT_POSITION_FOLLOWING (4) means nameInput comes after projectDropdown
      const position = projectDropdown.compareDocumentPosition(nameInput);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("name input has aria-describedby for errors", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      expect(nameInput).toHaveAttribute("aria-describedby");
    });

    it("focuses name input when dialog opens (not project dropdown)", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      const projectDropdown = getProjectDropdown();

      expect(nameInput).toHaveFocus();
      expect(projectDropdown).not.toHaveFocus();
    });
  });

  describe("project dropdown", () => {
    it("shows projectPath prop value as default selection", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const projectDropdown = getProjectDropdown() as HTMLInputElement;
      // Should show the project name, not the path
      expect(projectDropdown.value).toBe("test-project");
    });

    it("displays all open projects in dropdown", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const projectDropdown = getProjectDropdown();
      await fireEvent.focus(projectDropdown);

      // Clear the filter to show all options (debounce would otherwise filter to current value)
      await fireEvent.input(projectDropdown, { target: { value: "" } });
      await vi.runAllTimersAsync();

      // Both projects should be shown in the dropdown
      expect(screen.getByText("test-project")).toBeInTheDocument();
      expect(screen.getByText("other-project")).toBeInTheDocument();

      // Verify we have exactly 2 project options
      const projectListbox = document.getElementById("project-dropdown-listbox");
      const options = projectListbox?.querySelectorAll('[role="option"]') ?? [];
      expect(options.length).toBe(2);
    });

    it("form submits with selected project using keyboard", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Navigate to a different project using keyboard (if multiple are available)
      const projectDropdown = getProjectDropdown();
      await fireEvent.focus(projectDropdown);
      await fireEvent.keyDown(projectDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(projectDropdown, { key: "ArrowDown" }); // Try to select second option
      await fireEvent.keyDown(projectDropdown, { key: "Enter" });

      // Fill name
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "new-ws" } });

      // Select branch
      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Submit
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);
      await vi.runAllTimersAsync();

      // Should have called workspaces.create (project ID depends on what was selected)
      expect(workspaces.create).toHaveBeenCalled();
    });

    it("validation checks selected project's workspaces", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Enter a name that exists in the default project (test-project)
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "existing" } });
      await fireEvent.blur(nameInput);

      // Should show duplicate error since "existing" exists in test-project
      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("validation uses selected project for duplicate check", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Enter a name that exists in test-project (original prop project)
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "existing" } });
      await fireEvent.blur(nameInput);

      // Should show error for original project
      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();

      // Clear the name and enter a name that doesn't exist
      await fireEvent.input(nameInput, { target: { value: "new-workspace" } });
      await fireEvent.blur(nameInput);

      // Error should be gone since "new-workspace" doesn't exist
      expect(screen.queryByText(/workspace already exists/i)).not.toBeInTheDocument();
    });
  });

  describe("validation", () => {
    it('empty name shows error "Name is required"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    });

    it('name with / shows error "Name cannot contain /"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "feature/branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \//i)).toBeInTheDocument();
    });

    it('name with \\ shows error "Name cannot contain \\"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "feature\\branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \\/i)).toBeInTheDocument();
    });

    it('name with .. shows error "Name cannot contain .."', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "feature..branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \.\./i)).toBeInTheDocument();
    });

    it("name > 100 chars shows error", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      const longName = "a".repeat(101);
      await fireEvent.input(nameInput, { target: { value: longName } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/100 characters or less/i)).toBeInTheDocument();
    });

    it('duplicate name shows error "Workspace already exists"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "existing" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("duplicate name is case-insensitive", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "EXISTING" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("valid name clears error", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();

      // First enter invalid name
      await fireEvent.input(nameInput, { target: { value: "" } });
      await fireEvent.blur(nameInput);
      expect(screen.queryByText(/name is required/i)).toBeInTheDocument();

      // Then enter valid name
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });
      await fireEvent.blur(nameInput);
      expect(screen.queryByText(/name is required/i)).not.toBeInTheDocument();
    });

    it("name with dash and underscore is valid", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature_branch" } });
      await fireEvent.blur(nameInput);

      // Should not show any validation error (error helper only rendered when there's an error)
      expect(screen.queryByText(/name is required/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/name cannot contain/i)).not.toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("Escape closes dialog", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it("Enter on name input submits form when valid", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid name
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      // Select a branch
      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Press Enter on name input
      await fireEvent.keyDown(nameInput, { key: "Enter" });
      await vi.runAllTimersAsync();

      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        defaultProps.projectId,
        "valid-name",
        expect.any(String)
      );
    });

    it("Enter on name input does not submit when form invalid", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Leave name empty, just press Enter
      const nameInput = getNameInput();
      await fireEvent.keyDown(nameInput, { key: "Enter" });
      await vi.runAllTimersAsync();

      expect(mockCreateWorkspace).not.toHaveBeenCalled();
    });

    it("Enter on name input does not submit while already submitting", async () => {
      // Delay the API response to keep form in submitting state
      mockCreateWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Submit via Enter
      await fireEvent.keyDown(nameInput, { key: "Enter" });

      // Try to submit again via Enter while still submitting
      await fireEvent.keyDown(nameInput, { key: "Enter" });

      // Should only have been called once
      expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();
    });
  });

  describe("submit flow", () => {
    it("OK disabled until form valid", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|create/i });
      expect(okButton).toBeDisabled();
    });

    it("OK enabled when form is valid", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      // Select a branch
      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      const okButton = screen.getByRole("button", { name: /ok|create/i });
      expect(okButton).not.toBeDisabled();
    });

    it("OK shows spinner during submit", async () => {
      // Delay the API response
      mockCreateWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      // Should show submitting state in the button
      expect(screen.getByRole("button", { name: /creating/i })).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("all inputs disabled during submit", async () => {
      mockCreateWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      // Inputs should be disabled
      expect(nameInput).toBeDisabled();
      expect(branchDropdown).toBeDisabled();

      await vi.runAllTimersAsync();
    });

    it('aria-busy="true" during submit', async () => {
      mockCreateWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-busy", "true");

      await vi.runAllTimersAsync();
    });

    it("api.createWorkspace called with correct params", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(workspaces.create).toHaveBeenCalledWith(testProjectId, "my-feature", "main");
    });

    it("success switches to new workspace and closes dialog", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      // Should switch to the newly created workspace
      expect(mockSwitchWorkspace).toHaveBeenCalledWith(testProjectId, "my-feature");
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("branch dropdown integration", () => {
    // Integration test verifying the branch dropdown works correctly within the dialog context.
    // This tests the mousedown selection pattern that prevents blur-before-click timing issues.
    it("branch dropdown click selection works within dialog", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);

      // Use mouseDown to select (matches the actual handler pattern)
      const option = screen.getByText("develop");
      await fireEvent.mouseDown(option);

      // Verify selection occurred - the input should now show the selected value
      expect((branchDropdown as HTMLInputElement).value).toBe("develop");

      // Verify dropdown closed after selection
      expect(branchDropdown).toHaveAttribute("aria-expanded", "false");
    });

    it("branch dropdown is visible and not clipped by dialog overflow", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);

      // There are two listboxes now (project and branch), find the branch one
      const listboxes = screen.getAllByRole("listbox");
      const branchListbox = listboxes.find((lb) => lb.id.includes("branch-dropdown"));
      expect(branchListbox).toBeDefined();

      // Verify it has inline positioning styles (indicating position: fixed is being used)
      expect(branchListbox!.style.top).toBeTruthy();
      expect(branchListbox!.style.left).toBeTruthy();
      expect(branchListbox!.style.width).toBeTruthy();

      // Verify the CSS class is applied (which contains position: fixed)
      // After refactoring, BranchDropdown uses FilterableDropdown which uses "dropdown-listbox"
      expect(branchListbox!.classList.contains("dropdown-listbox")).toBe(true);
    });
  });

  describe("project change behavior", () => {
    /**
     * Helper to select a project by name using mouseDown (the actual handler pattern).
     * Uses mouseDown because FilterableDropdown uses mousedown to prevent blur-before-click.
     * Searches within the project dropdown's listbox only.
     *
     * IMPORTANT: This clears the filter first because FilterableDropdown uses debounced
     * filtering. When runAllTimersAsync() is called, the debounce fires and filters
     * options to match the current input value. Clearing the input shows all options.
     */
    async function selectProjectByName(projectName: string): Promise<void> {
      const projectDropdown = getProjectDropdown();
      await fireEvent.focus(projectDropdown);

      // Clear the filter to show all options (debounce would otherwise filter to current value)
      await fireEvent.input(projectDropdown, { target: { value: "" } });
      await vi.runAllTimersAsync();

      // Find the project dropdown's listbox (not the branch dropdown's)
      const projectListbox = document.getElementById("project-dropdown-listbox");
      if (!projectListbox) throw new Error("Project listbox not found");

      // Find the option within the project listbox - use mouseDown per the dropdown pattern
      const options = projectListbox.querySelectorAll('[role="option"]');
      const option = Array.from(options).find(
        (opt) => opt.textContent?.trim() === projectName
      ) as HTMLElement;
      if (!option) {
        throw new Error(
          `Option "${projectName}" not found. Available: ${Array.from(options)
            .map((o) => o.textContent?.trim())
            .join(", ")}`
        );
      }

      await fireEvent.mouseDown(option);
      await vi.runAllTimersAsync();
    }

    it("changing project clears branch selection", async () => {
      // Setup mock to return different branches per project ID
      mockFetchBases.mockImplementation((projectId: ProjectId) => {
        if (projectId === testProjectId) {
          return Promise.resolve({
            bases: [
              { name: "main", isRemote: false },
              { name: "develop", isRemote: false },
            ],
          });
        } else {
          return Promise.resolve({
            bases: [
              { name: "feature-branch", isRemote: false },
              { name: "release", isRemote: false },
            ],
          });
        }
      });

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Select a branch in the default project
      let branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Verify branch is selected
      expect((branchDropdown as HTMLInputElement).value).toBe("main");

      // Now change to a different project using mouseDown
      await selectProjectByName("other-project");

      // Re-query the branch dropdown (component was remounted after project change)
      branchDropdown = getBranchDropdown();

      // Branch selection should be cleared
      expect((branchDropdown as HTMLInputElement).value).toBe("");
    });

    it("branch dropdown shows new project's branches after project change", async () => {
      // Setup mock to return different branches per project ID
      mockFetchBases.mockImplementation((projectId: ProjectId) => {
        if (projectId === testProjectId) {
          return Promise.resolve({
            bases: [
              { name: "main", isRemote: false },
              { name: "develop", isRemote: false },
            ],
          });
        } else {
          return Promise.resolve({
            bases: [
              { name: "feature-branch", isRemote: false },
              { name: "release", isRemote: false },
            ],
          });
        }
      });

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Initial branches should be from test-project
      let branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("develop")).toBeInTheDocument();

      // Close dropdown
      await fireEvent.keyDown(branchDropdown, { key: "Escape" });

      // Change to other-project using mouseDown
      await selectProjectByName("other-project");

      // Re-query the branch dropdown (component was remounted after project change)
      branchDropdown = getBranchDropdown();

      // Open branch dropdown again - should show new project's branches
      await fireEvent.focus(branchDropdown);
      await vi.runAllTimersAsync();

      expect(screen.getByText("feature-branch")).toBeInTheDocument();
      expect(screen.getByText("release")).toBeInTheDocument();
    });

    it("sequential project changes clear branch each time", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Select a branch
      let branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });
      expect((branchDropdown as HTMLInputElement).value).toBe("main");

      // Change project (to other-project) using mouseDown
      await selectProjectByName("other-project");

      // Re-query after project change (component remounted)
      branchDropdown = getBranchDropdown();

      // Branch should be cleared
      expect((branchDropdown as HTMLInputElement).value).toBe("");

      // Select a branch again
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });
      expect((branchDropdown as HTMLInputElement).value).toBe("main");

      // Change project again (back to test-project) using mouseDown
      await selectProjectByName("test-project");

      // Re-query after project change (component remounted)
      branchDropdown = getBranchDropdown();

      // Branch should be cleared again
      expect((branchDropdown as HTMLInputElement).value).toBe("");
    });

    it("name re-validates when project changes (if touched)", async () => {
      // Projects have different existing workspaces:
      // test-project has "existing", other-project has "ws1"
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Enter a name that exists in other-project but not in test-project
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "ws1" } });
      await fireEvent.blur(nameInput); // Mark as touched

      // Should NOT show error (ws1 doesn't exist in test-project)
      expect(screen.queryByText(/workspace already exists/i)).not.toBeInTheDocument();

      // Change to other-project (which has ws1) using mouseDown
      await selectProjectByName("other-project");

      // Now should show error (ws1 exists in other-project)
      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("name does not re-validate when project changes if not touched", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Enter a name that exists in other-project but DON'T blur (not touched)
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "ws1" } });
      // No blur, so touched remains false

      // Change to other-project using mouseDown
      await selectProjectByName("other-project");

      // Should NOT show error because field wasn't touched
      expect(screen.queryByText(/workspace already exists/i)).not.toBeInTheDocument();
    });
  });

  describe("default branch initialization", () => {
    it("initializes selectedBranch from project.defaultBaseBranch", async () => {
      const projectWithDefault = {
        ...mockProjectsList[0],
        defaultBaseBranch: "develop",
      };
      const otherProject = mockProjectsList[1]!;
      const projectsWithDefault = [projectWithDefault, otherProject];
      mockProjectsStore.mockReturnValue(projectsWithDefault);
      // Also update getProjectById to use the updated projects list
      mockGetProjectById.mockImplementation((id: ProjectId) =>
        projectsWithDefault.find((p) => p.id === id)
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const branchCombobox = getBranchDropdown() as HTMLInputElement;
      expect(branchCombobox.value).toBe("develop");
    });

    it("sets selectedBranch from new project's defaultBaseBranch when user changes project", async () => {
      // Scenario: User changes to a different project that has a defaultBaseBranch set.
      // The effect should pick up the new project's default branch since selectedBranch
      // is cleared when changing projects.

      // test-project has no defaultBaseBranch, other-project has "develop" as default
      const projectWithoutDefault = mockProjectsList[0]!;
      const projectWithDefault = {
        ...mockProjectsList[1]!,
        defaultBaseBranch: "develop",
      };
      const testProjects = [projectWithoutDefault, projectWithDefault];
      mockProjectsStore.mockReturnValue(testProjects);
      mockGetProjectById.mockImplementation((id: ProjectId) =>
        testProjects.find((p) => p.id === id)
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Initially branch should be empty (test-project has no default)
      let branchCombobox = getBranchDropdown() as HTMLInputElement;
      expect(branchCombobox.value).toBe("");

      // Change to other-project which has defaultBaseBranch: "develop"
      const projectDropdown = getProjectDropdown();
      await fireEvent.focus(projectDropdown);
      await fireEvent.input(projectDropdown, { target: { value: "" } });
      await vi.runAllTimersAsync();

      const projectListbox = document.getElementById("project-dropdown-listbox");
      const options = projectListbox?.querySelectorAll('[role="option"]');
      const otherProjectOption = Array.from(options ?? []).find(
        (opt) => opt.textContent?.trim() === "other-project"
      ) as HTMLElement;
      await fireEvent.mouseDown(otherProjectOption);
      await vi.runAllTimersAsync();

      // Re-query the dropdown and check that it's now set to the new project's default
      branchCombobox = getBranchDropdown() as HTMLInputElement;
      expect(branchCombobox.value).toBe("develop");
    });

    it("does not override user's branch selection when defaultBaseBranch becomes available", async () => {
      // User selects a branch before defaultBaseBranch is loaded - should not be overwritten

      // Start with project that has no defaultBaseBranch
      mockProjectsStore.mockReturnValue(mockProjectsList);
      mockGetProjectById.mockImplementation((id: ProjectId) =>
        mockProjectsList.find((p) => p.id === id)
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // User selects a branch manually
      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Verify user's selection
      expect((branchDropdown as HTMLInputElement).value).toBe("main");

      // Now simulate defaultBaseBranch becoming available with different value
      const projectWithDefault = {
        ...mockProjectsList[0],
        defaultBaseBranch: "develop", // Different from user's selection
      };
      const otherProject = mockProjectsList[1]!;
      const projectsWithDefault = [projectWithDefault, otherProject];
      mockProjectsStore.mockReturnValue(projectsWithDefault);
      mockGetProjectById.mockImplementation((id: ProjectId) =>
        projectsWithDefault.find((p) => p.id === id)
      );

      // Trigger reactivity
      await vi.runAllTimersAsync();

      // User's selection should NOT be overwritten
      expect((branchDropdown as HTMLInputElement).value).toBe("main");
    });

    it("initializes selectedBranch to empty string when defaultBaseBranch is undefined", async () => {
      // mockProjectsList[0] has no defaultBaseBranch
      mockProjectsStore.mockReturnValue(mockProjectsList);

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const branchCombobox = getBranchDropdown() as HTMLInputElement;
      expect(branchCombobox.value).toBe("");
    });

    it("form is valid when defaultBaseBranch exists and is valid", async () => {
      const projectWithDefault = {
        ...mockProjectsList[0],
        defaultBaseBranch: "main",
      };
      const otherProject = mockProjectsList[1]!;
      const projectsWithDefault = [projectWithDefault, otherProject];
      mockProjectsStore.mockReturnValue(projectsWithDefault);
      // Also update getProjectById to use the updated projects list
      mockGetProjectById.mockImplementation((id: ProjectId) =>
        projectsWithDefault.find((p) => p.id === id)
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill in just the name - branch should already be set
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const okButton = screen.getByRole("button", { name: /ok|create/i });
      expect(okButton).not.toBeDisabled();
    });
  });

  describe("error handling", () => {
    it('api.createWorkspace failure displays error in role="alert"', async () => {
      mockCreateWorkspace.mockRejectedValue(new Error("Network error"));

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      // The submit error is displayed
      const errorElement = screen.getByText(/network error/i);
      expect(errorElement).toBeInTheDocument();
      expect(errorElement.closest("[role='alert']")).toBeInTheDocument();
    });

    it("error re-enables form for retry", async () => {
      mockCreateWorkspace.mockRejectedValue(new Error("Network error"));

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      // Form should be re-enabled
      expect(nameInput).not.toBeDisabled();
      expect(okButton).not.toBeDisabled();
    });

    it("error message cleared on next submit attempt", async () => {
      let callCount = 0;
      mockCreateWorkspace.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve();
      });

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = getNameInput();
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchDropdown = getBranchDropdown();
      await fireEvent.focus(branchDropdown);
      await fireEvent.keyDown(branchDropdown, { key: "ArrowDown" });
      await fireEvent.keyDown(branchDropdown, { key: "Enter" });

      // First attempt - fails
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);
      await vi.runAllTimersAsync();

      expect(screen.getByText(/network error/i)).toBeInTheDocument();

      // Second attempt - should clear error
      await fireEvent.click(okButton);

      expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();

      await vi.runAllTimersAsync();
    });
  });
});
