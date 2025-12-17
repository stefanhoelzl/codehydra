/**
 * Code-server related type definitions.
 * All properties are readonly for immutability.
 */

/**
 * State of a code-server instance.
 * String literal union for IPC serialization (not enum).
 */
export type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

/**
 * Configuration for code-server instance.
 */
export interface CodeServerConfig {
  /** Absolute path to the code-server binary */
  readonly binaryPath: string;
  /** Directory for runtime files (sockets, pid files) */
  readonly runtimeDir: string;
  /** Directory for VS Code extensions */
  readonly extensionsDir: string;
  /** Directory for VS Code user data */
  readonly userDataDir: string;
  /** Directory for CLI wrapper scripts (added to PATH) */
  readonly binDir: string;
}

/**
 * Information about a running code-server instance.
 */
export interface CodeServerInfo {
  /** Port the server is listening on */
  readonly port: number;
  /** Full URL to access the server */
  readonly url: string;
}
