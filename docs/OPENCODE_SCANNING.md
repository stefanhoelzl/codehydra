# OpenCode Instance Scanning - Implementation Plan

This document describes the planned improvements to OpenCode instance discovery.

## Problem Statement

The current implementation has several issues:

1. **Repeated 404 logs**: Every scan cycle probes all node/code-server processes, causing repeated `[404] GET /path` logs from code-server
2. **Inefficient scanning**: Probes ports that have already been confirmed as non-OpenCode
3. **Name-based filtering**: Uses process name matching ("node", "opencode", "code-server", "code") which is imprecise
4. **Slow feedback**: 2-second scan interval is too slow for user experience

## Solution Overview

### Key Changes

1. **Process tree filtering**: Only probe ports from processes that are descendants of our code-server
2. **Non-OpenCode port caching**: Track ports that failed probing to avoid re-probing them
3. **Remove name filtering**: Replace with ancestry-based filtering
4. **Faster scanning**: Change interval from 2s to 1s

### Dependencies

- Add `sysinfo` crate for cross-platform process tree walking (provides `Process::parent()`)

## Implementation Details

### Files to Modify

| File                                  | Changes                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `src-tauri/Cargo.toml`                | Add `sysinfo` dependency                                     |
| `src-tauri/src/code_server.rs`        | Expose PID from `Child::id()`                                |
| `src-tauri/src/opencode/mod.rs`       | Update `PortScanner` trait, add `ProcessTree` and `PortInfo` |
| `src-tauri/src/opencode/discovery.rs` | Main logic changes                                           |
| `src-tauri/src/lib.rs`                | Wire up code-server PID to discovery service                 |

### New Types

#### `PortInfo` Struct

Use a struct instead of tuple for clarity:

```rust
#[derive(Debug, Clone)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
}
```

#### `ProcessTree` Trait (for testability)

The `sysinfo` crate is not directly mockable. Introduce a trait to enable dependency injection:

```rust
#[cfg_attr(test, mockall::automock)]
pub trait ProcessTree: Send + Sync {
    /// Check if `pid` is a descendant of `ancestor_pid`
    fn is_descendant_of(&self, pid: u32, ancestor_pid: u32) -> bool;

    /// Refresh the process tree (call before ancestry checks)
    fn refresh(&self);

    /// Get all descendant PIDs of an ancestor (pre-computed for efficiency)
    fn get_descendant_pids(&self, ancestor_pid: u32) -> HashSet<u32>;
}
```

#### `SysinfoProcessTree` Implementation

```rust
pub struct SysinfoProcessTree {
    system: RwLock<sysinfo::System>,
}

impl SysinfoProcessTree {
    pub fn new() -> Self {
        Self {
            system: RwLock::new(sysinfo::System::new()),
        }
    }
}

impl ProcessTree for SysinfoProcessTree {
    fn refresh(&self) {
        // IMPORTANT: Use spawn_blocking to avoid blocking async runtime
        // sysinfo refresh can take 50-200ms on systems with many processes
        let mut sys = self.system.write().unwrap();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    }

    fn get_descendant_pids(&self, ancestor_pid: u32) -> HashSet<u32> {
        let sys = self.system.read().unwrap();
        let ancestor = sysinfo::Pid::from_u32(ancestor_pid);
        let mut descendants = HashSet::new();

        // Pre-compute all descendants in one pass (O(n) instead of O(n*d))
        for (pid, process) in sys.processes() {
            let mut current = *pid;
            while let Some(proc) = sys.process(current) {
                if let Some(parent) = proc.parent() {
                    if parent == ancestor {
                        descendants.insert(u32::from(*pid));
                        break;
                    }
                    current = parent;
                } else {
                    break;
                }
            }
        }
        descendants
    }

    fn is_descendant_of(&self, pid: u32, ancestor_pid: u32) -> bool {
        let sys = self.system.read().unwrap();
        let mut current = sysinfo::Pid::from_u32(pid);
        let ancestor = sysinfo::Pid::from_u32(ancestor_pid);

        while let Some(process) = sys.process(current) {
            if let Some(parent) = process.parent() {
                if parent == ancestor {
                    return true;
                }
                current = parent;
            } else {
                break;
            }
        }
        false
    }
}
```

### Trait Changes

#### `PortScanner` Trait

**Before:**

```rust
pub trait PortScanner: Send + Sync {
    fn get_active_listeners(&self) -> Result<Vec<(u16, String)>, OpenCodeError>;
}
```

**After:**

```rust
pub trait PortScanner: Send + Sync {
    fn get_active_listeners(&self) -> Result<Vec<PortInfo>, OpenCodeError>;
}
```

### New Fields in `OpenCodeDiscoveryService`

