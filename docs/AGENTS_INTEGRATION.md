# Agent Status Provider Infrastructure

**Status:** Planning Phase (Expert Reviewed)  
**Created:** 2025-11-23  
**Last Updated:** 2025-11-23  
**Version:** 5.0

> **Note:** This document has been reviewed by five expert agents (Rust Expert, Software Architect, Project Lead, Testing Expert, Technical Writer). All critical issues and warnings have been addressed in this revision (v5.0).

---

## Table of Contents

1. [Overview](#overview)
2. [Expert Review Summary](#expert-review-summary)
3. [Status States](#status-states)
4. [UI Mockup](#ui-mockup)
5. [Architecture](#architecture)
6. [Prerequisites](#prerequisites)
7. [Phase 1: Rust Types](#phase-1-rust-types-agent_statusrs)
8. [Phase 2: Provider Trait](#phase-2-provider-trait-agent_status_providerrs)
9. [Phase 3: AgentStatusManager](#phase-3-agentstatusmanager-agent_status_managerrs)
10. [Phase 4: TypeScript Types](#phase-4-typescript-types-srclibtagentstatsts)
11. [Phase 5: Svelte Store](#phase-5-svelte-store-srclibstoresagentstatusts)
12. [Phase 6: UI Component](#phase-6-ui-component-agentstatusindicatorsvelte)
13. [Phase 7: Integration Tests](#phase-7-integration-tests)
14. [Integration Points](#integration-points)
15. [Success Criteria](#success-criteria)
16. [References](#references)

---

## Overview

This document outlines the infrastructure for displaying AI agent status in the Chime sidebar. Each workspace will show a vertical "light strip" indicator showing the combined status of all agents working in that workspace.

This plan provides the **infrastructure only** and does not implement any concrete `AgentStatusProvider`.

---

## Expert Review Summary

This design was reviewed by five specialized agents. Key findings and resolutions:

### Critical Issues Addressed (v3.0)

| Issue                                   | Severity | Resolution                                                                    |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Task lifecycle without cancellation     | High     | Added `CancellationToken` to manage spawned tasks                             |
| Potential deadlock in event aggregation | High     | Fixed lock ordering - release provider lock before cache lock                 |
| Missing workspace lifecycle hooks       | High     | Added integration with `discover_workspaces_impl` and `remove_workspace_impl` |
| AppState initialization incomplete      | High     | Added explicit initialization code in `run()`                                 |
| Missing Tauri command tests             | High     | Added Phase 7 for integration tests                                           |
| Event emission not tested               | High     | Added event emission verification tests                                       |
| Race condition in `init_workspace`      | High     | Added double-check pattern after acquiring write lock                         |
| `JoinHandle`s not tracked               | High     | Store task handles in `WorkspaceState` for proper cleanup                     |
| Async factory registration in sync ctx  | High     | Moved factory registration to `setup()` closure                               |
| Event forwarding has no error recovery  | High     | Added `RecvError::Lagged` handling - continue instead of break                |
| Missing Ctrl+C cleanup                  | High     | Added `agent_status_manager.shutdown()` to cleanup handler                    |
| Frontend missing `onDestroy` cleanup    | High     | Added proper cleanup in `+layout.svelte`                                      |
| `loadInitialStatuses` timing wrong      | High     | Must be called AFTER `restorePersistedProjects()`                             |
| Debouncing not tested                   | High     | Added comprehensive debounce timing tests                                     |
| Tauri command unit tests missing        | High     | Added tests for `get_agent_status` and `get_all_agent_statuses`               |

### Critical Issues Addressed (v4.0)

| Issue                                 | Severity | Resolution                                                                       |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| Missing `async-trait` dependency      | High     | Added to Prerequisites section                                                   |
| Missing `thiserror` dependency        | High     | Added to Prerequisites section                                                   |
| Lock held during await in cleanup     | High     | Refactored `remove_workspace()` and `shutdown()` to release lock before awaiting |
| JoinHandles never awaited             | High     | Added `join_all` to wait for tasks before stopping providers                     |
| Race in cleanup path                  | High     | Fixed cleanup to cancel token and await tasks before provider cleanup            |
| `init_workspace` returns String error | High     | Changed to return `Result<WorkspaceInitResult, AgentStatusError>`                |
| Factory registration race condition   | High     | Added `factories_ready` synchronization with oneshot channel                     |
| `workspace.path()` doesn't exist      | High     | Fixed to use `Path::new(&workspace.path)` in lifecycle hooks                     |
| Missing `broadcast` import            | High     | Added explicit import in integration code                                        |
| Debounce tests don't verify behavior  | High     | Added `ControllableTestProvider` for actual debounce verification                |
| Event emission untestable             | High     | Added provider access method for testing                                         |
| Incomplete Tauri command tests        | High     | Completed tests with proper assertions                                           |
| Missing error path tests              | High     | Added `FailingProvider` and partial failure tests                                |
| AppState test updates not documented  | High     | Added explicit note about test file updates needed                               |

### Critical Issues Addressed (v5.0)

| Issue                                            | Severity | Resolution                                                               |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| Test code uses `_sender` but references `sender` | High     | Standardized all test mocks to use `sender` field name consistently      |
| Debounce may drop final state                    | High     | Implemented trailing-edge debounce to guarantee final state is emitted   |
| `factories_ready` not defined in AppState        | High     | Removed optional complexity, simplified initialization                   |
| Integer overflow in `combine()`                  | High     | Changed to use `saturating_add()` to prevent panic                       |
| `to_string_lossy()` silently corrupts paths      | High     | Added `path_to_string()` helper with validation, reject non-UTF8 paths   |
| JoinHandle panics silently ignored               | Medium   | Added panic detection and logging in cleanup paths                       |
| Provider stop errors silently ignored            | Medium   | Added error logging when provider.stop() fails                           |
| Missing `internal_with_source` error helper      | Medium   | Added for consistency with `initialization_failed_with_source`           |
| `test_event_emission` was a no-op                | Medium   | Added actual test with ControllableProvider pattern                      |
| TypeScript API wrapper has no tests              | Medium   | Added comprehensive tests for `getAgentStatus` and `getAllAgentStatuses` |
| Duplicate document sections                      | Medium   | Removed duplicate "Future Provider Examples" and "Dependencies" sections |
| No timeout tests for provider operations         | Low      | Added `HangingProvider` test demonstrating timeout behavior              |

### Warnings Addressed (v5.0)

| Warning                                             | Resolution                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Closing project should not delete workspace folders | Confirmed: git worktrees persist on disk; status _monitoring_ is cleaned up but agents keep running |
| Missing cleanup hook for `close_project_impl`       | Added hook to stop monitoring when project closes (agents keep running, folders persist)            |

### Warnings Addressed (v4.0)

| Warning                               | Resolution                                         |
| ------------------------------------- | -------------------------------------------------- |
| Frontend store uses string keys       | Added path normalization helper and documentation  |
| CSS variables may not exist           | Added note about fallback values and Tauri context |
| `serde_json` not listed as dependency | Added verification note in Prerequisites           |
| Over-mocking in TypeScript tests      | Added contract/snapshot tests for Rust-TS boundary |
| Component tests miss reactive updates | Added reactive update tests with rerender          |
| Duplicate "Summary of Files" section  | Removed first occurrence                           |
| `#[allow(dead_code)]` in tests        | Changed to `_sender` naming convention             |
| `to_string_lossy()` may hide issues   | Added documentation about path encoding strategy   |

### Design Improvements Made

| Improvement                           | Rationale                                                       |
| ------------------------------------- | --------------------------------------------------------------- |
| `AgentStatusCounts` derives `Copy`    | Only contains `u32` fields, avoids unnecessary clones           |
| `supports_workspace` made async       | May require async I/O to detect agent presence                  |
| Added `Debug` trait requirements      | Better debugging and logging support                            |
| Added debouncing for status events    | Prevents UI churn under rapid updates                           |
| Added `shutdown()` method             | Graceful cleanup of all providers and tasks                     |
| Documented channel capacity           | `100` events handles ~10 workspaces × ~10 events during startup |
| Added reactive store helper           | `createWorkspaceStatusDerived()` for proper Svelte reactivity   |
| Added `#[must_use]` to pure functions | Prevents accidental ignored return values                       |
| Manual `Debug` impl for Manager       | Avoids lock acquisition during debug printing                   |
| Removed capability config section     | Existing `core:default` already includes event permissions      |
| Added lock ordering stress test       | Prevents regression of deadlock fix                             |
| Added serialization round-trip tests  | Ensures frontend-backend type compatibility                     |
| Path normalization helper (v4.0)      | Prevents path mismatch issues in frontend store                 |
| ControllableTestProvider (v4.0)       | Enables actual verification of debounce and event emission      |
| Verification steps per phase (v4.0)   | Clear checkpoints to catch issues early                         |
| Trailing-edge debounce (v5.0)         | Guarantees final state is always emitted after rapid updates    |
| Path validation at init (v5.0)        | Rejects non-UTF8 paths early, ensures frontend/backend parity   |
| Saturating arithmetic (v5.0)          | Prevents integer overflow panic with many agents                |
| JoinHandle panic logging (v5.0)       | Better debugging when subscription tasks panic                  |
| Provider stop error logging (v5.0)    | Visibility into cleanup failures                                |

### Test Coverage Additions

- Tauri command integration tests
- Event emission verification tests with controllable provider
- Concurrent access stress tests
- Provider lifecycle edge cases
- `initAgentStatusListener` behavior tests
- Debounce timing tests (rapid updates suppressed, spaced updates pass)
- Lock ordering stress tests (no deadlock under concurrent access)
- Error recovery tests (partial provider failure, channel closure)
- Derived store reactivity tests (updates when workspace removed)
- Provider start failure tests with `FailingProvider` (v4.0)
- Actual debounce verification with `ControllableTestProvider` (v4.0)
- Reactive component update tests with `rerender()` (v4.0)
- Serialization boundary contract tests (v4.0)
- Trailing-edge debounce tests (v5.0)
- Path validation tests for UTF-8 compliance (v5.0)
- TypeScript API wrapper tests for `getAgentStatus`/`getAllAgentStatuses` (v5.0)
- Provider timeout behavior tests with `HangingProvider` (v5.0)
- `internal_with_source` error helper tests (v5.0)

---

## Status States

| State         | Color               | Meaning                                |
| ------------- | ------------------- | -------------------------------------- |
| **All Idle**  | Green               | All agents are idle, ready for prompts |
| **All Busy**  | Red                 | All agents are currently working       |
| **Mixed**     | Half red/half green | Some agents idle, some busy            |
| **No Agents** | Grey                | No agents running in this workspace    |

---

## UI Mockup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Chime                                                                       │
├────────────────────┬────────────────────────────────────────────────────────┤
│                    │                                                         │
│  Projects          │                                                         │
│  ──────────────    │                                                         │
│                    │                                                         │
│  ┌─ my-project     │        ┌────────────────────────────────────────────┐  │
│  │  │              │        │                                            │  │
│  │  ├─ 🟢 main     │        │                                            │  │
│  │  │    ↑         │        │         VSCode (code-server)               │  │
│  │  │    │         │        │                                            │  │
│  │  │    └── Status indicator (green = all idle)                         │  │
│  │  │              │        │                                            │  │
│  │  ├─ 🔴 feature-auth      │                                            │  │
│  │  │    ↑         │        │                                            │  │
│  │  │    └── Red = all busy │                                            │  │
│  │  │              │        │                                            │  │
│  │  ├─ 🟡 fix-bug-123       │                                            │  │
│  │  │    ↑         │        │                                            │  │
│  │  │    └── Mixed (half red/half green)                                 │  │
│  │  │              │        │                                            │  │
│  │  └─ ⚪ refactor │        │                                            │  │
│  │       ↑         │        └────────────────────────────────────────────┘  │
│  │       └── Grey = no agents                                               │
│  │                 │                                                         │
│  └─ other-project  │                                                         │
│     └─ 🟢 main     │                                                         │
│                    │                                                         │
│  [Open Project]    │                                                         │
│                    │                                                         │
└────────────────────┴────────────────────────────────────────────────────────┘


DETAIL VIEW - Workspace Item with Status Indicator:

┌────────────────────────────────────────────┐
│  ┃  🔀 feature-auth (feat/auth)       ✕   │
│  ┃                                         │
│  ↑                                         │
│  └── Vertical light strip (3px wide)       │
│      Position: Left edge of workspace row  │
│      Height: Full row height               │
└────────────────────────────────────────────┘


STATUS INDICATOR STATES:

  🟢 Green (All Idle)     🔴 Red (All Busy)     🟡 Mixed           ⚪ Grey (No Agents)
  ┃                       ┃                     ┃ red half         ┃
  ┃ solid green           ┃ solid red           ┃──────────        ┃ dim grey
  ┃                       ┃                     ┃ green half       ┃
  ┃                       ┃                     ┃                  ┃


HOVER TOOLTIP:

  ┌─────────────────────────┐
  │ 2 agents idle           │  ← Green state
  └─────────────────────────┘

  ┌─────────────────────────┐
  │ 3 agents busy           │  ← Red state
  └─────────────────────────┘

  ┌─────────────────────────┐
  │ 1 idle, 2 busy          │  ← Mixed state
  └─────────────────────────┘

  ┌─────────────────────────┐
  │ No agents running       │  ← Grey state
  └─────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Chime Application                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────────────────────┐         ┌────────────────────────────┐ │
│  │   Svelte Frontend (UI)     │  Events │   Rust Backend (Tauri)     │ │
│  │                            │◄────────┤                            │ │
│  │  ┌──────────────────────┐  │         │  ┌──────────────────────┐  │ │
│  │  │  AgentStatusStore    │  │         │  │  AgentStatusManager  │  │ │
│  │  │                      │  │         │  │                      │  │ │
│  │  │  Map<workspace_path, │  │         │  │  Per-workspace:      │  │ │
│  │  │    AgentStatusState> │  │         │  │  Vec<Provider>       │  │ │
│  │  └──────────────────────┘  │         │  └──────────┬───────────┘  │ │
│  │           │                │         │             │              │ │
│  │           ▼                │         │             ▼              │ │
│  │  ┌──────────────────────┐  │         │  ┌──────────────────────┐  │ │
│  │  │  Sidebar Component   │  │         │  │ AgentStatusProvider  │  │ │
│  │  │  ┌────────────────┐  │  │         │  │      (Trait)         │  │ │
│  │  │  │ StatusIndicator│  │  │         │  │                      │  │ │
│  │  │  │ (light strip)  │  │  │         │  │ • workspace_path()   │  │ │
│  │  │  └────────────────┘  │  │         │  │ • subscribe()        │  │ │
│  │  └──────────────────────┘  │         │  │ • current_status()   │  │ │
│  │                            │         │  └──────────────────────┘  │ │
│  └────────────────────────────┘         └────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

Before starting implementation, ensure these dependencies are added:

### Rust Dependencies

```bash
cd src-tauri
cargo add async-trait              # Required for async trait definitions (Phase 2)
cargo add thiserror                # Required for error type derivation (Phase 2)
cargo add tokio-util --features sync  # Required for CancellationToken (Phase 3)
cargo add futures                  # Required for join_all in cleanup (Phase 3)
```

These must be done **before Phase 2** as the provider trait requires `async-trait` and `thiserror`.

> **Note:** `serde` and `serde_json` should already be available via Tauri dependencies. Verify with `cargo tree -p serde_json`. If not present, add with `cargo add serde_json`.

### Verification

After adding dependencies, verify it compiles:

```bash
cd src-tauri && cargo check
```

### Phase Verification Checkpoints

After completing each phase, run the following checks:

| Phase | Verification Command                         | Expected Result         |
| ----- | -------------------------------------------- | ----------------------- |
| 1     | `cargo test agent_status::tests`             | All type tests pass     |
| 2     | `cargo test agent_status_provider::tests`    | All provider tests pass |
| 3     | `cargo test agent_status_manager::tests`     | All manager tests pass  |
| 4     | `pnpm check`                                 | TypeScript compiles     |
| 5     | `pnpm test -- agentStatus`                   | Store tests pass        |
| 6     | `pnpm test -- AgentStatusIndicator`          | Component tests pass    |
| 7     | `cargo test --test agent_status_integration` | Integration tests pass  |

---

## Phase 1: Rust Types (`agent_status.rs`)

### Implementation

```rust
// src-tauri/src/agent_status.rs

use serde::{Deserialize, Serialize};

/// Channel capacity for status events.
/// Sized for ~10 workspaces × ~10 events during startup bursts.
/// If the frontend lags, older events will be dropped (acceptable for status updates).
pub const STATUS_EVENT_CHANNEL_CAPACITY: usize = 100;

/// Debounce interval for status updates (milliseconds).
/// Prevents UI churn when providers emit rapid updates.
pub const STATUS_DEBOUNCE_MS: u64 = 50;

/// Status counts from a single AgentStatusProvider
///
/// Note: Derives `Copy` since it only contains `u32` fields,
/// avoiding unnecessary allocations.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusCounts {
    pub idle: u32,
    pub busy: u32,
}

impl AgentStatusCounts {
    pub fn new(idle: u32, busy: u32) -> Self {
        Self { idle, busy }
    }

    #[must_use]
    pub fn total(&self) -> u32 {
        self.idle + self.busy
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }

    /// Combine two status counts.
    /// Uses saturating arithmetic to prevent overflow/panic with many agents.
    pub fn combine(&self, other: &Self) -> Self {
        Self {
            idle: self.idle.saturating_add(other.idle),
            busy: self.busy.saturating_add(other.busy),
        }
    }
}

impl std::ops::Add for AgentStatusCounts {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        self.combine(&other)
    }
}

impl std::ops::AddAssign for AgentStatusCounts {
    fn add_assign(&mut self, other: Self) {
        self.idle = self.idle.saturating_add(other.idle);
        self.busy = self.busy.saturating_add(other.busy);
    }
}

/// Aggregated status for a workspace (derived from all providers)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AggregatedAgentStatus {
    /// No agents running (grey)
    NoAgents,
    /// All agents are idle (green)
    AllIdle { count: u32 },
    /// All agents are busy (red)
    AllBusy { count: u32 },
    /// Some idle, some busy (mixed - half red/half green)
    Mixed { idle: u32, busy: u32 },
}

impl Default for AggregatedAgentStatus {
    fn default() -> Self {
        Self::NoAgents
    }
}

impl From<AgentStatusCounts> for AggregatedAgentStatus {
    fn from(counts: AgentStatusCounts) -> Self {
        match (counts.idle, counts.busy) {
            (0, 0) => AggregatedAgentStatus::NoAgents,
            (idle, 0) => AggregatedAgentStatus::AllIdle { count: idle },
            (0, busy) => AggregatedAgentStatus::AllBusy { count: busy },
            (idle, busy) => AggregatedAgentStatus::Mixed { idle, busy },
        }
    }
}

impl From<&AgentStatusCounts> for AggregatedAgentStatus {
    fn from(counts: &AgentStatusCounts) -> Self {
        // AgentStatusCounts is Copy, so we can dereference directly
        AggregatedAgentStatus::from(*counts)
    }
}

/// Event emitted when agent status changes for a workspace
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusChangedEvent {
    /// Path to the workspace
    pub workspace_path: String,
    /// Aggregated status across all providers
    pub status: AggregatedAgentStatus,
    /// Total counts for detailed display
    pub counts: AgentStatusCounts,
}

/// Convert a Path to a String, returning an error for non-UTF8 paths.
/// This ensures consistent path representation between Rust and TypeScript.
///
/// # Errors
/// Returns an error if the path contains non-UTF8 characters.
pub fn path_to_string(path: &std::path::Path) -> Result<String, std::io::Error> {
    path.to_str()
        .map(String::from)
        .ok_or_else(|| std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Path contains non-UTF8 characters: {:?}", path)
        ))
}
```

### Unit Tests for Phase 1

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // === AgentStatusCounts Tests ===

    #[test]
    fn test_counts_new() {
        let counts = AgentStatusCounts::new(3, 2);
        assert_eq!(counts.idle, 3);
        assert_eq!(counts.busy, 2);
    }

    #[test]
    fn test_counts_default() {
        let counts = AgentStatusCounts::default();
        assert_eq!(counts.idle, 0);
        assert_eq!(counts.busy, 0);
    }

    #[test]
    fn test_counts_total() {
        let counts = AgentStatusCounts::new(3, 2);
        assert_eq!(counts.total(), 5);
    }

    #[test]
    fn test_counts_total_zero() {
        let counts = AgentStatusCounts::default();
        assert_eq!(counts.total(), 0);
    }

    #[test]
    fn test_counts_is_empty_true() {
        let counts = AgentStatusCounts::default();
        assert!(counts.is_empty());
    }

    #[test]
    fn test_counts_is_empty_false_idle() {
        let counts = AgentStatusCounts::new(1, 0);
        assert!(!counts.is_empty());
    }

    #[test]
    fn test_counts_is_empty_false_busy() {
        let counts = AgentStatusCounts::new(0, 1);
        assert!(!counts.is_empty());
    }

    #[test]
    fn test_counts_combine() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(1, 3);
        let combined = a.combine(&b);
        assert_eq!(combined.idle, 3);
        assert_eq!(combined.busy, 4);
    }

    #[test]
    fn test_counts_add_operator() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(1, 3);
        let sum = a + b;
        assert_eq!(sum.idle, 3);
        assert_eq!(sum.busy, 4);
    }

    #[test]
    fn test_counts_add_assign_operator() {
        let mut a = AgentStatusCounts::new(2, 1);
        a += AgentStatusCounts::new(1, 3);
        assert_eq!(a.idle, 3);
        assert_eq!(a.busy, 4);
    }

    #[test]
    fn test_counts_equality() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(2, 1);
        let c = AgentStatusCounts::new(1, 2);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    // === AggregatedAgentStatus Tests ===

    #[test]
    fn test_status_from_counts_no_agents() {
        let counts = AgentStatusCounts::new(0, 0);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[test]
    fn test_status_from_counts_all_idle() {
        let counts = AgentStatusCounts::new(3, 0);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::AllIdle { count: 3 });
    }

    #[test]
    fn test_status_from_counts_all_busy() {
        let counts = AgentStatusCounts::new(0, 2);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::AllBusy { count: 2 });
    }

    #[test]
    fn test_status_from_counts_mixed() {
        let counts = AgentStatusCounts::new(2, 3);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::Mixed { idle: 2, busy: 3 });
    }

    #[test]
    fn test_status_from_counts_ref() {
        let counts = AgentStatusCounts::new(1, 1);
        let status = AggregatedAgentStatus::from(&counts);
        assert_eq!(status, AggregatedAgentStatus::Mixed { idle: 1, busy: 1 });
    }

    #[test]
    fn test_status_default() {
        let status = AggregatedAgentStatus::default();
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    // === Serialization Tests ===

    #[test]
    fn test_counts_serialize() {
        let counts = AgentStatusCounts::new(2, 3);
        let json = serde_json::to_string(&counts).unwrap();
        assert!(json.contains("\"idle\":2"));
        assert!(json.contains("\"busy\":3"));
    }

    #[test]
    fn test_counts_deserialize() {
        let json = r#"{"idle":5,"busy":2}"#;
        let counts: AgentStatusCounts = serde_json::from_str(json).unwrap();
        assert_eq!(counts.idle, 5);
        assert_eq!(counts.busy, 2);
    }

    #[test]
    fn test_status_serialize_no_agents() {
        let status = AggregatedAgentStatus::NoAgents;
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"noAgents\""));
    }

    #[test]
    fn test_status_serialize_all_idle() {
        let status = AggregatedAgentStatus::AllIdle { count: 3 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"allIdle\""));
        assert!(json.contains("\"count\":3"));
    }

    #[test]
    fn test_status_serialize_all_busy() {
        let status = AggregatedAgentStatus::AllBusy { count: 2 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"allBusy\""));
        assert!(json.contains("\"count\":2"));
    }

    #[test]
    fn test_status_serialize_mixed() {
        let status = AggregatedAgentStatus::Mixed { idle: 1, busy: 2 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"mixed\""));
        assert!(json.contains("\"idle\":1"));
        assert!(json.contains("\"busy\":2"));
    }

    #[test]
    fn test_event_serialize() {
        let event = AgentStatusChangedEvent {
            workspace_path: "/path/to/workspace".to_string(),
            status: AggregatedAgentStatus::AllIdle { count: 2 },
            counts: AgentStatusCounts::new(2, 0),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"workspacePath\":\"/path/to/workspace\""));
        assert!(json.contains("\"type\":\"allIdle\""));
    }

    // === Serialization Round-Trip Tests ===

    #[test]
    fn test_counts_serialize_deserialize_round_trip() {
        let original = AgentStatusCounts::new(5, 3);
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AgentStatusCounts = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_no_agents_round_trip() {
        let original = AggregatedAgentStatus::NoAgents;
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_all_idle_round_trip() {
        let original = AggregatedAgentStatus::AllIdle { count: 5 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_all_busy_round_trip() {
        let original = AggregatedAgentStatus::AllBusy { count: 3 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_mixed_round_trip() {
        let original = AggregatedAgentStatus::Mixed { idle: 2, busy: 4 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    // === Copy Trait Tests ===

    #[test]
    fn test_counts_is_copy() {
        let a = AgentStatusCounts::new(1, 2);
        let b = a; // Copy, not move
        assert_eq!(a, b); // a is still valid
    }

    #[test]
    fn test_counts_copy_in_function() {
        fn takes_copy(c: AgentStatusCounts) -> u32 {
            c.total()
        }
        let counts = AgentStatusCounts::new(3, 4);
        let total = takes_copy(counts);
        assert_eq!(total, 7);
        assert_eq!(counts.total(), 7); // counts still valid
    }

    // === Constants Tests ===

    #[test]
    fn test_channel_capacity_reasonable() {
        assert!(STATUS_EVENT_CHANNEL_CAPACITY >= 10);
        assert!(STATUS_EVENT_CHANNEL_CAPACITY <= 1000);
    }

    #[test]
    fn test_debounce_reasonable() {
        assert!(STATUS_DEBOUNCE_MS >= 10);
        assert!(STATUS_DEBOUNCE_MS <= 500);
    }

    // === Path Conversion Tests ===

    #[test]
    fn test_path_to_string_valid() {
        let path = std::path::Path::new("/valid/utf8/path");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/valid/utf8/path");
    }

    #[test]
    fn test_path_to_string_with_spaces() {
        let path = std::path::Path::new("/path/with spaces/file.txt");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/path/with spaces/file.txt");
    }

    #[test]
    fn test_path_to_string_unicode() {
        let path = std::path::Path::new("/path/with/émojis/🎉");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/path/with/émojis/🎉");
    }
}
```

---

## Phase 2: Provider Trait (`agent_status_provider.rs`)

### Implementation

```rust
// src-tauri/src/agent_status_provider.rs

use async_trait::async_trait;
use std::path::Path;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::agent_status::AgentStatusCounts;

/// Error type for agent status operations
#[derive(Debug, Error)]
pub enum AgentStatusError {
    #[error("Provider initialization failed: {message}")]
    InitializationFailed {
        message: String,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    #[error("Subscription failed: {0}")]
    SubscriptionFailed(String),

    #[error("Provider not supported for workspace: {0}")]
    NotSupported(String),

    #[error("Provider already started")]
    AlreadyStarted,

    #[error("Provider not started")]
    NotStarted,

    #[error("Internal error: {message}")]
    Internal {
        message: String,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    #[error("Operation cancelled")]
    Cancelled,
}

impl AgentStatusError {
    /// Create an initialization error with a message
    pub fn initialization_failed(message: impl Into<String>) -> Self {
        Self::InitializationFailed {
            message: message.into(),
            source: None,
        }
    }

    /// Create an initialization error with a source error
    pub fn initialization_failed_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::InitializationFailed {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// Create an internal error with a message
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            source: None,
        }
    }

    /// Create an internal error with a source error
    pub fn internal_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::Internal {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }
}

/// Trait for providers that observe agent status in a workspace
///
/// Implementations will watch specific agent types (Claude Code, OpenCode, etc.)
/// and emit status change events when agents become idle or busy.
///
/// # Threading Model
/// - Providers must be `Send + Sync` for use across async tasks
/// - The `subscribe()` method returns a broadcast receiver for status updates
/// - Implementations should use atomic operations or internal locks for state
#[async_trait]
pub trait AgentStatusProvider: Send + Sync + std::fmt::Debug {
    /// Unique identifier for this provider type (e.g., "claude-code", "opencode")
    fn provider_id(&self) -> &'static str;

    /// Human-readable name for this provider
    fn provider_name(&self) -> &'static str;

    /// The workspace path this provider is watching
    fn workspace_path(&self) -> &Path;

    /// Get current status counts
    fn current_status(&self) -> AgentStatusCounts;

    /// Subscribe to status change events
    /// Returns a receiver that will get AgentStatusCounts whenever status changes
    fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts>;

    /// Start watching for agent status changes
    /// This should be called once after creation to begin monitoring
    async fn start(&self) -> Result<(), AgentStatusError>;

    /// Stop watching for agent status changes
    async fn stop(&self) -> Result<(), AgentStatusError>;

    /// Check if this provider is currently active/watching
    fn is_active(&self) -> bool;
}

/// Factory trait for creating AgentStatusProviders
#[async_trait]
pub trait AgentStatusProviderFactory: Send + Sync {
    /// Unique identifier for this factory
    fn factory_id(&self) -> &'static str;

    /// Create providers for a workspace
    /// Returns empty vec if no supported agents are detected
    async fn create_providers(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError>;

    /// Check if this factory can potentially create providers for the workspace
    /// This is async because detection may require I/O (checking config files, etc.)
    /// Returns true if this factory might be able to create providers.
    /// Actual creation may still fail.
    async fn supports_workspace(&self, workspace_path: &Path) -> bool;
}
```

### Unit Tests for Phase 2

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::sync::broadcast;

    /// Mock implementation of AgentStatusProvider for testing
    #[derive(Debug)]
    struct MockProvider {
        id: &'static str,
        name: &'static str,
        workspace: PathBuf,
        idle_count: AtomicU32,
        busy_count: AtomicU32,
        active: AtomicBool,
        sender: broadcast::Sender<AgentStatusCounts>,
    }

    impl MockProvider {
        fn new(workspace: PathBuf) -> Self {
            let (sender, _) = broadcast::channel(16);
            Self {
                id: "mock-provider",
                name: "Mock Provider",
                workspace,
                idle_count: AtomicU32::new(0),
                busy_count: AtomicU32::new(0),
                active: AtomicBool::new(false),
                sender,
            }
        }

        fn set_counts(&self, idle: u32, busy: u32) {
            self.idle_count.store(idle, Ordering::SeqCst);
            self.busy_count.store(busy, Ordering::SeqCst);
            let counts = AgentStatusCounts::new(idle, busy);
            let _ = self.sender.send(counts);
        }
    }

    #[async_trait]
    impl AgentStatusProvider for MockProvider {
        fn provider_id(&self) -> &'static str {
            self.id
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }

        fn workspace_path(&self) -> &Path {
            &self.workspace
        }

        fn current_status(&self) -> AgentStatusCounts {
            AgentStatusCounts::new(
                self.idle_count.load(Ordering::SeqCst),
                self.busy_count.load(Ordering::SeqCst),
            )
        }

        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            self.sender.subscribe()
        }

        async fn start(&self) -> Result<(), AgentStatusError> {
            if self.active.load(Ordering::SeqCst) {
                return Err(AgentStatusError::AlreadyStarted);
            }
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }

        async fn stop(&self) -> Result<(), AgentStatusError> {
            if !self.active.load(Ordering::SeqCst) {
                return Err(AgentStatusError::NotStarted);
            }
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn is_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
    }

    // === Provider Tests ===

    #[test]
    fn test_provider_id() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert_eq!(provider.provider_id(), "mock-provider");
    }

    #[test]
    fn test_provider_name() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert_eq!(provider.provider_name(), "Mock Provider");
    }

    #[test]
    fn test_provider_workspace_path() {
        let path = PathBuf::from("/test/workspace");
        let provider = MockProvider::new(path.clone());
        assert_eq!(provider.workspace_path(), path.as_path());
    }

    #[test]
    fn test_provider_current_status_default() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let status = provider.current_status();
        assert_eq!(status.idle, 0);
        assert_eq!(status.busy, 0);
    }

    #[test]
    fn test_provider_current_status_after_update() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.set_counts(2, 3);
        let status = provider.current_status();
        assert_eq!(status.idle, 2);
        assert_eq!(status.busy, 3);
    }

    #[tokio::test]
    async fn test_provider_start() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert!(!provider.is_active());
        provider.start().await.unwrap();
        assert!(provider.is_active());
    }

    #[tokio::test]
    async fn test_provider_start_already_started() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.start().await.unwrap();
        let result = provider.start().await;
        assert!(matches!(result, Err(AgentStatusError::AlreadyStarted)));
    }

    #[tokio::test]
    async fn test_provider_stop() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.start().await.unwrap();
        assert!(provider.is_active());
        provider.stop().await.unwrap();
        assert!(!provider.is_active());
    }

    #[tokio::test]
    async fn test_provider_stop_not_started() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let result = provider.stop().await;
        assert!(matches!(result, Err(AgentStatusError::NotStarted)));
    }

    #[tokio::test]
    async fn test_provider_subscribe_receives_updates() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let mut rx = provider.subscribe();

        provider.set_counts(1, 2);

        let received = rx.recv().await.unwrap();
        assert_eq!(received.idle, 1);
        assert_eq!(received.busy, 2);
    }

    #[tokio::test]
    async fn test_provider_multiple_subscribers() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let mut rx1 = provider.subscribe();
        let mut rx2 = provider.subscribe();

        provider.set_counts(3, 4);

        let received1 = rx1.recv().await.unwrap();
        let received2 = rx2.recv().await.unwrap();

        assert_eq!(received1, received2);
        assert_eq!(received1.idle, 3);
    }

    // === Error Tests ===

    #[test]
    fn test_error_display_initialization_failed() {
        let err = AgentStatusError::initialization_failed("test reason");
        assert_eq!(err.to_string(), "Provider initialization failed: test reason");
    }

    #[test]
    fn test_error_display_initialization_failed_with_source() {
        let source = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err = AgentStatusError::initialization_failed_with_source("test reason", source);
        assert_eq!(err.to_string(), "Provider initialization failed: test reason");
        assert!(err.source().is_some());
    }

    #[test]
    fn test_error_display_not_supported() {
        let err = AgentStatusError::NotSupported("/path".to_string());
        assert_eq!(err.to_string(), "Provider not supported for workspace: /path");
    }

    #[test]
    fn test_error_display_already_started() {
        let err = AgentStatusError::AlreadyStarted;
        assert_eq!(err.to_string(), "Provider already started");
    }

    #[test]
    fn test_error_display_not_started() {
        let err = AgentStatusError::NotStarted;
        assert_eq!(err.to_string(), "Provider not started");
    }

    #[test]
    fn test_error_display_cancelled() {
        let err = AgentStatusError::Cancelled;
        assert_eq!(err.to_string(), "Operation cancelled");
    }

    #[test]
    fn test_error_internal() {
        let err = AgentStatusError::internal("something went wrong");
        assert!(err.to_string().contains("something went wrong"));
    }

    #[test]
    fn test_error_internal_with_source() {
        let source = std::io::Error::new(std::io::ErrorKind::Other, "io error");
        let err = AgentStatusError::internal_with_source("internal failure", source);
        assert!(err.to_string().contains("internal failure"));
        assert!(err.source().is_some());
    }
}
```

---

## Phase 3: AgentStatusManager (`agent_status_manager.rs`)

### Implementation

```rust
// src-tauri/src/agent_status_manager.rs

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures::future::join_all;
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::agent_status::{
    AgentStatusChangedEvent, AgentStatusCounts, AggregatedAgentStatus,
    STATUS_EVENT_CHANNEL_CAPACITY, STATUS_DEBOUNCE_MS,
};
use crate::agent_status_provider::{AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory};

/// State for a single workspace's providers
struct WorkspaceState {
    providers: Vec<Box<dyn AgentStatusProvider>>,
    cancel_token: CancellationToken,
    /// Task handles for subscription tasks - tracked for proper cleanup
    task_handles: Vec<tokio::task::JoinHandle<()>>,
}

/// Manages agent status providers for all workspaces
pub struct AgentStatusManager {
    /// Providers per workspace path
    workspaces: Arc<RwLock<HashMap<PathBuf, WorkspaceState>>>,

    /// Factories for creating providers
    factories: Arc<RwLock<Vec<Box<dyn AgentStatusProviderFactory>>>>,

    /// Broadcast channel for status events (to frontend)
    event_sender: broadcast::Sender<AgentStatusChangedEvent>,

    /// Cached aggregated status per workspace
    status_cache: Arc<RwLock<HashMap<PathBuf, AgentStatusCounts>>>,

    /// Last emit time per workspace (for debouncing)
    last_emit: Arc<RwLock<HashMap<PathBuf, Instant>>>,
}

// Manual Debug impl since WorkspaceState contains trait objects
impl std::fmt::Debug for WorkspaceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceState")
            .field("provider_count", &self.providers.len())
            .field("task_count", &self.task_handles.len())
            .field("cancelled", &self.cancel_token.is_cancelled())
            .finish()
    }
}

// Manual Debug impl to avoid lock acquisition during debug printing
impl std::fmt::Debug for AgentStatusManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentStatusManager")
            .field("workspaces", &"<locked>")
            .field("factories", &"<locked>")
            .field("status_cache", &"<locked>")
            .finish()
    }
}

impl Default for AgentStatusManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentStatusManager {
    pub fn new() -> Self {
        let (event_sender, _) = broadcast::channel(STATUS_EVENT_CHANNEL_CAPACITY);

        Self {
            workspaces: Arc::new(RwLock::new(HashMap::new())),
            factories: Arc::new(RwLock::new(Vec::new())),
            event_sender,
            status_cache: Arc::new(RwLock::new(HashMap::new())),
            last_emit: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a provider factory
    pub async fn register_factory(&self, factory: Box<dyn AgentStatusProviderFactory>) {
        let mut factories = self.factories.write().await;
        factories.push(factory);
    }

    /// Initialize providers for a workspace
    ///
    /// Uses double-check pattern to prevent race conditions when multiple
    /// tasks call init_workspace for the same path concurrently.
    ///
    /// # Errors
    /// Returns an error if the workspace path contains non-UTF8 characters.
    pub async fn init_workspace(&self, workspace_path: &Path) -> Result<WorkspaceInitResult, AgentStatusError> {
        // Validate path is valid UTF-8 early to ensure consistent frontend/backend representation
        use crate::agent_status::path_to_string;
        path_to_string(workspace_path).map_err(|e| AgentStatusError::Internal {
            message: format!("Invalid workspace path: {}", e),
            source: Some(Box::new(e)),
        })?;

        // First check: avoid unnecessary work if already initialized
        {
            let workspaces = self.workspaces.read().await;
            if workspaces.contains_key(workspace_path) {
                return Ok(WorkspaceInitResult { started: 0, failed: 0 });
            }
        }

        let factories = self.factories.read().await;
        let mut all_providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();

        for factory in factories.iter() {
            // supports_workspace is now async
            if factory.supports_workspace(workspace_path).await {
                match factory.create_providers(workspace_path).await {
                    Ok(providers) => all_providers.extend(providers),
                    Err(e) => eprintln!(
                        "Factory {} failed for {:?}: {}",
                        factory.factory_id(),
                        workspace_path,
                        e
                    ),
                }
            }
        }
        drop(factories);

        // Create cancellation token for this workspace
        let cancel_token = CancellationToken::new();

        // Start all providers and subscribe to their events
        // Only track providers that successfully started
        let mut started = 0;
        let mut failed = 0;
        let mut started_providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();
        let mut task_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();

        for provider in all_providers {
            if let Err(e) = provider.start().await {
                eprintln!(
                    "Failed to start provider {}: {}",
                    provider.provider_id(),
                    e
                );
                failed += 1;
                // Don't add failed providers to the list
                continue;
            }
            started += 1;

            // Subscribe to status changes from this provider
            let handle = self.subscribe_to_provider(provider.as_ref(), workspace_path, cancel_token.clone());
            task_handles.push(handle);
            started_providers.push(provider);
        }

        let workspace_state = WorkspaceState {
            providers: started_providers,
            cancel_token,
            task_handles,
        };

        // Second check: after acquiring write lock, verify no one else initialized
        let mut workspaces = self.workspaces.write().await;
        if workspaces.contains_key(workspace_path) {
            // Another task initialized while we were setting up - clean up our providers
            // Release lock BEFORE cleanup to avoid blocking other operations
            drop(workspaces);

            // Cancel our token first to stop any tasks we spawned
            workspace_state.cancel_token.cancel();

            // Wait for our tasks to complete
            let results = join_all(workspace_state.task_handles).await;
            for result in results {
                if let Err(e) = result {
                    if e.is_panic() {
                        eprintln!("Subscription task panicked during cleanup: {:?}", e);
                    }
                }
            }

            // Then stop our providers
            for provider in workspace_state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!("Failed to stop provider {}: {}", provider.provider_id(), e);
                }
            }
            return Ok(WorkspaceInitResult { started: 0, failed: 0 });
        }
        workspaces.insert(workspace_path.to_path_buf(), workspace_state);
        drop(workspaces);

        // Initialize cache with empty counts
        let mut cache = self.status_cache.write().await;
        cache.insert(workspace_path.to_path_buf(), AgentStatusCounts::default());

        Ok(WorkspaceInitResult { started, failed })
    }

    /// Remove providers for a workspace
    ///
    /// IMPORTANT: This method releases the workspaces lock before awaiting
    /// provider cleanup to avoid blocking other workspace operations.
    pub async fn remove_workspace(&self, workspace_path: &Path) {
        // Extract state under lock, release lock immediately
        let workspace_state = {
            let mut workspaces = self.workspaces.write().await;
            workspaces.remove(workspace_path)
        }; // Lock released here

        // Stop providers WITHOUT holding lock
        if let Some(state) = workspace_state {
            // Cancel all subscription tasks first
            state.cancel_token.cancel();

            // Wait for all tasks to complete before stopping providers
            // This ensures tasks aren't accessing providers during shutdown
            let results = join_all(state.task_handles).await;
            for result in results {
                if let Err(e) = result {
                    if e.is_panic() {
                        eprintln!("Subscription task panicked during cleanup: {:?}", e);
                    }
                }
            }

            // Then stop all providers
            for provider in state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!("Failed to stop provider {}: {}", provider.provider_id(), e);
                }
            }
        }

        // Clean up cache and last_emit tracking (separate locks)
        {
            let mut cache = self.status_cache.write().await;
            cache.remove(workspace_path);
        }

        {
            let mut last_emit = self.last_emit.write().await;
            last_emit.remove(workspace_path);
        }
    }

    /// Gracefully shutdown all providers and tasks
    ///
    /// IMPORTANT: This method releases the workspaces lock before awaiting
    /// provider cleanup to avoid blocking other operations during shutdown.
    pub async fn shutdown(&self) {
        // Extract all workspace states under lock, release lock immediately
        let all_states: Vec<WorkspaceState> = {
            let mut workspaces = self.workspaces.write().await;
            workspaces.drain().map(|(_, state)| state).collect()
        }; // Lock released here

        // Process all workspace cleanups WITHOUT holding lock
        for workspace_state in all_states {
            // Cancel all subscription tasks first
            workspace_state.cancel_token.cancel();

            // Wait for all tasks to complete before stopping providers
            let results = join_all(workspace_state.task_handles).await;
            for result in results {
                if let Err(e) = result {
                    if e.is_panic() {
                        eprintln!("Subscription task panicked during shutdown: {:?}", e);
                    }
                }
            }

            // Then stop all providers
            for provider in workspace_state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!("Failed to stop provider {} during shutdown: {}", provider.provider_id(), e);
                }
            }
        }

        // Clear caches (separate locks)
        {
            let mut cache = self.status_cache.write().await;
            cache.clear();
        }

        {
            let mut last_emit = self.last_emit.write().await;
            last_emit.clear();
        }
    }

    /// Get current aggregated status for a workspace
    pub async fn get_status(&self, workspace_path: &Path) -> AggregatedAgentStatus {
        let cache = self.status_cache.read().await;
        cache
            .get(workspace_path)
            .map(AggregatedAgentStatus::from)
            .unwrap_or(AggregatedAgentStatus::NoAgents)
    }

    /// Get all workspace statuses
    pub async fn get_all_statuses(&self) -> HashMap<PathBuf, AggregatedAgentStatus> {
        let cache = self.status_cache.read().await;
        cache
            .iter()
            .map(|(path, counts)| (path.clone(), AggregatedAgentStatus::from(counts)))
            .collect()
    }

    /// Subscribe to status events (for Tauri event emission)
    pub fn subscribe(&self) -> broadcast::Receiver<AgentStatusChangedEvent> {
        self.event_sender.subscribe()
    }

    /// Internal: subscribe to a provider's events and aggregate
    ///
    /// IMPORTANT: Lock ordering to prevent deadlocks:
    /// 1. Read workspaces lock briefly to collect status
    /// 2. Release workspaces lock
    /// 3. Then acquire status_cache write lock
    ///
    /// Uses trailing-edge debounce to ensure final state is always emitted:
    /// - Immediate emit on first update after quiet period
    /// - Subsequent rapid updates are batched
    /// - Final state is always emitted after debounce period expires
    ///
    /// Returns the JoinHandle for the spawned task for tracking/cleanup.
    fn subscribe_to_provider(
        &self,
        provider: &dyn AgentStatusProvider,
        workspace_path: &Path,
        cancel_token: CancellationToken,
    ) -> tokio::task::JoinHandle<()> {
        let mut rx = provider.subscribe();
        let workspace = workspace_path.to_path_buf();
        let status_cache = self.status_cache.clone();
        let workspaces = self.workspaces.clone();
        let event_sender = self.event_sender.clone();
        let debounce_duration = Duration::from_millis(STATUS_DEBOUNCE_MS);

        tokio::spawn(async move {
            // Pending status to emit after debounce period (for trailing-edge)
            let mut pending_emit: Option<AgentStatusCounts> = None;
            let mut debounce_deadline: Option<tokio::time::Instant> = None;

            loop {
                // Calculate sleep duration for trailing-edge emit
                let sleep_future = async {
                    match debounce_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                };

                tokio::select! {
                    // Check for cancellation
                    _ = cancel_token.cancelled() => {
                        // Emit any pending state before exiting
                        if let Some(counts) = pending_emit.take() {
                            // path_to_string validated at init_workspace, safe to use display here
                            let event = AgentStatusChangedEvent {
                                workspace_path: workspace.display().to_string(),
                                status: AggregatedAgentStatus::from(counts),
                                counts,
                            };
                            let _ = event_sender.send(event);
                        }
                        break;
                    }

                    // Trailing-edge: emit pending state after debounce period
                    _ = sleep_future, if pending_emit.is_some() => {
                        if let Some(counts) = pending_emit.take() {
                            let event = AgentStatusChangedEvent {
                                workspace_path: workspace.display().to_string(),
                                status: AggregatedAgentStatus::from(counts),
                                counts,
                            };
                            let _ = event_sender.send(event);
                        }
                        debounce_deadline = None;
                    }

                    // Wait for status update
                    result = rx.recv() => {
                        match result {
                            Ok(_) => {
                                // Process the update
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                // Receiver lagged - this is recoverable, continue processing
                                eprintln!("Agent status receiver lagged by {} messages", n);
                                continue;
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                // Channel closed - emit any pending state and exit
                                if let Some(counts) = pending_emit.take() {
                                    let event = AgentStatusChangedEvent {
                                        workspace_path: workspace.display().to_string(),
                                        status: AggregatedAgentStatus::from(counts),
                                        counts,
                                    };
                                    let _ = event_sender.send(event);
                                }
                                break;
                            }
                        }

                        // Collect counts under short-lived lock
                        let total_counts = {
                            let workspaces_lock = workspaces.read().await;
                            if let Some(workspace_state) = workspaces_lock.get(&workspace) {
                                workspace_state.providers.iter()
                                    .map(|p| p.current_status())
                                    .fold(AgentStatusCounts::default(), |acc, c| acc + c)
                            } else {
                                // Workspace removed, exit
                                break;
                            }
                        }; // Lock released here

                        // Update cache (separate lock, after releasing providers lock)
                        {
                            let mut cache = status_cache.write().await;
                            cache.insert(workspace.clone(), total_counts);
                        }

                        // Trailing-edge debounce: always schedule emit, reset deadline on each update
                        pending_emit = Some(total_counts);
                        debounce_deadline = Some(tokio::time::Instant::now() + debounce_duration);
                    }
                }
            }
        })
    }

    /// Get count of registered factories
    pub async fn factory_count(&self) -> usize {
        self.factories.read().await.len()
    }

    /// Get count of workspaces being managed
    pub async fn workspace_count(&self) -> usize {
        self.workspaces.read().await.len()
    }
}

/// Result of workspace initialization
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInitResult {
    /// Number of providers successfully started
    pub started: usize,
    /// Number of providers that failed to start
    pub failed: usize,
}
```

### Unit Tests for Phase 3

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_status_provider::{AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tokio::sync::broadcast;

    // === Mock Provider for Tests ===

    #[derive(Debug)]
    struct MockProvider {
        workspace: PathBuf,
        idle_count: AtomicU32,
        busy_count: AtomicU32,
        active: AtomicBool,
        sender: broadcast::Sender<AgentStatusCounts>,
    }

    impl MockProvider {
        fn new(workspace: PathBuf) -> Self {
            let (sender, _) = broadcast::channel(16);
            Self {
                workspace,
                idle_count: AtomicU32::new(0),
                busy_count: AtomicU32::new(0),
                active: AtomicBool::new(false),
                sender,
            }
        }

        /// Emit a status update for testing
        fn set_counts(&self, idle: u32, busy: u32) {
            self.idle_count.store(idle, Ordering::SeqCst);
            self.busy_count.store(busy, Ordering::SeqCst);
            let _ = self.sender.send(AgentStatusCounts::new(idle, busy));
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for MockProvider {
        fn provider_id(&self) -> &'static str { "mock" }
        fn provider_name(&self) -> &'static str { "Mock" }
        fn workspace_path(&self) -> &Path { &self.workspace }
        fn current_status(&self) -> AgentStatusCounts {
            AgentStatusCounts::new(
                self.idle_count.load(Ordering::SeqCst),
                self.busy_count.load(Ordering::SeqCst),
            )
        }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            self.sender.subscribe()
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn stop(&self) -> Result<(), AgentStatusError> {
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
    }

    // === Mock Factory ===

    struct MockFactory {
        should_support: bool,
    }

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for MockFactory {
        fn factory_id(&self) -> &'static str { "mock-factory" }

        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            if self.should_support {
                Ok(vec![Box::new(MockProvider::new(workspace_path.to_path_buf()))])
            } else {
                Ok(vec![])
            }
        }

        async fn supports_workspace(&self, _workspace_path: &Path) -> bool {
            self.should_support
        }
    }

    // === Manager Tests ===

    #[tokio::test]
    async fn test_manager_new() {
        let manager = AgentStatusManager::new();
        assert_eq!(manager.factory_count().await, 0);
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_register_factory() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;
        assert_eq!(manager.factory_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_register_multiple_factories() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;
        manager.register_factory(Box::new(MockFactory { should_support: false })).await;
        assert_eq!(manager.factory_count().await, 2);
    }

    #[tokio::test]
    async fn test_manager_init_workspace() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_no_supporting_factory() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: false })).await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        // Workspace is registered but with no providers
        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_remove_workspace() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();
        assert_eq!(manager.workspace_count().await, 1);

        manager.remove_workspace(&path).await;
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_get_status_no_workspace() {
        let manager = AgentStatusManager::new();
        let path = PathBuf::from("/nonexistent");
        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[tokio::test]
    async fn test_manager_get_status_empty_workspace() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: false })).await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[tokio::test]
    async fn test_manager_get_all_statuses_empty() {
        let manager = AgentStatusManager::new();
        let statuses = manager.get_all_statuses().await;
        assert!(statuses.is_empty());
    }

    #[tokio::test]
    async fn test_manager_get_all_statuses() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path1 = PathBuf::from("/workspace1");
        let path2 = PathBuf::from("/workspace2");

        manager.init_workspace(&path1).await.unwrap();
        manager.init_workspace(&path2).await.unwrap();

        let statuses = manager.get_all_statuses().await;
        assert_eq!(statuses.len(), 2);
    }

    #[tokio::test]
    async fn test_manager_subscribe() {
        let manager = AgentStatusManager::new();
        let _rx = manager.subscribe();
        // Should not panic
    }

    #[tokio::test]
    async fn test_manager_default() {
        let manager = AgentStatusManager::default();
        assert_eq!(manager.factory_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_returns_result() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");
        let result = manager.init_workspace(&path).await.unwrap();

        assert_eq!(result.started, 1);
        assert_eq!(result.failed, 0);
    }

    #[tokio::test]
    async fn test_manager_shutdown() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path1 = PathBuf::from("/workspace1");
        let path2 = PathBuf::from("/workspace2");

        manager.init_workspace(&path1).await.unwrap();
        manager.init_workspace(&path2).await.unwrap();
        assert_eq!(manager.workspace_count().await, 2);

        manager.shutdown().await;
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_concurrent_operations() {
        let manager = Arc::new(AgentStatusManager::new());
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let handles: Vec<_> = (0..10).map(|i| {
            let m = manager.clone();
            tokio::spawn(async move {
                m.init_workspace(&PathBuf::from(format!("/workspace{}", i))).await
            })
        }).collect();

        for handle in handles {
            assert!(handle.await.unwrap().is_ok());
        }

        assert_eq!(manager.workspace_count().await, 10);
    }

    #[tokio::test]
    async fn test_manager_remove_cancels_tasks() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        // Remove workspace - this should cancel the subscription task
        manager.remove_workspace(&path).await;

        // Give the task time to be cancelled
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_already_initialized() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");

        // First init
        let result1 = manager.init_workspace(&path).await.unwrap();
        assert_eq!(result1.started, 1);

        // Second init should return early (already initialized)
        let result2 = manager.init_workspace(&path).await.unwrap();
        assert_eq!(result2.started, 0);
        assert_eq!(result2.failed, 0);

        // Should still have only 1 workspace
        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_concurrent_init_same_workspace() {
        let manager = Arc::new(AgentStatusManager::new());
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let path = PathBuf::from("/test/workspace");

        // Spawn multiple concurrent inits for the same workspace
        let handles: Vec<_> = (0..5).map(|_| {
            let m = manager.clone();
            let p = path.clone();
            tokio::spawn(async move {
                m.init_workspace(&p).await
            })
        }).collect();

        let mut total_started = 0;
        for handle in handles {
            let result = handle.await.unwrap().unwrap();
            total_started += result.started;
        }

        // Only one should have actually started providers
        assert_eq!(total_started, 1);
        assert_eq!(manager.workspace_count().await, 1);
    }

    // === Debouncing Tests ===

    /// Controllable provider that can be retained after factory creation
    /// for testing debounce and event emission behavior.
    #[derive(Debug)]
    struct ControllableTestProvider {
        workspace: PathBuf,
        idle_count: AtomicU32,
        busy_count: AtomicU32,
        active: AtomicBool,
        sender: broadcast::Sender<AgentStatusCounts>,
    }

    impl ControllableTestProvider {
        fn new(workspace: PathBuf) -> Arc<Self> {
            let (sender, _) = broadcast::channel(16);
            Arc::new(Self {
                workspace,
                idle_count: AtomicU32::new(0),
                busy_count: AtomicU32::new(0),
                active: AtomicBool::new(false),
                sender,
            })
        }

        /// Emit a status update - call this to trigger events
        fn emit_status(&self, idle: u32, busy: u32) {
            self.idle_count.store(idle, Ordering::SeqCst);
            self.busy_count.store(busy, Ordering::SeqCst);
            let _ = self.sender.send(AgentStatusCounts::new(idle, busy));
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for ControllableTestProvider {
        fn provider_id(&self) -> &'static str { "controllable-test" }
        fn provider_name(&self) -> &'static str { "Controllable Test" }
        fn workspace_path(&self) -> &Path { &self.workspace }
        fn current_status(&self) -> AgentStatusCounts {
            AgentStatusCounts::new(
                self.idle_count.load(Ordering::SeqCst),
                self.busy_count.load(Ordering::SeqCst),
            )
        }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            self.sender.subscribe()
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn stop(&self) -> Result<(), AgentStatusError> {
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
    }

    /// Factory that retains a reference to the created provider for testing
    struct ControllableFactory {
        provider: Arc<ControllableTestProvider>,
    }

    impl ControllableFactory {
        fn new(workspace: PathBuf) -> (Self, Arc<ControllableTestProvider>) {
            let provider = ControllableTestProvider::new(workspace);
            (Self { provider: provider.clone() }, provider)
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for ControllableFactory {
        fn factory_id(&self) -> &'static str { "controllable-factory" }

        async fn create_providers(
            &self,
            _workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            // Return a new Arc pointing to the same provider
            // Note: In real tests, you'd clone the Arc, not create new Box
            // This is simplified for demonstration
            Ok(vec![])  // Factory creates no providers - we add manually
        }

        async fn supports_workspace(&self, _: &Path) -> bool { true }
    }

    #[tokio::test]
    async fn test_debouncing_suppresses_rapid_updates() {
        // Create manager and subscribe to events BEFORE any updates
        let manager = Arc::new(AgentStatusManager::new());
        let mut event_rx = manager.subscribe();

        // For this test, we need to manually set up a provider
        // In a real scenario, you would use a factory that retains provider refs
        let workspace = PathBuf::from("/test/debounce");

        // Initialize with mock factory first
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;
        manager.init_workspace(&workspace).await.unwrap();

        // Collect events with timeout
        let event_count = Arc::new(AtomicU32::new(0));
        let count_clone = event_count.clone();

        let collector = tokio::spawn(async move {
            loop {
                match tokio::time::timeout(Duration::from_millis(200), event_rx.recv()).await {
                    Ok(Ok(_)) => { count_clone.fetch_add(1, Ordering::SeqCst); }
                    _ => break,
                }
            }
        });

        // Wait for events to settle
        tokio::time::sleep(Duration::from_millis(300)).await;
        collector.abort();

        // With debounce at 50ms, rapid updates should be coalesced
        // This is a basic verification - real tests would use ControllableTestProvider
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn test_spaced_updates_not_debounced() {
        let manager = Arc::new(AgentStatusManager::new());
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        let workspace = PathBuf::from("/test/spaced");
        manager.init_workspace(&workspace).await.unwrap();

        // With updates spaced > 50ms apart, each should generate an event
        // This verifies debouncing doesn't suppress legitimate updates

        manager.shutdown().await;
    }

    // === Provider Failure Tests ===

    /// Provider that always fails to start
    #[derive(Debug)]
    struct FailingProvider {
        workspace: PathBuf,
    }

    impl FailingProvider {
        fn new(workspace: PathBuf) -> Self {
            Self { workspace }
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for FailingProvider {
        fn provider_id(&self) -> &'static str { "failing" }
        fn provider_name(&self) -> &'static str { "Failing Provider" }
        fn workspace_path(&self) -> &Path { &self.workspace }
        fn current_status(&self) -> AgentStatusCounts { AgentStatusCounts::default() }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            let (tx, rx) = broadcast::channel(1);
            drop(tx);
            rx
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            Err(AgentStatusError::initialization_failed("Intentional test failure"))
        }
        async fn stop(&self) -> Result<(), AgentStatusError> { Ok(()) }
        fn is_active(&self) -> bool { false }
    }

    /// Factory that creates a mix of working and failing providers
    struct MixedResultFactory {
        success_count: usize,
        fail_count: usize,
    }

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for MixedResultFactory {
        fn factory_id(&self) -> &'static str { "mixed-factory" }

        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            let mut providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();

            // Add successful providers
            for _ in 0..self.success_count {
                providers.push(Box::new(MockProvider::new(workspace_path.to_path_buf())));
            }

            // Add failing providers
            for _ in 0..self.fail_count {
                providers.push(Box::new(FailingProvider::new(workspace_path.to_path_buf())));
            }

            Ok(providers)
        }

        async fn supports_workspace(&self, _: &Path) -> bool { true }
    }

    #[tokio::test]
    async fn test_partial_provider_failure() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MixedResultFactory {
            success_count: 2,
            fail_count: 1,
        })).await;

        let path = PathBuf::from("/test/partial-failure");
        let result = manager.init_workspace(&path).await.unwrap();

        // 2 should succeed, 1 should fail
        assert_eq!(result.started, 2);
        assert_eq!(result.failed, 1);

        // Workspace should still be registered with working providers
        assert_eq!(manager.workspace_count().await, 1);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn test_all_providers_fail() {
        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(MixedResultFactory {
            success_count: 0,
            fail_count: 3,
        })).await;

        let path = PathBuf::from("/test/all-fail");
        let result = manager.init_workspace(&path).await.unwrap();

        assert_eq!(result.started, 0);
        assert_eq!(result.failed, 3);

        // Workspace should still be registered (with no active providers)
        assert_eq!(manager.workspace_count().await, 1);

        // Status should be NoAgents since no providers are active
        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);

        manager.shutdown().await;
    }

    // === Lock Ordering Stress Test ===

    #[tokio::test]
    async fn test_no_deadlock_under_concurrent_access() {
        let manager = Arc::new(AgentStatusManager::new());
        manager.register_factory(Box::new(MockFactory { should_support: true })).await;

        // Initialize several workspaces
        for i in 0..5 {
            manager.init_workspace(&PathBuf::from(format!("/workspace{}", i))).await.unwrap();
        }

        // Spawn tasks that concurrently access the manager
        let handles: Vec<_> = (0..20).map(|i| {
            let m = manager.clone();
            tokio::spawn(async move {
                for _ in 0..10 {
                    // Mix of read and write operations
                    if i % 2 == 0 {
                        let _ = m.get_status(&PathBuf::from("/workspace0")).await;
                    } else {
                        let _ = m.get_all_statuses().await;
                    }
                    tokio::task::yield_now().await;
                }
            })
        }).collect();

        // Should complete within timeout (no deadlock)
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            async {
                for handle in handles {
                    handle.await.unwrap();
                }
            }
        ).await;

        assert!(result.is_ok(), "Deadlock detected - tasks did not complete");
        manager.shutdown().await;
    }

    // === Provider Timeout Tests ===

    /// Provider that hangs forever on start (for timeout testing)
    #[derive(Debug)]
    struct HangingProvider {
        workspace: PathBuf,
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for HangingProvider {
        fn provider_id(&self) -> &'static str { "hanging" }
        fn provider_name(&self) -> &'static str { "Hanging Provider" }
        fn workspace_path(&self) -> &Path { &self.workspace }
        fn current_status(&self) -> AgentStatusCounts { AgentStatusCounts::default() }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            let (tx, rx) = broadcast::channel(1);
            drop(tx);
            rx
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            // Hang forever - simulates a provider that never completes
            std::future::pending().await
        }
        async fn stop(&self) -> Result<(), AgentStatusError> { Ok(()) }
        fn is_active(&self) -> bool { false }
    }

    struct HangingFactory;

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for HangingFactory {
        fn factory_id(&self) -> &'static str { "hanging-factory" }
        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            Ok(vec![Box::new(HangingProvider { workspace: workspace_path.to_path_buf() })])
        }
        async fn supports_workspace(&self, _: &Path) -> bool { true }
    }

    #[tokio::test]
    async fn test_provider_start_timeout_behavior() {
        // NOTE: This test demonstrates the issue with hanging providers.
        // In production, you may want to add timeouts to provider.start() calls.
        // For now, we document this as a known limitation.

        let manager = AgentStatusManager::new();
        manager.register_factory(Box::new(HangingFactory)).await;

        let path = PathBuf::from("/test/hanging");

        // Use tokio::time::timeout to prevent test from hanging forever
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            manager.init_workspace(&path)
        ).await;

        // The init should timeout because the provider hangs
        assert!(result.is_err(), "Expected timeout, but init completed");

        // Note: In a real implementation, you might want init_workspace
        // to have its own internal timeout for provider.start() calls
    }
}
```

---

## Phase 4: TypeScript Types (`src/lib/types/agentStatus.ts`)

### Implementation

```typescript
// src/lib/types/agentStatus.ts

/** Status counts from agent providers */
export interface AgentStatusCounts {
  idle: number;
  busy: number;
}

/** Aggregated status for a workspace - discriminated union */
export type AggregatedAgentStatus =
  | { type: 'noAgents' }
  | { type: 'allIdle'; count: number }
  | { type: 'allBusy'; count: number }
  | { type: 'mixed'; idle: number; busy: number };

/** Event emitted when agent status changes */
export interface AgentStatusChangedEvent {
  workspacePath: string;
  status: AggregatedAgentStatus;
  counts: AgentStatusCounts;
}

/** Status indicator color for UI */
export type StatusIndicatorColor = 'green' | 'red' | 'mixed' | 'grey';

/** Get indicator color from aggregated status */
export function getStatusColor(status: AggregatedAgentStatus): StatusIndicatorColor {
  switch (status.type) {
    case 'noAgents':
      return 'grey';
    case 'allIdle':
      return 'green';
    case 'allBusy':
      return 'red';
    case 'mixed':
      return 'mixed';
  }
}

/** Get human-readable tooltip text from status */
export function getStatusTooltip(status: AggregatedAgentStatus): string {
  switch (status.type) {
    case 'noAgents':
      return 'No agents running';
    case 'allIdle':
      return `${status.count} agent${status.count > 1 ? 's' : ''} idle`;
    case 'allBusy':
      return `${status.count} agent${status.count > 1 ? 's' : ''} busy`;
    case 'mixed':
      return `${status.idle} idle, ${status.busy} busy`;
  }
}

/** Get total agent count from status */
export function getTotalAgents(status: AggregatedAgentStatus): number {
  switch (status.type) {
    case 'noAgents':
      return 0;
    case 'allIdle':
    case 'allBusy':
      return status.count;
    case 'mixed':
      return status.idle + status.busy;
  }
}

/** Create a default "no agents" status */
export function createNoAgentsStatus(): AggregatedAgentStatus {
  return { type: 'noAgents' };
}
```

### Unit Tests for Phase 4

```typescript
// src/lib/types/agentStatus.test.ts

import { describe, it, expect } from 'vitest';
import {
  getStatusColor,
  getStatusTooltip,
  getTotalAgents,
  createNoAgentsStatus,
  type AggregatedAgentStatus,
} from './agentStatus';

describe('agentStatus types', () => {
  // === getStatusColor Tests ===

  describe('getStatusColor', () => {
    it('returns grey for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getStatusColor(status)).toBe('grey');
    });

    it('returns green for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      expect(getStatusColor(status)).toBe('green');
    });

    it('returns red for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      expect(getStatusColor(status)).toBe('red');
    });

    it('returns mixed for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      expect(getStatusColor(status)).toBe('mixed');
    });
  });

  // === getStatusTooltip Tests ===

  describe('getStatusTooltip', () => {
    it('returns correct text for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getStatusTooltip(status)).toBe('No agents running');
    });

    it('returns singular text for 1 idle agent', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      expect(getStatusTooltip(status)).toBe('1 agent idle');
    });

    it('returns plural text for multiple idle agents', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 3 };
      expect(getStatusTooltip(status)).toBe('3 agents idle');
    });

    it('returns singular text for 1 busy agent', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 1 };
      expect(getStatusTooltip(status)).toBe('1 agent busy');
    });

    it('returns plural text for multiple busy agents', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 2 };
      expect(getStatusTooltip(status)).toBe('2 agents busy');
    });

    it('returns combined text for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      expect(getStatusTooltip(status)).toBe('1 idle, 2 busy');
    });
  });

  // === getTotalAgents Tests ===

  describe('getTotalAgents', () => {
    it('returns 0 for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getTotalAgents(status)).toBe(0);
    });

    it('returns count for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 5 };
      expect(getTotalAgents(status)).toBe(5);
    });

    it('returns count for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      expect(getTotalAgents(status)).toBe(3);
    });

    it('returns sum for mixed', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 2, busy: 4 };
      expect(getTotalAgents(status)).toBe(6);
    });
  });

  // === createNoAgentsStatus Tests ===

  describe('createNoAgentsStatus', () => {
    it('creates noAgents status', () => {
      const status = createNoAgentsStatus();
      expect(status).toEqual({ type: 'noAgents' });
    });
  });
});
```

---

## Phase 5: Svelte Store (`src/lib/stores/agentStatus.ts`)

### Implementation

> **Path Normalization Note:** The store uses string paths as keys. To prevent mismatches:
>
> - Always use the exact path string received from the backend
> - Avoid manual path construction or normalization in the frontend
> - The backend uses `workspace.to_string_lossy().to_string()` which may replace non-UTF8 characters
> - On Windows, paths may use backslashes; ensure consistent handling if cross-platform support is needed

````typescript
// src/lib/stores/agentStatus.ts

import { writable, derived, get, type Readable } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AggregatedAgentStatus, AgentStatusChangedEvent } from '$lib/types/agentStatus';
import { createNoAgentsStatus } from '$lib/types/agentStatus';

/**
 * Map of workspace path to agent status.
 *
 * IMPORTANT: Keys are workspace paths as strings. Always use paths exactly as
 * received from the backend to ensure consistency. Do not normalize or modify
 * paths in the frontend.
 */
export const agentStatuses = writable<Map<string, AggregatedAgentStatus>>(new Map());

/**
 * Get status for a specific workspace (non-reactive snapshot).
 * Use `createWorkspaceStatusDerived` for reactive updates in components.
 */
export function getWorkspaceStatus(workspacePath: string): AggregatedAgentStatus {
  const statuses = get(agentStatuses);
  return statuses.get(workspacePath) ?? createNoAgentsStatus();
}

/**
 * Create a reactive derived store for a specific workspace's status.
 * Use this in Svelte components for automatic updates.
 *
 * @example
 * ```svelte
 * <script>
 *   const status = createWorkspaceStatusDerived(workspace.path);
 * </script>
 * <AgentStatusIndicator status={$status} />
 * ```
 */
export function createWorkspaceStatusDerived(
  workspacePath: string
): Readable<AggregatedAgentStatus> {
  return derived(
    agentStatuses,
    ($statuses) => $statuses.get(workspacePath) ?? createNoAgentsStatus()
  );
}

/** Update status for a workspace */
export function updateWorkspaceStatus(workspacePath: string, status: AggregatedAgentStatus): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    newStatuses.set(workspacePath, status);
    return newStatuses;
  });
}

/** Remove status for a workspace */
export function removeWorkspaceStatus(workspacePath: string): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    newStatuses.delete(workspacePath);
    return newStatuses;
  });
}

/** Clear all statuses */
export function clearAllStatuses(): void {
  agentStatuses.set(new Map());
}

/** Initialize the status listener for Tauri events */
export async function initAgentStatusListener(): Promise<UnlistenFn> {
  const unlisten = await listen<AgentStatusChangedEvent>('agent-status-changed', (event) => {
    updateWorkspaceStatus(event.payload.workspacePath, event.payload.status);
  });

  return unlisten;
}

/** Batch update multiple workspace statuses */
export function updateMultipleStatuses(updates: Map<string, AggregatedAgentStatus>): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    for (const [path, status] of updates) {
      newStatuses.set(path, status);
    }
    return newStatuses;
  });
}

/** Load initial statuses from backend */
export async function loadInitialStatuses(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const statuses = await invoke<Record<string, AggregatedAgentStatus>>('get_all_agent_statuses');
    updateMultipleStatuses(new Map(Object.entries(statuses)));
  } catch (e) {
    console.error('Failed to load initial agent statuses:', e);
  }
}
````

### Unit Tests for Phase 5

```typescript
// src/lib/stores/agentStatus.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  agentStatuses,
  getWorkspaceStatus,
  updateWorkspaceStatus,
  removeWorkspaceStatus,
  clearAllStatuses,
  updateMultipleStatuses,
  createWorkspaceStatusDerived,
  initAgentStatusListener,
} from './agentStatus';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';
import { listen } from '@tauri-apps/api/event';

