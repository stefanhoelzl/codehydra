# CodeHydra Dictation

Voice-to-text dictation for VS Code. Speak into your microphone and have text transcribed directly into the editor at the cursor position.

## Features

- Real-time speech-to-text transcription with activity-based visual feedback
- Seamless integration with VS Code editor and terminal
- Status bar indicator shows recording state with color feedback
- Keyboard shortcut for quick toggle (F10)
- Smart auto-stop based on speech activity detection
- Auto-submit: Emit Enter key when manually stopping dictation
- Audio buffering during API connection for minimal perceived latency
- **Non-intrusive tab interface**: Audio capture runs in a background editor tab
- **Transcription log**: View all transcriptions in a scrollable, accessible log area
- **Auto-opens on startup**: Tab opens automatically if API key is configured

## Requirements

- An AssemblyAI API key (get one at https://www.assemblyai.com/)
- A working microphone
- Microphone permissions for VS Code

## Configuration

Open VS Code Settings and search for "dictation" to configure:

| Setting                                            | Description                                               | Default   |
| -------------------------------------------------- | --------------------------------------------------------- | --------- |
| `codehydra.dictation.provider`                     | Speech-to-text provider                                   | `auto`    |
| `codehydra.dictation.assemblyai.apiKey`            | AssemblyAI API key                                        | _(empty)_ |
| `codehydra.dictation.assemblyai.connectionTimeout` | Connection timeout in ms when connecting to AssemblyAI    | `2000`    |
| `codehydra.dictation.autoStopDelay`                | Auto-stop after this many seconds without speech activity | `5`       |
| `codehydra.dictation.listeningDelay`               | Delay in ms before showing 'listening' (orange) state     | `300`     |
| `codehydra.dictation.autoSubmit`                   | Emit Enter key when manually stopping dictation           | `true`    |

## Usage

### Starting/Stopping Dictation

- **Keyboard shortcut**: `F10` (toggle)
- **Status bar**: Click the microphone/record icon
- **Command palette**: "Dictation: Toggle Recording"

### Dictation Tab

The dictation tab opens automatically on startup if an API key is configured. It runs in the background and doesn't steal focus from your current editor.

Features of the dictation tab:

- **Recording indicator**: Green border appears at the top when recording
- **Status display**: Shows current state (Ready, Recording, etc.) with elapsed time
- **Transcription log**: All transcribed text appears in a scrollable log with timestamps
- **Keyboard shortcuts reference**: Quick reminder of F10 and Escape shortcuts
- **Clear Log button**: Clear the transcription log when needed

The tab stays open after recording stops - you can review your transcriptions anytime.

### Status Bar States

| Icon            | Color   | State          | Description                         |
| --------------- | ------- | -------------- | ----------------------------------- |
| $(record)       | Default | Idle           | Ready to record                     |
| $(mic)          | Default | Not configured | No API key set (click to configure) |
| $(loading~spin) | Default | Loading        | Initializing dictation              |
| $(mic-filled)   | Green   | Active         | Speech detected                     |
| $(mic)          | Orange  | Listening      | Recording, no speech detected       |
| $(loading~spin) | Default | Stopping       | Stopping dictation                  |
| $(error)        | Red     | Error          | Dictation failed (auto-clears)      |

### Visual Feedback

The status bar color changes based on speech detection:

- **Green (mic-filled)**: Speech is being detected
- **Orange (mic)**: Recording, but no speech detected for 300ms

During the initial connection phase, the icon is always green to indicate recording is active.

### Tips

1. **Speak clearly** - The transcription quality depends on clear audio
2. **Check the tooltip** - Hover over the status bar icon to see elapsed time and status
3. **Watch for color changes** - Orange means you've paused; green means speech is detected
4. **Auto-submit**: When you manually stop (F10 or click), an Enter key is automatically inserted
5. **Long sentences**: Speech detection keeps the recording alive even during natural pauses
6. **Cancel recording**: Press `Escape` to stop recording without emitting Enter

### Accessibility

The dictation tab is designed with accessibility in mind:

- **Semantic HTML**: Proper heading hierarchy and section structure
- **ARIA live regions**: Status changes are announced by screen readers
- **Keyboard navigation**: All interactive elements are keyboard accessible
- **High contrast**: Uses VS Code theme variables for consistent theming
- **Error alerts**: Error messages have `role="alert"` for screen reader announcement

## Troubleshooting

### No transcription appearing

1. Check that you have an active editor open
2. Verify your API key is correct in settings
3. Check the microphone permission in VS Code

### Microphone permission denied

On first use, VS Code will ask for microphone permission. If denied:

- macOS: System Preferences > Security & Privacy > Microphone > enable for VS Code
- Windows: Settings > Privacy > Microphone > allow for VS Code
- Linux: Check your desktop environment's permission settings

### Connection errors

- Verify your internet connection
- Check that your API key is valid
- Try again after a moment (temporary service issues)

## Privacy

Audio is streamed to AssemblyAI's servers for transcription. No audio is stored by this extension. See [AssemblyAI's privacy policy](https://www.assemblyai.com/legal/privacy-policy) for details on their data handling.

## License

MIT