```rust
pub struct OpenCodeDiscoveryService {
    active_instances: Arc<RwLock<HashMap<PathBuf, u16>>>,
    known_ports: Arc<RwLock<HashMap<u16, PathBuf>>>,
    // NEW: Ports probed and confirmed NOT to be OpenCode instances
    // Maps port -> pid to detect when a different process reuses the same port
    non_opencode_ports: Arc<RwLock<HashMap<u16, u32>>>,
    // NEW: Code-server PID for ancestry filtering
    code_server_pid: Arc<RwLock<Option<u32>>>,
    // NEW: Process tree for ancestry checking (mockable)
    process_tree: Box<dyn ProcessTree>,
    scanner: Box<dyn PortScanner>,
    probe: Box<dyn InstanceProbe>,
}
```

**Important**: `non_opencode_ports` is a `HashMap<u16, u32>` (port -> pid), not a `HashSet<u16>`. This allows detecting when a different process reuses the same port.

### Code-Server PID Lifecycle

The code-server PID must be communicated to the discovery service:

1. **When code-server starts**: Call `discovery.set_code_server_pid(Some(pid))`
2. **When code-server stops**: Call `discovery.set_code_server_pid(None)`
3. **When code-server restarts**: The setter clears `non_opencode_ports` cache

```rust
impl OpenCodeDiscoveryService {
    pub async fn set_code_server_pid(&self, pid: Option<u32>) {
        let mut pid_guard = self.code_server_pid.write().await;
        let old_pid = *pid_guard;
        *pid_guard = pid;

        // If PID changed, clear the non-opencode cache
        // (process ancestry has changed)
        if old_pid != pid {
            self.non_opencode_ports.write().await.clear();
        }
    }
}
```

**Exposing PID from CodeServerManager:**

```rust
// In code_server.rs
impl CodeServerManager {
    pub async fn pid(&self) -> Option<u32> {
        let instance = self.instance.read().await;
        instance.as_ref().and_then(|i| {
            match &i.state {
                InstanceState::Running { child } => child.id(),
                _ => None,
            }
        })
    }
}
```

### Updated `scan_and_update()` Algorithm

```
1. Get code-server PID (if not set, skip scanning)
2. Check if code-server process still exists; if not, clear PID and skip
3. Refresh process tree (use spawn_blocking to avoid blocking async runtime)
4. Pre-compute descendant PIDs of code-server (O(n) once, not O(n*d) per port)
5. Get all listeners: Vec<PortInfo>
6. Filter out PID 0 (kernel sockets)
7. Filter to only descendant PIDs (excludes code-server itself and unrelated processes)
8. Build candidate_set from filtered ports

9. Handle removed ports:
   - For ports in known_ports but not in candidate_set: remove from known_ports and active_instances
   - For ports in non_opencode_ports but not in candidate_set: remove from non_opencode_ports

10. Handle PID changes on existing ports:
    - For ports in non_opencode_ports where PID changed: remove from non_opencode_ports (will be re-probed)

11. Find new ports to probe:
    - Ports in candidate_set that are NOT in known_ports AND NOT in non_opencode_ports

12. Probe new ports:
    - On success: add to known_ports and active_instances
    - On failure: add to non_opencode_ports with current PID

13. Sleep 1 second (changed from 2 seconds)
```

### Async Considerations

**Critical**: `sysinfo::System::refresh_processes()` is a blocking call (50-200ms). Must use `spawn_blocking`:

```rust
pub async fn scan_and_update(&self) -> Result<(), OpenCodeError> {
    // Refresh process tree in blocking task
    let process_tree = self.process_tree.clone();
    tokio::task::spawn_blocking(move || {
        process_tree.refresh();
    }).await.map_err(|e| OpenCodeError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        e.to_string()
    )))?;

    // ... rest of the logic
}
```

### Configuration Changes

| Setting        | Before          | After               |
| -------------- | --------------- | ------------------- |
| Scan interval  | 2 seconds       | 1 second            |
| Port filtering | By process name | By process ancestry |

## Test Coverage

### Non-OpenCode Port Caching Tests

| #   | Test Name                                            | Scenario                                                                            |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `test_non_opencode_port_not_reprobed`                | Port fails probe -> not probed again on next scan                                   |
| 2   | `test_non_opencode_port_reprobed_after_disappearing` | Port fails -> disappears -> reappears -> gets probed again                          |
| 3   | `test_port_reused_by_opencode_after_other_process`   | Port used by non-OpenCode -> disappears -> OpenCode starts on same port -> detected |

### Process Ancestry Filtering Tests

| #   | Test Name                                 | Scenario                                           |
| --- | ----------------------------------------- | -------------------------------------------------- |
| 4   | `test_only_descendants_are_probed`        | Only ports from code-server descendants are probed |
| 5   | `test_non_descendant_ports_ignored`       | Ports from unrelated processes are never probed    |
| 6   | `test_code_server_port_itself_not_probed` | The code-server's own port is not probed           |

### Edge Case Tests

