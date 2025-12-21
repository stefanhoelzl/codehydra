---
status: COMPLETE
last_updated: 2025-12-21
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# PLUGIN_INTERFACE

## Overview

- **Problem**: CodeHydra and the VS Code extension cannot communicate bidirectionally. Startup commands are hardcoded in the extension, and there's no way to send commands to VS Code or expose CodeHydra APIs to the extension.
- **Solution**: Establish a Socket.IO-based WebSocket connection between CodeHydra (server) and the VS Code extension (client), enabling bidirectional communication with built-in request-response support via acknowledgment callbacks.
- **Risks**:
  - Port conflicts (mitigated by dynamic port allocation)
  - Connection timing (mitigated by Socket.IO's auto-reconnection)
  - Extension may connect before server ready (mitigated by reconnection)
  - Cross-platform path differences (mitigated by path normalization)
- **Alternatives Considered**:
  - Raw WebSocket (`ws`): No built-in reconnection or request-response pattern
  - HTTP polling: Higher latency, more complex for bidirectional events
  - IPC via files: Complex, no real-time events

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  CodeHydra (Electron Main Process)                  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    PluginServer (Socket.IO)                   │  │
│  │                         :dynamic port                         │  │
│  │                                                               │  │
│  │   connections: Map<normalizedWorkspacePath, Socket>           │  │
│  │                                                               │  │
│  │   Server → Client (with ack callback):                        │  │
│  │   ───► "command" (cmd, args, ack) → client returns result    │  │
│  │                                                               │  │
│  │   Timeout: 10s default for command acknowledgments            │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│            CodeServerManager spawns with:                           │
│            CODEHYDRA_PLUGIN_PORT=<port>                             │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ localhost:port (WebSocket)
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Workspace A    │  │  Workspace B    │  │  Workspace C    │
│  /proj/ws-a     │  │  /proj/ws-b     │  │  /proj/ws-c     │
│                 │  │                 │  │                 │
│ ┌─────────────┐ │  │ ┌─────────────┐ │  │ ┌─────────────┐ │
│ │PluginClient │ │  │ │PluginClient │ │  │ │PluginClient │ │
│ │ Socket.IO   │ │  │ │ Socket.IO   │ │  │ │ Socket.IO   │ │
│ └─────────────┘ │  │ └─────────────┘ │  │ └─────────────┘ │
└─────────────────┘  └─────────────────┘  └─────────────────┘

Note: Server = CodeHydra (Electron main), Client = VS Code extension (in code-server)
```

## Connection Lifecycle

```
┌──────────────┐     ┌───────────────┐     ┌──────────────────┐
│ CodeHydra    │     │ code-server   │     │ VS Code Extension│
│ Main Process │     │ (shared)      │     │ (per workspace)  │
└──────┬───────┘     └───────┬───────┘     └────────┬─────────┘
       │                     │                      │
       │ 1. Start PluginServer                      │
       │    (find free port) │                      │
       │                     │                      │
       │ 2. Start code-server│                      │
       │    env: CODEHYDRA_PLUGIN_PORT=<port>       │
       │────────────────────►│                      │
       │                     │                      │
       │                     │ 3. Load workspace    │
       │                     │────────────────────►│
       │                     │                      │
       │                     │ 4. Extension activates,
       │                     │    validates & reads env var
       │                     │                      │
       │ 5. Connect with auth: { workspacePath }    │
       │    (path normalized on both ends)          │
       │◄──────────────────────────────────────────│
       │                     │                      │
       │ 6. Validate auth, store in Map             │
       │    (disconnect old socket if duplicate)    │
       │                     │                      │
       │ 7. emit("command", {cmd, args}, ack)       │
       │    with 10s timeout │                      │
       │────────────────────────────────────────────►
       │                     │    execute command   │
       │                     │    call ack(result)  │
       │◄──────────────────────────────────────────│
       │     callback fires  │                      │
```

## Message Protocol

Socket.IO handles request-response via acknowledgment callbacks. No separate response events needed.

### Shared Types (`src/shared/plugin-protocol.ts`)

```typescript
import path from "node:path";

// Normalize workspace path for consistent Map lookups across platforms
export function normalizeWorkspacePath(workspacePath: string): string {
  return path.normalize(workspacePath);
}

// Result wrapper for all ack responses
export type PluginResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

// VS Code command request
export interface CommandRequest {
  readonly command: string;
  readonly args?: readonly unknown[];
}

// Runtime validation for incoming CommandRequest
export function isValidCommandRequest(payload: unknown): payload is CommandRequest {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "command" in payload &&
    typeof (payload as CommandRequest).command === "string" &&
    (!("args" in payload) || Array.isArray((payload as CommandRequest).args))
  );
}

