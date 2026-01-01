---
status: COMPLETED
last_updated: 2026-01-02
reviewers: [review-typescript, review-arch, review-testing, review-docs, review-platform]
---

# CREATE_WORKSPACE_TOOL

## Overview

- **Problem**: AI agents cannot programmatically create new workspaces with an initial prompt. Currently, workspace creation only happens through the UI, and agents must manually type their first prompt after a workspace is created.

- **Solution**: Add workspace creation to all public APIs (MCP, Plugin) with optional initial prompt, agent selection, and background mode. The initial prompt is sent asynchronously (fire-and-forget) after the OpenCode server becomes healthy.

- **Risks**:
  - Initial prompt might fail silently (mitigated by logging errors with context)
  - Race condition if workspace is deleted before prompt is sent (mitigated by checking workspace existence before sending)
- **Alternatives Considered**:
  - **Wait for prompt completion**: Rejected - would block the caller too long
  - **Store prompt as metadata**: Rejected - adds complexity, harder to track status

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Public API Surfaces                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐       ┌─────────────────┐                              │
│  │   MCP Server    │       │ Sidekick Ext.   │                              │
│  │ workspace_create│       │ workspace.      │                              │
│  │                 │       │   create()      │                              │
│  └────────┬────────┘       └────────┬────────┘                              │
│           │                         │ Socket.IO                             │
│           │                         ▼                                        │
│           │                ┌─────────────────┐                              │
│           │                │  Plugin Server  │                              │
│           │                │ api:workspace:  │                              │
│           │                │     create      │                              │
│           │                └────────┬────────┘                              │
│           │                         │ wire-plugin-api                       │
│           └────────────────┬────────┘                                        │
│                            ▼                                                 │
│                ┌───────────────────────┐                                     │
│                │ ICodeHydraApi.        │                                     │
│                │   workspaces.create() │                                     │
│                └───────────┬───────────┘                                     │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  CoreModule.workspaceCreate()                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Input:                                                                      │
│    - projectId, name, base                                                  │
│    - initialPrompt?: string | { prompt: string; agent?: string }            │
│    - keepInBackground?: boolean (default false = switch to it)              │
│                                                                              │
│  Process:                                                                    │
│    1. GitWorktreeProvider.createWorkspace(name, base)                       │
│    2. AppState.addWorkspace(path, ws)                                       │
│       └─► serverManager.startServer(path, { initialPrompt })                │
│    3. If !keepInBackground: viewManager.setActiveWorkspace(path)            │
│    4. Emit workspace:created event (with hasInitialPrompt flag)             │
│    5. Return Workspace                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼ (async, after server healthy)
┌─────────────────────────────────────────────────────────────────────────────┐
│  OpenCodeServerManager.onServerStarted (fire-and-forget)                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Check pendingPrompts Map for this workspace (path normalized via Path)  │
│  2. If found:                                                                │
│     a. Remove from Map                                                      │
│     b. Verify workspace still exists in AppState                            │
│     c. sendInitialPrompt(port, prompt, agent?, logger, sdkFactory)          │
│        ├─► sdk.session.create({ body: {} })                                 │
│        └─► sdk.session.prompt({ body: { agent?, parts: [...] } })           │
│  3. Errors logged with context (port, workspacePath), not thrown            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## API Parameter Design

The `initialPrompt` parameter accepts either a simple string or an object:

```typescript
// Simple string - uses default agent
initialPrompt: "Implement the login feature"

// Object with agent - uses specified agent
initialPrompt: { prompt: "Implement the login feature", agent: "build" }

// No initial prompt
initialPrompt: undefined
```

This design ensures you cannot specify an agent without a prompt.

**Normalization helper:**

```typescript
function normalizeInitialPrompt(input: InitialPrompt): { prompt: string; agent?: string } {
  if (typeof input === "string") {
    return { prompt: input };
  }
  return input;
}
```

## Implementation Steps

### Phase 1: Boundary Tests (GATE - verify SDK interaction works)

> **IMPORTANT**: Phase 1 is a GATE. If boundary tests fail, implementation MUST STOP and user must review the SDK API. The plan assumes `sdk.session.create()` and `sdk.session.prompt({ body: { agent?, parts } })` are the correct API signatures. Boundary tests verify this assumption against a real opencode process.