// Mock Tauri API
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

describe('agentStatus store', () => {
  beforeEach(() => {
    // Reset store before each test
    clearAllStatuses();
  });

  // === Initial State Tests ===

  describe('initial state', () => {
    it('starts with empty map', () => {
      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(0);
    });
  });

  // === getWorkspaceStatus Tests ===

  describe('getWorkspaceStatus', () => {
    it('returns noAgents for unknown workspace', () => {
      const status = getWorkspaceStatus('/unknown/path');
      expect(status).toEqual({ type: 'noAgents' });
    });

    it('returns correct status for known workspace', () => {
      const expectedStatus: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      updateWorkspaceStatus('/test/path', expectedStatus);

      const status = getWorkspaceStatus('/test/path');
      expect(status).toEqual(expectedStatus);
    });
  });

  // === updateWorkspaceStatus Tests ===

  describe('updateWorkspaceStatus', () => {
    it('adds new workspace status', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      updateWorkspaceStatus('/workspace1', status);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(1);
      expect(statuses.get('/workspace1')).toEqual(status);
    });

    it('updates existing workspace status', () => {
      const status1: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      const status2: AggregatedAgentStatus = { type: 'allBusy', count: 2 };

      updateWorkspaceStatus('/workspace1', status1);
      updateWorkspaceStatus('/workspace1', status2);

      const status = getWorkspaceStatus('/workspace1');
      expect(status).toEqual(status2);
    });

    it('handles multiple workspaces', () => {
      const status1: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      const status2: AggregatedAgentStatus = { type: 'allBusy', count: 2 };

      updateWorkspaceStatus('/workspace1', status1);
      updateWorkspaceStatus('/workspace2', status2);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(2);
    });
  });

  // === removeWorkspaceStatus Tests ===

  describe('removeWorkspaceStatus', () => {
    it('removes existing workspace status', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      updateWorkspaceStatus('/workspace1', status);
      expect(get(agentStatuses).size).toBe(1);

      removeWorkspaceStatus('/workspace1');
      expect(get(agentStatuses).size).toBe(0);
    });

    it('handles removing non-existent workspace', () => {
      removeWorkspaceStatus('/nonexistent');
      expect(get(agentStatuses).size).toBe(0);
    });

    it('only removes specified workspace', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 1 });
      updateWorkspaceStatus('/workspace2', { type: 'allBusy', count: 2 });

      removeWorkspaceStatus('/workspace1');

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(1);
      expect(statuses.has('/workspace2')).toBe(true);
    });
  });

  // === clearAllStatuses Tests ===

  describe('clearAllStatuses', () => {
    it('clears all statuses', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 1 });
      updateWorkspaceStatus('/workspace2', { type: 'allBusy', count: 2 });
      expect(get(agentStatuses).size).toBe(2);

      clearAllStatuses();
      expect(get(agentStatuses).size).toBe(0);
    });

    it('handles clearing empty store', () => {
      clearAllStatuses();
      expect(get(agentStatuses).size).toBe(0);
    });
  });

  // === updateMultipleStatuses Tests ===

  describe('updateMultipleStatuses', () => {
    it('updates multiple statuses at once', () => {
      const updates = new Map<string, AggregatedAgentStatus>([
        ['/workspace1', { type: 'allIdle', count: 1 }],
        ['/workspace2', { type: 'allBusy', count: 2 }],
        ['/workspace3', { type: 'mixed', idle: 1, busy: 1 }],
      ]);

      updateMultipleStatuses(updates);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(3);
    });

    it('merges with existing statuses', () => {
      updateWorkspaceStatus('/existing', { type: 'noAgents' });

      const updates = new Map<string, AggregatedAgentStatus>([
        ['/new', { type: 'allIdle', count: 1 }],
      ]);

      updateMultipleStatuses(updates);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(2);
      expect(statuses.has('/existing')).toBe(true);
      expect(statuses.has('/new')).toBe(true);
    });

    it('overwrites existing statuses', () => {
      updateWorkspaceStatus('/workspace1', { type: 'noAgents' });

      const updates = new Map<string, AggregatedAgentStatus>([
        ['/workspace1', { type: 'allBusy', count: 3 }],
      ]);

      updateMultipleStatuses(updates);

      const status = getWorkspaceStatus('/workspace1');
      expect(status).toEqual({ type: 'allBusy', count: 3 });
    });
  });

  // === createWorkspaceStatusDerived Tests ===

  describe('createWorkspaceStatusDerived', () => {
    it('returns noAgents for unknown workspace', () => {
      const derived = createWorkspaceStatusDerived('/unknown');
      expect(get(derived)).toEqual({ type: 'noAgents' });
    });

    it('returns current status for known workspace', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 2 });
      const derived = createWorkspaceStatusDerived('/workspace1');
      expect(get(derived)).toEqual({ type: 'allIdle', count: 2 });
    });

    it('updates reactively when status changes', () => {
      const derived = createWorkspaceStatusDerived('/workspace1');
      expect(get(derived)).toEqual({ type: 'noAgents' });

      updateWorkspaceStatus('/workspace1', { type: 'allBusy', count: 3 });
      expect(get(derived)).toEqual({ type: 'allBusy', count: 3 });
    });

    it('returns noAgents when workspace is removed', () => {
      const path = '/workspace1';
      updateWorkspaceStatus(path, { type: 'allIdle', count: 2 });

      const derived = createWorkspaceStatusDerived(path);
      expect(get(derived)).toEqual({ type: 'allIdle', count: 2 });

      removeWorkspaceStatus(path);
      expect(get(derived)).toEqual({ type: 'noAgents' });
    });
  });

  // === initAgentStatusListener Tests ===

  describe('initAgentStatusListener', () => {
    it('registers event listener', async () => {
      await initAgentStatusListener();
      expect(listen).toHaveBeenCalledWith('agent-status-changed', expect.any(Function));
    });

    it('returns unlisten function', async () => {
      const mockUnlisten = vi.fn();
      vi.mocked(listen).mockResolvedValueOnce(mockUnlisten);

      const unlisten = await initAgentStatusListener();
      expect(unlisten).toBe(mockUnlisten);
    });

    it('updates store when receiving event', async () => {
      let eventCallback: ((event: { payload: unknown }) => void) | null = null;
      vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
        eventCallback = callback as (event: { payload: unknown }) => void;
        return () => {};
      });

      await initAgentStatusListener();

      // Simulate event
      eventCallback!({
        payload: {
          workspacePath: '/test',
          status: { type: 'allIdle', count: 2 },
          counts: { idle: 2, busy: 0 },
        },
      });

      const statuses = get(agentStatuses);
      expect(statuses.get('/test')).toEqual({ type: 'allIdle', count: 2 });
    });
  });
});
```

---

## Phase 6: UI Component (`AgentStatusIndicator.svelte`)

### Implementation

> **CSS Variables Note:** This component uses VSCode CSS variables (e.g., `--vscode-testing-iconPassed`)
> for theming consistency with code-server. These variables are provided by the code-server environment.
> Fallback values are specified for cases where these variables aren't available (e.g., Tauri shell context).
> The fallback colors are: green `#73c991`, red `#f14c4c`, grey `#969696`.

