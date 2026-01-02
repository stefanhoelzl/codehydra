---
status: COMPLETED
last_updated: 2026-01-02
reviewers: [review-ui, review-typescript, review-docs]
---

# DICTATION_BACKGROUND_TAB

## Overview

- **Problem**: The current dictation audio capture uses a bottom panel that appears/disappears when recording starts/stops. This is intrusive and distracting to the user's workflow.
- **Solution**:
  1. Change from panel view (`WebviewViewProvider`) to editor tab (`WebviewPanel`)
  2. Keep the tab running in background with `retainContextWhenHidden: true`
  3. Open tab in `ViewColumn.One` without stealing focus using `preserveFocus: true`
  4. Auto-open during startup only if API key is configured
  5. Show transcribed text in accessible, scrollable log area
- **Risks**:
  - WebviewPanel lifecycle differs from WebviewViewProvider - mitigated by careful state management and `isDisposing` flag
  - Tab could be accidentally closed during recording - mitigated by recreating on next F10
  - Race condition on panel disposal - mitigated by disposal state tracking
- **Alternatives Considered**:
  - Keep panel but make it smaller: Rejected - still intrusive with open/close animation
  - Use notification area: Rejected - can't run webview for audio capture there
  - `ViewColumn.Beside`: Rejected - creates split view, would steal visual focus

## Behavior Summary

| Event               | No API Key    | Has API Key                 |
| ------------------- | ------------- | --------------------------- |
| Extension activates | Do nothing    | Create panel in background  |
| F10 pressed         | Open settings | Start/stop recording        |
| Escape pressed      | Nothing       | Cancel recording (no Enter) |
| Status bar click    | Open settings | Start/stop recording        |
| Recording stops     | N/A           | Tab stays open (not closed) |

## Architecture

### Current vs New

```
CURRENT (Panel View):                    NEW (Editor Tab):
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Editor                     │         │  Dictation │  Editor       │
│                             │         │  (bg tab)  │  (focused)    │
│                             │         │            │               │
├─────────────────────────────┤         │            │               │
│  Panel (appears/disappears) │         │            │               │
│  [Dictation Audio Capture]  │         │            │               │
└─────────────────────────────┘         └─────────────────────────────┘
        ↑                                        ↑
    Intrusive!                           Opens in ViewColumn.One,
                                         preserveFocus keeps editor active
```

