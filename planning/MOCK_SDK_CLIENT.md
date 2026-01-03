---
status: COMPLETED
last_updated: 2026-01-03
reviewers: []
---

# MOCK_SDK_CLIENT

## Overview

- **Problem**: The current `sdk-test-utils.ts` uses call-tracking mocks (`vi.fn()`) which test implementation details rather than behavior. Tests are brittle and don't follow the behavioral mock pattern established for other services.

- **Solution**: Create a behavioral state mock for `SdkClientFactory` following the `mock.$` pattern from `src/test/state-mock.ts`. The mock will track sessions with embedded status, provide synchronous event emission, and expose minimal setup methods on the state object.

- **SDK Types Used**: `Session`, `SessionStatus`, `Event` (aliased as `SdkEvent`), `OpencodeClient` from `@opencode-ai/sdk`

- **Risks**:
  - Migration of existing tests may introduce regressions → Mitigate by migrating tests incrementally
  - Event stream timing differs from real SDK (sync vs async) → Tests use `vi.useFakeTimers()` for timeout testing; boundary tests (`opencode-client.boundary.test.ts`) validate real SDK behavior

- **Alternatives Considered**:
  - Keep call-tracking mocks: Rejected because they test implementation, not behavior
  - Use real SDK with test server: Rejected because too slow for unit/integration tests

- **Pattern Reference**: Follow existing state mocks: `filesystem.state-mock.ts`, `port-manager.state-mock.ts`, `http-client.state-mock.ts`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Test Code                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   const mock = createSdkClientMock({                                │
│     sessions: [{ id: 'ses-0001', directory: '/test' }]              │
│   });                                                                │
│   const factory = createSdkFactoryMock(mock);                       │
│   const client = new OpenCodeClient(8080, logger, factory);         │
│                                                                      │
│   // Emit events via state (synchronous - no awaiting needed)       │
│   mock.$.emitEvent({ type: 'session.status', ... });                │
│                                                                      │
│   // Assert on SERVICE behavior, not mock state                     │
│   expect(client.currentStatus).toBe('busy');                        │
│   expect(listener).toHaveBeenCalledWith({ type: 'busy', ... });     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    MockSdkClient (OpencodeClient)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Implements nested SDK namespace structure:                         │
│                                                                      │
│  session: {                                                         │
│    list()    ──► Returns sessions (status stripped)                │
│    status()  ──► Returns Record<id, status>                         │
│    create()  ──► Adds session with ID ses-XXXX, returns it         │
│    prompt()  ──► Records to history, returns success                │
│    get()     ──► Returns session by ID                              │
│    delete()  ──► Removes session from state                         │
│  }                                                                   │
│  event: {                                                           │
│    subscribe() ──► Returns async iterator from state               │
│  }                                                                   │
│  postSessionIdPermissionsPermissionId() ──► Records call only      │
│                                                                      │
│  $: SdkClientMockState  ◄── State access                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SdkClientMockState                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ─── State (readonly for external access) ───                       │
│  sessions: ReadonlyMap<string, MockSession>  (session + status)     │
│  connected: boolean                                                  │
│  prompts: readonly PromptRecord[]            (history)              │
│  emittedEvents: readonly SdkEvent[]          (history)              │
│  permissionResponses: readonly PermissionResponse[]  (history)      │
│                                                                      │
│  ─── Setup Methods (explicit return types) ───                      │
│  emitEvent(event): void      Push event to stream (synchronous)     │
│  completeStream(): void      End the event stream gracefully        │
│  errorStream(error): void    Error the event stream                 │
│  setConnectionError(e): void Make subscribe() reject                │
│                                                                      │
│  ─── MockState ───                                                  │
│  snapshot(): Snapshot        Capture state for comparison           │
│  toString(): string          Human-readable state description       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Event Emission**: `emitEvent()` is synchronous for test predictability. When called, it immediately resolves any pending iterator reads. This differs from the real SDK's async SSE streams, but allows tests to control timing precisely. Real async behavior is validated in boundary tests.

## Implementation Steps

