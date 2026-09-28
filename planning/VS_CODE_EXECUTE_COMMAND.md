---
status: COMPLETED
last_updated: 2025-12-27
reviewers: [review-arch, review-typescript, review-testing, review-docs]
---

# VS_CODE_EXECUTE_COMMAND

## Overview

- **Problem**: VS Code extensions and AI agents (via MCP) cannot programmatically execute VS Code commands in their workspace. The existing command execution infrastructure (`PluginServer.sendCommand()`) is only used internally for startup/shutdown commands.
- **Solution**: Add `executeCommand` to `IWorkspaceApi` in CodeHydraApi, exposing it through the Public API for extensions and MCP server for AI agents.
- **Risks**:
  - Security: Any VS Code command can be executed. Mitigated by the fact that extensions already have full VS Code API access.
  - Loopback: Extension asks server to send command back to itself. This is intentional for consistency and auditability.
- **Alternatives Considered**:
  - Direct `vscode.commands.executeCommand()` in extensions: Already possible, but doesn't go through CodeHydra API layer for logging/auditing. **Note**: Extensions wanting to execute commands in their own workspace without the overhead should use this directly.
  - Handle executeCommand directly in PluginServer: Rejected - inconsistent with other API methods, MCP Server would need direct PluginServer dependency.
  - Allowlist of commands: Rejected due to maintenance burden and limiting flexibility.

### Use Case Guidance

The `executeCommand` API via CodeHydra is primarily valuable for:

1. **MCP server** - enabling AI agents to trigger VS Code commands
2. **Remote execution** - external systems executing commands via WebSocket
3. **Auditability** - centralized logging of command execution

For extensions wanting to execute commands in their own workspace with minimal overhead, use `vscode.commands.executeCommand()` directly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CodeHydra (Main Process)                            │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                          PluginServer                               │   │
│   │                                                                     │   │
│   │   Client-to-Server Events:                                          │   │
│   │                                                                     │   │
│   │   api:workspace:getStatus         ──┐                               │   │
│   │   api:workspace:getMetadata       ──┤                               │   │
│   │   api:workspace:setMetadata       ──┼──► ApiCallHandlers            │   │
│   │   api:workspace:getOpencodePort   ──┤      (wire-plugin-api)        │   │
│   │   api:workspace:delete            ──┤            │                  │   │
│   │   api:workspace:executeCommand    ──┘            │                  │   │
│   │                                                  ▼                  │   │
│   │   Server-to-Client:                        CodeHydraApi             │   │
│   │                                                  │                  │   │
│   │   "command" event ◄──────────────────────────────┘                  │   │
│   │                                    (executeCommand implementation   │   │
│   │                                     calls pluginServer.sendCommand) │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                     │
│   ┌───────────────────────────────────┼─────────────────────────────────┐   │
│   │                MCP Server         │                                 │   │
│   │                                   ▼                                 │   │
│   │   workspace_get_status      ──────┬──► CodeHydraApi                 │   │
│   │   workspace_get_metadata    ──────┤                                 │   │
│   │   workspace_set_metadata    ──────┤                                 │   │
│   │   workspace_get_opencode_port ────┤                                 │   │
│   │   workspace_delete          ──────┤                                 │   │
│   │   workspace_execute_command ──────┘                                 │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Socket.IO
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    codehydra-sidekick extension (VS Code)                   │
│                                                                             │
│   Receives "command" event ──► vscode.commands.executeCommand()             │
│                                                                             │
│   codehydraApi.workspace:                                                   │
│     .getStatus()        ──► emits api:workspace:getStatus                   │
│     .getMetadata()      ──► emits api:workspace:getMetadata                 │
│     .setMetadata()      ──► emits api:workspace:setMetadata                 │
│     .getOpencodePort()  ──► emits api:workspace:getOpencodePort             │
│     .executeCommand()   ──► emits api:workspace:executeCommand              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Dependency Graph