// Server → Client events (CodeHydra → Extension)
export interface ServerToClientEvents {
  command: (request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void;
}

// Client → Server events (Extension → CodeHydra)
// Currently empty - reserved for future API calls
export interface ClientToServerEvents {}

// Socket metadata (set from auth on connect)
export interface SocketData {
  workspacePath: string; // Normalized path
}

// Default timeout for command acknowledgments (ms)
export const COMMAND_TIMEOUT_MS = 10_000;
```

### Usage Example

**Server (CodeHydra):**

```typescript
// Send command to specific workspace (with timeout)
const result = await pluginServer.sendCommand(
  "/path/to/workspace",
  "workbench.action.closeSidebar",
  []
);
// result: { success: true, data: undefined }
// or: { success: false, error: "Command timed out" }
```

**Client (Extension) - JSDoc typed:**

```javascript
/** @typedef {import('../../shared/plugin-protocol').CommandRequest} CommandRequest */
/** @typedef {import('../../shared/plugin-protocol').PluginResult} PluginResult */

socket.on("command", async (request, ack) => {
  try {
    const result = await vscode.commands.executeCommand(request.command, ...(request.args ?? []));
    ack({ success: true, data: result });
  } catch (err) {
    ack({ success: false, error: String(err) });
  }
});
```

## Implementation Steps

- [x] **Step 1: Add socket.io dependencies**
  - Install `socket.io@^4.7.0` for main process
  - Note: Extension will bundle `socket.io-client@^4.7.0` separately via esbuild
  - Files affected: `package.json`
  - Test criteria: Package installs, types available, `import { Server } from "socket.io"` works

- [x] **Step 2: Create shared protocol types**
  - Create `src/shared/plugin-protocol.ts` with Socket.IO event types
  - Define `ServerToClientEvents`, `ClientToServerEvents`, `SocketData`
  - Define `PluginResult<T>`, `CommandRequest` with `readonly` properties
  - Add `normalizeWorkspacePath()` utility for cross-platform consistency
  - Add `isValidCommandRequest()` type guard for runtime validation
  - Add `COMMAND_TIMEOUT_MS` constant (10000ms)
  - Export types for server use (extension uses JSDoc annotations mirroring these)
  - Files affected: `src/shared/plugin-protocol.ts` (new)
  - Test criteria: TypeScript compiles, import in `src/services/plugin-server/` works

- [x] **Step 3: Create PluginServer service**
  - Create `src/services/plugin-server/plugin-server.ts`
  - Inject `Logger` via constructor (use logger name `[plugin]`)
  - Implement Socket.IO server with typed events
  - Use `PortManager.findFreePort()` for dynamic port allocation
  - Store connections in `Map<normalizedWorkspacePath, Socket>`
  - On connection: validate `auth.workspacePath` is string and absolute path
  - On connection: normalize path, disconnect old socket if duplicate exists
  - Handle connection/disconnection lifecycle with logging
  - Implement `sendCommand(workspacePath, command, args, timeoutMs?): Promise<PluginResult<unknown>>`
    - Normalize path for lookup
    - Return `{ success: false, error: "Workspace not connected" }` if not found
    - Use `Promise.race([ackPromise, timeoutPromise])` for timeout handling
    - Default timeout: `COMMAND_TIMEOUT_MS` (10s)
  - Add `isConnected(workspacePath): boolean` method
  - Add graceful shutdown with `close(): Promise<void>` method
  - Add `getPort(): number | null` method to retrieve assigned port
  - Files affected:
    - `src/services/plugin-server/plugin-server.ts` (new)
    - `src/services/plugin-server/index.ts` (new)
  - Test criteria: Unit tests for connection management, command sending, timeout

- [x] **Step 4: Create PluginServer test utilities**
  - Create `src/services/plugin-server/plugin-server.test-utils.ts`
  - Implement `createMockSocket()` factory for unit tests
  - Implement `createMockLogger()` or reuse existing logger mock
  - Follow pattern from `network.test-utils.ts`
  - Files affected: `src/services/plugin-server/plugin-server.test-utils.ts` (new)
  - Test criteria: Utilities importable and usable in tests

- [x] **Step 5: Create PluginServer unit tests**
  - Create `src/services/plugin-server/plugin-server.test.ts`
  - Test connection registration by workspace path
  - Test path normalization (Windows `C:\...` and Unix `/home/...`)
  - Test duplicate connection handling (old socket disconnected)
  - Test auth validation rejects invalid/missing workspacePath
  - Test disconnection cleanup removes from Map
  - Test `sendCommand()` success with mock socket
  - Test `sendCommand()` to unknown workspace returns error
  - Test `sendCommand()` timeout returns error after 10s
  - Test `sendCommand()` to disconnected workspace returns error
  - Test `close()` disconnects all clients and stops server
  - Files affected: `src/services/plugin-server/plugin-server.test.ts` (new)
  - Test criteria: All unit tests pass

- [x] **Step 6: Create PluginServer boundary tests**
  - Create `src/services/plugin-server/plugin-server.boundary.test.ts`
  - Use `afterEach` to close server and disconnect clients (prevent port leaks)
  - Set test timeout to 15000ms for CI environments
  - Test real Socket.IO server startup on dynamic port
  - Test real client connection with auth
  - Test command sending and acknowledgment round-trip
  - Test command error (client acks with error)
  - Test reconnection behavior: stop server, client enters reconnecting, restart, client reconnects within 10s
  - Test multiple workspace connections simultaneously
  - Test 10 concurrent workspace connections with parallel commands (stress test)
  - Test port reuse: close() then start() uses different port
  - Files affected: `src/services/plugin-server/plugin-server.boundary.test.ts` (new)
  - Test criteria: All boundary tests pass

- [x] **Step 7: Integrate PluginServer into main process**
  - Add `pluginServer` to module-level variables in `src/main/index.ts`
  - Start PluginServer in `startServices()` BEFORE `codeServerManager.ensureRunning()`
  - Get port from PluginServer after start
  - Pass port to CodeServerManager config
  - Add graceful degradation: if PluginServer.start() fails, log warning and continue (plugin is optional)
  - Update `cleanup()` function: close PluginServer AFTER CodeServerManager.stop()
  - Files affected: `src/main/index.ts`
  - Test criteria: Server starts successfully, port is available, graceful degradation works

- [x] **Step 8: Create main process integration test**
  - Create or update integration test for PluginServer + CodeServerManager
  - Test: PluginServer starts, port passed to CodeServerManager, code-server receives env var
  - Files affected: `src/main/index.integration.test.ts` or new file
  - Test criteria: Integration test passes

- [x] **Step 9: Pass plugin port to code-server**
  - Modify CodeServerManager to accept plugin port in config
  - Add `CODEHYDRA_PLUGIN_PORT` to environment when spawning (only if port defined)
  - Update `CodeServerConfig` interface with optional `pluginPort?: number`
  - Files affected:
    - `src/services/code-server/code-server-manager.ts`
    - `src/services/code-server/types.ts`
  - Test criteria: Environment variable is set correctly when port provided

- [x] **Step 10: Update CodeServerManager tests**
  - Add test: "passes CODEHYDRA_PLUGIN_PORT when pluginPort configured"
  - Add test: "omits CODEHYDRA_PLUGIN_PORT when pluginPort undefined"
  - Add test: "rejects invalid pluginPort (non-number)" (if validation added)
  - Files affected: `src/services/code-server/code-server-manager.test.ts`
  - Test criteria: All tests pass

- [x] **Step 11: Setup extension build with esbuild**
  - Create `src/services/vscode-setup/assets/codehydra-extension/esbuild.config.js`
  - Configure esbuild to bundle extension.js + socket.io-client into single file
  - Output to `dist/extension.js`
  - Update extension `package.json`:
    - Add `socket.io-client@^4.7.0` as dependency
    - Add build script: `"build": "node esbuild.config.js"`
    - Update `main` to `./dist/extension.js`
  - Update `.vscodeignore` to exclude `node_modules/` (bundled into dist)
  - Update main project build process to run `npm install && npm run build` in extension dir before `vsce package`
  - Files affected:
    - `src/services/vscode-setup/assets/codehydra-extension/esbuild.config.js` (new)
    - `src/services/vscode-setup/assets/codehydra-extension/package.json`
    - `src/services/vscode-setup/assets/codehydra-extension/.vscodeignore`
    - Build scripts (package.json scripts or vite config)
  - Test criteria: `npm run build:extension` produces bundled vsix with socket.io-client included

- [x] **Step 12: Implement extension PluginClient**
  - Update `src/services/vscode-setup/assets/codehydra-extension/extension.js`
  - Add JSDoc type annotations mirroring `plugin-protocol.ts` types
  - On activation:
    - Validate `CODEHYDRA_PLUGIN_PORT` exists and is valid number
    - If missing/invalid: log info message and skip connection (graceful degradation)
    - Get workspace path from `vscode.workspace.workspaceFolders[0].uri.fsPath`
    - Normalize path using `path.normalize()`
  - Connect to Socket.IO server:
    - URL: `http://localhost:${port}`
    - Auth: `{ workspacePath: normalizedPath }`
    - Options: `transports: ["websocket"]`, reconnection enabled with exponential backoff
  - Handle `command` event:
    - Wrap `vscode.commands.executeCommand()` in try-catch
    - Return `{ success: true, data: result }` or `{ success: false, error: message }`
  - Log connection/disconnection/reconnection events
  - On deactivate: disconnect socket
  - Files affected: `src/services/vscode-setup/assets/codehydra-extension/extension.js`
  - Test criteria: Extension connects and executes commands, graceful skip when no port

- [x] **Step 13: Update AGENTS.md documentation**
  - Add new "Plugin Interface" section after "OpenCode Integration"
  - Document:
    - Architecture overview (CodeHydra server, extension client)
    - `CODEHYDRA_PLUGIN_PORT` environment variable
    - Connection lifecycle
    - Message protocol (command with ack)
    - Path normalization requirement
    - Logging (logger name `[plugin]`)
  - Files affected: `AGENTS.md`
  - Test criteria: Documentation is clear and matches implementation

- [x] **Step 14: Update ARCHITECTURE.md documentation**
  - Add PluginServer to "App Services" table
  - Add to component diagram or create new diagram
  - Document Socket.IO dependency
  - Files affected: `docs/ARCHITECTURE.md`
  - Test criteria: Architecture doc reflects new component

## Testing Strategy

### Unit Tests (vitest)

| Test Case                     | Description                                | File                          |
| ----------------------------- | ------------------------------------------ | ----------------------------- |
| connection registration       | Store socket by normalized workspace path  | `plugin-server.test.ts`       |
| path normalization            | Handle Windows and Unix paths consistently | `plugin-server.test.ts`       |
| auth validation               | Reject invalid/missing workspacePath       | `plugin-server.test.ts`       |
| duplicate connection          | Disconnect old socket, store new one       | `plugin-server.test.ts`       |
| disconnection cleanup         | Remove socket from map on disconnect       | `plugin-server.test.ts`       |
| sendCommand success           | Send command, receive ack result           | `plugin-server.test.ts`       |
| sendCommand unknown workspace | Return error for unregistered path         | `plugin-server.test.ts`       |
| sendCommand timeout           | Return error after 10s if no ack           | `plugin-server.test.ts`       |
| sendCommand disconnected      | Return error for disconnected workspace    | `plugin-server.test.ts`       |
| close cleanup                 | Disconnect all clients and stop server     | `plugin-server.test.ts`       |
| env var passed                | CODEHYDRA_PLUGIN_PORT in spawn env         | `code-server-manager.test.ts` |
| env var omitted               | No env var when pluginPort undefined       | `code-server-manager.test.ts` |

### Integration Tests

| Test Case            | Description                                   | File                        |
| -------------------- | --------------------------------------------- | --------------------------- |
| port propagation     | PluginServer port passed to CodeServerManager | `index.integration.test.ts` |
| graceful degradation | App starts if PluginServer fails              | `index.integration.test.ts` |

### Boundary Tests

| Test Case          | Description                                            | File                             |
| ------------------ | ------------------------------------------------------ | -------------------------------- |
| server starts      | Socket.IO server binds to dynamic port                 | `plugin-server.boundary.test.ts` |
| client connects    | Client connects with workspacePath auth                | `plugin-server.boundary.test.ts` |
| command round-trip | Send command, client acks, promise resolves            | `plugin-server.boundary.test.ts` |
| command error      | Client acks with error, promise resolves with error    | `plugin-server.boundary.test.ts` |
| command timeout    | No ack within 10s, promise resolves with timeout error | `plugin-server.boundary.test.ts` |
| reconnection       | Client reconnects after server restart within 10s      | `plugin-server.boundary.test.ts` |
| multiple clients   | Multiple workspace connections coexist                 | `plugin-server.boundary.test.ts` |
| concurrent stress  | 10 workspaces with parallel commands                   | `plugin-server.boundary.test.ts` |
| port reuse         | Different port after close() and start()               | `plugin-server.boundary.test.ts` |

### Extension Testing

Extension automated testing is deferred for this plan. Rationale:

- Extension is simple (connect, handle commands, ack)
- `@vscode/test-electron` adds significant complexity
- Manual testing covers the critical paths
- Extension code has minimal logic beyond Socket.IO and VS Code API calls

Future work may add extension tests if complexity increases.

### Manual Testing Checklist

**Prerequisites:**

- Run `npm run build:extension` to package updated extension
- Restart CodeHydra (extension changes require full restart)

**Tests (run on both Linux and Windows if possible):**

- [ ] Start CodeHydra, verify PluginServer starts (check logs for `[plugin]` and port)
- [ ] Open a workspace, verify extension connects (check logs)
- [ ] Verify `CODEHYDRA_PLUGIN_PORT` visible in code-server terminal (`echo $CODEHYDRA_PLUGIN_PORT`)
- [ ] Open second workspace, verify second connection (check logs)
- [ ] Close workspace, verify disconnection logged
- [ ] Kill and restart CodeHydra, verify extension reconnects within 10s
- [ ] Run VS Code without CodeHydra (no env var), verify extension skips connection gracefully

## Troubleshooting

| Issue                    | Cause                           | Solution                                                           |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| Extension not connecting | `CODEHYDRA_PLUGIN_PORT` not set | Check code-server was started by CodeHydra, not standalone         |
| Extension not connecting | Port mismatch                   | Check logs for port number, verify firewall not blocking localhost |
| Command not executing    | Command ID wrong                | Verify command exists in VS Code (`Ctrl+Shift+P` to search)        |
| Command timeout          | Extension hung                  | Check VS Code developer tools console for errors                   |
| Path mismatch            | Windows/Unix paths              | Ensure both ends normalize paths with `path.normalize()`           |

## Dependencies

| Package                 | Purpose                                                              | Approved |
| ----------------------- | -------------------------------------------------------------------- | -------- |
| socket.io@^4.7.0        | Socket.IO server for main process                                    | [x]      |
| socket.io-client@^4.7.0 | Socket.IO client for extension (bundled via esbuild)                 | [x]      |
| esbuild                 | Bundle extension with socket.io-client (dev dependency in extension) | [x]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `npm add <package>` to use the latest versions.**

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                         |
| ---------------------- | ------------------------------------------------------------------------ |
| `AGENTS.md`            | Add "Plugin Interface" section: architecture, env var, protocol, logging |
| `docs/ARCHITECTURE.md` | Add PluginServer to "App Services" table, update component diagram       |

### New Documentation Required

| File | Purpose                                               |
| ---- | ----------------------------------------------------- |
| None | Architecture covered in AGENTS.md and ARCHITECTURE.md |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (AGENTS.md, ARCHITECTURE.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
