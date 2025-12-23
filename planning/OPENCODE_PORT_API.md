---
status: COMPLETED
last_updated: 2025-12-23
reviewers: [review-arch, review-testing, review-docs]
---

# OPENCODE_PORT_API

## Overview

- **Problem**: Third-party VS Code extensions need to connect to the OpenCode server running for their workspace, but there's no way to query the port number through the API.
- **Solution**: Add a new `getOpencodePort()` method to the workspace API that returns the port number (or `null` if no server is running). Expose this through both the renderer IPC API and the VS Code extension plugin API.
- **Risks**:
  - Minimal - follows existing patterns exactly
  - Security: Port is only accessible on localhost, consistent with existing OpenCode server behavior
- **Alternatives Considered**:
  - Environment variable: Already available as `OPENCODE_PORT` in code-server terminals, but not accessible to extensions
  - Reading ports.json directly: Would require file system access and parsing, more complex for extensions

### Return Value Semantics

| Condition                                       | Result                              |
| ----------------------------------------------- | ----------------------------------- |
| Valid workspace, server running                 | Returns port number (e.g., `12345`) |
| Valid workspace, server not running             | Returns `null`                      |
| Valid workspace, server manager not initialized | Returns `null`                      |
| Invalid/unknown projectId                       | Throws error                        |
| Invalid/unknown workspaceName for that project  | Throws error                        |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Main Process                                    │
│                                                                             │
│  ┌─────────────────────┐     ┌─────────────────────┐                       │
│  │ OpenCodeServerManager│────►│      AppState       │                       │
│  │   getPort(path)      │     │  getServerManager() │                       │
│  └─────────────────────┘     └──────────┬──────────┘                       │
│                                          │                                  │
│                              ┌───────────▼───────────┐                      │
│                              │   CodeHydraApiImpl    │                      │
│                              │ workspaces.getOpencodePort() │               │
│                              └───────────┬───────────┘                      │
│                                          │                                  │
│              ┌───────────────────────────┼───────────────────────────────┐  │
│              │                           │                               │  │
│     ┌────────▼────────┐         ┌────────▼────────┐        ┌─────────────┴┐ │
│     │  api-handlers   │         │ wire-plugin-api │        │ IPC Events   │ │
│     │ (IPC handler)   │         │ (Socket.IO)     │        │              │ │
│     └────────┬────────┘         └────────┬────────┘        └──────────────┘ │
│              │                           │                                  │
└──────────────┼───────────────────────────┼──────────────────────────────────┘
               │                           │
      ┌────────▼────────┐         ┌────────▼────────┐
      │    Preload      │         │  PluginServer   │
      │ (contextBridge) │         │ (Socket.IO)     │
      └────────┬────────┘         └────────┬────────┘
               │                           │
      ┌────────▼────────┐         ┌────────▼────────┐
      │    Renderer     │         │ codehydra ext   │
      │ api.workspaces  │         │ api.workspace   │
      │ .getOpencodePort│         │ .getOpencodePort│
      └─────────────────┘         └─────────────────┘
