// @vitest-environment node
/**
 * Tests for IPC payload validation schemas.
 */

import { describe, it, expect } from "vitest";
import { WorkspaceSwitchPayloadSchema, validate, ValidationError } from "./validation";

describe("WorkspaceSwitchPayloadSchema", () => {
  it("accepts workspacePath without focusWorkspace", () => {
    const payload = { workspacePath: "/test/repo/.worktrees/ws1" };
    const result = validate(WorkspaceSwitchPayloadSchema, payload);

    expect(result.workspacePath).toBe("/test/repo/.worktrees/ws1");
    expect(result.focusWorkspace).toBeUndefined();
  });

  it("accepts focusWorkspace: true", () => {
    const payload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      focusWorkspace: true,
    };
    const result = validate(WorkspaceSwitchPayloadSchema, payload);

    expect(result.workspacePath).toBe("/test/repo/.worktrees/ws1");
    expect(result.focusWorkspace).toBe(true);
  });

  it("accepts focusWorkspace: false", () => {
    const payload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      focusWorkspace: false,
    };
    const result = validate(WorkspaceSwitchPayloadSchema, payload);

    expect(result.workspacePath).toBe("/test/repo/.worktrees/ws1");
    expect(result.focusWorkspace).toBe(false);
  });

  it("rejects invalid workspacePath", () => {
    const payload = { workspacePath: "relative/path", focusWorkspace: false };

    expect(() => validate(WorkspaceSwitchPayloadSchema, payload)).toThrow(ValidationError);
  });

  it("rejects non-boolean focusWorkspace", () => {
    const payload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      focusWorkspace: "false",
    };

    expect(() => validate(WorkspaceSwitchPayloadSchema, payload)).toThrow(ValidationError);
  });
});