- [x] **Step 1: Create state class and types**
  - Create `src/services/opencode/sdk-client.state-mock.ts`
  - Define `MockSession` interface extending `Session` from `@opencode-ai/sdk` with `status: SdkSessionStatus`
  - Define `PromptRecord` interface: `{ sessionId, prompt, agent?, model?, timestamp }`
  - Define `PermissionResponse` interface: `{ sessionId, permissionId, response, timestamp }`
  - Define `SdkClientMockState` class implementing `MockState`
  - Use `readonly` modifiers on all state properties for external access
  - Add explicit `void` return types on setup methods
  - Implement `snapshot()` and `toString()`
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 2: Implement event stream infrastructure**
  - Create internal event queue and pending resolver pattern:
    - Maintain queue of events and pending promise resolver
    - When `emitEvent()` called: if pending resolver exists, resolve immediately; otherwise queue event
    - When iterator `next()` called: if queue has events, return next; otherwise create pending promise
  - Implement `emitEvent(event): void` - synchronous push to stream
  - Implement `completeStream(): void` - resolve pending with `{ done: true }`
  - Implement `errorStream(error): void` - reject pending reads
  - Implement async iterator for `event.subscribe()` returning `{ stream: AsyncIterable<Event> }`
  - Add JSDoc explaining synchronous behavior for test predictability
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 3: Implement SDK session methods**
  - Implement nested namespace structure matching `OpencodeClient`:
  - `session.list()` - return `{ data: Session[] }` with status field stripped (SDK returns sessions and statuses separately)
  - `session.status()` - return `{ data: Record<string, SdkSessionStatus> }` built from session statuses
  - `session.create()` - add session with auto-generated ID `ses-${String(nextId++).padStart(4, '0')}`, return `{ data: session }`
  - `session.prompt()` - record to `$.prompts` history, return `{ data: { id: messageId } }`
  - `session.get()` - return `{ data: session }` or throw if not found
  - `session.delete()` - remove session from state, return `{ data: session }`
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 4: Implement connection error simulation**
  - Implement `setConnectionError(error: Error | null): void` on state
  - Make `event.subscribe()` reject with configured error when set
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 5: Implement permission methods**
  - Implement `postSessionIdPermissionsPermissionId()` - records call to `$.permissionResponses` history only
  - NO auto-emit of `permission.replied` - tests must explicitly call `$.emitEvent()` to match real async SDK behavior
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 6: Implement factory functions**
  - Implement `createSdkClientMock(options?: MockSdkClientOptions): MockSdkClient`
  - Implement `createSdkFactoryMock(mock: MockSdkClient): SdkClientFactory`
  - Handle options: `sessions` array, `connectionError`
  - Session defaults: `status: { type: 'idle' }`, `projectID: 'proj-test'`, `version: '1'`, `time: { created: Date.now(), updated: Date.now() }`
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 7: Implement custom matchers**
  - Implement `toHaveSentPrompt(sessionId: string, text?: string | RegExp)`:
    - If `text` provided: check for exact string match or RegExp test
    - If `text` omitted: check that ANY prompt was sent to that session
  - Implement `toHaveSession(sessionId: string)` - check session exists in state
  - Register matchers via `expect.extend()`
  - Add module augmentation in same file:
    ```typescript
    declare module "vitest" {
      interface Assertion<T> extends SdkClientMatchers {}
    }
    ```
  - Files: `src/services/opencode/sdk-client.state-mock.ts`

- [x] **Step 8: Migrate opencode-client.test.ts**
  - Update imports to use new mock
  - Replace `createMockSdkClient` with `createSdkClientMock`
  - Replace `createMockSdkFactory` with `createSdkFactoryMock`
  - Update test assertions to verify service behavior (callbacks fired, return values correct)
  - Remove call-tracking assertions (`toHaveBeenCalledWith` on SDK methods)
  - Files: `src/services/opencode/opencode-client.test.ts`

- [x] **Step 9: Migrate agent-status-manager.test.ts**
  - Update imports to use new mock
  - Replace mock utilities usage
  - Update assertions to verify AgentStatusManager behavior (status counts, listener notifications)
  - Files: `src/services/opencode/agent-status-manager.test.ts`

- [x] **Step 10: Migrate opencode-server-manager.integration.test.ts**
  - Update imports to use new mock
  - Replace mock utilities usage
  - Update assertions to behavioral style
  - Files: `src/services/opencode/opencode-server-manager.integration.test.ts`

- [x] **Step 11: Remove old sdk-test-utils.ts**
  - Verify no remaining imports of old file
  - Delete `src/services/opencode/sdk-test-utils.ts`
  - Files: `src/services/opencode/sdk-test-utils.ts` (delete)

- [x] **Step 12: Update documentation**
  - Add SDK mock to `docs/TESTING.md` in the "State Mock Pattern" section (around line 359)
  - Include:
    1. Factory function signature: `createSdkClientMock(options?)`
    2. State interface: `SdkClientMockState` with sessions, prompts, emittedEvents
    3. Custom matchers: `toHaveSentPrompt(sessionId, text?)`, `toHaveSession(sessionId)`
    4. Usage example showing event emission via `mock.$.emitEvent()`
  - Files: `docs/TESTING.md`

## Testing Strategy

### Integration Tests

The mock is validated through the existing tests that use it. Tests verify **service behavior**, not mock internals.

| #   | Test Case                   | Entry Point                            | Behavior Verified                                         |
| --- | --------------------------- | -------------------------------------- | --------------------------------------------------------- |
| 1   | Status reflects SDK data    | `OpenCodeClient.getStatus()`           | Returns `busy` when SDK session status is busy            |
| 2   | Status changes propagate    | `OpenCodeClient.onStatusChanged()`     | Callback fires when `$.emitEvent()` delivers status event |
| 3   | Session events propagate    | `OpenCodeClient.onSessionEvent()`      | Callback fires with correct event type                    |
| 4   | Connection error handling   | `OpenCodeClient.connect()`             | Throws when `$.setConnectionError()` configured           |
| 5   | Permission events propagate | `OpenCodeClient.onPermissionEvent()`   | Callback fires when permission events emitted             |
| 6   | Manager aggregates status   | `AgentStatusManager.getStatus()`       | Returns correct idle/busy counts                          |
| 7   | Manager notifies on change  | `AgentStatusManager.onStatusChanged()` | Listener fires when workspace status changes              |

**Note**: `$.emitEvent()` is used as an **action** (arrange/act), not an assertion target. Assertions verify service outcomes.

### Boundary Tests

Existing boundary tests in `opencode-client.boundary.test.ts` validate real SDK behavior against a live OpenCode server. These ensure the behavioral mock matches real SDK contract.

### Manual Testing Checklist

- [ ] Run `pnpm test:integration` - all OpenCode tests pass
- [ ] Run `pnpm validate:fix` - no lint/type errors
- [ ] Verify no remaining imports of `sdk-test-utils.ts`

## Dependencies

No new dependencies required. Uses existing:

- `vitest` for testing and matchers
- `@opencode-ai/sdk` types (already a dependency)

## Documentation Updates

### Files to Update

| File              | Changes Required                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/TESTING.md` | Add SDK mock to "State Mock Pattern" section with factory signature, state interface, matchers, and usage example |

### New Documentation Required

None - inline JSDoc in the mock file is sufficient.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