### Webview Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Webview Panel Lifecycle                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Extension activates                                                       │
│          │                                                                  │
│          ▼                                                                  │
│   ┌──────────────┐                                                          │
│   │ Check config │                                                          │
│   │ (API key?)   │                                                          │
│   └──────────────┘                                                          │
│          │                                                                  │
│          ├───────────────────────────────────┐                              │
│          │                                   │                              │
│          ▼                                   ▼                              │
│   ┌──────────────┐                    ┌──────────────┐                      │
│   │   NO KEY     │                    │   HAS KEY    │                      │
│   └──────────────┘                    └──────────────┘                      │
│          │                                   │                              │
│          ▼                                   ▼                              │
│   ┌──────────────┐                    ┌──────────────┐                      │
│   │ Do nothing   │                    │ Create panel │                      │
│   │ (end)        │                    │ (background) │                      │
│   └──────────────┘                    │              │                      │
│                                       │ ViewColumn.1 │                      │
│                                       │ preserveFocus│                      │
│                                       │ retainContext│                      │
│                                       └──────────────┘                      │
│                                              │                              │
│                                              ▼                              │
│                                       ┌──────────────┐                      │
│                                       │ Panel ready  │                      │
│                                       │ (background) │                      │
│                                       └──────────────┘                      │
│                                              │                              │
│                                              │  User presses F10            │
│                                              ▼                              │
│                                       ┌──────────────┐                      │
│                                       │ Recording    │                      │
│                                       │ (active)     │                      │
│                                       └──────────────┘                      │
│                                              │                              │
│                                              │  User stops (F10/Esc)        │
│                                              ▼                              │
│                                       ┌──────────────┐                      │
│                                       │ Panel ready  │◄── Tab stays open    │
│                                       │ (background) │    (not closed)      │
│                                       └──────────────┘                      │
│                                              │                              │
│                                              │  User closes tab manually    │
│                                              ▼                              │
│                                       ┌──────────────┐                      │
│                                       │ Panel closed │                      │
│                                       │ isDisposing  │◄── Race condition    │
│                                       │ flag set     │    protection        │
│                                       └──────────────┘                      │
│                                              │                              │
│                                              │  User presses F10 again      │
│                                              ▼                              │
│                                       ┌──────────────┐                      │
│                                       │ Recreate     │                      │
│                                       │ panel        │                      │
│                                       └──────────────┘                      │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   F10 Pressed (when no API key configured):                                 │
│                                                                             │
│          ┌──────────────┐                                                   │
│          │ F10 pressed  │                                                   │
│          └──────────────┘                                                   │
│                 │                                                           │
│                 ▼                                                           │
│          ┌──────────────┐                                                   │
│          │ Open settings│                                                   │
│          │ (filtered to │                                                   │
│          │  dictation)  │                                                   │
│          └──────────────┘                                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Startup Flow with Sidekick

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CodeHydra Startup Flow                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   code-server starts                                                        │
│          │                                                                  │
│          ▼                                                                  │
│   Sidekick extension activates                                              │
│          │                                                                  │
│          ▼                                                                  │
│   Execute startup commands:                                                 │
│   1. workbench.action.closeSidebar                                          │
│   2. workbench.action.closeAuxiliaryBar                                     │
│   3. workbench.action.terminal.toggleTerminal                               │
│   4. opencode.openTerminal                                                  │
│   5. codehydra.dictation.openPanel  ◄─── Does nothing if no API key         │
│          │                               (AFTER opencode.openTerminal)      │
│          ▼                                                                  │
│   If configured: Dictation tab in background                                │
│   OpenCode chat visible as main editor                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## UI Design

### Status Bar (unchanged)

The status bar icons remain as currently implemented:

| State               | Icon              | Color    |
| ------------------- | ----------------- | -------- |
| Idle                | `$(record)`       | Default  |
| Not configured      | `$(record)`       | Disabled |
| Loading             | `$(loading~spin)` | Default  |
| Listening (silence) | `$(mic)`          | Orange   |
| Active (speech)     | `$(mic-filled)`   | Green    |
| Stopping            | `$(loading~spin)` | Default  |
| Error               | `$(error)`        | Red      |

### Tab Icon

The tab icon is always `$(mic)` - it does not change with recording state.

### Webview HTML Structure (Accessible)

The webview uses semantic HTML with ARIA attributes for accessibility:

```html
<body>
  <header>
    <h1><span class="codicon codicon-mic"></span> Dictation</h1>
  </header>

  <main>
    <section aria-labelledby="status-heading">
      <h2 id="status-heading" class="visually-hidden">Status</h2>
      <p id="status" aria-live="polite">Ready</p>
    </section>

    <section aria-labelledby="shortcuts-heading">
      <h2 id="shortcuts-heading">Shortcuts</h2>
      <ul>
        <li><kbd>F10</kbd> - Start/Stop recording</li>
        <li><kbd>Escape</kbd> - Cancel recording</li>
      </ul>
    </section>

    <section aria-labelledby="log-heading">
      <h2 id="log-heading">Log</h2>
      <div id="log-container">
        <div id="log" role="log" aria-live="polite" aria-relevant="additions">
          <!-- Log entries appended here -->
        </div>
        <button id="jump-to-latest" class="hidden">Jump to latest</button>
      </div>
    </section>
  </main>
</body>
```

