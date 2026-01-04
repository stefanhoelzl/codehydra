---
status: COMPLETED
last_updated: 2026-01-04
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# OPENCODE_SESSION_INFO

## Overview

- **Problem**: CodeHydra doesn't know which OpenCode session a workspace is using. The CLI wrapper queries all sessions and picks the best match, which is complex and adds latency. External tools could create sessions that interfere with tracking.
- **Solution**: Create a "primary session" when the OpenCode provider initializes. Store the session ID in the provider. Expose via new `getOpenCodeSession` API (replacing `getOpencodePort`). Simplify the CLI wrapper to use the known session ID from environment variable.
- **Risks**:
  - If user runs `/new` in TUI, they switch to a different session but the primary remains unchanged (acceptable - primary is for terminal attachment)
  - Session cannot be "reset" without changing ID (OpenCode limitation)
- **Alternatives Considered**:
  - Activity-based tracking (switch primary when user interacts with different session) - adds complexity
  - Query TUI state for current session - no API exists
  - Session logic in OpenCodeServerManager - rejected in favor of keeping it in OpenCodeProvider with thin OpenCodeClient

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           COMPONENT RESPONSIBILITIES                            │
└─────────────────────────────────────────────────────────────────────────────────┘

  OpenCodeClient (thin SDK wrapper - NO business logic)
  ─────────────────────────────────────────────────────
  • listSessions(): Promise<Result<Session[], OpenCodeError>>  ← NEW
  • createSession(): Promise<Result<Session, OpenCodeError>>   ← Updated return type
  • connect(): Promise<void>  (SSE subscription)
  • disconnect(): void                       ← EXISTS (document usage for reconnect)
  • dispose(): void
  • Event callbacks (onSessionEvent, onStatusChanged, etc.)

  Note: Session type from src/shared/api/types.ts (single definition, no duplicates)


  OpenCodeProvider (business logic per workspace)
  ───────────────────────────────────────────────
  State (readonly where possible):
  • port: number | null
  • primarySessionId: string | null
  • client: OpenCodeClient | null

  Methods:
  • initializeClient(port, workspacePath)
      → Creates client
      → Calls client.listSessions()
      → Uses findMatchingSession() utility from session-utils.ts
      → If not found: client.createSession()
      → Stores port and primarySessionId
      → Calls client.connect()

  • reconnect()             ← Server restart (port & sessionId unchanged)
  • disconnect()            ← Server stopping during restart
  • dispose()               ← Workspace deletion (clears everything)
  • getSession(): { port, sessionId } | null


  AgentStatusManager
  ──────────────────
  • disconnectWorkspace(path)   ← Server restart: provider.disconnect()
  • removeWorkspace(path)       ← Workspace deletion: provider.dispose() (existing)
  • reconnectWorkspace(path)    ← Server restarted: provider.reconnect()
  • getSession(path)            ← Delegates to provider


  Pure Utility Function (src/services/opencode/session-utils.ts)
  ──────────────────────────────────────────────────────────────
  findMatchingSession(sessions: Session[], directory: string): Session | null
    → Filter: directory matches (using Path.equals), no parentID
    → Sort: latest time.updated first
    → Return first match or null
```

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LIFECYCLE FLOWS                                    │
└─────────────────────────────────────────────────────────────────────────────────┘

  WORKSPACE CREATION
  ──────────────────
  startServer() → onServerStarted(path, port)
                         │
                         ▼
                  Create OpenCodeProvider
                         │
                         ▼
                  provider.initializeClient(port, workspacePath)
                         │
                         ├─► client.listSessions()
                         ├─► findMatchingSession(sessions, path)
                         │      └─► Filter by directory, pick latest
                         ├─► If not found: client.createSession()
                         ├─► Store port and primarySessionId
                         └─► client.connect()


  SERVER RESTART (same port, same session)
  ────────────────────────────────────────
  restartServer() → onServerStopped(path)
                         │
                         ▼
                  agentStatusManager.disconnectWorkspace(path)
                         │
                         ▼
                  provider.disconnect()  ← Client disposed, port & sessionId kept
                         │
                         ▼
                  onServerStarted(path, port)
                         │
                         ▼
                  agentStatusManager.reconnectWorkspace(path)
                         │
                         ▼
                  provider.reconnect()  ← New client, same port & sessionId


  WORKSPACE DELETION
  ──────────────────
  deleteWorkspace() → agentStatusManager.removeWorkspace(path)
                         │
                         ▼
                  provider.dispose()  ← Everything cleared
                         │
                         ▼
                  providers.delete(path)
```

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              API CHANGES                                        │
└─────────────────────────────────────────────────────────────────────────────────┘

  REMOVED                              ADDED
  ───────                              ─────
  getOpencodePort(): number | null     getOpenCodeSession(): OpenCodeSession | null
                                           │
                                           ▼
                                       {
                                         port: number,
                                         sessionId: string
                                       }

  Affected modules:
  • src/shared/api/interfaces.ts       - IWorkspaceApi method
  • src/shared/api/types.ts            - OpenCodeSession type
  • src/shared/plugin-protocol.ts      - Socket.IO event
  • src/main/modules/core/index.ts     - IPC handler
  • src/main/api/wire-plugin-api.ts    - Plugin handler
  • src/services/mcp-server/mcp-server.ts - MCP tool
  • extensions/sidekick/src/extension.ts  - Extension client
