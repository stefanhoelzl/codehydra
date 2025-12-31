---
status: COMPLETED
last_updated: 2026-01-01
reviewers: [review-typescript, review-testing, review-docs, review-ui]
---

# DICTATION_EXTENSION

## Overview

- **Problem**: Developers need to input text via voice for faster coding, documentation, or accessibility. Current solutions require leaving the IDE or using external tools.
- **Solution**: A VS Code extension that captures microphone audio via Web Audio API (in a webview), streams it to a cloud speech-to-text provider, and inserts transcribed text at the cursor position in real-time.
- **Risks**:
  - Microphone permission handling varies across platforms
  - WebSocket connection stability for streaming
  - Audio quality/noise affecting transcription accuracy
- **Alternatives Considered**:
  - **Node.js audio packages (SoX, mic)**: Rejected - requires external binary installation
  - **Browser extension**: Rejected - doesn't integrate with VS Code editor
  - **Local STT models**: Rejected - significant resource usage, complexity; can be added as provider later

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐     ┌───────────────────┐     ┌────────────────┐  │
│  │   Commands   │────▶│    Dictation      │◀───▶│   Status Bar   │  │
│  │  start/stop  │     │    Controller     │     │   (icon only)  │  │
│  └──────────────┘     └─────────┬─────────┘     └────────────────┘  │
│                                 │                                    │
│                    ┌────────────┴────────────┐                      │
│                    ▼                         ▼                      │
│         ┌──────────────────┐      ┌──────────────────┐              │
│         │  AudioCapture    │      │  STT Provider    │              │
│         │  (Webview Mgr)   │      │  (Interface)     │              │
│         └────────┬─────────┘      └────────┬─────────┘              │
│                  │                         │                        │
│                  │              ┌──────────┴──────────┐              │
│                  │              ▼                     ▼              │
│                  │   ┌──────────────────┐  ┌──────────────────┐     │
│                  │   │   AssemblyAI     │  │  (Future)        │     │
│                  │   │   Provider       │  │  Other Provider  │     │
│                  │   └──────────────────┘  └──────────────────┘     │
│                  │                                                   │
│  ┌───────────────▼───────────────────────────────────────────────┐  │
│  │                   Hidden Webview Panel                         │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  navigator.mediaDevices.getUserMedia()                  │  │  │
│  │  │  AudioWorkletNode (downsampling to 16kHz PCM)           │  │  │
│  │  │  postMessage() → audio chunks to extension              │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (via SDK)
                                    ▼
                    ┌───────────────────────────────────┐
                    │   AssemblyAI Streaming API        │
                    │   wss://streaming.assemblyai      │
                    │         .com/v3/ws                │
                    └───────────────────────────────────┘
```

### Data Flow

```
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌───────────┐    ┌────────┐
│  Mic    │───▶│ Webview │───▶│ Extension│───▶│ Provider  │───▶│ Cloud  │
│ (Web    │    │ (PCM    │    │ (forward │    │ (SDK      │    │ STT    │
│  Audio) │    │  chunks)│    │  audio)  │    │  stream)  │    │ API    │
└─────────┘    └─────────┘    └──────────┘    └───────────┘    └────────┘
                                                                    │
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌───────────┐         │
│ Editor  │◀───│ Type    │◀───│ Extension│◀───│ Provider  │◀────────┘
│ (cursor │    │ command │    │ (on turn │    │ (SDK      │   transcript
│  insert)│    │         │    │  event)  │    │  event)   │
└─────────┘    └─────────┘    └──────────┘    └───────────┘
```

### Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Connection Strategy                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  User clicks "Start"                                                 │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐            │
│  │  Connect    │────▶│   Begin     │────▶│  Streaming  │            │
│  │  (SDK)      │     │   Session   │     │   Audio     │            │
│  └─────────────┘     └─────────────┘     └──────┬──────┘            │
│                                                 │                    │
│                          ┌──────────────────────┼──────────────┐     │
│                          ▼                      ▼              ▼     │
│                   User stops            Timeout reached   Conn lost  │
│                          │              (maxDuration)          │     │
│                          ▼                      │              ▼     │
│                   ┌─────────────┐               │       ┌──────────┐ │
│                   │  Close      │◀──────────────┘       │ Show Err │ │
│                   │  (SDK)      │       │               │ Notif    │ │
│                   └─────────────┘       ▼               └──────────┘ │
│                          │        ┌──────────┐                │      │
│                          │        │ Show     │                │      │
│                          │        │ Timeout  │                │      │
│                          │        │ Notif    │                │      │
│                          │        └──────────┘                │      │
│                          ▼              │                     ▼      │
│                   ┌─────────────┐       │              ┌──────────┐  │
│                   │  Idle       │◀──────┘              │ Reset to │  │
│                   │  State      │                      │ Idle     │  │
│                   └─────────────┘                      └──────────┘  │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Key Points:                                                         │
│  • Connect on recording start (cost-effective, per-session billing)  │
│  • Auto-stop after maxDuration (default 60s) to limit costs          │
│  • Show notification when maxDuration reached                        │
│  • SDK handles graceful termination automatically                    │
│  • On connection loss: show error, reset to idle, user can restart   │
└─────────────────────────────────────────────────────────────────────┘
```