```
PluginServer (created first, standalone)
     │
     ▼
CodeHydraApi (depends on PluginServer for executeCommand)
     │
     ├──► wire-plugin-api (connects PluginServer events to CodeHydraApi)
     │
     └──► MCP Server (uses CodeHydraApi only, no direct PluginServer dependency)
```

### Data Flow for executeCommand

```
Extension calls:
  api.workspace.executeCommand("workbench.action.files.save")
         │
         ▼
Socket.IO emit: "api:workspace:executeCommand"
  { command: "workbench.action.files.save" }
         │
         ▼
PluginServer receives, calls ApiCallHandlers.executeCommand()
         │
         ▼
wire-plugin-api.ts handler
  - Resolves workspace path to projectId/workspaceName
  - Calls codeHydraApi.workspaces.executeCommand(projectId, workspaceName, command, args)
         │
         ▼
CodeHydraApiImpl.workspaces.executeCommand()
  - Resolves workspace to get path
  - Calls pluginServer.sendCommand(workspacePath, command, args)
  - Unwraps PluginResult: throws on error, returns data on success
         │
         ▼
PluginServer.sendCommand()
  - Emits "command" event to the workspace's socket
  - Returns PluginResult<unknown> (10-second timeout)
         │
         ▼
Extension receives "command" event
  - Executes vscode.commands.executeCommand(command, ...args)
  - Returns result via acknowledgment
         │
         ▼
Result flows back through the chain to caller
(Most VS Code commands return undefined)
```

### Error Handling

The `executeCommand` method follows the existing `IWorkspaceApi` pattern - it **throws on error** rather than returning a result wrapper:

- **Workspace not found**: Throws `Error("Workspace not found")`
- **Workspace not connected**: Throws `Error("Workspace not connected")`
- **Command execution failed**: Throws `Error("<error message from VS Code>")`
- **Timeout**: Throws `Error("Command timed out")` (10-second limit)

## Implementation Steps

- [x] **Step 1: Add ExecuteCommandRequest type to plugin-protocol.ts**
  - Add `ExecuteCommandRequest` interface with `command: string` and optional `args: readonly unknown[]`
  - Add `validateExecuteCommandRequest()` validation function:
    - Command must be non-empty string after trim
    - Args must be array if present
  - Add `api:workspace:executeCommand` to `ClientToServerEvents`
  - Files: `src/shared/plugin-protocol.ts`
  - Test criteria: Validation accepts valid requests, rejects invalid (empty command, whitespace-only, non-array args)

- [x] **Step 2: Add executeCommand to IWorkspaceApi interface**
  - Add method signature:
    ```typescript
    executeCommand(
      projectId: ProjectId,
      workspaceName: WorkspaceName,
      command: string,
      args?: readonly unknown[]
    ): Promise<unknown>;
    ```
  - Add JSDoc documenting that it throws on error (not returns result wrapper)
  - Files: `src/shared/api/interfaces.ts`
  - Test criteria: Interface compiles, method signature is correct

- [x] **Step 3: Add PluginServer dependency to CodeHydraApiImpl**
  - Add `pluginServer: PluginServer` parameter to constructor
  - Store as instance property
  - Update construction in `main/index.ts` to pass PluginServer
  - Files: `src/main/api/codehydra-api.ts`, `src/main/index.ts`
  - Test criteria: CodeHydraApiImpl receives and stores PluginServer instance

- [x] **Step 4: Implement executeCommand in CodeHydraApiImpl**
  - Implement `workspaces.executeCommand()` method
  - Resolve projectId/workspaceName to workspace path
  - Call `pluginServer.sendCommand(workspacePath, command, args)`
  - **Unwrap PluginResult**: throw on `success: false`, return `data` on success
  - Add structured logging: `this.logger.info("Executing command", { projectId, workspaceName, command, hasArgs: !!args })`
  - Files: `src/main/api/codehydra-api.ts`
  - Test criteria: Method calls sendCommand, unwraps result correctly, throws on error

