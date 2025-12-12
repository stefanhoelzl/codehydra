---
status: COMPLETED
last_updated: 2025-12-12
completed: 2025-12-12
reviewers: [review-testing, review-docs, review-arch, review-senior]
---

# BOUNDARY_TESTS

## Overview

- **Problem**: Current tests mock external dependencies, but mocks may not accurately reflect real behavior. We need tests that verify our modules work correctly against actual external systems.
- **Solution**: Create boundary tests that test modules at the edge of the application where they interact with external entities (Git CLI, OS processes, network, filesystems, external binaries).
- **Risks**:
  - External system tests can be flaky (network issues, process timing)
  - Tests may have platform-specific behavior
  - Some tests require external binaries (code-server, opencode)
- **Alternatives Considered**:
  - Contract testing: Rejected - requires maintaining separate contracts
  - Only unit tests with mocks: Current approach, but mocks may drift from reality

## Architecture

This is a meta-plan that establishes testing strategy and defines phases for implementation.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TEST PYRAMID                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                         ┌───────────┐                                │
│                         │  System   │  ← TBD (future)                │
│                         │   Tests   │                                │
│                         └─────┬─────┘                                │
│                     ┌─────────┴─────────┐                            │
│                     │   Boundary Tests   │  ← THIS PLAN              │
│                     │  (external systems)│                           │
│                     └─────────┬─────────┘                            │
│               ┌───────────────┴───────────────┐                      │
│               │      Integration Tests         │  ← Existing         │
│               │   (internal module combos)     │                     │
│               └───────────────┬───────────────┘                      │
│         ┌─────────────────────┴─────────────────────┐                │
│         │              Unit Tests                    │  ← Existing   │
│         │         (single modules, mocked)           │               │
│         └────────────────────────────────────────────┘               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Test Type Definitions

| Test Type       | Scope                     | What's Real         | What's Mocked        | File Pattern            |
| --------------- | ------------------------- | ------------------- | -------------------- | ----------------------- |
| **Unit**        | Single module             | Module under test   | All dependencies     | `*.test.ts`             |
| **Integration** | Multiple internal modules | All modules in test | External systems     | `*.integration.test.ts` |
| **Boundary**    | Module ↔ external entity  | External system     | Nothing (or minimal) | `*.boundary.test.ts`    |
| **System**      | Full application          | Everything          | Nothing              | TBD                     |

### Boundary Test Scope

```
┌─────────────────────────────────────────────────────────────────────┐
│                    APPLICATION BOUNDARY                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  Internal Modules                            │    │
│  │                                                              │    │
│  │   GitWorktreeProvider ──► SimpleGitClient ───────────────────┼────┼──► Git CLI
│  │                                                              │    │
│  │   DiscoveryService ─────► SiPortScanner ─────────────────────┼────┼──► OS netstat
│  │                     └───► PidtreeProvider ───────────────────┼────┼──► OS process tree
│  │                     └───► HttpInstanceProbe ─────────────────┼────┼──► HTTP
│  │                                                              │    │
│  │   AgentStatusManager ───► OpenCodeClient ────────────────────┼────┼──► OpenCode API
│  │                                                              │    │
│  │   AppState ─────────────► CodeServerManager ─────────────────┼────┼──► code-server
│  │                                                              │    │
│  │   Various ──────────────► ProjectStore ──────────────────────┼────┼──► Filesystem
│  │                                                              │    │
│  │   Platform utils ───────► findAvailablePort ─────────────────┼────┼──► TCP/net
│  │                     └───► spawnProcess ──────────────────────┼────┼──► OS processes
│  │                     └───► fetchWithTimeout ──────────────────┼────┼──► HTTP/fetch
│  │                                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ════════════════════════════════════════════════════════════════   │
│                    BOUNDARY (tested in this plan)                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

External Entities:
  • Git CLI (via simple-git)
  • OS netstat (via systeminformation)
  • OS process tree (via pidtree)
  • OS processes (via execa)
  • TCP ports (via net module)
  • HTTP (via fetch)
  • Filesystem (via fs/promises)
  • code-server binary
  • OpenCode server
```