| #   | Test Name                                   | Scenario                                                          |
| --- | ------------------------------------------- | ----------------------------------------------------------------- |
| 7   | `test_no_code_server_pid_skips_all`         | If code-server PID not set, no ports are probed                   |
| 8   | `test_code_server_pid_set_later`            | Code-server starts after discovery loop -> starts detecting       |
| 9   | `test_multiple_opencode_instances`          | Multiple OpenCode instances on different ports -> all detected    |
| 10  | `test_opencode_instance_stops_and_restarts` | OpenCode stops -> removed -> restarts on same port -> re-detected |

### Additional Tests (from review)

| #   | Test Name                               | Scenario                                                         |
| --- | --------------------------------------- | ---------------------------------------------------------------- |
| 11  | `test_port_reused_by_different_pid`     | Same port, different PID -> should re-probe                      |
| 12  | `test_code_server_restart_clears_cache` | Code-server restarts -> non_opencode_ports cleared               |
| 13  | `test_probe_timeout_handling`           | Probe times out -> treated as non-OpenCode                       |
| 14  | `test_probe_network_error_handling`     | Probe returns network error -> treated as non-OpenCode           |
| 15  | `test_scanner_error_propagation`        | Scanner returns error -> loop continues, doesn't crash           |
| 16  | `test_stale_code_server_pid`            | Code-server dies -> PID becomes stale -> handled gracefully      |
| 17  | `test_pid_zero_filtered`                | Kernel sockets (PID 0) are never probed                          |
| 18  | `test_ancestry_check_race_condition`    | Process dies between get_listeners and ancestry check -> handled |

### Critical Test Case: Port Reuse Scenario (Test #3)

This test validates the most important user scenario:

```
Scan 1: Port 3000 exists (non-OpenCode process, e.g., webpack dev server)
        -> Probe fails -> added to non_opencode_ports

Scan 2: Port 3000 still exists (same process)
        -> Skipped (in non_opencode_ports) - NO 404 logged!

Scan 3: Port 3000 gone (webpack stopped)
        -> Removed from non_opencode_ports

Scan 4: Port 3000 exists (OpenCode started on same port)
        -> Not in non_opencode_ports -> Probed -> Success!
        -> Added to known_ports/active_instances
```

### Critical Test Case: Port Reuse with Different PID (Test #11)

This test validates PID tracking in `non_opencode_ports`:

```
Scan 1: Port 3000 from PID 500 (non-OpenCode)
        -> Probe fails -> non_opencode_ports[3000] = 500

Scan 2: Port 3000 from PID 600 (different process reused port!)
        -> PID changed -> remove from non_opencode_ports
        -> Probe again -> Success (it's OpenCode this time)
```

### Integration Test

One real integration test to verify `sysinfo` works correctly:

```rust
#[tokio::test]
#[ignore] // Run with: cargo test -- --ignored
async fn test_real_process_tree_ancestry() {
    let our_pid = std::process::id();

    // Spawn a child process
    let child = std::process::Command::new("sleep")
        .arg("10")
        .spawn()
        .expect("Failed to spawn child");
    let child_pid = child.id();

    let tree = SysinfoProcessTree::new();
    tree.refresh();

    // Child should be descendant of us
    assert!(tree.is_descendant_of(child_pid, our_pid));

    // We should NOT be descendant of child
    assert!(!tree.is_descendant_of(our_pid, child_pid));
}
```

## Benefits

1. **No more 404 spam**: Code-server port is never probed (not a descendant of itself)
2. **Efficient scanning**: Ports that failed once aren't re-probed until they restart
3. **Precise filtering**: Only probe actual potential OpenCode instances
4. **Faster feedback**: 1-second interval for quicker detection
5. **Cross-platform**: Using `sysinfo` for Windows/macOS/Linux support
6. **Testable**: All external dependencies are behind mockable traits

## Migration Notes

- The `PortScanner` trait signature changes (breaking change for tests)
- Mock implementations need to be updated to return `PortInfo` instead of `(port, name)`
- Tests need to mock the `ProcessTree` trait for ancestry checking
- New `MockProcessTree` will be auto-generated by `mockall`

## Review Action Items

### Must Address (Blocking)

| #   | Item                                               | Status          |
| --- | -------------------------------------------------- | --------------- |
| 1   | Create `ProcessTree` trait                         | Planned         |
| 2   | Change `non_opencode_ports` to `HashMap<u16, u32>` | Planned         |
| 3   | Use `spawn_blocking` for sysinfo refresh           | Planned         |
| 4   | Create `PortInfo` struct                           | Planned         |
| 5   | Pre-compute descendant set once per scan           | Planned         |
| 6   | Document PID lifecycle                             | Done (this doc) |

### Should Address (High Priority)

| #   | Item                                                              | Status  |
| --- | ----------------------------------------------------------------- | ------- |
| 7   | Add test cases 11-18 (race conditions, error handling, PID reuse) | Planned |
| 8   | Add integration test for real process tree                        | Planned |
| 9   | Clear `non_opencode_ports` on code-server restart                 | Planned |
| 10  | Filter PID 0 (kernel sockets)                                     | Planned |
| 11  | Handle stale code-server PID gracefully                           | Planned |