### Editor Tab Appearance - Ready State

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Tab Bar                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐                                │
│  │ main.ts  │ │ index.ts │ │ [mic] Dictate │                                │
│  └──────────┘ └──────────┘ └───────────────┘                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │   [mic] Dictation                           [Clear Log]             │   │
│  │                                                                     │   │
│  │   Status: Ready                                                     │   │
│  │                                                                     │   │
│  │   Shortcuts                                                         │   │
│  │   • F10 - Start/Stop recording (+ Enter)                            │   │
│  │   • Escape - Cancel recording (no Enter)                            │   │
│  │                                                                     │   │
│  │   ─────────────────────────────────────────────────────────────     │   │
│  │                                                                     │   │
│  │   Log                                                               │   │
│  │   ┌────────────────────────────────────────────────────────────┐   │   │
│  │   │ [12:34:56] Ready                                           │   │   │
│  │   │                                                            │   │   │
│  │   │                                                            │   │   │
│  │   │                                            (scrollable)    │   │   │
│  │   └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Note: [mic] represents the codicon-mic icon, not emoji
```

### Editor Tab Appearance - Recording with Transcriptions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │ (green left border indicates active recording)               │   │   │
│  │  └──────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  │   [mic] Dictation                           [Clear Log]             │   │
│  │                                                                     │   │
│  │   Status: [circle] Recording (0:15)                                 │   │
│  │                                                                     │   │
│  │   Shortcuts                                                         │   │
│  │   • F10 - Stop recording (+ Enter)                                  │   │
│  │   • Escape - Cancel recording (no Enter)                            │   │
│  │                                                                     │   │
│  │   ─────────────────────────────────────────────────────────────     │   │
│  │                                                                     │   │
│  │   Log                                                               │   │
│  │   ┌────────────────────────────────────────────────────────────┐   │   │
│  │   │ [12:34:56] Ready                                           │   │   │
│  │   │ [12:35:10] Recording started                               │   │   │
│  │   │ [12:35:12] "Hello, this is a test"           (transcript)  │   │   │
│  │   │ [12:35:15] "of the dictation feature."       (transcript)  │   │   │
│  │   │ [12:35:18] "It should show all transcriptions here."       │   │   │
│  │   │                                                            │   │   │
│  │   │                   [Jump to latest] (if scrolled up)        │   │   │
│  │   └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Note: [circle] represents codicon-circle-filled for recording indicator
```

