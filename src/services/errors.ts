/**
 * Service error definitions with serialization support for IPC.
 */

import type { FileSystemErrorCode } from "./platform/filesystem";

// Re-export getErrorMessage for internal services use
export { getErrorMessage } from "../shared/error-utils";

/**
 * Error codes for binary download operations.
 */
export type BinaryDownloadErrorCode =
  | "NETWORK_ERROR"
  | "EXTRACTION_FAILED"
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_VERSION";

/**
 * Error codes for archive extraction operations.
 */
export type ArchiveErrorCode = "INVALID_ARCHIVE" | "EXTRACTION_FAILED" | "PERMISSION_DENIED";

/**
 * Serialized error format for IPC transport.
 */
export interface SerializedError {
  readonly type:
    | "git"
    | "workspace"
    | "code-server"
    | "project-store"
    | "opencode"
    | "vscode-setup"
    | "filesystem"
    | "binary-download"
    | "archive";
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
}

/**
 * Base class for all service errors.
 * Provides serialization for IPC communication.
 */
export abstract class ServiceError extends Error {
  abstract readonly type: SerializedError["type"];
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code ?? undefined;
    // Fix prototype chain for instanceof to work
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialize the error for IPC transport.
   */
  toJSON(): SerializedError {
    const result: SerializedError = {
      type: this.type,
      message: this.message,
    };
    if (this.code !== undefined) {
      return { ...result, code: this.code };
    }
    return result;
  }
}

/**
 * Error from git operations.
 */
export class GitError extends ServiceError {
  readonly type = "git" as const;
}

/**
 * Error from workspace operations.
 */
export class WorkspaceError extends ServiceError {
  readonly type = "workspace" as const;
}

/**
 * Error from code-server operations.
 */
export class CodeServerError extends ServiceError {
  readonly type = "code-server" as const;
}

/**
 * Error from project store operations.
 */
export class ProjectStoreError extends ServiceError {
  readonly type = "project-store" as const;
}

/**
 * Error from OpenCode integration operations.
 */
export class OpenCodeError extends ServiceError {
  readonly type = "opencode" as const;
}

/**
 * Error from VS Code setup operations.
 */
export class VscodeSetupError extends ServiceError {
  readonly type = "vscode-setup" as const;
}

/**
 * Error from binary download operations (code-server, opencode).
 */
export class BinaryDownloadError extends ServiceError {
  readonly type = "binary-download" as const;

  constructor(
    message: string,
    readonly errorCode?: BinaryDownloadErrorCode
  ) {
    super(message, errorCode);
    this.name = "BinaryDownloadError";
  }
}

/**
 * Error from archive extraction operations (tar.gz, zip).
 */
export class ArchiveError extends ServiceError {
  readonly type = "archive" as const;

  constructor(
    message: string,
    readonly errorCode?: ArchiveErrorCode
  ) {
    super(message, errorCode);
    this.name = "ArchiveError";
  }
}

/**
 * Error from filesystem operations.
 * Extends ServiceError for IPC serialization.
 */
export class FileSystemError extends ServiceError {
  readonly type = "filesystem" as const;

  constructor(
    /** Mapped error code */
    readonly fsCode: FileSystemErrorCode,
    /** Path that caused the error */
    readonly path: string,
    message: string,
    /** Original error for debugging */
    readonly cause?: Error,
    /** Original Node.js error code (e.g., "EMFILE", "ENOSPC") */
    readonly originalCode?: string
  ) {
    super(message, fsCode);
    this.name = "FileSystemError";
  }

  override toJSON(): SerializedError {
    return {
      type: this.type,
      message: this.message,
      path: this.path,
      code: this.fsCode,
    };
  }
}

/**
 * Type guard to check if an error is a ServiceError.
 */
export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
