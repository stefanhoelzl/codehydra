---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-12
reviewers: [review-arch, review-quality, review-testing, review-ui]
---

# First-Run Agent Selection and Setup Redesign

## Overview

- **Problem**: Currently, the agent type (Claude/OpenCode) is hardcoded at build time, and binary versions are fixed constants. Users cannot choose their preferred AI agent, and the setup flow doesn't provide granular progress feedback.

- **Solution**: Introduce a `config.json` file that stores user preferences and version configuration. On first startup, show an agent selection dialog. Redesign the setup screen to show 3 progress rows (VSCode, Agent, Setup) with parallel downloads. Implement a binary resolution service that prefers system-installed binaries over downloaded ones.

- **Risks**:
  - IPC interface changes require careful migration (mitigated: additive changes only)
  - Claude download URL structure may change (mitigated: fetch latest version dynamically)
  - Boundary tests depend on hardcoded versions (mitigated: tests download binaries on demand)

- **Alternatives Considered**:
  - Keep hardcoded agent type → Rejected: users want choice
  - Bundle all agents → Rejected: unnecessary download size
  - Version pinning for agents → Rejected: prefer system binaries, download latest as fallback

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Startup Flow                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │  ConfigService.load() │
                        │  {dataRootDir}/config │
                        └───────────┬───────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │ agent == null?                │
                    └───────────────┬───────────────┘
                               yes/ \no
                                 /   \
                                ▼     │
                ┌───────────────────┐ │
                │ Agent Selection   │ │
                │ Dialog            │ │
                │ (Claude/OpenCode) │ │
                └─────────┬─────────┘ │
                          │ save      │
                          └─────┬─────┘
                                │
                                ▼
                ┌───────────────────────────────────┐
                │  BinaryResolutionService.resolve()│
                │  For each: code-server, agent     │
                └───────────────┬───────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │ all available?        │
                    └───────────┬───────────┘
                           yes/ \no
                             /   \
                            ▼     ▼
                    ┌────────┐  ┌─────────────────┐
                    │ Ready  │  │ Setup Screen    │
                    │        │  │ (3 rows)        │
                    └────────┘  │ parallel DLs    │
                                └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        Directory Structure                               │
└─────────────────────────────────────────────────────────────────────────┘

{dataRootDir}/                      (dev: ./app-data/, prod: platform-specific)
└── config.json                     ← NEW

{bundlesRoot}/                      (always production paths)
├── code-server/
│   └── 4.107.0/
│       └── bin/code-server
├── claude/                         ← NEW
│   └── 1.0.58/
│       └── claude
└── opencode/
    └── 1.0.223/
        └── opencode

┌─────────────────────────────────────────────────────────────────────────┐
│                    Binary Resolution Logic                               │
└─────────────────────────────────────────────────────────────────────────┘

For code-server (versions.codeServer = "4.107.0"):
  → Check exact version in {bundlesRoot}/code-server/4.107.0/
  → If missing: download

