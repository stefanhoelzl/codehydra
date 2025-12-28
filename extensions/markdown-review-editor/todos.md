# Future Upgrade Todos

This document tracks planned upgrades beyond the minimal migration.

---

## Phase 2: Custom Editor (File-Bound Documents) - COMPLETED

Implemented dual-mode architecture supporting both Virtual Documents and File-Bound Custom Editor.

### Completed Tasks

- [x] Create `CustomEditorProvider` implementation (`custom-editor-provider.ts`)
  - Implemented `openCustomDocument`, `resolveCustomEditor`
  - Implemented `saveCustomDocument`, `saveCustomDocumentAs`
  - Implemented `revertCustomDocument`, `backupCustomDocument`

- [x] Register provider in `package.json` with `priority: "default"` for `.md` files

- [x] Implement document synchronization:
  - Track dirty state via VS Code's CustomDocument events
  - Handle external file changes with file watcher and reload dialog
  - Webview-authoritative model (no constant sync overhead)

- [x] Create `VirtualDocumentProvider` (`virtual-document-provider.ts`)
  - Demo content on first open
  - Workspace state persistence on: Apply, Hidden, Close, Deactivate
  - Separate from file-bound mode

- [x] Create shared `webview-manager.ts` for common webview logic

- [x] UI changes:
  - Removed Load/Store buttons (replaced with Save As)
  - Show file name in toolbar (file mode)
  - External change dialog with Reload/Keep options
  - VS Code handles dirty indicator in file mode

- [x] Undo/redo: Basic implementation (revert to saved state)

### Implementation Notes

- Used `CustomEditorProvider` (not `CustomTextEditorProvider`) for full control
- Webview-authoritative model avoids constant sync overhead
- Virtual mode auto-saves to workspace state, no explicit save needed

---

## Phase 3: Advanced VS Code Features

### Commands in Command Palette

- [ ] Register additional commands:

  ```json
  "contributes": {
    "commands": [
      {
        "command": "markdownReviewEditor.applyComments",
        "title": "Apply Comments to AI",
        "category": "Markdown Review"
      },
      {
        "command": "markdownReviewEditor.clearAnnotations",
        "title": "Clear All Annotations",
        "category": "Markdown Review"
      },
      {
        "command": "markdownReviewEditor.exportDocument",
        "title": "Export Document",
        "category": "Markdown Review"
      }
    ]
  }
  ```

- [ ] Add keybindings:
  ```json
  "contributes": {
    "keybindings": [
      {
        "command": "markdownReviewEditor.applyComments",
        "key": "ctrl+shift+a",
        "when": "markdownReviewEditor.active"
      }
    ]
  }
  ```

### Status Bar Integration

- [ ] Show annotation count in status bar
- [ ] Show AI processing status (idle/processing)
- [ ] Quick actions via status bar clicks

### Context Menu Integration

- [ ] Add "Open with Markdown Review Editor" to file explorer context menu:
  ```json
  "contributes": {
    "menus": {
      "explorer/context": [{
        "command": "markdownReviewEditor.openFile",
        "when": "resourceExtname == .md",
        "group": "navigation"
      }]
    }
  }
  ```

### Settings UI

- [ ] Register extension settings:
  ```json
  "contributes": {
    "configuration": {
      "title": "Markdown Review Editor",
      "properties": {
        "markdownReviewEditor.autoSave": {
          "type": "boolean",
          "default": false,
          "description": "Automatically save after AI applies changes"
        },
        "markdownReviewEditor.diffWordMergeCount": {
          "type": "number",
          "default": 5,
          "description": "Number of words to merge nearby changes in diff view"
        }
      }
    }
  }
  ```

### Activity Bar / Sidebar

- [ ] Add dedicated activity bar icon (optional)
- [ ] Create sidebar view for:
  - Document list / recent files
  - Annotation summary
  - AI session history

### Workspace Trust

- [ ] Respect workspace trust settings
- [ ] Disable AI features in untrusted workspaces (security)

### Telemetry (Optional)

- [ ] Add opt-in usage telemetry
- [ ] Track feature usage for improvement

### Localization

- [ ] Extract strings to `package.nls.json`
- [ ] Support multiple languages

### Estimated Effort

- Commands/Keybindings: 1 hour
- Status Bar: 1-2 hours
- Context Menus: 30 minutes
- Settings: 1 hour
- Activity Bar/Sidebar: 3-4 hours
- Other: Variable

---

## Phase 4: Integration with VS Code Markdown Preview

- [ ] Explore sync between built-in Markdown Preview and Review Editor
- [ ] Consider using VS Code's Markdown language features
- [ ] Investigate custom Markdown-it plugins for annotation rendering

---

## Notes

### Upgrade Path Design Decisions (Current Implementation)

1. **Message protocol is storage-agnostic**: The webview sends `documentChanged` and `requestSave` messages without knowing if content is virtual or file-bound.

2. **DocumentProvider interface**: Extension host uses abstract interface that can be swapped from `VirtualDocumentProvider` to `FileDocumentProvider`.

3. **Load/Store buttons remain**: These work via messages and can be hidden later via CSS or conditional rendering.

4. **Theme is inherited**: Already using VS Code theme colors, no manual toggle needed.