## Implementation Steps

### Phase 1: Testing Strategy Documentation

- [x] **Step 1.1: Create docs/TESTING.md**
  - Define all four test types (unit, integration, boundary, system)
  - Establish naming conventions
  - Document when each test type is required
  - Provide examples for each type
  - Files: `docs/TESTING.md` (new)

- [x] **Step 1.2: Update AGENTS.md**
  - Add testing requirements section
  - Reference docs/TESTING.md
  - Define which tests are required for different code changes
  - Files: `AGENTS.md` (update)

### Phase 2: Boundary Tests Implementation

Each group below will have its own detailed implementation plan created separately.

- [x] **Step 2.A: OS Process Management**
  - External entity: `execa`, `pidtree`
  - Modules:
    | Module | File |
    |--------|------|
    | `spawnProcess` | `src/services/platform/process.ts` |
    | `ExecaProcessRunner` | `src/services/platform/process.ts` |
    | `PidtreeProvider` | `src/services/opencode/process-tree.ts` |
  - Test file: `src/services/platform/process.boundary.test.ts`, `src/services/opencode/process-tree.boundary.test.ts`

- [x] **Step 2.B: OS Networking**
  - External entity: `net` module, `systeminformation`
  - Modules:
    | Module | File |
    |--------|------|
    | `PortManager (DefaultNetworkLayer)` | `src/services/platform/network.ts` |
  - Test file: `src/services/platform/network.boundary.test.ts`
  - Note: PortManager is part of the unified DefaultNetworkLayer (see plan NETWORK_BOUNDARY_TESTS.md)

- [x] **Step 2.C: HTTP**
  - External entity: `fetch`, `EventSource`
  - Modules:
    | Module | File |
    |--------|------|
    | `HttpClient (DefaultNetworkLayer)` | `src/services/platform/network.ts` |
    | `SseClient (DefaultNetworkLayer)` | `src/services/platform/network.ts` |
  - Test file: `src/services/platform/network.boundary.test.ts`
  - Note: HttpClient, SseClient, and PortManager are tested together since DefaultNetworkLayer is a unified module implementing all three interfaces

- [x] **Step 2.D: Filesystem**
  - External entity: `fs/promises`
  - Modules:
    | Module | File |
    |--------|------|
    | `DefaultFileSystemLayer` | `src/services/platform/filesystem.ts` |
  - Test file: `src/services/platform/filesystem.boundary.test.ts`
  - Note: FileSystemLayer abstraction created; ProjectStore uses it via DI

- [x] **Step 2.E: Git**
  - External entity: Git CLI via `simple-git`
  - Modules:
    | Module | File |
    |--------|------|
    | `SimpleGitClient` | `src/services/git/simple-git-client.ts` |
  - Action: Renamed existing `simple-git-client.integration.test.ts` → `simple-git-client.boundary.test.ts`
  - Note: Tests already exist and test against real git repos

- [x] **Step 2.F: code-server Binary**
  - External entity: `code-server` binary + HTTP health endpoint
  - Modules:
    | Module | File |
    |--------|------|
    | `CodeServerManager` | `src/services/code-server/code-server-manager.ts` |
  - Test file: `src/services/code-server/code-server-manager.boundary.test.ts`
  - Prerequisite: `code-server` devDependency available

- [x] **Step 2.G: OpenCode**
  - External entity: `opencode serve` HTTP API + SSE
  - Modules:
    | Module | File |
    |--------|------|
    | `OpenCodeClient` | `src/services/opencode/opencode-client.ts` |
  - Test file: `src/services/opencode/opencode-client.boundary.test.ts`
  - Prerequisite: `opencode-ai` devDependency available

## Testing Strategy

This plan establishes the testing strategy. Each phase will have its own detailed testing approach.

### General Boundary Test Principles

