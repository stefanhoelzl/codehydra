---
status: USER_TESTING
last_updated: 2025-12-31
reviewers: []
---

# RESTART_OPENCODE_SERVER

## Overview

- **Problem**: When updating OpenCode config files (e.g., `opencode.jsonc`) in a workspace, changes cannot be tested without restarting the entire CodeHydra application. This is disruptive because it affects all workspaces.
- **Solution**: Add a new API method `restartOpencodeServer` that restarts the OpenCode server for a single workspace while preserving the same port. This allows config changes to take effect immediately without affecting other workspaces.
- **Risks**:
  - Port reuse timing: There's a small window where the port could be claimed by another process between stop and start. Mitigation: Clear error message if port unavailable.
  - Session loss: Active OpenCode sessions will be terminated (mitigated by existing session restoration in the wrapper script)
- **Alternatives Considered**:
  - **New port allocation**: Rejected because existing terminals would have stale `CODEHYDRA_OPENCODE_PORT` env var
  - **Hot-reload config**: Would require OpenCode to support this; not available currently
  - **New onServerRestarted callback**: Rejected in favor of reusing existing `onServerStopped` → `onServerStarted` pattern

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Main Process                                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ OpenCodeServerManager                                                │   │
│  │                                                                     │   │
│  │  restartServer(workspacePath)                                       │   │
│  │    1. Get current port from running server                          │   │
│  │    2. stopServer(workspacePath)   → fires onServerStopped           │   │
│  │    3. startServerOnPort(workspacePath, port)  → fires onServerStarted│   │
│  │    4. Return RestartServerResult                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ AgentStatusManager (existing wiring in AppState)                     │   │
│  │                                                                     │   │
│  │  onServerStopped(path)  → removeWorkspace(path)  [disconnect SSE]   │   │
│  │  onServerStarted(path, port) → initWorkspace(path, port) [reconnect]│   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  API Layer:                                                                 │
│  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐              │
│  │ Private API    │   │ Public API     │   │ MCP Server     │              │
│  │ (IPC Handler)  │   │ (Plugin Proto) │   │ (Tool)         │              │
│  └───────┬────────┘   └───────┬────────┘   └───────┬────────┘              │
│          │                    │                    │                        │
│          └────────────────────┴────────────────────┘                        │
│                              │                                              │
│                   workspaces.restartOpencodeServer()                        │
│                              │                                              │
│                              ▼                                              │
│                   OpenCodeServerManager.restartServer()                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Callback Flow During Restart

```
restartServer(path)
    │
    ├─► stopServer(path)
    │       │
    │       └─► onServerStopped(path)
    │               │
    │               └─► AgentStatusManager.removeWorkspace(path)
    │                       └─► OpenCodeClient.dispose() [closes SSE]
    │
    └─► startServerOnPort(path, port)
            │
            └─► onServerStarted(path, port)
                    │
                    └─► AgentStatusManager.initWorkspace(path, port)
                            └─► Creates new OpenCodeClient [opens SSE]
```

## Implementation Steps

- [x] **Step 1: Add restartServer method to OpenCodeServerManager**
  - Add `RestartServerResult` type:
    ```typescript
    export type RestartServerResult =
      | { readonly success: true; readonly port: number }
      | { readonly success: false; readonly error: string; readonly serverStopped: boolean };
    ```
  - Add `"restarting"` state to `ServerEntry` type:
    ```typescript
    type ServerEntry =
      | { readonly state: "starting"; readonly startPromise: Promise<number> }
      | { readonly state: "running"; readonly port: number; readonly process: SpawnedProcess }
      | {
          readonly state: "restarting";
          readonly port: number;
          readonly restartPromise: Promise<RestartServerResult>;
        };
    ```
  - Add `restartServer(workspacePath: string): Promise<RestartServerResult>` method
  - Add private `startServerOnPort(workspacePath: string, port: number): Promise<number>` method
  - Reuse existing `onServerStopped` and `onServerStarted` callbacks (no new callback type)
  - **Idempotency**: If called while already restarting, return the in-progress `restartPromise`
  - Files affected:
    - `src/services/opencode/opencode-server-manager.ts`
  - Test criteria: Integration tests verify restart returns same port and fires stop/start callbacks

- [x] **Step 2: Add restartOpencodeServer to IWorkspaceApi interface**
  - Add method signature to `IWorkspaceApi` interface:
    ```typescript
    restartOpencodeServer(projectId: ProjectId, workspaceName: WorkspaceName): Promise<number>;
    ```
  - Add IPC channel constant `WORKSPACE_RESTART_OPENCODE_SERVER: "api:workspace:restart-opencode-server"`
  - Files affected:
    - `src/shared/api/interfaces.ts`
    - `src/shared/ipc.ts`
  - Test criteria: TypeScript compiles without errors

- [x] **Step 3: Implement API handler in CoreModule**
  - Add `workspaceRestartOpencodeServer` private method
  - Register IPC handler for `api:workspace:restart-opencode-server`
  - Files affected:
    - `src/main/modules/core/index.ts`
  - Test criteria: Integration tests verify handler returns port number for valid workspace

- [x] **Step 4: Add to Plugin Protocol (Public API)**
  - Add event to `ClientToServerEvents`:
    ```typescript
    "api:workspace:restartOpencodeServer": (ack: (result: PluginResult<number>) => void) => void;
    ```
  - Add handler in `wire-plugin-api.ts`
  - Files affected:
    - `src/shared/plugin-protocol.ts`
    - `src/main/api/wire-plugin-api.ts`
  - Test criteria: Integration test verifies Socket.IO event handling returns port

