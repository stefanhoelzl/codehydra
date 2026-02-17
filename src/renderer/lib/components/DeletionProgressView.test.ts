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
      { id: "kill-terminals", label: "Terminating processes", status: "pending" },
      { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
      { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
    ],
    completed: false,
    hasErrors: false,
  };

  // Mock functions with explicit type to satisfy component props
  let onRetry: ReturnType<typeof vi.fn> & (() => void);
  let onDismiss: ReturnType<typeof vi.fn> & (() => void);

  beforeEach(() => {
    onRetry = vi.fn() as ReturnType<typeof vi.fn> & (() => void);
    onDismiss = vi.fn() as ReturnType<typeof vi.fn> & (() => void);
  });

  it("should render workspace name", () => {
    render(DeletionProgressView, {
      props: {
        progress: defaultProgress,
        onRetry,
        onDismiss,
      },
    });

    expect(screen.getByText(/"feature-branch"/)).toBeInTheDocument();
  });

  it("should render title", () => {
    render(DeletionProgressView, {
      props: {
        progress: defaultProgress,
        onRetry,
        onDismiss,
      },
    });

    // Use heading role to distinguish from operation label with same text
    expect(screen.getByRole("heading", { name: "Removing workspace" })).toBeInTheDocument();
  });

  describe("pending operations", () => {
    it("should show pending operations with screen reader text", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.getByText("Terminating processes")).toBeInTheDocument();
      expect(screen.getByText("Closing VS Code view")).toBeInTheDocument();
      // "Removing workspace" appears both as title (h2) and operation label
      // Check that both exist (title + operation label = 2 matches)
      expect(screen.getAllByText("Removing workspace")).toHaveLength(2);
      // Screen reader text
      const pendingTexts = screen.getAllByText("Pending");
      expect(pendingTexts.length).toBe(3);
    });
  });

  describe("in-progress operation", () => {
    it("should show spinner with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "in-progress" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      // Check for progress ring (spinner)
      expect(document.querySelector("vscode-progress-ring")).toBeInTheDocument();
      // Screen reader text
      expect(screen.getByText("In progress")).toBeInTheDocument();
    });
  });

  describe("done operations", () => {
    it("should show checkmark icon with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "in-progress" },
        ],
      };

      const { container } = render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      // Check for vscode-icon (two done operations) - Icon component renders vscode-icon
      const doneIndicators = container.querySelectorAll(".status-done vscode-icon");
      expect(doneIndicators.length).toBe(2);
      // Screen reader text
      const completeTexts = screen.getAllByText("Complete");
      expect(completeTexts.length).toBe(2);
    });
  });

  describe("error operation", () => {
    it("should show error icon with screen reader text", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
            status: "error",
            error: "git worktree remove failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      const { container } = render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      // Check for vscode-icon (error indicator) - Icon component renders vscode-icon
      expect(container.querySelector(".status-error vscode-icon")).toBeInTheDocument();
      // Screen reader text
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("should show error box with role alert", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
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
          onDismiss,
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
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          {
            id: "cleanup-vscode",
            label: "Closing VS Code view",
            status: "error",
            error: "First error",
          },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
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
          onDismiss,
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
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "done" },
        ],
        completed: true,
        hasErrors: false,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it("should not show buttons when not completed", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "in-progress" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
        ],
        completed: false,
        hasErrors: false,
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it("should show Retry and Dismiss buttons when completed with errors", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
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
          onDismiss,
        },
      });

      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Dismiss")).toBeInTheDocument();
    });

    it("should show Kill & Retry button when blocking processes exist", () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
            status: "error",
            error: "Failed",
          },
        ],
        completed: true,
        hasErrors: true,
        blockingProcesses: [
          { pid: 1234, name: "node.exe", commandLine: "node", files: [], cwd: null },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.getByText("Kill & Retry")).toBeInTheDocument();
    });

    it("should call onRetry when Retry button is clicked", async () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
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
          onDismiss,
        },
      });

      const retryButton = screen.getByText("Retry").closest("vscode-button");
      expect(retryButton).toBeInTheDocument();

      await userEvent.click(retryButton!);

      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("should call onDismiss when Dismiss button is clicked", async () => {
      const progress: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
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
          onDismiss,
        },
      });

      const dismissButton = screen.getByText("Dismiss").closest("vscode-button");
      expect(dismissButton).toBeInTheDocument();

      await userEvent.click(dismissButton!);

      expect(onDismiss).toHaveBeenCalledOnce();
    });
  });

  describe("accessibility", () => {
    it("should have operations list with role=list and aria-live", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onDismiss,
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
          onDismiss,
        },
      });

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(3);
    });
  });

  describe("three-operation rendering", () => {
    it("renders all three operations in correct order with correct labels", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onDismiss,
        },
      });

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent("Terminating processes");
      expect(items[1]).toHaveTextContent("Closing VS Code view");
      expect(items[2]).toHaveTextContent("Removing workspace");
    });
  });

  describe("unblock operation steps", () => {
    it("renders killing-blockers step when present in operations", () => {
      const progressWithKillingBlockers: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "killing-blockers", label: "Killing blocking processes...", status: "in-progress" },
          { id: "kill-terminals", label: "Terminating processes", status: "pending" },
          { id: "stop-server", label: "Stopping agent server", status: "pending" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress: progressWithKillingBlockers,
          onRetry,
          onDismiss,
        },
      });

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(5);
      expect(items[0]).toHaveTextContent("Killing blocking processes...");
      // Check for spinner (in-progress status)
      expect(document.querySelector("vscode-progress-ring")).toBeInTheDocument();
    });

    it("shows killing-blockers as done when completed", () => {
      const progressWithKillingDone: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "killing-blockers", label: "Killing blocking processes...", status: "done" },
          { id: "kill-terminals", label: "Terminating processes", status: "in-progress" },
          { id: "stop-server", label: "Stopping agent server", status: "pending" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
        ],
      };

      const { container } = render(DeletionProgressView, {
        props: {
          progress: progressWithKillingDone,
          onRetry,
          onDismiss,
        },
      });

      // First item should be done (checkmark)
      const doneIndicators = container.querySelectorAll(".status-done vscode-icon");
      expect(doneIndicators.length).toBeGreaterThanOrEqual(1);
    });

    it("does not render unblock steps when not present in operations", () => {
      render(DeletionProgressView, {
        props: {
          progress: defaultProgress,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.queryByText("Killing blocking processes...")).not.toBeInTheDocument();
    });
  });

  describe("blocking processes", () => {
    const progressWithBlocking: DeletionProgress = {
      ...defaultProgress,
      operations: [
        { id: "kill-terminals", label: "Terminating processes", status: "done" },
        { id: "stop-server", label: "Stopping agent server", status: "done" },
        { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
        {
          id: "cleanup-workspace",
          label: "Removing workspace",
          status: "error",
          error: "EBUSY: resource busy or locked",
        },
      ],
      completed: true,
      hasErrors: true,
      blockingProcesses: [
        { pid: 1234, name: "node.exe", commandLine: "node dist/server.js", files: [], cwd: null },
        {
          pid: 5678,
          name: "Code.exe",
          commandLine: '"C:\\Program Files\\VS Code\\Code.exe" .',
          files: [],
          cwd: null,
        },
      ],
    };

    it("should show blocking processes list when blockingProcesses is non-empty", () => {
      const { container } = render(DeletionProgressView, {
        props: {
          progress: progressWithBlocking,
          onRetry,
          onDismiss,
        },
      });

      // Check scrollable region exists
      const region = container.querySelector(".blocking-processes");
      expect(region).toBeInTheDocument();

      // Check processes are rendered (PID shown as "PID 1234")
      expect(screen.getByText(/PID 1234/)).toBeInTheDocument();
      expect(screen.getByText("node.exe")).toBeInTheDocument();
      expect(screen.getByText(/PID 5678/)).toBeInTheDocument();
      expect(screen.getByText("Code.exe")).toBeInTheDocument();
    });

    it("should have accessible region for blocking processes", () => {
      render(DeletionProgressView, {
        props: {
          progress: progressWithBlocking,
          onRetry,
          onDismiss,
        },
      });

      const region = screen.getByRole("region", { name: "Blocking processes and files" });
      expect(region).toBeInTheDocument();
    });

    it("should not show blocking processes list when blockingProcesses is empty", () => {
      const progressEmpty: DeletionProgress = {
        ...progressWithBlocking,
        blockingProcesses: [],
      };

      const { container } = render(DeletionProgressView, {
        props: {
          progress: progressEmpty,
          onRetry,
          onDismiss,
        },
      });

      expect(container.querySelector(".blocking-processes")).not.toBeInTheDocument();
    });

    it("should not show blocking processes list when blockingProcesses is undefined", () => {
      const progressUndefined: DeletionProgress = {
        ...defaultProgress,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
            status: "error",
            error: "Failed",
          },
        ],
        completed: true,
        hasErrors: true,
      };

      const { container } = render(DeletionProgressView, {
        props: {
          progress: progressUndefined,
          onRetry,
          onDismiss,
        },
      });

      expect(container.querySelector(".blocking-processes")).not.toBeInTheDocument();
    });

    it("should show header with process and file count", () => {
      const progressWithFiles: DeletionProgress = {
        ...progressWithBlocking,
        blockingProcesses: [
          {
            pid: 1234,
            name: "node.exe",
            commandLine: "node dist/server.js",
            files: ["file1.txt", "file2.txt"],
            cwd: null,
          },
          {
            pid: 5678,
            name: "Code.exe",
            commandLine: '"C:\\Program Files\\VS Code\\Code.exe" .',
            files: ["file3.txt"],
            cwd: null,
          },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress: progressWithFiles,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.getByText(/2 process\(es\) holding 3 file\(s\)/)).toBeInTheDocument();
    });

    it("should show CWD when process has working directory in workspace", () => {
      const progressWithCwd: DeletionProgress = {
        ...progressWithBlocking,
        blockingProcesses: [
          {
            pid: 1234,
            name: "powershell.exe",
            commandLine: "powershell.exe",
            files: [],
            cwd: "src/components",
          },
        ],
      };

      render(DeletionProgressView, {
        props: {
          progress: progressWithCwd,
          onRetry,
          onDismiss,
        },
      });

      expect(screen.getByText("Working directory: src/components/")).toBeInTheDocument();
    });

    it("should show (no files detected) when process has no files and no cwd", () => {
      render(DeletionProgressView, {
        props: {
          progress: progressWithBlocking,
          onRetry,
          onDismiss,
        },
      });

      // Both processes have empty files array and null cwd
      const noFilesTexts = screen.getAllByText("(no files detected)");
      expect(noFilesTexts).toHaveLength(2);
    });

    describe("command line truncation", () => {
      it("should show short command lines in full (<= 60 chars)", () => {
        // 60 characters exactly
        const shortCommand = "C:\\Program Files\\Code\\bin\\code.exe --folder project";
        const progressWithShortCmd: DeletionProgress = {
          ...progressWithBlocking,
          blockingProcesses: [
            {
              pid: 1234,
              name: "code.exe",
              commandLine: shortCommand,
              files: [],
              cwd: null,
            },
          ],
        };

        render(DeletionProgressView, {
          props: {
            progress: progressWithShortCmd,
            onRetry,
            onDismiss,
          },
        });

        // Should show the full command line
        expect(screen.getByText(shortCommand)).toBeInTheDocument();
      });

      it("should truncate long command lines (> 60 chars) to first 30 + ... + last 20", () => {
        // 80 characters total - definitely long enough to be truncated
        const longCommand =
          "C:\\Program Files\\Microsoft VS Code\\Code.exe --folder C:\\Users\\test\\workspace123";
        const progressWithLongCmd: DeletionProgress = {
          ...progressWithBlocking,
          blockingProcesses: [
            {
              pid: 1234,
              name: "Code.exe",
              commandLine: longCommand,
              files: [],
              cwd: null,
            },
          ],
        };

        render(DeletionProgressView, {
          props: {
            progress: progressWithLongCmd,
            onRetry,
            onDismiss,
          },
        });

        // First 30 chars: "C:\Program Files\Microsoft VS "
        // Last 20 chars: "test\workspace123"
        const expectedTruncated = longCommand.slice(0, 30) + "..." + longCommand.slice(-20);
        expect(screen.getByText(expectedTruncated)).toBeInTheDocument();

        // Full command should NOT be in the document
        expect(screen.queryByText(longCommand)).not.toBeInTheDocument();
      });

      it("should show full command in title tooltip for truncated commands", () => {
        const longCommand =
          "C:\\Program Files\\Microsoft VS Code\\Code.exe --folder C:\\Users\\test\\workspace123";
        const progressWithLongCmd: DeletionProgress = {
          ...progressWithBlocking,
          blockingProcesses: [
            {
              pid: 1234,
              name: "Code.exe",
              commandLine: longCommand,
              files: [],
              cwd: null,
            },
          ],
        };

        const { container } = render(DeletionProgressView, {
          props: {
            progress: progressWithLongCmd,
            onRetry,
            onDismiss,
          },
        });

        // The title attribute should contain the full command line
        const commandElement = container.querySelector(".process-command");
        expect(commandElement).toHaveAttribute("title", longCommand);
      });
    });
  });
});
