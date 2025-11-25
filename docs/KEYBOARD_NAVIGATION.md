# Keyboard Navigation Implementation Plan

This document describes the keyboard navigation feature for Chime, enabling efficient workspace management without leaving the keyboard.

---

## Overview

Chime introduces a keyboard shortcut system that allows users to navigate between workspaces, create new workspaces, and remove workspaces - all while keeping focus on the VS Code editor.

### Design Principles

1. **Non-intrusive**: Shortcuts should not conflict with VS Code keybindings
2. **Focus stays on VS Code**: The iframe always has focus except when modal dialogs are open
3. **Discoverable**: Visual overlay shows available shortcuts when modifier is held
4. **Centralized configuration**: All keybindings defined in one place
5. **Works with iframe focus**: Uses Tauri global shortcuts to capture modifier even when VS Code has focus

---

## Keyboard Shortcuts

### Activation: `Alt+X` (while holding Alt)

To enter shortcut mode:

1. Press and hold `Alt`
2. Press `X` to activate shortcut mode (overlay appears, workspace numbers shown)
3. Press action keys while still holding `Alt`
4. Release `Alt` to exit shortcut mode

| Keys              | Action                                      |
| ----------------- | ------------------------------------------- |
| `Alt+X`           | Activate shortcut mode                      |
| `Alt+↑`           | Previous workspace (across projects)        |
| `Alt+↓`           | Next workspace (across projects)            |
| `Alt+Enter`       | Create workspace dialog (current project)   |
| `Alt+Delete`      | Remove workspace dialog (current workspace) |
| `Alt+Backspace`   | Remove workspace dialog (current workspace) |
| `Alt+1` - `Alt+9` | Jump to workspace by index (1-9)            |
| `Alt+0`           | Jump to 10th workspace                      |

### Behavior

- All shortcuts are registered at the OS level via Tauri global shortcuts
- `Alt+X` must be held to keep shortcut mode active
- Shortcut mode activates on `Alt+X` press and deactivates when `Alt+X` is released
- Action shortcuts (`Alt+↑`, `Alt+1`, etc.) only work when shortcut mode is active
- On deactivation, focus is explicitly restored to VS Code iframe
- `Escape` can also deactivate shortcut mode
- Window blur deactivates shortcut mode

### Why Alt+X?

The previous `Ctrl+Space` approach had issues:

- When holding `Ctrl+Space` and pressing action keys, the OS sends `Ctrl+ArrowUp` etc.
- These key combinations get intercepted by the OS/browser before reaching our handlers
- Tauri cannot register three-key shortcuts like `Ctrl+Space+ArrowUp`

The `Alt+X` approach solves this:

- `Alt+X` is a standard two-key shortcut that Tauri can register
- Once activated, `Alt+ActionKey` shortcuts are also two-key combinations
- While `Alt` is held, all action keys include the `Alt` modifier naturally
- VS Code conflicts (like `Alt+↑` for "move line up") don't matter because we've stolen focus

### Modal Dialog Shortcuts (no modifier needed)

| Key      | Action                           |
| -------- | -------------------------------- |
| `Enter`  | OK/Confirm                       |
| `Escape` | Cancel/Close                     |
| `↑/↓`    | Navigate options (if applicable) |

---

## UI Mockups

### Normal State (shortcut mode NOT active)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CHIME                                                                          │
├────────────────────────┬────────────────────────────────────────────────────────┤
│                        │                                                        │
│  MY PROJECT            │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ main         ● [x]│  │                                                        │
│  └──────────────────┘  │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ feature-a    ● [x]│◄─┼─── ACTIVE                                              │
│  └──────────────────┘  │                                                        │
│               [+]      │              VS CODE IFRAME                            │
│                        │                                                        │
│  ANOTHER PROJECT       │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ main         ● [x]│  │                                                        │
│  └──────────────────┘  │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ bugfix       ● [x]│  │                                                        │
│  └──────────────────┘  │                                                        │
│               [+]      │                                                        │
│                        │                                                        │
└────────────────────────┴────────────────────────────────────────────────────────┘

    ^ No index numbers visible, clean UI
