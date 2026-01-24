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
  /** Port for code-server to listen on */
  readonly port: number;
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
  /** Optional port for the PluginServer (CODEHYDRA_PLUGIN_PORT env var) */
  readonly pluginPort?: number;
  /** Directory containing code-server installation (for CODEHYDRA_CODE_SERVER_DIR env var) */
  readonly codeServerDir: string;
  /** Directory containing opencode binary (for CODEHYDRA_OPENCODE_DIR env var) */
  readonly opencodeDir: string;
}