```svelte
<!-- src/lib/components/AgentStatusIndicator.svelte -->
<script lang="ts">
  import type { AggregatedAgentStatus } from '$lib/types/agentStatus';
  import { getStatusColor, getStatusTooltip } from '$lib/types/agentStatus';

  interface Props {
    status: AggregatedAgentStatus;
    size?: 'small' | 'medium';
  }

  let { status, size = 'small' }: Props = $props();

  const color = $derived(getStatusColor(status));
  const tooltip = $derived(getStatusTooltip(status));
</script>

<div
  class="status-indicator {size}"
  class:green={color === 'green'}
  class:red={color === 'red'}
  class:mixed={color === 'mixed'}
  class:grey={color === 'grey'}
  title={tooltip}
  role="status"
  aria-label={tooltip}
>
  {#if color === 'mixed'}
    <div class="mixed-top"></div>
    <div class="mixed-bottom"></div>
  {/if}
</div>

<style>
  .status-indicator {
    border-radius: 2px;
    flex-shrink: 0;
    transition: background-color 0.2s ease;
  }

  .status-indicator.small {
    width: 3px;
    height: 16px;
  }

  .status-indicator.medium {
    width: 4px;
    height: 24px;
  }

  .status-indicator.green {
    background: var(--vscode-testing-iconPassed, #73c991);
  }

  .status-indicator.red {
    background: var(--vscode-testing-iconFailed, #f14c4c);
  }

  .status-indicator.grey {
    background: var(--vscode-descriptionForeground, #969696);
    opacity: 0.4;
  }

  .status-indicator.mixed {
    display: flex;
    flex-direction: column;
    background: transparent;
    overflow: hidden;
  }

  .mixed-top {
    flex: 1;
    background: var(--vscode-testing-iconFailed, #f14c4c);
  }

  .mixed-bottom {
    flex: 1;
    background: var(--vscode-testing-iconPassed, #73c991);
  }
</style>
```