```

### When Shortcut Mode is Active (Alt held after Alt+X)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CHIME                                                                          │
├────────────────────────┬────────────────────────────────────────────────────────┤
│                        │                                                        │
│  MY PROJECT            │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ 1  main      ● [x]│  │                                                        │
│  └──────────────────┘  │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ 2  feature-a ● [x]│◄─┼─── ACTIVE                                              │
│  └──────────────────┘  │                                                        │
│               [+]      │              VS CODE IFRAME                            │
│                        │                                                        │
│  ANOTHER PROJECT       │                                                        │
│  ┌──────────────────┐  │                                                        │
│  │ 3  main      ● [x]│  │                                                        │
│  └──────────────────┘  │                                                        │
│  ┌──────────────────┐  │   ┌─────────────────────────────────────────┐         │
│  │ 4  bugfix    ● [x]│  │   │                                         │         │
│  └──────────────────┘  │   │  ↑↓ Navigate   ⏎ New   ⌫ Del   1-0 Jump │         │
│               [+]      │   │                                         │         │
│                        │   └─────────────────────────────────────────┘         │
│                        │                                                        │
└────────────────────────┴────────────────────────────────────────────────────────┘
                                              ▲
                                              │
                                Floating pill overlay
                                (semi-transparent, hovers over content)
```

### Index Numbering (1-9, then 0 for 10th)

```
│  PROJECT A             │
│  ┌──────────────────┐  │
│  │ 1  main      ● [x]│  │   ← Press "1" to jump here
│  └──────────────────┘  │
│  ┌──────────────────┐  │
│  │ 2  feature   ● [x]│  │   ← Press "2" to jump here
│  └──────────────────┘  │
│                        │
│  PROJECT B             │
│  │ 3  main      ● [x]│  │
│  │ 4  hotfix    ● [x]│  │
│  │ 5  dev       ● [x]│  │
│  │ 6  staging   ● [x]│  │
│  │ 7  test      ● [x]│  │
│  │ 8  feature-x ● [x]│  │
│  │ 9  feature-y ● [x]│  │   ← Press "9" to jump here
│  │ 0  feature-z ● [x]│  │   ← Press "0" to jump here (10th)
│  │    feature-w ● [x]│  │   ← No number (11th+), use ↑↓ only
```

### Overlay Styling

```
                ┌─────────────────────────────────────────┐
                │  ↑↓ Navigate   ⏎ New   ⌫ Del   1-0 Jump │
                └─────────────────────────────────────────┘

Style:
- position: fixed
- bottom: 24px
- left: 50%, transform: translateX(-50%)
- background: rgba(30, 30, 30, 0.85)
- backdrop-filter: blur(8px)
- border-radius: 8px
- padding: 10px 20px
- box-shadow: 0 4px 12px rgba(0,0,0,0.3)
- color: rgba(255, 255, 255, 0.9)
- font-size: 13px
- z-index: 999 (above content, below modals at 1000)
- transition: opacity 150ms ease-in-out
```

---

## Architecture

### Hybrid Approach: Tauri Global Shortcuts + Frontend Keyup Detection

The key challenge is that keyboard events inside the VS Code iframe don't bubble to the parent document. We solve this with a hybrid approach:

1. **Tauri Global Shortcuts** register `Alt+X` for activation and `Alt+{ActionKey}` for actions
2. **Activation Event** (`Alt+X`) activates shortcut mode and steals focus from iframe
3. **Action Events** (`Alt+↑`, `Alt+1`, etc.) are only handled when shortcut mode is active
4. **Frontend Keyup Detection** detects when `Alt` is released to deactivate
5. **Focus Restoration** returns focus to iframe when deactivated

