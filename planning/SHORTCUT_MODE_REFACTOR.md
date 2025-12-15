---
status: APPROVED
last_updated: 2025-12-15
reviewers: [review-arch, review-typescript, review-testing, review-ui, review-docs]
---

# SHORTCUT_MODE_REFACTOR

## Overview

- **Problem**: Shortcut mode detection is split between main process (Alt+X activation) and renderer (action keys). This creates complexity, race conditions, and multiple IPC calls for simple operations.
- **Solution**: Consolidate all shortcut detection in main process, introduce unified UI mode system, simplify event flow.
- **Rationale**: Unified main-process detection eliminates race conditions where renderer sees action keys before focus switches, and simplifies the event flow by having a single source of truth for shortcut state.
- **Risks**:
  - Regression in keyboard handling edge cases (mitigated by comprehensive TDD tests per stage)
  - Event timing issues during mode transitions (mitigated by explicit state machine with idempotent transitions)
- **Alternatives Considered**:
  - Keep current split architecture, just clean up → Rejected: doesn't address root cause of complexity
  - Move all handling to renderer → Rejected: can't intercept keyboard events in WebContentsViews from renderer

### Design Decisions

1. **ViewManager owns mode state**: ViewManager is the single source of truth for UI mode. ShortcutController queries `viewManager.getMode()` instead of tracking its own `shortcutModeActive` flag. This eliminates state drift between components.

2. **Escape handled in renderer**: Escape is the only shortcut key handled by renderer (not main process) because:
   - It's a UI-level action (close overlay) that doesn't require view focus changes
   - Letting it bubble to renderer simplifies the main process state machine
   - It works consistently whether shortcut mode is active or not

3. **Mode transitions are idempotent**: Calling `setMode()` with the current mode is a no-op (no event emitted). This prevents spurious events during workspace switches.

4. **Events processed in order**: The `ui:mode-changed` events are guaranteed to be processed in order by the renderer (IPC channel ordering).

5. **Number key semantics**: Keys "1"-"9" map to workspaces 1-9, key "0" maps to workspace 10. Workspaces 11+ have no keyboard shortcut.

## Architecture

### Current Architecture (Complex)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Main Process                                                            │
│  ┌──────────────────────┐                                               │
│  │ ShortcutController   │                                               │
│  │ - Alt+X detection    │───► shortcut:enable ──────────────────┐       │
│  │ - Alt release detect │───► shortcut:disable ─────────────────┤       │
│  │ - tracks own state   │                                       │       │
│  └──────────────────────┘                                       │       │
│                                                                 │       │
│  ┌──────────────────────┐                                       │       │
│  │ ViewManager          │◄── setDialogMode() ◄──────────────────┼───┐   │
│  │ - z-index via dialog │◄── focusActiveWorkspace() ◄───────────┼───┤   │
│  │ - tracks isDialogMode│                                       │   │   │
│  └──────────────────────┘                                       │   │   │
└─────────────────────────────────────────────────────────────────┼───┼───┘
                                                                  │   │
┌─────────────────────────────────────────────────────────────────┼───┼───┐
│ Renderer                                                        │   │   │
│  ┌──────────────────────┐                                       │   │   │
│  │ App.svelte           │◄──────────────────────────────────────┘   │   │
│  │ - keyboard events    │ handles Up/Down/Enter/0-9/Del/O locally   │   │
│  │ - calls IPC back     │───────────────────────────────────────────┘   │
│  └──────────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Target Architecture (Simple)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Main Process                                                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ ShortcutController                                               │   │
│  │ - Registers before-input-event on ALL WebViews                   │   │
│  │ - Queries viewManager.getMode() for current state                │   │
│  │ - Alt+X when mode!=shortcut → setMode("shortcut")                │   │
│  │ - Up/Down/Enter/0-9/Del/O when mode=shortcut → emit shortcut     │   │
│  │ - Alt release when mode=shortcut → setMode("workspace")          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                           │                                             │
│                           ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ ViewManager (SINGLE SOURCE OF TRUTH for mode)                    │   │
│  │ - setMode(mode) → updates z-index + focus, emits event           │   │
│  │ - getMode() → returns current mode                               │   │
│  │ - mode=workspace: UI at z-index 0, focus workspace               │   │
│  │ - mode=shortcut: UI on top, focus UI                             │   │
│  │ - mode=dialog: UI on top, no focus change                        │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                           │                                             │
│                           ▼ api:ui:mode-changed event                   │
│                           ▼ api:shortcut:key event                      │
└───────────────────────────┼─────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────────┐
│ Renderer                  ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ App.svelte                                                       │   │
│  │ - Subscribes to api:ui:mode-changed → updates shortcut store     │   │
│  │ - Subscribes to api:shortcut:key → triggers action               │   │
│  │ - Escape key handler calls setMode("workspace")                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Dialogs                                                          │   │
│  │ - Calls api.ui.setMode("dialog") when opening                    │   │
│  │ - Calls api.ui.setMode("workspace") when closing                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event Flow (Target)