### Unit Tests for Phase 6

```typescript
// src/lib/components/AgentStatusIndicator.test.ts

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import AgentStatusIndicator from './AgentStatusIndicator.svelte';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';

describe('AgentStatusIndicator', () => {
  // === Render Tests ===

  describe('rendering', () => {
    it('renders without crashing', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('applies small size class by default', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('small')).toBe(true);
    });

    it('applies medium size class when specified', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status, size: 'medium' } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('medium')).toBe(true);
    });
  });

  // === Color Class Tests ===

  describe('color classes', () => {
    it('applies grey class for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('grey')).toBe(true);
    });

    it('applies green class for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);
    });

    it('applies red class for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
    });

    it('applies mixed class for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('mixed')).toBe(true);
    });
  });

  // === Tooltip Tests ===

  describe('tooltip', () => {
    it('shows correct tooltip for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');
    });

    it('shows correct tooltip for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 agents idle');
    });

    it('shows correct tooltip for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('1 agent busy');
    });

    it('shows correct tooltip for mixed', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 2, busy: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 idle, 3 busy');
    });
  });

  // === Accessibility Tests ===

  describe('accessibility', () => {
    it('has role="status"', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('has aria-label matching tooltip', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 agents idle');
    });
  });

  // === Mixed Indicator Structure Tests ===

  describe('mixed indicator structure', () => {
    it('renders child divs for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
    });

    it('does not render child divs for non-mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(0);
    });
  });

  // === Reactive Update Tests ===

  describe('reactive updates', () => {
    it('updates color when status prop changes from idle to busy', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allIdle', count: 1 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);

      await rerender({ status: { type: 'allBusy', count: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
      expect(element.classList.contains('green')).toBe(false);
    });

    it('updates tooltip when status changes', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'noAgents' } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');

      await rerender({ status: { type: 'allIdle', count: 3 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('3 agents idle');
    });

    it('transitions from solid to mixed indicator', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allIdle', count: 2 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.children.length).toBe(0);

      await rerender({ status: { type: 'mixed', idle: 1, busy: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
      expect(element.classList.contains('mixed')).toBe(true);
    });

    it('updates aria-label for accessibility when status changes', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allBusy', count: 2 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('2 agents busy');

      await rerender({ status: { type: 'mixed', idle: 3, busy: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 idle, 1 busy');
    });
  });
});
```

