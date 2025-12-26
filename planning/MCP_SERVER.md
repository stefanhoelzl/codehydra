---
status: COMPLETED
last_updated: 2024-12-26
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# MCP_SERVER

## Overview

- **Problem**: AI agents running in OpenCode workspaces cannot interact with CodeHydra programmatically. They have no way to query workspace status, manage metadata, or delete workspaces.
- **Solution**: Implement an app-wide MCP (Model Context Protocol) server in CodeHydra that exposes the public API as MCP tools. OpenCode instances auto-connect via injected configuration.
- **Risks**:
  - MCP server port conflicts (mitigated: use dynamic port allocation)
  - Workspace identification reliability (mitigated: use workspace path header with validation)
  - OpenCode config format changes (mitigated: generate minimal config, rely on merging)
- **Alternatives Considered**:
  - Per-workspace MCP servers (rejected: resource overhead, complexity)
  - STDIO transport (rejected: requires spawning per-workspace, doesn't fit "attach" model)
  - Generating `opencode.jsonc` per workspace (rejected: conflicts with user config)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CodeHydra (Electron Main Process)                  │
│                                                                         │
│  ┌──────────────────────┐     ┌─────────────────────────────────────┐  │
│  │   McpServerManager   │     │       OpenCodeServerManager         │  │
│  │                      │     │                                     │  │
│  │  - start()           │     │  Spawns: opencode serve             │  │
│  │  - stop()            │     │  Env vars:                          │  │
│  │  - getPort()         │     │    OPENCODE_CONFIG=<mcp-config>     │  │
│  │                      │     │    CODEHYDRA_WORKSPACE_PATH=<path>  │  │
│  │  Port: dynamic       │     │    CODEHYDRA_MCP_PORT=<port>        │  │
│  └──────────┬───────────┘     └─────────────────────────────────────┘  │
│             │                                                           │
│             │ HTTP :mcp-port                                            │
│             │                                                           │
│  ┌──────────▼───────────┐                                               │
│  │     MCP Server       │                                               │
│  │  (@modelcontextpro..)│                                               │
│  │                      │                                               │
│  │  Tools:              │◄──────────────────────────────────────────┐  │
│  │  - workspace_*       │     HTTP + X-Workspace-Path header        │  │
│  │                      │                                           │  │
│  │  Delegates to:       │                                           │  │
│  │  - ICoreApi          │                                           │  │
│  │  - AppState          │                                           │  │
│  └──────────────────────┘                                           │  │
│                                                                      │  │
└──────────────────────────────────────────────────────────────────────┼──┘
                                                                       │
              ┌────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  opencode serve :14001  │     │  opencode serve :14002  │
│  (workspace A)          │     │  (workspace B)          │
│                         │     │                         │
│  CODEHYDRA_WORKSPACE_   │     │  CODEHYDRA_WORKSPACE_   │
│  PATH=/path/to/ws-a     │     │  PATH=/path/to/ws-b     │
│                         │     │                         │
│  MCP config (merged):   │     │  MCP config (merged):   │
│  codehydra server with  │     │  codehydra server with  │
│  X-Workspace-Path from  │     │  X-Workspace-Path from  │
│  env var substitution   │     │  env var substitution   │
└─────────────────────────┘     └─────────────────────────┘
```

### Startup Sequence

```
startServices()
    │
    ├─► 1. Create McpServerManager
    │       └─► start() → allocate port, write config file
    │
    ├─► 2. Create OpenCodeServerManager (receives MCP port)
    │
    ├─► 3. Create AppState, CodeHydraApiImpl, etc.
    │
    └─► 4. Wire everything together
```

**Critical**: McpServerManager MUST start BEFORE OpenCodeServerManager so the MCP port is available when spawning OpenCode processes.

### Data Flow: MCP Tool Call

```
Agent in OpenCode ──► "call workspace_get_status"
                              │
                              ▼
                     OpenCode MCP Client
                              │
                              │ HTTP POST /mcp
                              │ Header: X-Workspace-Path: /path/to/workspace
                              ▼
                     CodeHydra MCP Server
                              │
                              │ Parse workspace path from header
                              │ Validate path is registered workspace
                              │ Resolve projectId + workspaceName via AppState
                              ▼
                     ICoreApi.workspaces.getStatus()
                              │
                              ▼
                     Return WorkspaceStatus as MCP result
```

### Security Considerations

**Header-based workspace identification**: Using `X-Workspace-Path` header means any HTTP client that can reach the MCP server port could impersonate any workspace by setting the header. This is an **accepted tradeoff** because:

- MCP server only listens on localhost (127.0.0.1)
- Similar to how PluginServer trusts `auth.workspacePath`
- Validation ensures the path is an actual registered workspace

### External System Access Exception

**Exception**: MCP SDK's internal HTTP server is acceptable because it's the official MCP protocol implementation. The SDK controls HTTP transport as part of its protocol semantics. This is similar to how the `ignore` library is used directly as a pure library.

## Implementation Steps

- [x] **Step 1: Add MCP SDK dependency**
  - Install `@modelcontextprotocol/sdk` package
  - Files affected: `package.json`, `package-lock.json`
  - Test criteria:
    - `npm install` completes successfully
    - `@modelcontextprotocol/sdk` is in package.json dependencies
    - No TypeScript errors when importing from the package

- [x] **Step 2: Create MCP server types and test utilities**
  - Create `src/services/mcp-server/` directory
  - Define types for MCP server, including branded `McpWorkspacePath` type
  - Create mock factories following patterns from `src/services/test-utils.ts`
  - Files affected:
    - `src/services/mcp-server/index.ts` (exports)
    - `src/services/mcp-server/types.ts` (types including McpWorkspacePath)
    - `src/services/mcp-server/test-utils.ts` (mock factories)
  - Test criteria: Types compile without errors
  - Mock factories:
    ```typescript
    export function createMockMcpServer(overrides?: Partial<McpServer>): McpServer;
    export function createMockMcpContext(workspacePath: string): McpContext;
    export function createTestMcpClient(port: number): TestMcpClient;
    ```

- [x] **Step 3: Implement workspace path resolution**
  - Create `resolveWorkspace(workspacePath: string, appState: AppState): ResolvedWorkspace | null`
  - Resolution algorithm:
    1. Normalize the workspace path using `path.normalize()`
    2. Call `appState.findProjectForWorkspace(normalizedPath)` to find the project
    3. If not found, return null (workspace not managed by CodeHydra)
    4. Generate projectId using existing ID generation logic
    5. Extract workspaceName from workspace path basename
  - Handle edge cases: workspace not found, invalid paths, symlinks
  - Files affected:
    - `src/services/mcp-server/workspace-resolver.ts`
    - `src/services/mcp-server/workspace-resolver.test.ts`
  - Test criteria (unit tests):
    - Valid workspace path resolves to correct projectId + workspaceName
    - Non-existent workspace path returns null
    - Invalid/malformed paths return null with no crash
    - Windows backslash paths handled correctly
    - Paths with special characters handled

- [x] **Step 4: Create MCP server service with factory injection**
  - Implement `McpServer` class with HTTP transport
  - Use factory injection pattern for `@modelcontextprotocol/sdk` (testability)
  - Constructor signature:

    ```typescript
    type McpServerFactory = (options: McpServerOptions) => McpServerInstance;

    class McpServer implements IDisposable {
      constructor(
        private readonly api: ICoreApi,
        private readonly appState: AppState,
        private readonly serverFactory: McpServerFactory,
        private readonly logger: Logger
      )
    }
    ```

  - Files affected:
    - `src/services/mcp-server/mcp-server.ts` (implementation)
    - `src/services/mcp-server/mcp-server.test.ts` (unit tests with mocked factory)
  - Test criteria (unit tests with mocked SDK):
    - Server creates with injected dependencies
    - Server registers tools correctly
    - Tool handlers delegate to ICoreApi

- [x] **Step 5: Implement MCP tools**
  - `workspace_get_status`: Get workspace status (dirty, agent status)
  - `workspace_get_metadata`: Get all metadata
  - `workspace_set_metadata`: Set/delete a metadata key
  - `workspace_get_opencode_port`: Get OpenCode server port
  - `workspace_delete`: Delete workspace with keepBranch option
  - All tools use callback registration pattern (like PluginServer's `onApiCall`)
  - Files affected:
    - `src/services/mcp-server/tools.ts`
    - `src/services/mcp-server/tools.test.ts`
  - Test criteria (unit tests for each tool):
    - Happy path: returns correct data format
    - Error: workspace not found returns MCP error
    - Error: ICoreApi throws → proper error propagation
    - Error: missing X-Workspace-Path header → clear error message
    - Error: invalid metadata key format → validation error

- [x] **Step 6: Create McpServerManager with boundary abstractions**
  - Manages MCP server lifecycle (start/stop)
  - Allocates dynamic port via `PortManager`
  - Constructor signature:
    ```typescript
    class McpServerManager implements IDisposable {
      constructor(
        private readonly portManager: PortManager,
        private readonly fs: FileSystemLayer,
        private readonly pathProvider: PathProvider,
        private readonly api: ICoreApi,
        private readonly appState: AppState,
        private readonly logger: Logger
      )
    }
    ```
  - Files affected:
    - `src/services/mcp-server/mcp-server-manager.ts`
    - `src/services/mcp-server/mcp-server-manager.test.ts`
  - Test criteria (unit tests with mocked dependencies):
    - Manager starts server on allocated port
    - Manager stops server cleanly
    - Port allocation failure handled gracefully
    - Double-start prevented

- [x] **Step 7: Generate OpenCode MCP config**
  - Create config generator using `FileSystemLayer` and `PathProvider`
  - Config generated at `pathProvider.dataRootDir/opencode/codehydra-mcp.json`
  - Config regenerated each time McpServerManager starts (port may change)
  - Files affected:
    - `src/services/mcp-server/config-generator.ts`
    - `src/services/mcp-server/config-generator.test.ts`
  - Test criteria (unit tests):
    - Generated config matches expected JSON structure
    - Config uses correct environment variable substitution syntax
    - FileSystemLayer.writeFile called with correct path
  - Test criteria (boundary tests):
    - Config file written to temp directory is valid JSON
    - Config validates against OpenCode schema (if available)

- [x] **Step 8: Add MCP server boundary tests**
  - Test actual HTTP transport behavior (real SDK, real HTTP)
  - Files affected:
    - `src/services/mcp-server/mcp-server.boundary.test.ts`
  - Test criteria:
    - HTTP server starts and accepts connections
    - MCP protocol handshake succeeds
    - Tool call over HTTP returns correct result
    - Invalid workspace path returns proper MCP error
    - Concurrent requests handled correctly
    - Server shutdown closes connections cleanly
    - Port conflict → retry or fail gracefully

- [x] **Step 9: Update OpenCodeServerManager**
  - Pass `OPENCODE_CONFIG` environment variable when spawning
  - Pass `CODEHYDRA_WORKSPACE_PATH` environment variable
  - Pass `CODEHYDRA_MCP_PORT` environment variable
  - Receive MCP port via constructor or setter (from McpServerManager)
  - Files affected:
    - `src/services/opencode/opencode-server-manager.ts`
    - `src/services/opencode/opencode-server-manager.test.ts`
  - Test criteria (boundary tests):
    - Spawned process receives all three env vars
    - Env vars have correct values
    - Missing MCP port → graceful handling (log warning, skip MCP config)

- [x] **Step 10: Integrate into main process startup**
  - Start MCP server during `startServices()` BEFORE OpenCodeServerManager
  - Pass MCP server port to OpenCodeServerManager
  - Add McpServerManager to cleanup sequence (dispose AFTER OpenCodeServerManager)
  - Files affected:
    - `src/main/index.ts`
  - Test criteria (integration tests):
    - MCP server starts and port file written before first OpenCode spawn
    - App shutdown disposes McpServerManager after OpenCodeServerManager
    - Full startup/shutdown cycle completes without errors

- [x] **Step 11: Extend Public API with workspace deletion**
  - Add `delete` method to public workspace API (via PluginServer for consistency)
  - Both MCP and PluginServer share same underlying `IWorkspaceApi.remove()` call
  - Files affected:
    - `src/services/plugin-server/plugin-handlers.ts` (add handler)
    - `src/shared/plugin-protocol.ts` (add DeleteWorkspaceRequest type)
    - `docs/API.md`:
      - Public API > workspace namespace table: Add `delete` method row
      - Public API > Usage Examples: Add "Delete Current Workspace" example
      - WebSocket Access > Event Channels table: Add `api:workspace:delete` row
      - Type Definitions: Add `DeleteWorkspaceRequest` interface
  - Test criteria (integration tests):
    - Deletion via plugin API triggers workspace removal
    - keepBranch option respected

- [x] **Step 12: Update documentation**
  - Update `docs/ARCHITECTURE.md`:
    - Add McpServerManager to App Services section
    - Add MCP server to Component Architecture diagram
    - Update OpenCode Integration section with new env vars
    - Add MCP server to startup flow
  - Update `docs/API.md` (see Step 11)
  - Update `AGENTS.md`:
    - Add `[mcp]` to Logger Names table
    - Add MCP server to Key Concepts table
  - Files affected:
    - `docs/ARCHITECTURE.md`
    - `docs/API.md`
    - `AGENTS.md`
  - Test criteria: Documentation accurately reflects implementation

## Testing Strategy

### Unit Tests (vitest)

| Test Case                          | Description                              | File                         |
| ---------------------------------- | ---------------------------------------- | ---------------------------- |
| Workspace resolver - valid         | Resolves path to projectId/workspaceName | `workspace-resolver.test.ts` |
| Workspace resolver - not found     | Returns null for unknown workspace       | `workspace-resolver.test.ts` |
| Workspace resolver - invalid       | Handles malformed paths gracefully       | `workspace-resolver.test.ts` |
| Config generator                   | Generates valid OpenCode config JSON     | `config-generator.test.ts`   |
| Tool: workspace_get_status         | Returns correct status format            | `tools.test.ts`              |
| Tool: workspace_get_status error   | Handles workspace not found              | `tools.test.ts`              |
| Tool: workspace_get_metadata       | Returns metadata object                  | `tools.test.ts`              |
| Tool: workspace_set_metadata       | Sets/deletes metadata                    | `tools.test.ts`              |
| Tool: workspace_set_metadata error | Validates key format                     | `tools.test.ts`              |
| Tool: workspace_get_opencode_port  | Returns port or null                     | `tools.test.ts`              |
| Tool: workspace_delete             | Calls API with correct params            | `tools.test.ts`              |
| Manager lifecycle                  | Start/stop server correctly              | `mcp-server-manager.test.ts` |
| Manager port conflict              | Handles port allocation failure          | `mcp-server-manager.test.ts` |

### Integration Tests

| Test Case           | Description                       | File                                |
| ------------------- | --------------------------------- | ----------------------------------- |
| Startup sequence    | MCP starts before OpenCode spawns | `mcp-server.integration.test.ts`    |
| Shutdown sequence   | Cleanup order correct             | `mcp-server.integration.test.ts`    |
| Plugin API deletion | Workspace delete via Socket.IO    | `plugin-server.integration.test.ts` |

### Boundary Tests

| Test Case             | Description                               | File                                       |
| --------------------- | ----------------------------------------- | ------------------------------------------ |
| HTTP server lifecycle | Server starts, accepts connections, stops | `mcp-server.boundary.test.ts`              |
| MCP protocol          | Tool call over HTTP returns result        | `mcp-server.boundary.test.ts`              |
| Error responses       | Invalid workspace returns MCP error       | `mcp-server.boundary.test.ts`              |
| Concurrent requests   | Multiple requests handled correctly       | `mcp-server.boundary.test.ts`              |
| Config file write     | Config written to filesystem correctly    | `config-generator.boundary.test.ts`        |
| OpenCode env vars     | Spawned process receives env vars         | `opencode-server-manager.boundary.test.ts` |

### Manual Testing Checklist

- [ ] Start CodeHydra with a workspace
- [ ] Verify OpenCode receives MCP config (check OpenCode logs/settings)
- [ ] Use agent to call `workspace_get_status` tool
- [ ] Use agent to call `workspace_get_metadata` tool
- [ ] Use agent to set metadata via `workspace_set_metadata`
- [ ] Use agent to delete workspace via `workspace_delete`
- [ ] Verify workspace deletion terminates OpenCode and removes view
- [ ] Test with multiple workspaces simultaneously
- [ ] Test workspace deletion while other workspace is active

**Note**: Manual testing only required after all automated tests pass. Focus on end-to-end agent UX, not functionality already covered by tests.

## Dependencies

| Package                     | Purpose                     | Approved |
| --------------------------- | --------------------------- | -------- |
| `@modelcontextprotocol/sdk` | MCP protocol implementation | [x]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `npm add <package>` to use the latest versions.**

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add McpServerManager to App Services, update startup flow diagram, add MCP to OpenCode integration section |
| `docs/API.md`          | Add workspace delete method, add MCP server section, add DeleteWorkspaceRequest type                       |
| `AGENTS.md`            | Add `[mcp]` logger, add MCP server to Key Concepts                                                         |

### New Documentation Required

| File   | Purpose                                |
| ------ | -------------------------------------- |
| (none) | MCP server documented in existing docs |

## Type Definitions

### Branded Types

```typescript
// Validated workspace path from MCP header
declare const McpWorkspacePathBrand: unique symbol;
type McpWorkspacePath = string & { readonly [McpWorkspacePathBrand]: true };

// Resolved workspace from path
interface ResolvedWorkspace {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
}
```

### MCP Error Types

```typescript
interface McpError {
  readonly code: "workspace-not-found" | "project-not-found" | "invalid-input" | "internal-error";
  readonly message: string;
}

type McpToolResult<T> = { success: true; data: T } | { success: false; error: McpError };
```

### OpenCode Spawn Environment

```typescript
interface OpenCodeSpawnEnv {
  OPENCODE_CONFIG: string; // File path to codehydra-mcp.json
  CODEHYDRA_WORKSPACE_PATH: string; // Absolute workspace path
  CODEHYDRA_MCP_PORT: string; // Port number as string
}
```

## MCP Tool Specifications

**Note**: All workspace tools operate on the workspace specified in the `X-Workspace-Path` HTTP header (set via OpenCode environment variable substitution). Tools do not take workspace identifiers as input parameters.

### workspace_get_status

```json
{
  "name": "workspace_get_status",
  "description": "Get the current workspace status including dirty flag and agent status",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:**

```json
{
  "isDirty": true,
  "agent": {
    "type": "busy",
    "counts": { "idle": 0, "busy": 1, "total": 1 }
  }
}
```

### workspace_get_metadata

```json
{
  "name": "workspace_get_metadata",
  "description": "Get all metadata for the current workspace",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:**

```json
{
  "base": "main",
  "custom-key": "custom-value"
}
```

### workspace_set_metadata

```json
{
  "name": "workspace_set_metadata",
  "description": "Set or delete a metadata key for the current workspace",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "Metadata key (must start with letter, contain only letters/digits/hyphens)"
      },
      "value": {
        "type": ["string", "null"],
        "description": "Value to set, or null to delete the key"
      }
    },
    "required": ["key", "value"]
  }
}
```

**Returns:** `null` on success

### workspace_get_opencode_port

```json
{
  "name": "workspace_get_opencode_port",
  "description": "Get the OpenCode server port for the current workspace",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `14001` or `null`

### workspace_delete

```json
{
  "name": "workspace_delete",
  "description": "Delete the current workspace. This will terminate the OpenCode session.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "keepBranch": {
        "type": "boolean",
        "description": "If true, keep the git branch after deleting the worktree",
        "default": false
      }
    },
    "required": []
  }
}
```

**Returns:** `{ "started": true }` (deletion is async)

## OpenCode Config Format

Generated at `<app-data>/opencode/codehydra-mcp.json` (regenerated on each McpServerManager start):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codehydra": {
      "type": "remote",
      "url": "http://127.0.0.1:{env:CODEHYDRA_MCP_PORT}/mcp",
      "headers": {
        "X-Workspace-Path": "{env:CODEHYDRA_WORKSPACE_PATH}"
      },
      "enabled": true
    }
  }
}
```

## Environment Variables

| Variable                   | Set By                | Used By           | Description             |
| -------------------------- | --------------------- | ----------------- | ----------------------- |
| `CODEHYDRA_MCP_PORT`       | OpenCodeServerManager | OpenCode (config) | MCP server port         |
| `CODEHYDRA_WORKSPACE_PATH` | OpenCodeServerManager | OpenCode (config) | Absolute workspace path |
| `OPENCODE_CONFIG`          | OpenCodeServerManager | OpenCode          | Path to MCP config file |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md, API.md, AGENTS.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
