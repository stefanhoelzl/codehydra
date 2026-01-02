---
status: USER_TESTING
last_updated: 2026-01-02
reviewers: [review-ui, review-typescript, review-docs]
---

# DICTATION_LONG_SENTENCES

## Overview

- **Problem**: Long sentences cause dictation to stop prematurely. The AssemblyAI API only returns transcripts when sentences complete (turn ends), but the silence timeout (10s) fires if no transcript is received, even though the user is still speaking.
- **Solution**:
  1. Subscribe to both turn events AND word-level transcript events from AssemblyAI
  2. Reset the auto-stop timer on ANY speech activity (not just complete turns)
  3. Add visual feedback (green = speech detected, orange = silence) with a 300ms delay
  4. Optimize startup by buffering audio while API connects (perceived ~500ms vs ~1.5s)
  5. Add auto-submit feature (emit Enter on manual stop)
- **Risks**:
  - AssemblyAI SDK event API might differ from documentation - mitigated by defensive coding and testing
  - Audio buffer could grow large if API connection is slow - mitigated by connection timeout (2s default)
- **Alternatives Considered**:
  - Extend the timeout: Rejected - doesn't solve the core problem, just delays it
  - Keep WebSocket warm: Rejected - AssemblyAI charges for session duration, even idle

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DictationController                                │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                     │
│  │ Audio       │    │ Audio       │    │ Provider    │                     │
│  │ Capture     │───►│ Buffer      │───►│ (when       │                     │
│  │             │    │ (queue)     │    │ connected)  │                     │
│  └─────────────┘    └─────────────┘    └─────────────┘                     │
│         │                                    │                              │
│         │                                    │ onActivity / onTranscript    │
│         ▼                                    ▼                              │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │                    Timer Management                          │           │
│  │                                                              │           │
│  │  BUFFERING PHASE:          STREAMING PHASE:                 │           │
│  │  (API not connected)       (API connected)                  │           │
│  │                                                              │           │
│  │  - Always green            - Activity event → green         │           │
│  │  - Auto-stop timer         - 300ms no activity → orange     │           │
│  │    resets on audio         - Auto-stop timer resets         │           │
│  │    chunks                    on activity                    │           │
│  │                                                              │           │
│  │  On activity event: reset BOTH timers                       │           │
│  │  - Auto-stop timer (5s) → prevents recording timeout        │           │
│  │  - Listening timer (300ms) → shows green status             │           │
│  │                                                              │           │
│  └─────────────────────────────────────────────────────────────┘           │
│                                    │                                        │
│                                    ▼                                        │
│                            ┌─────────────┐                                 │
│                            │ StatusBar   │                                 │
│                            │ (colors)    │                                 │
│                            └─────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Connection State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Connection Phase State Machine                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   type ConnectionPhase = "disconnected" | "buffering" | "flushing"          │
│                        | "streaming" | "error";                             │
│                                                                             │
│   ┌──────────────┐                                                          │
│   │ disconnected │ ─── start() ───►  ┌────────────┐                        │
│   └──────────────┘                   │ buffering  │                        │
│          ▲                           │            │                        │
│          │                           │ Audio queued│                        │
│          │                           │ API connecting                       │
│     error/stop                       └────────────┘                        │
│          │                                 │                                │
│          │                          API connected                           │
│          │                                 ▼                                │
│          │                           ┌────────────┐                        │
│          │                           │  flushing  │                        │
│          │                           │            │                        │
│          │                           │ Send queued │                        │
│          │                           │ audio       │                        │
│          │                           └────────────┘                        │
│          │                                 │                                │
│          │                           Buffer empty                           │
│          │                                 ▼                                │
│          │                           ┌────────────┐                        │
│          └─────────────────────────  │ streaming  │                        │
│                                      │            │                        │
│                                      │ Direct send│                        │
│                                      └────────────┘                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Startup Sequence (Optimized)