- [x] **Step 5: Add MCP tool**
  - Add `workspace_restart_opencode_server` tool registration:
    ```typescript
    this.mcpServer.registerTool(
      "workspace_restart_opencode_server",
      {
        description:
          "Restart the OpenCode server for the current workspace, preserving the same port",
        inputSchema: z.object({}),
      },
      this.createWorkspaceHandler(async (resolved) =>
        this.api.workspaces.restartOpencodeServer(resolved.projectId, resolved.workspaceName)
      )
    );
    ```
  - Files affected:
    - `src/services/mcp-server/mcp-server.ts`
  - Test criteria: Integration test verifies tool calls `workspaces.restartOpencodeServer()` and returns port

- [x] **Step 6: Add to sidekick extension API**
  - Add `restartOpencodeServer()` method to `workspace` namespace in `codehydraApi`:
    ```javascript
    restartOpencodeServer() {
      return emitApiCall("api:workspace:restartOpencodeServer");
    },
    ```
  - Update `api.d.ts` with method signature
  - Files affected:
    - `extensions/sidekick/extension.js`
    - `extensions/sidekick/api.d.ts`
  - Test criteria: Integration test mocks Socket.IO and verifies correct event emission

- [x] **Step 7: Add VS Code command**
  - Add `codehydra.restartOpencodeServer` command registration with user feedback:
    ```javascript
    vscode.commands.registerCommand("codehydra.restartOpencodeServer", async () => {
      try {
        const port = await codehydraApi.workspace.restartOpencodeServer();
        vscode.window.showInformationMessage(`OpenCode server restarted on port ${port}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to restart OpenCode server: ${err.message}`);
      }
    });
    ```
  - Add command contribution to `package.json`:
    ```json
    {
      "command": "codehydra.restartOpencodeServer",
      "title": "Restart OpenCode Server",
      "category": "CodeHydra"
    }
    ```
  - Files affected:
    - `extensions/sidekick/extension.js`
    - `extensions/sidekick/package.json`
  - Test criteria: Command appears in VS Code Command Palette as "CodeHydra: Restart OpenCode Server"

- [x] **Step 8: Update documentation**
  - **docs/API.md**:
    - Add to Private API `workspaces` table:
      | Method | Signature | Description |
      |--------|-----------|-------------|
      | `restartOpencodeServer` | `(projectId, workspaceName) => Promise<number>` | Restart OpenCode server, preserving port |
    - Add to Public API `workspace` namespace table:
      | Method | Signature | Description |
      |--------|-----------|-------------|
      | `restartOpencodeServer` | `() => Promise<number>` | Restart OpenCode server, returns port |
    - Add usage example in Public API section
  - **AGENTS.md**:
    - Add to MCP Server tools table:
      | Tool | Description |
      |------|-------------|
      | `workspace_restart_opencode_server` | Restart the OpenCode server for the current workspace |
  - Files affected:
    - `docs/API.md`
    - `AGENTS.md`
  - Test criteria: Documentation is accurate and complete

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks.

**Test file locations:**

- `src/services/opencode/opencode-server-manager.integration.test.ts` - Tests 1-6
- `src/main/modules/core/index.integration.test.ts` - Test 7
- `src/main/api/wire-plugin-api.integration.test.ts` - Test 8
- `src/services/mcp-server/mcp-server.integration.test.ts` - Test 9

| #   | Test Case                                                   | Entry Point                                       | Behavioral Mock State                                                                   | Behavior Verified                                                                     |
| --- | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | restart returns same port                                   | `serverManager.restartServer(path)`               | ProcessRunner: tracks PID, allows kill+respawn; HttpClient: returns healthy after spawn | `expect(result.port).toBe(originalPort)`                                              |
| 2   | restart fails if server not running                         | `serverManager.restartServer(path)`               | No server in map                                                                        | `expect(result.success).toBe(false)`, `expect(result.error).toContain("not running")` |
| 3   | restart fires stop then start callbacks                     | `serverManager.restartServer(path)`               | Track callback invocations                                                              | `onServerStopped` called before `onServerStarted`, both with correct path/port        |
| 4   | restart during starting state waits then restarts           | `serverManager.restartServer(path)`               | First start in progress                                                                 | Waits for start to complete, then restarts                                            |
| 5   | restart during restarting state returns in-progress promise | `serverManager.restartServer(path)`               | Restart already in progress                                                             | Second call returns same promise as first                                             |
| 6   | restart fails with port conflict                            | `serverManager.restartServer(path)`               | HttpClient: health check fails (port taken)                                             | `expect(result.success).toBe(false)`, `expect(result.serverStopped).toBe(true)`       |
| 7   | API handler returns port for valid workspace                | `CoreModule handler`                              | AppState mock with running server                                                       | `expect(port).toBe(expectedPort)`                                                     |
| 8   | plugin event returns success with port                      | Socket emit `api:workspace:restartOpencodeServer` | PluginServer mock                                                                       | `expect(result.success).toBe(true)`, `expect(result.data).toBe(port)`                 |
| 9   | MCP tool returns port in result                             | MCP tool invocation                               | API mock                                                                                | Result contains port number                                                           |

### Manual Testing Checklist

- [ ] Open CodeHydra with a workspace
- [ ] Modify `opencode.jsonc` in the workspace
- [ ] Run "CodeHydra: Restart OpenCode Server" from Command Palette
- [ ] Verify success notification shows port number
- [ ] Verify OpenCode server restarts (check logs for stop/start sequence)
- [ ] Open new terminal and verify `opencode` command works
- [ ] Verify existing terminal `opencode` command still works (same port)
- [ ] Verify agent status indicator reconnects after restart

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File          | Changes Required                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `docs/API.md` | Add `restartOpencodeServer` to Private API workspaces table, Public API workspace namespace table, and usage example |
| `AGENTS.md`   | Add `workspace_restart_opencode_server` to MCP Server tools table                                                    |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
