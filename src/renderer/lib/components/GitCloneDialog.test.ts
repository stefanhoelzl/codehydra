/**
 * Tests for the GitCloneDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { Project, ProjectId } from "@shared/api/types";

// Create mock functions with vi.hoisted
const { mockCloneProject, mockOpenCreateDialog, mockCloseDialog } = vi.hoisted(() => ({
  mockCloneProject: vi.fn(),
  mockOpenCreateDialog: vi.fn(),
  mockCloseDialog: vi.fn(),
}));

// Mock $lib/api
vi.mock("$lib/api", () => ({
  projects: {
    clone: mockCloneProject,
  },
  on: vi.fn(() => () => {}),
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  openCreateDialog: mockOpenCreateDialog,
  closeDialog: mockCloseDialog,
}));

// Import component after mocks
import GitCloneDialog from "./GitCloneDialog.svelte";
import * as cloneProgressStore from "$lib/stores/clone-progress.svelte.js";

// Test data
const testProjectId = "test-repo-12345678" as ProjectId;
const testUrl = "https://github.com/org/test-repo.git";

function createProject(id: ProjectId): Project {
  return {
    id,
    name: "test-repo",
    path: "/test/projects/test-repo",
    workspaces: [],
    remoteUrl: testUrl,
  };
}

/**
 * Helper to get the URL textfield (vscode-textfield).
 */
function getUrlInput(): HTMLElement & { value?: string } {
  const input = document.querySelector("vscode-textfield");
  if (!input) throw new Error("URL input not found");
  return input as HTMLElement & { value?: string };
}

