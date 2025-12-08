---
status: COMPLETED
last_updated: 2025-12-08
reviewers: [review-docs, review-arch, review-ui]
---

# DOCS_UPDATE

## Overview

- **Problem**: The documentation in `docs/ARCHITECTURE.md` and `docs/USER_INTERFACE.md` is outdated. It was written during Phase 0 (documentation setup) and hasn't been updated as implementation progressed through Phases 1-5.
- **Solution**: Update all docs to reflect current implementation state, add missing architecture diagrams from planning documents, remove outdated content, and mark unimplemented features (Phase 6).
- **Risks**:
  - Documentation may drift again as new features are added → Mitigate by updating docs as part of each feature plan
  - Some planning docs have conflicting information → Use source code as source of truth
- **Alternatives Considered**:
  - Complete rewrite of docs → Rejected: too time-consuming, existing structure is good
  - Leave as-is with "outdated" disclaimer → Rejected: docs are actively used by AI agents

## Architecture

```
docs/
├── ARCHITECTURE.md    # System design - NEEDS UPDATE
└── USER_INTERFACE.md  # UI flows, mockups - NEEDS UPDATE

AGENTS.md              # Agent instructions - NEEDS MINOR UPDATE
```

### Key Discrepancies Found

| Category         | Current State                                     | Actual Implementation                               |
| ---------------- | ------------------------------------------------- | --------------------------------------------------- |
| IPC Contract     | "[Placeholder - to be defined in Phase 3]"        | Fully implemented with 12 commands, 7 events        |
| Keyboard capture | Documents dual-capture (globalShortcut + preload) | Uses main-process `before-input-event` only         |
| Preload scripts  | Lists `webview-preload.ts`                        | File doesn't exist (simpler architecture)           |
| Components       | Missing ShortcutOverlay, shortcuts store          | Both implemented                                    |
| OpenCode         | Documented as implemented                         | Not yet implemented (Phase 6)                       |
| Branch display   | Shows `(branch)` in mockups                       | Not implemented, not planned                        |
| O shortcut       | Not documented                                    | Implemented (opens folder picker)                   |
| UI visibility    | Describes bounds-switching for UI layer           | Hybrid: UI uses z-order, workspace views use bounds |
| Remove dialog    | Shows 3-button pattern                            | Uses checkbox + 2-button pattern                    |
| Shortcut events  | N/A                                               | In IpcChannels but not typed in IpcEvents interface |

## Implementation Steps

**Note**: All steps reference sections by header name, not line numbers, to avoid issues when earlier edits shift line positions. Always verify source files match before making changes.

### Step 1: Update docs/ARCHITECTURE.md - Remove Outdated Content

- [x] **Step 1.1: Remove outdated "Keyboard Architecture" and "Preload Scripts" sections**
  - Location: Find section starting with `## Keyboard Architecture` that contains "Dual Capture Strategy"
  - This section documents a `globalShortcut` + preload approach that was never implemented
  - Delete the following content:
    - "## Keyboard Architecture" header
    - "### Dual Capture Strategy" subsection
    - "### Alt Key Handling" subsection
    - "### Preload Scripts" table (the one listing `webview-preload.ts`)
  - **Do NOT delete** the "## Keyboard Capture System" section (which is correct and should remain)
  - After deletion, add a new Preload Scripts subsection under "## Component Architecture" → "### Main Process Components":

    ```markdown
    ### Preload Scripts

    | Script           | Used By  | Purpose                                            |
    | ---------------- | -------- | -------------------------------------------------- |
    | preload/index.ts | UI layer | Expose IPC API for sidebar, dialogs, shortcut mode |

    **Note**: Workspace views intentionally have NO preload script. Keyboard capture is handled via main-process `before-input-event` for simplicity and security.
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/preload/` directory (should only contain `index.ts`)

### Step 2: Update docs/ARCHITECTURE.md - Fix UI Layer State Machine