```
User presses F10
       │
       ▼
┌──────────────────┐
│ State: starting  │
│ Status: Loading  │
│ $(loading~spin)  │
└──────────────────┘
       │
       ├──────────────────────────────────┐
       ▼                                  ▼
┌──────────────────┐              ┌──────────────────┐
│ Start Audio      │              │ Connect to API   │
│ Capture (~500ms) │              │ (timeout: 2s)    │
└──────────────────┘              └──────────────────┘
       │                                  │
       ▼                                  │
┌──────────────────┐                      │
│ Audio Ready!     │                      │
│ State: recording │                      │
│ Phase: buffering │                      │
│ Status: Active   │◄─────────────────────┤
│ $(mic-filled)    │                      │
│ GREEN            │                      │
│                  │                      │
│ Buffer audio     │                      │
│ chunks in queue  │                      │
└──────────────────┘                      │
       │                                  │
       │◄─────────────────────────────────┘
       │ API Connected (or timeout → error)
       ▼
┌──────────────────┐
│ Phase: flushing  │
│ Send all queued  │
│ audio chunks     │
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ Phase: streaming │
│                  │
│ Activity-based   │
│ green/orange     │
│ feedback         │
└──────────────────┘
```

### Two-Phase Visual Feedback

```
PHASE 1: BUFFERING                    PHASE 2: STREAMING
(Audio ready, API connecting)         (API connected)

┌─────────────────────┐               ┌─────────────────────┐
│                     │               │                     │
│  Always GREEN       │   ──────►     │  Activity → GREEN   │
│  $(mic-filled)      │   API         │  $(mic-filled)      │
│                     │   connects    │        │            │
│  "I'm recording"    │               │        ▼ 300ms      │
│                     │               │                     │
│                     │               │  Silence → ORANGE   │
│                     │               │  $(mic)             │
└─────────────────────┘               └─────────────────────┘
```

### Stop Behavior

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Stop Triggers                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  MANUAL STOP (user intent):              AUTO-STOP (system):                │
│  - F10 toggle                            - Silence timeout (5s)             │
│  - Status bar click                      - Connection timeout (2s)          │
│                                          - Error                            │
│                                                                             │
│  → Emit Enter (if autoSubmit=true)       → No Enter emitted                 │
│  → Close panel                           → Close panel                      │
│                                          → Show error message (if error)    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## UI Design

### Status Bar States

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VS Code Status Bar                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  IDLE:       [ ● ]  Dictation                      $(record), default       │
│              Tooltip: "Start dictation (F10)"                               │
│                                                                             │
│  LOADING:    [ ⟳ ]  Connecting...                  $(loading~spin), default │
│              Tooltip: "Initializing dictation..."                           │
│                                                                             │
│  LISTENING:  [ 🎤 ]  Listening...                  $(mic), ORANGE           │
│              Tooltip: "Recording - no speech (F10 to stop)"                 │
│              (Only in streaming phase, after 300ms silence)                 │
│                                                                             │
│  ACTIVE:     [ 🎤 ]  Listening...                  $(mic-filled), GREEN     │
│              Tooltip: "Recording - speech detected (F10 to stop)"           │
│              (Buffering phase: always)                                      │
│              (Streaming phase: on activity)                                 │
│                                                                             │
│  STOPPING:   [ ⟳ ]  Stopping...                    $(loading~spin), default │
│              Tooltip: "Stopping dictation..."                               │
│                                                                             │
│  ERROR:      [ ⚠ ]  Dictation                      $(error), RED            │
│              Tooltip: "Dictation failed: <error message>"                   │
│              (Auto-clears to IDLE after 3 seconds)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Color Implementation

