# Agent Provider Interface

This document describes how to implement a new agent provider for CodeHydra.

## Overview

CodeHydra uses an abstraction layer to support multiple AI coding agents. The architecture consists of three main components:

| Component            | Purpose                                     | Scope                    |
| -------------------- | ------------------------------------------- | ------------------------ |
| `AgentSetupInfo`     | Binary distribution, config file generation | Singleton per type       |
| `AgentServerManager` | Server lifecycle (start, stop, restart)     | Shared across workspaces |
| `AgentProvider`      | Connection and status tracking              | One per workspace        |

**Existing implementations:**

- **OpenCode** (`src/agents/opencode/`) - SSE-based SDK client, one server per workspace
- **Claude Code** (`src/agents/claude-code/`) - HTTP hook server, shared across all workspaces

## Core Interfaces

All interfaces are defined in `src/agents/types.ts`.

### AgentSetupInfo

Static information about an agent type. One instance per agent type (singleton).

```typescript
interface AgentSetupInfo {
  /** Version string (e.g., "0.1.0-beta.43") */
  readonly version: string;

  /** Binary filename relative to bin directory (e.g., "opencode" or "opencode.exe") */
  readonly binaryPath: string;

  /** Entry point for wrapper script (e.g., "agents/opencode-wrapper.cjs") */
  readonly wrapperEntryPoint: string;

  /** VS Code marketplace extension ID (e.g., "anthropic.claude-code") */
  readonly extensionId?: string;

  /** Get download URL for the binary for current platform */
  getBinaryUrl(): string;

  /**
   * Generate config file with environment variable substitution
   * @param targetPath - Path where config file should be written
   * @param variables - Variables to substitute (e.g., { MCP_PORT: "3000" })
   */
  generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void>;
}
```

**Implementation notes:**

- `getBinaryUrl()` returns platform-specific download URL
- `generateConfigFile()` creates workspace-specific config (e.g., MCP server configuration)
- Use template files with `${VARIABLE}` placeholders for config generation

### AgentServerManager

Manages server lifecycle. Typically one manager handles all workspaces.

```typescript
interface AgentServerManager {
  /** Start server for a workspace, returns allocated port */
  startServer(workspacePath: string): Promise<number>;

  /** Stop server for a workspace */
  stopServer(workspacePath: string): Promise<StopServerResult>;

  /** Restart server for a workspace, preserving the same port */
  restartServer(workspacePath: string): Promise<RestartServerResult>;

  /** Check if server is running for workspace */
  isRunning(workspacePath: string): boolean;

  /** Get the port for a running workspace server */
  getPort(workspacePath: string): number | undefined;

  /** Stop all servers for a project */
  stopAllForProject(projectPath: string): Promise<void>;

  /** Callback when server starts successfully */
  onServerStarted(
    callback: (workspacePath: string, port: number, ...args: unknown[]) => void
  ): () => void;

  /** Callback when server stops */
  onServerStopped(callback: (workspacePath: string, ...args: unknown[]) => void): () => void;

  /** Dispose the manager, stopping all servers */
  dispose(): Promise<void>;
}
```

**Server architecture patterns:**

| Pattern       | Description                                     | Example     |
| ------------- | ----------------------------------------------- | ----------- |
| Per-workspace | Spawn one server process per workspace          | OpenCode    |
| Shared        | Single HTTP server routes requests by workspace | Claude Code |

**Implementation notes:**

- Use `PortManager` to allocate ports
- Implement health checks before firing `onServerStarted`
- Preserve port across restarts when possible
- Handle graceful shutdown with timeouts

### AgentProvider

Per-workspace connection and status tracking.

