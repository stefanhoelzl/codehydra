---
status: COMPLETED
last_updated: 2025-12-08
reviewers: [review-ui, review-typescript, review-electron, review-testing, review-docs]
depends_on: KEYBOARD_ACTIVATION
---

# KEYBOARD_ACTIONS

## Overview

- **Problem**: Shortcut mode activates and shows overlay, but pressing action keys does nothing.
- **Solution**: Implement action handlers for navigation, workspace jumping, dialog opening, and project opening. Add sidebar index numbers. Conditionally hide unavailable actions from overlay.
- **Risks**:
  - Global workspace indexing across projects may be confusing
  - Edge cases: no workspaces, out-of-range indices, no active project/workspace
  - Rapid key presses could cause IPC race conditions
- **Alternatives Considered**:
  - Per-project indexing - rejected because requires knowing which project is "active"

**Depends on**: `KEYBOARD_ACTIVATION` must be completed first.

## User Interactions

**Note**: All shortcuts below work WITHIN shortcut mode. User presses Alt+X to enter shortcut mode, then while holding Alt, presses action keys.

| Shortcut              | Action                                 |
| --------------------- | -------------------------------------- |
| Alt+X                 | Enter shortcut mode (already works)    |
| Release Alt           | Exit shortcut mode (already works)     |
| ↑ (while in mode)     | Navigate to previous workspace (wraps) |
| ↓ (while in mode)     | Navigate to next workspace (wraps)     |
| 1-9 (while in mode)   | Jump to workspace at index 1-9         |
| 0 (while in mode)     | Jump to workspace at index 10          |
| Enter (while in mode) | Open create workspace dialog           |
| Delete/Backspace      | Open remove workspace dialog           |
| O (while in mode)     | Open project (folder picker)           |

### Edge Case Behavior

| Condition           | Affected Actions | Behavior                   |
| ------------------- | ---------------- | -------------------------- |
| No workspaces       | ↑↓, 1-0, Delete  | No-op, hidden from overlay |
| ≤1 workspace        | ↑↓               | No-op, hidden from overlay |
| No active project   | Enter (create)   | No-op, hidden from overlay |
| No active workspace | Delete (remove)  | No-op, hidden from overlay |
| Index out of range  | 1-0              | No-op                      |

## UI Design

### Sidebar with Index Numbers (only in shortcut mode)

```
Normal:                          Shortcut Mode:
┌───────────────────────┐        ┌───────────────────────┐
│ project-a        [+][×]│        │ project-a        [+][×]│
│   └─ feature       [×] │        │   1 feature        [×] │
│   └─ bugfix        [×] │        │   2 bugfix         [×] │
│ project-b        [+][×]│        │ project-b        [+][×]│
│   └─ experiment    [×] │        │   3 experiment     [×] │
│   └─ (11th ws)     [×] │        │   · (11th ws)      [×] │  ← dimmed dot for 11+
│                       │        │                       │
│ [Open Project]        │        │ [O Open Project]      │
└───────────────────────┘        └───────────────────────┘

Index numbering: 1-9, then 0 for 10th. Workspaces 11+ show dimmed dot (no shortcut).
Open Project button shows "O" prefix during shortcut mode.
```

### ShortcutOverlay (conditional display)

```
Full overlay (multiple workspaces, active project & workspace):
┌─────────────────────────────────────────────────────┐
│  ↑↓ Navigate   ⏎ New   ⌫ Del   1-0 Jump   O Open   │
└─────────────────────────────────────────────────────┘

Minimal overlay (no workspaces, no active context):
┌─────────────┐
│   O Open    │
└─────────────┘

Note: Use visibility:hidden (not {#if}) for unavailable shortcuts to prevent layout shifts.
Add transition: opacity 150ms for smooth appearance changes.
```

## Implementation Steps

