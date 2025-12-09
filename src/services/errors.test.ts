// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  ServiceError,
  GitError,
  WorkspaceError,
  CodeServerError,
  ProjectStoreError,
  OpenCodeError,
  VscodeSetupError,
  isServiceError,
  type SerializedError,
} from "./errors";

describe("ServiceError", () => {
  describe("GitError", () => {
    it("has correct type", () => {
      const error = new GitError("Repository not found");
      expect(error.type).toBe("git");
    });

    it("preserves message", () => {
      const error = new GitError("Repository not found");
      expect(error.message).toBe("Repository not found");
    });

    it("preserves optional code", () => {
      const error = new GitError("Repository not found", "REPO_NOT_FOUND");
      expect(error.code).toBe("REPO_NOT_FOUND");
    });

    it("is instanceof Error", () => {
      const error = new GitError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("is instanceof ServiceError", () => {
      const error = new GitError("test");
      expect(error).toBeInstanceOf(ServiceError);
    });

    it("serializes to JSON", () => {
      const error = new GitError("Repository not found", "REPO_NOT_FOUND");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "git",
        message: "Repository not found",
        code: "REPO_NOT_FOUND",
      });
    });

    it("serializes without code when not provided", () => {
      const error = new GitError("Repository not found");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "git",
        message: "Repository not found",
        code: undefined,
      });
    });
  });

  describe("WorkspaceError", () => {
    it("has correct type", () => {
      const error = new WorkspaceError("Workspace not found");
      expect(error.type).toBe("workspace");
    });

    it("serializes correctly", () => {
      const error = new WorkspaceError("Workspace not found", "NOT_FOUND");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "workspace",
        message: "Workspace not found",
        code: "NOT_FOUND",
      });
    });
  });

  describe("CodeServerError", () => {
    it("has correct type", () => {
      const error = new CodeServerError("Failed to start");
      expect(error.type).toBe("code-server");
    });

    it("serializes correctly", () => {
      const error = new CodeServerError("Failed to start", "START_FAILED");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "code-server",
        message: "Failed to start",
        code: "START_FAILED",
      });
    });
  });

  describe("ProjectStoreError", () => {
    it("has correct type", () => {
      const error = new ProjectStoreError("Failed to save");
      expect(error.type).toBe("project-store");
    });

    it("serializes correctly", () => {
      const error = new ProjectStoreError("Failed to save", "SAVE_FAILED");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "project-store",
        message: "Failed to save",
        code: "SAVE_FAILED",
      });
    });
  });

  describe("OpenCodeError", () => {
    it("has correct type", () => {
      const error = new OpenCodeError("Connection failed");
      expect(error.type).toBe("opencode");
    });

    it("preserves message", () => {
      const error = new OpenCodeError("Connection failed");
      expect(error.message).toBe("Connection failed");
    });

    it("preserves optional code", () => {
      const error = new OpenCodeError("Connection failed", "CONNECTION_REFUSED");
      expect(error.code).toBe("CONNECTION_REFUSED");
    });

    it("is instanceof Error", () => {
      const error = new OpenCodeError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("is instanceof ServiceError", () => {
      const error = new OpenCodeError("test");
      expect(error).toBeInstanceOf(ServiceError);
    });

    it("serializes correctly", () => {
      const error = new OpenCodeError("Connection failed", "CONNECTION_REFUSED");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "opencode",
        message: "Connection failed",
        code: "CONNECTION_REFUSED",
      });
    });
  });
});

