---
status: COMPLETED
last_updated: 2026-01-02
reviewers: [review-testing, review-typescript]
---

# MOCK_PORT_MANAGER

## Overview

- **Problem**: The current `createMockPortManager()` is a simple call-tracking mock that doesn't follow the behavioral `mock.$` pattern established in `src/test/state-mock.ts`. It uses a different options structure (`{ findFreePort: { port, error } }`) inconsistent with other state mocks.
- **Solution**: Migrate to a minimal state mock that returns ports sequentially from a configured list, implements `MockWithState<PortManagerMockState>`, and throws when exhausted.
- **Risks**:
  - Many tests use the old API - need to update call sites (mitigated by simple 1:1 mapping)
- **Alternatives Considered**:
  - Full behavioral mock with occupied ports simulation → rejected (overengineered for single-method interface)
  - Custom matchers (toHaveAllocatedPort, etc.) → rejected (no tests actually assert on mock state)

## Architecture

```
PortManager Interface (1 method)
┌─────────────────────────────────┐
│ findFreePort(): Promise<number> │
└─────────────────────────────────┘

MockPortManager Implementation
┌─────────────────────────────────────────────────┐
│ MockPortManager                                 │
├─────────────────────────────────────────────────┤
│ $: PortManagerMockState                         │
│   ├─ remainingPorts: readonly number[]          │
│   ├─ allocatedPorts: readonly number[]          │
│   ├─ snapshot(): Snapshot                       │
│   └─ toString(): string                         │
├─────────────────────────────────────────────────┤
│ findFreePort(): Promise<number>                 │
│   - Returns next port from remainingPorts       │
│   - Moves port to allocatedPorts                │
│   - Throws "No ports available" when exhausted  │
└─────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Create port-manager.state-mock.ts**
  - Create `src/services/platform/port-manager.state-mock.ts`
  - Define explicit type: `export type MockPortManager = PortManager & MockWithState<PortManagerMockState>`
  - Implement `PortManagerMockState` class implementing `MockState`
  - Use readonly getters for `remainingPorts` and `allocatedPorts` (return `readonly number[]`)
  - Implement `createPortManagerMock(ports?: number[]): MockPortManager`
  - Add JSDoc with `@example` blocks (follow `createMockHttpClient` pattern)
  - Default ports: `[8080]`
  - Throw `Error("No ports available")` when exhausted
  - Files affected: `src/services/platform/port-manager.state-mock.ts` (new)

- [x] **Step 2: Update network.test-utils.ts**
  - Remove `MockPortManagerOptions` interface
  - Remove `createMockPortManager()` function
  - Add re-export: `export { createPortManagerMock, type MockPortManager } from "./port-manager.state-mock"`
  - Keep `createMockPortManager` as deprecated alias for backward compatibility during migration
  - Files affected: `src/services/platform/network.test-utils.ts`

- [x] **Step 3: Update plugin-server.test.ts**
  - Change `createMockPortManager({ findFreePort: { port: 3000 } })` to `createPortManagerMock([3000])`
  - Files affected: `src/services/plugin-server/plugin-server.test.ts`

- [x] **Step 4: Update code-server-manager.test.ts**
  - Change all `createMockPortManager({ findFreePort: { port: X } })` to `createPortManagerMock([X])`
  - Update the one test that uses inline mock override to use array syntax
  - Files affected: `src/services/code-server/code-server-manager.test.ts`

- [x] **Step 5: Update code-server-manager.integration.test.ts**
  - Change all `createMockPortManager({ findFreePort: { port: 8080 } })` to `createPortManagerMock([8080])`
  - Files affected: `src/services/code-server/code-server-manager.integration.test.ts`

- [x] **Step 6: Update mcp-server-manager.test.ts**
  - Change local `createMockPortManager()` to use imported `createPortManagerMock()`
  - Update error test to handle exhausted ports pattern
  - Files affected: `src/services/mcp-server/mcp-server-manager.test.ts`

- [x] **Step 7: Update opencode-server-manager.test.ts**
  - Change local `createTestPortManager()` to use `createPortManagerMock()`
  - For tests needing sequential ports, pass array like `[14001, 14002, 14003]`
  - Files affected: `src/services/opencode/opencode-server-manager.test.ts`

- [x] **Step 8: Update opencode-server-manager.integration.test.ts**
  - Change local `createTestPortManager()` to use `createPortManagerMock()`
  - Files affected: `src/services/opencode/opencode-server-manager.integration.test.ts`

- [x] **Step 9: Verify no call-tracking assertions**
  - Review migrated test files for call-tracking patterns like `expect(mock.findFreePort).toHaveBeenCalled()`
  - Flag any found for conversion to behavioral assertions (verify outcomes, not calls)
  - Files affected: All files from Steps 3-8

- [x] **Step 10: Remove deprecated alias**
  - Remove `createMockPortManager` alias from `network.test-utils.ts`
  - Verify no remaining usages via grep
  - Files affected: `src/services/platform/network.test-utils.ts`

## Testing Strategy

No new tests needed - this is test infrastructure. Existing tests using the mock provide sufficient validation.

### Manual Testing Checklist

- [x] `pnpm test:integration` passes (pre-existing dictation extension failure unrelated)
- [x] `pnpm test:legacy` passes (unit tests)
- [x] `pnpm validate:fix` passes (pre-existing extensions type check failure unrelated)

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File              | Changes Required                                                         |
| ----------------- | ------------------------------------------------------------------------ |
| `docs/TESTING.md` | Add port-manager.state-mock.ts to State Mock Pattern examples (optional) |

### New Documentation Required

| File | Purpose                            |
| ---- | ---------------------------------- |
| None | JSDoc in source file is sufficient |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] All tests using PortManager mock updated to new API
- [ ] No remaining usages of old `createMockPortManager` API
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