- [x] **Step 0: Shared Shortcuts Module**
  - **Tests first** (`src/shared/shortcuts.test.ts`):
    - `should-recognize-arrow-up-as-navigation-key`
    - `should-recognize-arrow-down-as-navigation-key`
    - `should-recognize-digits-0-9-as-jump-keys`
    - `should-recognize-enter-delete-backspace-as-dialog-keys`
    - `should-recognize-o-O-as-project-keys`
    - `should-recognize-all-action-keys`
    - `should-reject-non-action-keys`
  - Create type guards module with `as const` for type safety:

  ```typescript
  // src/shared/shortcuts.ts

  /** Navigation keys for workspace traversal. */
  const NAVIGATION_KEYS = ["ArrowUp", "ArrowDown"] as const;
  /** Jump keys for direct workspace access (1-9, 0 for 10th). */
  const JUMP_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
  /** Dialog keys for opening create/remove dialogs. */
  const DIALOG_KEYS = ["Enter", "Delete", "Backspace"] as const;
  /** Project keys for opening folder picker. */
  const PROJECT_KEYS = ["o", "O"] as const;

  export type NavigationKey = (typeof NAVIGATION_KEYS)[number];
  export type JumpKey = (typeof JUMP_KEYS)[number];
  export type DialogKey = (typeof DIALOG_KEYS)[number];
  export type ProjectKey = (typeof PROJECT_KEYS)[number];
  export type ActionKey = NavigationKey | JumpKey | DialogKey | ProjectKey;

  /** Type guard for navigation keys (ArrowUp, ArrowDown). */
  export function isNavigationKey(key: string): key is NavigationKey {
    return (NAVIGATION_KEYS as readonly string[]).includes(key);
  }

  /** Type guard for jump keys (0-9). */
  export function isJumpKey(key: string): key is JumpKey {
    return (JUMP_KEYS as readonly string[]).includes(key);
  }

  /** Type guard for dialog keys (Enter, Delete, Backspace). */
  export function isDialogKey(key: string): key is DialogKey {
    return (DIALOG_KEYS as readonly string[]).includes(key);
  }

  /** Type guard for project keys (o, O). */
  export function isProjectKey(key: string): key is ProjectKey {
    return (PROJECT_KEYS as readonly string[]).includes(key);
  }

  /** Type guard for any action key. */
  export function isActionKey(key: string): key is ActionKey {
    return isNavigationKey(key) || isJumpKey(key) || isDialogKey(key) || isProjectKey(key);
  }

  /** Convert jump key to 0-based workspace index. Keys 1-9 → indices 0-8, key 0 → index 9. */
  export function jumpKeyToIndex(key: JumpKey): number {
    return key === "0" ? 9 : parseInt(key, 10) - 1;
  }
  ```

  - Files affected: `src/shared/shortcuts.ts`, `src/shared/shortcuts.test.ts`

- [x] **Step 1: Projects Store Helper Functions**
  - **Tests first** (`src/renderer/lib/stores/projects.test.ts`):
    - `should-return-flat-array-of-all-workspaces`
    - `should-maintain-project-then-workspace-order`
    - `should-return-empty-array-when-no-projects`
    - `should-return-workspace-at-global-index`
    - `should-return-undefined-for-out-of-range-index`
    - `should-find-workspace-index-by-path`
    - `should-return-negative-one-for-unknown-path`
  - Add helper functions to projects store:

  ```typescript
  // In projects.svelte.ts

  /**
   * Get flat array of all workspaces across all projects.
   * Order: project order, then workspace order within each project.
   */
  export function getAllWorkspaces(): Workspace[] {
    return projectsState.projects.flatMap((p) => p.workspaces);
  }

  /**
   * Get workspace by global index (0-based).
   * @returns Workspace at index, or undefined if out of range.
   */
  export function getWorkspaceByIndex(index: number): Workspace | undefined {
    return getAllWorkspaces()[index];
  }

  /**
   * Find the index of a workspace by its path.
   * @returns 0-based index, or -1 if not found.
   */
  export function findWorkspaceIndex(path: string | null): number {
    if (!path) return -1;
    return getAllWorkspaces().findIndex((w) => w.path === path);
  }

  /**
   * Wrap an index to stay within bounds (for circular navigation).
   */
  export function wrapIndex(index: number, length: number): number {
    return ((index % length) + length) % length;
  }
  ```

  - Files affected: `src/renderer/lib/stores/projects.svelte.ts`, `src/renderer/lib/stores/projects.test.ts`