- [x] **Step 1.1: Add boundary test for session.create + session.prompt**
  - Add test that creates session and sends prompt via SDK
  - Verify prompt is sent successfully (session exists, prompt in history)
  - Must be platform independent (no `it.skipIf` for platforms)
  - File: `src/services/opencode/opencode-client.boundary.test.ts`
  - Test criteria: Test passes with real opencode process on all platforms

- [x] **Step 1.2: Add boundary test for session.prompt with agent parameter**
  - Add test that sends prompt with `agent` field in body
  - Verify agent parameter appears in UserMessage response
  - File: `src/services/opencode/opencode-client.boundary.test.ts`
  - Test criteria: Test passes, agent field present in UserMessage

- [x] **Step 1.3: GATE CHECK - Review boundary test results**
  - If tests pass: proceed to Phase 2
  - If tests fail: STOP and review SDK API with user
  - Document actual SDK API signature if different from assumed
  - **Result**: Tests pass - SDK API signatures confirmed:
    - `sdk.session.create({ body: {} })` returns `{ data: { id: string } }`
    - `sdk.session.prompt({ path: { id }, body: { agent?, parts } })` works correctly

### Phase 2: Initial Prompt Utility

- [x] **Step 2.1: Create sendInitialPrompt utility**
  - Create function with signature:
    ```typescript
    export async function sendInitialPrompt(
      port: number,
      prompt: string,
      agent: string | undefined,
      logger: Logger,
      sdkFactory: SdkClientFactory = createOpencodeClient
    ): Promise<void>;
    ```
  - Fire-and-forget semantics: function catches all errors, logs with context, never throws
  - Log errors with: `logger.error('Failed to send initial prompt', { port, prompt: prompt.substring(0, 50), agent, error: error.message })`
  - File: `src/services/opencode/initial-prompt.ts` (new file)
  - Test criteria: Integration test with behavioral mock verifies session created and prompt sent

- [x] **Step 2.2: Add integration test for sendInitialPrompt**
  - Create behavioral mock of SDK that tracks state (not call counts):
    ```typescript
    class MockSdkClient {
      sessions = new Map<string, { prompts: Array<{ text: string; agent?: string }> }>();
      // Tests verify: mock.sessions.get(id).prompts[0].agent === 'foo'
    }
    ```
  - Test cases:
    - Session created and prompt sent (verify mock state)
    - Prompt with agent (verify agent in mock state)
    - Prompt without agent (verify no agent in mock state)
    - SDK throws error (verify error logged, no exception)
  - File: `src/services/opencode/initial-prompt.test.ts` (new file)
  - Test criteria: All tests pass with behavioral mock

### Phase 3: Core API Changes

- [x] **Step 3.1: Add InitialPrompt type and normalizer**
  - Define in `src/shared/api/types.ts`:

    ```typescript
    export type InitialPrompt = string | { prompt: string; agent?: string };

    export function normalizeInitialPrompt(input: InitialPrompt): {
      prompt: string;
      agent?: string;
    } {
      return typeof input === "string" ? { prompt: input } : input;
    }
    ```

  - Also export shared zod schema for reuse:
    ```typescript
    export const initialPromptSchema = z.union([
      z.string().min(1),
      z.object({ prompt: z.string().min(1), agent: z.string().optional() }),
    ]);
    ```
  - Test criteria: TypeScript compiles, normalizer handles both forms

- [x] **Step 3.2: Update WorkspaceCreatePayload**
  - Add `initialPrompt?: InitialPrompt`
  - Add `keepInBackground?: boolean`
  - File: `src/main/api/registry-types.ts`
  - Test criteria: TypeScript compiles

- [x] **Step 3.3: Update IWorkspaceApi interface**
  - Update `create()` signature to accept new optional parameters
  - File: `src/shared/api/interfaces.ts`
  - Test criteria: Interface matches payload type

