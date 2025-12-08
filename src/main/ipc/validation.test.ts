// @vitest-environment node
/**
 * Tests for IPC payload validation schemas.
 */

import { describe, it, expect } from "vitest";
import {
  WorkspaceSwitchPayloadSchema,
  AgentGetStatusPayloadSchema,
  validate,
  ValidationError,
} from "./validation";

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

describe("AgentGetStatusPayloadSchema", () => {
  it("accepts valid absolute workspacePath", () => {
    const payload = { workspacePath: "/test/repo/.worktrees/ws1" };
    const result = validate(AgentGetStatusPayloadSchema, payload);

    expect(result.workspacePath).toBe("/test/repo/.worktrees/ws1");
  });

  it("rejects relative path", () => {
    const payload = { workspacePath: "relative/path" };

    expect(() => validate(AgentGetStatusPayloadSchema, payload)).toThrow(ValidationError);
  });

  it("rejects path with traversal", () => {
    const payload = { workspacePath: "/test/../etc/passwd" };

    expect(() => validate(AgentGetStatusPayloadSchema, payload)).toThrow(ValidationError);
  });

  it("rejects missing workspacePath", () => {
    const payload = {};

    expect(() => validate(AgentGetStatusPayloadSchema, payload)).toThrow(ValidationError);
  });
});