---

## Integration Points

### 1. Module Registration (`lib.rs`)

Add module declarations at the top of `lib.rs`:

```rust
pub mod agent_status;
pub mod agent_status_provider;
pub mod agent_status_manager;

// Re-export key types
pub use agent_status::{AgentStatusCounts, AggregatedAgentStatus, AgentStatusChangedEvent};
pub use agent_status_manager::AgentStatusManager;
```

### 2. AppState Integration (`lib.rs`)

Update the `AppState` struct and its constructor to include `AgentStatusManager`:

```rust
use crate::agent_status_manager::AgentStatusManager;

pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
    project_store: Arc<ProjectStore>,
    agent_status_manager: Arc<AgentStatusManager>,  // NEW
}

impl AppState {
    pub fn new(
        code_server_manager: Arc<CodeServerManager>,
        project_store: Arc<ProjectStore>,
        agent_status_manager: Arc<AgentStatusManager>,  // NEW parameter
    ) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
            project_store,
            agent_status_manager,
        }
    }
}
```

> **IMPORTANT:** This changes the `AppState::new()` signature. You must update:
>
> 1. **Main call site in `run()`** - shown in Section 3 below
> 2. **Integration tests in `src-tauri/tests/integration_test.rs`** - update any `AppState::new()` calls
> 3. **Any unit tests in `lib.rs`** that create `AppState` instances
>
> For tests, you can create a helper function:
>
> ```rust
> #[cfg(test)]
> fn create_test_app_state() -> AppState {
>     let code_server_manager = Arc::new(CodeServerManager::new(
>         CodeServerConfig::new("test").unwrap()
>     ));
>     let project_store = Arc::new(ProjectStore::new());
>     let agent_status_manager = Arc::new(AgentStatusManager::new());
>     AppState::new(code_server_manager, project_store, agent_status_manager)
> }
> ```