For agents with versions.{agent} = null:
  1. Check system binary (which/where)
  2. If not found: check {bundlesRoot}/{agent}/*/ for any version
  3. If found: use latest (highest version via localeCompare numeric)
  4. If none: download latest

For agents with versions.{agent} = "1.0.58" (pinned):
  → Skip system check
  → Check exact version in {bundlesRoot}/{agent}/1.0.58/
  → If missing: download

┌─────────────────────────────────────────────────────────────────────────┐
│                    Claude Download URL Structure                         │
└─────────────────────────────────────────────────────────────────────────┘

Base URL: https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases

Endpoints:
  - Latest version: {BASE}/latest → returns version string (e.g., "1.0.58")
  - Manifest: {BASE}/{VERSION}/manifest.json → contains checksums
  - Binary: {BASE}/{VERSION}/{PLATFORM}/claude[.exe]

Platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64
```

## UI Design

### Agent Selection Dialog

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                        [CodeHydra Logo]                         │
│                                                                 │
│                    Choose your AI Agent                         │
│                                                                 │
│         Select which AI assistant to use with CodeHydra        │
│                                                                 │
│     ┌─────────────────────┐   ┌─────────────────────┐          │
│     │                     │   │                     │          │
│     │    ✨ (sparkle)     │   │    >_ (terminal)    │          │
│     │                     │   │                     │          │
│     │       Claude        │   │      OpenCode       │          │
│     │                     │   │                     │          │
│     │   ● selected        │   │   ○                 │          │
│     └─────────────────────┘   └─────────────────────┘          │
│                                                                 │
│                      ┌──────────────┐                           │
│                      │   Continue   │                           │
│                      └──────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Icons: <Icon name="sparkle"> for Claude, <Icon name="terminal"> for OpenCode
Buttons: <vscode-button> for Continue
Accessibility: Cards are keyboard focusable, selectable via Enter/Space,
               use role="radiogroup" container with role="radio" aria-checked on cards
```

### Setup Screen (3 Rows)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                        [CodeHydra Logo]                         │
│                                                                 │
│                     Setting up CodeHydra                        │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ◐  VSCode                              Downloading   42% │  │
│  │     ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ✓  Claude                          Using system CLI      │  │
│  │     ████████████████████████████████████████████████████  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ○  Setup                                                 │  │
│  │     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Status Icons (using Icon component):
  - pending: <Icon name="circle-outline">
  - running: <Icon name="sync" spin>
  - done: <Icon name="check"> (green)
  - failed: <Icon name="error"> (red)

Progress bars: <vscode-progress-bar>
Buttons: <vscode-button> for Retry and Quit
Accessibility: aria-live="polite" region to announce status changes
```

### User Interactions

- Agent Selection: Click card or use keyboard (Tab/Enter/Space) to select, Continue button to proceed
- Setup Screen: Progress updates automatically, Retry/Quit buttons on failure

## Implementation Steps

- [x] **Step 1: Create config types and service**
  - Create `src/services/config/types.ts` with `AppConfig`, `ConfigAgentType`, `VersionConfig`
  - Create `src/services/config/config-service.ts` implementing load/save/update
  - Add `readonly configPath: Path` to PathProvider interface
  - Note: This is a pure service (not a boundary abstraction), uses FileSystemLayer for I/O
  - Files: `src/services/config/types.ts`, `src/services/config/config-service.ts`, `src/services/platform/path-provider.ts`
  - Test criteria: Config loads defaults when missing, saves formatted JSON, handles corrupt JSON (logs warning, returns defaults)

- [x] **Step 2: Create binary resolution service**
  - Create `src/services/binary-resolution/types.ts` with resolution interfaces
  - Create `src/services/binary-resolution/binary-resolution-service.ts`
  - Implement `findSystemBinary()` using `which`/`where` via ProcessRunner
    - Windows: `where` returns multiple paths (use first), exit code 1 = not found
    - Unix: `which` returns single path, exit code 1 = not found
  - Implement `findLatestDownloaded()` scanning version directories
    - Use `localeCompare(a, b, { numeric: true })` for version comparison (no semver dependency)
  - Implement `resolve()` with pinned vs null version logic
  - Note: This is a pure service (not a boundary abstraction), uses existing ProcessRunner and FileSystemLayer
  - Files: `src/services/binary-resolution/types.ts`, `src/services/binary-resolution/binary-resolution-service.ts`
  - Test criteria: System binary detection works on both platforms, version directory scanning works, resolution priority correct

- [x] **Step 3: Update AgentType and rename claude-code to claude**
  - Change `AgentType` from `"opencode" | "claude-code"` to `"opencode" | "claude"`
  - Rename all `claude-code` references to `claude` throughout codebase
  - Rename PathProvider properties: `claudeCodeConfigDir` → `claudeConfigDir`, `claudeCodeHookHandlerPath` → `claudeHookHandlerPath`, `claudeCodeWrapperPath` → `claudeWrapperPath`
  - Files affected (grep for "claude-code"):
    - `src/agents/types.ts`
    - `src/agents/claude-code/*` → `src/agents/claude/*` (directory rename)
    - `src/main/index.ts`
    - `src/main/app-state.ts`
    - `src/services/platform/path-provider.ts`
    - `src/services/platform/path-provider.test.ts`
    - `src/services/platform/path-provider.test-utils.ts`
    - `src/services/logging/types.ts`
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - Test files referencing claude-code
  - Test criteria: All references updated, no `claude-code` strings remain (verify with grep)

- [x] **Step 4: Update PathProvider for dynamic versions**
  - Remove hardcoded `codeServerDir`, `opencodeDir`, `codeServerBinaryPath`, `opencodeBinaryPath`, `bundledNodePath`
  - Add `getBinaryDir(type, version)`, `getBinaryPath(type, version)`, `getBinaryBaseDir(type)`
  - Update all PathProvider consumers to use new methods:
    - `src/services/binary-download/binary-download-service.ts`
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - `src/agents/opencode/server-manager.ts`
    - `src/agents/opencode/setup-info.ts`
    - `src/agents/claude/setup-info.ts`
    - `src/services/code-server/code-server-manager.ts`
    - All related test files
  - Files: `src/services/platform/path-provider.ts`, all consumers listed above
  - Test criteria: Dynamic paths resolve correctly, existing functionality preserved

- [x] **Step 5: Add Claude binary download support**
  - Update `AgentSetupInfo` interface: add `getBinaryUrl(version, platform, arch)`, `getLatestVersion()`
  - Implement Claude download URLs using GCS bucket pattern (see Architecture section)
  - Add `"claude"` to `BinaryType`
  - Update `BINARY_CONFIGS` to include Claude
  - Use HttpClient interface for fetching latest version (per External System Access Rules)
  - Files: `src/agents/types.ts`, `src/agents/claude/setup-info.ts`, `src/services/binary-download/types.ts`, `src/services/binary-download/versions.ts`
  - Test criteria: Claude URLs valid for all platforms, latest version fetches correctly

- [x] **Step 6: Update lifecycle module for new flow**
  - **Note: Requires explicit user approval per CLAUDE.md (IPC interface changes)**
  - Modify `getState()` to return `{ state, agent }` instead of just state string
  - Add `setAgent(agent)` IPC handler to save selection to config
  - Update setup flow to use BinaryResolutionService for availability checks
  - Files: `src/main/modules/lifecycle/index.ts`, `src/shared/ipc.ts`, `src/shared/api/types.ts`
  - Test criteria: State includes agent info, setAgent saves to config

- [x] **Step 7: Create setup row progress types and emitter**
  - **Note: Requires explicit user approval per CLAUDE.md (new IPC event)**
  - Add `SetupRowId`, `SetupRowStatus`, `SetupRowProgress`, `SetupScreenProgress` types:
    ```typescript
    export type SetupRowId = "vscode" | "agent" | "setup";
    export type SetupRowStatus = "pending" | "running" | "done" | "failed";
    ```
  - Add `LIFECYCLE_SETUP_PROGRESS` IPC event
  - Create progress emitter for 3-row model
  - Files: `src/services/vscode-setup/types.ts`, `src/shared/ipc.ts`
  - Test criteria: Progress events emit with correct row structure

- [x] **Step 8: Update VscodeSetupService for parallel downloads**
  - Refactor setup flow to download code-server and agent in parallel using `Promise.all`
  - Map internal phases to 3-row progress model
  - Emit row-based progress events
  - Error handling: if one download fails, cancel the other and report failure
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test criteria: Downloads run in parallel, progress maps to correct rows

- [x] **Step 9: Create AgentSelectionDialog component**
  - Create Svelte 5 component with two selection cards (Claude/OpenCode)
  - Use `<Icon name="sparkle">` for Claude, `<Icon name="terminal">` for OpenCode
  - Use `<vscode-button>` for Continue button
  - Keyboard accessibility: cards focusable via Tab, selectable via Enter/Space
  - ARIA: container has `role="radiogroup"`, cards have `role="radio"` with `aria-checked`
  - Continue button calls `lifecycle.setAgent()`
  - Files: `src/renderer/lib/components/AgentSelectionDialog.svelte`
  - Test criteria: Selection updates state, keyboard navigation works, Continue triggers API call

- [x] **Step 10: Redesign SetupScreen component**
  - Replace single progress bar with 3-row layout
  - Use `<vscode-progress-bar>` for each row's progress indicator
  - Use `<Icon>` component for status icons:
    - pending: `<Icon name="circle-outline">`
    - running: `<Icon name="sync" spin>`
    - done: `<Icon name="check">` with green color
    - failed: `<Icon name="error">` with red color
  - Subscribe to `LIFECYCLE_SETUP_PROGRESS` events
  - Show row-specific status icons and progress bars
  - Use `<vscode-button>` for Retry and Quit buttons
  - Add `aria-live="polite"` region to announce status changes
  - Handle error state with Retry/Quit buttons
  - Files: `src/renderer/lib/components/SetupScreen.svelte`
  - Test criteria: Rows update independently, error state shows controls, screen reader announces changes

- [x] **Step 11: Update App.svelte for new flow**
  - Handle `agent: null` case by showing AgentSelectionDialog
  - Update state machine for new lifecycle states
  - Files: `src/renderer/App.svelte`
  - Test criteria: Dialog shows when agent not selected, flow proceeds after selection

- [x] **Step 12: Update boundary tests to use ensureBinaryForTests**
  - Create `src/services/test-utils/ensure-binaries.ts` utility
  - Uses BinaryResolutionService to check/download binaries before tests
  - Keep as post-install step for pnpm install (binaries downloaded during install)
  - Update boundary tests to use this utility instead of skipIf pattern
  - Files: `src/services/test-utils/ensure-binaries.ts`, all `*.boundary.test.ts` files
  - Test criteria: Tests download binaries on demand if not installed, no silent skipping

- [x] **Step 13: Update PathProvider mock factory**
  - Update `createMockPathProvider()` to support new dynamic methods
  - Files: `src/services/platform/path-provider.test-utils.ts`
  - Test criteria: Mock provides all new methods

## Testing Strategy

### Integration Tests

| #   | Test Case                                   | Entry Point                         | Boundary Mocks                     | Behavior Verified                                               |
| --- | ------------------------------------------- | ----------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| 1   | Load creates default config                 | `ConfigService.load()`              | FileSystemMock                     | Returns DEFAULT_APP_CONFIG, file written                        |
| 2   | Load parses existing config                 | `ConfigService.load()`              | FileSystemMock                     | Returns parsed config                                           |
| 3   | Load handles corrupt JSON                   | `ConfigService.load()`              | FileSystemMock (invalid JSON)      | Returns defaults, logs warning                                  |
| 4   | Resolve agent with system binary            | `lifecycle.getState()`              | ProcessRunnerMock (which succeeds) | State shows agent available                                     |
| 5   | Resolve with pinned version                 | `BinaryResolutionService.resolve()` | FileSystemMock                     | Checks exact version dir                                        |
| 6   | Resolve with null (system first)            | `BinaryResolutionService.resolve()` | ProcessRunnerMock, FileSystemMock  | Tries system → downloaded                                       |
| 7   | Parallel downloads show concurrent progress | `lifecycle.setup()`                 | HttpClientMock                     | Both VSCode and Agent rows show "running" status simultaneously |
| 8   | Setup row progress emits correctly          | `lifecycle.setup()`                 | All mocks                          | Row events emit with correct status                             |
| 9   | Download failure shows error state          | `lifecycle.setup()`                 | HttpClientMock (fails)             | Failed row shows error, other row cancelled                     |
| 10  | System binary not executable                | `BinaryResolutionService.resolve()` | ProcessRunnerMock, FileSystemMock  | Falls back to download                                          |

### UI Integration Tests

| #   | Test Case                         | Category | Component            | Behavior Verified                                         |
| --- | --------------------------------- | -------- | -------------------- | --------------------------------------------------------- |
| 1   | Renders both agent options        | Pure-UI  | AgentSelectionDialog | Claude and OpenCode cards visible with correct icons      |
| 2   | Selection changes state           | UI-state | AgentSelectionDialog | Clicking card updates selection, shows selected indicator |
| 3   | Continue saves agent and proceeds | API-call | AgentSelectionDialog | After Continue, config updated and setup screen shown     |
| 4   | Keyboard navigation works         | Pure-UI  | AgentSelectionDialog | Tab focuses cards, Enter/Space selects                    |
| 5   | Renders 3 rows                    | Pure-UI  | SetupScreen          | VSCode, Agent, Setup rows visible                         |
| 6   | Progress updates correct row      | UI-state | SetupScreen          | Progress event updates correct row                        |
| 7   | Shows agent name dynamically      | Pure-UI  | SetupScreen          | "Claude" or "OpenCode" based on config                    |
| 8   | Error state shows retry controls  | UI-state | SetupScreen          | Failed row shows error, Retry/Quit buttons visible        |

### Boundary Tests

| #   | Test Case                       | Interface             | External System | Behavior Verified                                   |
| --- | ------------------------------- | --------------------- | --------------- | --------------------------------------------------- |
| 1   | Fetch Claude latest version     | HttpClient.fetch()    | GCS API         | Real HTTP request to /latest returns version string |
| 2   | Claude URL valid for linux-x64  | HttpClient.fetch()    | GCS API         | HEAD request to binary URL returns 200/302          |
| 3   | System binary detection Unix    | ProcessRunner.spawn() | which command   | Spawns `which claude`, parses stdout path           |
| 4   | System binary detection Windows | ProcessRunner.spawn() | where command   | Spawns `where claude`, parses first line of stdout  |

### Focused Tests

| #   | Test Case                       | Function                                 | Input/Output                                 |
| --- | ------------------------------- | ---------------------------------------- | -------------------------------------------- |
| 1   | Claude URL generation linux-x64 | getBinaryUrl("1.0.58", "linux", "x64")   | Returns `{BASE}/1.0.58/linux-x64/claude`     |
| 2   | Claude URL generation win32     | getBinaryUrl("1.0.58", "win32", "x64")   | Returns `{BASE}/1.0.58/win32-x64/claude.exe` |
| 3   | Version comparison higher       | compareVersions("1.0.58", "1.0.57")      | Returns positive number                      |
| 4   | Version comparison equal        | compareVersions("1.0.58", "1.0.58")      | Returns 0                                    |
| 5   | Version comparison prerelease   | compareVersions("1.0.58-beta", "1.0.57") | Handles gracefully                           |
| 6   | Config validation valid         | validateConfig(validInput)               | Returns valid AppConfig                      |
| 7   | Config validation invalid       | validateConfig(invalidInput)             | Returns error                                |

### Behavioral Mock Specifications

**ProcessRunnerMock for which/where simulation:**

```typescript
const mock = createMockProcessRunner({
  onSpawn: (command, args) => {
    if (command === "which" || command === "where") {
      const binaryName = args[0];
      const installedBinaries = mock.$.systemBinaries; // Map<string, string>
      if (installedBinaries.has(binaryName)) {
        return { exitCode: 0, stdout: installedBinaries.get(binaryName) };
      }
      return { exitCode: 1, stdout: "", stderr: `${binaryName} not found` };
    }
  },
});
```

### Manual Testing Checklist

- [ ] Fresh install: agent dialog appears
- [ ] Select Claude → downloads if not system-installed
- [ ] Select OpenCode → downloads if not system-installed
- [ ] System Claude installed → uses system, shows "Using system CLI"
- [ ] System OpenCode installed → uses system, shows "Using system CLI"
- [ ] Parallel download progress visible (both rows update)
- [ ] Download failure → row shows failed, Retry button works
- [ ] Subsequent startup skips dialog (agent saved)
- [ ] Delete config.json → dialog reappears on next startup
- [ ] Pinned version in config → downloads exact version
- [ ] Keyboard navigation in agent selection dialog works

## Dependencies

None required. Version comparison uses built-in `localeCompare` with `{ numeric: true }` option.

## Documentation Updates

### Files to Update

| File                 | Changes Required                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLAUDE.md            | Update AgentType from "claude-code" to "claude" in any examples or references                                                                                                                       |
| docs/ARCHITECTURE.md | Add new "First-Run Flow" section documenting: 1) Config loading, 2) Agent selection dialog trigger, 3) Binary resolution logic, 4) Setup screen phases                                              |
| docs/PATTERNS.md     | Add "ConfigService Pattern" section showing load/save/update pattern with FileSystemLayer. Add "BinaryResolutionService Pattern" section showing system→downloaded→download resolution              |
| docs/API.md          | Add `LIFECYCLE_SET_AGENT` channel documentation. Update `LIFECYCLE_GET_STATE` return type to `{ state, agent }`. Add `LIFECYCLE_SETUP_PROGRESS` event documentation with `SetupRowProgress` payload |

### New Documentation Required

| File | Purpose                                   |
| ---- | ----------------------------------------- |
| None | All patterns documented in existing files |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated (CLAUDE.md, ARCHITECTURE.md, PATTERNS.md, API.md)
- [ ] User acceptance testing passed (manual checklist)
- [ ] CI passed
- [ ] Merged to main
