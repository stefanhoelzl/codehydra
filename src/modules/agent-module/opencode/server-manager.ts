/**
 * OpenCode Server Manager - manages one opencode serve instance per workspace.
 *
 * Instead of letting users spawn multiple opencode processes, CodeHydra manages
 * one server per workspace, speaking the wire its binary's major version names
 * (1.x or 2.x; 2.x servers are given a password via OPENCODE_PASSWORD). The
 * opencode CLI wrapper reads the port from the _CH_OPENCODE_PORT environment
 * variable (set by the sidekick extension) and redirects to `opencode attach`
 * (1.x) or `opencode --server` (2.x).
 */

import type { ProcessRunner, SpawnedProcess } from "../../../boundaries/platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../../../boundaries/platform/process";
import type { PortManager, HttpClient } from "../../../boundaries/platform/network";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { Logger } from "../../../boundaries/platform/logging";
import { randomBytes } from "node:crypto";
import type { IDisposable, Unsubscribe } from "./types";
import { waitForHealthy } from "../../../utils/health-check";
import { Path } from "../../../utils/path/path";
import type { PromptModel } from "../../../shared/api/types";
import type {
  AgentServerManager,
  StopServerResult,
  RestartServerResult,
  McpConfig,
} from "../types";
import type { SupportedPlatform } from "../../../boundaries/platform/platform-info";
import { runAgentBinary, type ResolvedAgentBinary } from "../binary-resolver";
import { opencodeWireVersion } from "./setup-info";
import type { WorkspaceRef } from "../../../intents/contract";
import { prependPath } from "../../../utils/env-path";
import { getErrorMessage } from "../../../shared/error-utils";

/**
 * A workspace's pending initial prompt to send when server becomes healthy.
 */
export interface PendingPrompt {
  readonly prompt: string;
  readonly agent?: string;
  readonly model?: PromptModel;
}

/**
 * Which OpenCode server API a workspace's server speaks, and how to reach it.
 * 1.x and 2.x are different contracts; 2.x additionally requires a password.
 */
export interface OpenCodeWireInfo {
  /** The server API the workspace's binary speaks. */
  readonly major: 1 | 2;
  /**
   * 2.x only: the per-workspace password the server was given via
   * `OPENCODE_PASSWORD`. Clients authenticate with HTTP Basic, user
   * `opencode`. Undefined for 1.x, which has no auth.
   */
  readonly password: string | undefined;
  /**
   * The MCP server CodeHydra configured on it ({@link OPENCODE_MCP_SERVER}),
   * when it configured one: 2.x connects MCP servers asynchronously, and a
   * prompt waits for this one so its first turn sees CodeHydra's tools.
   */
  readonly mcpServer?: string;
}

/** The name CodeHydra's MCP server has in an OpenCode config; its tools are `codehydra_<tool>`. */
export const OPENCODE_MCP_SERVER = "codehydra";

/**
 * Callback types for OpenCodeServerManager.
 */
export type ServerStartedCallback = (
  workspaceRef: WorkspaceRef,
  port: number,
  pendingPrompt: PendingPrompt | undefined
) => void;
/**
 * Callback for server stopped events.
 * @param workspaceRef - The workspace
 * @param isRestart - True if this stop is part of a restart (will be followed by start)
 */
export type ServerStoppedCallback = (workspaceRef: WorkspaceRef, isRestart: boolean) => void;

/**
 * A workspace the manager runs a server for. Kept from start until a stop
 * that is not part of a restart, so a restart spawns with what the start was
 * given. Memory only: the open pipeline re-supplies it every time.
 */
interface TrackedWorkspace {
  /** The workspace's directory: the server's working directory. */
  readonly path: Path;
  /** Workspace environment for the server process. */
  readonly env: Readonly<Record<string, string>> | undefined;
  /** The `opencode` the server runs, so a restart keeps the terminal's binary. */
  readonly binary: ResolvedAgentBinary | undefined;
}

/**
 * Server entry in the manager's internal map.
 * Uses a discriminated union to properly model starting, running, and restarting states.
 */
type ServerEntry =
  | { readonly state: "starting"; readonly startPromise: Promise<number> }
  | { readonly state: "running"; readonly port: number; readonly process: SpawnedProcess }
  | {
      readonly state: "restarting";
      readonly port: number;
      readonly process: SpawnedProcess;
      readonly restartPromise: Promise<RestartServerResult>;
    };