```typescript
interface AgentProvider {
  /** VS Code commands to execute on workspace activation */
  readonly startupCommands: readonly string[];

  /** Connect to agent server at given port */
  connect(port: number): Promise<void>;

  /** Disconnect from agent server (for restart, preserves session info) */
  disconnect(): void;

  /** Reconnect to agent server after restart */
  reconnect(): Promise<void>;

  /** Subscribe to status changes - callback receives computed status */
  onStatusChange(callback: (status: AgentStatus) => void): () => void;

  /** Get session info for TUI attachment */
  getSession(): AgentSessionInfo | null;

  /** Get environment variables needed for terminal integration */
  getEnvironmentVariables(): Record<string, string>;

  /** Mark agent as active (first MCP request received) */
  markActive(): void;

  /** Dispose the provider completely */
  dispose(): void;
}
```

**Implementation notes:**

- `startupCommands` are VS Code commands executed when workspace becomes active
- `disconnect()` preserves state for reconnection; `dispose()` is final cleanup
- Status changes should be emitted as soon as they occur
- `getEnvironmentVariables()` provides env vars for terminal/extension integration

## Supporting Types

```typescript
/** Agent status for a single workspace */
type AgentStatus = "none" | "idle" | "busy";

/** Session info for TUI attachment */
interface AgentSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}

/** Error types for agent operations */
interface AgentError {
  readonly code: "CONNECTION_FAILED" | "SERVER_START_FAILED" | "CONFIG_ERROR" | "TIMEOUT";
  readonly message: string;
  readonly cause?: Error;
}

/** Result of stopping a server */
interface StopServerResult {
  readonly success: boolean;
  readonly error?: string;
}

/** Result of restarting a server */
type RestartServerResult =
  | { readonly success: true; readonly port: number }
  | { readonly success: false; readonly error: string; readonly serverStopped: boolean };
```

## Lifecycle

### Server Startup Sequence

```
1. startServer(workspacePath) called
2. Allocate port via PortManager
3. Spawn server process or configure routes
4. Wait for health check / readiness
5. Fire onServerStarted callback
6. Provider.connect(port) called
```

### Provider Lifecycle

```
1. Create provider instance with dependencies
2. connect(port) - establish connection to server
3. onStatusChange() - register status listeners
4. getSession() - retrieve session info when needed
5. markActive() - called on first MCP request
6. disconnect() - server restarting (preserve state)
7. reconnect() - server restarted (use preserved state)
8. dispose() - final cleanup
```

### Status Flow

```
none → idle → busy → idle → ...
 ↑      ↑       ↑      ↑
 │      │       │      └── Work completed
 │      │       └── User submitted prompt
 │      └── Session started, waiting for input
 └── No active session
```

## Implementation Checklist

### 1. Create Setup Info Class

```typescript
// src/agents/my-agent/setup-info.ts
export class MyAgentSetupInfo implements AgentSetupInfo {
  readonly version = "1.0.0";
  readonly binaryPath = process.platform === "win32" ? "my-agent.exe" : "my-agent";
  readonly wrapperEntryPoint = "agents/my-agent-wrapper.cjs";
  readonly extensionId = "publisher.my-agent-extension";

  constructor(private deps: { fileSystem: FileSystemLayer; platform: string }) {}

  getBinaryUrl(): string {
    // Return platform-specific download URL
  }

  async generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void> {
    // Generate config with variable substitution
  }
}
```

### 2. Create Server Manager Class

```typescript
// src/agents/my-agent/server-manager.ts
export class MyAgentServerManager implements AgentServerManager {
  private servers = new Map<string, ServerState>();
  private startedCallbacks: Array<(...args: unknown[]) => void> = [];
  private stoppedCallbacks: Array<(...args: unknown[]) => void> = [];

  async startServer(workspacePath: string): Promise<number> {
    const port = await this.deps.portManager.acquirePort();
    // Start server, wait for ready
    this.notifyStarted(workspacePath, port);
    return port;
  }

  // ... implement remaining methods
}
```

### 3. Create Provider Class