```
User Action                Main Process                    Renderer
───────────────────────────────────────────────────────────────────────────
Alt+X pressed         ──►  setMode("shortcut")
                           emit ui:mode-changed       ──►  show overlay
                           {mode, previousMode}            announce to SR

Up/Down/0-9/Del/O     ──►  emit shortcut:key={key}   ──►  map key to action
                                                           (may call setMode)

Escape pressed                                       ──►  api.setMode("workspace")
                      ◄──  setMode("workspace")            (fire-and-forget)
                           emit ui:mode-changed      ──►  hide overlay

Alt released          ──►  setMode("workspace")
                           emit ui:mode-changed      ──►  hide overlay

Dialog opens (shortcut)                              ──►  api.setMode("dialog")
                      ◄──  setMode("dialog")               (fire-and-forget)
                           emit ui:mode-changed      ──►  hide overlay, show dialog

Dialog opens (normal)                                ──►  api.setMode("dialog")
                      ◄──  setMode("dialog")
                           emit ui:mode-changed      ──►  (no-op if mode unchanged)

Dialog closes                                        ──►  api.setMode("workspace")
                      ◄──  setMode("workspace")
                           emit ui:mode-changed      ──►  focus workspace
```

### Focus Management

| Transition           | Focus Behavior                                       |
| -------------------- | ---------------------------------------------------- |
| workspace → shortcut | Focus moves to UI layer (overlay can receive Escape) |
| shortcut → workspace | Focus returns to active workspace view               |
| shortcut → dialog    | Focus moves to dialog component                      |
| workspace → dialog   | Focus moves to dialog component                      |
| dialog → workspace   | Focus returns to active workspace view               |

---

## Stage 1: UI Mode Infrastructure

**Goal**: Introduce unified mode system, replace shortcut:enable/disable with ui:mode-changed event.

**Scope**: New types, ViewManager.setMode(), ui:mode-changed event, renderer subscribes to event.

**Backward Compatibility**: Old API (setDialogMode, focusActiveWorkspace) still works during this stage.

### Implementation Steps

- [x] **Step 1.1: Add types to shared modules (TDD)**
  - Write test: `UIMode` type accepts only valid values
  - Write test: `UIModeChangedEvent` has mode and previousMode
  - Add `UIMode = "workspace" | "dialog" | "shortcut"` to `src/shared/ipc.ts`
  - Add `UIModeChangedEvent = { mode: UIMode; previousMode: UIMode }` type
  - Add `api:ui:mode-changed` event channel (follows `api:<domain>:<action>` pattern)
  - Keep old channels for now (will remove in Stage 3)
  - Files: `src/shared/ipc.ts`
  - Test criteria: Types compile, type tests pass

- [x] **Step 1.2: Add setMode() to ViewManager (TDD)**
  - Write failing tests FIRST:
    - `setMode("workspace") sets z-index to 0 and focuses active workspace`
    - `setMode("shortcut") sets z-index to top and focuses UI`
    - `setMode("dialog") sets z-index to top and does not change focus`
    - `setMode() with same mode is no-op (no event emitted)`
    - `setMode() emits event with mode and previousMode`
  - Implement:
    - Add `private mode: UIMode = "workspace"` state
    - Add `setMode(mode: UIMode): void` method with idempotent check
    - Add `getMode(): UIMode` getter
    - Add debug logging: `console.debug('ViewManager mode:', previousMode, '→', newMode)`
  - Mode behavior:
    - `workspace`: UI at z-index 0, focus active workspace
    - `shortcut`: UI on top, focus UI layer
    - `dialog`: UI on top (no focus change)
  - Emit `ui:mode-changed` event via callback when mode actually changes
  - Update `setDialogMode()` to call `setMode()` internally (deprecated, kept for migration)
  - Files: `src/main/managers/view-manager.ts`, `src/main/managers/view-manager.interface.ts`
  - Test criteria: All unit tests pass