```

## Implementation Steps

- [x] **Step 1: Add IPC Channel**
  - Add `WORKSPACE_GET_OPENCODE_PORT` to `ApiIpcChannels` in `src/shared/ipc.ts`
  - Channel name: `api:workspace:get-opencode-port`
  - Files affected: `src/shared/ipc.ts`
  - Test criteria: TypeScript compiles, channel exists in const object

- [x] **Step 2: Add Interface Method**
  - Add `getOpencodePort(projectId, workspaceName): Promise<number | null>` to `IWorkspaceApi` in `src/shared/api/interfaces.ts`
  - Use branded types `ProjectId` and `WorkspaceName` (matching existing methods)
  - Include JSDoc describing return value (null when no server running, throws on invalid project/workspace)
  - Files affected: `src/shared/api/interfaces.ts`
  - Test criteria: TypeScript compiles, interface has new method

- [x] **Step 3: Add Electron API Type**
  - Add `getOpencodePort(projectId, workspaceName): Promise<number | null>` to `Api.workspaces` in `src/shared/electron-api.d.ts`
  - Files affected: `src/shared/electron-api.d.ts`
  - Test criteria: TypeScript compiles, type matches interface

- [x] **Step 4: Implement in CodeHydraApiImpl**
  - Add `getOpencodePort` implementation in `createWorkspaceApi()` method
  - Implementation steps:
    1. Resolve `projectId` to project path using `resolveProjectPath()`
    2. Throw error if project not found
    3. Find workspace within project by matching `workspaceName` to path basename
    4. Throw error if workspace not found
    5. Call `this.appState.getServerManager()?.getPort(workspacePath)`
    6. Convert `undefined` to `null` explicitly (add comment: "Convert undefined to null for JSON compatibility")
    7. Return port number or `null`
  - Follow existing pattern from `getStatus()` method (lines 705-753)
  - Files affected: `src/main/api/codehydra-api.ts`
  - Test criteria: Unit tests pass for new method

- [x] **Step 5: Add IPC Handler**
  - Add handler for `WORKSPACE_GET_OPENCODE_PORT` in `registerApiHandlers()`
  - Validate inputs using existing validators from the same file:
    - `validateProjectId(p?.projectId, "projectId")` - validates ProjectId format
    - `validateWorkspaceName(p?.workspaceName, "workspaceName")` - validates WorkspaceName format
  - Follow validation pattern from `WORKSPACE_GET_STATUS` handler
  - Delegate to `api.workspaces.getOpencodePort()`
  - Files affected: `src/main/ipc/api-handlers.ts`
  - Test criteria: Handler registered, validation works

- [x] **Step 6: Expose in Preload**
  - Add `getOpencodePort(projectId, workspaceName)` to `workspaces` object
  - Use `ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_OPENCODE_PORT, { projectId, workspaceName })`
  - Files affected: `src/preload/index.ts`
  - Test criteria: Preload exposes method correctly

- [x] **Step 7: Add Plugin Protocol Event**
  - Add `"api:workspace:getOpencodePort"` to `ClientToServerEvents` in `src/shared/plugin-protocol.ts`
  - Signature: `(ack: (result: PluginResult<number | null>) => void) => void`
  - Files affected: `src/shared/plugin-protocol.ts`
  - Test criteria: TypeScript compiles, event type is correct

- [x] **Step 8: Add Plugin API Handler Interface**
  - Add `getOpencodePort(workspacePath: string): Promise<PluginResult<number | null>>` to `ApiCallHandlers` interface
  - Note: Plugin handlers receive `workspacePath` (from socket auth), not projectId/workspaceName
  - Resolution happens in `wirePluginApi`, not in PluginServer
  - Files affected: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Interface updated

- [x] **Step 9: Add Socket Handler in PluginServer**
  - Add socket handler for `"api:workspace:getOpencodePort"` in `setupApiHandlers()`
  - Follow pattern from `getStatus` handler (no request payload, just ack)
  - Files affected: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Socket handler works

- [x] **Step 10: Wire Plugin API Handler**
  - Add `getOpencodePort` handler implementation in `wirePluginApi()`
  - Context: Plugin connections are identified by workspace path (from socket auth), but the API requires projectId + workspaceName
  - Resolution steps:
    1. Use `workspaceResolver.findProjectForWorkspace(workspacePath)` to get project
    2. Generate `projectId` from project path using `generateProjectId()`
    3. Extract `workspaceName` from `workspacePath` using `nodePath.basename()`
    4. Call `api.workspaces.getOpencodePort(projectId, workspaceName)`
  - Files affected: `src/main/api/wire-plugin-api.ts`
  - Test criteria: Handler wired correctly

- [x] **Step 11: Add Extension Client Method**
  - Add `getOpencodePort()` method to `codehydraApi.workspace` object
  - Use `emitApiCall("api:workspace:getOpencodePort")`
  - Add JSDoc describing return value
  - Files affected: `src/services/vscode-setup/assets/codehydra-extension/extension.js`
  - Test criteria: Method exists and calls correct event

- [x] **Step 12: Add Extension API Type Declaration**
  - Add `getOpencodePort(): Promise<number | null>` to `WorkspaceApi` interface
  - Include JSDoc with example usage showing how to connect to the OpenCode server
  - Files affected: `src/services/vscode-setup/assets/codehydra-extension/api.d.ts`
  - Test criteria: TypeScript declaration matches implementation

- [x] **Step 13: Update Mock API Handlers for Tests**
  - Add `getOpencodePort` to `MockApiHandlersOptions` and `createMockApiHandlers()`
  - Files affected: `src/services/plugin-server/plugin-server.test-utils.ts`
  - Test criteria: Mock factory updated

- [x] **Step 14: Add Unit Tests for CodeHydraApiImpl**
  - Add tests for `CodeHydraApiImpl.workspaces.getOpencodePort()` in `src/main/api/codehydra-api.test.ts`
  - Group in `describe('getOpencodePort')` block with nested describes for success/null/error cases
  - Test cases:
    - `should return port number when OpenCode server is running for workspace`
    - `should return null when server manager returns undefined (server not running)`
    - `should return null when server manager is not initialized`
    - `should return null when server is starting but port not yet assigned (port = 0)`
    - `should throw error when projectId does not exist in AppState`
    - `should throw error when workspaceName does not exist in project`
  - Files affected: `src/main/api/codehydra-api.test.ts`
  - Test criteria: All test cases pass

- [x] **Step 15: Add IPC Handler Unit Tests**
  - Add tests for the IPC handler in `src/main/ipc/api-handlers.test.ts`
  - Test cases:
    - `should reject with validation error when projectId format is invalid`
    - `should reject with validation error when workspaceName is empty`
    - `should delegate to api.workspaces.getOpencodePort with validated params`
  - Files affected: `src/main/ipc/api-handlers.test.ts`
  - Test criteria: Tests pass

- [x] **Step 16: Add Preload Layer Tests**
  - Add tests in `src/preload/index.test.ts`
  - Test cases:
    - `workspaces.getOpencodePort should invoke WORKSPACE_GET_OPENCODE_PORT IPC channel`
    - `workspaces.getOpencodePort should pass projectId and workspaceName parameters`
    - `workspaces.getOpencodePort should return IPC result`
  - Files affected: `src/preload/index.test.ts`
  - Test criteria: Tests pass

- [x] **Step 17: Add Plugin Server Handler Unit Tests**
  - Add tests in `src/services/plugin-server/plugin-server.test.ts`
  - Test cases:
    - `should register getOpencodePort handler on socket connection`
    - `should call apiHandlers.getOpencodePort with workspace path`
    - `should send result via ack callback`
    - `should handle errors and send error result`
  - Files affected: `src/services/plugin-server/plugin-server.test.ts`
  - Test criteria: Tests pass

- [x] **Step 18: Add Plugin Server Boundary Tests**
  - Add boundary tests in `src/services/plugin-server/plugin-server.boundary.test.ts`
  - Use actual Socket.IO client connection (not mocked) to test protocol layer
  - Test cases:
    - `getOpencodePort Socket.IO event should return port from handler`
    - `getOpencodePort Socket.IO event should handle handler errors gracefully`
  - Files affected: `src/services/plugin-server/plugin-server.boundary.test.ts`
  - Test criteria: Tests pass

- [x] **Step 19: Add wire-plugin-api Unit Tests**
  - Add unit tests in `src/main/api/wire-plugin-api.test.ts`
  - Mock the API handlers
  - Test cases:
    - `getOpencodePort handler should resolve workspace path to projectId and workspaceName`
    - `getOpencodePort handler should return success result with port number`
    - `getOpencodePort handler should return success result with null when no server`
    - `getOpencodePort handler should return error result when workspace not found`
  - Files affected: `src/main/api/wire-plugin-api.test.ts`
  - Test criteria: Tests pass

- [x] **Step 20: Add IPC Integration Test**
  - Add integration test in `src/main/ipc/api-handlers.integration.test.ts`
  - Test full IPC flow: renderer API call → preload → IPC → main process handler → API implementation
  - Test case:
    - `getOpencodePort full IPC flow should return port from server manager`
  - Files affected: `src/main/ipc/api-handlers.integration.test.ts`
  - Test criteria: Tests pass

- [x] **Step 21: Final Validation**
  - Run `npm run validate:fix` to ensure all checks pass
  - Files affected: None (validation only)
  - Test criteria: All checks pass

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                                     | Description                                  | File                      |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| `should return port number when OpenCode server is running`   | Mock server manager with port, verify return | `codehydra-api.test.ts`   |
| `should return null when server manager returns undefined`    | Mock server manager returning undefined      | `codehydra-api.test.ts`   |
| `should return null when server manager is not initialized`   | No server manager set                        | `codehydra-api.test.ts`   |
| `should return null when server is starting (port = 0)`       | Server entry exists but port is 0            | `codehydra-api.test.ts`   |
| `should throw error when projectId does not exist`            | Invalid projectId                            | `codehydra-api.test.ts`   |
| `should throw error when workspaceName does not exist`        | Valid project, invalid workspace             | `codehydra-api.test.ts`   |
| `should reject with validation error for invalid projectId`   | Invalid format                               | `api-handlers.test.ts`    |
| `should reject with validation error for empty workspaceName` | Empty string                                 | `api-handlers.test.ts`    |
| `should delegate to API with validated params`                | Valid input                                  | `api-handlers.test.ts`    |
| `should invoke correct IPC channel`                           | Verify channel name                          | `index.test.ts` (preload) |
| `should pass parameters correctly`                            | Verify payload                               | `index.test.ts` (preload) |
| `should register handler on socket`                           | Handler registration                         | `plugin-server.test.ts`   |
| `should call apiHandlers.getOpencodePort`                     | Handler delegation                           | `plugin-server.test.ts`   |
| `should resolve workspace path to projectId/workspaceName`    | Path resolution                              | `wire-plugin-api.test.ts` |

### Boundary Tests

| Test Case                                        | Description           | File                             |
| ------------------------------------------------ | --------------------- | -------------------------------- |
| `getOpencodePort Socket.IO event returns port`   | Real Socket.IO client | `plugin-server.boundary.test.ts` |
| `getOpencodePort Socket.IO event handles errors` | Real Socket.IO client | `plugin-server.boundary.test.ts` |

### Integration Tests

| Test Case                       | Description                     | File                               |
| ------------------------------- | ------------------------------- | ---------------------------------- |
| `getOpencodePort full IPC flow` | Renderer → preload → IPC → main | `api-handlers.integration.test.ts` |

### Manual Testing Checklist

- [ ] Start app with a workspace
- [ ] Verify OpenCode server starts (check logs for port assignment)
- [ ] In renderer console: `await api.workspaces.getOpencodePort(projectId, workspaceName)` returns port
- [ ] Stop OpenCode server, verify returns null
- [ ] In VS Code extension console: `codehydra.workspace.getOpencodePort()` returns port
- [ ] Test with invalid projectId, verify error in DevTools console
- [ ] Test with invalid workspaceName, verify error in DevTools console
- [ ] Test calling getOpencodePort before workspace is fully initialized

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`            | Add `getOpencodePort()` to Plugin API table in "Available Methods" section                                                                       |
| `docs/ARCHITECTURE.md` | Add `api:workspace:get-opencode-port` to IPC Contract → Commands table with payload `{ projectId, workspaceName }` and response `number \| null` |

### New Documentation Required

| File   | Purpose                                          |
| ------ | ------------------------------------------------ |
| (none) | API is self-documenting via TypeScript and JSDoc |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (AGENTS.md and ARCHITECTURE.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