```typescript
// src/agents/my-agent/provider.ts
export class MyAgentProvider implements AgentProvider {
  readonly startupCommands = ["my-agent.openTerminal"] as const;
  private statusCallbacks: Array<(status: AgentStatus) => void> = [];
  private status: AgentStatus = "none";
  private port: number | null = null;
  private sessionId: string | null = null;

  async connect(port: number): Promise<void> {
    this.port = port;
    // Establish connection, subscribe to events
  }

  onStatusChange(callback: (status: AgentStatus) => void): () => void {
    this.statusCallbacks.push(callback);
    callback(this.status); // Emit current status immediately
    return () => {
      const idx = this.statusCallbacks.indexOf(callback);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
    };
  }

  // ... implement remaining methods
}
```

### 4. Register in Factory Functions

Update `src/agents/index.ts`:

```typescript
// Add to AgentType union in src/agents/types.ts
export type AgentType = "opencode" | "claude-code" | "my-agent";

// Add imports
import { MyAgentSetupInfo } from "./my-agent/setup-info";
import { MyAgentServerManager } from "./my-agent/server-manager";
import { MyAgentProvider } from "./my-agent/provider";

// Add cases to factory functions
export function getAgentSetupInfo(type: AgentType, deps: SetupInfoDeps): AgentSetupInfo {
  switch (type) {
    // ... existing cases
    case "my-agent":
      return new MyAgentSetupInfo({ fileSystem: deps.fileSystem, platform: deps.platform });
  }
}

export function createAgentServerManager(
  type: AgentType,
  deps: ServerManagerDeps
): AgentServerManager {
  switch (type) {
    // ... existing cases
    case "my-agent":
      return new MyAgentServerManager(deps);
  }
}

export function createAgentProvider(type: AgentType, deps: ProviderDeps): AgentProvider {
  switch (type) {
    // ... existing cases
    case "my-agent":
      return new MyAgentProvider(deps);
  }
}
```

## Dependencies

Providers receive dependencies through factory functions:

```typescript
/** Dependencies for AgentSetupInfo */
interface SetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: SupportedArch;
}

/** Dependencies for AgentServerManager */
interface ServerManagerDeps {
  readonly processRunner: ProcessRunner;
  readonly portManager: PortManager;
  readonly httpClient: HttpClient;
  readonly pathProvider: PathProvider;
  readonly fileSystem: FileSystemLayer;
  readonly logger: Logger;
}

/** Dependencies for AgentProvider */
interface ProviderDeps {
  readonly workspacePath: string;
  readonly logger: Logger;
  // Provider-specific optional dependencies
}
```

## Testing

Integration tests should cover:

1. **Connect/disconnect/reconnect cycle**
2. **Status change propagation**
3. **Session retrieval**
4. **Environment variables**
5. **Multiple subscribers**
6. **Disposal cleanup**

Example test structure (see `src/agents/claude-code/provider.integration.test.ts`):

```typescript
describe("MyAgentProvider", () => {
  it("should emit status changes to subscribers", async () => {
    const provider = new MyAgentProvider(deps);
    const statuses: AgentStatus[] = [];

    provider.onStatusChange((status) => statuses.push(status));
    await provider.connect(3000);

    // Trigger status change
    // ...

    expect(statuses).toContain("idle");
  });

  it("should preserve session across disconnect/reconnect", async () => {
    const provider = new MyAgentProvider(deps);
    await provider.connect(3000);

    // Establish session
    // ...

    provider.disconnect();
    await provider.reconnect();

    expect(provider.getSession()).not.toBeNull();
  });
});
```

## Reference Implementations

| Agent       | Setup Info                             | Server Manager                             | Provider                             |
| ----------- | -------------------------------------- | ------------------------------------------ | ------------------------------------ |
| OpenCode    | `src/agents/opencode/setup-info.ts`    | `src/agents/opencode/server-manager.ts`    | `src/agents/opencode/provider.ts`    |
| Claude Code | `src/agents/claude-code/setup-info.ts` | `src/agents/claude-code/server-manager.ts` | `src/agents/claude-code/provider.ts` |