- [x] **Step 1.3: Add setMode() to API and IPC handlers (TDD)**
  - Write failing tests FIRST:
    - `api:ui:set-mode handler calls viewManager.setMode()`
    - `api:ui:set-mode handler validates mode parameter`
  - Add `setMode(mode: UIMode): void` to `UIApi` interface
  - Add IPC handler `api:ui:set-mode`
  - Handler calls `viewManager.setMode()`
  - Files: `src/shared/api/interfaces.ts`, `src/main/api/codehydra-api.ts`, `src/main/ipc/api-handlers.ts`
  - Test criteria: API tests pass, IPC handler tests pass

- [x] **Step 1.4: Update preload with new event subscription (TDD)**
  - Write failing test: `onModeChange subscription receives UIModeChangedEvent`
  - Add `onModeChange(callback: (event: UIModeChangedEvent) => void): () => void`
  - Keep old subscriptions for now
  - Files: `src/preload/index.ts`
  - Test criteria: Preload exposes new subscription, test passes

- [x] **Step 1.5: Update ShortcutController to use setMode() (TDD)**
  - Write failing tests FIRST:
    - `Alt+X when mode is workspace calls setMode("shortcut")`
    - `Alt+X when mode is dialog is ignored (no mode change)`
    - `Alt release when mode is shortcut calls setMode("workspace")`
    - `Alt release when mode is workspace is ignored`
    - `Rapid Alt+X press/release handles correctly`
  - Remove `shortcutModeActive` flag - query `viewManager.getMode()` instead
  - On Alt+X activation: call `viewManager.setMode("shortcut")`
  - On Alt release: call `viewManager.setMode("workspace")` only if mode is shortcut
  - Remove SHORTCUT_ENABLE and SHORTCUT_DISABLE emission entirely
  - Files: `src/main/shortcut-controller.ts`
  - Test criteria: All unit tests pass

- [x] **Step 1.6: Update renderer to subscribe to ui:mode-changed (TDD)**
  - Write failing tests FIRST:
    - `onModeChange with mode=shortcut shows overlay`
    - `onModeChange with mode=workspace hides overlay`
    - `Subscription cleanup on unmount`
  - Subscribe to `onModeChange` in App.svelte using Svelte 5 pattern:
    ```typescript
    $effect(() => {
      const unsubscribe = api.onModeChange((event) => {
        updateMode(event.mode);
      });
      return unsubscribe; // Cleanup on unmount
    });
    ```
  - Update shortcuts store to track mode from event
  - Add ARIA live region for screen reader announcements:
    ```svelte
    <span class="ch-visually-hidden" aria-live="polite">
      {#if mode === "shortcut"}Shortcut mode active. Use arrow keys to navigate.{/if}
    </span>
    ```
  - Keep keyboard handler for now (actions still handled in renderer)
  - Files: `src/renderer/App.svelte`, `src/renderer/lib/stores/shortcuts.svelte.ts`
  - Test criteria: Component tests pass, overlay shows/hides based on mode event