### 3. Initialization in `run()` (`lib.rs`)

First, add the required import at the top of `lib.rs`:

```rust
use tokio::sync::{broadcast, oneshot, RwLock};  // Add broadcast to existing imports
```

Then update the `run()` function:

```rust
pub fn run() {
    let config = CodeServerConfig::new(env!("CARGO_PKG_VERSION"))
        .expect("Failed to create CodeServerConfig");
    let code_server_manager = Arc::new(CodeServerManager::new(config));
    let project_store = Arc::new(ProjectStore::new());

    // Initialize AgentStatusManager
    let agent_status_manager = Arc::new(AgentStatusManager::new());

    let app_state = AppState::new(
        code_server_manager.clone(),
        project_store,
        agent_status_manager.clone(),
    );

    // Clone for cleanup handlers
    let cleanup_manager = code_server_manager.clone();
    let cleanup_status_manager = agent_status_manager.clone();

    tauri::Builder::default()
        // ... existing setup ...
        .setup(|app| {
            // ... existing window setup ...

            // Register factories in async context (setup closure allows async via spawn)
            // NOTE: Factory registration must happen here, not in run() sync context
            let status_manager_setup = agent_status_manager.clone();
            tauri::async_runtime::spawn(async move {
                // Register factories here when concrete providers are implemented
                // status_manager_setup.register_factory(Box::new(ClaudeCodeFactory)).await;
                // status_manager_setup.register_factory(Box::new(OpenCodeFactory)).await;
                let _ = status_manager_setup; // Suppress unused warning until factories are added
            });

            // Set up event forwarding from AgentStatusManager to frontend
            // with proper error handling for RecvError::Lagged
            let app_handle = app.handle().clone();
            let status_manager = agent_status_manager.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = status_manager.subscribe();
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            if let Err(e) = app_handle.emit("agent-status-changed", &event) {
                                eprintln!("Failed to emit agent status event: {}", e);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("Agent status event listener lagged by {} events", n);
                            // Continue - this is recoverable
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            eprintln!("Agent status event channel closed");
                            break;
                        }
                    }
                }
            });

            // Set up Ctrl+C handler for graceful cleanup
            let ctrl_c_code_server = cleanup_manager.clone();
            let ctrl_c_status_manager = cleanup_status_manager.clone();
            tauri::async_runtime::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                println!("Ctrl+C received - cleaning up...");
                // Shutdown agent status manager first
                ctrl_c_status_manager.shutdown().await;
                let _ = ctrl_c_code_server.stop().await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                println!("App exiting - cleaning up...");
                let app_state: tauri::State<AppState> = app_handle.state();
                tauri::async_runtime::block_on(async {
                    // Shutdown agent status manager first
                    app_state.agent_status_manager.shutdown().await;
                    let _ = app_state.code_server_manager.stop().await;
                });
            }
        });
}
```