/**
 * Configuration options for OpenCodeServerManager.
 */
export interface OpenCodeServerManagerConfig {
  /** Timeout for health check in milliseconds. Default: 30000 */
  healthCheckTimeoutMs?: number;
  /** Interval between health check retries in milliseconds. Default: 500 */
  healthCheckIntervalMs?: number;
}

/**
 * Options for starting a server.
 */
export interface StartServerOptions {
  /** Initial prompt to send after server becomes healthy */
  readonly initialPrompt?: {
    readonly prompt: string;
    /** Named agent to run (OpenCode's agent, e.g. "build"/"plan"/custom). */
    readonly agentName?: string;
    readonly model?: PromptModel;
  };
  /**
   * Workspace environment for the server process — and so for every command
   * its bash tool runs. Kept (in memory) for restarts of this server.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The `opencode` to run. Kept (in memory) for restarts, so a restart keeps
   * the binary the workspace's terminal attaches with.
   */
  readonly binary?: ResolvedAgentBinary;
}

/**
 * Manages OpenCode server instances for workspaces.
 * One server per workspace, with health check. Port stored in memory only.
 *
 * Implements AgentServerManager interface for use in the agent abstraction layer.
 */
export class OpenCodeServerManager implements AgentServerManager, IDisposable {
  private readonly processRunner: ProcessRunner;
  private readonly portManager: PortManager;
  private readonly httpClient: HttpClient;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;
  private readonly config: Required<OpenCodeServerManagerConfig>;

  private readonly platform: SupportedPlatform;

  /** Workspaces by ref, with what their servers are spawned from. */
  private readonly workspaces = new Map<WorkspaceRef, TrackedWorkspace>();
  /**
   * 2.x servers' passwords, by ref. Generated once per server, kept across
   * restarts (the agent terminal's env holds it), dropped with the workspace.
   */
  private readonly serverPasswords = new Map<WorkspaceRef, string>();
  private readonly servers = new Map<WorkspaceRef, ServerEntry>();
  private readonly startedCallbacks = new Set<ServerStartedCallback>();
  private readonly stoppedCallbacks = new Set<ServerStoppedCallback>();

  /** Pending initial prompts to send when servers become healthy. */
  private readonly pendingPrompts = new Map<WorkspaceRef, PendingPrompt>();

  private mcpConfig: McpConfig | null = null;

  /** Handler called when workspace becomes active (agent terminal opened) */
  private markActiveHandler: ((workspaceRef: WorkspaceRef) => void) | null = null;

  constructor(
    processRunner: ProcessRunner,
    portManager: PortManager,
    httpClient: HttpClient,
    pathProvider: PathProvider,
    logger: Logger,
    platform: SupportedPlatform,
    config?: OpenCodeServerManagerConfig
  ) {
    this.processRunner = processRunner;
    this.portManager = portManager;
    this.httpClient = httpClient;
    this.pathProvider = pathProvider;
    this.logger = logger;
    this.platform = platform;
    this.config = {
      healthCheckTimeoutMs: config?.healthCheckTimeoutMs ?? 30000,
      healthCheckIntervalMs: config?.healthCheckIntervalMs ?? 500,
    };
  }

  /** The directory of a workspace, while it is tracked. */
  getWorkspacePath(workspaceRef: WorkspaceRef): Path | undefined {
    return this.workspaces.get(workspaceRef)?.path;
  }

  /**
   * The wire a workspace's server speaks, and how to authenticate to it.
   * Available from the server's start until its workspace stops.
   */
  getWireInfo(workspaceRef: WorkspaceRef): OpenCodeWireInfo | undefined {
    const workspace = this.workspaces.get(workspaceRef);
    if (workspace === undefined) return undefined;
    return {
      major: opencodeWireVersion(workspace.binary?.version),
      password: this.serverPasswords.get(workspaceRef),
      ...(this.mcpConfig && { mcpServer: OPENCODE_MCP_SERVER }),
    };
  }