- [x] **Step 1.7: Remove shortcut:enable/disable events**
  - Remove SHORTCUT_ENABLE and SHORTCUT_DISABLE from IPC channel constants
  - Remove old subscriptions from preload (`onShortcutEnable`, `onShortcutDisable`)
  - Remove old handlers from App.svelte
  - Files: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/App.svelte`
  - Test criteria: All tests pass, no references to old events

### Stage 1 Testing

**Unit Tests** (write FIRST, before implementation):

| Test Case                      | Description                    | File                          |
| ------------------------------ | ------------------------------ | ----------------------------- |
| `setMode("workspace")` z-index | Sets z-index to 0              | `view-manager.test.ts`        |
| `setMode("workspace")` focus   | Focuses active workspace       | `view-manager.test.ts`        |
| `setMode("shortcut")` z-index  | Sets z-index to top            | `view-manager.test.ts`        |
| `setMode("shortcut")` focus    | Focuses UI layer               | `view-manager.test.ts`        |
| `setMode("dialog")` z-index    | Sets z-index to top            | `view-manager.test.ts`        |
| `setMode("dialog")` focus      | Does not change focus          | `view-manager.test.ts`        |
| `setMode()` idempotent         | Same mode = no event           | `view-manager.test.ts`        |
| `setMode()` event payload      | Includes mode and previousMode | `view-manager.test.ts`        |
| Alt+X in workspace mode        | Calls setMode("shortcut")      | `shortcut-controller.test.ts` |
| Alt+X in dialog mode           | Ignored                        | `shortcut-controller.test.ts` |
| Alt release in shortcut mode   | Calls setMode("workspace")     | `shortcut-controller.test.ts` |
| Rapid Alt+X                    | Handles correctly              | `shortcut-controller.test.ts` |

**Manual Testing Checklist**:

- [ ] Alt+X activates shortcut mode (overlay visible)
- [ ] Releasing Alt exits shortcut mode (overlay hidden)
- [ ] Alt+X while dialog open does NOT activate shortcut mode
- [ ] Arrow keys still navigate (existing keyboard handler)
- [ ] Number keys still work
- [ ] Enter/Delete/O still work
- [ ] Opening dialog works
- [ ] Closing dialog returns focus to workspace
- [ ] Screen reader announces "Shortcut mode active"

---

## Stage 2: Shortcut Actions via Events

**Goal**: Main process detects action keys, emits events, renderer handles events.

**Scope**: ShortcutController action detection, shortcut:key event, renderer event handler.

**Backward Compatibility**: None needed - this replaces renderer keyboard handling.

### Implementation Steps

- [ ] **Step 2.1: Add ShortcutKey type and event channel (TDD)**
  - Write failing tests:
    - `isShortcutKey("up")` returns true
    - `isShortcutKey("invalid")` returns false
  - Add type and type guard to `src/shared/shortcuts.ts`:
    ```typescript
    export const SHORTCUT_KEYS = [
      "up",
      "down",
      "enter",
      "delete",
      "o",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ] as const;
    export type ShortcutKey = (typeof SHORTCUT_KEYS)[number];
    export function isShortcutKey(key: string): key is ShortcutKey {
      return (SHORTCUT_KEYS as readonly string[]).includes(key);
    }
    ```
  - Add `api:shortcut:key` event channel (follows `api:<domain>:<action>` pattern)
  - Files: `src/shared/ipc.ts`, `src/shared/shortcuts.ts`
  - Test criteria: Type tests pass, type guard works

- [ ] **Step 2.2: Add shortcut event emission to ShortcutController (TDD)**
  - Write failing tests FIRST (use `test.each` for key mappings):
    ```typescript
    test.each([
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["Enter", "enter"],
      ["Delete", "delete"],
      ["Backspace", "delete"],
      ["o", "o"],
      ["O", "o"],
      ["0", "0"],
      // ... etc for 1-9
    ])("emits %s as shortcut key %s", (input, expected) => { ... });
    ```
  - Write tests for edge cases:
    - `Shortcut key when mode is workspace is ignored`
    - `Shortcut key when mode is dialog is ignored`
    - `Unknown key in shortcut mode is not suppressed`
  - Add `onShortcut` callback to `ShortcutControllerDeps`:
    ```typescript
    interface ShortcutControllerDeps {
      setMode: (mode: UIMode) => void;
      getMode: () => UIMode;
      focusUI: () => void;
      getUIWebContents: () => WebContents | null;
      onShortcut?: (key: ShortcutKey) => void;
    }
    ```
  - Add type-safe key normalization:
    ```typescript
    const KEY_MAP: Record<string, ShortcutKey> = {
      ArrowUp: "up",
      ArrowDown: "down",
      Enter: "enter",
      Delete: "delete",
      Backspace: "delete",
      o: "o",
      O: "o",
      // 0-9 map to themselves
    };
    function normalizeKey(key: string): ShortcutKey | null {
      return KEY_MAP[key] ?? (isShortcutKey(key) ? key : null);
    }
    ```
  - When mode=shortcut and shortcut key pressed: suppress event, call `onShortcut(key)`
  - NOTE: Escape is NOT handled here (see Design Decisions)
  - Files: `src/main/shortcut-controller.ts`
  - Test criteria: All parameterized tests pass

- [ ] **Step 2.3: Wire shortcut event to IPC**
  - In main process setup, wire `ShortcutController.onShortcut` to emit IPC event
  - Files: `src/main/index.ts` or where ShortcutController is instantiated
  - Test criteria: Integration test verifies events reach renderer

- [ ] **Step 2.4: Add onShortcut subscription to preload (TDD)**
  - Write failing test: `onShortcut subscription receives ShortcutKey`
  - Add `onShortcut(callback: (key: ShortcutKey) => void): () => void`
  - Files: `src/preload/index.ts`
  - Test criteria: Preload exposes subscription

- [ ] **Step 2.5: Update renderer to handle shortcut events (TDD)**
  - Write failing tests FIRST:
    - `Shortcut "up" calls navigateWorkspace(-1)`
    - `Shortcut "down" calls navigateWorkspace(1)`
    - `Shortcut "0" calls jumpToWorkspace(9)` (0 = workspace 10, index 9)
    - `Shortcut "1"-"9" calls jumpToWorkspace(index)`
    - `Shortcut "enter" opens create workspace dialog`
    - `Shortcut "delete" opens delete confirmation`
    - `Shortcut "o" opens project dialog`
    - `Shortcut number beyond workspace count is ignored`
  - Subscribe to `onShortcut` in App.svelte:
    ```typescript
    $effect(() => {
      const unsubscribe = api.onShortcut((key) => {
        handleShortcutKey(key);
      });
      return unsubscribe;
    });
    ```
  - Map keys to actions (renderer decides semantics):
    - "up"/"down" → navigate workspace list
    - "1"-"9" → jump to workspace 1-9 (index 0-8)
    - "0" → jump to workspace 10 (index 9)
    - "enter" → create workspace, calls `void api.ui.setMode("dialog")`
    - "delete" → remove workspace, calls `void api.ui.setMode("dialog")`
    - "o" → open project dialog, calls `void api.ui.setMode("dialog")`
  - Files: `src/renderer/App.svelte`
  - Test criteria: All action tests pass

- [ ] **Step 2.6: Remove keyboard event handling from renderer (TDD)**
  - Write failing test: `Escape key in shortcut mode calls api.ui.setMode("workspace")`
  - Remove `handleKeyDown` for shortcut mode action keys from App.svelte
  - KEEP Escape key handler:
    ```typescript
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && shortcutStore.mode === "shortcut") {
        void api.ui.setMode("workspace"); // Fire-and-forget pattern
      }
    }
    ```
  - Simplify shortcuts store (remove key handling logic, keep only mode state)
  - Files: `src/renderer/App.svelte`, `src/renderer/lib/stores/shortcuts.svelte.ts`
  - Test criteria: Only Escape handler remains, test passes

- [ ] **Step 2.7: Register before-input-event on UI view (TDD)**
  - Write failing test: `Action key captured when UI view has focus`
  - ShortcutController registers handler on UI WebContentsView
  - Ensures action keys are captured even when UI has focus
  - Files: `src/main/shortcut-controller.ts`
  - Test criteria: Actions work regardless of which view has focus

### Stage 2 Testing

**Unit Tests** (write FIRST):

| Test Case                         | Description                        | File                          |
| --------------------------------- | ---------------------------------- | ----------------------------- |
| Key normalization (parameterized) | Each key maps correctly            | `shortcut-controller.test.ts` |
| Shortcut in workspace mode        | Ignored                            | `shortcut-controller.test.ts` |
| Shortcut in dialog mode           | Ignored                            | `shortcut-controller.test.ts` |
| Unknown key not suppressed        | Passes through                     | `shortcut-controller.test.ts` |
| "up" action                       | Navigates up                       | `App.test.ts`                 |
| "down" action                     | Navigates down                     | `App.test.ts`                 |
| "0"-"9" actions                   | Jump to workspace                  | `App.test.ts`                 |
| Number beyond count               | Ignored                            | `App.test.ts`                 |
| "enter" action                    | Opens create dialog                | `App.test.ts`                 |
| "delete" action                   | Opens delete confirm               | `App.test.ts`                 |
| "o" action                        | Opens project dialog               | `App.test.ts`                 |
| Escape in shortcut mode           | Calls setMode("workspace")         | `App.test.ts`                 |
| Navigation at first workspace     | Wraps or stays (document behavior) | `App.test.ts`                 |
| Navigation at last workspace      | Wraps or stays (document behavior) | `App.test.ts`                 |

**Manual Testing Checklist**:

- [ ] Arrow Up navigates up in workspace list
- [ ] Arrow Down navigates down in workspace list
- [ ] Arrow Up at first workspace (verify wrap/stop behavior)
- [ ] Arrow Down at last workspace (verify wrap/stop behavior)
- [ ] Number keys 1-9 jump to corresponding workspace
- [ ] Number key 0 jumps to workspace 10
- [ ] Number key for non-existent workspace is ignored
- [ ] Enter opens create workspace dialog (mode becomes "dialog")
- [ ] Delete opens remove workspace confirmation
- [ ] O opens project selector
- [ ] Escape exits shortcut mode (renderer handles this, calls setMode)
- [ ] Actions work when workspace view has focus
- [ ] Actions work when UI view has focus
- [ ] Opening dialog during shortcut mode hides overlay

---

## Stage 3: Cleanup and Consolidation

**Goal**: Remove old API methods, clean up dead code, update documentation.

**Scope**: Remove setDialogMode, focusActiveWorkspace, migrate all callers, update docs.

### Implementation Steps

- [ ] **Step 3.1: Migrate dialog components to setMode()**
  - Search for `setDialogMode(true)` and `setDialogMode(false)` patterns
  - Replace `api.ui.setDialogMode(true)` with `void api.ui.setMode("dialog")`
  - Replace `api.ui.setDialogMode(false)` + `api.ui.focusActiveWorkspace()` with `void api.ui.setMode("workspace")`
  - Note: If `setDialogMode(false)` appears alone without `focusActiveWorkspace()`, verify intended behavior before replacing
  - Files: `src/renderer/lib/components/MainView.svelte`, any components using setDialogMode
  - Test criteria: Dialogs work correctly

- [ ] **Step 3.2: Remove old API methods**
  - Remove `setDialogMode()` from UIApi interface and implementation
  - Remove `focusActiveWorkspace()` from UIApi interface and implementation
  - Remove IPC handlers for old methods
  - Files: `src/shared/api/interfaces.ts`, `src/main/api/codehydra-api.ts`, `src/main/ipc/api-handlers.ts`
  - Test criteria: Old methods no longer exist, TypeScript errors if any caller remains

- [ ] **Step 3.3: Remove old IPC channels**
  - Remove `api:ui:set-dialog-mode` channel
  - Remove `api:ui:focus-active-workspace` channel
  - Files: `src/shared/ipc.ts`
  - Test criteria: No references to old channels

- [ ] **Step 3.4: Update preload**
  - Remove `setDialogMode()` method
  - Remove `focusActiveWorkspace()` method
  - Files: `src/preload/index.ts`
  - Test criteria: Old methods not exposed

- [ ] **Step 3.5: Clean up ViewManager**
  - Remove `setDialogMode()` wrapper method
  - Remove `isDialogMode` flag (replaced by `mode` state)
  - Files: `src/main/managers/view-manager.ts`
  - Test criteria: Clean implementation with only setMode()/getMode()

- [ ] **Step 3.6: Update ARCHITECTURE.md**
  - Update "Dialog Overlay Mode" section: replace setDialogMode() with setMode()
  - Rewrite "Keyboard Capture System" section: unified main-process detection
  - Update "IPC Contract" section: remove shortcut:enable/disable, document api:ui:mode-changed and api:shortcut:key
  - Update architecture diagrams showing event flow
  - Files: `docs/ARCHITECTURE.md`
  - Test criteria: Documentation matches implementation

- [ ] **Step 3.7: Update AGENTS.md**
  - Update "Shortcut Mode" concept: clarify all detection in main process
  - Update "Fire-and-Forget IPC" section: replace setDialogMode() example with setMode()
  - Add note that action key detection moved from renderer to main process
  - Files: `AGENTS.md`
  - Test criteria: Documentation matches implementation

- [ ] **Step 3.8: Final cleanup pass**
  - Search for any remaining references to old methods
  - Run `npm run validate:fix`
  - Files: Various
  - Test criteria: No dead code, all tests pass, validation passes

### Stage 3 Testing

**Manual Testing Checklist**:

- [ ] All shortcut mode functionality works
- [ ] Opening dialogs from shortcut mode works (overlay disappears)
- [ ] Closing dialogs returns to workspace
- [ ] Project selector works
- [ ] Workspace creation works
- [ ] Workspace deletion works
- [ ] No console errors about missing methods
- [ ] Alt+X while dialog open (should not activate shortcut mode)

---

## Testing Strategy

### Test Utilities

Create helpers in `src/main/test-utils.ts`:

```typescript
// Factory for ViewManager with mocked dependencies
export function createTestViewManager(overrides?: Partial<ViewManagerDeps>): ViewManager;

