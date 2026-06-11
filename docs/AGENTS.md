# Agent System Documentation

This document describes the agent integration layer, provider interfaces, and how to implement new agent types.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
  - [AgentModuleProvider](#agentmoduleprovider)
  - [AgentModuleSpec and the core factory](#agentmodulespec-and-the-core-factory)
  - [AgentServerManager](#agentservermanager)
  - [AgentProvider](#agentprovider)
- [Status Flow](#status-flow)
- [MCP Integration](#mcp-integration)
- [OpenCode Implementation](#opencode-implementation)
- [Claude Code Implementation](#claude-code-implementation)
- [Implementing a New Agent](#implementing-a-new-agent)
- [Testing](#testing)

---

## Overview

CodeHydra uses an abstraction layer to support multiple AI coding agents. Everything lives under `src/modules/agent-module/`:

| Component                   | Purpose                                                               | Scope                    |
| --------------------------- | --------------------------------------------------------------------- | ------------------------ |
| `createAgentModule`         | Generic intent module; delegates every hook to an AgentModuleProvider | One per agent type       |
| `AgentModuleProvider`       | Unified per-agent surface (binary, lifecycle, status, sessions)       | One per agent type       |
| `createAgentModuleProvider` | Generic provider-tracking core, parameterized by an `AgentModuleSpec` | One per agent type       |
| `AgentServerManager`        | Server lifecycle (start, stop, restart)                               | Shared across workspaces |
| `AgentProvider`             | Connection and status tracking                                        | One per workspace        |

**Existing implementations:**

- **OpenCode** (`src/modules/agent-module/opencode/`) - SSE-based SDK client, one server per workspace
- **Claude Code** (`src/modules/agent-module/claude/`) - HTTP hook server, shared across all workspaces

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  AgentServerManager ──► spawns/tracks agent server(s)            │
│         │                      port stored in memory             │
│         │ onServerStarted(path, port, ...)                       │
│         ▼                                                        │
│  module-provider core ◄── AgentProvider (status events)          │
│  (registry + status cache)                                       │
│         │                                                        │
│         │ onStatusChange callback (wired by createAgentModule)   │
│         ▼                                                        │
│  Dispatcher.dispatch(agent:update-status intent)                 │
│         │                                                        │
│         │ UpdateAgentStatusOperation emits domain event          │
│         ▼                                                        │
│  agent:status-updated domain event                               │
│         │                                                        │
│         ├──► UI IPC subscriber                                   │
│         │      converts AggregatedAgentStatus → WorkspaceStatus  │
│         │      emits workspace:status-changed                    │
│         │                                                        │
│         └──► Badge module subscriber                             │
│                updates internal map, re-aggregates badge state   │
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

### Generic agent module

`createAgentModule(provider, deps)` (`src/modules/agent-module/agent-module.ts`) returns an `IntentModule` that is a thin adapter: every hook handler delegates to the `AgentModuleProvider`. One module instance is registered per agent type in the composition root (`src/main.ts`).

| Operation              | Hook Points                               | Responsibility                                             |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `app:start`            | `before-ready`, `check-deps`, `start`     | Script declarations, binary preflight, MCP port capture    |
| `app:ready`            | `available-agents`                        | Report agent availability for the picker                   |
| `app:shutdown`         | `stop`                                    | Dispose provider, cleanup status subscription              |
| `setup`                | `register-agents`, `save-agent`, `binary` | Agent selection UI, config persistence, binary download    |
| `open-workspace`       | `setup`                                   | Start server, wait for provider, prompt plumbing, env vars |
| `delete-workspace`     | `shutdown`                                | Stop server, clear per-workspace tracking                  |
| `hibernate-workspace`  | `shutdown`                                | Best-effort server stop (errors not propagated)            |
| `get-workspace-status` | `get`                                     | Return agent status                                        |
| `get-agent-session`    | `get`                                     | Return session info                                        |
| `restart-agent`        | `restart`                                 | Restart agent server                                       |
| `agent-lifecycle`      | `lifecycle`                               | Terminal open/close transitions (reported by the sidekick) |

Provider initialization is lazy: it happens on the first `open-workspace` for the configured agent, using the MCP port captured during `app:start`.

### File Structure

```
src/modules/agent-module/
  types.ts                  # Shared interfaces (AgentServerManager, AgentProvider, McpConfig, ...)
  agent-module.ts           # createAgentModule (generic intent adapter)
  agent-module-provider.ts  # AgentModuleProvider interface
  module-provider.ts        # createAgentModuleProvider core + AgentModuleSpec
  status-utils.ts           # Pure status conversion helpers
  opencode/
    setup-info.ts           # Version/URL/bundle-dir helper functions
    server-manager.ts       # OpenCodeServerManager (one server per workspace)
    provider.ts             # OpenCodeProvider (SSE client wrapper)
    client.ts               # OpenCodeClient (official SDK + SSE)
    module-provider.ts      # createOpenCodeModuleProvider (spec definition)
    wrapper.ts              # CLI wrapper (redirects to `opencode attach`)
  claude/
    setup-info.ts           # Version/URL/sub-path helper functions
    server-manager.ts       # ClaudeCodeServerManager (shared HTTP hook server)
    provider.ts             # ClaudeCodeProvider (env vars + hook subscription)
    module-provider.ts      # createClaudeModuleProvider (spec definition)
    hook-handler.ts         # Hook POST script run by the Claude CLI
    wrapper.ts              # CLI wrapper (session resume, initial prompt)
```

---

## Core Components

### AgentModuleProvider

The unified per-agent surface consumed by the generic module (`agent-module-provider.ts`). Covers identity constants (`type`, `displayName`, `icon`, `scripts`, ...), binary management (`preflight`, `downloadBinary`), lifecycle (`initialize`, `dispose`), per-workspace operations (`startWorkspace`, `stopWorkspace`, `restartWorkspace`, `applyTerminalLifecycle`), queries (`getStatus`, `getSession`), the cross-workspace `onStatusChange` event, and `clearWorkspaceTracking`.

### AgentModuleSpec and the core factory

`createAgentModuleProvider(spec, deps)` (`module-provider.ts`) implements `AgentModuleProvider` once. It owns the shared machinery:

- per-workspace provider registry and status cache (with change deduplication)
- `onServerStarted`/`onServerStopped` wiring, including the restart path (disconnect → reconnect)
- binary preflight/download scaffolding
- disposal

Per-agent behavior is supplied via `AgentModuleSpec<P>` (generic over the concrete provider class):

| Spec member              | Claude                                        | OpenCode                                       |
| ------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `resolveBinary()`        | `null` when no version override (bundled)     | always resolves from `version.opencode`        |
| `createProvider`         | `new ClaudeCodeProvider({serverManager,...})` | `new OpenCodeProvider(path, logger)`           |
| `connectProvider`        | `connect(port)`                               | `connect(port)` + `fetchStatus()`              |
| `initialStatus`          | always `"none"` (status arrives via hooks)    | derived from `getEffectiveCounts()`            |
| `onProviderRegistered`   | —                                             | sends the pending initial prompt               |
| `startServer`            | `startServer(path)`                           | `startServer(path, {initialPrompt})`           |
| `afterProviderReady`     | writes prompt file + no-session marker        | —                                              |
| `applyTerminalLifecycle` | WrapperStart/WrapperEnd via server manager    | `triggerWrapperStart` / TUI detach             |
| `wireExtraCallbacks`     | —                                             | `setMarkActiveHandler` (TUI-attached tracking) |
| `clearWorkspaceTracking` | — (no per-workspace tracking)                 | clears the TUI-attached entry                  |

### AgentServerManager

Manages server lifecycle (`types.ts`). One manager handles all workspaces.

```typescript
interface AgentServerManager {
  startServer(workspacePath: string): Promise<number>;
  stopServer(workspacePath: string): Promise<StopServerResult>;
  restartServer(workspacePath: string): Promise<RestartServerResult>;
  onServerStarted(
    cb: (workspacePath: string, port: number, ...args: unknown[]) => void
  ): () => void;
  onServerStopped(cb: (workspacePath: string, ...args: unknown[]) => void): () => void;
  setMarkActiveHandler(handler: (workspacePath: string) => void): void;
  setInitialPrompt?(workspacePath: string, config: NormalizedInitialPrompt): Promise<void>; // Claude only
  setNoSessionMarker?(workspacePath: string): Promise<void>; // Claude only
  setMcpConfig(config: McpConfig): void;
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

Per-workspace connection and status tracking (`types.ts`).

```typescript
interface AgentProvider {
  connect(port: number): Promise<void>;
  disconnect(): void; // for restart, preserves session info
  reconnect(): Promise<void>;
  onStatusChange(callback: (status: AgentStatus) => void): () => void;
  getSession(): AgentSessionInfo | null;
  getEnvironmentVariables(): Record<string, string>;
  markActive(): void;
  detachTui?(): void; // only providers with a TUI-attached status gate (OpenCode)
  dispose(): void;
}
```

**Implementation notes:**

- `disconnect()` preserves state for reconnection; `dispose()` is final cleanup
- Status changes should be emitted as soon as they occur
- `getEnvironmentVariables()` provides env vars the sidekick sets for all new terminals

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

For agents like OpenCode, sessions waiting for user permission are displayed as "idle" (green indicator) rather than "busy". The provider tracks `pendingPermissions: Map<sessionId, Set<permissionId>>`; any pending permission makes `getEffectiveCounts()` report idle.

**Event handling:**

- `permission.updated`: Adds permission to `pendingPermissions`
- `permission.replied`: Removes permission from `pendingPermissions`
- `session.deleted`: Clears pending permissions for that session
- Disconnect: Clears all pending permissions (reconnection safety)

### Background Shell Handling (Claude Code)

With `experimental.busy-during-background-shell` enabled, the workspace stays busy while
the agent has a qualifying background shell running (Bash with `run_in_background`),
instead of going idle when the turn ends. The Stop/StopFailure hook payload carries
`background_tasks` — the live list of still-running background tasks — which the bridge
evaluates on every Stop: `true` keeps the workspace busy for any running shell task;
an array of regexes (config.json only) keeps it busy only for shells whose command
matches (e.g. `["ship-wait"]` for a CI-wait script), so dev servers don't pin the
workspace busy. The decision is stashed to also suppress the `idle_prompt` notification
that fires ~60s after Stop, and cleared when the agent is re-invoked (`UserPromptSubmit`,
which happens automatically when a background shell exits) or the session ends.
`PermissionRequest` → idle is never suppressed. Default: disabled.

---

## MCP Integration

Agent servers are configured to connect to CodeHydra's MCP server for workspace API access. The MCP port is captured during `app:start` and passed to the provider via `initialize()`.

### OpenCode MCP Configuration

OpenCode servers receive the MCP config inline via the `OPENCODE_CONFIG_CONTENT` environment variable at spawn time:

```json
{
  "mcp": {
    "codehydra": {
      "type": "remote",
      "url": "http://127.0.0.1:<mcp-port>/mcp",
      "headers": { "X-Workspace-Path": "<workspace-path>" },
      "enabled": true
    }
  }
}
```

### Claude Code MCP Configuration

The server manager generates per-workspace config files (`codehydra-hooks.json`, `codehydra-mcp.json`) from JSON templates with `${VARIABLE}` substitution, stored under `<data>/claude/configs/<workspace-hash>/`. The provider exposes their paths via environment variables (`_CH_CLAUDE_SETTINGS`, `_CH_CLAUDE_MCP_CONFIG`).

### MCP Tools Available to Agents

The MCP server exposes workspace management tools (`workspace.getStatus`, `workspace.getMetadata`, `workspace.setMetadata`, `workspace.delete`, `workspace.create`, `workspace.executeCommand`, ...). See docs/API.md.

### Port Discovery for CLI

The sidekick extension applies the env vars from `getEnvironmentVariables()` to all new terminals:

| Variable                  | Purpose                            |
| ------------------------- | ---------------------------------- |
| `_CH_OPENCODE_PORT`       | OpenCode server port               |
| `_CH_OPENCODE_SESSION_ID` | OpenCode session ID for attachment |
| `_CH_BRIDGE_PORT`         | Claude hook bridge port            |
| `_CH_WORKSPACE_PATH`      | Workspace path (both agents)       |

The OpenCode wrapper script reads these to redirect `opencode` invocations to `opencode attach http://127.0.0.1:$PORT --session $SESSION_ID`.

---

## OpenCode Implementation

OpenCode uses SSE (Server-Sent Events) for real-time status updates.

### Server Startup Flow

```
1. startServer(workspacePath) called
2. Allocate port via PortManager
3. Spawn `opencode serve --port N` (cwd = workspace)
4. HTTP probe to `/path` confirms server is ready
5. Fire onServerStarted(path, port, pendingPrompt)
6. Provider.connect(port) finds/creates a session and connects SSE
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
  constructor(port: number, logger: Logger, sdkFactory: SdkClientFactory = defaultSdkFactory) {
    // ...
  }
}
```

### TUI-Attached Gate

OpenCode status reports `"none"` until the TUI attaches (first MCP request or terminal open). The module provider keeps a `tuiAttachedWorkspaces` set that survives provider recreation across server restarts; terminal close detaches the TUI (`detachTui()`) without stopping the server.

---

## Claude Code Implementation

Claude Code uses a shared HTTP server with a hook-based integration model.

### Architecture

Unlike OpenCode (one server per workspace), Claude Code uses a single HTTP bridge server that handles hook notifications for all workspaces. The workspace is identified by the `workspacePath` field in the hook payload.

```
POST /hook/<HookName>
Content-Type: application/json

{ "workspacePath": "/path/to/workspace", "session_id": "..." }
```

### Status Derivation

Status is driven by the Claude CLI's hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, ...) routed through a per-workspace state machine in the server manager (see `claude/types.ts` for the hook → status mapping). It also handles compaction, sub-agent tracking, and permission-resolution edge cases. `WrapperStart`/`WrapperEnd` are not accepted over HTTP — they are driven by the sidekick via the `agent:lifecycle` intent (`triggerWrapperLifecycle`).

### Session Resumption

The Claude wrapper automatically attempts to resume previous sessions using the `--continue` flag:

1. On launch, checks if user passed `--continue`, `-c`, or `--resume` flags
2. If not, prepends `--continue` to attempt resuming the most recent session for this directory (unless the no-session marker for a brand-new workspace is present)
3. If continuation fails (no session exists), automatically retries without `--continue`
4. This enables seamless session continuity across CodeHydra restarts

**Flag precedence**: If user passes `--resume <session-id>`, it takes precedence over `--continue`. The wrapper detects this and skips adding `--continue` to avoid conflicts.

---

## Implementing a New Agent

### 1. Create setup-info helpers

```typescript
// src/modules/agent-module/my-agent/setup-info.ts
export function getMyAgentUrlForVersion(version, platform, arch): string { ... }
export function getMyAgentBundleDir(pathProvider, version): Path { ... }
```

### 2. Create the server manager and provider

Implement `AgentServerManager` (server lifecycle) and `AgentProvider` (per-workspace connection + status), following the per-workspace (OpenCode) or shared (Claude) pattern.

### 3. Define the module provider spec

```typescript
// src/modules/agent-module/my-agent/module-provider.ts
export function createMyAgentModuleProvider(deps: MyAgentModuleProviderDeps): AgentModuleProvider {
  return createAgentModuleProvider<MyAgentProvider>(
    {
      type: "my-agent",
      configKey: "version.my-agent",
      displayName: "My Agent",
      icon: "rocket",
      serverName: "My Agent",
      scripts: ["ch-my-agent"],
      serverManager: deps.serverManager,
      resolveBinary() { ... },
      createProvider: (path) => new MyAgentProvider(path, deps.logger),
      connectProvider: (provider, port) => provider.connect(port),
      initialStatus: () => "none",
      startServer: (path) => deps.serverManager.startServer(path).then(() => undefined),
      applyTerminalLifecycle: (path, event, ctx) => { ... },
    },
    { logger: deps.logger, downloadDeps: deps.downloadDeps, binaryName: deps.binaryConfig.name }
  );
}
```

### 4. Register in the composition root

In `src/main.ts`, construct the module provider and register a module:

```typescript
const myAgentProvider = createMyAgentModuleProvider({ ... });
dispatcher.registerModule(createAgentModule(myAgentProvider, { dispatcher, logger, agentConfig }));
```

Also extend the `AgentType` union (`src/shared/plugin-protocol`) — this is an interface change requiring approval (see CLAUDE.md).

---

## Testing

### Integration Test Coverage

The primary suites are `claude/module-provider.integration.test.ts` and `opencode/module-provider.integration.test.ts`. They exercise the full `AgentModuleProvider` surface against a stubbed server manager and a `vi.mock`ed provider class, covering:

1. **Identity constants and binary management** (preflight/download)
2. **Server started/stopped callbacks** (first start, restart-reconnect, full stop)
3. **Status change propagation and deduplication**
4. **Session retrieval and environment variables**
5. **Prompt plumbing** (Claude prompt file / OpenCode pending prompt)
6. **Disposal cleanup**

### Testing the OpenCode Client

```typescript
const mockSdk = createMockSdkClient({
  sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
  sessionStatuses: { "ses-1": { type: "idle" } },
});
const factory = createMockSdkFactory(mockSdk);
const client = new OpenCodeClient(8080, SILENT_LOGGER, factory);
```

See `opencode/sdk-client.state-mock.ts` and docs/TESTING.md for conventions.
