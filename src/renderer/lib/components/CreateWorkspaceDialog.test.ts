/**
 * Tests for the CreateWorkspaceDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { Project, ProjectPath } from "@shared/ipc";

// Create mock functions with vi.hoisted
const { mockCreateWorkspace, mockListBases, mockProjects, mockCloseDialog } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
  mockListBases: vi.fn(),
  mockProjects: vi.fn(),
  mockCloseDialog: vi.fn(),
}));

// Mock $lib/api
vi.mock("$lib/api", () => ({
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue([]),
  createWorkspace: mockCreateWorkspace,
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: mockListBases,
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
}));

// Mock $lib/stores/projects
vi.mock("$lib/stores/projects.svelte.js", () => ({
  projects: {
    get value() {
      return mockProjects();
    },
  },
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  closeDialog: mockCloseDialog,
  getTriggerElement: vi.fn().mockReturnValue(null),
}));

// Import component after mocks
import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
import { createWorkspace } from "$lib/api";

describe("CreateWorkspaceDialog component", () => {
  const mockProject: Project = {
    path: "/test/project" as ProjectPath,
    name: "test-project",
    workspaces: [
      { path: "/test/project/.worktrees/existing", name: "existing", branch: "existing" },
    ],
  };

  const defaultProps = {
    open: true,
    projectPath: "/test/project",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProjects.mockReturnValue([mockProject]);
    mockListBases.mockResolvedValue([
      { name: "main", isRemote: false },
      { name: "develop", isRemote: false },
    ]);
    mockCreateWorkspace.mockResolvedValue(undefined);
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

    it("renders name input and branch dropdown", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("name input has aria-describedby for errors", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      expect(nameInput).toHaveAttribute("aria-describedby");
    });
  });

  describe("validation", () => {
    it('empty name shows error "Name is required"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    });

    it('name with / shows error "Name cannot contain /"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "feature/branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \//i)).toBeInTheDocument();
    });

    it('name with \\ shows error "Name cannot contain \\"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "feature\\branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \\/i)).toBeInTheDocument();
    });

    it('name with .. shows error "Name cannot contain .."', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "feature..branch" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/name cannot contain \.\./i)).toBeInTheDocument();
    });

    it("name > 100 chars shows error", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      const longName = "a".repeat(101);
      await fireEvent.input(nameInput, { target: { value: longName } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/100 characters or less/i)).toBeInTheDocument();
    });

    it('duplicate name shows error "Workspace already exists"', async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "existing" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("duplicate name is case-insensitive", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "EXISTING" } });
      await fireEvent.blur(nameInput);

      expect(screen.getByText(/workspace already exists/i)).toBeInTheDocument();
    });

    it("valid name clears error", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const nameInput = screen.getByLabelText(/name/i);

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

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature_branch" } });
      await fireEvent.blur(nameInput);

      // Should not show any validation error (the alert container exists but should be empty)
      const errorMessage = screen.getByRole("alert");
      expect(errorMessage.textContent).toBe("");
    });
  });

  describe("keyboard navigation", () => {
    it("Escape closes dialog", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockCloseDialog).toHaveBeenCalled();
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

      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      // Select a branch
      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      // Inputs should be disabled
      expect(nameInput).toBeDisabled();
      expect(branchCombobox).toBeDisabled();

      await vi.runAllTimersAsync();
    });

    it('aria-busy="true" during submit', async () => {
      mockCreateWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "valid-name" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(createWorkspace).toHaveBeenCalledWith("/test/project", "my-feature", "main");
    });

    it("success closes dialog", async () => {
      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|create/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it('api.createWorkspace failure displays error in role="alert"', async () => {
      mockCreateWorkspace.mockRejectedValue(new Error("Network error"));

      render(CreateWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Fill valid form
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
      const nameInput = screen.getByLabelText(/name/i);
      await fireEvent.input(nameInput, { target: { value: "my-feature" } });

      const branchCombobox = screen.getByRole("combobox");
      await fireEvent.focus(branchCombobox);
      await fireEvent.keyDown(branchCombobox, { key: "ArrowDown" });
      await fireEvent.keyDown(branchCombobox, { key: "Enter" });

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