- [x] **Step 3.4: Add pending prompt storage to OpenCodeServerManager**
  - Add `pendingPrompts: Map<string, { prompt: string; agent?: string }>` field
  - Use `new Path(workspacePath).toString()` as Map key for cross-platform consistency
  - Add `setPendingPrompt(workspacePath: string, prompt: string, agent?: string)` method
  - Add `consumePendingPrompt(workspacePath: string)` method (returns and removes)
  - File: `src/services/opencode/opencode-server-manager.ts`
  - Test criteria: Can store and retrieve pending prompts with normalized paths

- [x] **Step 3.5: Wire pending prompts in OpenCodeServerManager.startServer**
  - Accept optional `initialPrompt` parameter in `startServer()`
  - If provided, call `setPendingPrompt()` before starting server
  - In `onServerStarted` callback:
    1. Call `consumePendingPrompt(workspacePath)`
    2. If found, verify workspace still exists (via callback or AppState reference)
    3. Call `sendInitialPrompt()` asynchronously (fire-and-forget)
  - File: `src/services/opencode/opencode-server-manager.ts`
  - Test criteria: Pending prompt consumed and sent when server starts

- [x] **Step 3.6: Update CoreModule.workspaceCreate**
  - Extract `initialPrompt`, `keepInBackground` from payload
  - Normalize initialPrompt using `normalizeInitialPrompt()`
  - Pass normalized prompt to server manager via `startServer()` options
  - If `!keepInBackground`: call `viewManager.setActiveWorkspace()`
  - Emit `workspace:created` event with optional `hasInitialPrompt: boolean` flag
  - File: `src/main/modules/core/index.ts`
  - Test criteria: Options passed through correctly

### Phase 4: Public API Wrappers

- [x] **Step 4.1: Add workspace_create MCP tool**
  - Register new tool with zod schema (reuse `initialPromptSchema` from types)
  - Parameters: `name`, `base`, `initialPrompt?`, `keepInBackground?`
  - Project resolution: Use `resolveWorkspace(workspacePath, appState)` from caller's X-Workspace-Path header to get projectId, then create new workspace in same project
  - File: `src/services/mcp-server/mcp-server.ts`
  - Test criteria: MCP tool creates workspace in caller's project

- [x] **Step 4.2: Update plugin protocol types**
  - Add `api:workspace:create` event type with full signature:
    ```typescript
    "api:workspace:create": (
      request: WorkspaceCreateRequest,
      ack: (result: PluginResult<Workspace>) => void
    ) => void;
    ```
  - Add `WorkspaceCreateRequest` interface
  - Add `validateWorkspaceCreateRequest` function for runtime validation
  - File: `src/shared/plugin-protocol.ts`
  - Test criteria: Types compile

- [x] **Step 4.3: Add api:workspace:create to Plugin Server**
  - Add new Socket.IO event handler
  - Parameters match MCP tool
  - File: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Event handler registered

- [x] **Step 4.4: Wire plugin workspace:create in wire-plugin-api.ts**
  - Connect `api:workspace:create` to `api.workspaces.create()`
  - File: `src/main/api/wire-plugin-api.ts`
  - Test criteria: Event routed to API

- [x] **Step 4.5: Add workspace.create() to sidekick extension**
  - Add `create(name, base, options?)` method to `codehydraApi.workspace`
  - Options: `{ initialPrompt?, keepInBackground? }`
  - File: `extensions/sidekick/extension.js`
  - Test criteria: Method exposed on API

- [x] **Step 4.6: Update sidekick API type declarations**
  - Add `create()` method signature
  - Add `WorkspaceCreateOptions` interface
  - File: `extensions/sidekick/api.d.ts`
  - Test criteria: Types compile

### Phase 5: Documentation

- [x] **Step 5.1: Update AGENTS.md MCP tools table**
  - Add `workspace_create` tool documentation following existing format
  - File: `AGENTS.md`
  - Test criteria: Documentation accurate and consistent with existing entries

- [x] **Step 5.2: Update docs/API.md**
  - Update Public API section only (VS Code Extension Access and WebSocket Access)
  - Document `initialPrompt` and `keepInBackground` parameters
  - Document new MCP tool
  - Document new plugin API method
  - File: `docs/API.md`
  - Test criteria: Documentation complete

- [x] **Step 5.3: Update docs/ARCHITECTURE.md**
  - Add workspace.create to Public API Surfaces diagram in API Layer Architecture section
  - File: `docs/ARCHITECTURE.md`
  - Test criteria: Diagram updated

