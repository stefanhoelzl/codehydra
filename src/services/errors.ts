/**
 * Service error definitions with serialization support for IPC.
 */

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
    | "vscode-setup";
  readonly message: string;
  readonly code?: string;
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

  /**
   * Deserialize an error from IPC transport.
   * Recreates the appropriate ServiceError subclass based on the type field.
   *
   * @param json Serialized error object from IPC
   * @returns A ServiceError subclass instance matching the original error type
   *
   * @example
   * ```typescript
   * // In renderer process, receiving error from main process
   * const serialized = await ipcRenderer.invoke('some-operation');
   * if (serialized.type) {
   *   const error = ServiceError.fromJSON(serialized);
   *   if (error instanceof GitError) {
   *     // Handle git-specific error
   *   }
   * }
   * ```
   */
  static fromJSON(json: SerializedError): ServiceError {
    switch (json.type) {
      case "git":
        return new GitError(json.message, json.code);
      case "workspace":
        return new WorkspaceError(json.message, json.code);
      case "code-server":
        return new CodeServerError(json.message, json.code);
      case "project-store":
        return new ProjectStoreError(json.message, json.code);
      case "opencode":
        return new OpenCodeError(json.message, json.code);
      case "vscode-setup":
        return new VscodeSetupError(json.message, json.code);
    }
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
 * Type guard to check if an error is a ServiceError.
 */
export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