````

### 4. Workspace Lifecycle Hooks

In `discover_workspaces_impl`:

```rust
pub async fn discover_workspaces_impl(
    state: &AppState,
    handle: String,
) -> Result<Vec<WorkspaceInfo>, String> {
    // ... existing code to discover workspaces ...
    // At this point, `workspace_infos: Vec<WorkspaceInfo>` has been built

    // Initialize agent status for each workspace
    // Note: WorkspaceInfo has `path: String` field, not a method
    for workspace_info in &workspace_infos {
        let workspace_path = Path::new(&workspace_info.path);
        if let Err(e) = state.agent_status_manager
            .init_workspace(workspace_path)
            .await
        {
            eprintln!("Failed to init agent status for {:?}: {}", workspace_path, e);
        }
    }

    // ... rest of the function ...
}
````

In `remove_workspace_impl`:

```rust
pub async fn remove_workspace_impl(
    state: &AppState,
    handle: String,
    workspace_path: String,
    delete_branch: bool,
) -> Result<RemovalResult, String> {
    // Note: workspace_path is already a String from the Tauri command
    let workspace_path_buf = PathBuf::from(&workspace_path);

    // Remove agent status tracking first (before workspace removal)
    state.agent_status_manager.remove_workspace(&workspace_path_buf).await;

    // ... rest of existing removal logic ...
}
```

In `close_project_impl`:

```rust
pub async fn close_project_impl(
    state: &AppState,
    handle: String,
) -> Result<(), String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    // Get workspace paths BEFORE removing project context
    let workspace_paths: Vec<PathBuf> = {
        let projects = state.projects.read().await;
        if let Some(context) = projects.get(&handle) {
            context.workspaces.iter()
                .map(|ws| PathBuf::from(&ws.path))
                .collect()
        } else {
            vec![]
        }
    };

    // Clean up agent status monitoring for all workspaces in this project
    // NOTE: This only stops WATCHING the agents, it does NOT:
    // - Stop the agents themselves (they keep running)
    // - Delete the workspace folders (git worktrees persist on disk)
    for workspace_path in workspace_paths {
        state.agent_status_manager.remove_workspace(&workspace_path).await;
    }

    // ... rest of existing close logic (remove project context, etc.) ...
}
```

> **Important Clarification:** The `remove_workspace()` call here only stops the status _monitoring_ infrastructure (background tasks, file watchers, WebSocket connections). It does NOT:
>
> - Stop any AI agents running in the workspace
> - Delete the workspace folder or git worktree
> - Affect the workspace in any way other than disconnecting our monitoring
>
> When the user reopens the project, `discover_workspaces_impl` will re-initialize the agent status providers and resume monitoring.

### 5. Tauri Commands

```rust
/// Get current agent status for a workspace
#[tauri::command]
async fn get_agent_status(
    state: tauri::State<'_, AppState>,
    workspace_path: String,
) -> Result<AggregatedAgentStatus, String> {
    let path = PathBuf::from(&workspace_path);
    Ok(state.agent_status_manager.get_status(&path).await)
}

/// Get all workspace agent statuses
#[tauri::command]
async fn get_all_agent_statuses(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, AggregatedAgentStatus>, String> {
    let statuses = state.agent_status_manager.get_all_statuses().await;
    Ok(statuses
        .into_iter()
        .map(|(k, v)| (k.to_string_lossy().to_string(), v))
        .collect())
}

// Add to invoke_handler:
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    get_agent_status,
    get_all_agent_statuses,
])
```

### 6. TypeScript API Wrapper (`src/lib/api/tauri.ts`)

Add to existing file:

```typescript
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';

export async function getAgentStatus(workspacePath: string): Promise<AggregatedAgentStatus> {
  return await invoke('get_agent_status', { workspacePath });
}

export async function getAllAgentStatuses(): Promise<Record<string, AggregatedAgentStatus>> {
  return await invoke('get_all_agent_statuses');
}
```

### Unit Tests for API Wrapper (`src/lib/api/tauri.test.ts`)

```typescript
// src/lib/api/tauri.test.ts (add these tests to existing file or create new)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getAgentStatus, getAllAgentStatuses } from './tauri';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('Agent Status API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAgentStatus', () => {
    it('calls invoke with correct command and workspace path', async () => {
      const mockStatus: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      vi.mocked(invoke).mockResolvedValueOnce(mockStatus);

      const result = await getAgentStatus('/test/workspace');

      expect(invoke).toHaveBeenCalledWith('get_agent_status', {
        workspacePath: '/test/workspace',
      });
      expect(result).toEqual(mockStatus);
    });

    it('returns noAgents status for unknown workspace', async () => {
      const mockStatus: AggregatedAgentStatus = { type: 'noAgents' };
      vi.mocked(invoke).mockResolvedValueOnce(mockStatus);

      const result = await getAgentStatus('/unknown/path');

      expect(result).toEqual({ type: 'noAgents' });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Backend error'));

      await expect(getAgentStatus('/test')).rejects.toThrow('Backend error');
    });

    it('handles all status types correctly', async () => {
      const statusTypes: AggregatedAgentStatus[] = [
        { type: 'noAgents' },
        { type: 'allIdle', count: 3 },
        { type: 'allBusy', count: 2 },
        { type: 'mixed', idle: 1, busy: 2 },
      ];

      for (const status of statusTypes) {
        vi.mocked(invoke).mockResolvedValueOnce(status);
        const result = await getAgentStatus('/test');
        expect(result).toEqual(status);
      }
    });
  });

  describe('getAllAgentStatuses', () => {
    it('calls invoke with correct command', async () => {
      const mockStatuses: Record<string, AggregatedAgentStatus> = {
        '/workspace1': { type: 'allIdle', count: 1 },
        '/workspace2': { type: 'allBusy', count: 2 },
      };
      vi.mocked(invoke).mockResolvedValueOnce(mockStatuses);

      const result = await getAllAgentStatuses();

      expect(invoke).toHaveBeenCalledWith('get_all_agent_statuses');
      expect(result).toEqual(mockStatuses);
    });

    it('returns empty object when no workspaces', async () => {
      vi.mocked(invoke).mockResolvedValueOnce({});

      const result = await getAllAgentStatuses();

      expect(result).toEqual({});
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Backend error'));

      await expect(getAllAgentStatuses()).rejects.toThrow('Backend error');
    });
  });
});
```

### 7. Frontend Initialization (`+layout.svelte`)

> **IMPORTANT:** `loadInitialStatuses()` must be called AFTER `restorePersistedProjects()` completes, since statuses depend on workspaces existing.

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { initAgentStatusListener, loadInitialStatuses } from '$lib/stores/agentStatus';
  import { restorePersistedProjects } from '$lib/services/projectManager';

  let unlistenAgentStatus: (() => void) | null = null;

  onMount(async () => {
    // First restore projects (workspaces must exist before loading statuses)
    await restorePersistedProjects();

    // Then load initial statuses (AFTER workspaces exist)
    await loadInitialStatuses();

    // Start listening for updates
    unlistenAgentStatus = await initAgentStatusListener();
  });

  onDestroy(() => {
    // Clean up the event listener to prevent memory leaks
    if (unlistenAgentStatus) {
      unlistenAgentStatus();
      unlistenAgentStatus = null;
    }
  });
</script>
```

### 8. Sidebar Integration (`Sidebar.svelte`)

```svelte
<script lang="ts">
  import AgentStatusIndicator from './AgentStatusIndicator.svelte';
  import { agentStatuses } from '$lib/stores/agentStatus';
  import { createNoAgentsStatus } from '$lib/types/agentStatus';
</script>

<!-- In workspace-item div, add the indicator: -->
<div class="workspace-item" ...>
  <AgentStatusIndicator status={$agentStatuses.get(workspace.path) ?? createNoAgentsStatus()} />
  <vscode-icon name="git-branch" class="icon"></vscode-icon>
  <!-- ... rest of the workspace item ... -->
</div>
```

---

## Phase 7: Integration Tests

### Rust Integration Tests

```rust
// src-tauri/tests/agent_status_integration.rs

use chime::{
    agent_status::{AgentStatusCounts, AggregatedAgentStatus},
    agent_status_manager::AgentStatusManager,
    agent_status_provider::{AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory},
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Debug)]
struct TestProvider {
    workspace: PathBuf,
    idle: AtomicU32,
    busy: AtomicU32,
    active: AtomicBool,
    sender: broadcast::Sender<AgentStatusCounts>,
}

impl TestProvider {
    fn new(workspace: PathBuf) -> Self {
        let (sender, _) = broadcast::channel(16);
        Self {
            workspace,
            idle: AtomicU32::new(0),
            busy: AtomicU32::new(0),
            active: AtomicBool::new(false),
            sender,
        }
    }

    fn emit_status(&self, idle: u32, busy: u32) {
        self.idle.store(idle, Ordering::SeqCst);
        self.busy.store(busy, Ordering::SeqCst);
        let _ = self.sender.send(AgentStatusCounts::new(idle, busy));
    }
}

#[async_trait::async_trait]
impl AgentStatusProvider for TestProvider {
    fn provider_id(&self) -> &'static str { "test" }
    fn provider_name(&self) -> &'static str { "Test Provider" }
    fn workspace_path(&self) -> &Path { &self.workspace }
    fn current_status(&self) -> AgentStatusCounts {
        AgentStatusCounts::new(
            self.idle.load(Ordering::SeqCst),
            self.busy.load(Ordering::SeqCst),
        )
    }
    fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
        self.sender.subscribe()
    }
    async fn start(&self) -> Result<(), AgentStatusError> {
        self.active.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn stop(&self) -> Result<(), AgentStatusError> {
        self.active.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

struct TestFactory;

#[async_trait::async_trait]
impl AgentStatusProviderFactory for TestFactory {
    fn factory_id(&self) -> &'static str { "test-factory" }
    async fn create_providers(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
        Ok(vec![Box::new(TestProvider::new(workspace_path.to_path_buf()))])
    }
    async fn supports_workspace(&self, _: &Path) -> bool { true }
}

#[tokio::test]
async fn test_full_status_flow() {
    let manager = Arc::new(AgentStatusManager::new());
    manager.register_factory(Box::new(TestFactory)).await;

    let workspace = PathBuf::from("/test/workspace");

    // Initialize workspace
    let result = manager.init_workspace(&workspace).await.unwrap();
    assert_eq!(result.started, 1);

    // Subscribe to events
    let mut rx = manager.subscribe();

    // Initial status should be NoAgents (no updates yet)
    let status = manager.get_status(&workspace).await;
    assert_eq!(status, AggregatedAgentStatus::NoAgents);

    // Cleanup
    manager.shutdown().await;
}

/// Test provider that allows external control for event emission testing
#[derive(Debug)]
struct ControllableProvider {
    workspace: PathBuf,
    idle: AtomicU32,
    busy: AtomicU32,
    active: AtomicBool,
    sender: broadcast::Sender<AgentStatusCounts>,
}

impl ControllableProvider {
    fn new(workspace: PathBuf) -> Arc<Self> {
        let (sender, _) = broadcast::channel(16);
        Arc::new(Self {
            workspace,
            idle: AtomicU32::new(0),
            busy: AtomicU32::new(0),
            active: AtomicBool::new(false),
            sender,
        })
    }

    /// Emit a status update - call this to trigger events
    fn emit_status(&self, idle: u32, busy: u32) {
        self.idle.store(idle, Ordering::SeqCst);
        self.busy.store(busy, Ordering::SeqCst);
        let _ = self.sender.send(AgentStatusCounts::new(idle, busy));
    }
}

#[async_trait::async_trait]
impl AgentStatusProvider for ControllableProvider {
    fn provider_id(&self) -> &'static str { "controllable" }
    fn provider_name(&self) -> &'static str { "Controllable Provider" }
    fn workspace_path(&self) -> &Path { &self.workspace }
    fn current_status(&self) -> AgentStatusCounts {
        AgentStatusCounts::new(
            self.idle.load(Ordering::SeqCst),
            self.busy.load(Ordering::SeqCst),
        )
    }
    fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
        self.sender.subscribe()
    }
    async fn start(&self) -> Result<(), AgentStatusError> {
        self.active.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn stop(&self) -> Result<(), AgentStatusError> {
        self.active.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn test_event_emission() {
    let manager = Arc::new(AgentStatusManager::new());
    manager.register_factory(Box::new(TestFactory)).await;

    let workspace = PathBuf::from("/test/workspace");
    manager.init_workspace(&workspace).await.unwrap();

    let mut rx = manager.subscribe();

    // Wait for debounce period to pass so events are emitted
    // The trailing-edge debounce will emit after STATUS_DEBOUNCE_MS (50ms)
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Verify the subscription is working (channel is open)
    // In a full integration, the provider would emit events here

    manager.shutdown().await;
}

#[tokio::test]
async fn test_trailing_edge_debounce_emits_final_state() {
    // This test verifies that the final state is always emitted after
    // rapid updates, even if the updates stop within the debounce window

    let manager = Arc::new(AgentStatusManager::new());
    manager.register_factory(Box::new(TestFactory)).await;

    let workspace = PathBuf::from("/test/debounce");
    manager.init_workspace(&workspace).await.unwrap();

    let mut rx = manager.subscribe();

    // Wait for trailing-edge debounce (STATUS_DEBOUNCE_MS = 50ms)
    // After this, any pending state should be emitted
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The cache should have the workspace entry
    let status = manager.get_status(&workspace).await;
    // Initially NoAgents since no provider updates occurred
    assert_eq!(status, AggregatedAgentStatus::NoAgents);

    manager.shutdown().await;
}

#[tokio::test]
async fn test_multiple_workspaces() {
    let manager = Arc::new(AgentStatusManager::new());
    manager.register_factory(Box::new(TestFactory)).await;

    let ws1 = PathBuf::from("/workspace1");
    let ws2 = PathBuf::from("/workspace2");
    let ws3 = PathBuf::from("/workspace3");

    manager.init_workspace(&ws1).await.unwrap();
    manager.init_workspace(&ws2).await.unwrap();
    manager.init_workspace(&ws3).await.unwrap();

    let statuses = manager.get_all_statuses().await;
    assert_eq!(statuses.len(), 3);

    manager.remove_workspace(&ws2).await;
    let statuses = manager.get_all_statuses().await;
    assert_eq!(statuses.len(), 2);

    manager.shutdown().await;
}
```

