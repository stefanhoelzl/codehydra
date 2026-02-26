import { describe, it, expect } from "vitest";
import { extractWorkspaceName } from "./id-utils";

describe("extractWorkspaceName", () => {
  it("extracts basename from standard path", () => {
    expect(extractWorkspaceName("/home/user/projects/.worktrees/feature-1")).toBe("feature-1");
  });

  it("unsanitizes % back to / in workspace name", () => {
    expect(extractWorkspaceName("/workspaces/feature%login")).toBe("feature/login");
  });

  it("handles multiple % segments", () => {
    expect(extractWorkspaceName("/workspaces/user%feature%sub-feature")).toBe(
      "user/feature/sub-feature"
    );
  });

  it("handles Windows-style paths", () => {
    expect(extractWorkspaceName("C:\\Users\\projects\\.worktrees\\feature-1")).toBe("feature-1");
  });

  it("handles Windows-style paths with sanitized name", () => {
    expect(extractWorkspaceName("C:\\Users\\projects\\.worktrees\\feature%login")).toBe(
      "feature/login"
    );
  });

  it("handles trailing slash", () => {
    expect(extractWorkspaceName("/workspaces/feature-1/")).toBe("feature-1");
  });

  it("returns name unchanged when no % present", () => {
    expect(extractWorkspaceName("/workspaces/simple-name")).toBe("simple-name");
  });
});