| State     | Icon              | Foreground Color | ThemeColor                 |
| --------- | ----------------- | ---------------- | -------------------------- |
| Idle      | `$(record)`       | Default          | (none)                     |
| Loading   | `$(loading~spin)` | Default          | (none)                     |
| Listening | `$(mic)`          | Orange           | `editorWarning.foreground` |
| Active    | `$(mic-filled)`   | Green            | `testing.iconPassed`       |
| Stopping  | `$(loading~spin)` | Default          | (none)                     |
| Error     | `$(error)`        | Red              | `errorForeground`          |

### User Interactions

- **F10**: Toggle dictation (start if idle, stop if recording)
- **Click status bar**: Toggle dictation

Note: Escape keybinding removed - F10 toggle is sufficient for stopping.

## Implementation Steps

- [x] **Step 1: Update Provider Interface**
  - Add `ActivityHandler` type: `() => void`
  - Add `onActivity()` method to `SpeechToTextProvider`
  - Activity signals that speech is being detected (for timer reset and visual feedback)
  - Files: `src/providers/types.ts`
  - Test criteria: Interface compiles, existing implementations error until updated

- [x] **Step 2: Update AssemblyAI Provider**
  - Subscribe to `transcript` event (word-level) in addition to `turn` event
  - Defensive check: verify event exists before subscribing
  - Fire `onActivity()` on ANY event with text content (partial turns, word-level transcripts)
  - Keep `onTranscript()` firing only on complete formatted turns
  - Files: `src/providers/assemblyai.ts`
  - Test criteria: Activity fires on partial results, transcript fires on complete turns

- [x] **Step 3: Update Mock Provider**
  - Add `onActivity()` support with handler registry
  - Add `simulateActivity()` test helper
  - Files: `src/providers/mock.ts`
  - Test criteria: Mock can simulate activity events separately from transcripts

- [x] **Step 4: Update Settings**
  - Rename `silenceTimeout` → `autoStopDelay` (default 5s, min 3s, max 60s)
  - Add `listeningDelay` (default 300ms, min 100ms, max 1000ms)
  - Add `autoSubmit` (default true) - emit Enter on manual stop
  - Add `assemblyai.connectionTimeout` (default 2000ms, min 1000ms, max 10000ms)
  - Remove Escape keybinding from package.json
  - Remove `isRecording` context key (no longer needed without Escape binding)
  - Update config.ts to read new settings with validation (clamp to min/max)
  - Files: `package.json`, `src/config.ts`, `src/commands.ts`
  - Test criteria: New settings appear in VS Code, values clamped to valid range

- [x] **Step 5: Update StatusBar with New States**
  - Add new state type: `StatusBarState = "idle" | "loading" | "listening" | "active" | "stopping" | "error"`
  - Update `update()` to accept state and optional error message
  - Add `setActive(isActive: boolean)` method to switch between listening/active
  - Add tooltips for each state
  - Add error state with auto-clear timer (3 seconds)
  - Use foreground color via `statusBarItem.color = new vscode.ThemeColor(...)`
  - Icon mapping:
    - idle: `$(record)`
    - loading: `$(loading~spin)`
    - listening: `$(mic)` + orange
    - active: `$(mic-filled)` + green
    - stopping: `$(loading~spin)`
    - error: `$(error)` + red
  - Files: `src/StatusBar.ts`
  - Test criteria: Correct icon, color, and tooltip for each state

- [x] **Step 6: Update DictationState Type**
  - Update `DictationState` to include connection phase:
    ```typescript
    type ConnectionPhase = "disconnected" | "buffering" | "flushing" | "streaming";
    type DictationState =
      | { status: "idle" }
      | { status: "loading" }
      | {
          status: "recording";
          phase: ConnectionPhase;
          isActive: boolean;
          startTime: number;
          sessionId: string;
        }
      | { status: "stopping" }
      | { status: "error"; message: string };
    ```
  - Files: `src/DictationController.ts`
  - Test criteria: State type is consistent between controller and status bar

