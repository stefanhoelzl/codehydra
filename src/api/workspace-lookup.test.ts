/**
 * Focused tests for matching a directory to its workspace.
 */

import { describe, it, expect } from "vitest";
import {
  callerProject,
  findWorkspaceContaining,
  isWithinWorkspace,
  looksLikePath,
  resolveProjectReference,
  resolveWorkspaceReference,
} from "./workspace-lookup";

const WORKSPACES = [
  { name: "feature", path: "/repo/.worktrees/feature" },
  { name: "feature-2", path: "/repo/.worktrees/feature-2" },
  { name: "outer", path: "/repo/.worktrees/outer" },
  { name: "nested", path: "/repo/.worktrees/outer/nested" },
];

const PROJECTS = [
  { name: "repo", path: "/repo", workspaces: WORKSPACES },
  { name: "other", path: "/other", workspaces: [{ name: "feature", path: "/other/wt/feature" }] },
];

describe("isWithinWorkspace", () => {
  it("matches the workspace root itself", () => {
    expect(isWithinWorkspace("/repo/wt", "/repo/wt")).toBe(true);
  });

  it("matches a path inside it", () => {
    expect(isWithinWorkspace("/repo/wt/src/deep", "/repo/wt")).toBe(true);
  });

  it("does not match a sibling whose name merely extends it", () => {
    expect(isWithinWorkspace("/repo/wt-old", "/repo/wt")).toBe(false);
  });
});

describe("findWorkspaceContaining", () => {
  it("finds the workspace a directory sits in", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature/src")).toBe(
      "/repo/.worktrees/feature"
    );
  });

  it("matches the root exactly", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature")).toBe(
      "/repo/.worktrees/feature"
    );
  });

  it("does not let one workspace claim a sibling that extends its name", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature-2/src")).toBe(
      "/repo/.worktrees/feature-2"
    );
  });

  it("prefers the innermost of nested workspaces", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/outer/nested/src")).toBe(
      "/repo/.worktrees/outer/nested"
    );
  });

  it("returns null outside every workspace, rather than failing", () => {
    // A shell standing outside any worktree is a normal caller: the app-global
    // commands are exactly what someone runs there.
    expect(findWorkspaceContaining(WORKSPACES, "/tmp/elsewhere")).toBeNull();
  });

  it("returns null when nothing is open", () => {
    expect(findWorkspaceContaining([], "/repo/.worktrees/feature")).toBeNull();
  });
});

describe("looksLikePath", () => {
  it("treats an absolute path as a path", () => {
    expect(looksLikePath("/repo/.worktrees/feature")).toBe(true);
  });

  it("treats a Windows drive path as a path", () => {
    expect(looksLikePath("C:\\repo\\wt")).toBe(true);
  });

  it("treats a bare word as a name", () => {
    // Names are the ergonomic form — `ch ws delete test-0` beats a worktree path.
    expect(looksLikePath("test-0")).toBe(false);
  });
});

describe("resolveWorkspaceReference", () => {
  it("resolves an unambiguous name", () => {
    expect(resolveWorkspaceReference([PROJECTS[0]!], "nested")).toEqual({
      path: "/repo/.worktrees/outer/nested",
    });
  });

  it("takes a path at its word, even for a workspace not yet listed", () => {
    expect(resolveWorkspaceReference([], "/repo/.worktrees/brand-new")).toEqual({
      path: "/repo/.worktrees/brand-new",
    });
  });

  it("refuses an ambiguous name rather than guessing", () => {
    // "feature" exists in both projects; picking one silently would act on the
    // wrong workspace.
    const result = resolveWorkspaceReference(PROJECTS, "feature");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("2 open workspaces");
    expect(result).toHaveProperty("category", "usage");
  });

  it("prefers the caller's own project for a name both projects have", () => {
    expect(
      resolveWorkspaceReference(PROJECTS, "feature", { callerWorkspace: "/other/wt/feature" })
    ).toEqual({ path: "/other/wt/feature" });
    expect(
      resolveWorkspaceReference(PROJECTS, "feature", { callerWorkspace: "/repo/.worktrees/outer" })
    ).toEqual({ path: "/repo/.worktrees/feature" });
  });

  it("counts a shell in a project's own checkout as that project", () => {
    expect(resolveWorkspaceReference(PROJECTS, "feature", { cwd: "/other/src" })).toEqual({
      path: "/other/wt/feature",
    });
  });

  it("falls back to the other projects when the caller's has no such name", () => {
    expect(
      resolveWorkspaceReference(PROJECTS, "nested", { callerWorkspace: "/other/wt/feature" })
    ).toEqual({ path: "/repo/.worktrees/outer/nested" });
  });

  it("still refuses a name that several other projects have", () => {
    const projects = [
      ...PROJECTS,
      { name: "third", path: "/third", workspaces: [{ name: "x", path: "/third/wt/x" }] },
      { name: "fourth", path: "/fourth", workspaces: [{ name: "x", path: "/fourth/wt/x" }] },
    ];

    const result = resolveWorkspaceReference(projects, "x", {
      callerWorkspace: "/other/wt/feature",
    });

    expect(result).toHaveProperty("category", "usage");
    expect((result as { error: string }).error).toContain("--project");
  });

  it("looks a name up only in the project it is scoped to", () => {
    expect(resolveWorkspaceReference(PROJECTS, "feature", { project: "other" })).toEqual({
      path: "/other/wt/feature",
    });
    expect(
      resolveWorkspaceReference(PROJECTS, "nested", {
        project: "/other",
        callerWorkspace: "/repo/.worktrees/outer",
      })
    ).toMatchObject({ category: "not-found" });
  });

  it("reports a scoping project that is not open", () => {
    expect(resolveWorkspaceReference(PROJECTS, "feature", { project: "absent" })).toMatchObject({
      category: "not-found",
    });
  });

  it("reports a name that matches nothing", () => {
    const result = resolveWorkspaceReference(PROJECTS, "absent");
    expect((result as { error: string }).error).toContain('No open workspace named "absent"');
    expect(result).toHaveProperty("category", "not-found");
  });
});

describe("callerProject", () => {
  it("is the project of the caller's workspace", () => {
    expect(callerProject(PROJECTS, { callerWorkspace: "/other/wt/feature" })?.name).toBe("other");
  });

  it("is the project whose checkout a shell stands in", () => {
    expect(callerProject(PROJECTS, { cwd: "/other" })?.name).toBe("other");
  });

  it("is undefined for a caller outside every project", () => {
    expect(callerProject(PROJECTS, { cwd: "/elsewhere" })).toBeUndefined();
  });
});

describe("resolveProjectReference", () => {
  it("resolves an unambiguous name", () => {
    expect(resolveProjectReference(PROJECTS, "other")).toEqual({ path: "/other" });
  });

  it("takes a path at its word", () => {
    expect(resolveProjectReference(PROJECTS, "/somewhere/else")).toEqual({
      path: "/somewhere/else",
    });
  });

  it("reports a name that matches nothing", () => {
    const result = resolveProjectReference(PROJECTS, "absent");
    expect((result as { error: string }).error).toContain('No open project named "absent"');
  });
});