- [x] **Step 5: Add executeCommand to PluginServer ApiCallHandlers**
  - Add method signature to `ApiCallHandlers` interface:
    ```typescript
    executeCommand(
      workspacePath: string,
      request: ExecuteCommandRequest
    ): Promise<PluginResult<unknown>>;
    ```
  - Add socket event handler in `setupApiHandlers()` method
  - Handler validates request using `validateExecuteCommandRequest()`, calls handler, returns result
  - Files: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Handler calls registered callback, propagates errors correctly

- [x] **Step 6: Add executeCommand handler to wire-plugin-api.ts**
  - Add `executeCommand` handler that calls `api.workspaces.executeCommand()`
  - Wrap in try/catch to convert thrown errors to `PluginResult` format
  - Files: `src/main/api/wire-plugin-api.ts`
  - Test criteria: Handler resolves workspace and delegates to API, converts errors to PluginResult

- [x] **Step 7: Add workspace.executeCommand() to extension client**
  - Add `executeCommand(command, args)` method to `codehydraApi.workspace` object
  - Add client-side validation before emitting:
    ```javascript
    if (typeof command !== "string" || command.trim().length === 0) {
      return Promise.reject(new Error("Command must be a non-empty string"));
    }
    if (args !== undefined && !Array.isArray(args)) {
      return Promise.reject(new Error("Args must be an array"));
    }
    ```
  - Call `emitApiCall("api:workspace:executeCommand", { command, args })`
  - Files: `src/services/vscode-setup/assets/codehydra-sidekick/extension.js`
  - Test criteria: Method exists, validates inputs, emits correct event

- [x] **Step 8: Add executeCommand type declaration to api.d.ts**
  - Add to `WorkspaceApi`:
    ```typescript
    /**
     * Execute a VS Code command in this workspace.
     *
     * Note: Most VS Code commands return `undefined`. The return type is `unknown`
     * because command return types are not statically typed.
     *
     * @param command - VS Code command identifier (e.g., "workbench.action.files.save")
     * @param args - Optional arguments to pass to the command
     * @returns The command's return value, or undefined if command returns nothing
     * @throws Error if workspace disconnected, command not found, or execution fails
     * @throws Error if command times out (10-second limit)
     *
     * @example
     * // Save all files (returns undefined)
     * await api.workspace.executeCommand('workbench.action.files.saveAll');
     *
     * // Get selected text (returns string | undefined)
     * const text = await api.workspace.executeCommand('editor.action.getSelectedText');
     */
    executeCommand(command: string, args?: readonly unknown[]): Promise<unknown>;
    ```
  - Files: `src/services/vscode-setup/assets/codehydra-sidekick/api.d.ts`
  - Test criteria: TypeScript types are correct, JSDoc is comprehensive

- [x] **Step 9: Add workspace_execute_command tool to MCP server**
  - Register `workspace_execute_command` tool with zod schema:
    ```typescript
    z.object({
      command: z.string().min(1).max(256).describe("VS Code command identifier"),
      args: z.array(z.unknown()).optional().describe("Optional command arguments"),
    });
    ```
  - Tool handler gets context, calls `api.workspaces.executeCommand()`
  - Handle success/error responses following existing pattern
  - Files: `src/services/mcp-server/mcp-server.ts`
  - Test criteria: Tool registered with constraints, calls API, handles errors

- [x] **Step 10: Update extension version**
  - Bump version in `package.json` from `0.0.1` to `0.0.2`
  - Update `extensions.json` with new version and vsix filename
  - Files: `src/services/vscode-setup/assets/codehydra-sidekick/package.json`, `src/services/vscode-setup/assets/extensions.json`
  - Test criteria: Preflight detects version change and reinstalls extension