```

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         SIDEKICK + CLI WRAPPER FLOW                             │
└─────────────────────────────────────────────────────────────────────────────────┘

  Sidekick Extension (on connect)
  ───────────────────────────────
  socket.on("connect")
         │
         └─► getOpenCodeSession()
                    │
                    ▼
             { port: 12345, sessionId: "ses-abc" }
                    │
                    ├─► Set CODEHYDRA_OPENCODE_PORT=12345
                    └─► Set CODEHYDRA_OPENCODE_SESSION_ID=ses-abc


  CLI Wrapper (user runs `opencode`)
  ──────────────────────────────────
  Read CODEHYDRA_OPENCODE_PORT → baseUrl
  Read CODEHYDRA_OPENCODE_SESSION_ID → sessionId
         │
         └─► opencode attach <baseUrl> --session <sessionId>

  NO SDK CALLS - just reads env vars!
```

## Implementation Steps

### Phase 1: Utility Function & OpenCodeClient Updates

- [x] **Step 1: Move findMatchingSession to shared location**
  - Description: Extract utility function for reuse by OpenCodeProvider
  - Files affected:
    - `src/services/opencode/session-utils.ts` (new file)
    - `src/bin/opencode-wrapper.ts` (import from new location)
  - Changes:
    - Create `session-utils.ts` with `findMatchingSession()` function
    - Use `Session` type from `src/shared/api/types.ts` (single definition)
    - Update `opencode-wrapper.ts` to import from new location
  - Test criteria: Existing wrapper tests still pass

- [x] **Step 2: Add listSessions method to OpenCodeClient**
  - Description: Thin SDK wrapper for listing sessions with Result pattern
  - Files affected:
    - `src/services/opencode/opencode-client.ts`
  - Changes:
    - Add `listSessions(): Promise<Result<Session[], OpenCodeError>>` method
    - SDK call: `this.sdk.session.list()`
    - Return `ok(sessions)` on success, `err(OpenCodeError)` on failure
    - Add JSDoc: `/** Lists all sessions from the OpenCode server */`
    - Add debug logging: `this.logger.debug("Listing sessions")`
  - Test criteria: Method returns Result with sessions from SDK

- [x] **Step 3: Update createSession to return full Session**
  - Description: Return full session object instead of just ID
  - Files affected:
    - `src/services/opencode/opencode-client.ts`
  - Changes:
    - Update return type to `Result<Session, OpenCodeError>` (already uses Result)
    - Return full session object from SDK response
  - Test criteria: Method returns session with id, directory, time

- [x] **Step 4: Document disconnect method usage for reconnect**
  - Description: The `disconnect()` method already exists in OpenCodeClient. Document its usage for the reconnect flow.
  - Files affected:
    - `src/services/opencode/opencode-client.ts` (documentation only)
  - Changes:
    - Add JSDoc to existing `disconnect()` method explaining reconnect usage
    - Document that it closes SSE subscription but keeps SDK client instance
  - Test criteria: Documentation added, existing behavior unchanged

### Phase 2: OpenCodeProvider Session Management

