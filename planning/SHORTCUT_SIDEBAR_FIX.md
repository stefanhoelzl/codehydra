---
status: COMPLETED
last_updated: 2025-12-21
reviewers:
  - review-ui
  - review-typescript
  - review-arch
  - review-testing
  - review-docs
---

# SHORTCUT_SIDEBAR_FIX

## Overview

- **Problem**: Alt+X shortcut mode activation does not work when the mouse hovers over the expanded sidebar. The shortcut is silently blocked because sidebar hover sets mode to `"dialog"`, and `ShortcutController` explicitly blocks Alt+X when mode is `"dialog"`.
- **Solution**: Introduce a new UI mode `"hover"` that is distinct from `"dialog"`. This allows sidebar hover to use `"hover"` mode (Alt+X allowed) while actual dialogs use `"dialog"` mode (Alt+X blocked).
- **Risks**:
  - API/IPC interface change (adding new mode value) - requires coordinated updates across shared types, main process, and renderer. **Per AGENTS.md rules, this requires explicit user approval.**
  - Existing code that checks `mode === "dialog"` may need review (see Audit Results below)
- **Alternatives Considered**:
  - **Pass dialog state to main process**: Would require additional IPC calls and state synchronization. More complex than adding a new mode.
  - **Remove the dialog block in ShortcutController**: Would allow Alt+X during actual dialogs, which could cause confusing UX when dialog has focus trap.

## Audit Results

Codebase audit identified the following locations that must be updated:

| File                                | Line | Code                                                        | Required Change                                                |
| ----------------------------------- | ---- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `src/main/ipc/api-handlers.ts`      | 94   | `VALID_UI_MODES = ["workspace", "dialog", "shortcut"]`      | Add `"hover"` - runtime validation will reject without this    |
| `src/main/managers/view-manager.ts` | 549  | `if (this.mode === "dialog" \|\| this.mode === "shortcut")` | Add `"hover"` - maintains UI z-order during workspace switches |

**Note**: `ShortcutController` line 211 (`if (currentMode === "dialog")`) requires NO changes - this is correct behavior that blocks only `"dialog"` mode, allowing `"hover"` to work.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UI Mode Flow (After Fix)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Renderer (ui-mode.svelte.ts)              Main Process                     │
│  ┌─────────────────────────────┐           ┌──────────────────────────────┐ │
│  │ computeDesiredMode()        │           │ ShortcutController           │ │
│  │                             │           │                              │ │
│  │ if shortcut → "shortcut"    │  IPC      │ if mode === "dialog"         │ │
│  │ if dialogOpen → "dialog"    │ ────────► │   → BLOCK Alt+X              │ │
│  │ if sidebarHover → "hover"   │           │                              │ │
│  │ else → "workspace"          │           │ if mode === "hover"          │ │
│  │                             │           │   → ALLOW Alt+X ✓            │ │
│  └─────────────────────────────┘           │                              │ │
│                                            └──────────────────────────────┘ │
│                                                                             │
│  Priority: shortcut > dialog > hover > workspace                            │
│                                                                             │
│  Note: Existing $effect in ui-mode.svelte.ts automatically communicates     │
│  the new "hover" mode via api.ui.setMode() - no IPC wiring changes needed.  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## UI Design

No visual changes. This is a behavioral fix only.

### User Interactions

- **Before fix**: Hovering sidebar, pressing Alt+X → nothing happens (broken)
- **After fix**: Hovering sidebar, pressing Alt+X → shortcut mode activates (working)

## Implementation Steps

- [x] **Step 1: Update UIMode type in shared/ipc.ts**
  - Add `"hover"` to the `UIMode` union type
  - Update JSDoc comment to document all 4 modes:
    ```typescript
    /**
     * UI mode for the application.
     * - "workspace": Normal mode, workspace view has focus, UI behind workspace
     * - "shortcut": Shortcut mode active, UI on top, shows keyboard hints
     * - "dialog": Dialog open, UI on top, dialog has focus (blocks Alt+X)
     * - "hover": UI overlay active (sidebar hover), UI on top, no focus change (allows Alt+X)
     */
    export type UIMode = "workspace" | "dialog" | "shortcut" | "hover";
    ```
  - Files affected: `src/shared/ipc.ts`
  - Test criteria: TypeScript compiles without errors

