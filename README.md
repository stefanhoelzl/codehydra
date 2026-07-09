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

https://github.com/user-attachments/assets/82b56a86-3dee-42a6-90d3-e2a002949f7a

## Requirements

- **Git**
- A **Claude Code** or **OpenCode** account

## Installation

```bash
# Using Node.js
npx codehydra@latest

# Using Python
uvx --refresh codehydra
```

Or download directly from [GitHub Releases](https://github.com/stefanhoelzl/codehydra/releases).

## Features

- **Parallel Workspaces** - Run Claude Code or OpenCode in several workspaces at once
- **Git Worktrees** - Each workspace is a worktree with its own branch, not a separate clone
- **Built-in Agents** - Claude Code and OpenCode ship with CodeHydra; choose one
  globally or per workspace
- **Real-time Status** - Monitor agent status across all workspaces, mirrored on the app badge
- **Keyboard Driven** - Alt+X shortcut mode for fast workspace navigation
- **VS Code Powered** - A full VSCodium editor per workspace, with your extensions,
  themes and settings
- **Agent-Driven Editor** - Agents can run any VS Code command, including ones your
  installed extensions register: open files, run tasks, drive the UI
- **Cross-platform** - Linux, macOS, and Windows

Also included: hibernation, `.keepfiles`, workspace tags, and auto-workspaces
(experimental) for GitHub pull requests and YouTrack issues.

## How It Works

CodeHydra uses **git worktrees** to create isolated workspaces from a single repository:

| Concept          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| **Project**      | A git repository - a local path, or cloned from a git URL           |
| **Workspace**    | A git worktree with its own branch, running its own AI agent        |
| **Hibernation**  | Park a workspace to free resources; its worktree stays on disk      |
| **Agent status** | `none`, `idle` or `busy` - shown per workspace and on the app badge |

Every workspace opens in a full VSCodium editor with your extensions, themes and
settings, and runs its own AI agent independently. Switch between workspaces
instantly while each agent continues working.

## Keyboard Shortcuts

Hold **Alt** and tap **X** to enter shortcut mode. While still holding Alt:

| Key       | Action                                              |
| --------- | --------------------------------------------------- |
| `↑` / `↓` | Navigate workspaces                                 |
| `←` / `→` | Jump to the next idle workspace (busy if none idle) |
| `1` - `0` | Jump to a workspace by position                     |
| `Enter`   | New workspace                                       |
| `Delete`  | Remove the active workspace                         |
| `h`       | Hibernate or wake the active workspace              |
| `s`       | Open settings                                       |
| `b`       | Report a bug                                        |
| `Escape`  | Exit shortcut mode                                  |

Releasing Alt also exits shortcut mode.

## MCP Integration

Every workspace's agent is automatically connected to CodeHydra's `codehydra` MCP
server - there is nothing to configure. Through it, an agent can:

| Group               | Tools                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace lifecycle | `workspace_create` (optionally with a prompt), `workspace_delete`, `workspace_hibernate`, `workspace_wake`, `workspace_restart_agent_server` |
| Status and metadata | `workspace_get_status`, `workspace_get_metadata`, `workspace_set_metadata`, `workspace_get_agent_session`, `project_list`                    |
| Editor and UI       | `workspace_execute_command`, `ui_show_message`, `log`                                                                                        |
| Diagnostics         | `report_bug`                                                                                                                                 |

`workspace_execute_command` accepts any VS Code command identifier, so an agent can
drive the editor the same way you do - including commands contributed by your own
extensions.

## Development

### Prerequisites

- Node.js 24+
- pnpm 10
- Git

### Commands

| Command                 | Description                          |
| ----------------------- | ------------------------------------ |
| `pnpm bootstrap`        | Install dependencies and build       |
| `pnpm dev`              | Start in development mode            |
| `pnpm build`            | Build for production                 |
| `pnpm test`             | Run all tests                        |
| `pnpm test:integration` | Run integration tests                |
| `pnpm validate:fix`     | Fix lint/format issues and run tests |
| `pnpm dist`             | Create distributable for current OS  |

## Releases

CodeHydra uses calendar versioning (`YYYY.MM.DD`). See [docs/RELEASE.md](docs/RELEASE.md).

## License

[MIT](LICENSE) - 2025-2026 CodeHydra