- [x] **Step 2: Action Handlers in Shortcuts Store**
  - **Tests first** (`src/renderer/lib/stores/shortcuts.test.ts`):
    - `should-navigate-to-previous-workspace-on-arrow-up`
    - `should-navigate-to-next-workspace-on-arrow-down`
    - `should-wrap-to-last-workspace-when-navigating-up-from-first`
    - `should-wrap-to-first-workspace-when-navigating-down-from-last`
    - `should-not-navigate-when-no-workspaces`
    - `should-not-navigate-when-single-workspace`
    - `should-prevent-concurrent-navigation-during-rapid-keypresses`
    - `should-jump-to-workspace-1-through-9`
    - `should-jump-to-workspace-10-on-key-0`
    - `should-not-jump-when-index-out-of-range`
    - `should-open-create-dialog-on-enter`
    - `should-not-open-create-dialog-when-no-active-project`
    - `should-open-remove-dialog-on-delete`
    - `should-open-remove-dialog-on-backspace`
    - `should-not-open-remove-dialog-when-no-active-workspace`
    - `should-deactivate-shortcut-mode-before-opening-dialog`
    - `should-trigger-folder-picker-on-o-key`
    - `should-deactivate-shortcut-mode-before-opening-folder-picker`
    - `should-log-error-when-workspace-switch-fails`
  - Add to shortcuts store (refactored into separate handlers):

  ```typescript
  // src/renderer/lib/stores/shortcuts.svelte.ts

  import {
    isActionKey,
    isNavigationKey,
    isDialogKey,
    isJumpKey,
    isProjectKey,
    jumpKeyToIndex,
    type ActionKey,
    type NavigationKey,
    type JumpKey,
    type DialogKey,
  } from "../../shared/shortcuts";
  import {
    getAllWorkspaces,
    getWorkspaceByIndex,
    findWorkspaceIndex,
    wrapIndex,
    activeWorkspacePath,
    activeProject,
  } from "./projects.svelte";
  import { dialogState } from "./dialogs.svelte";

  // Guard to prevent concurrent workspace switches during rapid key presses
  let _switchingWorkspace = false;

  /**
   * Handle keydown events during shortcut mode.
   * Dispatches to appropriate action handler based on key type.
   */
  export function handleKeyDown(event: KeyboardEvent): void {
    if (!_shortcutModeActive) return;

    if (isActionKey(event.key)) {
      event.preventDefault();
      void executeAction(event.key);
    }
  }

  async function executeAction(key: ActionKey): Promise<void> {
    if (isNavigationKey(key)) {
      await handleNavigation(key);
    } else if (isJumpKey(key)) {
      await handleJump(key);
    } else if (isDialogKey(key)) {
      handleDialog(key);
    } else if (isProjectKey(key)) {
      handleProjectOpen();
    }
  }

  /**
   * Handle arrow key navigation between workspaces.
   * Wraps around at boundaries. No-op if ≤1 workspaces or switch in progress.
   */
  async function handleNavigation(key: NavigationKey): Promise<void> {
    const workspaces = getAllWorkspaces();
    if (workspaces.length <= 1) return;
    if (_switchingWorkspace) return;

    const direction = key === "ArrowUp" ? -1 : 1;
    const currentIndex = findWorkspaceIndex(activeWorkspacePath.value);
    const nextIndex = wrapIndex(currentIndex + direction, workspaces.length);

    _switchingWorkspace = true;
    try {
      await api.switchWorkspace(workspaces[nextIndex].path);
    } catch (error) {
      console.error("Failed to switch workspace:", error);
    } finally {
      _switchingWorkspace = false;
    }
  }

  /**
   * Handle number key jump to specific workspace.
   * No-op if index out of range or switch in progress.
   */
  async function handleJump(key: JumpKey): Promise<void> {
    const index = jumpKeyToIndex(key);
    const workspace = getWorkspaceByIndex(index);
    if (!workspace) return;
    if (_switchingWorkspace) return;

    _switchingWorkspace = true;
    try {
      await api.switchWorkspace(workspace.path);
    } catch (error) {
      console.error("Failed to jump to workspace:", error);
    } finally {
      _switchingWorkspace = false;
    }
  }

  /**
   * Handle dialog opening keys (Enter, Delete, Backspace).
   * Deactivates shortcut mode (without z-order changes) before opening dialog.
   */
  function handleDialog(key: DialogKey): void {
    if (key === "Enter") {
      const projectPath = activeProject.value?.path;
      if (!projectPath) return;
      // Deactivate mode without calling full exitShortcutMode to avoid z-order thrashing
      _shortcutModeActive = false;
      dialogState.openCreateDialog(projectPath, null);
    } else {
      // Delete or Backspace
      const workspacePath = activeWorkspacePath.value;
      if (!workspacePath) return;
      _shortcutModeActive = false;
      dialogState.openRemoveDialog(workspacePath, null);
    }
  }

  /**
   * Handle O key to open project folder picker.
   */
  function handleProjectOpen(): void {
    exitShortcutMode();
    void api.selectFolder().then((path) => {
      if (path) void api.openProject(path);
    });
  }

  // Ensure exitShortcutMode is exported for testing
  export { exitShortcutMode };
  ```

  - Files affected: `src/renderer/lib/stores/shortcuts.svelte.ts`, `src/renderer/lib/stores/shortcuts.test.ts`