describe("VscodeSetupError", () => {
  it("has correct type", () => {
    const error = new VscodeSetupError("Setup failed");
    expect(error.type).toBe("vscode-setup");
  });

  it("preserves message", () => {
    const error = new VscodeSetupError("Setup failed");
    expect(error.message).toBe("Setup failed");
  });

  it("preserves optional code", () => {
    const error = new VscodeSetupError("Setup failed", "NETWORK_ERROR");
    expect(error.code).toBe("NETWORK_ERROR");
  });

  it("is instanceof Error", () => {
    const error = new VscodeSetupError("test");
    expect(error).toBeInstanceOf(Error);
  });

  it("is instanceof ServiceError", () => {
    const error = new VscodeSetupError("test");
    expect(error).toBeInstanceOf(ServiceError);
  });

  it("serializes correctly", () => {
    const error = new VscodeSetupError("Setup failed", "NETWORK_ERROR");
    const json = error.toJSON();

    expect(json).toEqual({
      type: "vscode-setup",
      message: "Setup failed",
      code: "NETWORK_ERROR",
    });
  });

  it("serializes without code when not provided", () => {
    const error = new VscodeSetupError("Setup failed");
    const json = error.toJSON();

    expect(json).toEqual({
      type: "vscode-setup",
      message: "Setup failed",
      code: undefined,
    });
  });
});

describe("ServiceError.fromJSON", () => {
  it("deserializes GitError", () => {
    const json: SerializedError = {
      type: "git",
      message: "Repository not found",
      code: "REPO_NOT_FOUND",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toBe("Repository not found");
    expect(error.code).toBe("REPO_NOT_FOUND");
  });

  it("deserializes WorkspaceError", () => {
    const json: SerializedError = {
      type: "workspace",
      message: "Workspace not found",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toBe("Workspace not found");
  });

  it("deserializes CodeServerError", () => {
    const json: SerializedError = {
      type: "code-server",
      message: "Failed to start",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(CodeServerError);
    expect(error.message).toBe("Failed to start");
  });

  it("deserializes ProjectStoreError", () => {
    const json: SerializedError = {
      type: "project-store",
      message: "Failed to save",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(ProjectStoreError);
    expect(error.message).toBe("Failed to save");
  });

  it("deserializes OpenCodeError", () => {
    const json: SerializedError = {
      type: "opencode",
      message: "Connection failed",
      code: "CONNECTION_REFUSED",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(OpenCodeError);
    expect(error.message).toBe("Connection failed");
    expect(error.code).toBe("CONNECTION_REFUSED");
  });

  it("deserializes VscodeSetupError", () => {
    const json: SerializedError = {
      type: "vscode-setup",
      message: "Setup failed",
      code: "NETWORK_ERROR",
    };

    const error = ServiceError.fromJSON(json);

    expect(error).toBeInstanceOf(VscodeSetupError);
    expect(error.message).toBe("Setup failed");
    expect(error.code).toBe("NETWORK_ERROR");
  });

  it("roundtrips correctly", () => {
    const original = new GitError("Test error", "TEST_CODE");
    const json = original.toJSON();
    const restored = ServiceError.fromJSON(json);

    expect(restored.type).toBe(original.type);
    expect(restored.message).toBe(original.message);
    expect(restored.code).toBe(original.code);
  });
});

describe("isServiceError", () => {
  it("returns true for GitError", () => {
    const error = new GitError("test");
    expect(isServiceError(error)).toBe(true);
  });

  it("returns true for WorkspaceError", () => {
    const error = new WorkspaceError("test");
    expect(isServiceError(error)).toBe(true);
  });

  it("returns true for CodeServerError", () => {
    const error = new CodeServerError("test");
    expect(isServiceError(error)).toBe(true);
  });

  it("returns true for ProjectStoreError", () => {
    const error = new ProjectStoreError("test");
    expect(isServiceError(error)).toBe(true);
  });

  it("returns false for regular Error", () => {
    const error = new Error("test");
    expect(isServiceError(error)).toBe(false);
  });

  it("returns false for non-error objects", () => {
    expect(isServiceError({ message: "test" })).toBe(false);
    expect(isServiceError("test")).toBe(false);
    expect(isServiceError(null)).toBe(false);
    expect(isServiceError(undefined)).toBe(false);
  });
});