- [x] **Step 7: Restructure DictationController - Parallel Init with Buffering**
  - Start audio capture and API connection in parallel
  - Add connection timeout (default 2s, configurable)
  - Transition to "recording" state with phase="buffering" when audio is ready
  - Add audio buffer: `ArrayBuffer[]` to queue chunks while API connects
  - Buffer is bounded by connection timeout (2s max buffering)
  - On API connect: transition to phase="flushing", send all queued chunks, then phase="streaming"
  - On connection timeout: show error, stop recording
  - Files: `src/DictationController.ts`
  - Test criteria: Recording starts after audio ready, buffer flushes on connect, timeout shows error

- [x] **Step 8: Implement Two-Phase Visual Feedback**
  - Buffering phase: Always show active (green, mic-filled)
  - Streaming phase: Subscribe to `onActivity()`, reset 300ms listening timer on activity
  - On activity: set `isActive=true`, show green, reset listening timer
  - On listening timer expire (300ms): set `isActive=false`, show orange
  - Files: `src/DictationController.ts`
  - Test criteria: Green during buffering, green/orange toggle during streaming

- [x] **Step 9: Update Auto-Stop Timer Logic**
  - Buffering phase: Reset auto-stop timer when audio chunks are received
  - Streaming phase: Reset auto-stop timer when activity events are received
  - On activity: reset BOTH timers (auto-stop AND listening)
  - Default auto-stop delay: 5s (was 10s)
  - Files: `src/DictationController.ts`
  - Test criteria: Long sentences don't trigger timeout, silence stops after 5s

- [x] **Step 10: Add Timer Cleanup**
  - Add `listeningTimer` property
  - Add `errorClearTimer` property (for StatusBar error auto-clear)
  - Update `cleanup()` to clear both new timers
  - Files: `src/DictationController.ts`, `src/StatusBar.ts`
  - Test criteria: No memory leaks, timers cleared on stop

- [x] **Step 11: Implement Auto-Submit Feature**
  - Add `stop(options?: { emitEnter?: boolean })` method signature
  - On manual stop (F10, status bar): call `stop({ emitEnter: config.autoSubmit })`
  - On auto-stop (timeout): call `stop({ emitEnter: false })`
  - On error: call `stop({ emitEnter: false })`
  - Insert Enter using same mechanism as text insertion: `\n` character
  - Files: `src/DictationController.ts`
  - Test criteria: Enter emitted on manual stop when enabled, not on timeout/error

- [x] **Step 12: Update Integration Tests**
  - Update existing tests for new settings names (`autoStopDelay` instead of `silenceTimeout`)
  - Add tests for activity-based timer reset
  - Add tests for parallel initialization and buffering
  - Add tests for connection timeout
  - Add tests for two-phase visual feedback
  - Add tests for auto-submit (Enter on manual stop only)
  - Add tests for error state
  - Remove tests for Escape keybinding
  - Files: `src/DictationController.integration.test.ts`
  - Test criteria: All tests pass

## Testing Strategy

### Integration Tests

Test behavior through DictationController with mock provider and audio capture.