- [x] **Step 2: Update IPC validation in api-handlers.ts**
  - Add `"hover"` to the `VALID_UI_MODES` array (line 94):
    ```typescript
    const VALID_UI_MODES: readonly UIMode[] = ["workspace", "dialog", "shortcut", "hover"];
    ```
  - Files affected: `src/main/ipc/api-handlers.ts`
  - Test criteria: IPC handler accepts "hover" mode without validation error

- [x] **Step 3: Update computeDesiredMode() in ui-mode.svelte.ts**
  - Change logic with explicit if-else precedence:
    ```typescript
    if (modeFromMain === "shortcut") return "shortcut";
    if (dialogOpen) return "dialog";
    if (sidebarExpanded) return "hover";
    return "workspace";
    ```
  - Update the priority comment from `shortcut > (dialog | sidebarExpanded) > workspace` to `shortcut > dialog > hover > workspace`
  - Full condition: return `"hover"` when `sidebarExpanded === true AND dialogOpen === false AND modeFromMain !== "shortcut"`
  - Files affected: `src/renderer/lib/stores/ui-mode.svelte.ts`
  - Test criteria: Unit tests pass with new mode value

- [x] **Step 4: Add "hover" case in ViewManager.setMode()**
  - Use fallthrough pattern with shared behavior:
    ```typescript
    case "hover":
    case "dialog":
      // Move UI to top (adding existing child moves it to end = top)
      contentView.addChildView(this.uiView);
      // Do NOT change focus - hover/dialog component will manage focus
      break;
    ```
  - Add exhaustive switch default for future mode additions:
    ```typescript
    default: {
      const _exhaustive: never = newMode;
      this.logger.warn("Unhandled UI mode", { mode: _exhaustive });
    }
    ```
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: Unit tests pass, mode changes work correctly

- [x] **Step 5: Update z-order maintenance check in ViewManager**
  - Update line 549 to include "hover":
    ```typescript
    if (this.mode === "dialog" || this.mode === "shortcut" || this.mode === "hover") {
    ```
  - Files affected: `src/main/managers/view-manager.ts`
  - Test criteria: UI stays on top when switching workspaces while sidebar is hovered