- [x] **Step 11: Update API documentation**
  - Add `executeCommand` to Public API workspace namespace table
  - Add usage examples:
    - Save all files: `api.workspace.executeCommand('workbench.action.files.saveAll')`
    - Open settings: `api.workspace.executeCommand('workbench.action.openSettings')`
    - Command with return value: `const text = await api.workspace.executeCommand('editor.action.getSelectedText')`
  - Add to WebSocket Event Channels table (Client→Server)
  - Add `ExecuteCommandRequest` type definition
  - Document timeout (10-second limit) and error cases
  - Files: `docs/API.md`
  - Test criteria: Documentation is accurate and complete

- [x] **Step 12: Update docs/ARCHITECTURE.md**
  - Add `executeCommand` to Plugin Interface "Client → Server (API Calls)" protocol table
  - Files: `docs/ARCHITECTURE.md`
  - Test criteria: Architecture docs reflect new API method

- [x] **Step 13: Update AGENTS.md with MCP server tools table**
  - Add new "## MCP Server" section after "Plugin API" section
  - Include table listing all available MCP tools:
    | Tool                          | Description                                     |
    | ----------------------------- | ----------------------------------------------- |
    | `workspace_get_status`        | Get workspace status (dirty flag, agent status) |
    | `workspace_get_metadata`      | Get all workspace metadata                      |
    | `workspace_set_metadata`      | Set or delete a metadata key                    |
    | `workspace_get_opencode_port` | Get OpenCode server port                        |
    | `workspace_execute_command`   | Execute a VS Code command                       |
    | `workspace_delete`            | Delete the workspace                            |
  - Note that MCP tools mirror Public API workspace methods
  - Files: `AGENTS.md`
  - Test criteria: AI agents can reference available MCP tools

- [x] **Step 14: Add unit tests for plugin-protocol validation**
  - Test `validateExecuteCommandRequest()` with valid inputs
  - Test with missing command, empty command, whitespace-only command
  - Test with invalid args type (string, object, null)
  - Test with valid args (empty array, array with values)
  - Files: `src/shared/plugin-protocol.test.ts`
  - Test criteria: All validation cases covered

- [x] **Step 15: Add unit tests for CodeHydraApiImpl.executeCommand**
  - Test successful command execution (returns result data)
  - Test workspace not found error (throws)
  - Test workspace not connected error (throws)
  - Test command execution failure propagation (throws)
  - Test constructor stores PluginServer reference
  - Files: `src/main/api/codehydra-api.test.ts`
  - Test criteria: Method behavior verified, error handling correct

- [x] **Step 16: Add unit tests for wire-plugin-api executeCommand**
  - Test handler delegates to API correctly
  - Test handler converts thrown errors to PluginResult
  - Test workspace resolution failure
  - Files: `src/main/api/wire-plugin-api.test.ts`
  - Test criteria: Handler behavior verified

- [x] **Step 17: Add unit tests for MCP tools.test.ts**
  - Add `workspace_execute_command` tool tests following existing pattern
  - Test successful execution, workspace not found, command failure
  - Files: `src/services/mcp-server/tools.test.ts`
  - Test criteria: Tool behavior matches other tools pattern

- [x] **Step 18: Add boundary test for PluginServer executeCommand event**
  - Test real Socket.IO client sending `api:workspace:executeCommand`
  - Verify handler is called with correct params
  - Verify response is returned correctly
  - Files: `src/services/plugin-server/plugin-server.boundary.test.ts`
  - Test criteria: End-to-end Socket.IO communication works