  /**
   * Start an OpenCode server for a workspace.
   * Returns the port number on success.
   *
   * @param workspaceRef - The workspace's ref, which the agent and every `ch` it runs name it by
   * @param workspacePath - The workspace's directory, the server's working directory
   * @param options - Optional start options (e.g., initialPrompt)
   * @returns Allocated port number
   * @throws Error if server fails to start or health check times out
   */
  async startServer(
    workspaceRef: WorkspaceRef,
    workspacePath: Path,
    options: StartServerOptions = {}
  ): Promise<number> {
    const previous = this.workspaces.get(workspaceRef);
    this.workspaces.set(workspaceRef, {
      path: workspacePath,
      env: options.env ?? previous?.env,
      binary: options.binary ?? previous?.binary,
    });
    // Store pending prompt if provided
    if (options.initialPrompt) {
      this.setPendingPrompt(
        workspaceRef,
        options.initialPrompt.prompt,
        options.initialPrompt.agentName,
        options.initialPrompt.model
      );
    }

    // Check if already running/starting
    const existing = this.servers.get(workspaceRef);
    if (existing) {
      if (existing.state === "starting") {
        return existing.startPromise;
      }
      return existing.port;
    }

    // Create the start promise.
    // Set entry BEFORE any async work so concurrent callers (e.g. restartServer) can see it
    const startPromise = this.doStartServer(workspaceRef);
    this.servers.set(workspaceRef, { state: "starting", startPromise });

    try {
      const port = await startPromise;
      return port;
    } catch (error) {
      // Clean up on failure
      this.servers.delete(workspaceRef);
      throw error;
    }
  }

  /**
   * Internal method to start the server.
   */
  private async doStartServer(workspaceRef: WorkspaceRef): Promise<number> {
    // Allocate a free port
    const port = await this.portManager.findFreePort();

    // Spawn server and wait for health check
    const proc = await this.spawnServerOnPort(workspaceRef, port);

    // Update the server entry to running state
    this.servers.set(workspaceRef, { state: "running", port, process: proc });

    // Consume pending prompt before firing callback
    const pendingPrompt = this.consumePendingPrompt(workspaceRef);

    // pid is guaranteed to be defined since spawnServerOnPort validates it
    this.logger
      .scoped({ workspace: workspaceRef })
      .info("Server started", { port, pid: proc.pid! });

    // Fire callback with pending prompt (caller handles sending)
    for (const callback of this.startedCallbacks) {
      callback(workspaceRef, port, pendingPrompt);
    }

    return port;
  }

