/**
 * Tests for workspace resolver.
 */

import { describe, it, expect } from "vitest";
import { resolveWorkspace, type WorkspaceLookup } from "./workspace-resolver";

/**
 * Create a mock WorkspaceLookup for testing.
 */
function createMockAppState(
  projects: { path: string; workspaces: { path: string }[] }[]
): WorkspaceLookup {
  return {
    findProjectForWorkspace(workspacePath: string) {
      for (const project of projects) {
        const ws = project.workspaces.find((w) => w.path === workspacePath);
        if (ws) {
          return project;
        }
      }
      return undefined;
    },
  };
}

describe("resolveWorkspace", () => {
  // Use platform-appropriate paths
  const isWindows = process.platform === "win32";
  const projectPath = isWindows ? "C:\\Projects\\my-app" : "/home/user/projects/my-app";
  const workspacePath = isWindows
    ? "C:\\Projects\\my-app\\.worktrees\\feature-branch"
    : "/home/user/projects/my-app/.worktrees/feature-branch";

  describe("valid workspace path", () => {
    it("resolves to correct projectId and workspaceName", () => {
      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const result = resolveWorkspace(workspacePath, appState);

      expect(result).not.toBeNull();
      expect(result!.projectId).toMatch(/^my-app-[a-f0-9]{8}$/);
      expect(result!.workspaceName).toBe("feature-branch");
      expect(result!.workspacePath).toBe(workspacePath);
    });

    it("handles paths with special characters in project name", () => {
      const specialProjectPath = isWindows
        ? "C:\\Projects\\My Cool App"
        : "/home/user/projects/My Cool App";
      const specialWorkspacePath = isWindows
        ? "C:\\Projects\\My Cool App\\.worktrees\\feature"
        : "/home/user/projects/My Cool App/.worktrees/feature";

      const appState = createMockAppState([
        {
          path: specialProjectPath,
          workspaces: [{ path: specialWorkspacePath }],
        },
      ]);

      const result = resolveWorkspace(specialWorkspacePath, appState);

      expect(result).not.toBeNull();
      expect(result!.projectId).toMatch(/^My-Cool-App-[a-f0-9]{8}$/);
      expect(result!.workspaceName).toBe("feature");
    });

    it("handles multiple workspaces in the same project", () => {
      const workspace1 = isWindows
        ? "C:\\Projects\\my-app\\.worktrees\\feature-1"
        : "/home/user/projects/my-app/.worktrees/feature-1";
      const workspace2 = isWindows
        ? "C:\\Projects\\my-app\\.worktrees\\feature-2"
        : "/home/user/projects/my-app/.worktrees/feature-2";

      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspace1 }, { path: workspace2 }],
        },
      ]);

      const result1 = resolveWorkspace(workspace1, appState);
      const result2 = resolveWorkspace(workspace2, appState);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1!.projectId).toBe(result2!.projectId);
      expect(result1!.workspaceName).toBe("feature-1");
      expect(result2!.workspaceName).toBe("feature-2");
    });
  });

  describe("non-existent workspace path", () => {
    it("returns null for unknown workspace path", () => {
      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const unknownPath = isWindows
        ? "C:\\Projects\\my-app\\.worktrees\\unknown"
        : "/home/user/projects/my-app/.worktrees/unknown";

      const result = resolveWorkspace(unknownPath, appState);

      expect(result).toBeNull();
    });

    it("returns null when no projects exist", () => {
      const appState = createMockAppState([]);

      const result = resolveWorkspace(workspacePath, appState);

      expect(result).toBeNull();
    });
  });

  describe("invalid paths", () => {
    it("returns null for empty string", () => {
      const appState = createMockAppState([]);

      const result = resolveWorkspace("", appState);

      expect(result).toBeNull();
    });

    it("returns null for relative path", () => {
      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const result = resolveWorkspace("./relative/path", appState);

      expect(result).toBeNull();
    });

    it("returns null for non-string input", () => {
      const appState = createMockAppState([]);

      // @ts-expect-error Testing invalid input
      expect(resolveWorkspace(null, appState)).toBeNull();
      // @ts-expect-error Testing invalid input
      expect(resolveWorkspace(undefined, appState)).toBeNull();
      // @ts-expect-error Testing invalid input
      expect(resolveWorkspace(123, appState)).toBeNull();
      // @ts-expect-error Testing invalid input
      expect(resolveWorkspace({}, appState)).toBeNull();
    });
  });

  describe("path normalization", () => {
    it("normalizes paths with double slashes", () => {
      // Path with double slashes that normalizes to workspacePath
      const pathWithDoubleSlashes = isWindows
        ? workspacePath.replace("\\feature-branch", "\\\\feature-branch")
        : workspacePath.replace("/feature-branch", "//feature-branch");

      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const result = resolveWorkspace(pathWithDoubleSlashes, appState);

      expect(result).not.toBeNull();
      expect(result!.workspacePath).toBe(workspacePath);
    });

    it("handles Windows backslash paths on Windows", () => {
      if (!isWindows) {
        // Skip on non-Windows
        return;
      }

      const backslashPath = "C:\\Projects\\my-app\\.worktrees\\feature-branch";
      const appState = createMockAppState([
        {
          path: "C:\\Projects\\my-app",
          workspaces: [{ path: backslashPath }],
        },
      ]);

      const result = resolveWorkspace(backslashPath, appState);

      expect(result).not.toBeNull();
      expect(result!.workspaceName).toBe("feature-branch");
    });

    it("handles paths with dot segments", () => {
      // Path with .. that still points to the same workspace after normalization
      const pathWithDots = isWindows
        ? "C:\\Projects\\my-app\\.worktrees\\..\\..\\my-app\\.worktrees\\feature-branch"
        : "/home/user/projects/my-app/.worktrees/../../my-app/.worktrees/feature-branch";

      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const result = resolveWorkspace(pathWithDots, appState);

      // After normalization, should match the registered workspace
      expect(result).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles workspace at root level", () => {
      const rootWorkspace = isWindows ? "C:\\workspace" : "/workspace";
      const rootProject = isWindows ? "C:\\project" : "/project";

      const appState = createMockAppState([
        {
          path: rootProject,
          workspaces: [{ path: rootWorkspace }],
        },
      ]);

      const result = resolveWorkspace(rootWorkspace, appState);

      expect(result).not.toBeNull();
      expect(result!.workspaceName).toBe("workspace");
    });

    it("handles workspace name with slashes (branch-style)", () => {
      // Workspace name encoded as feature%login on filesystem
      const branchWorkspacePath = isWindows
        ? "C:\\Projects\\my-app\\.worktrees\\feature%login"
        : "/home/user/projects/my-app/.worktrees/feature%login";

      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: branchWorkspacePath }],
        },
      ]);

      const result = resolveWorkspace(branchWorkspacePath, appState);

      expect(result).not.toBeNull();
      expect(result!.workspaceName).toBe("feature%login");
    });

    it("generates consistent project IDs for same path", () => {
      const appState = createMockAppState([
        {
          path: projectPath,
          workspaces: [{ path: workspacePath }],
        },
      ]);

      const result1 = resolveWorkspace(workspacePath, appState);
      const result2 = resolveWorkspace(workspacePath, appState);

      expect(result1!.projectId).toBe(result2!.projectId);
    });
  });
});
