---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-20
reviewers: [review-arch, review-quality, review-testing]
---

# CLAUDE_INITIAL_PROMPT_SUPPORT

## Overview

- **Problem**: The Claude provider ignores `initialPrompt` when creating workspaces. The comment claims "no TUI" but Claude CLI supports `claude "prompt"` to start an interactive session with a pre-submitted prompt.
- **Solution**: Implement file-based initial prompt delivery - write prompt config (prompt text + optional model/agent) to a JSON file when workspace is created, wrapper reads and deletes it on first Claude invocation, then passes appropriate CLI flags.
- **Risks**:
  - File may not be deleted if Claude crashes before wrapper cleanup (mitigated: wrapper deletes before spawning Claude)
  - Race condition if user runs `claude` before file is written (mitigated: `setInitialPrompt()` called after `startAgentServer()` but before workspace view is created and preloaded)
- **Alternatives Considered**: Environment variable approach rejected because env vars persist in the terminal session, causing all subsequent `claude` invocations to use the initial prompt.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Workspace Creation Flow                                │
│                                                                          │
│  CoreModule.workspaceCreate()                                            │
│       │                                                                  │
│       ▼                                                                  │
│  AppState.addWorkspace(workspace, { initialPrompt })                     │
│       │                                                                  │
│       ├──► ServerManager.startServer(path)                               │
│       │         │                                                        │
│       │         └──► generateConfigFiles() [existing]                    │
│       │                                                                  │
│       ├──► ServerManager.setInitialPrompt(path, prompt) [NEW]            │
│       │         │                                                        │
│       │         └──► Writes: {tempDir}/initial-prompt.json               │
│       │              { prompt, model?, agent? }                          │
│       │                                                                  │
│       └──► Provider.getEnvironmentVariables() → sidekick → terminal      │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                    First Claude Invocation                               │
│                                                                          │
│  User runs: claude                                                       │
│       │                                                                  │
│       ▼                                                                  │
│  wrapper.ts (our wrapper script)                                         │
│       │                                                                  │
│       ├──► getInitialPromptConfig() [NEW]                                │
│       │         │                                                        │
│       │         ├── Read CODEHYDRA_INITIAL_PROMPT_FILE env var           │
│       │         ├── If file exists: read JSON, delete file & temp dir    │
│       │         └── Return { prompt, model?, agent? } or undefined       │
│       │                                                                  │
│       └──► spawnSync(claude, [prompt, --model?, --agent?, ...])          │
│                     │                                                    │
│                     ├── "prompt" as positional arg (interactive mode)    │
│                     ├── --model modelID (if model provided)              │
│                     └── --agent agentName (if agent provided)            │
└──────────────────────────────────────────────────────────────────────────┘
```

## Types

### InitialPromptConfig (wrapper-internal type)

```typescript
/**
 * Config read from initial-prompt.json file.
 * Model is stored as just the modelID string (not full PromptModel).
 */
