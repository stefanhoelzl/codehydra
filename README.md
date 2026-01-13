<div align="center">
  <img src="resources/icon.png" alt="CodeHydra Logo" width="128" height="128">
  <h1>CodeHydra</h1>
  <p><strong>Multi-workspace IDE for parallel AI agent development</strong></p>

[![CI](https://github.com/stefanhoelzl/codehydra/actions/workflows/ci.yaml/badge.svg)](https://github.com/stefanhoelzl/codehydra/actions/workflows/ci.yaml)
[![npm](https://img.shields.io/npm/v/codehydra)](https://www.npmjs.com/package/codehydra)
[![PyPI](https://img.shields.io/pypi/v/codehydra)](https://pypi.org/project/codehydra/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)

</div>

---

Run multiple AI coding assistants simultaneously in isolated git worktrees
with real-time status monitoring.

## Installation

```bash
# Using Node.js
npx codehydra

# Using Python
uvx codehydra
```

Or download directly from [GitHub Releases](https://github.com/stefanhoelzl/codehydra/releases).

## Features

- **Parallel Workspaces** - Run multiple AI agents simultaneously, each in its own workspace
- **Git Worktrees** - Each workspace is an isolated git worktree, not a separate clone
- **Real-time Status** - Monitor agent status (idle/busy/waiting) across all workspaces
- **Keyboard Driven** - Alt+X shortcut mode for fast workspace navigation
- **VS Code Powered** - Full code-server integration with all your extensions
- **Voice Dictation** - Built-in speech-to-text for hands-free coding
- **Cross-platform** - Linux, macOS, and Windows

## Screenshot

> Screenshots coming soon

## How It Works

CodeHydra uses **git worktrees** to create isolated workspaces from a single repository:

| Concept       | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| **Project**   | A git repository (the main directory)                         |
| **Workspace** | A git worktree - an isolated working copy with its own branch |

Each workspace gets its own VS Code instance (via code-server) and can run an independent
AI agent. Switch between workspaces instantly while each agent continues working.

## Development

### Prerequisites

- pnpm (manages Node.js version automatically)
- Git

### Commands

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `pnpm dev`          | Start in development mode            |
| `pnpm build`        | Build for production                 |
| `pnpm test`         | Run all tests                        |
| `pnpm validate:fix` | Fix lint/format issues and run tests |
| `pnpm dist`         | Create distributable for current OS  |

## License

[MIT](LICENSE) - 2025 CodeHydra