- [x] **Step 2.1: Update "UI Layer State Machine" section**
  - Location: Find section `### UI Layer State Machine`
  - The current docs incorrectly describe "bounds-based visibility" for the UI layer
  - The actual implementation uses a **hybrid approach**:
    - UI layer: always full-window bounds, visibility controlled by **z-order**
    - Workspace views: visibility controlled by **bounds** (active = content area, inactive = 0x0)
  - Replace the entire section with:

    ```markdown
    ### UI Layer State Machine

    The application uses a **hybrid visibility approach**:

    - **UI layer**: Always has full-window bounds. Visibility controlled by z-order.
    - **Workspace views**: Visibility controlled by bounds (active = content area, inactive = 0x0).

    | State   | UI Z-Order                  | Focus    | Description                  |
    | ------- | --------------------------- | -------- | ---------------------------- |
    | Normal  | Behind workspace views      | VS Code  | User working in editor       |
    | Overlay | In front of workspace views | UI layer | Shortcut mode or dialog open |

    **State transitions:**

    - Normal → Overlay: User activates shortcut mode (Alt+X) or opens dialog
    - Overlay → Normal: User releases Alt, presses Escape, closes dialog, or window loses focus

    **Implementation:**

    - UI transparency: `setBackgroundColor('#00000000')`
    - Z-order front: `contentView.addChildView(view)` (no index = add to end = top)
    - Z-order back: `contentView.addChildView(view, 0)` (index 0 = bottom)
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/main/managers/view-manager.ts`

### Step 3: Update docs/ARCHITECTURE.md - Add View Lifecycle Diagram

- [x] **Step 3.1: Add View Lifecycle diagram**
  - Location: After `### View Management` section, before `### UI Layer State Machine`
  - Add new subsection:

    ```markdown
    ### View Lifecycle
    ```

    View Lifecycle:

    [not created] ──createWorkspaceView()──► [created/hidden]
    │
    │ bounds: (0, 0, 0, 0)
    │
    setActiveWorkspace()
    │
    ▼
    [active/visible]
    │
    │ bounds: (SIDEBAR_WIDTH, 0, w, h)
    │
    setActiveWorkspace(other)
    │
    ▼
    [hidden]
    │
    destroyWorkspaceView()
    │
    ▼
    [destroyed]

    ```

    - **Hidden views** retain their VS Code state (no reload when shown again)
    - **Bounds-based hiding** (0x0) is more efficient than destroying/recreating views
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/main/managers/view-manager.ts`

### Step 4: Update docs/ARCHITECTURE.md - Tables

- [x] **Step 4.1: Update App Services table**
  - Location: Find `### App Services` section
  - Add Status column to indicate implementation state
  - Replace table with:

    ```markdown
    | Service                  | Responsibility                                    | Status      |
    | ------------------------ | ------------------------------------------------- | ----------- |
    | Git Worktree Provider    | Discover worktrees (not main dir), create, remove | Implemented |
    | Code-Server Manager      | Start/stop code-server, port management           | Implemented |
    | Project Store            | Persist open projects across sessions             | Implemented |
    | OpenCode Discovery       | Find running OpenCode instances                   | Phase 6     |
    | OpenCode Status Provider | SSE connections, status aggregation               | Phase 6     |
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/services/` directory

- [x] **Step 4.2: Update Frontend Components table**
  - Location: Find `### Frontend Components` section
  - Add ShortcutOverlay component, update stores list
  - Replace table with:

    ```markdown
    | Component             | Purpose                                              |
    | --------------------- | ---------------------------------------------------- |
    | App                   | Main application component, IPC event handling       |
    | Sidebar               | Project list, workspace list, action buttons         |
    | EmptyState            | Displayed when no projects are open                  |
    | Dialog                | Base dialog component with focus trap, accessibility |
    | CreateWorkspaceDialog | New workspace form with validation, branch selection |
    | RemoveWorkspaceDialog | Confirmation with uncommitted changes warning        |
    | BranchDropdown        | Searchable combobox for branch selection             |
    | ShortcutOverlay       | Keyboard shortcut hints (shown during shortcut mode) |
    | Stores                | projects, dialogs, shortcuts (Svelte 5 runes)        |
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/renderer/lib/components/` and `src/renderer/lib/stores/`

### Step 5: Update docs/ARCHITECTURE.md - Expand Dialog Overlay Mode

