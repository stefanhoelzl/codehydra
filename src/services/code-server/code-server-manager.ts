/**
 * CodeServerManager - Manages code-server instances.
 * Handles starting, stopping, and health checking of code-server processes.
 */

import { join, delimiter } from "node:path";
import type { CodeServerConfig, InstanceState } from "./types";
import type { ProcessRunner, SpawnedProcess } from "../platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../platform/process";
import type { HttpClient, PortManager } from "../platform/network";
import { encodePathForUrl } from "../platform/paths";
import { CodeServerError, getErrorMessage } from "../errors";
import type { Logger } from "../logging";
import { waitForHealthy } from "../platform/health-check";

/**
 * Function to unsubscribe from PID change events.
 */
type Unsubscribe = () => void;

/**
 * Callback for PID change events.
 */
type PidChangedCallback = (pid: number | null) => void;

/**
 * Normalize a path for use in code-server URLs.
 * Handles Windows path conversion and URL encoding.
 *
 * @param path Absolute path to normalize
 * @returns URL-safe encoded path
 */
function normalizePathForUrl(path: string): string {
  // Handle Windows paths: C:\Users\... -> /C:/Users/...
  let normalizedPath = path;
  if (/^[A-Za-z]:/.test(path)) {
    // Windows absolute path - convert backslashes and prefix with /
    normalizedPath = "/" + path.replace(/\\/g, "/");
  }

  // Encode the path but preserve colons for Windows drive letters
  return encodePathForUrl(normalizedPath).replace(/%3A/g, ":");
}

/**
 * Generate URL for opening a folder in code-server.
 *
 * @param port The port code-server is running on
 * @param folderPath Absolute path to the folder to open
 * @returns Full URL with folder query parameter
 */
export function urlForFolder(port: number, folderPath: string): string {
  const encodedPath = normalizePathForUrl(folderPath);
  return `http://127.0.0.1:${port}/?folder=${encodedPath}`;
}

/**
 * Generate URL for opening a .code-workspace file in code-server.
 *
 * @param port The port code-server is running on
 * @param workspaceFilePath Absolute path to the .code-workspace file
 * @returns Full URL with workspace query parameter
 */
export function urlForWorkspace(port: number, workspaceFilePath: string): string {
  const encodedPath = normalizePathForUrl(workspaceFilePath);
  return `http://127.0.0.1:${port}/?workspace=${encodedPath}`;
}

/**
 * Manager for a code-server instance.
 * Handles lifecycle management including start, stop, and health checks.
 */
export class CodeServerManager {
  private readonly config: CodeServerConfig;
  private readonly processRunner: ProcessRunner;
  private readonly httpClient: HttpClient;
  private readonly portManager: PortManager;
  private readonly logger: Logger;
  private state: InstanceState = "stopped";
  private currentPort: number | null = null;
  private currentPid: number | null = null;
  private process: SpawnedProcess | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly pidListeners = new Set<PidChangedCallback>();

  constructor(
    config: CodeServerConfig,
    processRunner: ProcessRunner,
    httpClient: HttpClient,
    portManager: PortManager,
    logger: Logger
  ) {
    this.config = config;
    this.processRunner = processRunner;
    this.httpClient = httpClient;
    this.portManager = portManager;
    this.logger = logger;
  }

  /**
   * Subscribe to PID change events.
   * Called when the server starts (with PID) or stops (with null).
   *
   * @param callback - Function to call when PID changes
   * @returns Unsubscribe function to remove the listener
   */
  onPidChanged(callback: PidChangedCallback): Unsubscribe {
    this.pidListeners.add(callback);
    return () => this.pidListeners.delete(callback);
  }

  /**
   * Notify all listeners of a PID change.
   */
  private notifyPidChanged(pid: number | null): void {
    for (const listener of this.pidListeners) {
      listener(pid);
    }
  }

  /**
   * Check if the server is currently running.
   */
  isRunning(): boolean {
    return this.state === "running";
  }

  /**
   * Get the current port, or null if not running.
   */
  port(): number | null {
    return this.currentPort;
  }

  /**
   * Get the current process ID, or null if not running.
   */
  pid(): number | null {
    return this.currentPid;
  }

  /**
   * Get the current state of the server.
   */
  getState(): InstanceState {
    return this.state;
  }

  /**
   * Ensure the server is running.
   * If already running, returns the current port.
   * If starting, waits for startup to complete.
   *
   * @returns Promise resolving to the port number
   * @throws CodeServerError if startup fails
   */
  async ensureRunning(): Promise<number> {
    // If already running, return current port
    if (this.state === "running" && this.currentPort !== null) {
      return this.currentPort;
    }

    // If already starting, wait for that promise
    if (this.state === "starting" && this.startPromise !== null) {
      return this.startPromise;
    }

    // Start the server
    this.state = "starting";
    this.startPromise = this.doStart();

    try {
      const port = await this.startPromise;
      this.state = "running";
      return port;
    } catch (error: unknown) {
      this.state = "failed";
      this.startPromise = null;
      throw error;
    }
  }