  /**
   * Spawn an OpenCode server and wait for it to be healthy.
   * Common implementation used by both doStartServer and startServerOnPort.
   *
   * @param workspaceRef - The workspace
   * @param port - Port number to use
   * @returns The spawned process
   * @throws Error if server fails to spawn or health check times out
   */
  private async spawnServerOnPort(
    workspaceRef: WorkspaceRef,
    port: number
  ): Promise<SpawnedProcess> {
    const workspace = this.workspaces.get(workspaceRef);
    const binary = workspace?.binary;
    if (workspace === undefined || binary === undefined) {
      throw new Error(`No opencode binary given for ${workspaceRef}`);
    }
    const major = opencodeWireVersion(binary.version);

    // A 2.x server requires a password and prints a random one unless it is
    // given here. Generated once per workspace and kept across restarts: the
    // agent terminal's environment holds it, and a restart that changed it
    // would strand a terminal that can no longer attach.
    let password: string | undefined;
    if (major === 2) {
      password = this.serverPasswords.get(workspaceRef) ?? randomBytes(24).toString("base64url");
      this.serverPasswords.set(workspaceRef, password);
    }

    // OPENCODE_CONFIG_CONTENT is merged into the resolved config last, so these
    // values win over the user's opencode.json. `instructions` is the exception
    // that merges rather than wins: OpenCode unions it across every config
    // source, so CodeHydra's prompt is added to the user's own entries.
    //
    // Use Path.toString() for paths (already POSIX format). Backslashes would
    // become invalid escape sequences in JSON.
    const config: Record<string, unknown> = {
      // Appended to the system prompt as "Instructions from: <path>".
      instructions: [this.getSystemPromptPath().toString()],
    };
    if (this.mcpConfig) {
      // A local (stdio) server rather than a remote URL: `ch mcp` is launched as
      // a subprocess with everything it needs passed explicitly, so it does not
      // depend on CodeHydra's bin directory being on OpenCode's PATH.
      const codehydra = {
        type: "local",
        command: [this.mcpConfig.nodePath, this.mcpConfig.cliPath, "mcp"],
        environment: {
          _CH_WORKSPACE: workspaceRef,
          _CH_API_PORT: String(this.mcpConfig.port),
          _CH_API_TOKEN: this.mcpConfig.token,
        },
      };
      if (major === 2) {
        // 2.x groups servers under `mcp.servers` (no `enabled`: its inverse
        // `disabled` defaults to false). `codemode: false` hands the model
        // CodeHydra's tools directly, as `codehydra_<tool>` like 1.x, instead
        // of only through the Code Mode `execute` tool's catalog.
        config.mcp = { servers: { [OPENCODE_MCP_SERVER]: { ...codehydra, codemode: false } } };
      } else {
        config.mcp = { [OPENCODE_MCP_SERVER]: { ...codehydra, enabled: true } };
      }
    }
    if (binary.source === "download") {
      // CodeHydra updates the binaries it downloads; a system install is the
      // user's to manage. (`autoupdate` in 1.x, `update` in 2.x.)
      if (major === 2) {
        config.update = "disable";
      } else {
        config.autoupdate = false;
      }
    }
    // OpenCode's server is spawned from the Electron main process, which does
    // not have CodeHydra's bin directory on PATH — so without this, its bash
    // tool cannot reach `ch`. (`ch-bg` is there too but changes nothing under
    // OpenCode: its status tracking never looks at background shells.)
    // Prepended so a CodeHydra script wins over a same-named one elsewhere on
    // PATH.
    const binDir = this.pathProvider.dataPath("bin").toNative();
    //
    // The workspace environment layers over the inherited one, and CodeHydra's
    // own entries below layer over both: a repository can add to the agent's
    // world but not re-point it (PATH still gets the bin directory prepended).
    // `prependPath` keeps a single PATH key whatever its case (Windows' `Path`).
    const baseEnv = prependPath({ ...process.env, ...workspace.env }, binDir, this.platform);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      // The agent's own workspace, so `ch` run from its bash tool resolves the
      // right one without depending on the process's working directory.
      _CH_WORKSPACE: workspaceRef,
      ...(this.mcpConfig && {
        _CH_API_PORT: String(this.mcpConfig.port),
        _CH_API_TOKEN: this.mcpConfig.token,
      }),
      ...(password !== undefined && { OPENCODE_PASSWORD: password }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };

    // Spawn opencode serve
    const proc = runAgentBinary(
      this.processRunner,
      binary.path,
      ["serve", "--port", String(port)],
      this.platform,
      { cwd: workspace.path.toNative(), env }
    );

    // Check if spawn failed
    if (proc.pid === undefined) {
      const result = await proc.wait();
      throw new Error(`Failed to spawn opencode: ${result.stderr}`);
    }

    // Wait for health check
    try {
      await this.waitForHealthCheck(port, major, password);
    } catch (error) {
      // Kill the process on health check failure
      await proc.kill(PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS);
      throw error;
    }

    return proc;
  }

  /**
   * Wait for health check to pass.
   *
   * 1.x answers `GET /path`; 2.x has no `/path` (its web-UI catch-all returns
   * 200 for anything) — its readiness endpoint is `GET /api/info`, which is
   * authenticated, so a healthy check also proves the password works.
   */
  private async waitForHealthCheck(port: number, major: 1 | 2, password?: string): Promise<void> {
    const url = major === 2 ? `http://127.0.0.1:${port}/api/info` : `http://127.0.0.1:${port}/path`;
    const headers =
      major === 2 && password !== undefined
        ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
        : undefined;

    await waitForHealthy({
      checkFn: async () => {
        const response = await this.httpClient.fetch(url, {
          timeout: 2000,
          ...(headers && { headers }),
        });
        return response.ok;
      },
      timeoutMs: this.config.healthCheckTimeoutMs,
      intervalMs: this.config.healthCheckIntervalMs,
      errorMessage: `Health check timeout after ${this.config.healthCheckTimeoutMs}ms`,
    });
  }

