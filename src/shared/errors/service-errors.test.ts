// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  ServiceError,
  GitError,
  WorkspaceError,
  IdeServerError,
  ProjectStoreError,
  OpenCodeError,
  FileSystemError,
  KNOWN_FILESYSTEM_ERROR_CODES,
  getErrorMessage,
} from "./service-errors";

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

  describe("IdeServerError", () => {
    it("has correct type", () => {
      const error = new IdeServerError("Failed to start");
      expect(error.type).toBe("ide-server");
    });

    it("serializes correctly", () => {
      const error = new IdeServerError("Failed to start", "START_FAILED");
      const json = error.toJSON();

      expect(json).toEqual({
        type: "ide-server",
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

describe("FileSystemError", () => {
  it("has correct type", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error.type).toBe("filesystem");
  });

  it("preserves message", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error.message).toBe("File not found");
  });

  it("preserves fsCode", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error.fsCode).toBe("ENOENT");
  });

  it("preserves path", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error.path).toBe("/path/to/file");
  });

  it("preserves cause when provided", () => {
    const cause = new Error("Original error");
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found", cause);
    expect(error.cause).toBe(cause);
  });

  it("preserves originalCode when provided", () => {
    const error = new FileSystemError(
      "UNKNOWN",
      "/path/to/file",
      "Unknown error",
      undefined,
      "ENOSPC"
    );
    expect(error.originalCode).toBe("ENOSPC");
  });

  it("is instanceof Error", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error).toBeInstanceOf(Error);
  });

  it("is instanceof ServiceError", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    expect(error).toBeInstanceOf(ServiceError);
  });

  it("serializes to JSON with all fields", () => {
    const error = new FileSystemError("ENOENT", "/path/to/file", "File not found");
    const json = error.toJSON();

    expect(json).toEqual({
      type: "filesystem",
      message: "File not found",
      path: "/path/to/file",
      code: "ENOENT",
    });
  });

  it("does not list UNKNOWN as a known POSIX code", () => {
    // UNKNOWN is the fallback, not a code the filesystem boundary recognises.
    // If it leaked into the tuple, mapError would treat a literal "UNKNOWN"
    // errno as a recognised code.
    expect(KNOWN_FILESYSTEM_ERROR_CODES).not.toContain("UNKNOWN");
  });

  it("serializes all error codes correctly", () => {
    // Derived from the single source of truth, so a newly added code is covered
    // here automatically and cannot be silently omitted.
    const codes = [...KNOWN_FILESYSTEM_ERROR_CODES, "UNKNOWN"] as const;

    for (const code of codes) {
      const path = `/test/${code}`;
      const error = new FileSystemError(code, path, `Test error for ${code}`);
      const json = error.toJSON();
      expect(json.code).toBe(code);
      expect(json.path).toBe(path);
    }
  });
});

describe("getErrorMessage", () => {
  it("extracts message from Error instance", () => {
    const error = new Error("Something went wrong");
    expect(getErrorMessage(error)).toBe("Something went wrong");
  });

  it("extracts message from ServiceError subclass", () => {
    const error = new GitError("Repository not found");
    expect(getErrorMessage(error)).toBe("Repository not found");
  });

  it("converts string to string", () => {
    expect(getErrorMessage("plain string error")).toBe("plain string error");
  });

  it("converts number to string", () => {
    expect(getErrorMessage(404)).toBe("404");
  });

  it("converts null to string", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("converts undefined to string", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("converts object to string", () => {
    expect(getErrorMessage({ code: "ERR" })).toBe("[object Object]");
  });
});