- [x] **Step 3: Sidebar Index Numbers & Open Project Hint**
  - **Tests first** (`src/renderer/lib/components/Sidebar.test.ts`):
    - `should-show-index-numbers-when-shortcut-mode-active`
    - `should-hide-index-numbers-when-shortcut-mode-inactive`
    - `should-display-indices-1-through-9-then-0-for-tenth`
    - `should-number-workspaces-globally-across-projects`
    - `should-show-dimmed-dot-for-workspaces-beyond-tenth`
    - `should-have-aria-hidden-on-index-spans`
    - `should-include-shortcut-hint-in-workspace-button-aria-label`
    - `should-show-O-on-open-project-button-when-shortcut-mode-active`
    - `should-hide-O-on-open-project-button-when-shortcut-mode-inactive`
  - Add `shortcutModeActive` prop to Sidebar with proper accessibility:

  ```svelte
  <script lang="ts" context="module">
    // Pure functions at module scope for performance
    function getWorkspaceGlobalIndex(
      projects: Project[],
      projectIndex: number,
      workspaceIndex: number
    ): number {
      let globalIndex = 0;
      for (let p = 0; p < projectIndex; p++) {
        globalIndex += projects[p].workspaces.length;
      }
      return globalIndex + workspaceIndex;
    }

    function formatIndexDisplay(globalIndex: number): string | null {
      if (globalIndex > 9) return null; // No shortcut for 11+
      return globalIndex === 9 ? "0" : String(globalIndex + 1);
    }

    function getShortcutHint(globalIndex: number): string {
      if (globalIndex > 9) return ""; // No shortcut
      const key = globalIndex === 9 ? "0" : String(globalIndex + 1);
      return ` - Press ${key} to jump`;
    }
  </script>

  <script lang="ts">
    interface Props {
      // ... existing props
      shortcutModeActive?: boolean;
    }

    let { shortcutModeActive = false, ...rest }: Props = $props();
  </script>

  <!-- In workspace list item -->
  <button
    class="workspace-item"
    aria-label="{workspace.name}{shortcutModeActive ? getShortcutHint(globalIndex) : ''}"
  >
    {#if shortcutModeActive}
      {@const globalIndex = getWorkspaceGlobalIndex(projects, pIndex, wIndex)}
      {@const display = formatIndexDisplay(globalIndex)}
      <span
        class="shortcut-index"
        class:shortcut-index--dimmed={display === null}
        aria-hidden="true"
      >
        {display ?? "·"}
      </span>
    {/if}
    {workspace.name}
  </button>

  <!-- Open Project button -->
  <vscode-button
    onclick={onOpenProject}
    aria-label="Open Project{shortcutModeActive ? ' - Press O' : ''}"
  >
    {#if shortcutModeActive}
      <span class="shortcut-index" aria-hidden="true">O</span>
    {/if}
    Open Project
  </vscode-button>

  <style>
    .shortcut-index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 1.25rem;
      height: 1.25rem;
      margin-right: 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 2px;
    }

    .shortcut-index--dimmed {
      opacity: 0.4;
    }
  </style>
  ```

  - Also update EmptyState component with same pattern (shown when no projects exist)
  - Files affected:
    - `src/renderer/lib/components/Sidebar.svelte`, `src/renderer/lib/components/Sidebar.test.ts`
    - `src/renderer/lib/components/EmptyState.svelte`, `src/renderer/lib/components/EmptyState.test.ts`