### State Machine

```typescript
type DictationState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startTime: number; sessionId: string }
  | { status: "stopping" };
```

**Valid transitions:**

- `idle` → `starting` (user starts)
- `starting` → `recording` (connection established)
- `starting` → `idle` (connection failed, user cancels)
- `recording` → `stopping` (user stops, timeout, error)
- `stopping` → `idle` (cleanup complete)

## UI Design

### Status Bar Item (Icon Only, With Color)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ... other status items ...  │ [mic] │  ... other items ...         │
└─────────────────────────────────────────────────────────────────────┘

Visibility:
  - Always visible when API key is configured
  - Show dimmed with "Not configured" tooltip when no API key set

States (icon only, no text):
  ○ Idle:         $(mic)           - default colors
  ○ Unconfigured: $(mic)           - dimmed/disabled appearance
  ◐ Starting:     $(loading~spin)  - default colors
  ● Recording:    $(mic-filled)    - warning background (statusBarItem.warningBackground)

Tooltip:
  - Unconfigured: "Dictation: Not configured. Click to open settings."
  - Idle: "Dictation: Click to start (Ctrl+Alt+D)"
  - Starting: "Dictation: Connecting..."
  - Recording: "Dictation: Recording (45s / 60s)"
```

### User Interactions

1. **Start Recording**:
   - Keyboard shortcut: `Ctrl+Alt+D` (configurable)
   - Command palette: "Dictation: Start Recording"
   - Status bar click (when idle)

2. **Stop Recording**:
   - Same keyboard shortcut: `Ctrl+Alt+D` (toggle)
   - Escape key
   - Command palette: "Dictation: Stop Recording"
   - Status bar click (when recording)
   - **Automatic**: When `maxDuration` timeout reached

3. **During "Starting" State**:
   - Toggle command is ignored (show notification: "Dictation: Already connecting...")
   - Wait for connection to establish or fail

4. **Notifications** (only shown on errors/events):
   - Missing API key: "Dictation: No API key configured. Please set codehydra.dictation.assemblyai.apiKey in settings."
   - Connection failed: "Dictation: Failed to connect to speech service. Check your internet connection."
   - Connection lost: "Dictation: Connection lost. Recording stopped."
   - Microphone denied: "Dictation: Microphone access denied. Please allow microphone access."
   - No active editor: "Dictation: No active editor. Open a file to use dictation."
   - Invalid API key: "Dictation: Invalid API key. Please check your settings."
   - **Max duration reached**: "Dictation: Recording stopped. Maximum duration (60s) reached."

## Type Definitions

### Webview Message Protocol

```typescript
// Extension → Webview
type ToWebviewMessage = { type: "start" } | { type: "stop" };