- [x] **Step 19: Add integration test for full round-trip**
  - Create integration test with real PluginServer and CodeHydraApi
  - Mock Socket.IO client connection
  - Call `api.workspaces.executeCommand()`
  - Verify command event emitted to socket
  - Simulate acknowledgment response
  - Verify result returned to caller
  - Files: `src/main/api/codehydra-api.integration.test.ts`
  - Test criteria: Full API → PluginServer → Socket chain verified

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                        | Description                                      | File                    |
| ------------------------------------------------ | ------------------------------------------------ | ----------------------- |
| validateExecuteCommandRequest valid              | Accepts `{ command: "test" }`                    | plugin-protocol.test.ts |
| validateExecuteCommandRequest valid with args    | Accepts `{ command: "test", args: [1, 2] }`      | plugin-protocol.test.ts |
| validateExecuteCommandRequest empty command      | Rejects `{ command: "" }`                        | plugin-protocol.test.ts |
| validateExecuteCommandRequest whitespace command | Rejects `{ command: "   " }`                     | plugin-protocol.test.ts |
| validateExecuteCommandRequest missing command    | Rejects `{}`                                     | plugin-protocol.test.ts |
| validateExecuteCommandRequest invalid args       | Rejects `{ command: "test", args: "not-array" }` | plugin-protocol.test.ts |
| CodeHydraApi constructor stores PluginServer     | Verifies dependency injection                    | codehydra-api.test.ts   |
| CodeHydraApi executeCommand success              | Calls sendCommand, unwraps result                | codehydra-api.test.ts   |
| CodeHydraApi executeCommand not found            | Throws for unknown workspace                     | codehydra-api.test.ts   |
| CodeHydraApi executeCommand not connected        | Throws for disconnected workspace                | codehydra-api.test.ts   |
| CodeHydraApi executeCommand failure              | Throws on sendCommand error                      | codehydra-api.test.ts   |
| wire executeCommand success                      | Delegates to api, returns PluginResult           | wire-plugin-api.test.ts |
| wire executeCommand error                        | Converts thrown error to PluginResult            | wire-plugin-api.test.ts |
| MCP tool success                                 | Calls api, returns result                        | tools.test.ts           |
| MCP tool workspace not found                     | Returns workspace-not-found error                | tools.test.ts           |
| MCP tool command failure                         | Returns internal-error with message              | tools.test.ts           |

### Boundary Tests

| Test Case                         | Description                            | File                           |
| --------------------------------- | -------------------------------------- | ------------------------------ |
| PluginServer executeCommand event | Real Socket.IO client-server roundtrip | plugin-server.boundary.test.ts |

### Integration Tests

| Test Case                      | Description                            | File                              |
| ------------------------------ | -------------------------------------- | --------------------------------- |
| executeCommand full round-trip | API → PluginServer → Socket → Response | codehydra-api.integration.test.ts |

### Manual Testing Checklist

- [ ] Start app in development mode (`npm run dev`)
- [ ] Open a project and create a workspace
- [ ] In code-server, open Developer Tools console and test:

  ```javascript
  const ext = await vscode.extensions.getExtension("codehydra.sidekick");
  const api = ext.exports.codehydra;
  await api.whenReady();

  // Test command execution
  await api.workspace.executeCommand("workbench.action.files.saveAll");

  // Test command that opens a file
  await api.workspace.executeCommand("workbench.action.files.newUntitledFile");

  // Test command with return value
  const result = await api.workspace.executeCommand("editor.action.getSelectedText");
  console.log("Selected text:", result);

  // Test invalid command (should error)
  try {
    await api.workspace.executeCommand("nonexistent.command");
  } catch (e) {
    console.log("Expected error:", e.message);
  }

  // Test empty command (should error from client validation)
  try {
    await api.workspace.executeCommand("");
  } catch (e) {
    console.log("Expected error:", e.message);
  }
  ```

- [ ] Verify commands execute correctly
- [ ] Verify MCP tool works via OpenCode agent:
  - Start OpenCode in a workspace
  - Use MCP tool to execute a VS Code command (e.g., save file)
  - Verify command executes successfully
  - Test error case (invalid command)

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `docs/API.md`          | Add executeCommand to Public API workspace namespace table, add examples, add to WebSocket events, document timeout and errors |
| `docs/ARCHITECTURE.md` | Add executeCommand to Plugin Interface "Client → Server (API Calls)" protocol table                                            |
| `AGENTS.md`            | Add MCP Server section with available tools table                                                                              |

### New Documentation Required

| File   | Purpose                           |
| ------ | --------------------------------- |
| (none) | No new documentation files needed |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
