# CodeHydra Dictation

Voice-to-text dictation for VS Code. Speak into your microphone and have text transcribed directly into the editor at the cursor position.

## Features

- Real-time speech-to-text transcription
- Seamless integration with VS Code editor
- Status bar indicator shows recording state
- Keyboard shortcut for quick toggle
- Automatic timeout to prevent accidental long recordings

## Requirements

- An AssemblyAI API key (get one at https://www.assemblyai.com/)
- A working microphone
- Microphone permissions for VS Code

## Configuration

Open VS Code Settings and search for "dictation" to configure:

| Setting                                 | Description                           | Default   |
| --------------------------------------- | ------------------------------------- | --------- |
| `codehydra.dictation.provider`          | Speech-to-text provider               | `auto`    |
| `codehydra.dictation.assemblyai.apiKey` | AssemblyAI API key                    | _(empty)_ |
| `codehydra.dictation.maxDuration`       | Maximum recording duration in seconds | `60`      |

## Usage

### Starting/Stopping Dictation

- **Keyboard shortcut**: `Ctrl+Alt+D` (toggle)
- **Status bar**: Click the microphone icon
- **Command palette**: "Dictation: Toggle Recording"
- **Stop with Escape**: Press `Escape` to stop (only while recording)

### Status Bar Icons

| Icon            | State          | Description             |
| --------------- | -------------- | ----------------------- |
| $(mic)          | Idle           | Ready to record         |
| $(mic) (dimmed) | Not configured | No API key set          |
| $(loading~spin) | Connecting     | Establishing connection |
| $(mic-filled)   | Recording      | Actively transcribing   |

### Tips

1. **Speak clearly** - The transcription quality depends on clear audio
2. **Check the tooltip** - Hover over the status bar icon to see elapsed time
3. **Watch for auto-stop** - Recording automatically stops at `maxDuration` to limit costs

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
