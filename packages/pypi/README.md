# CodeHydra

Multi-workspace IDE for parallel AI agent development.

## Installation

```bash
# Run directly without installation
uvx --refresh codehydra

# Or install globally
pip install codehydra
codehydra
```

## Features

- Run Claude Code or OpenCode in several isolated git worktrees at once
- Real-time agent status monitoring across all workspaces
- Keyboard-driven navigation (Alt+X shortcut mode)
- A full VSCodium editor per workspace, with your extensions, themes and settings
- Agents can run any VS Code command through the built-in MCP server

## How It Works

This package downloads the appropriate CodeHydra binary for your platform from GitHub Releases on first run, caches it locally, and executes it with any passed arguments.

Supported platforms:

- Linux x64
- macOS x64 and arm64
- Windows x64

## Links

- [Website](https://codehydra.stho.net)
- [GitHub Repository](https://github.com/stefanhoelzl/codehydra)
- [Releases](https://github.com/stefanhoelzl/codehydra/releases)

## License

MIT