  /**
   * Stop an OpenCode server for a workspace.
   *
   * @param workspaceRef - The workspace
   * @param isRestart - True if this stop is part of a restart operation
   * @returns StopResult indicating success or failure
   */
  async stopServer(workspaceRef: WorkspaceRef, isRestart = false): Promise<StopServerResult> {
    const log = this.logger.scoped({ workspace: workspaceRef });
    const entry = this.servers.get(workspaceRef);
    if (!entry) {
      return { success: true };
    }

    // Wait for pending start
    if (entry.state === "starting") {
      try {
        await entry.startPromise;
      } catch {
        // Start failed, but we still need to clean up
      }
    }

    // Get the current entry (may have been updated after startPromise resolved)
    const currentEntry = this.servers.get(workspaceRef);
    let stopResult: StopServerResult = { success: true };

    // Kill the process if we have a running or restarting server
    if (currentEntry && (currentEntry.state === "running" || currentEntry.state === "restarting")) {
      // Kill the process with 1s timeouts
      const killResult = await currentEntry.process.kill(
        PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
        PROCESS_KILL_FORCE_TIMEOUT_MS
      );

      if (!killResult.success) {
        log.warn("Failed to kill OpenCode server", { pid: currentEntry.process.pid ?? 0 });
        stopResult = { success: false, error: "Process did not terminate" };
      }
    }

    // Remove from map (but NOT if restarting - the restart will update the entry)
    const finalEntry = this.servers.get(workspaceRef);
    if (finalEntry?.state !== "restarting") {
      this.servers.delete(workspaceRef);
    }
    if (!isRestart) {
      this.workspaces.delete(workspaceRef);
      // A stopped workspace's next server gets a fresh password; a restart
      // reuses the one the agent terminal already holds.
      this.serverPasswords.delete(workspaceRef);
    }

    // Fire callback with isRestart flag
    for (const callback of this.stoppedCallbacks) {
      callback(workspaceRef, isRestart);
    }

    log.info("Server stopped", { isRestart });

    return stopResult;
  }

  /**
   * Restart an OpenCode server for a workspace, preserving the same port.
   *
   * Note: This method is NOT async to ensure idempotency - when called multiple
   * times concurrently, it returns the SAME promise object. If it were async,
   * each call would create a new wrapper Promise.
   *
   * @param workspaceRef - The workspace
   * @returns RestartServerResult with port on success, or error details on failure
   */
  restartServer(workspaceRef: WorkspaceRef): Promise<RestartServerResult> {
    const entry = this.servers.get(workspaceRef);

    // If already restarting, return the in-progress promise (idempotent)
    if (entry?.state === "restarting") {
      return entry.restartPromise;
    }

    // If starting, wait for start to complete, then restart
    if (entry?.state === "starting") {
      return entry.startPromise
        .then(() => this.restartServer(workspaceRef))
        .catch(() => ({
          success: false as const,
          error: "Server failed to start",
        }));
    }

    // If not running, can't restart
    if (!entry || entry.state !== "running") {
      return Promise.resolve({
        success: false as const,
        error: "Server not running",
      });
    }

    // Get the current port and process to preserve
    const port = entry.port;
    const process = entry.process;

    // Use a deferred promise to set state BEFORE any async work
    // This prevents race conditions where concurrent calls both see "running" state
    const {
      promise: restartPromise,
      resolve: resolveRestart,
      reject: rejectRestart,
    } = Promise.withResolvers<RestartServerResult>();

    // Store entry while restarting BEFORE calling doRestartServer
    // (keep process reference so stopServer can kill it)
    this.servers.set(workspaceRef, { state: "restarting", port, process, restartPromise });

    // Kick off the restart and resolve the deferred promise
    this.doRestartServer(workspaceRef, port).then(resolveRestart).catch(rejectRestart);

    return restartPromise;
  }