- [x] **Step 6: Update ARCHITECTURE.md documentation**
  - Add `"hover"` mode to the UI Mode System section mode table:
    | Mode        | UI Z-Order | Focus          | Description                              |
    | ----------- | ---------- | -------------- | ---------------------------------------- |
    | `workspace` | Behind     | Workspace view | Normal editing mode                      |
    | `shortcut`  | On top     | UI layer       | Shortcut overlay visible                 |
    | `dialog`    | On top     | Dialog (no-op) | Modal dialog open (blocks Alt+X)         |
    | `hover`     | On top     | No change      | Sidebar expanded on hover (allows Alt+X) |
  - Add mode transitions:
    - Sidebar hover starts → `workspace → hover`
    - Sidebar hover stops → `hover → workspace`
    - Dialog opens while hovering → `hover → dialog`
  - Update Keyboard Capture System section to document that Alt+X is blocked when `mode === "dialog"` but allowed for all other modes including `"hover"`
  - Files affected: `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects new behavior

- [x] **Step 7: Update USER_INTERFACE.md documentation**
  - Review Sidebar Expansion Behavior section
  - No changes likely needed (behavior change is internal to mode naming)
  - Files affected: `docs/USER_INTERFACE.md`
  - Test criteria: Documentation is consistent with implementation

- [x] **Step 8: Update unit tests**
  - **src/shared/ipc.test.ts**: Add test for `"hover"` mode value
  - **src/renderer/lib/stores/ui-mode.svelte.test.ts**:
    - Add parameterized tests using `test.each()` for all mode priority combinations:
      - `computeDesiredMode returns "shortcut" when modeFromMain is shortcut`
      - `computeDesiredMode returns "dialog" when dialogOpen is true`
      - `computeDesiredMode returns "hover" when sidebarExpanded is true and dialogOpen is false`
      - `computeDesiredMode returns "workspace" when all flags are false`
      - `computeDesiredMode returns "dialog" when both dialogOpen AND sidebarExpanded are true` (priority test)
      - `computeDesiredMode returns "shortcut" when shortcut AND dialog AND hover flags all true` (priority test)
  - **src/main/managers/view-manager.test.ts**:
    - Add test for `setMode("hover")` moves UI to top without focus change
    - Add test for z-order maintenance with hover mode during workspace switch
  - **src/main/shortcut-controller.test.ts**:
    - Add test verifying Alt+X activates shortcut mode when mode is `"hover"`
    - Verify existing test for Alt+X blocked when mode is `"dialog"` still passes
  - **src/main/ipc/api-handlers.test.ts**:
    - Add test for `api:ui:setMode` handler accepts `"hover"` mode
  - Files affected:
    - `src/shared/ipc.test.ts`
    - `src/renderer/lib/stores/ui-mode.svelte.test.ts`
    - `src/main/managers/view-manager.test.ts`
    - `src/main/shortcut-controller.test.ts`
    - `src/main/ipc/api-handlers.test.ts`
  - Test criteria: All tests pass

- [x] **Step 9: Add integration test for IPC flow**
  - Add test in `src/main/shortcut-controller.integration.test.ts` that verifies:
    1. Renderer can send `"hover"` mode via IPC
    2. Main process receives and accepts it
    3. Alt+X is allowed in hover mode but blocked in dialog mode
  - Files affected: `src/main/shortcut-controller.integration.test.ts`
  - Test criteria: Integration test passes

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                                                 | Description                   | File                          |
| ------------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| `UIMode type accepts "hover" value`                                       | Verify type includes new mode | `ipc.test.ts`                 |
| `computeDesiredMode returns "shortcut" when modeFromMain is shortcut`     | Base case                     | `ui-mode.svelte.test.ts`      |
| `computeDesiredMode returns "dialog" when dialogOpen is true`             | Base case                     | `ui-mode.svelte.test.ts`      |
| `computeDesiredMode returns "hover" when sidebarExpanded only`            | New mode logic                | `ui-mode.svelte.test.ts`      |
| `computeDesiredMode returns "workspace" when all flags false`             | Base case                     | `ui-mode.svelte.test.ts`      |
| `computeDesiredMode returns "dialog" when dialogOpen AND sidebarExpanded` | Priority: dialog > hover      | `ui-mode.svelte.test.ts`      |
| `computeDesiredMode returns "shortcut" when all flags true`               | Priority: shortcut > all      | `ui-mode.svelte.test.ts`      |
| `setMode("hover") moves UI to top without focus change`                   | ViewManager behavior          | `view-manager.test.ts`        |
| `workspace switch maintains UI z-order in hover mode`                     | Z-order fix                   | `view-manager.test.ts`        |
| `Alt+X activates shortcut mode when mode is "hover"`                      | ShortcutController allows     | `shortcut-controller.test.ts` |
| `Alt+X is blocked when mode is "dialog"`                                  | Existing behavior preserved   | `shortcut-controller.test.ts` |
| `api:ui:setMode handler accepts "hover" mode`                             | IPC validation                | `api-handlers.test.ts`        |

### Integration Tests

| Test Case                        | Description                                | File                                      |
| -------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `hover mode IPC flow end-to-end` | Renderer → IPC → main → ShortcutController | `shortcut-controller.integration.test.ts` |

### Manual Testing Checklist

- [ ] Open a project with at least one workspace
- [ ] Hover over the sidebar to expand it
- [ ] Press Alt+X while hovering over sidebar
- [ ] Verify shortcut mode activates (overlay appears, workspace numbers shown)
- [ ] Release Alt to exit shortcut mode
- [ ] While sidebar is hovered, switch workspaces using keyboard (verify UI stays on top)
- [ ] Open a dialog (e.g., Create Workspace)
- [ ] Press Alt+X while dialog is open
- [ ] Verify shortcut mode does NOT activate (dialog should block it)
- [ ] Close dialog and verify normal operation

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`   | Add `"hover"` mode to UI Mode System table with description "Sidebar hover, UI on top, no focus change, Alt+X allowed". Add mode transitions. Update Keyboard Capture System section to document Alt+X blocking rules. |
| `docs/USER_INTERFACE.md` | Review Sidebar Expansion Behavior section - likely no changes needed (internal naming change)                                                                                                                          |

### New Documentation Required

None - changes are additions to existing documentation.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