// Webview → Extension
type FromWebviewMessage =
  | { type: "audio"; data: ArrayBuffer }
  | { type: "started" }
  | { type: "stopped" }
  | {
      type: "error";
      code: "PERMISSION_DENIED" | "NOT_FOUND" | "NOT_READABLE" | "UNKNOWN";
      message: string;
    };
```

### Provider Interface

```typescript
interface SpeechToTextProvider extends vscode.Disposable {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(buffer: ArrayBuffer): void;
  onTranscript(handler: (text: string) => void): () => void; // Returns unsubscribe
  onError(handler: (error: DictationError) => void): () => void; // Returns unsubscribe
}

type DictationError =
  | { type: "connection"; message: string }
  | { type: "permission"; message: string }
  | { type: "auth"; message: string }
  | { type: "provider"; code: number; message: string };
```

## Implementation Steps

- [x] **Step 1: Extension scaffolding**
  - Create `extensions/dictation/` directory structure
  - Set up `package.json` with extension metadata, commands, configuration, `assemblyai` dependency
  - Set up `esbuild.config.js` for TypeScript bundling (handle `.ts` files)
  - Create `.vscodeignore` for packaging
  - Files: `extensions/dictation/package.json`, `extensions/dictation/esbuild.config.js`, `extensions/dictation/.vscodeignore`, `extensions/dictation/tsconfig.json`
  - Test: Run `npm run build` in extension directory successfully

- [x] **Step 2: Provider interface and AssemblyAI implementation**
  - Create `SpeechToTextProvider` interface implementing `vscode.Disposable`
  - Define `DictationError` discriminated union type
  - Implement `AssemblyAIProvider` using official `assemblyai` SDK
  - Use SDK's `client.streaming.transcriber()` with event handlers
  - Handle connection lifecycle via SDK events: `open`, `turn`, `error`, `close`
  - Return unsubscribe functions from `onTranscript` and `onError` for cleanup
  - Files: `extensions/dictation/src/providers/types.ts`, `extensions/dictation/src/providers/assemblyai.ts`
  - Test: Provider connects to mock SDK, receives audio, fires transcript callback with text

- [x] **Step 3: Audio capture webview**
  - Create webview HTML with proper structure and CSP meta tag
  - Configure webview options:
    ```typescript
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri]
    }
    ```
  - Add CSP for AudioWorklet: `worker-src 'self' blob:`
  - Implement `getUserMedia()` with error handling:
    - Catch `NotAllowedError` → `PERMISSION_DENIED`
    - Catch `NotFoundError` → `NOT_FOUND`
    - Catch `NotReadableError` → `NOT_READABLE`
  - Use AudioWorklet to process audio:
    - Detect input sample rate (typically 44100Hz or 48000Hz)
    - Resample to 16kHz using linear interpolation
    - Convert Float32 to PCM16: `Math.max(-32768, Math.min(32767, sample * 32768))`
    - Buffer size: 50ms × 16000Hz × 2 bytes = 1600 bytes per chunk
  - Load AudioWorklet processor via `webview.asWebviewUri()`
  - Send typed messages via `postMessage`
  - Files: `extensions/dictation/src/audio/webview.html`, `extensions/dictation/src/audio/audio-processor.js`, `extensions/dictation/src/audio/AudioCapture.ts`, `extensions/dictation/src/audio/types.ts`
  - Test: Controller starts recording, mock webview sends audio chunks, provider receives them

- [x] **Step 4: Dictation controller**
  - Create main controller implementing `vscode.Disposable`
  - Define `DictationState` discriminated union for state machine
  - Implement start: check API key → set state `starting` → connect provider → create webview → start audio → set state `recording` → start timers
  - Implement stop: set state `stopping` → stop audio → close provider → cleanup timers → set state `idle`
  - Implement duration timeout: auto-stop when `maxDuration` reached, show notification
  - Handle transcript events: insert text at active editor cursor position
  - Handle errors: show notification, call cleanup, reset to idle
  - Implement cleanup function that clears ALL resources:
    ```typescript
    private cleanup(): void {
      clearTimeout(this.durationTimer);
      clearInterval(this.tooltipTimer);
      this.provider?.dispose();
      this.webview?.dispose();
      this.unsubscribeTranscript?.();
      this.unsubscribeError?.();
    }
    ```
  - Manage provider selection based on configuration
  - Files: `extensions/dictation/src/DictationController.ts`
  - Test: Controller starts → state is recording → auto-stops at timeout → state is idle

- [x] **Step 5: Status bar and commands**
  - Create status bar item with state management
  - Show icon only: `$(mic)` idle/unconfigured, `$(loading~spin)` starting, `$(mic-filled)` recording
  - Unconfigured state: dimmed appearance, click opens settings
  - Recording state: warning background using `statusBarItem.warningBackground`
  - Update tooltip every second during recording: "Recording (15s / 60s)"
  - Register VS Code commands for start/stop/toggle
  - Handle toggle during `starting` state: show notification, ignore command
  - Add keyboard shortcut bindings (`Ctrl+Alt+D` and `Escape` for stop)
  - Set `dictation.isRecording` context for conditional keybindings
  - Wire up command handlers to controller
  - Files: `extensions/dictation/src/StatusBar.ts`, `extensions/dictation/extension.ts`
  - Test: Status bar shows warning background when recording, tooltip updates every second

- [x] **Step 6: Configuration and error handling**
  - Read API key and maxDuration from VS Code configuration (`codehydra.dictation.*`)
  - Implement provider auto-selection logic (first provider with API key)
  - Add error notifications for all cases:
    - No API key configured
    - Invalid API key (auth failed)
    - No active editor
    - Microphone permission denied
    - Microphone not found
    - Connection failed
    - Connection lost
    - Max duration reached
  - Watch for configuration changes:
    ```typescript
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codehydra.dictation")) {
        this.updateStatusBarVisibility();
      }
    });
    ```
  - Handle config change during recording: stop recording, show notification
  - Files: `extensions/dictation/src/config.ts`, updates to controller
  - Test: Remove API key during recording → recording stops, notification shown

- [x] **Step 7: Integration and polish**
  - Test end-to-end flow in VS Code (open Developer Tools for webview debugging)
  - Add extension icon
  - Write README for the extension
  - Test in code-server (CodeHydra context)
  - Files: `extensions/dictation/README.md`, `extensions/dictation/icon.png`
  - Test: Full manual testing checklist passes in VS Code desktop and code-server

## Testing Strategy

### Integration Tests

Entry point is `DictationController` for all tests. Use behavioral mocks with in-memory state.

| #   | Test Case              | Entry Point                          | Behavioral Mock                     | Outcome Verified                                            |
| --- | ---------------------- | ------------------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| 1   | Start recording        | `controller.start()`                 | MockProvider (connected state)      | Controller state is `recording`, status bar shows recording |
| 2   | Stop recording         | `controller.stop()`                  | MockProvider                        | Controller state is `idle`, cleanup called                  |
| 3   | Transcript received    | `controller.start()`                 | MockProvider emits transcript       | Text inserted at cursor position                            |
| 4   | Connection error       | `controller.start()`                 | MockProvider rejects connect        | Error notification shown, state is `idle`                   |
| 5   | Connection lost        | `controller.start()`                 | MockProvider emits close event      | Error notification shown, state is `idle`                   |
| 6   | Duration timeout       | `controller.start()`                 | Timer fires at maxDuration          | Recording stopped, timeout notification shown               |
| 7   | No API key             | `controller.start()`                 | Config returns empty                | Error notification shown, state stays `idle`                |
| 8   | No active editor       | `controller.start()`                 | No activeTextEditor                 | Error notification shown, state stays `idle`                |
| 9   | Permission denied      | `controller.start()`                 | MockWebview emits PERMISSION_DENIED | Error notification shown, state is `idle`                   |
| 10  | Rapid toggle           | `controller.toggle()` x3             | MockProvider                        | No crash, final state is consistent                         |
| 11  | Toggle during starting | `controller.toggle()` while starting | MockProvider slow connect           | Notification shown, state unchanged                         |

### Behavioral Mock Definition

```typescript
class MockAssemblyAITranscriber {
  private state: "disconnected" | "connecting" | "connected" = "disconnected";
  private transcriptHandlers: ((text: string) => void)[] = [];
  private errorHandlers: ((error: DictationError) => void)[] = [];