// Factory for ShortcutController with mocked ViewManager
export function createTestShortcutController(
  overrides?: Partial<ShortcutControllerDeps>
): ShortcutController;

// Helper for simulating Electron keyboard events
export function simulateKeyPress(key: string, modifiers?: { alt?: boolean }): InputEvent;
```

### Unit Tests (vitest) - TDD Order

| Test Case                      | Stage | Description                    | File                          |
| ------------------------------ | ----- | ------------------------------ | ----------------------------- |
| `setMode("workspace")` z-index | 1     | Sets z-index to 0              | `view-manager.test.ts`        |
| `setMode("workspace")` focus   | 1     | Focuses active workspace       | `view-manager.test.ts`        |
| `setMode("shortcut")` z-index  | 1     | Sets z-index to top            | `view-manager.test.ts`        |
| `setMode("shortcut")` focus    | 1     | Focuses UI layer               | `view-manager.test.ts`        |
| `setMode("dialog")` z-index    | 1     | Sets z-index to top            | `view-manager.test.ts`        |
| `setMode("dialog")` focus      | 1     | Does not change focus          | `view-manager.test.ts`        |
| `setMode()` idempotent         | 1     | Same mode = no event           | `view-manager.test.ts`        |
| `setMode()` event payload      | 1     | Includes mode and previousMode | `view-manager.test.ts`        |
| Alt+X in workspace mode        | 1     | Calls setMode("shortcut")      | `shortcut-controller.test.ts` |
| Alt+X in dialog mode           | 1     | Ignored                        | `shortcut-controller.test.ts` |
| Alt release in shortcut        | 1     | Calls setMode("workspace")     | `shortcut-controller.test.ts` |
| Rapid Alt+X                    | 1     | Handles correctly              | `shortcut-controller.test.ts` |
| Key normalization (each)       | 2     | Maps correctly                 | `shortcut-controller.test.ts` |
| Shortcut in wrong mode         | 2     | Ignored                        | `shortcut-controller.test.ts` |
| "up"/"down" action             | 2     | Navigates                      | `App.test.ts`                 |
| Number key actions             | 2     | Jump to workspace              | `App.test.ts`                 |
| "enter"/"delete"/"o"           | 2     | Open dialogs                   | `App.test.ts`                 |
| Escape in shortcut             | 2     | Calls setMode                  | `App.test.ts`                 |
| Boundary navigation            | 2     | First/last workspace           | `App.test.ts`                 |

### Integration Tests

| Test Case              | Stage | Description                       | File                                      |
| ---------------------- | ----- | --------------------------------- | ----------------------------------------- |
| Mode change flow       | 1     | Alt+X → mode event → overlay      | `shortcut-controller.integration.test.ts` |
| Action event flow      | 2     | Key → event → action              | `shortcut-controller.integration.test.ts` |
| Dialog during shortcut | 2     | Action opens dialog, mode changes | `shortcut-controller.integration.test.ts` |
| Dialog mode flow       | 3     | Dialog open/close mode changes    | `shortcut-controller.integration.test.ts` |
| Escape handling        | 2     | Escape → setMode → mode event     | `App.test.ts`                             |

---

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Update Dialog Overlay Mode section, rewrite Keyboard Capture System section, update IPC Contract (remove shortcut:enable/disable, add api:ui:mode-changed and api:shortcut:key) |
| `AGENTS.md`            | Update Shortcut Mode concept (all detection in main), update Fire-and-Forget IPC example (setDialogMode → setMode)                                                              |

### New Documentation Required

| File   | Purpose                             |
| ------ | ----------------------------------- |
| (none) | Implementation is internal refactor |

## Definition of Done

- [ ] All Stage 1 steps complete and tested (TDD)
- [ ] All Stage 2 steps complete and tested (TDD)
- [ ] All Stage 3 steps complete and tested
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (ARCHITECTURE.md: Dialog Overlay Mode, Keyboard Capture System, IPC Contract; AGENTS.md: Shortcut Mode, Fire-and-Forget IPC)
- [ ] User acceptance testing passed for each stage
- [ ] Changes committed
