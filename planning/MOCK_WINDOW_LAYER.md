---
status: COMPLETED
last_updated: 2026-01-03
reviewers: [review-typescript, review-docs, review-testing]
---

# MOCK_WINDOW_LAYER

## Overview

- **Problem**: The WindowLayer behavioral mock uses the legacy `_getState()` pattern instead of the standardized `mock.$` pattern established in `src/test/state-mock.ts`. This inconsistency makes the codebase harder to maintain and doesn't follow the behavioral mock conventions.
- **Solution**: Migrate the WindowLayer mock from `window.test-utils.ts` to `window.state-mock.ts` using the `mock.$` pattern, add custom matchers for type-safe assertions (no direct state access), and update all tests.
- **Risks**:
  - Breaking existing tests (mitigated by updating all usages atomically)
  - Missing edge cases in matchers (mitigated by comprehensive matcher set based on actual usage)
- **Alternatives Considered**:
  - Keep `_getState()` pattern → rejected (inconsistent with other mocks like FileSystemLayer, PortManager)
  - Only add `$` alias without removing `_getState()` → rejected (maintains two patterns)

**Note**: Boundary tests for WindowLayer (testing real Electron BaseWindow) are out of scope for this migration. This plan focuses on the behavioral mock infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        window.state-mock.ts                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    WindowMockState (per-window)                   │   │
│  │  All properties readonly to prevent accidental mutation           │   │
│  │                                                                   │   │
│  │  readonly bounds: Rectangle                                       │   │
│  │  readonly contentBounds: Rectangle                                │   │
│  │  readonly title: string                                           │   │
│  │  readonly isMaximized: boolean                                    │   │
│  │  readonly isDestroyed: boolean                                    │   │
│  │  readonly attachedViews: ReadonlySet<string>                      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    WindowLayerMockState                           │   │
│  │  (extends MockState)                                              │   │
│  │                                                                   │   │
│  │  readonly windows: ReadonlyMap<string, WindowMockState>           │   │
│  │  snapshot(): Snapshot                                             │   │
│  │  toString(): string                                               │   │
│  │                                                                   │   │
│  │  // Trigger methods for simulating Electron window events         │   │
│  │  // Accessed via mock.$.triggerX(handle)                          │   │
│  │  triggerResize(handle): void                                      │   │
│  │  triggerMaximize(handle): void    // also sets isMaximized=true   │   │
│  │  triggerUnmaximize(handle): void  // also sets isMaximized=false  │   │
│  │  triggerClose(handle): void                                       │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    MockWindowLayer                                │   │
│  │  = WindowLayer & MockWithState<WindowLayerMockState>              │   │
│  │                                                                   │   │
│  │  // All WindowLayer methods (createWindow, destroy, etc.)         │   │
│  │  // Plus $ accessor for state                                     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    MockWindowLayerInternal                        │   │
│  │  = MockWindowLayer & WindowLayerInternal                          │   │
│  │                                                                   │   │
│  │  // Adds _getRawWindow() that throws (for manager tests)          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Factories:                                                              │
│  - createWindowLayerMock() → MockWindowLayer                             │
│      Use for: Integration tests that only need WindowLayer interface     │
│  - createWindowLayerInternalMock() → MockWindowLayerInternal             │
│      Use for: Manager tests that need WindowLayerInternal._getRawWindow  │
│               (throws by default - tests shouldn't use real BaseWindow)  │
│                                                                          │
│  Custom Matchers (required - no direct state access allowed):            │
│  - toHaveWindow(id)              // window exists                        │
│  - toHaveWindowCount(count)      // total window count                   │
│  - toHaveWindowTitle(id, title)  // window title check                   │
│  - toBeWindowMaximized(id)       // maximized state                      │
│  - toHaveWindowBounds(id, bounds) // bounds (partial match)              │
│  - toHaveAttachedView(id, viewId) // specific view attached              │
│  - toHaveAttachedViewCount(id, count) // attached view count             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Migration Pattern Example

**Before (window.test-utils.ts):**

```typescript
const windowLayer = createBehavioralWindowLayer();
const handle = windowLayer.createWindow({ title: "Test" });

// State access
const state = windowLayer._getState();
expect(state.windows.size).toBe(1);
expect(state.windows.get(handle.id)?.title).toBe("Test");

// Event simulation
windowLayer._triggerResize(handle);
```

**After (window.state-mock.ts):**

```typescript
const windowLayer = createWindowLayerMock();
const handle = windowLayer.createWindow({ title: "Test" });

// Custom matchers (no direct state access)
expect(windowLayer).toHaveWindowCount(1);
expect(windowLayer).toHaveWindowTitle(handle.id, "Test");

// Event simulation via $.triggerX()
windowLayer.$.triggerResize(handle);
```

## Implementation Steps

- [x] **Step 1: Create window.state-mock.ts**
  - Create new file `src/services/shell/window.state-mock.ts`
  - Follow the pattern from `src/services/platform/filesystem.state-mock.ts` for structure
  - Implement `WindowMockState` interface with all readonly properties
  - Implement `WindowLayerMockState` class with `$` pattern
  - Implement trigger methods on state class (`$.triggerResize()`, `$.triggerMaximize()`, etc.)
  - Implement `createWindowLayerMock()` factory
  - Implement `createWindowLayerInternalMock()` factory
  - Add all custom matchers with vitest module augmentation
  - Add JSDoc examples for each custom matcher showing typical usage
  - Files affected: `src/services/shell/window.state-mock.ts` (new)

- [x] **Step 2: Update window.integration.test.ts**
  - Note: This file tests the mock's behavior (validates trigger event simulation and state transitions)
  - Change imports from `window.test-utils` to `window.state-mock`
  - Replace `BehavioralWindowLayer` with `MockWindowLayer`
  - Replace `createBehavioralWindowLayer()` with `createWindowLayerMock()`
  - Replace `mock._getState().windows...` with custom matchers (no direct state access)
  - Replace `mock._triggerX(handle)` with `mock.$.triggerX(handle)`
  - Verify no call-tracking assertions (toHaveBeenCalled) - only behavioral outcomes
  - Files affected: `src/services/shell/window.integration.test.ts`

- [x] **Step 3: Update and rename window-manager.test.ts**
  - Rename `window-manager.test.ts` → `window-manager.integration.test.ts`
  - Change imports from `window.test-utils` to `window.state-mock`
  - Replace `TestWindowLayer` with `MockWindowLayerInternal`
  - Replace `createTestWindowLayer()` with `createWindowLayerInternalMock()`
  - Replace `deps.windowLayer._getState()...` with custom matchers (no direct state access)
  - Replace `deps.windowLayer._triggerX(handle)` with `deps.windowLayer.$.triggerX(handle)`
  - Verify no call-tracking assertions - only behavioral outcomes
  - Files affected: `src/main/managers/window-manager.test.ts` → `window-manager.integration.test.ts`

- [x] **Step 4: Update and rename view-manager.test.ts**
  - Rename `view-manager.test.ts` → `view-manager.integration.test.ts`
  - Change imports from `window.test-utils` to `window.state-mock`
  - Update `createViewManagerWindowLayer()` helper to use `MockWindowLayerInternal`
  - Replace `deps.windowLayer._getState()...` with custom matchers (no direct state access)
  - Verify no call-tracking assertions - only behavioral outcomes
  - Files affected: `src/main/managers/view-manager.test.ts` → `view-manager.integration.test.ts`

- [x] **Step 5: Remove old window.test-utils.ts**
  - Delete the file entirely (all functionality moved to state-mock)
  - Files affected: `src/services/shell/window.test-utils.ts` (delete)

- [x] **Step 6: Update documentation**
  - Update `docs/PATTERNS.md` Test Utils Location table
  - Change `createBehavioralWindowLayer()` → `createWindowLayerMock()`
  - Change `shell/window.test-utils.ts` → `shell/window.state-mock.ts`
  - Add entry for `createWindowLayerInternalMock()` factory
  - Files affected: `docs/PATTERNS.md`

- [x] **Step 7: Run validation**
  - Run `pnpm validate:fix` to ensure all checks pass

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File               | Changes Required                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/PATTERNS.md` | Update Test Utils Location table: Change `createBehavioralWindowLayer()` → `createWindowLayerMock()`, `shell/window.test-utils.ts` → `shell/window.state-mock.ts`. Add `createWindowLayerInternalMock()` entry. |

## Definition of Done

- [x] All implementation steps complete
- [x] `pnpm validate:fix` passes
- [x] Old `window.test-utils.ts` deleted
- [x] Test files renamed to `*.integration.test.ts`
- [x] No remaining `_getState()` or `_triggerX()` usages in WindowLayer tests
- [x] No direct state access in tests (all via custom matchers)
- [x] No call-tracking assertions in tests (only behavioral outcomes)
- [x] `docs/PATTERNS.md` updated with new factory names