interface InitialPromptConfig {
  readonly prompt: string;
  readonly model?: string; // Just modelID, extracted from PromptModel.modelID
  readonly agent?: string;
}
```

## Testing Strategy

### Boundary Tests (FileSystemLayer.mkdtemp)

| #   | Test Case                        | Interface                   | External System | Behavior Verified                         |
| --- | -------------------------------- | --------------------------- | --------------- | ----------------------------------------- |
| 1   | mkdtemp creates unique directory | `FileSystemLayer.mkdtemp()` | filesystem      | Returns path to new directory with prefix |
| 2   | mkdtemp directories are unique   | `FileSystemLayer.mkdtemp()` | filesystem      | Two calls return different paths          |

### Integration Tests

Test behavior through high-level entry points with behavioral mocks.

| #   | Test Case                                                         | Entry Point                                                      | Boundary Mocks                   | Behavior Verified                                                   |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| 1   | setInitialPrompt stores path retrievable via getInitialPromptPath | `ServerManager.setInitialPrompt()` then `getInitialPromptPath()` | FileSystemLayer                  | `getInitialPromptPath()` returns Path pointing to file in temp dir  |
| 2   | Initial prompt file contains correct JSON structure               | `ServerManager.setInitialPrompt()`                               | FileSystemLayer                  | File contains `{ prompt: "...", model?: "modelID", agent?: "..." }` |
| 3   | getInitialPromptPath returns path when prompt set                 | `ServerManager.getInitialPromptPath()`                           | -                                | Returns Path object                                                 |
| 4   | getInitialPromptPath returns undefined when no prompt             | `ServerManager.getInitialPromptPath()`                           | -                                | Returns undefined                                                   |
| 5   | Provider env vars include file path when prompt set               | `Provider.getEnvironmentVariables()`                             | -                                | Contains `CODEHYDRA_INITIAL_PROMPT_FILE`                            |
| 6   | Provider env vars omit file path when no prompt                   | `Provider.getEnvironmentVariables()`                             | -                                | Does not contain `CODEHYDRA_INITIAL_PROMPT_FILE`                    |
| 7   | getInitialPromptConfig reads file and returns parsed config       | `getInitialPromptConfig()`                                       | FileSystemLayer mock             | Returns `InitialPromptConfig`, file deleted                         |
| 8   | getInitialPromptConfig returns undefined when file missing        | `getInitialPromptConfig()`                                       | FileSystemLayer mock             | Returns undefined, no error                                         |
| 9   | getInitialPromptConfig handles invalid JSON gracefully            | `getInitialPromptConfig()`                                       | FileSystemLayer mock             | Returns undefined, logs warning                                     |
| 10  | setInitialPrompt handles mkdtemp failure                          | `ServerManager.setInitialPrompt()`                               | FileSystemLayer (mkdtemp throws) | Logs error, does not throw                                          |

### Focused Tests (pure functions only)

| #   | Test Case                               | Function                   | Input/Output                                                            |
| --- | --------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| 1   | buildInitialPromptArgs with prompt only | `buildInitialPromptArgs()` | `{prompt:"hi"}` → `["hi"]`                                              |
| 2   | buildInitialPromptArgs with model       | `buildInitialPromptArgs()` | `{prompt:"hi", model:"sonnet"}` → `["hi", "--model", "sonnet"]`         |
| 3   | buildInitialPromptArgs with agent       | `buildInitialPromptArgs()` | `{prompt:"hi", agent:"coder"}` → `["hi", "--agent", "coder"]`           |
| 4   | buildInitialPromptArgs with all options | `buildInitialPromptArgs()` | `{prompt, model, agent}` → `["prompt", "--model", ..., "--agent", ...]` |

### Manual Testing Checklist

- [ ] Create workspace with initial prompt (prompt only) via MCP tool
- [ ] Verify first `claude` invocation starts with prompt submitted
- [ ] Verify second `claude` invocation starts fresh (no prompt)
- [ ] Verify workspace creation without initial prompt still works
- [ ] Create workspace with initial prompt + model specified
- [ ] Verify Claude starts with correct model (check model indicator in TUI)
- [ ] Create workspace with initial prompt + agent specified
- [ ] Verify Claude starts with correct agent

## Implementation Steps

- [x] **Step 1: Add mkdtemp to FileSystemLayer**
  - Add `mkdtemp(prefix: PathLike): Promise<Path>` method to interface
  - Implement in `DefaultFileSystemLayer` using `fs.mkdtemp()`
  - Add to `filesystem.state-mock.ts` with in-memory implementation that tracks created dirs with incrementing counter for unique paths
  - Add boundary test for `mkdtemp`
  - Files: `src/services/platform/filesystem.ts`, `src/services/platform/filesystem.state-mock.ts`
  - Test criteria: Creates temp dir, mock tracks created dirs with unique suffixes

- [x] **Step 2: Add setInitialPrompt to ServerManager**
  - Add `setInitialPrompt(workspacePath: string, config: NormalizedInitialPrompt): Promise<void>` method
  - Add `getInitialPromptPath(workspacePath: string): Path | undefined` method
  - Use `fileSystem.mkdtemp()` to create temp dir, write `initial-prompt.json` inside
  - JSON format: `{ prompt: string, model?: string, agent?: string }`
  - Extract `model.modelID` from `NormalizedInitialPrompt.model` (which is `PromptModel` type) when writing JSON
  - Store temp dir path in workspace state for later retrieval
  - File: `src/agents/claude/server-manager.ts`
  - Test criteria: JSON file created with correct content, model stored as string ID only

- [x] **Step 3: Add new environment variable for initial prompt file path**
  - Add `CODEHYDRA_INITIAL_PROMPT_FILE` to `getEnvironmentVariables()` in provider
  - Get path from `serverManager.getInitialPromptPath(workspacePath)`
  - Only include if initial prompt was set (path is defined)
  - The env var is optional - wrapper handles missing value gracefully (no initial prompt)
  - File: `src/agents/claude/provider.ts`
  - Test criteria: Env var included when prompt set, omitted when not set

- [x] **Step 4: Update wrapper to consume initial prompt**
  - Add `getInitialPromptConfig(): InitialPromptConfig | undefined` function
  - Use synchronous Node.js APIs (`fs.readFileSync`, `fs.unlinkSync`, `fs.rmdirSync`) to match wrapper's sync execution model
  - Read JSON from `CODEHYDRA_INITIAL_PROMPT_FILE` env var path (if env var missing, return undefined)
  - If file exists: parse JSON, delete file first, then delete parent temp dir, return config
  - If JSON parse fails: log warning, delete file anyway, return undefined
  - Add `buildInitialPromptArgs(config: InitialPromptConfig): string[]` pure function
  - Build args array:
    - Prompt as first positional argument
    - `--model modelID` if model is set
    - `--agent agentName` if agent is set
  - File: `src/agents/claude/wrapper.ts`
  - Test criteria: All flags correctly passed to claude, file deleted after read

- [x] **Step 5: Wire up initial prompt in app-state**
  - Remove the "Initial prompt ignored" log message
  - After `startAgentServer()`, call `serverManager.setInitialPrompt()` if prompt provided
  - Add optional `setInitialPrompt` method to `AgentServerManager` interface to avoid type guards
  - Only `ClaudeCodeServerManager` implements `setInitialPrompt`; other implementations can omit or no-op
  - File: `src/main/app-state.ts`, `src/agents/types.ts`
  - Test criteria: Initial prompt flows through to file creation

- [x] **Step 6: Add integration tests**
  - Test workspace creation with initial prompt creates file
  - Test workspace creation without initial prompt doesn't create file
  - Test provider env vars include file path when prompt set
  - Test getInitialPromptConfig with FileSystemLayer mock
  - Test error scenarios (mkdtemp failure, invalid JSON)
  - File: `src/agents/claude/server-manager.integration.test.ts` (new or existing)
  - Test criteria: All tests pass

- [x] **Step 7: Update documentation**
  - Add `CODEHYDRA_INITIAL_PROMPT_FILE` to environment variables section in `docs/API.md`
  - Document that it's an optional env var pointing to initial prompt JSON file
  - File: `docs/API.md`
  - Test criteria: Documentation accurately describes the new env var

## Approval Required

Per CLAUDE.md, these items require explicit user approval:

1. **FileSystemLayer interface modification**: Adding `mkdtemp(prefix: PathLike): Promise<Path>` method
   - Reason: Enables creating unique temp directories for initial prompt files
   - Impact: Requires updating `filesystem.state-mock.ts` and adding boundary test

2. **AgentServerManager interface modification**: Adding optional `setInitialPrompt` method
   - Reason: Avoids runtime type guards in app-state.ts
   - Impact: Minor interface extension, implementations can omit the method

## Dependencies

No new dependencies required.

## Documentation Updates

- `docs/API.md`: Add `CODEHYDRA_INITIAL_PROMPT_FILE` environment variable documentation

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Manual testing checklist complete
- [ ] CI passed