```
                          OS Level (Tauri Plugin)
┌────────────────────────────────────────────────────────────────┐
│  tauri-plugin-global-shortcut                                  │
│  - Registers Alt+X (activation)                                │
│  - Registers Alt+ArrowUp, Alt+ArrowDown, Alt+1-0, etc.         │
│  - All fire via Tauri events to frontend                       │
│  - Works regardless of iframe focus                            │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼ Events: chime-shortcut-activated, chime-action-*
                          Frontend (Svelte)
┌────────────────────────────────────────────────────────────────┐
│  +layout.svelte                                                │
│  - On chime-shortcut-activated: set active, steal focus        │
│  - On chime-action-*: if active, execute action                │
│  - <svelte:window on:keyup>: detect Alt release → deactivate   │
│  - <svelte:window on:blur>: deactivate on window blur          │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  keyboardNavigation.ts (store)                                 │
│  - chimeShortcutActive: writable<boolean>                      │
│  - modalOpen: writable<boolean>                                │
│  - flatWorkspaceList: derived store                            │
│  - navigateUp() / navigateDown() / jumpToIndex(n)              │
│  - handleActionKey(event): routes to correct action            │
└────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌───────────────┐ ┌──────────────────────┐
│ Sidebar.svelte   │ │ Overlay.svelte│ │ WorkspaceView.svelte │
│ - Shows indexes  │ │ - Shows when  │ │ - Manages iframes    │
│ - Reacts to nav  │ │   active      │ │ - Focus management   │
└──────────────────┘ └───────────────┘ └──────────────────────┘
```

                          OS Level (Tauri Plugin)

┌────────────────────────────────────────────────────────────┐
│ tauri-plugin-global-shortcut │
│ - Registers Ctrl+Space at OS level │
│ - Fires ONCE when combination pressed │
│ - Works regardless of iframe focus │
└────────────────────────────────────────────────────────────┘
│
▼ Single event on press
Frontend (Svelte)
┌────────────────────────────────────────────────────────────┐
│ +layout.svelte │
│ - On Ctrl+Space: activate mode, steal focus │
│ - <svelte:window on:keyup>: detect Ctrl/Space release │
│ - <svelte:window on:blur>: deactivate on window blur │
│ - Hidden div receives action keys │
│ - Routes keys to keyboardNavigation store │
└────────────────────────────────────────────────────────────┘
│
▼
┌────────────────────────────────────────────────────────────┐
│ keyboardNavigation.ts (store) │
│ - chimeShortcutActive: writable<boolean> │
│ - modalOpen: writable<boolean> │
│ - flatWorkspaceList: derived store │
│ - navigateUp() / navigateDown() / jumpToIndex(n) │
│ - handleActionKey(event): routes to correct action │
└────────────────────────────────────────────────────────────┘
│
┌───────────────┼───────────────┐
▼ ▼ ▼
┌──────────────────┐ ┌───────────────┐ ┌──────────────────────┐
│ Sidebar.svelte │ │ Overlay.svelte│ │ WorkspaceView.svelte │
│ - Shows indexes │ │ - Shows when │ │ - Manages iframes │
│ - Reacts to nav │ │ active │ │ - Focus management │
└──────────────────┘ └───────────────┘ └──────────────────────┘

```

### File Structure

```

src-tauri/
├── Cargo.toml # Add tauri-plugin-global-shortcut
├── capabilities/
│ └── default.json # Add global-shortcut permissions
└── src/
└── lib.rs # Register plugin in setup

src/lib/
├── config/
│ └── keybindings.ts # Central keymap configuration
├── stores/
│ ├── keyboardNavigation.ts # State & navigation logic
│ └── keyboardNavigation.test.ts # Tests
├── components/
│ ├── KeyboardShortcutOverlay.svelte # Bottom overlay
│ ├── KeyboardShortcutOverlay.test.ts # Tests
│ ├── Sidebar.svelte # Modified: workspace index numbers
│ └── ...
└── routes/
└── +layout.svelte # Global shortcut registration & focus management

````

---

## Rust/Tauri Changes

### 1. Force X11 Backend (Wayland Compatibility)