  private async doStart(): Promise<number> {
    this.logger.info("Starting code-server");

    // Find an available port
    const port = await this.portManager.findFreePort();
    this.currentPort = port;

    // Build command arguments
    const args = [
      "--port",
      port.toString(),
      "--auth",
      "none",
      "--disable-workspace-trust",
      "--extensions-dir",
      this.config.extensionsDir,
      "--user-data-dir",
      this.config.userDataDir,
    ];

    // Spawn the process
    try {
      // Create clean environment without VS Code/code-server variables.
      // When running inside a code-server terminal, these env vars can
      // interfere with the nested code-server instance. Removing them
      // allows code-server to start as a standalone server.
      const cleanEnv = { ...process.env };

      // Remove all VSCODE_* variables - they interfere with nested code-server
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("VSCODE_")) {
          delete cleanEnv[key];
        }
      }

      // Prepend binDir to PATH so CLI tools are available in terminal
      // Handle both PATH (Unix/most Windows) and Path (some Windows configs)
      const existingPath = cleanEnv.PATH ?? cleanEnv.Path ?? "";
      cleanEnv.PATH = this.config.binDir + delimiter + existingPath;
      // Remove lowercase Path to avoid duplicates on Windows
      delete cleanEnv.Path;

      // Set EDITOR and GIT_SEQUENCE_EDITOR for git operations
      // Uses absolute path to the code wrapper with flags for proper behavior:
      // --wait: Don't return until the file is closed
      // --reuse-window: Open in existing window instead of creating new one
      const isWindows = process.platform === "win32";
      const codeCmd = isWindows
        ? `"${join(this.config.binDir, "code.cmd")}"`
        : join(this.config.binDir, "code");
      const editorValue = `${codeCmd} --wait --reuse-window`;
      cleanEnv.EDITOR = editorValue;
      cleanEnv.GIT_SEQUENCE_EDITOR = editorValue;

      // Disable code-server's localhost URL rewriting by setting empty proxy URI.
      // Without this, code-server rewrites localhost URLs to go through /proxy/<port>/
      cleanEnv.VSCODE_PROXY_URI = "";

      // Set plugin port for VS Code extension communication
      if (this.config.pluginPort !== undefined) {
        cleanEnv.CODEHYDRA_PLUGIN_PORT = String(this.config.pluginPort);
      }

      // Set code-server and opencode directories for wrapper scripts
      cleanEnv.CODEHYDRA_CODE_SERVER_DIR = this.config.codeServerDir;
      cleanEnv.CODEHYDRA_OPENCODE_DIR = this.config.opencodeDir;

      this.process = this.processRunner.run(this.config.binaryPath, args, {
        cwd: this.config.runtimeDir,
        env: cleanEnv,
      });

      // Get the PID
      this.currentPid = this.process.pid ?? null;

      // Wait for health check
      await this.waitForServerHealthy(port);

      // Notify listeners of PID change
      if (this.currentPid !== null) {
        this.notifyPidChanged(this.currentPid);
      }

      this.logger.info("Started", { port, pid: this.currentPid ?? 0 });
      return port;
    } catch (error: unknown) {
      this.currentPort = null;
      this.currentPid = null;
      this.process = null;

      const errorMsg = getErrorMessage(error);
      this.logger.error("Start failed", { error: errorMsg });
      throw new CodeServerError(`Failed to start code-server: ${errorMsg}`);
    }
  }

  /**
   * Wait for the server to become healthy.
   * Uses shared health check utility with 10s timeout.
   */
  private async waitForServerHealthy(port: number): Promise<void> {
    await waitForHealthy({
      checkFn: () => this.checkHealth(port),
      timeoutMs: 10000,
      intervalMs: 100,
      errorMessage: "Health check timed out after 10 seconds",
    });
  }

  /**
   * Check if the server is responding to health checks.
   */
  private async checkHealth(port: number): Promise<boolean> {
    try {
      const response = await this.httpClient.fetch(`http://127.0.0.1:${port}/healthz`, {
        timeout: 1000,
      });
      const healthy = response.status === 200;
      this.logger.debug("Health check", { status: healthy ? "ok" : "failed" });
      return healthy;
    } catch (error) {
      this.logger.warn("Health check failed", { error: getErrorMessage(error) });
      return false;
    }
  }

  /**
   * Stop the server.
   * Uses the new kill() API with SIGTERM→SIGKILL escalation.
   *
   * @throws CodeServerError if stop fails
   */
  async stop(): Promise<void> {
    const proc = this.process;
    const pid = this.currentPid;
    if (this.state === "stopped" || proc === null) {
      return;
    }

    this.logger.info("Stopping", { pid: pid ?? 0 });
    this.state = "stopping";

    try {
      // Use graceful shutdown with 1s timeouts
      const result = await proc.kill(
        PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
        PROCESS_KILL_FORCE_TIMEOUT_MS
      );

      if (!result.success) {
        this.logger.warn("Failed to kill code-server", { pid: pid ?? 0 });
      }

      this.logger.info("Stopped", {
        pid: pid ?? 0,
        success: result.success,
        reason: result.reason ?? "none",
      });
    } finally {
      this.state = "stopped";
      this.currentPort = null;
      this.currentPid = null;
      this.process = null;
      this.startPromise = null;
      this.notifyPidChanged(null);
    }
  }
}
