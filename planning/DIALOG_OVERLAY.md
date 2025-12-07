# DIALOG_OVERLAY

---

status: COMPLETED
last_updated: 2025-12-07
reviewers: [review-electron, review-arch, review-typescript, review-testing, review-docs]

---

## Overview

- **Problem**: The UI layer currently has full window bounds and is positioned on top of workspace views. Due to a failed CSS `pointer-events` approach, the workspace view is not receiving events. The body has `pointer-events: none` and `background: transparent`, with `pointer-events: auto` on sidebar and dialog overlay. This approach doesn't work because CSS pointer-events only affects DOM within a single WebContentsView, not between separate views.

- **Solution**: Use z-order swapping to control which WebContentsView receives events. In normal state, workspace views are on top (can receive events in content area). When a dialog opens, move the UI layer to the top so the dialog overlay can cover the entire window.

- **Risks**:
  | Risk | Likelihood | Impact | Mitigation |
  |------|------------|--------|------------|
  | Visual flicker during z-order change | Low | Low | Electron handles reordering atomically |
  | Race condition if dialog opens/closes rapidly | Low | Low | Operation is idempotent (see Design Decisions) |
  | Focus issues after z-order change | Medium | Medium | Focus managed by existing Dialog component |
  | Window destroyed during z-order change | Low | Low | Add try-catch with `isDestroyed()` check |

- **Alternatives Considered**:
  | Alternative | Why Rejected |
  |-------------|--------------|
  | CSS `pointer-events: none` on transparent areas | Doesn't work - CSS only affects DOM within a single WebContentsView, not between views |
  | Separate overlay WebContentsView for dialogs | More complex, need to manage separate view lifecycle and HTML |
  | `setIgnoreMouseEvents` API | Window-level only, can't apply to partial areas |
  | Resize UI bounds when dialog opens | More complex than z-order swap, same IPC requirements |

## Design Decisions

### 1. No Debounce for Rapid Open/Close

**Decision**: Do not add debounce or guard against rapid dialog open/close cycles.

**Rationale**:

- The `addChildView` operation is **idempotent** - calling it multiple times with the same state results in the same final state
- The operation is **synchronous and fast** (just reordering child views in memory)
- There's no "corrupted intermediate state" possible
- Adding debounce would introduce **latency** to the normal case (dialog feels sluggish)
- **YAGNI** - don't add complexity for a theoretical problem

**Future consideration**: If issues are observed, a simple state guard can be added:

```typescript
private dialogModeOpen = false;
setDialogMode(isOpen: boolean): void {
  if (this.dialogModeOpen === isOpen) return;
  this.dialogModeOpen = isOpen;
  // ... rest
}
```

### 2. Fire-and-Forget IPC (using invoke for consistency)

**Decision**: The renderer fires the IPC call without awaiting confirmation, but uses `invoke` pattern for consistency with existing codebase.

**Rationale**:

- Dialog appears **instantly** in the UI (no IPC round-trip delay)
- IPC is very fast (<5ms) while dialog fade-in animation is ~150-200ms
- The `setDialogMode` operation **cannot fail** (it's just reordering views)
- Using `invoke` maintains consistency with all other IPC calls in the codebase
- The `void` operator explicitly signals the promise is intentionally not awaited

**Note**: While `ipcRenderer.send()` would be more semantically correct for fire-and-forget, using `invoke` maintains codebase consistency. The performance difference is negligible.

### 3. Z-Order Change via $effect (Reactive Approach)

**Decision**: Use a Svelte `$effect` in App.svelte to watch dialog state and call the IPC, rather than calling IPC directly from store functions.

**Rationale**:

- Maintains **separation of concerns** - dialog store manages state, component handles side effects
- Store functions remain **pure state management** with no API dependencies
- Easier to **test** - store tests don't need to mock API calls
- **Reactive** - z-order automatically syncs with dialog state

**Implementation pattern**:

```typescript
// In App.svelte
$effect(() => {
  const isDialogOpen = dialogState.value.type !== "closed";
  void api.setDialogMode(isDialogOpen);
});
```

### 4. Modal Keyboard Behavior

**Decision**: When dialog is open (UI layer on top), all keyboard events go to the UI layer.

**Rationale**: This is correct modal dialog behavior - the workspace shouldn't receive keyboard events when a modal is open. The focus trap in Dialog.svelte ensures keyboard navigation stays within the dialog.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BaseWindow                                      │
│  contentView.children (z-order: later = on top)                             │
│                                                                             │
│  NORMAL STATE (no dialog):                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ children[0]: UI Layer        │ children[N]: Workspace Views        │   │
│  │ bounds: x=0, w=FULL          │ bounds: x=250, w=rest               │   │
│  │ z-order: BEHIND              │ z-order: ON TOP                     │   │
│  │                              │                                      │   │
│  │ Sidebar receives events here │ Workspace receives events here      │   │
│  │ (no workspace overlap at x<250)│ (workspaces are on top)           │   │
│  └──────────────────────────────┴──────────────────────────────────────┘   │
│                                                                             │
│  DIALOG STATE:                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ children[0..N-1]: Workspace Views                                   │   │
│  │ z-order: BEHIND                                                     │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ children[N]: UI Layer                                               │   │
│  │ bounds: x=0, w=FULL                                                 │   │
│  │ z-order: ON TOP                                                     │   │
│  │ ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │ │                    Dialog Overlay                               │ │   │
│  │ │                    (visible, receives all events)               │ │   │
│  │ └─────────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  DIALOG + WORKSPACE SWITCH:                                                 │
│  Dialog remains on top. New workspace view gets content area bounds         │
│  behind UI layer. Dialog state is independent of workspace switching.       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Renderer (UI Layer)                                                          │
│                                                                              │
│   User clicks [+] to create workspace                                        │
│              │                                                               │
│              ▼                                                               │
│   openCreateDialog() in dialogs store                                        │
│              │                                                               │
│              ▼                                                               │
│   _dialogState = { type: 'create', ... }                                     │
│              │                                                               │
│              ▼                                                               │
│   App.svelte $effect detects dialogState.value.type !== 'closed'             │
│              │                                                               │
│              ▼                                                               │
│   void api.setDialogMode(true)  ────────────────────────┐                    │
│                                                          │ IPC               │
└──────────────────────────────────────────────────────────┼───────────────────┘
                                                           │
┌──────────────────────────────────────────────────────────┼───────────────────┐
│ Main Process                                             ▼                   │
│                                                                              │
│   IPC Handler: 'ui:set-dialog-mode'                                          │
│              │                                                               │
│              ▼                                                               │
│   viewManager.setDialogMode(true)                                            │
│              │                                                               │
│              ▼                                                               │
│   contentView.addChildView(uiView)  // Moves UI to top                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 0: Revert Failed CSS Approach

- [x] **Step 0.1: Revert global.css changes**
  - File: `src/renderer/lib/styles/global.css`
  - Remove from body (lines 20-22):
    ```css
    /* REMOVE these lines */
    background: transparent;
    pointer-events: none;
    ```
  - Add back:
    ```css
    background: var(--ch-background);
    ```

- [x] **Step 0.2: Revert Sidebar.svelte CSS**
  - File: `src/renderer/lib/components/Sidebar.svelte`
  - Remove from `.sidebar` class (line 126):
    ```css
    /* REMOVE this line */
    pointer-events: auto;
    ```

- [x] **Step 0.3: Revert Dialog.svelte CSS**
  - File: `src/renderer/lib/components/Dialog.svelte`
  - Remove from `.dialog-overlay` class (line 122):
    ```css
    /* REMOVE this line */
    pointer-events: auto;
    ```

- [x] **Step 0.4: Revert view ordering in ViewManager**
  - File: `src/main/managers/view-manager.ts`
  - In `createWorkspaceView()` (around line 155), change:
    ```typescript
    // FROM:
    this.windowManager.getWindow().contentView.addChildView(view, 0);
    // TO:
    this.windowManager.getWindow().contentView.addChildView(view);
    ```
  - This adds workspace views AFTER UI layer (on top), which is the normal state.

- [x] **Step 0.5: Verify revert worked**
  - Run `pnpm dev`
  - Open a project
  - Verify workspace view is visible and interactive

### Step 1: Add IPC Channel

- [x] **Step 1.1: Define payload interface and IPC channel**
  - File: `src/shared/ipc.ts`
  - Add payload interface after other payload types (around line 126):
    ```typescript
    export interface UISetDialogModePayload {
      readonly isOpen: boolean;
    }
    ```
  - Add to `IpcCommands` interface:
    ```typescript
    "ui:set-dialog-mode": { payload: UISetDialogModePayload; response: void };
    ```
  - Add to `IpcChannels` object:
    ```typescript
    UI_SET_DIALOG_MODE: "ui:set-dialog-mode",
    ```

- [x] **Step 1.2: Add validation schema**
  - File: `src/main/ipc/validation.ts`
  - Add:
    ```typescript
    /**
     * Validation schema for ui:set-dialog-mode payload.
     */
    export const UISetDialogModePayloadSchema = z.object({
      isOpen: z.boolean(),
    });
    ```

### Step 2: Implement ViewManager Method

- [x] **Step 2.1: Update IViewManager interface**
  - File: `src/main/managers/view-manager.interface.ts`
  - Add method signature:
    ```typescript
    /**
     * Sets whether the UI layer should be in dialog mode.
     * In dialog mode, the UI is moved to the top to overlay workspace views.
     *
     * @param isOpen - True to enable dialog mode (UI on top), false for normal mode (UI behind)
     */
    setDialogMode(isOpen: boolean): void;
    ```

- [x] **Step 2.2: Write tests for setDialogMode**
  - File: `src/main/managers/view-manager.test.ts`
  - Add test cases:

    ```typescript
    describe("setDialogMode", () => {
      it("moves UI layer to top when isOpen is true", () => {
        // Setup: create ViewManager with workspace views
        // Act: viewManager.setDialogMode(true)
        // Assert: expect(mockContentView.addChildView).toHaveBeenCalledWith(mockUIView)
        // Assert: verify addChildView was called WITHOUT index parameter (adds to end = top)
      });

      it("moves UI layer to bottom when isOpen is false", () => {
        // Setup: create ViewManager
        // Act: viewManager.setDialogMode(false)
        // Assert: expect(mockContentView.addChildView).toHaveBeenCalledWith(mockUIView, 0)
      });

      it("is idempotent - multiple calls with same value are safe", () => {
        // Act: call setDialogMode(true) twice
        // Assert: no errors, addChildView called twice (both are valid operations)
      });

      it("does not throw when window is destroyed", () => {
        // Setup: mock window.isDestroyed() to return true
        // Act & Assert: expect(() => viewManager.setDialogMode(true)).not.toThrow()
      });

      it("does not affect workspace views - they remain in children array", () => {
        // Setup: create ViewManager with 2 workspace views
        // Act: viewManager.setDialogMode(true)
        // Assert: workspace views still accessible via getWorkspaceView()
      });
    });
    ```

- [x] **Step 2.3: Implement setDialogMode in ViewManager**
  - File: `src/main/managers/view-manager.ts`
  - Add implementation:

    ```typescript
    /**
     * Sets whether the UI layer should be in dialog mode.
     * In dialog mode, the UI is moved to the top to overlay workspace views.
     *
     * @param isOpen - True to enable dialog mode (UI on top), false for normal mode (UI behind)
     */
    setDialogMode(isOpen: boolean): void {
      try {
        const window = this.windowManager.getWindow();
        if (window.isDestroyed()) return;

        const contentView = window.contentView;
        if (isOpen) {
          // Move UI to top (adding existing child moves it to end = top)
          contentView.addChildView(this.uiView);
        } else {
          // Move UI to bottom (index 0 = behind workspaces)
          contentView.addChildView(this.uiView, 0);
        }
      } catch {
        // Ignore errors during z-order change - window may be closing
      }
    }
    ```

- [x] **Step 2.4: Verify build passes**
  - Run `pnpm build` - should complete without TypeScript errors

### Step 3: Register IPC Handler

- [x] **Step 3.1: Write tests for handler**
  - File: `src/main/ipc/handlers.test.ts`
  - Add test cases:

    ```typescript
    describe("ui:set-dialog-mode handler", () => {
      it("calls viewManager.setDialogMode with isOpen=true", async () => {
        const mockViewManager = { setDialogMode: vi.fn() };
        const handler = createUISetDialogModeHandler(mockViewManager);

        await handler(mockEvent, { isOpen: true });

        expect(mockViewManager.setDialogMode).toHaveBeenCalledWith(true);
      });

      it("calls viewManager.setDialogMode with isOpen=false", async () => {
        const mockViewManager = { setDialogMode: vi.fn() };
        const handler = createUISetDialogModeHandler(mockViewManager);

        await handler(mockEvent, { isOpen: false });

        expect(mockViewManager.setDialogMode).toHaveBeenCalledWith(false);
      });

      it("throws ValidationError when payload is missing", async () => {
        // Test via registerAllHandlers integration
      });

      it("throws ValidationError when isOpen is not boolean", async () => {
        // Test validation schema rejects string, number, etc.
      });
    });
    ```

- [x] **Step 3.2: Create handler function**
  - File: `src/main/ipc/handlers.ts`
  - Add handler factory:
    ```typescript
    /**
     * Creates handler for ui:set-dialog-mode command.
     */
    export function createUISetDialogModeHandler(
      viewManager: Pick<IViewManager, "setDialogMode">
    ): (event: IpcMainInvokeEvent, payload: UISetDialogModePayload) => Promise<void> {
      return async (_event, payload) => {
        viewManager.setDialogMode(payload.isOpen);
      };
    }
    ```

- [x] **Step 3.3: Register handler in registerAllHandlers**
  - File: `src/main/ipc/handlers.ts`
  - Add registration:
    ```typescript
    registerHandler(
      "ui:set-dialog-mode",
      UISetDialogModePayloadSchema,
      createUISetDialogModeHandler(viewManager)
    );
    ```
  - Add import for `UISetDialogModePayloadSchema` from `./validation`
  - Add import for `UISetDialogModePayload` from `../../shared/ipc`

### Step 4: Expose in Preload

- [x] **Step 4.1: Update preload tests**
  - File: `src/preload/index.test.ts`
  - Add test:

    ```typescript
    it("setDialogMode calls ipcRenderer.invoke with correct channel and payload", async () => {
      await api.setDialogMode(true);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith("ui:set-dialog-mode", { isOpen: true });
    });
    ```

- [x] **Step 4.2: Add to preload script**
  - File: `src/preload/index.ts`
  - Add to api object:
    ```typescript
    setDialogMode: (isOpen: boolean): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.UI_SET_DIALOG_MODE, { isOpen }),
    ```

- [x] **Step 4.3: Update type definitions**
  - File: `src/shared/electron-api.d.ts`
  - Add to `Api` interface:
    ```typescript
    setDialogMode(isOpen: boolean): Promise<void>;
    ```

### Step 5: Update Renderer API Layer

- [x] **Step 5.1: Update API re-exports**
  - File: `src/renderer/lib/api/index.ts`
  - The `setDialogMode` function should be automatically available since we export `window.api`
  - Verify it's included in the exports

- [x] **Step 5.2: Add mock for tests**
  - File: `src/renderer/lib/api/index.ts` (or test setup)
  - Ensure `setDialogMode` is included in the mock API

### Step 6: Integrate with App.svelte

- [x] **Step 6.1: Write integration test for dialog mode effect**
  - File: `src/renderer/lib/integration.test.ts`
  - Add test:

    ```typescript
    describe("dialog z-order integration", () => {
      it("calls api.setDialogMode(true) when dialog opens", async () => {
        render(App);

        // Open create dialog
        openCreateDialog("/path/to/project", "trigger-id");
        await tick();

        expect(mockApi.setDialogMode).toHaveBeenCalledWith(true);
      });

      it("calls api.setDialogMode(false) when dialog closes", async () => {
        render(App);
        openCreateDialog("/path/to/project", "trigger-id");
        await tick();
        mockApi.setDialogMode.mockClear();

        closeDialog();
        await tick();

        expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      });

      it("handles api.setDialogMode failure gracefully", async () => {
        mockApi.setDialogMode.mockRejectedValue(new Error("IPC failed"));
        render(App);

        // Should not throw
        openCreateDialog("/path/to/project", "trigger-id");
        await tick();

        // Dialog should still open in UI
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });
    ```

- [x] **Step 6.2: Add $effect to App.svelte**
  - File: `src/renderer/App.svelte`
  - Add effect to sync dialog state with z-order:
    ```typescript
    // Sync dialog state with main process z-order
    $effect(() => {
      const isDialogOpen = dialogState.value.type !== "closed";
      void api.setDialogMode(isDialogOpen);
    });
    ```
  - Import `api` from `$lib/api` if not already imported

### Step 7: Update Existing Tests

- [x] **Step 7.1: Update view-manager tests for new view ordering**
  - File: `src/main/managers/view-manager.test.ts`
  - Update any tests that verify workspace views are added at index 0
  - They should now be added without index (at end)

- [x] **Step 7.2: Update integration tests to mock setDialogMode**
  - File: `src/renderer/lib/integration.test.ts`
  - Ensure `mockApi.setDialogMode` is defined in the mock

- [x] **Step 7.3: Update App.test.ts to mock setDialogMode**
  - File: `src/renderer/App.test.ts`
  - Add `setDialogMode` to the mock API

## Testing Strategy

### Unit Tests

| Test Case                     | Description              | Assertion                                   | File                    |
| ----------------------------- | ------------------------ | ------------------------------------------- | ----------------------- |
| setDialogMode true            | Moves UI to top          | `addChildView(uiView)` called without index | `view-manager.test.ts`  |
| setDialogMode false           | Moves UI to bottom       | `addChildView(uiView, 0)` called            | `view-manager.test.ts`  |
| setDialogMode idempotent      | Multiple calls safe      | No errors, both calls succeed               | `view-manager.test.ts`  |
| setDialogMode destroyed       | Window destroyed         | No throw, early return                      | `view-manager.test.ts`  |
| setDialogMode with workspaces | Multiple workspace views | Workspaces unaffected                       | `view-manager.test.ts`  |
| IPC handler true              | Calls viewManager        | `setDialogMode(true)` called                | `handlers.test.ts`      |
| IPC handler false             | Calls viewManager        | `setDialogMode(false)` called               | `handlers.test.ts`      |
| IPC validation                | Rejects invalid payload  | ValidationError thrown                      | `handlers.test.ts`      |
| preload                       | Exposes setDialogMode    | `invoke` called with correct args           | `preload/index.test.ts` |
| App effect                    | Syncs dialog state       | `setDialogMode` called on state change      | `integration.test.ts`   |

### Integration Tests

| Test Case         | Description                                      | File                  |
| ----------------- | ------------------------------------------------ | --------------------- |
| Dialog open flow  | dialog store → $effect → api → mock verification | `integration.test.ts` |
| Dialog close flow | closeDialog → $effect → api.setDialogMode(false) | `integration.test.ts` |
| API failure       | setDialogMode rejects, dialog still opens        | `integration.test.ts` |

### Manual Testing Checklist

- [ ] Open project with workspaces
- [ ] Click workspace to switch - VS Code view responds
- [ ] Type in VS Code - keyboard works
- [ ] Click [+] to open create dialog
- [ ] Dialog appears centered over entire window (not just sidebar)
- [ ] Dialog has semi-transparent dark overlay covering workspace
- [ ] Click outside dialog (on darkened overlay) - dialog closes
- [ ] Press Escape - dialog closes
- [ ] After dialog closes, focus returns to trigger element
- [ ] After dialog closes, VS Code view is interactive again
- [ ] Click workspace [×] to open remove dialog
- [ ] Remove dialog appears over entire window
- [ ] Confirm removal works correctly
- [ ] After removal, VS Code view is interactive
- [ ] Test rapid open/close (open, close, open quickly) - no errors
- [ ] Test keyboard in VS Code after dialog closes - still works
- [ ] Test dialog during workspace loading (code-server starting)
- [ ] Test minimize/maximize window with dialog open - stays centered

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                         |
| ---------------------- | ------------------------------------------------------------------------ |
| `docs/ARCHITECTURE.md` | Add section about dialog z-order management and view ordering invariants |
| `AGENTS.md`            | Document fire-and-forget IPC pattern for UI state changes                |

### Documentation Content

**For docs/ARCHITECTURE.md** - Add under Frontend section:

```markdown
### Dialog Overlay Mode

When a modal dialog is open, the UI layer's z-order is changed to overlay workspace views:

- **Normal mode**: UI layer at index 0 (behind), workspace views on top
- **Dialog mode**: UI layer at last index (on top), receives all events

This is triggered by a reactive `$effect` in App.svelte that watches `dialogState` and calls `api.setDialogMode(isOpen)`. The main process ViewManager handles the z-order swap using `contentView.addChildView()` reordering.
```

**For AGENTS.md** - Add new section:

````markdown
### IPC Patterns

**Fire-and-Forget IPC**: For UI state changes that cannot fail (like z-order swapping), use the `void` operator to call IPC without awaiting:

```typescript
void api.setDialogMode(true); // Intentionally not awaited
```
````

This pattern is used when:

1. The operation cannot meaningfully fail
2. Immediate UI response is more important than confirmation
3. The renderer should not block on the main process

```

## Definition of Done

- [ ] All implementation steps complete
- [ ] Step 0 reverts verified working (workspace view visible)
- [ ] `pnpm validate:fix` passes
- [ ] All unit tests pass (including new setDialogMode tests)
- [ ] All integration tests pass
- [ ] Manual testing checklist complete
- [ ] Documentation updated (ARCHITECTURE.md, AGENTS.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
```