## Testing Strategy

### Boundary Tests (Phase 1 - GATE)

| #   | Test Case                     | Entry Point                 | Real System   | Behavior Verified                          |
| --- | ----------------------------- | --------------------------- | ------------- | ------------------------------------------ |
| 1   | Session create + prompt works | `sdk.session.create/prompt` | Real opencode | Session exists in list, prompt in messages |
| 2   | Prompt with agent parameter   | `sdk.session.prompt`        | Real opencode | Agent field present in UserMessage         |

**Contract established by boundary tests:**

- `sdk.session.create({ body: {} })` returns `{ data: { id: string } }`
- `sdk.session.prompt({ path: { id }, body: { agent?, parts: [{ type: 'text', text }] } })` returns UserMessage with agent field

Integration tests' behavioral mock MUST match this contract.

### Integration Tests

| #   | Test Case                                          | Entry Point                    | Boundary Mocks           | Behavior Verified                                     |
| --- | -------------------------------------------------- | ------------------------------ | ------------------------ | ----------------------------------------------------- |
| 1   | sendInitialPrompt creates session and sends prompt | `sendInitialPrompt()`          | SDK behavioral mock      | Mock state has session with prompt                    |
| 2   | sendInitialPrompt includes agent when provided     | `sendInitialPrompt()`          | SDK behavioral mock      | Mock state shows agent in prompt                      |
| 3   | sendInitialPrompt omits agent when not provided    | `sendInitialPrompt()`          | SDK behavioral mock      | Mock state shows no agent in prompt                   |
| 4   | sendInitialPrompt logs errors without throwing     | `sendInitialPrompt()`          | SDK mock (throws)        | Logger.error called, no exception                     |
| 5   | Workspace create with string prompt normalizes     | `CoreModule.workspaceCreate()` | GitClient, ServerManager | ServerManager receives `{ prompt, agent: undefined }` |
| 6   | Workspace create with object prompt passes through | `CoreModule.workspaceCreate()` | GitClient, ServerManager | ServerManager receives `{ prompt, agent }`            |
| 7   | Pending prompt consumed and sent on server start   | ServerManager.startServer      | SDK behavioral mock      | Mock state has session with prompt after callback     |
| 8   | Workspace deleted before prompt: no crash          | ServerManager callback         | SDK mock, AppState       | Error logged, no exception, prompt removed from Map   |
| 9   | keepInBackground=false switches workspace          | `CoreModule.workspaceCreate()` | ViewManager              | appState.activeWorkspace === newWorkspacePath         |
| 10  | keepInBackground=true no switch                    | `CoreModule.workspaceCreate()` | ViewManager              | appState.activeWorkspace !== newWorkspacePath         |
| 11  | keepInBackground defaults to false                 | `CoreModule.workspaceCreate()` | ViewManager              | Default behavior switches workspace                   |
| 12  | Empty prompt string rejected                       | `CoreModule.workspaceCreate()` | -                        | Validation error thrown                               |

### Manual Testing Checklist

- [ ] Create workspace via MCP tool without initial prompt
- [ ] Create workspace via MCP tool with initial prompt (string)
- [ ] Create workspace via MCP tool with initial prompt (object with agent)
- [ ] Create workspace with keepInBackground=true (stays on current)
- [ ] Create workspace with keepInBackground=false (switches)
- [ ] Verify initial prompt appears in new workspace's OpenCode chat history
- [ ] Verify correct agent is used for initial prompt
- [ ] Plugin API: create workspace from VS Code extension
- [ ] UI workspace creation still works (existing behavior unchanged)
- [ ] Create workspace with initial prompt, delete workspace immediately (no crash)

## Dependencies

No new dependencies required. Uses existing `@opencode-ai/sdk`.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                       |
| ---------------------- | ---------------------------------------------------------------------- |
| `AGENTS.md`            | Add `workspace_create` to MCP Server tools table                       |
| `docs/API.md`          | Document new parameters in Public API section, MCP tool, plugin method |
| `docs/ARCHITECTURE.md` | Add workspace.create to Public API Surfaces diagram                    |

### New Documentation Required

None - covered by updates to existing docs.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
