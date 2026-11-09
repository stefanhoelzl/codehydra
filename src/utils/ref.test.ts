/**
 * Focused tests for workspace and project refs.
 */

import { describe, it, expect } from "vitest";
import {
  asProjectRef,
  asWorkspaceRef,
  isRef,
  isValidProjectType,
  makeProjectRef,
  makeWorkspaceRef,
  parseProjectRef,
  parseWorkspaceRef,
  projectNameOf,
  projectRefOf,
  splitTypedProjectReference,
  splitWorkspaceReference,
  workspaceNameOf,
} from "./ref";

describe("makeProjectRef", () => {
  it("names the machine, the type and the identifier", () => {
    expect(makeProjectRef("git", "github.com/org/codehydra")).toBe(
      "ch::local::git::github.com/org/codehydra"
    );
  });

  it("keeps the identifier verbatim", () => {
    expect(makeProjectRef("git", "/home/s/odd::dir:x")).toBe("ch::local::git::/home/s/odd::dir:x");
  });

  it("takes another machine", () => {
    expect(makeProjectRef("git", "x.org/a/b", "ssh+box1")).toBe("ch::ssh+box1::git::x.org/a/b");
  });

  it("rejects a machine name that could hold a separator", () => {
    expect(() => makeProjectRef("git", "x.org/a/b", "a:b")).toThrow(/Invalid machine/);
  });

  it.each(["Git", "1git", "a.b", "a/b", "c:", ""])("rejects the type %j", (type) => {
    expect(() => makeProjectRef(type, "x")).toThrow(/Invalid project type/);
  });

  it("rejects an empty identifier", () => {
    expect(() => makeProjectRef("git", "")).toThrow(/identifier/);
  });
});

describe("isValidProjectType", () => {
  it("takes lower-case names starting with a letter", () => {
    expect(isValidProjectType("git")).toBe(true);
    expect(isValidProjectType("my-type2")).toBe(true);
  });

  it.each(["github.com/org/x", "/home/s/x", "c:/users/s/x", "localhost/x", "Git", "-x"])(
    "never takes what an old ref's project part can be: %s",
    (value) => {
      expect(isValidProjectType(value)).toBe(false);
    }
  );
});