- [x] **Step 4: Conditional ShortcutOverlay**
  - **Tests first** (`src/renderer/lib/components/ShortcutOverlay.test.ts`):
    - `should-hide-navigate-hint-when-one-or-fewer-workspaces`
    - `should-hide-jump-hint-when-one-or-fewer-workspaces`
    - `should-hide-new-hint-when-no-active-project`
    - `should-hide-delete-hint-when-no-active-workspace`
    - `should-always-show-open-hint`
    - `should-show-all-hints-when-context-available`
    - `should-not-cause-layout-shift-when-hints-hidden`
  - Update ShortcutOverlay with visibility-based hiding to prevent layout shifts:

  ```svelte
  <script lang="ts">
    interface Props {
      active: boolean;
      workspaceCount: number;
      hasActiveProject: boolean;
      hasActiveWorkspace: boolean;
    }

    let { active, workspaceCount, hasActiveProject, hasActiveWorkspace }: Props = $props();

    const showNavigation = $derived(workspaceCount > 1);
    const showJump = $derived(workspaceCount > 1);
    const showNew = $derived(hasActiveProject);
    const showDelete = $derived(hasActiveWorkspace);
  </script>

  <div class="shortcut-overlay" class:active role="status" aria-live="polite">
    <span
      class="shortcut-hint"
      class:shortcut-hint--hidden={!showNavigation}
      aria-label="Arrow up or down to navigate workspaces"
    >
      ↑↓ Navigate
    </span>
    <span
      class="shortcut-hint"
      class:shortcut-hint--hidden={!showNew}
      aria-label="Enter to create new workspace"
    >
      ⏎ New
    </span>
    <span
      class="shortcut-hint"
      class:shortcut-hint--hidden={!showDelete}
      aria-label="Delete or Backspace to remove workspace"
    >
      ⌫ Del
    </span>
    <span
      class="shortcut-hint"
      class:shortcut-hint--hidden={!showJump}
      aria-label="Press 1 through 0 to jump to workspace"
    >
      1-0 Jump
    </span>
    <span class="shortcut-hint" aria-label="O to open project"> O Open </span>
  </div>

  <style>
    .shortcut-overlay {
      /* ... existing styles ... */
      transition: opacity 150ms ease-out;
    }

    .shortcut-hint {
      transition: opacity 150ms ease-out;
    }

    .shortcut-hint--hidden {
      visibility: hidden;
      opacity: 0;
    }
  </style>
  ```

  - Files affected: `src/renderer/lib/components/ShortcutOverlay.svelte`, `src/renderer/lib/components/ShortcutOverlay.test.ts`