Add this line at the very beginning of the `run()` function in `lib.rs`, before any other code:

```rust
std::env::set_var("GDK_BACKEND", "x11");
````

This forces the app to use X11 (via XWayland on Wayland systems), which is required for global shortcuts to work. This approach:

- Works on both X11 and Wayland (variable is ignored on native X11)
- No detection needed - unconditionally safe to set
- Enables global shortcut functionality on all Linux systems

### 2. Add Dependencies

```bash
cd src-tauri
cargo add tauri-plugin-global-shortcut
```

This adds to `Cargo.toml`:

```toml
[dependencies]
tauri-plugin-global-shortcut = "2"
```

### 3. Add Frontend Package

```bash
pnpm add @tauri-apps/plugin-global-shortcut
```

### 4. Add Permissions

Update `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered"
  ]
}
```

### 5. Register Plugin and Shortcuts

Update `src-tauri/src/lib.rs` in the `run()` function's `.setup()` closure:

```rust
// In the setup closure, register global shortcuts
#[cfg(desktop)]
{
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let app_handle = app.handle().clone();

    // Define all shortcuts
    let shortcuts = vec![
        // Activation: Alt+X
        (Shortcut::new(Some(Modifiers::ALT), Code::KeyX), "chime-shortcut-activated"),
        // Navigation
        (Shortcut::new(Some(Modifiers::ALT), Code::ArrowUp), "chime-action-up"),
        (Shortcut::new(Some(Modifiers::ALT), Code::ArrowDown), "chime-action-down"),
        // Workspace actions
        (Shortcut::new(Some(Modifiers::ALT), Code::Enter), "chime-action-create"),
        (Shortcut::new(Some(Modifiers::ALT), Code::Delete), "chime-action-remove"),
        (Shortcut::new(Some(Modifiers::ALT), Code::Backspace), "chime-action-remove"),
        // Jump to workspace (1-9, 0)
        (Shortcut::new(Some(Modifiers::ALT), Code::Digit1), "chime-action-jump-1"),
        (Shortcut::new(Some(Modifiers::ALT), Code::Digit2), "chime-action-jump-2"),
        // ... etc for 3-9, 0
    ];

    // Register plugin with handler
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    // Find matching shortcut and emit event
                    for (s, event_name) in &shortcuts {
                        if shortcut == s {
                            let _ = app_handle.emit(event_name, ());
                            break;
                        }
                    }
                }
            })
            .build(),
    )?;

    // Register all shortcuts
    for (shortcut, _) in &shortcuts {
        let _ = app.global_shortcut().register(shortcut.clone());
    }
}
```

### 6. Platform Considerations

| Platform            | Consideration                                                       |
| ------------------- | ------------------------------------------------------------------- |
| **Linux (X11)**     | Works natively via X11 global hotkeys                               |
| **Linux (Wayland)** | Works via XWayland (forced by `GDK_BACKEND=x11`)                    |
| **Windows**         | `Alt` may trigger menu bar in some apps, but `Alt+X` is usually ok  |
| **macOS**           | `Alt/Option+X` types special character `≈` - may need different key |

---

## Frontend Changes

### Listening for Tauri Events

In `+layout.svelte`, listen for shortcut events from Tauri:

```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onMount, onDestroy } from 'svelte';
import { get } from 'svelte/store';
import {
  chimeShortcutActive,
  modalOpen,
  navigateUp,
  navigateDown,
  jumpToIndex,
  createDialogRequest,
  removeDialogRequest,
} from '$lib/stores/keyboardNavigation';
import { activeWorkspace } from '$lib/stores/projects';

let unlisteners: UnlistenFn[] = [];