- [x] **Step 5: Add session state to OpenCodeProvider**
  - Description: Store port and primarySessionId with readonly access
  - Files affected:
    - `src/services/opencode/agent-status-manager.ts` (OpenCodeProvider)
  - Changes:
    - Add `private _port: number | null = null` field
    - Add `private _primarySessionId: string | null = null` field
    - Add `private readonly workspacePath: string` field (passed to constructor)
    - Add `getSession(): { port: number; sessionId: string } | null` method
    - Add JSDoc: `/** Returns the primary session info for this workspace */`
    - Add debug logging when session state changes
  - Test criteria: State is stored and retrievable via getter

- [x] **Step 6: Update initializeClient to find/create session**
  - Description: On initialization, find existing session or create new one
  - Files affected:
    - `src/services/opencode/agent-status-manager.ts` (OpenCodeProvider)
  - Changes:
    - Update `initializeClient(port: number)` signature (workspacePath from constructor)
    - Store port
    - Call `client.listSessions()` and handle Result
    - Call `findMatchingSession(sessions, workspacePath)` from session-utils.ts
    - If found: store session ID, log info "Found existing session"
    - If not found: call `client.createSession()`, store session ID, log info "Created new session"
    - Remove `fetchRootSessions()` call
    - Then call `client.connect()`
  - Test criteria: Session is found or created, ID is stored

- [x] **Step 7: Add disconnect and reconnect methods**
  - Description: Support server restart without losing session ID
  - Files affected:
    - `src/services/opencode/agent-status-manager.ts` (OpenCodeProvider)
  - Changes:
    - Add `disconnect()`: calls client.disconnect(), keeps port and sessionId
    - Add `reconnect()`: creates new client with stored port, calls connect()
    - Update `dispose()`: clears everything including port and sessionId
    - Add JSDoc for each method explaining lifecycle usage
    - Add info logging: "Disconnecting for restart", "Reconnecting after restart"
  - Test criteria: After reconnect, sessionId is preserved

### Phase 3: AgentStatusManager Updates

- [x] **Step 8: Add workspace path to OpenCodeProvider constructor**
  - Description: Pass workspace path when creating provider
  - Files affected:
    - `src/services/opencode/agent-status-manager.ts`
    - `src/main/app-state.ts` (where providers are created)
  - Changes:
    - Update OpenCodeProvider constructor to accept workspacePath
    - Update AppState to pass workspacePath when creating providers
  - Test criteria: Provider knows its workspace path

- [x] **Step 9: Add disconnect/reconnect methods to AgentStatusManager**
  - Description: Delegate to provider for restart flow
  - Files affected:
    - `src/services/opencode/agent-status-manager.ts` (AgentStatusManager)
  - Changes:
    - Add `disconnectWorkspace(path)`: calls provider.disconnect()
    - Add `reconnectWorkspace(path)`: calls provider.reconnect()
    - Add `getSession(path)`: delegates to provider.getSession()
    - Keep existing `removeWorkspace()` for deletion
  - Test criteria: Restart preserves provider, deletion removes it

- [x] **Step 10: Update AppState callbacks for restart flow**
  - Description: Use disconnect/reconnect on server restart
  - Files affected:
    - `src/main/app-state.ts`
  - Changes:
    - Detect if this is restart (provider exists) vs first start
    - For restart: call disconnectWorkspace + reconnectWorkspace
    - For first start: create new provider as before
  - Test criteria: Server restart preserves session ID

### Phase 4: API Changes

- [x] **Step 11: Add OpenCodeSession type**
  - Description: New type for combined port + session ID
  - Files affected:
    - `src/shared/api/types.ts`
  - Changes:
    - Add `OpenCodeSession` interface: `{ port: number; sessionId: string }`
  - Test criteria: Type compiles

- [x] **Step 12: Replace getOpencodePort with getOpenCodeSession in interfaces**
  - Description: Update API interface
  - Files affected:
    - `src/shared/api/interfaces.ts`
  - Changes:
    - Replace `getOpencodePort()` with `getOpenCodeSession()`
    - Return type: `Promise<OpenCodeSession | null>`
  - Test criteria: Interface compiles

- [x] **Step 13: Update core module handler**
  - Description: Implement new API handler
  - Files affected:
    - `src/main/modules/core/index.ts`
  - Changes:
    - Replace `workspaceGetOpencodePort` with `workspaceGetOpenCodeSession`
    - Call `agentStatusManager.getSession(workspacePath)`
    - Return `OpenCodeSession | null`
  - Test criteria: Handler returns port and sessionId