- [x] **Step 5: Wire Everything in App.svelte**
  - **Tests first** (`src/renderer/App.test.ts`):
    - `should-connect-handleKeyDown-to-window`
    - `should-pass-shortcutModeActive-to-sidebar`
    - `should-pass-shortcutModeActive-to-empty-state`
    - `should-pass-all-context-props-to-overlay`
  - Update App.svelte:

  ```svelte
  <script lang="ts">
    import * as shortcuts from "$lib/stores/shortcuts.svelte";
    import { getAllWorkspaces } from "$lib/stores/projects.svelte";

    // ... existing code

    const allWorkspaces = $derived(getAllWorkspaces());
  </script>

  <svelte:window
    onkeydown={shortcuts.handleKeyDown}
    onkeyup={shortcuts.handleKeyUp}
    onblur={shortcuts.handleWindowBlur}
  />

  <!-- When projects exist -->
  <Sidebar
    {projects}
    {activeProjectPath}
    {activeWorkspacePath}
    shortcutModeActive={shortcuts.shortcutModeActive.value}
    {onOpenProject}
    {onCreateWorkspace}
    {onRemoveWorkspace}
    {onActivateWorkspace}
  />

  <!-- When no projects exist -->
  <EmptyState shortcutModeActive={shortcuts.shortcutModeActive.value} {onOpenProject} />

  <ShortcutOverlay
    active={shortcuts.shortcutModeActive.value}
    workspaceCount={allWorkspaces.length}
    hasActiveProject={!!activeProjectPath}
    hasActiveWorkspace={!!activeWorkspacePath}
  />
  ```

  - Files affected: `src/renderer/App.svelte`, `src/renderer/App.test.ts`

- [x] **Step 6: Integration Tests**
  - **Tests** (`src/renderer/lib/integration.test.ts`):
    - `should-complete-full-shortcut-flow-activate-action-release`:
      Alt+X → overlay shows → press ↓ → workspace switches → overlay stays → release Alt → overlay hides
    - `should-execute-multiple-actions-in-sequence`:
      Alt+X → press 1 (jump) → press 2 (jump) → verify both executed, overlay visible
    - `should-open-dialog-and-hide-overlay`:
      Alt+X → press Enter → dialog opens, overlay hides, shortcut mode inactive
    - `should-wrap-navigation-at-boundaries`:
      Alt+X → at last workspace → press ↓ → wraps to first workspace
    - `should-trigger-folder-picker-on-o-key`:
      Alt+X → press O → folder picker opens, overlay hides
    - `should-handle-no-workspaces-gracefully`:
      No workspaces → Alt+X → only "O Open" visible, ↑↓ and 1-0 hidden and no-op
    - `should-handle-single-workspace-gracefully`:
      Single workspace → Alt+X → navigate hints hidden, jump works for index 1
  - Files affected: `src/renderer/lib/integration.test.ts`

## Testing Strategy

### Mocking Strategy

```typescript
// Mock the API module
vi.mock("$lib/api", () => ({
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  setDialogMode: vi.fn(),
  focusActiveWorkspace: vi.fn(),
}));

// Mock the projects store
vi.mock("./projects.svelte", () => ({
  getAllWorkspaces: vi.fn(() => []),
  getWorkspaceByIndex: vi.fn(() => undefined),
  findWorkspaceIndex: vi.fn(() => -1),
  wrapIndex: vi.fn((i, l) => ((i % l) + l) % l),
  activeWorkspacePath: { value: null },
  activeProject: { value: null },
}));

// Mock the dialogs store
vi.mock("./dialogs.svelte", () => ({
  dialogState: {
    isOpen: { value: false },
    openCreateDialog: vi.fn(),
    openRemoveDialog: vi.fn(),
  },
}));
```