| #   | Test Case                          | Entry Point                                          | Boundary Mocks                                  | Behavior Verified                                     |
| --- | ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| 1   | Long sentence keeps recording      | `controller.start()` + activity events               | MockProvider, MockAudioCapture                  | Auto-stop timer resets on activity, no premature stop |
| 2   | Silence triggers auto-stop         | `controller.start()` + no activity for 5s            | MockProvider, MockAudioCapture                  | Recording stops after autoStopDelay, no Enter emitted |
| 3   | Buffering phase always green       | `controller.start()` with deferred connect           | MockProvider (deferred), MockAudioCapture       | Status is active (green, mic-filled) when audio ready |
| 4   | Streaming phase green on activity  | `controller.start()` + API connected + activity      | MockProvider, MockAudioCapture                  | Status shows active (green, mic-filled) on activity   |
| 5   | Streaming phase orange after 300ms | `controller.start()` + API connected + 300ms silence | MockProvider, MockAudioCapture                  | Status shows listening (orange, mic) after delay      |
| 6   | Audio buffering during connect     | `controller.start()` + audio before API ready        | MockProvider (deferred), MockAudioCapture       | Audio queued, all chunks sent when connected          |
| 7   | Buffer flush order preserved       | `controller.start()` + multiple audio chunks         | MockProvider (deferred), MockAudioCapture       | Chunks sent to provider in correct order              |
| 8   | Auto-stop resets during buffering  | `controller.start()` + audio chunks, no API          | MockProvider (deferred), MockAudioCapture       | Audio chunks reset the auto-stop timer                |
| 9   | Manual stop emits Enter            | `controller.toggle()` to stop                        | MockProvider, MockAudioCapture                  | Enter character inserted after stopping               |
| 10  | Auto-stop does not emit Enter      | `controller.start()` + 5s silence                    | MockProvider, MockAudioCapture                  | No Enter character inserted                           |
| 11  | Error does not emit Enter          | `controller.start()` + provider error                | MockProvider, MockAudioCapture                  | No Enter character inserted                           |
| 12  | autoSubmit=false skips Enter       | `controller.toggle()` with autoSubmit=false          | MockProvider, MockAudioCapture                  | No Enter on manual stop                               |
| 13  | Connection timeout shows error     | `controller.start()` + 2s no connect                 | MockProvider (never connects), MockAudioCapture | Error state shown, recording stopped                  |
| 14  | Error state auto-clears            | StatusBar error state                                | N/A                                             | Error clears to idle after 3s                         |
| 15  | Both timers reset on activity      | `controller.start()` + activity                      | MockProvider, MockAudioCapture                  | Auto-stop and listening timers both reset             |

### Manual Testing Checklist

- [ ] Start dictation, speak a long sentence (>10 seconds) without pauses - should not stop
- [ ] Start dictation, stay silent - should stop after 5 seconds (no Enter emitted)
- [ ] Start dictation - status shows record icon initially, then green mic-filled when recording starts
- [ ] Start dictation, wait for API to connect, then pause speaking - status changes green mic-filled → orange mic after 300ms
- [ ] Start dictation, speak continuously after API connects - status stays green mic-filled
- [ ] Start dictation, speak immediately during loading - first words are captured and transcribed
- [ ] Start dictation, speak, then press F10 - Enter is emitted after text
- [ ] Start dictation, speak, then click status bar - Enter is emitted after text
- [ ] Verify Escape key does NOT stop recording
- [ ] Disconnect network, start dictation - error shown after 2s, status shows error icon
- [ ] Verify error state auto-clears to idle after 3 seconds
- [ ] Hover over status bar - verify tooltip shows correct state description
- [ ] Verify settings: `codehydra.dictation.autoStopDelay` appears with default 5
- [ ] Verify settings: `codehydra.dictation.listeningDelay` appears with default 300
- [ ] Verify settings: `codehydra.dictation.autoSubmit` appears with default true
- [ ] Verify settings: `codehydra.dictation.assemblyai.connectionTimeout` appears with default 2000
- [ ] Test with autoSubmit=false - no Enter on manual stop

## Dependencies

No new dependencies required. Uses existing `assemblyai` SDK.

| Package | Purpose | Approved |
| ------- | ------- | -------- |
| (none)  | N/A     | N/A      |

## Documentation Updates

### Files to Update

| File                             | Changes Required                                             |
| -------------------------------- | ------------------------------------------------------------ |
| `extensions/dictation/README.md` | - Rename silenceTimeout to autoStopDelay in settings docs    |
|                                  | - Add listeningDelay setting documentation                   |
|                                  | - Add autoSubmit setting documentation                       |
|                                  | - Add assemblyai.connectionTimeout setting documentation     |
|                                  | - Remove Escape keybinding from shortcuts section            |
|                                  | - Update status bar states description (record icon, colors) |

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