  async connect(): Promise<void> {
    this.state = "connecting";
    // Simulate instant connection in tests (no real timers)
    this.state = "connected";
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (this.state !== "connected") throw new Error("Not connected");
    // Store for verification if needed
  }

  // Test helpers
  simulateTranscript(text: string): void {
    this.transcriptHandlers.forEach((h) => h(text));
  }

  simulateError(error: DictationError): void {
    this.errorHandlers.forEach((h) => h(error));
  }

  simulateClose(): void {
    this.state = "disconnected";
    this.errorHandlers.forEach((h) => h({ type: "connection", message: "Connection closed" }));
  }
}
```

### Focused Tests (Pure Functions)

| #   | Test Case            | Function                   | Input/Output                       |
| --- | -------------------- | -------------------------- | ---------------------------------- |
| 1   | PCM conversion       | `floatToPcm16()`           | `0.5` → `16384`, `-1.0` → `-32768` |
| 2   | Resample calculation | `calculateResampleRatio()` | `44100, 16000` → `2.75625`         |
| 3   | Config parsing       | `getConfig()`              | Settings object → typed config     |

### Test Performance

- Integration tests MUST complete in <50ms per test
- Behavioral mocks use synchronous operations, no real timers/intervals
- Use `vi.useFakeTimers()` for duration timeout tests

### Manual Testing Checklist

- [ ] Start dictation with valid API key - recording begins, status bar shows warning-colored filled mic
- [ ] Tooltip shows elapsed/remaining time: "Recording (15s / 60s)"
- [ ] Recording auto-stops after maxDuration - notification "Maximum duration (60s) reached"
- [ ] Speak into microphone - text appears at cursor position after each turn
- [ ] Stop dictation with `Ctrl+Alt+D` - recording stops, status bar shows outline mic
- [ ] Stop dictation with `Escape` - recording stops, status bar shows outline mic
- [ ] Disconnect network during recording - error notification shown, returns to idle
- [ ] Start dictation without API key - status bar shows dimmed, click opens settings
- [ ] Start dictation with invalid API key - error notification shown
- [ ] Deny microphone permission - error notification shown
- [ ] Remove API key from settings - status bar shows dimmed state
- [ ] Add API key to settings - status bar shows idle state (ready)
- [ ] Start dictation with no active editor - error notification shown
- [ ] Toggle during "Starting" state - notification "Already connecting..."
- [ ] Toggle dictation rapidly - no crashes or stuck states
- [ ] Change maxDuration in settings - new value used on next recording
- [ ] Debug webview: Open Developer Tools, check Console for getUserMedia errors
- [ ] Test in code-server (CodeHydra) - same behavior as desktop VS Code

## Dependencies

| Package      | Purpose                                                                        | Approved |
| ------------ | ------------------------------------------------------------------------------ | -------- |
| `assemblyai` | Official SDK - handles WebSocket, types, connection management, error handling | [x]      |

**SDK Benefits:**

- TypeScript types for all messages and events
- Built-in WebSocket lifecycle management
- Clean event-based API (`transcriber.on('turn', ...)`)
- Automatic message parsing (Begin, Turn, Termination)
- Standardized error handling
- Future-proof against API changes
- Official support from AssemblyAI

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `npm add <package>` to use the latest versions.**

## Documentation Updates

### Files to Update

| File                   | Changes Required                |
| ---------------------- | ------------------------------- |
| `extensions/README.md` | Add dictation extension to list |

### New Documentation Required

| File                             | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `extensions/dictation/README.md` | Extension usage, configuration, requirements |

## Configuration Schema

```json
{
  "codehydra.dictation.provider": {
    "type": "string",
    "enum": ["auto", "assemblyai"],
    "default": "auto",
    "description": "Speech-to-text provider. 'auto' selects the first provider with a configured API key."
  },
  "codehydra.dictation.assemblyai.apiKey": {
    "type": "string",
    "default": "",
    "description": "AssemblyAI API key for speech-to-text. Get one at https://www.assemblyai.com/"
  },
  "codehydra.dictation.maxDuration": {
    "type": "number",
    "default": 60,
    "minimum": 10,
    "maximum": 300,
    "description": "Maximum recording duration in seconds. Recording auto-stops when reached to limit costs."
  }
}
```

## Command Schema

| Command            | Title                       | Keybinding   | When                     |
| ------------------ | --------------------------- | ------------ | ------------------------ |
| `dictation.toggle` | Dictation: Toggle Recording | `Ctrl+Alt+D` | -                        |
| `dictation.start`  | Dictation: Start Recording  | -            | `!dictation.isRecording` |
| `dictation.stop`   | Dictation: Stop Recording   | `Escape`     | `dictation.isRecording`  |

**Note**: The `Escape` keybinding only activates when `dictation.isRecording` context is true, so it won't interfere with normal Escape key usage.

## File Structure

```
extensions/dictation/
├── src/
│   ├── providers/
│   │   ├── types.ts              # SpeechToTextProvider interface, DictationError
│   │   ├── assemblyai.ts         # AssemblyAI implementation (using SDK)
│   │   └── mock.ts               # MockAssemblyAITranscriber for tests
│   ├── audio/
│   │   ├── webview.html          # Hidden webview for audio capture (with CSP)
│   │   ├── audio-processor.js    # AudioWorklet processor (16kHz PCM)
│   │   ├── AudioCapture.ts       # Webview manager class
│   │   └── types.ts              # ToWebviewMessage, FromWebviewMessage
│   ├── DictationController.ts    # Main orchestration logic (Disposable)
│   ├── DictationController.integration.test.ts
│   ├── StatusBar.ts              # Status bar item management
│   ├── config.ts                 # Configuration reading
│   └── utils.ts                  # Pure functions (floatToPcm16, etc.)
│   └── utils.test.ts             # Focused tests for pure functions
├── extension.ts                  # Entry point (activate/deactivate)
├── package.json                  # Extension manifest
├── esbuild.config.js             # Build configuration
├── tsconfig.json                 # TypeScript configuration
├── .vscodeignore                 # Package exclusions
├── README.md                     # User documentation
└── icon.png                      # Extension icon
```

## Webview HTML Structure

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-{{nonce}}'; worker-src 'self' blob:;"
    />
    <title>Audio Capture</title>
  </head>
  <body>
    <div id="status" role="status" aria-live="polite" style="display:none;"></div>
    <script nonce="{{nonce}}" src="{{processorUri}}"></script>
    <script nonce="{{nonce}}">
      // Audio capture initialization
    </script>
  </body>
</html>
```

## SDK Usage Reference

```typescript
import { AssemblyAI } from "assemblyai";

// Create client
const client = new AssemblyAI({ apiKey: config.apiKey });

// Create streaming transcriber
const transcriber = client.streaming.transcriber({
  sampleRate: 16_000,
  formatTurns: true, // Get formatted transcripts with punctuation
});

// Event handlers
transcriber.on("open", ({ id }) => {
  console.log(`Session started: ${id}`);
});

transcriber.on("turn", (turn) => {
  if (turn.transcript && turn.turn_is_formatted) {
    // Insert formatted transcript at cursor
    insertText(turn.transcript);
  }
});

transcriber.on("error", (error) => {
  showErrorNotification(error.message);
});

transcriber.on("close", (code, reason) => {
  if (code !== 1000) {
    // 1000 = normal closure
    showErrorNotification("Connection lost");
  }
  resetToIdle();
});

// Connect and stream
await transcriber.connect();

// Send audio chunks from webview
transcriber.sendAudio(audioBuffer);

// Close when done
await transcriber.close();
```

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
