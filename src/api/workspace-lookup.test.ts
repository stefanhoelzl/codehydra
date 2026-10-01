/**
 * Focused tests for turning references and directories into workspace and project refs.
 */

import { describe, it, expect } from "vitest";
import {
  callerProject,
  findWorkspaceContaining,
  isWithinWorkspace,
  looksLikePath,
  resolveProjectReference,
  resolveWorkspaceReference,
  workspaceAtPath,
  type ProjectLocation,
} from "./workspace-lookup";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";

const REPO = projectRefFor("/repo");
const OTHER = projectRefFor("/other");
const MANAGED = projectRefFor("/data/remotes/codehydra", "https://github.com/org/codehydra.git");

function ws(project: ReturnType<typeof projectRefFor>, name: string, path: string) {
  return { ref: makeWorkspaceRef(project, name), name, path };
}

const WORKSPACES = [
  ws(REPO, "feature", "/repo/.worktrees/feature"),
  ws(REPO, "feature-2", "/repo/.worktrees/feature-2"),
  ws(REPO, "outer", "/repo/.worktrees/outer"),
  ws(REPO, "nested", "/repo/.worktrees/outer/nested"),
];

const PROJECTS: ProjectLocation[] = [
  { ref: REPO, name: "repo", path: "/repo", workspaces: WORKSPACES },
  {
    ref: OTHER,
    name: "other",
    path: "/other",
    workspaces: [ws(OTHER, "feature", "/other/wt/feature")],
  },
  {
    ref: MANAGED,
    name: "codehydra",
    path: "/data/remotes/codehydra",
    workspaces: [ws(MANAGED, "main", "/data/ws/main")],
  },
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
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature/src")).toBe(WORKSPACES[0]);
  });

  it("matches the root exactly", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature")).toBe(WORKSPACES[0]);
  });

  it("does not let one workspace claim a sibling that extends its name", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/feature-2/src")).toBe(
      WORKSPACES[1]
    );
  });

  it("prefers the innermost of nested workspaces", () => {
    expect(findWorkspaceContaining(WORKSPACES, "/repo/.worktrees/outer/nested/src")).toBe(
      WORKSPACES[3]
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

describe("workspaceAtPath", () => {
  it("gives the ref of the workspace containing a directory", () => {
    expect(workspaceAtPath(PROJECTS, "/other/wt/feature/src")).toBe(
      makeWorkspaceRef(OTHER, "feature")
    );
  });

  it("is null outside every workspace", () => {
    expect(workspaceAtPath(PROJECTS, "/other/src")).toBeNull();
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
    // Names are the ergonomic form — `ch ws delete test-0` beats a full ref.
    expect(looksLikePath("test-0")).toBe(false);
  });
});

describe("resolveWorkspaceReference", () => {
  it("resolves an unambiguous name", () => {
    expect(resolveWorkspaceReference([PROJECTS[0]!], "nested")).toEqual({
      ref: makeWorkspaceRef(REPO, "nested"),
    });
  });

  it("takes a full ref at its word, even for a workspace not yet listed", () => {
    const ref = makeWorkspaceRef(REPO, "brand-new");
    expect(resolveWorkspaceReference([], ref)).toEqual({ ref });
  });

  it("refuses something written as a ref that is not a workspace ref", () => {
    expect(resolveWorkspaceReference(PROJECTS, REPO)).toMatchObject({ category: "usage" });
  });

  it("refuses a workspace named by its path", () => {
    const result = resolveWorkspaceReference(PROJECTS, "/repo/.worktrees/feature");
    expect(result).toHaveProperty("category", "usage");
    expect((result as { error: string }).error).toContain("is a path");
  });

  it("resolves <project>::<name> with the project as a name, a path, or an origin", () => {
    const expected = { ref: makeWorkspaceRef(OTHER, "feature") };
    expect(resolveWorkspaceReference(PROJECTS, "other::feature")).toEqual(expected);
    expect(resolveWorkspaceReference(PROJECTS, "/other::feature")).toEqual(expected);
    expect(resolveWorkspaceReference(PROJECTS, "github.com/org/codehydra::main")).toEqual({
      ref: makeWorkspaceRef(MANAGED, "main"),
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
      resolveWorkspaceReference(PROJECTS, "feature", {
        callerWorkspace: makeWorkspaceRef(OTHER, "feature"),
      })
    ).toEqual({ ref: makeWorkspaceRef(OTHER, "feature") });
    expect(
      resolveWorkspaceReference(PROJECTS, "feature", {
        callerWorkspace: makeWorkspaceRef(REPO, "outer"),
      })
    ).toEqual({ ref: makeWorkspaceRef(REPO, "feature") });
  });

  it("counts a shell in a project's own checkout as that project", () => {
    expect(resolveWorkspaceReference(PROJECTS, "feature", { cwd: "/other/src" })).toEqual({
      ref: makeWorkspaceRef(OTHER, "feature"),
    });
  });

  it("falls back to the other projects when the caller's has no such name", () => {
    expect(
      resolveWorkspaceReference(PROJECTS, "nested", {
        callerWorkspace: makeWorkspaceRef(OTHER, "feature"),
      })
    ).toEqual({ ref: makeWorkspaceRef(REPO, "nested") });
  });

  it("still refuses a name that several other projects have", () => {
    const third = projectRefFor("/third");
    const fourth = projectRefFor("/fourth");
    const projects: ProjectLocation[] = [
      ...PROJECTS,
      { ref: third, name: "third", path: "/third", workspaces: [ws(third, "x", "/third/wt/x")] },
      {
        ref: fourth,
        name: "fourth",
        path: "/fourth",
        workspaces: [ws(fourth, "x", "/fourth/wt/x")],
      },
    ];

    const result = resolveWorkspaceReference(projects, "x", {
      callerWorkspace: makeWorkspaceRef(OTHER, "feature"),
    });

    expect(result).toHaveProperty("category", "usage");
    expect((result as { error: string }).error).toContain("--project");
  });

  it("looks a name up only in the project it is scoped to", () => {
    expect(resolveWorkspaceReference(PROJECTS, "feature", { project: "other" })).toEqual({
      ref: makeWorkspaceRef(OTHER, "feature"),
    });
    expect(
      resolveWorkspaceReference(PROJECTS, "nested", {
        project: "/other",
        callerWorkspace: makeWorkspaceRef(REPO, "outer"),
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
    expect(
      callerProject(PROJECTS, { callerWorkspace: makeWorkspaceRef(OTHER, "feature") })?.name
    ).toBe("other");
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
    expect(resolveProjectReference(PROJECTS, "other")).toEqual({ ref: OTHER });
  });

  it("resolves an open checkout by its path", () => {
    expect(resolveProjectReference(PROJECTS, "/other")).toEqual({ ref: OTHER });
  });

  it("resolves a managed project by its origin, in any form git accepts", () => {
    expect(resolveProjectReference(PROJECTS, "github.com/org/codehydra")).toEqual({
      ref: MANAGED,
    });
    expect(resolveProjectReference(PROJECTS, "git@github.com:Org/CodeHydra.git")).toEqual({
      ref: MANAGED,
    });
  });

  it("takes a full ref at its word", () => {
    const ref = projectRefFor("/somewhere/else");
    expect(resolveProjectReference(PROJECTS, ref)).toEqual({ ref });
  });

  it("refuses an ambiguous name", () => {
    const twin = projectRefFor("/elsewhere/other");
    const projects: ProjectLocation[] = [
      ...PROJECTS,
      { ref: twin, name: "other", path: "/elsewhere/other", workspaces: [] },
    ];
    expect(resolveProjectReference(projects, "other")).toMatchObject({ category: "usage" });
  });

  it("reports a name that matches nothing", () => {
    const result = resolveProjectReference(PROJECTS, "absent");
    expect((result as { error: string }).error).toContain('No open project named "absent"');
  });
});
