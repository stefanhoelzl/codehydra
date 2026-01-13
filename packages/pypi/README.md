# CodeHydra

Multi-workspace IDE for parallel AI agent development.

## Installation

```bash
# Run directly without installation
uvx codehydra

# Or install globally
pip install codehydra
codehydra
```

## Features

- Run multiple AI agents simultaneously in isolated git worktrees
- Real-time status monitoring across all workspaces
- Keyboard-driven navigation (Alt+X shortcut mode)
- Full VS Code integration via code-server
- Built-in voice dictation

## How It Works

This package downloads the appropriate CodeHydra binary for your platform from GitHub Releases on first run, caches it locally, and executes it with any passed arguments.

Supported platforms:

- Linux x64
- macOS x64 and arm64
- Windows x64

## Links

- [GitHub Repository](https://github.com/stefanhoelzl/codehydra)
- [Releases](https://github.com/stefanhoelzl/codehydra/releases)

## License

MIT