- [x] **Step 5.1: Expand "Dialog Overlay Mode" section with z-order diagram**
  - Location: Find `### Dialog Overlay Mode` section
  - Replace entire section with:

    ```markdown
    ### Dialog Overlay Mode

    When a modal dialog or shortcut mode is active, the UI layer's z-order is changed to overlay workspace views:
    ```

    NORMAL STATE (no dialog, no shortcut mode):
    ┌─────────────────────────────────────────────────────────────────────┐
    │ children[0]: UI Layer │ children[N]: Workspace Views │
    │ z-order: BEHIND │ z-order: ON TOP │
    │ │ │
    │ Sidebar receives events │ Workspace receives events │
    └──────────────────────────────┴─────────────────────────────────────┘

    DIALOG/SHORTCUT STATE:
    ┌─────────────────────────────────────────────────────────────────────┐
    │ children[0..N-1]: Workspace Views (z-order: BEHIND) │
    ├─────────────────────────────────────────────────────────────────────┤
    │ children[N]: UI Layer (z-order: ON TOP) │
    │ ┌─────────────────────────────────────────────────────────────────┐ │
    │ │ Dialog or Shortcut Overlay │ │
    │ │ (receives all keyboard/mouse events) │ │
    │ └─────────────────────────────────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────────┘

    ```

    This is triggered by:
    - **Dialogs**: A reactive `$effect` in App.svelte watches `dialogState` and calls `api.setDialogMode(isOpen)`
    - **Shortcut mode**: `ShortcutController` calls `setDialogMode(true)` when Alt+X detected

    The main process ViewManager handles the z-order swap using `contentView.addChildView()` reordering.
    ```

  - Files affected: `docs/ARCHITECTURE.md`

### Step 6: Update docs/ARCHITECTURE.md - Keyboard Capture System

- [x] **Step 6.1: Add ShortcutController State Machine diagram and race condition docs**
  - Location: Find `## Keyboard Capture System` section, after the "Key Files" table
  - Add new subsections:

    ```markdown
    ### ShortcutController State Machine
    ```

                                  ┌──────────┐
                  ┌───────────────│  NORMAL  │◄────────────────────────────────┐
                  │               └────┬─────┘                                 │
                  │                    │                                       │
                  │ Alt up             │ Alt down                              │
                  │ (suppress)         │ (preventDefault)                      │
                  │                    ▼                                       │
                  │            ┌─────────────┐                                 │
                  │            │ ALT_WAITING │                                 │
                  │            └──────┬──────┘                                 │
                  │                   │                                        │
                  │     ┌─────────────┼─────────────┐                          │
                  │     │             │             │                          │
                  │  Alt up      non-X key       X down                        │
                  │  (suppress)  (let through)      │                          │
                  │     │             │             ▼                          │
                  │     │             │      • preventDefault                  │
                  │     │             │      • setDialogMode(true)             │
                  │     │             │      • focusUI()                       │
                  │     │             │      • Emit ENABLE to UI               │
                  │     │             │             │                          │
                  └─────┴─────────────┴─────────────┘                          │
                                                                               │
                  Main process returns to NORMAL immediately ──────────────────┘

    ```

    **Note**: Alt keyup is ALWAYS suppressed (in both states) so VS Code never sees Alt-only key events.

    ### Race Condition Handling

    There is a race condition where the user can release Alt faster than focus switches to the UI layer:

    1. User presses Alt+X → ShortcutController activates mode, calls `focusUI()`
    2. User releases Alt VERY QUICKLY (before focus actually switches)
    3. Workspace view still has focus, catches the Alt keyup via `before-input-event`
    4. **Problem**: UI layer never sees Alt keyup, thinks shortcut mode is still active

    **Solution**: Main process tracks `shortcutModeActive` flag. On Alt keyup, if the flag was true:
    - Reset flag to false
    - Send `shortcut:disable` event to UI
    - UI receives event and resets its state

    This ensures the UI never gets stuck in shortcut mode.
    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/main/shortcut-controller.ts`

### Step 7: Update docs/ARCHITECTURE.md - OpenCode & IPC

- [x] **Step 7.1: Add Phase 6 note to OpenCode Integration**
  - Location: Find `## OpenCode Integration` section
  - Add blockquote note at the very start of the section (after the heading):

    ```markdown
    ## OpenCode Integration

    > **Phase 6**: OpenCode integration is not yet implemented. The following describes the planned design.
    ```

  - Files affected: `docs/ARCHITECTURE.md`