describe("makeWorkspaceRef", () => {
  const project = makeProjectRef("git", "github.com/org/codehydra");

  it("appends the name to the project ref", () => {
    expect(makeWorkspaceRef(project, "feature/x")).toBe(
      "ch::local::git::github.com/org/codehydra::feature/x"
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
  it("reads machine, type, identifier and name", () => {
    expect(parseWorkspaceRef("ch::local::git::github.com/org/codehydra::feature/x")).toEqual({
      machine: "local",
      type: "git",
      identifier: "github.com/org/codehydra",
      projectRef: "ch::local::git::github.com/org/codehydra",
      name: "feature/x",
    });
  });

  it("keeps an identifier that itself contains separators verbatim", () => {
    const parts = parseWorkspaceRef("ch::local::git::/home/s/odd::dir:x::main");
    expect(parts?.identifier).toBe("/home/s/odd::dir:x");
    expect(parts?.name).toBe("main");
  });

  it("keeps a Windows path and a port", () => {
    expect(parseWorkspaceRef("ch::local::git::c:/users/s/proj::main")?.identifier).toBe(
      "c:/users/s/proj"
    );
    expect(
      parseWorkspaceRef("ch::local::git::git.example.com:2222/org/repo::main")?.identifier
    ).toBe("git.example.com:2222/org/repo");
  });

  it("reads another type", () => {
    expect(parseWorkspaceRef("ch::local::my-type::PROJ-1::main")).toMatchObject({
      type: "my-type",
      identifier: "PROJ-1",
      projectRef: "ch::local::my-type::PROJ-1",
    });
  });

  it.each([
    ["a name", "feature/x"],
    ["a path", "/home/s/proj"],
    ["a project ref without a workspace part", "ch::local::git::github.com"],
    ["an empty name", "ch::local::git::github.com/org/x::"],
    ["a bad machine", "ch::Local Box::git::github.com/org/x::main"],
  ])("rejects %s", (_label, value) => {
    expect(parseWorkspaceRef(value)).toBeNull();
  });
});

describe("refs from before project types", () => {
  it.each([
    ["a managed clone", "ch::local::github.com/org/x", "github.com/org/x"],
    [
      "an origin with a port",
      "ch::local::git.example.com:2222/org/x",
      "git.example.com:2222/org/x",
    ],
    ["an origin without a dot", "ch::local::localhost/x", "localhost/x"],
    ["an IPv6 origin", "ch::local::[::1]/repo", "[::1]/repo"],
    ["a checkout", "ch::local::/home/s/proj", "/home/s/proj"],
    ["a Windows checkout", "ch::local::c:/users/s/proj", "c:/users/s/proj"],
    ["a checkout holding separators", "ch::local::/home/s/odd::dir", "/home/s/odd::dir"],
  ])("read %s as git", (_label, value, identifier) => {
    expect(parseProjectRef(value)).toEqual({ machine: "local", type: "git", identifier });
    expect(asProjectRef(value)).toBe(`ch::local::git::${identifier}`);
  });

  it("read a workspace ref as git, in today's form", () => {
    const old = "ch::local::github.com/org/x::feature/y";
    expect(parseWorkspaceRef(old)?.projectRef).toBe("ch::local::git::github.com/org/x");
    expect(asWorkspaceRef(old)).toBe("ch::local::git::github.com/org/x::feature/y");
    expect(asWorkspaceRef("ch::local::/home/s/proj::main")).toBe(
      "ch::local::git::/home/s/proj::main"
    );
    expect(asWorkspaceRef("ch::local::c:/users/s/proj::main")).toBe(
      "ch::local::git::c:/users/s/proj::main"
    );
  });

  it("leave a ref already in today's form as it is", () => {
    const ref = "ch::local::git::github.com/org/x";
    expect(asProjectRef(ref)).toBe(ref);
    expect(asWorkspaceRef(`${ref}::main`)).toBe(`${ref}::main`);
  });

  it("do not read a project ref of today as a workspace", () => {
    expect(parseWorkspaceRef("ch::local::git::github.com/org/x")).toBeNull();
    expect(parseWorkspaceRef("ch::local::git::/home/s/proj")).toBeNull();
  });
});

describe("parseProjectRef", () => {
  it("reads machine, type and identifier", () => {
    expect(parseProjectRef("ch::local::git::github.com/org/x")).toEqual({
      machine: "local",
      type: "git",
      identifier: "github.com/org/x",
    });
  });

  it("rejects what is not a ref", () => {
    expect(parseProjectRef("/home/s/proj")).toBeNull();
    expect(parseProjectRef("ch::local")).toBeNull();
    expect(parseProjectRef("ch::local::git")).toBeNull();
    expect(parseProjectRef("ch::local::git::")).toBeNull();
  });
});

describe("helpers", () => {
  const ref = "ch::local::git::github.com/org/x::feature/y";

  it("tells refs from names and paths", () => {
    expect(isRef(ref)).toBe(true);
    expect(isRef("feature/y")).toBe(false);
    expect(isRef("/home/s/proj")).toBe(false);
  });

  it("brands valid refs and refuses others", () => {
    expect(asWorkspaceRef(ref)).toBe(ref);
    expect(asWorkspaceRef("feature/y")).toBeNull();
    expect(asProjectRef("ch::local::git::github.com/org/x")).toBe(
      "ch::local::git::github.com/org/x"
    );
    expect(asProjectRef("x")).toBeNull();
  });

  it("reads project and name back out of a workspace ref", () => {
    const workspace = asWorkspaceRef(ref)!;
    expect(projectRefOf(workspace)).toBe("ch::local::git::github.com/org/x");
    expect(workspaceNameOf(workspace)).toBe("feature/y");
  });

  it("names a project by the last part of its identifier", () => {
    expect(projectNameOf(makeProjectRef("git", "github.com/org/codehydra"))).toBe("codehydra");
    expect(projectNameOf(makeProjectRef("git", "/home/s/codehydra"))).toBe("codehydra");
    expect(projectNameOf(makeProjectRef("my-type", "PROJ-1"))).toBe("PROJ-1");
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
    expect(splitWorkspaceReference("my-type::PROJ-1::main")).toEqual({
      project: "my-type::PROJ-1",
      name: "main",
    });
  });
});

describe("splitTypedProjectReference", () => {
  const types = new Set(["git", "my-type"]);

  it("splits a reference starting with a known type", () => {
    expect(splitTypedProjectReference("my-type::PROJ-1", types)).toEqual({
      type: "my-type",
      identifier: "PROJ-1",
    });
    expect(splitTypedProjectReference("git::/home/s/odd::dir", types)).toEqual({
      type: "git",
      identifier: "/home/s/odd::dir",
    });
  });

  it.each([
    ["no separator", "github.com/org/x"],
    ["an unknown type", "other::x"],
    ["an empty identifier", "git::"],
    ["an empty type", "::x"],
  ])("is null for %s", (_label, value) => {
    expect(splitTypedProjectReference(value, types)).toBeNull();
  });
});