### Editor Tab Appearance - Error State

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  │   Log                                                               │   │
│  │   ┌────────────────────────────────────────────────────────────┐   │   │
│  │   │ [12:34:56] Ready                                           │   │   │
│  │   │ [12:35:10] Recording started                               │   │   │
│  │   │ [12:35:12] [error] Connection lost (role="alert")          │   │   │
│  │   │           ^^^^^^^^ red color, error icon                   │   │   │
│  │   └────────────────────────────────────────────────────────────┘   │   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Editor Tab Appearance - Unconfigured Empty State

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │   [mic] Dictation                                                   │   │
│  │                                                                     │   │
│  │   ┌─────────────────────────────────────────────────────────────┐   │   │
│  │   │                                                             │   │   │
│  │   │   [settings-gear] Configure Dictation                       │   │   │
│  │   │                                                             │   │   │
│  │   │   To use voice dictation, you need to configure an          │   │   │
│  │   │   AssemblyAI API key in settings.                           │   │   │
│  │   │                                                             │   │   │
│  │   │   [Open Settings]                                           │   │   │
│  │   │                                                             │   │   │
│  │   └─────────────────────────────────────────────────────────────┘   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Note: This view only appears if user manually opens tab without API key configured
```

### CSS Theming

Use VS Code CSS variables for consistent theming:

```css
body {
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

.recording-indicator {
  border-left: 3px solid var(--vscode-testing-iconPassed); /* green */
}

.transcript {
  color: var(--vscode-textLink-foreground);
}

.error {
  color: var(--vscode-errorForeground);
}

.timestamp {
  color: var(--vscode-descriptionForeground);
}

kbd {
  background-color: var(--vscode-keybindingLabel-background);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-radius: 3px;
  padding: 2px 4px;
}

#jump-to-latest {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
```

## Implementation Steps

- [x] **Step 1: Define transcript message type**
  - Add `TranscriptMessage` type to `src/audio/types.ts`: `{ type: "transcript"; text: string; timestamp: number }`
  - Add `ErrorMessage` type: `{ type: "error"; message: string; timestamp: number }`
  - Add `StatusMessage` type: `{ type: "status"; status: string; duration?: number }`
  - Files: `src/audio/types.ts`
  - Test criteria: Types compile, used in subsequent steps

- [x] **Step 2: Create AudioCapturePanel class**
  - Create `src/audio/AudioCapturePanel.ts` using `vscode.window.createWebviewPanel`
  - Configure: `retainContextWhenHidden: true`, `enableScripts: true`
  - Use `ViewColumn.One` (not `ViewColumn.Beside`) with `preserveFocus: true`
  - Singleton pattern: store panel reference, recreate if closed
  - Add `isDisposing` flag to prevent race conditions during disposal
  - Add disposal handler that sets flag before cleanup
  - `open()` does nothing if no API key configured
  - Set tab icon to codicon `mic` (static, doesn't change)
  - Keep existing audio message handling logic
  - Add `logTranscript(text: string)` method - sends typed `TranscriptMessage`
  - Add `logError(message: string)` method - sends typed `ErrorMessage`
  - Add `updateStatus(status: string, duration?: number)` method
  - Add `clearLog()` method
  - Files: `src/audio/AudioCapturePanel.ts`
  - Test criteria: Panel created in background, does nothing if no key, disposal is safe

- [x] **Step 3: Update webview HTML for editor tab with accessibility**
  - Use semantic HTML: `<header>`, `<main>`, `<section>`, proper heading hierarchy
  - Add ARIA live regions: `aria-live="polite"` on status, `role="log"` on log container
  - Use VS Code CSS variables for theming (no hardcoded colors)
  - Use Codicons (via CSS class `codicon codicon-mic`) instead of emoji
  - Add visual recording indicator (green left border when recording)
  - Show helpful instructions with `<kbd>` elements for shortcuts
  - Show recording status and duration
  - Add "Clear Log" button in header
  - Implement smart auto-scroll: only auto-scroll if user is at bottom
  - Add "Jump to latest" button when user scrolls up during updates
  - Style transcriptions differently (quoted, link color)
  - Show errors with `role="alert"` and error styling
  - Add empty state / onboarding message for unconfigured state
  - Files: `src/audio/webview.html`
  - Test criteria: Tab looks clean, accessible, scrolls correctly, themed properly

- [x] **Step 4: Add openPanel command**
  - Register `codehydra.dictation.openPanel` command
  - Command calls `AudioCapturePanel.open()`
  - Does nothing if not configured (for startup use) - no error, silent no-op
  - Files: `src/commands.ts`, `src/extension.ts`, `package.json`
  - Test criteria: Command opens panel in background, silent if no key

- [x] **Step 5: Update DictationController**
  - Change from `AudioCaptureViewProvider` to `AudioCapturePanel`
  - F10 without API key → open settings (filtered to `codehydra.dictation`)
  - F10 with API key → start/stop recording
  - Ensure panel is open before starting (auto-create if closed)
  - Send transcript text to panel via `logTranscript()` method
  - Send errors to panel via `logError()` method
  - Update status via `updateStatus()` method
  - Tab stays open after recording stops (no close behavior)
  - Remove visibility change handling (panel stays alive in background)
  - Files: `src/DictationController.ts`, `src/extension.ts`
  - Test criteria: Recording works, F10 without key opens settings, transcripts/errors logged

- [x] **Step 6: Remove panel view registration**
  - Remove `viewsContainers.panel` from package.json
  - Remove `views.codehydra-dictation` from package.json
  - Remove `AudioCaptureViewProvider` registration from extension.ts
  - Delete old `AudioCaptureViewProvider.ts` file
  - Files: `package.json`, `src/extension.ts`, `src/audio/AudioCaptureViewProvider.ts`
  - Test criteria: No more bottom panel, only editor tab

- [x] **Step 7: Add to sidekick startup commands**
  - Add `codehydra.dictation.openPanel` to startup command sequence
  - Execute AFTER `opencode.openTerminal` command (position 5 in sequence)
  - Command does nothing if not configured, safe to always call
  - Files: `extensions/sidekick/extension.js`
  - Test criteria: Dictation tab opens on startup if configured

- [x] **Step 8: Update AGENTS.md**
  - Add `codehydra.dictation.openPanel` to Plugin Startup Commands documentation
  - Document that command is no-op when API key not configured
  - Files: `AGENTS.md`
  - Test criteria: Documentation accurate

- [x] **Step 9: Update integration tests**
  - Update tests to use new AudioCapturePanel
  - Add tests for no-op when not configured
  - Add tests for F10 opening settings when not configured
  - Add tests for panel recreation after close
  - Add tests for `isDisposing` flag preventing race conditions
  - Add tests for transcript logging with typed messages
  - Add tests for error logging
  - Add tests for status updates
  - Files: `src/DictationController.integration.test.ts`, `src/audio/AudioCapturePanel.test.ts`
  - Test criteria: All tests pass

- [x] **Step 10: Update extension documentation**
  - Update README with new tab-based behavior
  - Document startup behavior
  - Document accessibility features
  - Files: `extensions/dictation/README.md`
  - Test criteria: Documentation accurate

## Testing Strategy

### Integration Tests

| #   | Test Case                         | Entry Point                      | Boundary Mocks | Behavior Verified                           |
| --- | --------------------------------- | -------------------------------- | -------------- | ------------------------------------------- |
| 1   | Panel opens in ViewColumn.One     | `AudioCapturePanel.open()`       | vscode.window  | Panel created with preserveFocus: true      |
| 2   | No-op without API key             | `AudioCapturePanel.open()`       | config         | Nothing happens, no error                   |
| 3   | F10 without key opens settings    | `controller.toggle()`            | config         | Settings opened with filter                 |
| 4   | Panel survives tab switch         | `panel.start()` + hide panel     | vscode.window  | Audio capture continues                     |
| 5   | Panel recreated after close       | Close panel + `start()`          | vscode.window  | New panel created                           |
| 6   | Disposal race condition prevented | Rapid close + operations         | vscode.window  | isDisposing flag prevents errors            |
| 7   | Transcripts logged with type      | `controller` receives transcript | MockPanel      | `logTranscript()` called with typed message |
| 8   | Errors logged to panel            | `controller` receives error      | MockPanel      | `logError()` called, shows in log           |
| 9   | Status updates sent to panel      | `controller.start()`             | MockPanel      | `updateStatus()` called                     |
| 10  | Tab stays open after stop         | `controller.stop()`              | MockPanel      | Panel not disposed                          |

### Manual Testing Checklist

- [ ] With API key: tab opens on startup in background (ViewColumn.One)
- [ ] With API key: OpenCode chat remains focused after startup
- [ ] Without API key: no tab opens, no error
- [ ] F10 with key: recording starts, tab stays in background
- [ ] F10 without key: settings open (filtered to dictation)
- [ ] Switch to other files while recording - recording continues
- [ ] Transcriptions appear in the log area with timestamps
- [ ] Transcriptions styled differently (link color, quoted)
- [ ] Errors appear with error styling and alert role
- [ ] Log area scrolls automatically when at bottom
- [ ] Log area shows "Jump to latest" when scrolled up
- [ ] "Clear Log" button works
- [ ] Green border appears during recording
- [ ] F10 again: recording stops, Enter emitted, tab stays open
- [ ] Escape while recording: recording stops, NO Enter, tab stays open
- [ ] Close tab manually, press F10: tab reopens, recording starts
- [ ] Tab icon is always mic codicon (doesn't change)
- [ ] Status bar icons work as before
- [ ] Screen reader announces status changes (aria-live)
- [ ] Keyboard navigation works within webview
- [ ] Colors match VS Code theme (try light and dark themes)

## Dependencies

No new dependencies required.

| Package | Purpose | Approved |
| ------- | ------- | -------- |
| (none)  | N/A     | N/A      |

## Documentation Updates

### Files to Update

| File                             | Changes Required                                     |
| -------------------------------- | ---------------------------------------------------- |
| `extensions/dictation/README.md` | Update to describe tab-based audio capture           |
| `AGENTS.md`                      | Add startup command to Plugin Startup Commands table |

### New Documentation Required

| File   | Purpose |
| ------ | ------- |
| (none) | N/A     |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