- [x] **Step 7.2: Replace IPC Contract placeholder with actual content**
  - Location: Find `## IPC Contract` section
  - Replace entire section including the placeholder text with:

    ```markdown
    ## IPC Contract

    All IPC channels are defined in `src/shared/ipc.ts` with TypeScript types for compile-time safety.

    ### Commands (renderer → main)

    | Channel                     | Payload                             | Response            | Description                       |
    | --------------------------- | ----------------------------------- | ------------------- | --------------------------------- |
    | `project:open`              | `{ path: string }`                  | `Project`           | Open project, discover workspaces |
    | `project:close`             | `{ path: string }`                  | `void`              | Close project, destroy views      |
    | `project:list`              | `void`                              | `Project[]`         | List all open projects            |
    | `project:select-folder`     | `void`                              | `string \| null`    | Show folder picker dialog         |
    | `workspace:create`          | `{ projectPath, name, baseBranch }` | `Workspace`         | Create workspace, create view     |
    | `workspace:remove`          | `{ workspacePath, deleteBranch }`   | `RemovalResult`     | Remove workspace, destroy view    |
    | `workspace:switch`          | `{ workspacePath }`                 | `void`              | Switch active workspace           |
    | `workspace:list-bases`      | `{ projectPath }`                   | `BaseInfo[]`        | List available branches           |
    | `workspace:update-bases`    | `{ projectPath }`                   | `UpdateBasesResult` | Fetch from remotes                |
    | `workspace:is-dirty`        | `{ workspacePath }`                 | `boolean`           | Check for uncommitted changes     |
    | `ui:set-dialog-mode`        | `{ isOpen: boolean }`               | `void`              | Swap UI layer z-order             |
    | `ui:focus-active-workspace` | `void`                              | `void`              | Return focus to VS Code           |

    ### Events (main → renderer)

    | Channel              | Payload                                          | Description                               |
    | -------------------- | ------------------------------------------------ | ----------------------------------------- |
    | `project:opened`     | `{ project: Project }`                           | Project was opened                        |
    | `project:closed`     | `{ path: string }`                               | Project was closed                        |
    | `workspace:created`  | `{ projectPath: string, workspace: Workspace }`  | Workspace was created                     |
    | `workspace:removed`  | `{ projectPath: string, workspacePath: string }` | Workspace was removed                     |
    | `workspace:switched` | `{ workspacePath: string }`                      | Active workspace changed                  |
    | `shortcut:enable`    | `void`                                           | Shortcut mode activated                   |
    | `shortcut:disable`   | `void`                                           | Shortcut mode deactivated (race recovery) |

    **Note**: `shortcut:enable` and `shortcut:disable` are defined as channel constants but are not typed in the `IpcEvents` interface (they use simple void payloads).

    ### IPC Data Flow
    ```

    ┌─────────────┐ IPC invoke ┌─────────────┐ direct call ┌─────────────┐
    │ Renderer │ ──────────────────► │ Main │ ──────────────────► │ Services │
    │ (Svelte) │ │ (handlers) │ │ (Node.js) │
    │ │ ◄────────────────── │ │ ◄────────────────── │ │
    └─────────────┘ IPC response/ └─────────────┘ return value/ └─────────────┘
    events throw error

    ```

    ```

  - Files affected: `docs/ARCHITECTURE.md`
  - Reference: Verify against `src/shared/ipc.ts`

### Step 8: Update docs/USER_INTERFACE.md - Keyboard Shortcuts

- [x] **Step 8.1: Add O shortcut to keyboard shortcuts table**
  - Location: Find the "Shortcuts (while Alt held after Alt+X)" table
  - Add new row after the `Alt+0` row:

    ```markdown
    | Alt+O | Open project (folder picker) |
    ```

  - Files affected: `docs/USER_INTERFACE.md`
  - Reference: Verify against `src/shared/shortcuts.ts` (PROJECT_KEYS constant)