### Unit Tests

| Test Case                                 | Description                   | File                                                  |
| ----------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| should-recognize-arrow-keys-as-navigation | Type guard for ↑↓             | `src/shared/shortcuts.test.ts`                        |
| should-recognize-digits-as-jump-keys      | Type guard for 0-9            | `src/shared/shortcuts.test.ts`                        |
| should-recognize-dialog-keys              | Type guard for Enter/Del/Back | `src/shared/shortcuts.test.ts`                        |
| should-recognize-project-keys             | Type guard for o/O            | `src/shared/shortcuts.test.ts`                        |
| should-recognize-all-action-keys          | Combined type guard           | `src/shared/shortcuts.test.ts`                        |
| should-convert-jump-key-to-index          | jumpKeyToIndex helper         | `src/shared/shortcuts.test.ts`                        |
| should-return-flat-workspace-array        | getAllWorkspaces              | `src/renderer/lib/stores/projects.test.ts`            |
| should-maintain-workspace-order           | Order consistency             | `src/renderer/lib/stores/projects.test.ts`            |
| should-return-workspace-at-index          | getWorkspaceByIndex           | `src/renderer/lib/stores/projects.test.ts`            |
| should-handle-out-of-range-index          | Bounds checking               | `src/renderer/lib/stores/projects.test.ts`            |
| should-find-workspace-index-by-path       | findWorkspaceIndex            | `src/renderer/lib/stores/projects.test.ts`            |
| should-wrap-index-correctly               | wrapIndex helper              | `src/renderer/lib/stores/projects.test.ts`            |
| should-navigate-up-to-previous            | ArrowUp navigation            | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-navigate-down-to-next              | ArrowDown navigation          | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-wrap-at-top                        | Up from first → last          | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-wrap-at-bottom                     | Down from last → first        | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-noop-navigate-no-workspaces        | Empty state handling          | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-noop-navigate-single               | Single workspace              | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-prevent-concurrent-switches        | Rapid keypress guard          | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-jump-by-number-keys                | 1-9 jump                      | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-jump-to-tenth-on-zero              | 0 → index 9                   | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-noop-jump-out-of-range             | Invalid index                 | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-open-create-on-enter               | Enter key                     | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-noop-create-no-project             | No active project             | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-open-remove-on-delete              | Delete key                    | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-open-remove-on-backspace           | Backspace key                 | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-noop-remove-no-workspace           | No active workspace           | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-deactivate-before-dialog           | Mode exit timing              | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-trigger-folder-picker              | O key                         | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-log-switch-error                   | Error handling                | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-show-indices-when-active           | Visibility                    | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-hide-indices-when-inactive         | Visibility                    | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-format-indices-correctly           | 1-9, 0 format                 | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-number-globally                    | Cross-project                 | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-show-dimmed-dot-for-11plus         | Discoverability               | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-have-aria-hidden-on-indices        | Accessibility                 | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-show-O-hint-when-active            | Button hint                   | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-hide-O-hint-when-inactive          | Button hint                   | `src/renderer/lib/components/Sidebar.test.ts`         |
| should-show-O-in-empty-state              | EmptyState                    | `src/renderer/lib/components/EmptyState.test.ts`      |
| should-hide-O-in-empty-state              | EmptyState                    | `src/renderer/lib/components/EmptyState.test.ts`      |
| should-hide-navigate-when-few-workspaces  | Overlay                       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-hide-jump-when-few-workspaces      | Overlay                       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-hide-new-when-no-project           | Overlay                       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-hide-delete-when-no-workspace      | Overlay                       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-always-show-open                   | Overlay                       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-not-cause-layout-shift             | CSS stability                 | `src/renderer/lib/components/ShortcutOverlay.test.ts` |

### Accessibility Tests