describe("GitCloneDialog component", () => {
  const defaultProps = {
    open: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    cloneProgressStore.reset();
    mockCloneProject.mockResolvedValue(createProject(testProjectId));
  });

  afterEach(() => {
    cloneProgressStore.reset();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("structure", () => {
    it("uses Dialog base component", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it('renders title "Clone from Git Repository"', async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText("Clone from Git Repository")).toBeInTheDocument();
    });

    it("renders URL textfield with placeholder", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      expect(input).toBeInTheDocument();
      // vscode-textfield may not reflect placeholder as attribute in test environment
      // Check either attribute or property
      const placeholder =
        input.getAttribute("placeholder") ??
        (input as unknown as { placeholder?: string }).placeholder;
      expect(placeholder).toBe("org/repo or https://github.com/org/repo.git");
    });

    it("renders Cancel and Clone buttons", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /clone/i })).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("URL input has autofocus", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      // vscode-textfield with autofocus attribute
      expect(input.hasAttribute("autofocus")).toBe(true);
    });
  });

  describe("URL validation", () => {
    it("Clone button disabled when URL is empty", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      expect(cloneButton).toBeDisabled();
    });

    it("Clone button enabled for valid HTTPS URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      expect(cloneButton).not.toBeDisabled();
    });

    it("Clone button enabled for valid SSH URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: "git@github.com:org/repo.git" } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      expect(cloneButton).not.toBeDisabled();
    });

    it("shows validation error for invalid URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: "invalid-url" } });

      expect(screen.getByText(/enter a git url, org\/repo/i)).toBeInTheDocument();
    });

    it("Clone button disabled for invalid URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: "not-a-url" } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      expect(cloneButton).toBeDisabled();
    });
  });

  describe("clone flow", () => {
    it("calls api.projects.clone() with URL on submit", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      await vi.runAllTimersAsync();

      expect(mockCloneProject).toHaveBeenCalledWith(testUrl);
    });

    it('shows "Continue in background" button during clone', async () => {
      mockCloneProject.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(createProject(testProjectId)), 1000))
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      // Should show "Continue in background" button
      expect(screen.getByRole("button", { name: /continue in background/i })).toBeInTheDocument();
      // Clone button should be gone
      expect(screen.queryByRole("button", { name: /^clone$/i })).not.toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("disables input and cancel during clone", async () => {
      mockCloneProject.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(createProject(testProjectId)), 1000))
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      // Input should be disabled
      expect(input).toBeDisabled();
      // Cancel should be disabled
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
      // "Continue in background" should be enabled
      expect(screen.getByRole("button", { name: /continue in background/i })).not.toBeDisabled();

      await vi.runAllTimersAsync();
    });

    it("opens CreateWorkspaceDialog with project ID on success", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      // Flush microtasks from the detached promise's .then() handler
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(mockOpenCreateDialog).toHaveBeenCalledWith(testProjectId);
    });

    it('closes dialog when "Continue in background" is clicked', async () => {
      mockCloneProject.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(createProject(testProjectId)), 1000))
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      const bgButton = screen.getByRole("button", { name: /continue in background/i });
      await fireEvent.click(bgButton);

      expect(mockCloseDialog).toHaveBeenCalled();

      await vi.runAllTimersAsync();
    });

    it("does not navigate after background clone completes", async () => {
      let resolveClone: (project: Project) => void;
      mockCloneProject.mockImplementation(
        () =>
          new Promise<Project>((resolve) => {
            resolveClone = resolve;
          })
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      // Click "Continue in background"
      const bgButton = screen.getByRole("button", { name: /continue in background/i });
      await fireEvent.click(bgButton);

      // Now resolve the clone
      resolveClone!(createProject(testProjectId));
      await vi.runAllTimersAsync();

      // openCreateDialog should NOT have been called (dialog was backgrounded)
      expect(mockOpenCreateDialog).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("shows error message on clone failure", async () => {
      mockCloneProject.mockRejectedValue(new Error("Network error: could not connect"));

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      await vi.runAllTimersAsync();

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });

    it("stays open after error for retry", async () => {
      mockCloneProject.mockRejectedValue(new Error("Auth failed"));

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      await vi.runAllTimersAsync();

      // Dialog should still be visible
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Input should be re-enabled
      expect(getUrlInput()).not.toBeDisabled();
    });

    it("clears error when user types", async () => {
      mockCloneProject.mockRejectedValueOnce(new Error("Failed"));

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      await vi.runAllTimersAsync();

      // Error should be shown
      expect(screen.getByRole("alert")).toBeInTheDocument();

      // Type in the input
      await fireEvent.input(input, { target: { value: "https://github.com/other/repo.git" } });

      // Error should be cleared
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("cancel flow", () => {
    it("calls openCreateDialog() without project ID on cancel", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      expect(mockOpenCreateDialog).toHaveBeenCalledWith();
    });

    it("Escape key cancels dialog", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockOpenCreateDialog).toHaveBeenCalledWith();
    });

    it("Escape key does not close during clone", async () => {
      mockCloneProject.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(createProject(testProjectId)), 1000))
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      // Clone is in progress — Escape should not close
      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockOpenCreateDialog).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
    });

    it("cancel button disabled during clone", async () => {
      mockCloneProject.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(createProject(testProjectId)), 1000))
      );

      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });

      const cloneButton = screen.getByRole("button", { name: /clone/i });
      await fireEvent.click(cloneButton);

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      expect(cancelButton).toBeDisabled();

      await vi.runAllTimersAsync();
    });
  });

  describe("Enter key handling", () => {
    it("submits form when Enter is pressed with valid URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: testUrl } });
      await fireEvent.keyDown(input, { key: "Enter" });

      await vi.runAllTimersAsync();

      expect(mockCloneProject).toHaveBeenCalledWith(testUrl);
    });

    it("does not submit when Enter is pressed with invalid URL", async () => {
      render(GitCloneDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const input = getUrlInput();
      await fireEvent.input(input, { target: { value: "invalid" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      await vi.runAllTimersAsync();

      expect(mockCloneProject).not.toHaveBeenCalled();
    });
  });

  describe("closed state", () => {
    it("does not render when open is false", async () => {
      render(GitCloneDialog, {
        props: { ...defaultProps, open: false },
      });
      await vi.runAllTimersAsync();

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