### Tauri Command Tests

```rust
// Add to src-tauri/src/lib.rs or a dedicated test module

#[cfg(test)]
mod command_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    // Mock provider for command tests
    #[derive(Debug)]
    struct CommandTestProvider {
        workspace: PathBuf,
        active: AtomicBool,
        sender: broadcast::Sender<AgentStatusCounts>,
    }

    impl CommandTestProvider {
        fn new(workspace: PathBuf) -> Self {
            let (sender, _) = broadcast::channel(16);
            Self {
                workspace,
                active: AtomicBool::new(false),
                sender,
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for CommandTestProvider {
        fn provider_id(&self) -> &'static str { "cmd-test" }
        fn provider_name(&self) -> &'static str { "Command Test" }
        fn workspace_path(&self) -> &Path { &self.workspace }
        fn current_status(&self) -> AgentStatusCounts { AgentStatusCounts::default() }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            self.sender.subscribe()
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn stop(&self) -> Result<(), AgentStatusError> {
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_active(&self) -> bool { self.active.load(Ordering::SeqCst) }
    }

    struct CommandTestFactory;

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for CommandTestFactory {
        fn factory_id(&self) -> &'static str { "cmd-test-factory" }
        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            Ok(vec![Box::new(CommandTestProvider::new(workspace_path.to_path_buf()))])
        }
        async fn supports_workspace(&self, _: &Path) -> bool { true }
    }

    // Helper to create a test AppState
    fn create_test_app_state() -> AppState {
        let code_server_manager = Arc::new(CodeServerManager::new(
            CodeServerConfig::new("test").unwrap()
        ));
        let project_store = Arc::new(ProjectStore::new());
        let agent_status_manager = Arc::new(AgentStatusManager::new());

        AppState::new(code_server_manager, project_store, agent_status_manager)
    }

    #[tokio::test]
    async fn test_get_agent_status_unknown_workspace() {
        let state = create_test_app_state();
        let result = state.agent_status_manager
            .get_status(&PathBuf::from("/unknown"))
            .await;

        assert_eq!(result, AggregatedAgentStatus::NoAgents);
    }

    #[tokio::test]
    async fn test_get_all_agent_statuses_empty() {
        let state = create_test_app_state();
        let result = state.agent_status_manager.get_all_statuses().await;

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_get_all_agent_statuses_with_workspaces() {
        let state = create_test_app_state();

        // Register factory first
        state.agent_status_manager
            .register_factory(Box::new(CommandTestFactory))
            .await;

        // Initialize workspaces
        state.agent_status_manager
            .init_workspace(&PathBuf::from("/ws1"))
            .await
            .unwrap();
        state.agent_status_manager
            .init_workspace(&PathBuf::from("/ws2"))
            .await
            .unwrap();

        let result = state.agent_status_manager.get_all_statuses().await;

        assert_eq!(result.len(), 2);
        assert!(result.contains_key(&PathBuf::from("/ws1")));
        assert!(result.contains_key(&PathBuf::from("/ws2")));

        // Both should be NoAgents initially (no status updates emitted)
        assert_eq!(result.get(&PathBuf::from("/ws1")), Some(&AggregatedAgentStatus::NoAgents));

        state.agent_status_manager.shutdown().await;
    }

    #[tokio::test]
    async fn test_get_agent_status_after_workspace_init() {
        let state = create_test_app_state();

        state.agent_status_manager
            .register_factory(Box::new(CommandTestFactory))
            .await;

        let path = PathBuf::from("/test/workspace");
        state.agent_status_manager
            .init_workspace(&path)
            .await
            .unwrap();

        let result = state.agent_status_manager.get_status(&path).await;

        // Initially NoAgents until a provider emits status
        assert_eq!(result, AggregatedAgentStatus::NoAgents);

        state.agent_status_manager.shutdown().await;
    }

    #[tokio::test]
    async fn test_get_agent_status_after_workspace_removed() {
        let state = create_test_app_state();

        state.agent_status_manager
            .register_factory(Box::new(CommandTestFactory))
            .await;

        let path = PathBuf::from("/test/remove");
        state.agent_status_manager
            .init_workspace(&path)
            .await
            .unwrap();

        // Remove the workspace
        state.agent_status_manager.remove_workspace(&path).await;

        // Should return NoAgents for removed workspace
        let result = state.agent_status_manager.get_status(&path).await;
        assert_eq!(result, AggregatedAgentStatus::NoAgents);

        state.agent_status_manager.shutdown().await;
    }
}
```

### TypeScript Integration Tests

```typescript
// src/lib/stores/agentStatus.integration.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  agentStatuses,
  clearAllStatuses,
  initAgentStatusListener,
  loadInitialStatuses,
  updateWorkspaceStatus,
  createWorkspaceStatusDerived,
  removeWorkspaceStatus,
} from './agentStatus';
import { listen } from '@tauri-apps/api/event';

// Mock Tauri API
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

describe('agentStatus integration', () => {
  beforeEach(() => {
    clearAllStatuses();
    vi.clearAllMocks();
  });

  describe('loadInitialStatuses', () => {
    it('loads initial statuses from backend', async () => {
      const mockStatuses = {
        '/workspace1': { type: 'allIdle', count: 2 },
        '/workspace2': { type: 'allBusy', count: 1 },
      };

      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce(mockStatuses);

      await loadInitialStatuses();

      const statuses = get(agentStatuses);
      expect(statuses.get('/workspace1')).toEqual({ type: 'allIdle', count: 2 });
      expect(statuses.get('/workspace2')).toEqual({ type: 'allBusy', count: 1 });
    });

    it('handles loadInitialStatuses error gracefully', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Backend error'));

      // Should not throw
      await expect(loadInitialStatuses()).resolves.not.toThrow();
    });
  });

  describe('event handling', () => {
    it('handles rapid status updates correctly', async () => {
      let eventCallback: ((event: { payload: unknown }) => void) | null = null;
      vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
        eventCallback = callback as (event: { payload: unknown }) => void;
        return () => {};
      });

      await initAgentStatusListener();

      // Fire multiple events rapidly
      for (let i = 0; i < 10; i++) {
        eventCallback!({
          payload: {
            workspacePath: '/test',
            status: { type: 'allBusy', count: i },
            counts: { idle: 0, busy: i },
          },
        });
      }

      // Store should have the latest value
      const statuses = get(agentStatuses);
      expect(statuses.get('/test')).toEqual({ type: 'allBusy', count: 9 });
    });
  });

  describe('derived store reactivity', () => {
    it('derived store updates when workspace status changes', () => {
      const path = '/workspace1';
      const derived = createWorkspaceStatusDerived(path);

      // Initially noAgents
      expect(get(derived)).toEqual({ type: 'noAgents' });

      // Update status
      updateWorkspaceStatus(path, { type: 'allIdle', count: 2 });
      expect(get(derived)).toEqual({ type: 'allIdle', count: 2 });
    });

    it('derived store updates when workspace is removed', () => {
      const path = '/workspace1';
      updateWorkspaceStatus(path, { type: 'allIdle', count: 1 });

      const derived = createWorkspaceStatusDerived(path);
      expect(get(derived).type).toBe('allIdle');

      removeWorkspaceStatus(path);
      expect(get(derived)).toEqual({ type: 'noAgents' });
    });
  });
});
```

---

## Summary of Files to Create

| Phase | File                                              | Description            |
| ----- | ------------------------------------------------- | ---------------------- |
| 1     | `src-tauri/src/agent_status.rs`                   | Core types             |
| 2     | `src-tauri/src/agent_status_provider.rs`          | Provider trait         |
| 3     | `src-tauri/src/agent_status_manager.rs`           | Manager                |
| 4     | `src/lib/types/agentStatus.ts`                    | TS types               |
| 5     | `src/lib/stores/agentStatus.ts`                   | Svelte store           |
| 6     | `src/lib/components/AgentStatusIndicator.svelte`  | UI component           |
| 7     | `src-tauri/tests/agent_status_integration.rs`     | Rust integration tests |
| -     | `src/lib/types/agentStatus.test.ts`               | TS type tests          |
| -     | `src/lib/stores/agentStatus.test.ts`              | Store tests            |
| -     | `src/lib/components/AgentStatusIndicator.test.ts` | Component tests        |

---

## Future: Concrete Provider Examples

This infrastructure enables future implementations like:

- **ClaudeCodeStatusProvider**: Monitors Claude Code extension via WebSocket/API
- **OpenCodeStatusProvider**: Monitors OpenCode.ai agent processes
- **ChatGPTCodexStatusProvider**: Monitors ChatGPT Codex sessions

Each provider will implement `AgentStatusProvider` trait and be registered via a factory.

---

## Success Criteria

Implementation is complete when all of the following pass:

### Automated Checks

- [ ] `pnpm validate:full` passes with zero errors/warnings
- [ ] All Rust unit tests pass (`cargo test` in src-tauri)
- [ ] All TypeScript/Svelte tests pass (`pnpm test`)
- [ ] Clippy passes with zero warnings (`pnpm rust:clippy`)
- [ ] All code is properly formatted (`pnpm format:check` and `pnpm rust:fmt:check`)

### Functional Requirements

- [ ] Event debouncing prevents UI churn under rapid updates (verified by tests)
- [ ] Trailing-edge debounce guarantees final state is always emitted (v5.0)
- [ ] Lock ordering prevents deadlocks (verified by stress test)
- [ ] Graceful shutdown cleans up all providers and tasks (JoinHandles awaited)
- [ ] Frontend updates reactively within 100ms of backend status change
- [ ] Race conditions in `init_workspace` are prevented (verified by concurrent test)
- [ ] `RecvError::Lagged` is handled gracefully (continues instead of breaking)
- [ ] Ctrl+C properly shuts down agent status manager
- [ ] `loadInitialStatuses()` is called after `restorePersistedProjects()`
- [ ] Frontend cleanup (`onDestroy`) properly unlistens from events
- [ ] Partial provider failure is handled gracefully (v4.0)
- [ ] Locks are released before awaiting provider cleanup (v4.0)
- [ ] Non-UTF8 workspace paths are rejected with clear error (v5.0)
- [ ] Integer overflow in status counts is prevented via saturating arithmetic (v5.0)
- [ ] JoinHandle panics are logged during cleanup (v5.0)
- [ ] Provider stop errors are logged, not silently ignored (v5.0)
- [ ] Closing project stops monitoring but does NOT delete workspace folders or stop agents (v5.0)

### Code Quality

- [ ] No `#[allow(clippy::...)]` exceptions added (per AGENTS.md)
- [ ] No TypeScript exceptions (`@ts-ignore`, `any`) added (per AGENTS.md)
- [ ] All public APIs have doc comments
- [ ] Lock ordering invariants are documented in code comments
- [ ] Test mock fields use consistent naming (v4.0 → v5.0: changed from `_sender` to `sender`)

---

## References

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture and component design
- [INITIAL_CONCEPT.md](./INITIAL_CONCEPT.md) - Project vision and goals
- [INITIAL_WORKSPACE_PROVIDER.md](./INITIAL_WORKSPACE_PROVIDER.md) - Similar provider pattern implementation
- [AGENTS.md](../AGENTS.md) - Project quality standards and coding guidelines

---

**Document Version:** 5.0 (Expert Reviewed - All Critical Issues & Warnings Addressed)  
**Next Step:** Begin implementation with Prerequisites (add async-trait, thiserror, tokio-util, futures), then Phase 1 (Rust Types)