| Test Case                               | Description       | File                                                  |
| --------------------------------------- | ----------------- | ----------------------------------------------------- |
| should-announce-workspace-switch        | Screen reader     | `src/renderer/lib/stores/shortcuts.test.ts`           |
| should-have-proper-aria-labels          | Hint labels       | `src/renderer/lib/components/ShortcutOverlay.test.ts` |
| should-include-shortcut-in-button-label | Workspace buttons | `src/renderer/lib/components/Sidebar.test.ts`         |

### Integration Tests

| Test Case                          | Description  | File                                   |
| ---------------------------------- | ------------ | -------------------------------------- |
| should-complete-full-shortcut-flow | End-to-end   | `src/renderer/lib/integration.test.ts` |
| should-execute-multiple-actions    | Sequence     | `src/renderer/lib/integration.test.ts` |
| should-open-dialog-from-shortcut   | Dialog flow  | `src/renderer/lib/integration.test.ts` |
| should-wrap-navigation             | Boundary     | `src/renderer/lib/integration.test.ts` |
| should-trigger-folder-picker       | Project open | `src/renderer/lib/integration.test.ts` |
| should-handle-no-workspaces        | Edge case    | `src/renderer/lib/integration.test.ts` |
| should-handle-single-workspace     | Edge case    | `src/renderer/lib/integration.test.ts` |

### Performance Tests

| Test Case                      | Description             | File                                   |
| ------------------------------ | ----------------------- | -------------------------------------- |
| should-handle-rapid-navigation | 100 keypresses <100ms   | `src/renderer/lib/integration.test.ts` |
| should-handle-rapid-jumps      | All 10 workspaces <50ms | `src/renderer/lib/integration.test.ts` |

### Manual Testing Checklist

- [ ] Alt+X then 1 → switches to first workspace, overlay stays
- [ ] Alt+X then 2 → switches to second workspace
- [ ] Alt+X then 0 → switches to 10th workspace (if exists)
- [ ] Alt+X then 5 with only 3 workspaces → nothing happens
- [ ] Alt+X then ↓ → navigates to next workspace
- [ ] Alt+X then ↑ → navigates to previous workspace
- [ ] Alt+X then ↓ on last workspace → wraps to first
- [ ] Alt+X then ↑ on first workspace → wraps to last
- [ ] Alt+X then 1 then 2 → switches twice while holding Alt
- [ ] Rapid ↓↓↓ → only one switch occurs (guard works)
- [ ] Alt+X then Enter → create dialog opens, overlay hidden
- [ ] Alt+X then Delete → remove dialog opens, overlay hidden
- [ ] Alt+X then Backspace → remove dialog opens, overlay hidden
- [ ] Alt+X then O → folder picker opens, overlay hidden
- [ ] Verify sidebar shows 1-9, 0 numbers during shortcut mode
- [ ] Verify sidebar numbers are global across projects
- [ ] Verify 11th+ workspaces show dimmed dot (·)
- [ ] Verify Open Project button shows "O" prefix during shortcut mode
- [ ] With >10 workspaces → first 10 have numbers, rest have dots
- [ ] With 0 workspaces → overlay only shows "O Open"
- [ ] With 1 workspace → overlay hides ↑↓ Navigate and 1-0 Jump
- [ ] With no active project → overlay hides ⏎ New
- [ ] With no active workspace → overlay hides ⌫ Del
- [ ] Verify no layout shift when overlay hints hide/show

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

No additional documentation updates needed - covered in KEYBOARD_ACTIVATION.

## Definition of Done

- [ ] All implementation steps complete
- [ ] All tests pass (unit, integration, accessibility)
- [ ] `pnpm validate:fix` passes
- [ ] Manual testing checklist completed
- [ ] All shortcut actions work correctly
- [ ] Sidebar shows index numbers during shortcut mode
- [ ] Overlay conditionally hides unavailable actions (no layout shift)
- [ ] Error handling logs failures appropriately
- [ ] Rapid keypresses handled gracefully