onMount(async () => {
  // Listen for activation (Alt+X)
  unlisteners.push(
    await listen('chime-shortcut-activated', () => {
      if (!get(modalOpen)) {
        chimeShortcutActive.set(true);
      }
    })
  );

  // Listen for navigation actions
  unlisteners.push(
    await listen('chime-action-up', () => {
      if (get(chimeShortcutActive)) navigateUp();
    })
  );
  unlisteners.push(
    await listen('chime-action-down', () => {
      if (get(chimeShortcutActive)) navigateDown();
    })
  );

  // Listen for workspace actions
  unlisteners.push(
    await listen('chime-action-create', () => {
      if (get(chimeShortcutActive)) {
        const active = get(activeWorkspace);
        if (active) createDialogRequest.set(active.projectHandle);
      }
    })
  );
  unlisteners.push(
    await listen('chime-action-remove', () => {
      if (get(chimeShortcutActive)) {
        const active = get(activeWorkspace);
        if (active) removeDialogRequest.set(active);
      }
    })
  );

  // Listen for jump actions (1-9, 0)
  for (let i = 1; i <= 9; i++) {
    const index = i;
    unlisteners.push(
      await listen(`chime-action-jump-${i}`, () => {
        if (get(chimeShortcutActive)) jumpToIndex(index);
      })
    );
  }
  unlisteners.push(
    await listen('chime-action-jump-0', () => {
      if (get(chimeShortcutActive)) jumpToIndex(10);
    })
  );
});

onDestroy(() => {
  unlisteners.forEach((unlisten) => unlisten());
});

// Detect when Alt is released to deactivate
function onKeyUp(event: KeyboardEvent) {
  if (get(chimeShortcutActive)) {
    if (event.key === 'Alt') {
      chimeShortcutActive.set(false);
    }
  }
}

// Also deactivate on Escape
function onKeyDown(event: KeyboardEvent) {
  if (get(chimeShortcutActive) && event.key === 'Escape') {
    chimeShortcutActive.set(false);
  }
}

// Deactivate on window blur
function onWindowBlur() {
  if (get(chimeShortcutActive)) {
    chimeShortcutActive.set(false);
  }
}
```

```svelte
<svelte:window onkeyup={onKeyUp} onkeydown={onKeyDown} onblur={onWindowBlur} />
```

**Note**: Focus stealing is no longer needed because all shortcuts are registered at the OS level via Tauri. The action keys include the `Alt` modifier, so they're captured as `Alt+ArrowUp` etc. even when VS Code has focus.

---

## Central Keybindings Configuration

### `src/lib/config/keybindings.ts`

```typescript
/**
 * Central configuration for all Chime keyboard shortcuts.
 *
 * Activation: Alt+X - captured via Tauri global shortcut
 * Actions: Alt+{ActionKey} - captured via Tauri global shortcuts, only handled when active
 */

// Activation shortcut
export const CHIME_ACTIVATION = {
  display: 'Alt+X', // Display format for UI
} as const;

// Shortcut labels for the overlay (shown while in shortcut mode)
export const CHIME_SHORTCUTS = {
  // Navigation
  navigateUp: {
    label: '↑↓',
    description: 'Navigate',
  },
  navigateDown: {
    label: '↑↓',
    description: 'Navigate',
  },

  // Workspace actions
  createWorkspace: {
    label: '⏎',
    description: 'New',
  },
  removeWorkspace: {
    label: '⌫',
    description: 'Del',
  },

  // Quick jump (1-9, 0 for 10th)
  jumpToWorkspace: {
    label: '1-0',
    description: 'Jump',
  },
} as const;

// Dialog shortcuts (no modifier needed)
export const DIALOG_SHORTCUTS = {
  confirm: {
    key: 'Enter',
    label: '⏎',
    description: 'OK',
  },
  cancel: {
    key: 'Escape',
    label: 'Esc',
    description: 'Cancel',
  },
} as const;

// Helper: Get display key for workspace index (1-9, 10 → 0)
export function getDisplayKeyForIndex(index: number): string | null {
  if (index >= 1 && index <= 9) return String(index);
  if (index === 10) return '0';
  return null;
}
```

**Note**: With the Alt+X approach, action key matching is no longer needed in the frontend because Tauri handles all shortcut registration and emits specific events for each action.

---

## Test Setup

### Mock Tauri Events

Since shortcuts are now handled entirely by Tauri (Rust side), frontend tests only need to mock the Tauri event listener:

```typescript
// In src/test/setup.ts - @tauri-apps/api/event is already mocked
// Use the existing mockEmit helper to simulate shortcut events

