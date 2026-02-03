# Agent System Documentation

This document describes the agent integration layer, provider interface, and how to implement new agent types.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
  - [AgentSetupInfo](#agentsetupinfo)
  - [AgentServerManager](#agentservermanager)
  - [AgentProvider](#agentprovider)
  - [AgentStatusManager](#agentstatusmanager)
- [Status Flow](#status-flow)
- [MCP Integration](#mcp-integration)
- [OpenCode Implementation](#opencode-implementation)
- [Claude Code Implementation](#claude-code-implementation)
- [Implementing a New Agent](#implementing-a-new-agent)
- [Testing](#testing)

---

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

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  AgentServerManager ──► spawns agent server(s)                   │
│         │                      port stored in memory             │
│         │ onServerStarted(path, port)                            │
│         ▼                                                        │
│  AgentStatusManager ◄── AgentProvider (status events)            │
│         │                                                        │
│         │ callback on status change                              │
│         ▼                                                        │
│  IPC Handlers ──► workspace:status-changed event                 │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
═══════════════════════════╪══════════════════════════════════════
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    RENDERER PROCESS                              │
│                          │                                       │
│  api.on('workspace:status-changed') ──► stores                   │
│                                            │                     │
│                                            │ reactive binding    │
│                                            ▼                     │
│  Sidebar.svelte ◄── StatusIndicator (visual indicator)           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### File Structure

```
src/agents/
  types.ts              # Shared interfaces (AgentSetupInfo, AgentServerManager, AgentProvider)
  index.ts              # Factory functions and exports
  status-manager.ts     # AgentStatusManager (aggregates status across workspaces)
  opencode/
    setup-info.ts       # OpenCodeSetupInfo (version, URLs)
    server-manager.ts   # OpenCodeServerManager (one server per workspace)
    provider.ts         # OpenCodeProvider (SSE client)
    client.ts           # OpenCodeClient (SSE/HTTP)
    types.ts            # OpenCode-specific types
  claude-code/
    setup-info.ts       # ClaudeCodeSetupInfo
    server-manager.ts   # ClaudeCodeServerManager (shared HTTP server)
    provider.ts         # ClaudeCodeProvider
```

---

## Core Components

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

Manages server lifecycle. One manager handles all workspaces.

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

### AgentStatusManager

Aggregates status across all workspaces:

```typescript
interface AgentStatusManager {
  /** Register a provider for a workspace */
  registerProvider(workspacePath: string, provider: AgentProvider): void;

  /** Unregister a provider when workspace is removed */
  unregisterProvider(workspacePath: string): void;

  /** Get current status for a workspace */
  getStatus(workspacePath: string): AgentStatus;

  /** Subscribe to status changes for any workspace */
  onStatusChange(callback: (workspacePath: string, status: AgentStatus) => void): () => void;
}
```

**Key responsibilities:**

1. Maintains registry of workspace → provider mappings
2. Subscribes to each provider's status changes
3. Aggregates and emits unified status events
4. Cleans up subscriptions when providers are unregistered

---

## Status Flow

```
none → idle → busy → idle → ...
 ↑      ↑       ↑      ↑
 │      │       │      └── Work completed
 │      │       └── User submitted prompt
 │      └── Session started, waiting for input
 └── No active session
```

### Status Types

```typescript
/** Agent status for a single workspace */
type AgentStatus = "none" | "idle" | "busy";

/** Session info for TUI attachment */
interface AgentSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}
```

### Permission State Override

For agents like OpenCode, sessions waiting for user permission are displayed as "idle" (green indicator) rather than "busy":

```
┌─────────────────────────────────────────────────────────────────┐
│                      AgentProvider                               │
│                                                                  │
│  sessionStatuses: Map<sessionId, SessionStatus>                  │
│  pendingPermissions: Map<sessionId, Set<permissionId>>          │
│                                                                  │
│  getAdjustedStatus():                                           │
│    for each session:                                            │
│      if pendingPermissions.has(sessionId) → count as idle       │
│      else if status.type === "idle" → count as idle             │
│      else if status.type === "busy" → count as busy             │
└─────────────────────────────────────────────────────────────────┘
```

**Event handling:**

- `permission.updated`: Adds permission to `pendingPermissions` Set
- `permission.replied`: Removes permission from `pendingPermissions` Set
- `session.deleted`: Clears pending permissions for that session
- Connection disconnect: Clears all pending permissions (reconnection safety)

---

## MCP Integration

Agent servers are configured to connect to CodeHydra's MCP server for workspace API access.

### Environment Variables

When spawning agent servers, the following environment variables are set:

| Variable                   | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `CODEHYDRA_WORKSPACE_PATH` | Absolute path to the workspace (for X-Workspace-Path header) |
| `CODEHYDRA_MCP_PORT`       | Port of CodeHydra's MCP server                               |
| `CODEHYDRA_PLUGIN_PORT`    | Port of CodeHydra's Plugin server (for extensions)           |

### OpenCode MCP Configuration

OpenCode servers receive a config file path via `OPENCODE_CONFIG` env var:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codehydra": {
      "type": "remote",
      "url": "http://127.0.0.1:{env:CODEHYDRA_MCP_PORT}",
      "headers": {
        "X-Workspace-Path": "{env:CODEHYDRA_WORKSPACE_PATH}"
      },
      "enabled": true
    }
  }
}
```

### MCP Tools Available to Agents

The MCP server exposes workspace management tools:

| Tool                       | Description                           |
| -------------------------- | ------------------------------------- |
| `workspace.getStatus`      | Get workspace dirty/agent status      |
| `workspace.getMetadata`    | Get all workspace metadata            |
| `workspace.setMetadata`    | Set or delete metadata key            |
| `workspace.delete`         | Delete the current workspace          |
| `workspace.create`         | Create a new workspace in the project |
| `workspace.executeCommand` | Execute a VS Code command             |

### Port Discovery for CLI

The sidekick extension calls `api.workspace.getAgentSession()` on connect and sets environment variables for all new terminals:

| Variable                        | Purpose                            |
| ------------------------------- | ---------------------------------- |
| `CODEHYDRA_OPENCODE_PORT`       | OpenCode server port               |
| `CODEHYDRA_OPENCODE_SESSION_ID` | OpenCode session ID for attachment |

The wrapper script (`<app-data>/bin/opencode`) reads these env vars to redirect `opencode` invocations to `opencode attach http://127.0.0.1:$PORT --session $SESSION_ID`.

---

## OpenCode Implementation

OpenCode uses SSE (Server-Sent Events) for real-time status updates.

### Server Startup Flow

```
1. startServer(workspacePath) called
2. Allocate port via PortManager
3. Spawn `opencode serve --port N --dir path`
4. HTTP probe to `/app` confirms server is ready
5. Fire onServerStarted callback
6. Provider.connect(port) establishes SSE connection
```

### SSE Event Types

OpenCode sends **unnamed SSE events** (no `event:` prefix) with the event type embedded in the JSON payload:

```
data: {"type":"session.status","properties":{"sessionID":"...","status":{"type":"busy"}}}
```

**Event types handled:**

| Event Type           | Description                      |
| -------------------- | -------------------------------- |
| `session.status`     | Status changes (idle/busy/retry) |
| `session.created`    | New root session tracking        |
| `session.idle`       | Explicit idle notification       |
| `session.deleted`    | Session cleanup                  |
| `permission.updated` | Permission request added         |
| `permission.replied` | Permission response received     |

### OpenCode SDK Integration

`OpenCodeClient` uses the official `@opencode-ai/sdk`:

```typescript
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

export type SdkClientFactory = (baseUrl: string) => OpencodeClient;

export class OpenCodeClient implements IDisposable {
  constructor(port: number, sdkFactory: SdkClientFactory = defaultFactory) {
    this.baseUrl = `http://localhost:${port}`;
    this.sdk = sdkFactory(this.baseUrl);
  }

  async connect(timeoutMs = 5000): Promise<void> {
    const events = await this.sdk.event.subscribe();
    this.processEvents(events.stream);
  }
}
```

### Error Handling

- **Connection Failures**: Exponential backoff reconnection (1s, 2s, 4s... max 30s)
- **Port Reuse**: PID comparison detects when different process reuses a port
- **Concurrent Scans**: Mutex flag prevents overlapping scan operations
- **Resource Cleanup**: `IDisposable` pattern ensures proper cleanup on shutdown

---

## Claude Code Implementation

Claude Code uses a shared HTTP server with a hook-based integration model.

### Architecture

Unlike OpenCode (one server per workspace), Claude Code uses a single HTTP server that handles requests for all workspaces. The workspace is identified via request headers.

```
┌─────────────────────────────────────────────────────────────────┐
│  ClaudeCodeServerManager                                         │
│  - Single HTTP server on dynamic port                           │
│  - Routes: POST /hook                                           │
│  - Workspace identified by X-Workspace-Path header              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Workspace A   │ │ Workspace B   │ │ Workspace C   │
│ Provider      │ │ Provider      │ │ Provider      │
└───────────────┘ └───────────────┘ └───────────────┘
```

### Hook Integration

Claude Code sends hooks to the CodeHydra server:

```typescript
// Hook request from Claude Code
POST /hook
X-Workspace-Path: /path/to/workspace
Content-Type: application/json

{
  "type": "status",
  "status": "busy"
}
```

### Status Derivation

Since Claude Code doesn't provide explicit status events, status is derived from hook activity:

- **First hook received**: `none` → `idle`
- **Prompt submitted**: `idle` → `busy`
- **Response completed**: `busy` → `idle`
- **Inactivity timeout**: `busy` → `idle` (safety fallback)

### Session Resumption

The Claude wrapper automatically attempts to resume previous sessions using the `--continue` flag:

1. On launch, checks if user passed `--continue`, `-c`, or `--resume` flags
2. If not, prepends `--continue` to attempt resuming the most recent session for this directory
3. If continuation fails (no session exists), automatically retries without `--continue`
4. This enables seamless session continuity across CodeHydra restarts

**How `--continue` works**: The Claude CLI `--continue` flag loads the most recent conversation from the current project directory. Sessions are stored in `~/.claude/projects/` and are per-directory.

**Flag precedence**: If user passes `--resume <session-id>`, it takes precedence over `--continue`. The wrapper detects this and skips adding `--continue` to avoid conflicts.

Users can still use their own flags:

- `--resume <session>` - Resume a specific named session
- `--continue` or `-c` - Explicitly continue most recent session

---

## Implementing a New Agent

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

### Dependencies

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

---

## Testing

### Integration Test Coverage

Tests should cover:

1. **Connect/disconnect/reconnect cycle**
2. **Status change propagation**
3. **Session retrieval**
4. **Environment variables**
5. **Multiple subscribers**
6. **Disposal cleanup**

### Example Test Structure

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

### Testing OpenCode Client

```typescript
import { createMockSdkClient, createMockSdkFactory, createTestSession } from "./sdk-test-utils";

const mockSdk = createMockSdkClient({
  sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
  sessionStatuses: { "ses-1": { type: "idle" } },
});
const factory = createMockSdkFactory(mockSdk);
const client = new OpenCodeClient(8080, factory);
```

### Reference Implementations

| Agent       | Setup Info                             | Server Manager                             | Provider                             |
| ----------- | -------------------------------------- | ------------------------------------------ | ------------------------------------ |
| OpenCode    | `src/agents/opencode/setup-info.ts`    | `src/agents/opencode/server-manager.ts`    | `src/agents/opencode/provider.ts`    |
| Claude Code | `src/agents/claude-code/setup-info.ts` | `src/agents/claude-code/server-manager.ts` | `src/agents/claude-code/provider.ts` |