- [x] **Step 14: Update plugin protocol**
  - Description: Update Socket.IO event types
  - Files affected:
    - `src/shared/plugin-protocol.ts`
  - Changes:
    - Replace `api:workspace:getOpencodePort` with `api:workspace:getOpenCodeSession`
    - Update result type to `OpenCodeSession | null`
  - Test criteria: Protocol types compile

- [x] **Step 15: Update wire-plugin-api handler**
  - Description: Update plugin API handler
  - Files affected:
    - `src/main/api/wire-plugin-api.ts`
  - Changes:
    - Replace `getOpencodePort` handler with `getOpenCodeSession`
    - Call `api.workspaces.getOpenCodeSession()`
  - Test criteria: Handler works via Socket.IO

- [x] **Step 16: Update MCP server tool**
  - Description: Replace MCP tool
  - Files affected:
    - `src/services/mcp-server/mcp-server.ts`
  - Changes:
    - Replace `workspace_get_opencode_port` with `workspace_get_opencode_session`
    - Update description and return type
  - Test criteria: MCP tool returns session info

### Phase 5: Extension & Wrapper Updates

- [x] **Step 17: Update sidekick extension**
  - Description: Use new API, set both env vars
  - Files affected:
    - `extensions/sidekick/src/extension.ts`
  - Changes:
    - Replace `getOpencodePort()` with `getOpenCodeSession()`
    - Set `CODEHYDRA_OPENCODE_PORT` from session.port
    - Set `CODEHYDRA_OPENCODE_SESSION_ID` from session.sessionId
    - Update debug command if exists
  - Test criteria: Both env vars set on connect

- [x] **Step 18: Simplify CLI wrapper**
  - Description: Use session ID from env instead of querying SDK
  - Files affected:
    - `src/bin/opencode-wrapper.ts`
  - Changes:
    - Read `CODEHYDRA_OPENCODE_SESSION_ID` from environment
    - If set: always use `--session <id>` flag
    - Remove SDK client creation and session.list() call
    - Remove findMatchingSession import (function is now imported by OpenCodeProvider from session-utils.ts)
    - Keep minimal error handling
  - Test criteria: Wrapper uses env var, no SDK calls

### Phase 6: Cleanup

- [x] **Step 19: Remove fetchRootSessions from OpenCodeClient**
  - Description: Clean up unused code
  - Files affected:
    - `src/services/opencode/opencode-client.ts`
  - Changes:
    - Remove `fetchRootSessions()` method
    - Remove `rootSessionIds` and `childToRootSession` maps if no longer needed
    - Keep session event handling for status tracking
  - Test criteria: Code compiles, tests pass

- [x] **Step 20: Update documentation**
  - Description: Document new env var and API
  - Files affected:
    - `AGENTS.md`
    - `docs/API.md`
    - `docs/ARCHITECTURE.md`
  - Changes:
    - Add `CODEHYDRA_OPENCODE_SESSION_ID` to environment variables section in AGENTS.md
    - Replace `getOpencodePort` with `getOpenCodeSession` in API docs
    - Update OpenCode integration section in ARCHITECTURE.md if it references port-only API
  - Test criteria: Documentation accurate

## Testing Strategy

### Integration Tests

Test behavior through high-level entry points with behavioral mocks.

| #   | Test Case                                      | Entry Point                                | Boundary Mocks                                    | Behavior Verified                                                    |
| --- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Provider init creates session when none exists | `OpenCodeProvider.initializeClient()`      | OpenCodeClient (returns empty session list)       | `expect(provider.getSession()?.sessionId).toBe("new-session-id")`    |
| 2   | Provider init finds existing session           | `OpenCodeProvider.initializeClient()`      | OpenCodeClient (returns 2 sessions for workspace) | `expect(provider.getSession()?.sessionId).toBe("latest-session-id")` |
| 3   | Provider reconnect preserves session ID        | `OpenCodeProvider.reconnect()`             | OpenCodeClient                                    | `expect(sessionIdAfter).toBe(sessionIdBefore)`                       |
| 4   | getOpenCodeSession returns port and sessionId  | `CoreModule.workspaceGetOpenCodeSession()` | AgentStatusManager (returns mock session)         | `expect(result).toEqual({ port: 12345, sessionId: "ses-abc" })`      |
| 5   | Server restart preserves session               | `AppState.handleServerRestarted()`         | OpenCodeServerManager, AgentStatusManager         | `expect(sessionIdAfter).toBe(sessionIdBefore)`                       |
| 6   | Workspace deletion clears session              | `AgentStatusManager.removeWorkspace()`     | -                                                 | `expect(provider.getSession()).toBeNull()`                           |