// Example test:
import { mockEmit } from './setup';

test('activates shortcut mode on chime-shortcut-activated event', async () => {
  // Simulate Tauri emitting the activation event
  mockEmit('chime-shortcut-activated', null);

  // Assert shortcut mode is active
  expect(get(chimeShortcutActive)).toBe(true);
});

test('navigates up on chime-action-up event when active', async () => {
  chimeShortcutActive.set(true);
  mockEmit('chime-action-up', null);

  // Assert navigation occurred
  // ...
});
```

---

## Implementation Plan (TDD)

### Phase 0: Tauri Plugin Setup

| Step | Action                                                |
| ---- | ----------------------------------------------------- |
| 0.1  | Add `GDK_BACKEND=x11` at start of `run()` in `lib.rs` |
| 0.2  | `cargo add tauri-plugin-global-shortcut` in src-tauri |
| 0.3  | `pnpm add @tauri-apps/plugin-global-shortcut`         |
| 0.4  | Add permissions to `capabilities/default.json`        |
| 0.5  | Register plugin in `lib.rs`                           |
| 0.6  | Test global shortcut works with `pnpm tauri dev`      |

### Phase 1: Central Configuration

| Step | Action                                                        |
| ---- | ------------------------------------------------------------- |
| 1.1  | Write tests for keybindings.ts helper functions               |
| 1.2  | Create `src/lib/config/keybindings.ts` with types and helpers |

**Test cases for helpers:**

- `matchesShortcut()` returns true for exact key match
- `matchesShortcut()` returns true for key in keys array
- `matchesShortcut()` ignores modifier keys in event
- `getJumpIndexFromKey()` returns correct index (1-9, 0→10)
- `getJumpIndexFromKey()` returns null for non-numeric strings
- `getDisplayKeyForIndex()` returns correct display key
- `getDisplayKeyForIndex()` returns null for index > 10

### Phase 2: Keyboard Navigation Store

| Step | Action                                  |
| ---- | --------------------------------------- |
| 2.1  | Write tests for `keyboardNavigation.ts` |
| 2.2  | Implement store to pass tests           |

**Test cases:**

- `chimeShortcutActive` state management (uses `writable()` pattern)
- `modalOpen` state management
- `flatWorkspaceList` derived store from `projects`
- `flatWorkspaceList` updates when projects change
- `flatWorkspaceList` handles empty projects array
- `flatWorkspaceList` handles projects with 0 workspaces
- `navigateUp()` selects previous workspace
- `navigateUp()` crosses project boundary
- `navigateUp()` stays at first workspace (no wrap)
- `navigateDown()` selects next workspace
- `navigateDown()` crosses project boundary
- `navigateDown()` stays at last workspace (no wrap)
- `jumpToIndex()` selects correct workspace
- `jumpToIndex()` does nothing for invalid index
- `getWorkspaceIndex()` returns correct 1-based index
- `handleActionKey()` routes to correct action
- `handleActionKey()` returns false for unhandled keys
- Shortcuts disabled when `modalOpen` is true
- Navigation throttled (50-100ms between calls)

### Phase 3: Keyboard Shortcut Overlay

| Step | Action                                           |
| ---- | ------------------------------------------------ |
| 3.1  | Write tests for `KeyboardShortcutOverlay.svelte` |
| 3.2  | Implement component to pass tests                |

**Test cases:**

- Hidden when `chimeShortcutActive` is false
- Visible when `chimeShortcutActive` is true
- Uses Svelte `transition:fade` for animation
- Correct content from config labels
- Has `role="status"` and `aria-live="polite"` for accessibility
- z-index is 999 (below modals)

### Phase 4: Sidebar Workspace Numbers

| Step | Action                                                       |
| ---- | ------------------------------------------------------------ |
| 4.1  | Write tests for workspace index numbers in `Sidebar.test.ts` |
| 4.2  | Update `Sidebar.svelte` to pass tests                        |

**Test cases:**

- Numbers hidden when `chimeShortcutActive` is false
- Numbers visible when `chimeShortcutActive` is true
- Correct numbering (1-9, 0 for 10th, none for 11th+)
- Numbers span across projects in order
- Uses `getDisplayKeyForIndex()` from config
- Active workspace has `aria-selected="true"` during navigation

### Phase 5: Integration Tests

| Step | Action                                      |
| ---- | ------------------------------------------- |
| 5.1  | Write integration tests for store → UI flow |
| 5.2  | Test complete keyboard navigation scenarios |

**Test cases:**

- Activating shortcut mode shows overlay and workspace numbers
- `Down` navigates AND updates active workspace AND shows visual feedback
- `Up` navigates correctly including cross-project
- `Enter` triggers create dialog action
- `Delete` triggers remove dialog action
- `3` jumps to third workspace
- Rapid navigation is throttled
- Window blur deactivates shortcut mode
- Dialog open prevents shortcut activation

### Phase 6: Tauri Event Handler

| Step | Action                                         |
| ---- | ---------------------------------------------- |
| 6.1  | Write tests for Tauri event handling in layout |
| 6.2  | Implement event listeners in `+layout.svelte`  |

**Test cases:**

- Listens for `chime-shortcut-activated` event
- Activates `chimeShortcutActive` on activation event
- Does not activate when `modalOpen` is true
- Listens for `chime-action-*` events
- Only handles action events when `chimeShortcutActive` is true
- Deactivates on Alt keyup (detected via frontend)
- Deactivates on Escape keydown
- Deactivates on window blur
- Cleans up event listeners on destroy

### Phase 7: Dialog Standardization

| Step | Action                                   |
| ---- | ---------------------------------------- |
| 7.1  | Write tests for dialog keyboard handling |
| 7.2  | Update dialogs to use `DIALOG_SHORTCUTS` |

**Test cases:**

- Enter triggers confirm action
- Escape triggers cancel action
- SetupModal handles Enter (retry) when button visible
- Dialogs set `modalOpen = true` when opened
- Dialogs set `modalOpen = false` when closed

### Phase 8: Focus Management

| Step | Action                                        |
| ---- | --------------------------------------------- |
| 8.1  | Write tests for focus return to iframe        |
| 8.2  | Update components for proper focus management |

**Test cases:**

- Focus returns to iframe after dialog close
- Focus returns to correct iframe after workspace switch
- Focus restoration waits for DOM update (debounce/RAF)
- Focus stays on VS Code during normal operation
- `focusActiveIframe()` handles null/undefined iframe refs

### Phase 9: Validation

| Step | Action                               |
| ---- | ------------------------------------ |
| 9.1  | Run `pnpm test`                      |
| 9.2  | Run `pnpm validate`                  |
| 9.3  | Run `pnpm rust:clippy`               |
| 9.4  | Manual testing with `pnpm tauri dev` |

---

## Edge Cases

| Scenario                           | Behavior                                   |
| ---------------------------------- | ------------------------------------------ |
| Only 1 workspace                   | Up/Down stays on same (wrap has no effect) |
| No workspaces                      | All navigation disabled                    |
| At first workspace + Up            | Wraps to last workspace                    |
| At last workspace + Down           | Wraps to first workspace                   |
| More than 10 workspaces            | Only first 10 get numbers, rest use ↑↓     |
| Modal dialog open                  | Shortcut activation blocked                |
| Active workspace being removed     | Auto-select next/previous                  |
| Alt released                       | Deactivate shortcut mode                   |
| Escape pressed while active        | Deactivate shortcut mode                   |
| Window loses focus                 | Deactivate shortcut mode                   |
| Jump to non-existent index         | Do nothing                                 |
| Rapid key presses                  | Throttle navigation (50-100ms)             |
| Global shortcut registration fails | Silently ignored (for now)                 |
| Component unmount during active    | Cleanup fires, state reset                 |
| Alt+X when already active          | Stays active (no toggle)                   |

---

## Platform Considerations

| Platform            | Consideration                                                         |
| ------------------- | --------------------------------------------------------------------- |
| **Windows**         | `Alt` triggers menu bar focus in some apps, but `Alt+X` usually works |
| **macOS**           | `Alt/Option+X` types special character `≈` - may need different key   |
| **Linux (X11)**     | Works natively via X11 global hotkeys                                 |
| **Linux (Wayland)** | Works via XWayland (forced by `GDK_BACKEND=x11` in app startup)       |

**Note**: The activation key (`Alt+X`) will be made configurable in the future. If conflicts arise on specific platforms, alternative modifiers can be used.

---

## Accessibility

| Feature                  | Implementation                                     |
| ------------------------ | -------------------------------------------------- |
| Overlay announcement     | `role="status"` and `aria-live="polite"`           |
| Current workspace        | `aria-selected="true"` on active workspace         |
| Focus capture element    | `role="application"` with descriptive `aria-label` |
| Keyboard discoverability | Overlay shows available shortcuts                  |
| Focus management         | Focus returns to expected element after actions    |

---

## Expert Review Findings (Incorporated)

### From Rust Expert

- ✅ Fixed: Release detection now uses frontend `keyup` listener
- ✅ Added: `dialog:default` permission
- ✅ Added: Documentation for Wayland limitations
- ✅ Added: Error handling for registration failures
- ✅ Added: Fire-and-forget pattern for `onDestroy`

### From Software Architect

- ✅ Added: Focus restoration with debounce/requestAnimationFrame
- ✅ Added: Throttling for navigation (50-100ms)
- ✅ Added: Error handling for shortcut registration
- ✅ Confirmed: Reuse `setActiveWorkspace()` from existing `projects.ts`
- ✅ Added: Track registration state to prevent double-registration
- Considered: State machine for navigation mode (optional enhancement)

### From Frontend/Svelte Expert

- ✅ Fixed: `onDestroy` uses fire-and-forget pattern (not async)
- ✅ Added: `pnpm add @tauri-apps/plugin-global-shortcut`
- ✅ Changed: Use `<div tabindex="-1">` instead of hidden `<input>`
- ✅ Added: Window blur handler via `<svelte:window on:blur>`
- ✅ Added: `aria-label` on focus capture element
- ✅ Changed: `aria-selected` instead of `aria-current` for workspace items
- ✅ Added: Error handling for `register()` failure

### From Testing Expert

- ✅ Added: Global mock for Tauri plugin in `src/test/setup.ts`
- ✅ Added: Helper to simulate global shortcut in tests
- ✅ Reordered: Integration tests (Phase 5) before global handler (Phase 6)
- ✅ Added: Throttle/debounce test cases
- ✅ Added: Edge case tests for empty states, invalid indices
- ✅ Added: Tests for registration failure handling
- ✅ Added: Tests for focus intent (spy on `.focus()`)

---

## Benefits of This Design

| Benefit                      | Description                                       |
| ---------------------------- | ------------------------------------------------- |
| **Single source of truth**   | Change a shortcut in one place, all code updates  |
| **Works with iframe**        | Tauri global shortcuts bypass iframe focus issues |
| **Robust release detection** | Frontend keyup handles all release scenarios      |
| **Testable**                 | Config helpers and store logic can be unit tested |
| **Documentation**            | Config file serves as documentation               |
| **Consistency**              | UI labels and handlers always match               |
| **Extensibility**            | Easy to add new shortcuts later                   |
| **Non-intrusive**            | Doesn't conflict with VS Code shortcuts           |
| **Discoverable**             | Overlay teaches users the shortcuts               |
| **Accessible**               | Screen reader support via ARIA attributes         |
| **Cross-platform**           | Works on Windows, macOS, Linux (X11)              |