- [x] **Step 8.2: Update shortcut overlay mockup with conditional hints**
  - Location: Find the "Shortcut Mode UI" section with the overlay mockup
  - Replace the overlay mockup with:

    ```markdown
    **Overlay (bottom center):**
    ```

    ┌───────────────────────────────────────────────────────┐
    │ ↑↓ Navigate ⏎ New ⌫ Del 1-0 Jump O Open │
    └───────────────────────────────────────────────────────┘

    ```

    **Note**: Some hints are conditionally hidden based on application state:
    - "↑↓ Navigate" and "1-0 Jump" only visible when more than 1 workspace exists
    - "⏎ New" only visible when there's an active project
    - "⌫ Del" only visible when there's an active workspace
    - "O Open" is always visible
    ```

  - Files affected: `docs/USER_INTERFACE.md`
  - Reference: Verify against `src/renderer/lib/components/ShortcutOverlay.svelte`

- [x] **Step 8.3: Document shortcut mode sidebar indicators**
  - Location: Find the "Shortcut mode active" sidebar mockup
  - Update the mockup and add explanation:

    ```markdown
    **Shortcut mode active:**
    ```

    │ 📁 my-project [+][×] │
    │ 1 └─ 🌿 feature-auth [×] │ ← Index numbers appear
    │ 2 └─ 🌿 bugfix-123 [×] │
    │ 📁 other-project [+][×] │
    │ 3 └─ 🌿 experiment [×] │
    │ · └─ 🌿 eleventh-ws [×] │ ← Dot for workspaces 11+
    │ │
    │ O [Open Project] │ ← "O" prefix appears

    ```

    Index display rules:
    - Workspaces 1-9: Show digit (1-9)
    - Workspace 10: Show "0"
    - Workspaces 11+: Show "·" (dimmed dot, no keyboard shortcut)
    ```

  - Files affected: `docs/USER_INTERFACE.md`
  - Reference: Verify against `src/renderer/lib/components/Sidebar.svelte`

### Step 9: Update docs/USER_INTERFACE.md - Remove Branch Display

- [x] **Step 9.1: Remove branch display from all workspace mockups**
  - Location: Throughout the entire document
  - Find and update all workspace mockup patterns:
    - `🌿 feature (feat)` → `🌿 feature`
    - `🌿 bugfix (fix)` → `🌿 bugfix`
    - `🌿 name (branch)` → `🌿 name`
    - `(feat)`, `(fix)`, `(branch)` → remove these patterns
  - Keep workspace names without branch suffixes
  - Files affected: `docs/USER_INTERFACE.md`
  - Reference: Verify against `src/renderer/lib/components/Sidebar.svelte` (does not display branch)

### Step 10: Update docs/USER_INTERFACE.md - Remove Workspace Dialog

- [x] **Step 10.1: Update Remove Workspace dialog mockups and flow**
  - Location: Find "Removing a Workspace" section
  - Replace the dialog mockups with checkbox + 2-button pattern:

    ```markdown
    **Confirmation dialog (clean):**
    ```

    ┌────────────────────────────────────────────┐
    │ Remove Workspace │
    │ │
    │ Remove workspace "feature-auth"? │
    │ │
    │ ☑ Delete branch │
    │ │
    │ [Cancel] [Remove] │
    └────────────────────────────────────────────┘

    ```

    **Confirmation dialog (checking state):**

    ```

    ┌────────────────────────────────────────────┐
    │ Remove Workspace │
    │ │
    │ Remove workspace "feature-auth"? │
    │ │
    │ Checking for uncommitted changes... │
    │ │
    │ ☐ Delete branch │
    │ │
    │ [Cancel] [Remove] │
    │ ~~~~~~~~ │ ← Disabled
    └────────────────────────────────────────────┘

    ```

    **Confirmation dialog (uncommitted changes warning):**

    ```

    ┌────────────────────────────────────────────┐
    │ Remove Workspace │
    │ │
    │ Remove workspace "feature-auth"? │
    │ │
    │ ┌────────────────────────────────────┐ │
    │ │ ⚠ This workspace has uncommitted │ │
    │ │ changes that will be lost. │ │
    │ └────────────────────────────────────┘ │
    │ │
    │ ☑ Delete branch │
    │ │
    │ [Cancel] [Remove] │
    └────────────────────────────────────────────┘

    ```

    **Removing state:**

    ```

    │ [Cancel] [Removing...]│
    │ ~~~~~~~~ ~~~~~~~~~~~~ │ ← Both disabled

    ```

    ```

  - Also update the flow description to match:

    ```markdown
    5. Choose action:
       - **Cancel**: Close dialog, no action
       - **Remove** (with "Delete branch" checked): Remove worktree AND delete git branch
       - **Remove** (with "Delete branch" unchecked): Remove worktree only, keep branch
    ```

  - Files affected: `docs/USER_INTERFACE.md`
  - Reference: Verify against `src/renderer/lib/components/RemoveWorkspaceDialog.svelte`

