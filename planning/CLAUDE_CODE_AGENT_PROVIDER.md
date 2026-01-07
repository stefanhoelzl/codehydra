# Claude Code Agent Provider

Implementation plan for adding Claude Code CLI as an agent provider alongside OpenCode.

## Overview

| OpenCode                  | Claude Code       | Description                            |
| ------------------------- | ----------------- | -------------------------------------- |
| `opencode serve --port N` | **Bridge Server** | Background process for status tracking |
| `opencode attach`         | **`claude` CLI**  | User-interactive terminal session      |
| SSE events                | **Hooks → HTTP**  | Real-time status notifications         |

## Architecture

### Component → Interface Mapping

| Component                 | Implements           | Purpose                                   |
| ------------------------- | -------------------- | ----------------------------------------- |
| `ClaudeCodeSetupInfo`     | `AgentSetupInfo`     | Binary detection, config templates        |
| `ClaudeCodeServerManager` | `AgentServerManager` | **Single** HTTP server for all workspaces |
| `ClaudeCodeProvider`      | `AgentProvider`      | Status tracking per workspace, env vars   |
| `hook-handler.js`         | (standalone script)  | Platform-independent hook executor        |

### Key Simplification: Single Server

Unlike OpenCode (one server per workspace), Claude Code runs **one HTTP server for all workspaces**:

- Hooks include `workspacePath` in their request body
- ServerManager routes status updates to correct workspace

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CodeHydra Main Process                           │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ ClaudeCodeServerManager (implements AgentServerManager)        │ │
│  │                                                                │ │
│  │ - ONE HTTP server for ALL workspaces                           │ │
│  │ - POST /hook/:hookName (body includes workspacePath)           │ │
│  │ - Routes status updates to correct workspace                   │ │
│  │ - Generates config files per workspace                         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                               ▲                                      │
│  ┌──────────────────────┐     │                                      │
│  │ ClaudeCodeProvider   │     │ subscribes to status (per workspace) │
│  │ (one per workspace)  │─────┘                                      │
│  └──────────────────────┘                                            │
└──────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ Hook HTTP (includes workspacePath)
┌─────────────────────────────────────────────┴────────────────────────┐
│                     VS Code Terminal (code-server)                    │
│                                                                      │
│  $ claude  (wrapper adds --continue --settings ... --mcp-config ...) │
│                                                                      │
│  [User interacts with Claude]                                        │
│  [Hooks fire → hook-handler.js → POST /hook/:name {workspacePath}]   │
└──────────────────────────────────────────────────────────────────────┘
```

## Status Model

**Status reflects when user intervention is needed:**

| Status | Meaning           | User action needed?                    |
| ------ | ----------------- | -------------------------------------- |
| `none` | No session active | -                                      |
| `idle` | Waiting for user  | Submit prompt, answer permission, etc. |
| `busy` | Agent is working  | No                                     |

### Hook → Status Mapping

| Hook                | Status Change | Rationale                                |
| ------------------- | ------------- | ---------------------------------------- |
| `SessionStart`      | → `idle`      | Session started, waiting for user prompt |
| `SessionEnd`        | → `none`      | Session ended                            |
| `UserPromptSubmit`  | → `busy`      | User submitted, agent working            |
| `PermissionRequest` | → `idle`      | Waiting for user to answer               |
| `Stop`              | → `idle`      | Agent finished, waiting for next prompt  |
| `PreToolUse`        | (no change)   | Tool starting, still busy                |
| `PostToolUse`       | (no change)   | Tool done, still busy                    |
| `SubagentStop`      | (no change)   | Subagent done, main agent continues      |
| `Notification`      | (no change)   | Informational only                       |
| `PreCompact`        | (no change)   | Informational only                       |

## Claude Code CLI Reference

### Settings Behavior

| Flag           | Behavior                                   |
| -------------- | ------------------------------------------ |
| `--settings`   | **MERGES** with user/project settings      |
| `--mcp-config` | **MERGES** with user/project MCP configs   |
| `--continue`   | Resume last conversation in this directory |

**Two config files required** (MCP cannot be in settings.json):

- `codehydra-hooks.json` → injected via `--settings`
- `codehydra-mcp.json` → injected via `--mcp-config`

### Environment Variables (set by sidekick)

| Variable                      | Purpose                       |
| ----------------------------- | ----------------------------- |
| `CODEHYDRA_CLAUDE_SETTINGS`   | Path to codehydra-hooks.json  |
| `CODEHYDRA_CLAUDE_MCP_CONFIG` | Path to codehydra-mcp.json    |
| `CODEHYDRA_BRIDGE_PORT`       | Bridge server port            |
| `CODEHYDRA_MCP_PORT`          | Main MCP server port          |
| `CODEHYDRA_WORKSPACE_PATH`    | Workspace path for MCP header |

## Files Created

| File                                         | Purpose                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `src/agents/claude-code/types.ts`            | Hook payloads, status types                      |
| `src/agents/claude-code/setup-info.ts`       | `AgentSetupInfo` implementation                  |
| `src/agents/claude-code/server-manager.ts`   | `AgentServerManager` impl (includes HTTP server) |
| `src/agents/claude-code/provider.ts`         | `AgentProvider` implementation                   |
| `src/agents/claude-code/wrapper.ts`          | CLI wrapper entry point                          |
| `src/agents/claude-code/hook-handler.js`     | Platform-independent hook executor               |
| `src/agents/claude-code/hooks.template.json` | Hook settings template                           |
| `src/agents/claude-code/mcp.template.json`   | MCP config template                              |
| `resources/bin/claude`                       | Unix shell wrapper                               |
| `resources/bin/claude.cmd`                   | Windows batch wrapper                            |

## Files Modified

| File                                     | Changes                                             |
| ---------------------------------------- | --------------------------------------------------- |
| `src/agents/types.ts`                    | Add `"claude-code"` to `AgentType`                  |
| `src/agents/index.ts`                    | Add factory cases for claude-code                   |
| `src/services/platform/path-provider.ts` | Add Claude Code config paths                        |
| `src/main/index.ts`                      | Replace OpenCode with Claude Code initialization    |
| `src/main/app-state.ts`                  | Accept agentType, use factory for provider creation |
| `vite.config.bin.ts`                     | Add claude wrapper and hook-handler build           |

## Decisions

| Decision         | Choice                                     | Rationale                                        |
| ---------------- | ------------------------------------------ | ------------------------------------------------ |
| Binary source    | System-installed                           | No licensing concerns, user manages installation |
| API key          | Assume user has it                         | `ANTHROPIC_API_KEY` expected in environment      |
| Config injection | `--settings` + `--mcp-config` (both merge) | Two separate files required                      |
| Hook commands    | Node.js script (platform-independent)      | No curl/wget dependency                          |

## Out of Scope (Future Work)

- Agent type selection UI (per-project or global)
- Running both agents simultaneously
- Binary download/version management for Claude Code
- Initial prompt support via headless mode (`-p`)