1. **Real external systems**: Tests interact with actual external entities, not mocks
2. **Isolation**: Each test should clean up after itself
3. **CI-compatible**: All tests should be runnable in CI environments
4. **Timeouts**: Appropriate timeouts for external system interactions
5. **Skip conditions**: Tests can be skipped if required binaries are unavailable

### Phase-Specific Strategies

| Phase             | Test Approach                                     |
| ----------------- | ------------------------------------------------- |
| 2.A (Process)     | Spawn real processes, verify lifecycle and output |
| 2.B (Networking)  | Open real sockets, verify port detection          |
| 2.C (HTTP)        | Use local test HTTP server                        |
| 2.D (Filesystem)  | Use temp directories, verify file operations      |
| 2.E (Git)         | Already implemented - uses real git repos         |
| 2.F (code-server) | Start/stop real code-server process               |
| 2.G (OpenCode)    | Start `opencode serve`, test HTTP/SSE             |

## Dependencies

| Package | Purpose                                             | Approved |
| ------- | --------------------------------------------------- | -------- |
| (none)  | No new dependencies - uses existing devDependencies | N/A      |

**Existing devDependencies used:**

- `code-server` - For boundary tests against code-server binary
- `opencode-ai` - For boundary tests against OpenCode server
- `vitest` - Test runner

## Documentation Updates

### Files to Update

| File        | Changes Required                                             |
| ----------- | ------------------------------------------------------------ |
| `AGENTS.md` | Add testing requirements section referencing docs/TESTING.md |

### New Documentation Required

| File              | Purpose                                 |
| ----------------- | --------------------------------------- |
| `docs/TESTING.md` | Complete testing strategy documentation |

## Definition of Done

- [x] Phase 1: `docs/TESTING.md` created with complete testing strategy
- [x] Phase 1: `AGENTS.md` updated with testing requirements
- [x] Phase 2.A-G: Each phase has detailed plan created (separate planning docs)
- [x] Phase 2.A-G: All boundary tests implemented and passing
- [x] All tests runnable in CI environment
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [x] Changes committed

## Implementation Order

```
Phase 1: Documentation (this plan)
│
├── 1.1 Create docs/TESTING.md
│
└── 1.2 Update AGENTS.md
│
▼
Phase 2: Boundary Tests (separate plans for each)
│
├── 2.A: OS Process Management (simplest - process spawn/exec)
│
├── 2.B: OS Networking (medium - socket operations)
│
├── 2.C: HTTP (medium - needs test server)
│
├── 2.D: Filesystem (simple - temp dirs)
│
├── 2.E: Git (rename only - tests exist)
│
├── 2.F: code-server binary (complex - real binary)
│
└── 2.G: OpenCode (complex - real binary + SSE)
```

## Notes

- **Phase 2 implementation**: Each group (A-G) will have its own detailed implementation plan created when that phase begins
- **Existing test rename**: The SimpleGitClient already has real boundary tests, just misnamed as "integration"
- **VscodeSetupService**: Explicitly excluded from this plan (interacts with filesystem + code-server CLI)
- **System tests**: Marked as TBD in the test pyramid - not part of this plan

## Implementation Notes (Added on Completion)

During implementation, several abstraction layers were created to enable both boundary testing and unit testing:

| Abstraction | Interface                                   | Implementation           | Test Utils                 |
| ----------- | ------------------------------------------- | ------------------------ | -------------------------- |
| Filesystem  | `FileSystemLayer`                           | `DefaultFileSystemLayer` | `filesystem.test-utils.ts` |
| Network     | `HttpClient`, `PortManager`                 | `DefaultNetworkLayer`    | `network.test-utils.ts`    |
| Processes   | `ProcessRunner`                             | `ExecaProcessRunner`     | `process.test-utils.ts`    |
| Paths       | `PathProvider`, `BuildInfo`, `PlatformInfo` | Various                  | `*.test-utils.ts`          |

These abstractions are **mandatory** for all external system access. See `AGENTS.md` for usage rules.