### Step 11: Update docs/USER_INTERFACE.md - Agent Status

- [x] **Step 11.1: Add Phase 6 note to Agent Status Monitoring section**
  - Location: Find "Agent Status Monitoring" section (or similar heading about status indicators)
  - Add blockquote note at the start of the section:

    ```markdown
    ### Agent Status Monitoring

    > **Phase 6**: Agent status monitoring is not yet implemented. The following describes the planned design.
    ```

  - Files affected: `docs/USER_INTERFACE.md`

### Step 12: Update AGENTS.md

- [x] **Step 12.1: Expand Shortcut Mode in Key Concepts table**
  - Location: Find the "Key Concepts" table
  - Update the Shortcut Mode row to include all shortcuts:

    ```markdown
    | Shortcut Mode | Keyboard-driven navigation activated by Alt+X, shows overlay with workspace actions (↑↓ navigate, 1-0 jump, Enter new, Delete remove, O open project) |
    ```

  - Files affected: `AGENTS.md`

### Step 13: Validation

- [x] **Step 13.1: Verify changes against source files**
  - Run verification commands:

    ```bash
    # Verify no placeholder text remains
    grep -r "Placeholder" docs/

    # Verify no references to non-existent files
    grep -r "webview-preload" docs/

    # Verify no dual-capture references
    grep -r "globalShortcut" docs/

    # Verify branch patterns removed
    grep -E "\(feat\)|\(fix\)|\(branch\)" docs/USER_INTERFACE.md
    ```

- [x] **Step 13.2: Run validation**
  - Run `pnpm validate:fix` to ensure no build/lint issues
  - Files affected: None (validation only)

## Testing Strategy

### Manual Verification

| Check                        | Criteria                                                |
| ---------------------------- | ------------------------------------------------------- |
| ARCHITECTURE.md diagrams     | All diagrams render correctly in markdown preview       |
| ARCHITECTURE.md IPC Contract | Matches `src/shared/ipc.ts` definitions                 |
| ARCHITECTURE.md components   | Matches actual files in `src/renderer/lib/components/`  |
| ARCHITECTURE.md services     | Status column accurately reflects implementation        |
| ARCHITECTURE.md keyboard     | State machine matches `src/main/shortcut-controller.ts` |
| USER_INTERFACE.md shortcuts  | All shortcuts documented, including O                   |
| USER_INTERFACE.md mockups    | No branch names in parentheses                          |
| USER_INTERFACE.md dialogs    | Remove dialog shows checkbox pattern with states        |
| USER_INTERFACE.md overlay    | Conditional visibility documented                       |
| USER_INTERFACE.md sidebar    | Index numbers documented for shortcut mode              |
| AGENTS.md                    | Shortcut Mode description includes O                    |
| Cross-references             | No broken links between docs                            |

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

This plan IS the documentation update. No additional docs needed.

## Definition of Done

- [ ] All implementation steps complete
- [ ] docs/ARCHITECTURE.md has all architecture diagrams (View Lifecycle, Z-Order, State Machine)
- [ ] docs/ARCHITECTURE.md IPC Contract section populated with all channels
- [ ] docs/ARCHITECTURE.md outdated dual-capture section removed
- [ ] docs/ARCHITECTURE.md hybrid visibility approach documented
- [ ] docs/ARCHITECTURE.md race condition handling documented
- [ ] docs/ARCHITECTURE.md WebContentsView security note added
- [ ] docs/USER_INTERFACE.md includes O shortcut
- [ ] docs/USER_INTERFACE.md branch display removed from all mockups
- [ ] docs/USER_INTERFACE.md Remove dialog shows checkbox + states
- [ ] docs/USER_INTERFACE.md overlay conditional visibility documented
- [ ] docs/USER_INTERFACE.md sidebar index numbers documented
- [ ] AGENTS.md Key Concepts updated with full shortcut list
- [ ] `pnpm validate:fix` passes
- [ ] Manual verification checklist complete
