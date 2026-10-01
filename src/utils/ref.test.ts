/**
 * Focused tests for workspace and project refs.
 */

import { describe, it, expect } from "vitest";
import {
  asProjectRef,
  asWorkspaceRef,
  isRef,
  makeProjectRef,
  makeWorkspaceRef,
  parseProjectRef,
  parseWorkspaceRef,
  projectRefOf,
  splitWorkspaceReference,
  workspaceNameOf,
} from "./ref";

const isWindows = process.platform === "win32";

describe("makeProjectRef", () => {
  it("names a managed clone by its normalized origin", () => {
    expect(
      makeProjectRef({ kind: "managed", origin: "https://GitHub.com/Org/CodeHydra.git" })
    ).toBe("ch::local::github.com/org/codehydra");
  });

  it("gives the scp and https forms of one origin the same ref", () => {
    expect(makeProjectRef({ kind: "managed", origin: "git@github.com:org/repo.git" })).toBe(
      makeProjectRef({ kind: "managed", origin: "https://github.com/org/repo" })
    );
  });

  it("keeps a non-default port", () => {
    expect(
      makeProjectRef({ kind: "managed", origin: "https://git.example.com:2222/org/repo.git" })
    ).toBe("ch::local::git.example.com:2222/org/repo");
  });

  it.skipIf(isWindows)("names a checkout by its normalized path", () => {
    expect(makeProjectRef({ kind: "checkout", path: "/home/s/proj/" })).toBe(
      "ch::local::/home/s/proj"
    );
  });

  it("takes another machine", () => {
    expect(makeProjectRef({ kind: "managed", origin: "https://x.org/a/b" }, "ssh+box1")).toBe(
      "ch::ssh+box1::x.org/a/b"
    );
  });

  it("rejects a machine name that could hold a separator", () => {
    expect(() => makeProjectRef({ kind: "managed", origin: "https://x.org/a/b" }, "a:b")).toThrow(
      /Invalid machine/
    );
  });
});

describe("makeWorkspaceRef", () => {
  const project = makeProjectRef({ kind: "managed", origin: "https://github.com/org/codehydra" });

  it("appends the name to the project ref", () => {
    expect(makeWorkspaceRef(project, "feature/x")).toBe(
      "ch::local::github.com/org/codehydra::feature/x"
    );
  });

  it("rejects a name with a colon", () => {
    expect(() => makeWorkspaceRef(project, "a:b")).toThrow(/Invalid workspace name/);
  });

  it("rejects an empty name", () => {
    expect(() => makeWorkspaceRef(project, "")).toThrow(/Invalid workspace name/);
  });
});

describe("parseWorkspaceRef", () => {
  it("splits at the first and last separator", () => {
    expect(parseWorkspaceRef("ch::local::github.com/org/codehydra::feature/x")).toEqual({
      machine: "local",
      project: "github.com/org/codehydra",
      kind: "managed",
      projectRef: "ch::local::github.com/org/codehydra",
      name: "feature/x",
    });
  });

  it("keeps a project that itself contains separators verbatim", () => {
    const parts = parseWorkspaceRef("ch::local::/home/s/odd::dir:x::main");
    expect(parts?.project).toBe("/home/s/odd::dir:x");
    expect(parts?.kind).toBe("checkout");
    expect(parts?.name).toBe("main");
  });

  it("recognizes a Windows checkout", () => {
    expect(parseWorkspaceRef("ch::local::c:/users/s/proj::main")?.kind).toBe("checkout");
  });

  it("keeps a port in a managed project", () => {
    expect(parseWorkspaceRef("ch::local::git.example.com:2222/org/repo::main")?.project).toBe(
      "git.example.com:2222/org/repo"
    );
  });

  it.each([
    ["a name", "feature/x"],
    ["a path", "/home/s/proj"],
    ["a project ref without a workspace part", "ch::local::github.com"],
    ["an empty name", "ch::local::github.com/org/x::"],
    ["a bad machine", "ch::Local Box::github.com/org/x::main"],
  ])("rejects %s", (_label, value) => {
    expect(parseWorkspaceRef(value)).toBeNull();
  });
});

describe("parseProjectRef", () => {
  it("reads machine and project", () => {
    expect(parseProjectRef("ch::local::github.com/org/x")).toEqual({
      machine: "local",
      project: "github.com/org/x",
      kind: "managed",
    });
  });

  it("rejects what is not a ref", () => {
    expect(parseProjectRef("/home/s/proj")).toBeNull();
    expect(parseProjectRef("ch::local")).toBeNull();
  });
});

describe("helpers", () => {
  const ref = "ch::local::github.com/org/x::feature/y";

  it("tells refs from names and paths", () => {
    expect(isRef(ref)).toBe(true);
    expect(isRef("feature/y")).toBe(false);
    expect(isRef("/home/s/proj")).toBe(false);
  });

  it("brands valid refs and refuses others", () => {
    expect(asWorkspaceRef(ref)).toBe(ref);
    expect(asWorkspaceRef("feature/y")).toBeNull();
    expect(asProjectRef("ch::local::github.com/org/x")).toBe("ch::local::github.com/org/x");
    expect(asProjectRef("x")).toBeNull();
  });

  it("reads project and name back out of a workspace ref", () => {
    const workspace = asWorkspaceRef(ref)!;
    expect(projectRefOf(workspace)).toBe("ch::local::github.com/org/x");
    expect(workspaceNameOf(workspace)).toBe("feature/y");
  });
});

describe("splitWorkspaceReference", () => {
  it("reads a bare name as the caller's own project", () => {
    expect(splitWorkspaceReference("feature/x")).toEqual({ project: null, name: "feature/x" });
  });

  it("splits a project and a name at the last separator", () => {
    expect(splitWorkspaceReference("github.com/org/x::main")).toEqual({
      project: "github.com/org/x",
      name: "main",
    });
    expect(splitWorkspaceReference("/home/s/odd::dir::main")).toEqual({
      project: "/home/s/odd::dir",
      name: "main",
    });
  });
});