  /**
   * Internal method to perform the restart.
   */
  private async doRestartServer(
    workspaceRef: WorkspaceRef,
    port: number
  ): Promise<RestartServerResult> {
    // Stop the server first (with isRestart=true to preserve session ID)
    const stopResult = await this.stopServer(workspaceRef, true);
    if (!stopResult.success) {
      return {
        success: false,
        error: stopResult.error ?? "Failed to stop server",
      };
    }

    // Start the server on the same port
    try {
      const newPort = await this.startServerOnPort(workspaceRef, port);
      return { success: true, port: newPort };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  /**
   * Start an OpenCode server for a workspace on a specific port.
   * Used by restartServer to preserve the same port.
   *
   * @param workspaceRef - The workspace
   * @param port - Port number to use
   * @returns Allocated port number
   * @throws Error if server fails to start or health check times out
   */
  private async startServerOnPort(workspaceRef: WorkspaceRef, port: number): Promise<number> {
    // Spawn server and wait for health check
    const proc = await this.spawnServerOnPort(workspaceRef, port);

    // Update the server entry to running state
    this.servers.set(workspaceRef, { state: "running", port, process: proc });

    // pid is guaranteed to be defined since spawnServerOnPort validates it
    this.logger
      .scoped({ workspace: workspaceRef })
      .info("Server started", { port, pid: proc.pid! });

    // Fire callback (no pending prompt for restart scenarios)
    for (const callback of this.startedCallbacks) {
      callback(workspaceRef, port, undefined);
    }

    return port;
  }

  /**
   * Subscribe to server started events.
   */
  onServerStarted(callback: ServerStartedCallback): Unsubscribe {
    this.startedCallbacks.add(callback);
    return () => this.startedCallbacks.delete(callback);
  }

  /**
   * Subscribe to server stopped events.
   */
  onServerStopped(callback: ServerStoppedCallback): Unsubscribe {
    this.stoppedCallbacks.add(callback);
    return () => this.stoppedCallbacks.delete(callback);
  }

  /**
   * Trigger the "agent terminal opened" transition for a workspace.
   *
   * Replaces the wrapper's WrapperStart HTTP POST: invoked via the
   * agent:lifecycle intent when the sidekick reports the agent terminal opening.
   * Marks the workspace active (TUI attached). Idempotent.
   */
  triggerWrapperStart(workspaceRef: WorkspaceRef): void {
    this.logger.scoped({ workspace: workspaceRef }).debug("Agent terminal opened");
    this.markActiveHandler?.(workspaceRef);
  }

  /**
   * Set handler called when the workspace becomes active (agent terminal opened).
   */
  setMarkActiveHandler(handler: (workspaceRef: WorkspaceRef) => void): void {
    this.markActiveHandler = handler;
  }

  /**
   * Set the MCP server configuration.
   * This must be called before starting servers if MCP integration is desired.
   *
   * @param config - MCP configuration with config path and port
   */
  setMcpConfig(config: McpConfig): void {
    this.mcpConfig = config;
    this.logger.debug("MCP config set", { port: config.port });
  }

  /**
   * Get the path to the CodeHydra system prompt loaded into every OpenCode session.
   *
   * The runtime dir, outside the ASAR, so the opencode process can read it. The
   * OpenCode file omits the `ch-bg` section: that wrapper is only detectable in
   * Claude's background_tasks, so under OpenCode it would change nothing.
   */
  getSystemPromptPath(): Path {
    return this.pathProvider.runtimePath("bin/codehydra-prompt-opencode.md");
  }

  /**
   * Store a pending initial prompt to send when the server becomes healthy.
   */
  private setPendingPrompt(
    workspaceRef: WorkspaceRef,
    prompt: string,
    agent?: string,
    model?: PromptModel
  ): void {
    this.pendingPrompts.set(workspaceRef, {
      prompt,
      ...(agent !== undefined && { agent }),
      ...(model !== undefined && { model }),
    });
    this.logger.scoped({ workspace: workspaceRef }).debug("Pending prompt stored", {
      promptLength: prompt.length,
      ...(agent !== undefined && { agent }),
      ...(model !== undefined && { model: `${model.providerID}/${model.modelID}` }),
    });
  }

  /**
   * Consume (retrieve and remove) a pending initial prompt.
   */
  private consumePendingPrompt(workspaceRef: WorkspaceRef): PendingPrompt | undefined {
    const pending = this.pendingPrompts.get(workspaceRef);
    if (pending) {
      this.pendingPrompts.delete(workspaceRef);
      this.logger.scoped({ workspace: workspaceRef }).debug("Pending prompt consumed");
    }
    return pending;
  }

  /**
   * Dispose the manager, stopping all servers.
   */
  async dispose(): Promise<void> {
    const workspaces = [...this.servers.keys()];
    await Promise.all(workspaces.map((workspaceRef) => this.stopServer(workspaceRef)));
    this.startedCallbacks.clear();
    this.stoppedCallbacks.clear();
    this.markActiveHandler = null;
  }
}