#### Mock Behavior Specifications

**OpenCodeClient mock for tests 1-3:**

```typescript
const mockClient = createMockOpenCodeClient({
  listSessions: async () =>
    ok([
      /* configured sessions */
    ]),
  createSession: async () =>
    ok({ id: "new-session-id", directory: "/path", time: { created: "...", updated: "..." } }),
  connect: async () => {},
  disconnect: () => {},
});
```

**AgentStatusManager mock for test 4:**

```typescript
const mockManager = createMockAgentStatusManager({
  getSession: (path) => ({ port: 12345, sessionId: "ses-abc" }),
});
```

### Error Scenario Tests

| #   | Test Case                       | Entry Point                           | Error Condition                                | Expected Behavior                                |
| --- | ------------------------------- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| 1   | listSessions fails              | `OpenCodeProvider.initializeClient()` | `listSessions()` returns `err(OpenCodeError)`  | Provider logs error, creates new session instead |
| 2   | createSession fails             | `OpenCodeProvider.initializeClient()` | `createSession()` returns `err(OpenCodeError)` | Provider logs error, sessionId remains null      |
| 3   | Server unavailable on reconnect | `OpenCodeProvider.reconnect()`        | `connect()` throws                             | Provider logs error, keeps previous sessionId    |

### Boundary Tests (new external interface)

| #   | Test Case                         | Interface                       | External System | Behavior Verified                               |
| --- | --------------------------------- | ------------------------------- | --------------- | ----------------------------------------------- |
| 1   | listSessions returns sessions     | `OpenCodeClient.listSessions()` | OpenCode SDK    | Returns sessions matching workspace directory   |
| 2   | listSessions handles empty result | `OpenCodeClient.listSessions()` | OpenCode SDK    | Returns `ok([])` when no sessions exist         |
| 3   | listSessions handles SDK error    | `OpenCodeClient.listSessions()` | OpenCode SDK    | Returns `err(OpenCodeError)` on network failure |

### Focused Tests (pure utility functions)

| #   | Test Case          | Function              | Input/Output                                                      |
| --- | ------------------ | --------------------- | ----------------------------------------------------------------- |
| 1   | Find by directory  | `findMatchingSession` | Sessions with matching dir → returns match                        |
| 2   | Filter root only   | `findMatchingSession` | Mix of root/child → returns only root                             |
| 3   | Pick latest        | `findMatchingSession` | Multiple matches → returns latest updated                         |
| 4   | No match           | `findMatchingSession` | No matching dir → returns null                                    |
| 5   | Path normalization | `findMatchingSession` | Different path formats (forward/back slashes) → matches correctly |

### Manual Testing Checklist

- [ ] Create new workspace, verify session ID in terminal env (`echo $CODEHYDRA_OPENCODE_SESSION_ID`)
- [ ] Run `opencode` in terminal, verify it attaches without delay (no SDK calls)
- [ ] Close and reopen terminal, verify same session restored
- [ ] Restart OpenCode server (via MCP tool), verify session ID preserved
- [ ] Run `/new` in TUI, verify new terminals still use original session
- [ ] Delete workspace, verify clean removal
- [ ] Check MCP tool `workspace_get_opencode_session` returns both values

## Dependencies

| Package | Purpose                        | Approved |
| ------- | ------------------------------ | -------- |
| (none)  | Uses existing @opencode-ai/sdk | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| `AGENTS.md`            | Add `CODEHYDRA_OPENCODE_SESSION_ID` to environment variables section |
| `docs/API.md`          | Replace `getOpencodePort` with `getOpenCodeSession` documentation    |
| `docs/ARCHITECTURE.md` | Update OpenCode integration section if it references port-only API   |

### New Documentation Required

| File   | Purpose                                     |
| ------ | ------------------------------------------- |
| (none) | Changes are internal implementation details |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
