/**
 * Tests for DeletionProgressView component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import DeletionProgressView from "./DeletionProgressView.svelte";
import type { DeletionProgress, ProjectId, WorkspaceName } from "@shared/api/types";
import type { WorkspacePath } from "@shared/ipc";

describe("DeletionProgressView", () => {
  const defaultProgress: DeletionProgress = {
    workspacePath: "/path/to/workspace" as WorkspacePath,
    workspaceName: "feature-branch" as WorkspaceName,
    projectId: "test-project-12345678" as ProjectId,
    keepBranch: false,
    operations: [
      { id: "cleanup-vscode", label: "Cleanup VS Code", status: "pending" },
      { id: "cleanup-workspace", label: "Cleanup workspace", status: "pending" },
    ],
    completed: false,
    hasErrors: false,
  };

  // Mock functions with explicit type to satisfy component props
  let onRetry: ReturnType<typeof vi.fn> & (() => void);
  let onCloseAnyway: ReturnType<typeof vi.fn> & (() => void);

  beforeEach(() => {
    onRetry = vi.fn() as ReturnType<typeof vi.fn> & (() => void);
    onCloseAnyway = vi.fn() as ReturnType<typeof vi.fn> & (() => void);
  });

  it("should render workspace name", () => {
    render(DeletionProgressView, {
      props: {
        progress: defaultProgress,
        onRetry,
        onCloseAnyway,
      },
    });

    expect(screen.getByText(/"feature-branch"/)).toBeInTheDocument();
  });

  it("should render title", () => {
    render(DeletionProgressView, {
      props: {
        progress: defaultProgress,
        onRetry,
        onCloseAnyway,
      },
    });

    expect(screen.getByText("Removing workspace")).toBeInTheDocument();
  });

  describe("pending operations", () => {
    it("should show pending operations with screen reader text", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onCloseAnyway,
        },
      });

      expect(screen.getByText("Cleanup VS Code")).toBeInTheDocument();
      expect(screen.getByText("Cleanup workspace")).toBeInTheDocument();
      // Screen reader text
      const pendingTexts = screen.getAllByText("Pending");
      expect(pendingTexts.length).toBe(2);
    });
  });

  describe("in-progress operation", () => {
    it("should show spinner with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "in-progress" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "pending" },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      // Check for progress ring (spinner)
      expect(document.querySelector("vscode-progress-ring")).toBeInTheDocument();
      // Screen reader text
      expect(screen.getByText("In progress")).toBeInTheDocument();
    });
  });

  describe("done operations", () => {
    it("should show checkmark with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "in-progress" },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      // Check for checkmark character
      expect(screen.getByText("\u2713")).toBeInTheDocument();
      // Screen reader text
      expect(screen.getByText("Complete")).toBeInTheDocument();
    });
  });

  describe("error operation", () => {
    it("should show red X with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "git worktree remove failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      // Check for X character
      expect(screen.getByText("\u2717")).toBeInTheDocument();
      // Screen reader text
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("should show error box with role alert", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "git worktree remove failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      const errorBox = screen.getByRole("alert");
      expect(errorBox).toBeInTheDocument();
      expect(errorBox).toHaveTextContent("Error: git worktree remove failed");
    });

    it("should show first error message only when multiple errors", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          {
            id: "cleanup-vscode",
            label: "Cleanup VS Code",
            status: "error",
            error: "First error",
          },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "Second error",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      expect(screen.getByText("Error: First error")).toBeInTheDocument();
      expect(screen.queryByText("Second error")).not.toBeInTheDocument();
    });
  });

  describe("action buttons", () => {
    it("should not show buttons when completed without errors", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "done" },
        ],
        completed: true,
        hasErrors: false,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /close anyway/i })).not.toBeInTheDocument();
    });

    it("should not show buttons when not completed", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "in-progress" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "pending" },
        ],
        completed: false,
        hasErrors: false,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /close anyway/i })).not.toBeInTheDocument();
    });

    it("should show Retry and Close Anyway buttons when completed with errors", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "Failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Close Anyway")).toBeInTheDocument();
    });

    it("should call onRetry when Retry button is clicked", async () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "Failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      const retryButton = screen.getByText("Retry").closest("vscode-button");
      expect(retryButton).toBeInTheDocument();

      await userEvent.click(retryButton!);

      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("should call onCloseAnyway when Close Anyway button is clicked", async () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Cleanup workspace",
            status: "error",
            error: "Failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onCloseAnyway,
        },
      });

      const closeAnywayButton = screen.getByText("Close Anyway").closest("vscode-button");
      expect(closeAnywayButton).toBeInTheDocument();

      await userEvent.click(closeAnywayButton!);

      expect(onCloseAnyway).toHaveBeenCalledOnce();
    });
  });

  describe("accessibility", () => {
    it("should have operations list with role=list and aria-live", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onCloseAnyway,
        },
      });

      const list = screen.getByRole("list");
      expect(list).toHaveAttribute("aria-live", "polite");
    });

    it("should have operation items with role=listitem", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onCloseAnyway,
        },
      });

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(2);
    });
  });
});
