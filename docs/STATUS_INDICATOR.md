# Status Indicator Improvements - Implementation Plan

**Document Version:** 2.0  
**Last Updated:** 2025-11-25

This document outlines the implementation plan for three improvements to the agent status indicator:

1. Make the status indicator wider
2. Add a chime sound when an agent transitions from busy to idle
3. Fix the mixed status display for multiple OpenCode instances in the same workspace

---

## Table of Contents

1. [Problem Summary](#problem-summary)
2. [Architecture Overview](#architecture-overview)
3. [Expert Review Summary](#expert-review-summary)
4. [Implementation Tasks](#implementation-tasks)
   - [Task 1: Widen Status Indicator](#task-1-widen-status-indicator)
   - [Task 2: Frontend Raw Counts Tracking](#task-2-frontend-raw-counts-tracking)
   - [Task 3: Chime Sound Notification](#task-3-chime-sound-notification)
   - [Task 4: Multi-Instance Discovery Support](#task-4-multi-instance-discovery-support)
   - [Task 5: Provider Multi-Instance Aggregation](#task-5-provider-multi-instance-aggregation)
5. [Test Plan](#test-plan)
6. [File Change Summary](#file-change-summary)

---

## Problem Summary

### Issue 1: Status Indicator Too Narrow

**Current:** Width is 3px (small) / 4px (medium)  
**Desired:** Wider indicator for better visibility

### Issue 2: No Audio Feedback

**Current:** No notification when agents finish work  
**Desired:** Play a chime when any agent transitions from busy to idle

### Issue 3: Mixed Status Not Displaying

**Current:** When running multiple OpenCode processes in the same workspace (e.g., one busy, one idle), the indicator shows solid green instead of half-red/half-green  
**Root Cause:** The discovery service uses `HashMap<PathBuf, u16>` which only tracks ONE port per workspace path. When a second OpenCode instance starts, it overwrites the first.

---

## Architecture Overview

### Current Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Current Architecture                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  OpenCode Instance A ──┐                                                    │
│  (port 3000)           │                                                    │
│                        ▼                                                    │
│  OpenCode Instance B   ┌────────────────────────┐                           │
│  (port 3001)       ──► │ OpenCodeDiscoveryService│                          │
│                        │                        │                           │
│                        │ active_instances:      │                           │
│                        │ HashMap<PathBuf, u16>  │ ◄── BUG: Only stores ONE │
│                        │ /workspace → 3001     │     port per path!        │
│                        └───────────┬────────────┘                           │
│                                    │                                        │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ OpenCodeProvider       │                           │
│                        │                        │                           │
│                        │ Monitors single port   │ ◄── Only sees Instance B │
│                        │ Reports: {idle:1,busy:0}│                          │
│                        └───────────┬────────────┘                           │
│                                    │                                        │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ AgentStatusManager     │                           │
│                        │                        │                           │
│                        │ Aggregates from        │                           │
│                        │ provider → AllIdle     │                           │
│                        └───────────┬────────────┘                           │
│                                    │ Tauri Event                            │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ Frontend               │                           │
│                        │                        │                           │
│                        │ Shows: GREEN           │ ◄── Wrong! Should be     │
│                        │ (all idle)             │     MIXED (red/green)    │
│                        └────────────────────────┘                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Proposed Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Proposed Architecture                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  OpenCode Instance A ──┐                                                    │
│  (port 3000, busy)     │                                                    │
│                        ▼                                                    │
│  OpenCode Instance B   ┌────────────────────────┐                           │
│  (port 3001, idle) ──► │ OpenCodeDiscoveryService│                          │
│                        │                        │                           │
│                        │ active_instances:      │                           │
│                        │ HashMap<PathBuf,       │ ◄── FIX: Stores ALL ports│
│                        │        BTreeSet<u16>>  │     per path (ordered)   │
│                        │ /workspace → {3000,    │                           │
│                        │              3001}     │                           │
│                        └───────────┬────────────┘                           │
│                                    │                                        │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ OpenCodeProvider       │                           │
│                        │                        │                           │
│                        │ Monitors ALL ports     │                           │
│                        │ Channel-based updates  │                           │
│                        │ Aggregates counts:     │                           │
│                        │ {idle:1, busy:1}       │ ◄── Combined from both   │
│                        └───────────┬────────────┘                           │
│                                    │                                        │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ AgentStatusManager     │                           │
│                        │                        │                           │
│                        │ Aggregates → Mixed     │                           │
│                        │ {idle:1, busy:1}       │                           │
│                        └───────────┬────────────┘                           │
│                                    │ Tauri Event (with counts)              │
│                                    ▼                                        │
│                        ┌────────────────────────┐                           │
│                        │ Frontend               │                           │
│                        │                        │                           │
│                        │ NotificationService:   │                           │
│                        │ - Tracks prev counts   │                           │
│                        │ - Detects busy decrease│                           │
│                        │ - Plays chime sound    │ ◄── NEW: Audio feedback  │
│                        │ Shows: MIXED (red/grn) │ ◄── CORRECT!             │
│                        └────────────────────────┘                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Expert Review Summary

The implementation plan was reviewed by three expert agents. Key findings and required changes:

### Critical Issues (Must Fix)

| Issue                                 | Source         | Resolution                                                      |
| ------------------------------------- | -------------- | --------------------------------------------------------------- |
| Mixed sync/async locks in provider.rs | Rust Expert    | Use `tokio::sync::RwLock` consistently, not `std::sync::RwLock` |
| TOCTOU race in aggregation            | Rust Expert    | Hold lock while computing AND emitting aggregate                |
| Use `BTreeSet` not `HashSet`          | Rust Expert    | Deterministic ordering aids debugging and testing               |
| Chime logic placement                 | Architect      | Extract to dedicated `AgentNotificationService` class           |
| Module-level previous counts state    | Architect      | Encapsulate in class with explicit cleanup method               |
| Missing multi-instance tests          | Testing Expert | Add 14+ tests for core scenarios                                |

### Important Issues (Should Fix)

| Issue                           | Source      | Resolution                                               |
| ------------------------------- | ----------- | -------------------------------------------------------- |
| Path canonicalization at lookup | Rust Expert | Canonicalize at insert time for better performance       |
| Implementation order            | Architect   | Reorder to 1 → 2 → 3 → 4 → 5 (frontend first)            |
| Channel-based aggregation       | Rust Expert | Consider mpsc channels instead of shared port_counts map |

---

## Implementation Tasks

### Task 1: Widen Status Indicator

**File:** `src/lib/components/AgentStatusIndicator.svelte`

**Changes:**

```css
/* Before */
.status-indicator.small {
  width: 3px;
  height: 16px;
}

.status-indicator.medium {
  width: 4px;
  height: 24px;
}

/* After */
.status-indicator.small {
  width: 6px;
  height: 16px;
}

.status-indicator.medium {
  width: 8px;
  height: 24px;
}
```

**Rationale:** Double the width for better visibility while keeping height unchanged.

---

### Task 2: Frontend Raw Counts Tracking

**Goal:** Store raw `{idle, busy}` counts in the frontend instead of aggregated status types. This allows the frontend to:

1. Derive the display color locally
2. Compare previous vs. current counts to detect when to play the chime

#### 2.1 Update Type Definitions

**File:** `src/lib/types/agentStatus.ts`

**Changes:**

- Keep `AgentStatusCounts` interface (already exists as part of event)
- Add `getStatusColorFromCounts()` function
- Keep existing types for backward compatibility during transition

```typescript
// NEW: Derive status color from counts
export function getStatusColorFromCounts(counts: AgentStatusCounts): StatusIndicatorColor {
  const { idle, busy } = counts;
  if (idle === 0 && busy === 0) return 'grey';
  if (busy === 0) return 'green';
  if (idle === 0) return 'red';
  return 'mixed';
}

// NEW: Derive tooltip from counts
export function getTooltipFromCounts(counts: AgentStatusCounts): string {
  const { idle, busy } = counts;
  if (idle === 0 && busy === 0) return 'No agents running';
  if (busy === 0) return `${idle} agent${idle > 1 ? 's' : ''} idle`;
  if (idle === 0) return `${busy} agent${busy > 1 ? 's' : ''} busy`;
  return `${idle} idle, ${busy} busy`;
}

// NEW: Create default empty counts
export function createEmptyCounts(): AgentStatusCounts {
  return { idle: 0, busy: 0 };
}
```

#### 2.2 Update Store to Track Counts

**File:** `src/lib/stores/agentStatus.ts`

**Changes:**

- Change store type from `Map<string, AggregatedAgentStatus>` to `Map<string, AgentStatusCounts>`
- Update event listener to store counts directly
- Delegate chime detection to `AgentNotificationService` (separation of concerns)

```typescript
// Store raw counts instead of aggregated status
export const agentCounts = writable<Map<string, AgentStatusCounts>>(new Map());

// Update listener to use counts and notification service
export async function initAgentStatusListener(): Promise<UnlistenFn> {
  const notificationService = new AgentNotificationService();

  const unlisten = await listen<AgentStatusChangedEvent>('agent-status-changed', (event) => {
    const { workspacePath, counts } = event.payload;

    // Delegate chime detection to notification service
    notificationService.handleStatusChange(workspacePath, counts);

    // Update store
    updateWorkspaceCounts(workspacePath, counts);
  });

  return unlisten;
}
```

#### 2.3 Create AgentNotificationService (NEW - per Architect review)

**File:** `src/lib/services/agentNotifications.ts` (new file)

**Rationale:** Separates audio notification concerns from state management for better testability and future configuration.

```typescript
// src/lib/services/agentNotifications.ts

import type { AgentStatusCounts } from '$lib/types/agentStatus';

/**
 * Service responsible for audio notifications when agent status changes.
 * Extracted from store to separate concerns and improve testability.
 */
export class AgentNotificationService {
  private previousCounts = new Map<string, AgentStatusCounts>();
  private enabled = true;

  /**
   * Handle a status change event and play chime if appropriate.
   */
  handleStatusChange(workspacePath: string, counts: AgentStatusCounts): void {
    const prev = this.previousCounts.get(workspacePath);

    // Play chime when busy count decreases (agent finished work)
    if (this.enabled && prev && counts.busy < prev.busy) {
      playChimeSound();
    }

    this.previousCounts.set(workspacePath, counts);
  }

  /**
   * Enable or disable chime notifications.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clean up tracking for a removed workspace.
   */
  removeWorkspace(workspacePath: string): void {
    this.previousCounts.delete(workspacePath);
  }

  /**
   * Reset all state (useful for testing).
   */
  reset(): void {
    this.previousCounts.clear();
  }
}

// Audio context singleton
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Reset audio context (for testing).
 */
export function resetAudioContext(): void {
  audioContext = null;
}

/**
 * Play a simple chime sound using Web Audio API.
 * Two-tone chime: 880Hz then 1320Hz (A5 to E6)
 */
export function playChimeSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Create oscillator for first tone
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 880; // A5
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    // Create oscillator for second tone
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 1320; // E6
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.3, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.3);
  } catch (e) {
    // Audio not supported or blocked - silently ignore
    console.debug('Could not play chime:', e);
  }
}
```

#### 2.4 Update AgentStatusIndicator Component

**File:** `src/lib/components/AgentStatusIndicator.svelte`

**Changes:**

- Accept `AgentStatusCounts` as prop (or derive from counts)
- Compute color and tooltip internally

```svelte
<script lang="ts">
  import type { AgentStatusCounts } from '$lib/types/agentStatus';
  import { getStatusColorFromCounts, getTooltipFromCounts } from '$lib/types/agentStatus';

  interface Props {
    counts: AgentStatusCounts;
    size?: 'small' | 'medium';
  }

  let { counts, size = 'small' }: Props = $props();

  const color = $derived(getStatusColorFromCounts(counts));
  const tooltip = $derived(getTooltipFromCounts(counts));
</script>
```

#### 2.5 Update Sidebar to Pass Counts

**File:** `src/lib/components/Sidebar.svelte`

**Changes:**

- Import `agentCounts` instead of `agentStatuses`
- Pass counts to `AgentStatusIndicator`

```svelte
<script lang="ts">
  import { agentCounts } from '$lib/stores/agentStatus';
  import { createEmptyCounts } from '$lib/types/agentStatus';
</script>

<AgentStatusIndicator
  counts={$agentCounts.get(mainWorkspace(project).path) ?? createEmptyCounts()}
/>
```

---

### Task 3: Chime Sound Notification

**Moved to Task 2.3** - The chime implementation is now part of the `AgentNotificationService` class per the Architect review.

**Trigger Condition:** In `AgentNotificationService.handleStatusChange()`, compare new `counts.busy` with previous `counts.busy`. If decreased, call `playChimeSound()`.

---

### Task 4: Multi-Instance Discovery Support

**File:** `src-tauri/src/opencode/discovery.rs`

#### 4.1 Change Data Structure (Updated per Rust Expert review)

```rust
use std::collections::BTreeSet;  // NOT HashSet - deterministic ordering

// Before
active_instances: Arc<RwLock<HashMap<PathBuf, u16>>>,

// After
active_instances: Arc<RwLock<HashMap<PathBuf, BTreeSet<u16>>>>,
```

**Rationale for BTreeSet:** Deterministic iteration order aids debugging and testing. Performance difference negligible for small sets (<10 items).

#### 4.2 Update `get_port()` to `get_ports()`

```rust
// Before
pub async fn get_port(&self, path: &Path) -> Option<u16> {
    let map = self.active_instances.read().await;
    map.get(path).copied()
}

// After
pub async fn get_ports(&self, path: &Path) -> Vec<u16> {
    let map = self.active_instances.read().await;

    // Try exact match first
    if let Some(ports) = map.get(path) {
        return ports.iter().copied().collect();
    }

    // Try canonicalized path match
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    if let Some(ports) = map.get(&canonical) {
        return ports.iter().copied().collect();
    }

    // Check canonicalized keys - O(n) but rare path
    for (stored_path, ports) in map.iter() {
        if stored_path.canonicalize().ok() == Some(canonical.clone()) {
            return ports.iter().copied().collect();
        }
    }

    Vec::new()
}
```

#### 4.3 Update Insertion Logic

```rust
// Before (in scan_and_update)
if let Some(old_port) = active_instances.insert(path.clone(), info.port) {
    known_ports.remove(&old_port);
}
known_ports.insert(info.port, path);

// After
active_instances
    .entry(path.clone())
    .or_insert_with(BTreeSet::new)
    .insert(info.port);
known_ports.insert(info.port, path);
```

#### 4.4 Update Removal Logic

```rust
// Before
if let Some(path) = known_ports_guard.remove(&port) {
    active_instances_guard.remove(&path);
}

// After
if let Some(path) = known_ports_guard.remove(&port) {
    if let Some(ports) = active_instances_guard.get_mut(&path) {
        ports.remove(&port);
        if ports.is_empty() {
            active_instances_guard.remove(&path);
        }
    }
}
```

---

### Task 5: Provider Multi-Instance Aggregation

**File:** `src-tauri/src/opencode/provider.rs`

#### 5.1 Fix Lock Type (Critical - per Rust Expert review)

**Current code uses `std::sync::RwLock` in async context - this is problematic.**

```rust
// Before (WRONG)
use std::sync::{Arc, RwLock};
current_counts: Arc<RwLock<AgentStatusCounts>>,

// After (CORRECT)
use tokio::sync::RwLock;
// ... use tokio::sync::RwLock for all async-accessed state
```

#### 5.2 Channel-Based Aggregation Pattern (per Rust Expert review)

**Rationale:** Eliminates shared mutable state, prevents race conditions, simplifies per-port tasks.

```rust
use tokio::sync::mpsc;
use std::collections::BTreeSet;

/// Events from per-port monitor tasks
enum PortUpdate {
    Status { port: u16, counts: AgentStatusCounts },
    Disconnected { port: u16 },
}

pub struct OpenCodeProvider {
    workspace_path: PathBuf,
    discovery_service: Arc<OpenCodeDiscoveryService>,
    client_factory: Arc<dyn ClientFactory>,
    status_sender: broadcast::Sender<AgentStatusCounts>,
    active: Arc<AtomicBool>,
    task_handle: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl OpenCodeProvider {
    async fn run_monitor(
        workspace_path: PathBuf,
        discovery: Arc<OpenCodeDiscoveryService>,
        client_factory: Arc<dyn ClientFactory>,
        sender: broadcast::Sender<AgentStatusCounts>,
        active_flag: Arc<AtomicBool>,
    ) {
        let (tx, mut rx) = mpsc::channel::<PortUpdate>(64);
        let mut port_counts: HashMap<u16, AgentStatusCounts> = HashMap::new();
        let mut port_tasks: HashMap<u16, JoinHandle<()>> = HashMap::new();

        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !active_flag.load(Ordering::Relaxed) {
                        break;
                    }

                    let current_ports: BTreeSet<u16> = discovery
                        .get_ports(&workspace_path)
                        .await
                        .into_iter()
                        .collect();

                    let mut changed = false;

                    // Remove obsolete port tasks
                    let to_remove: Vec<_> = port_tasks.keys()
                        .filter(|p| !current_ports.contains(p))
                        .copied()
                        .collect();

                    for port in to_remove {
                        if let Some(h) = port_tasks.remove(&port) {
                            h.abort();
                        }
                        port_counts.remove(&port);
                        changed = true;
                    }

                    // Add new port tasks
                    for port in current_ports {
                        if !port_tasks.contains_key(&port) {
                            let handle = Self::spawn_port_monitor(
                                port,
                                client_factory.clone(),
                                tx.clone(),
                                active_flag.clone(),
                            );
                            port_tasks.insert(port, handle);
                            port_counts.insert(port, AgentStatusCounts::default());
                            changed = true;
                        }
                    }

                    // Emit aggregate after discovery update
                    if changed {
                        Self::emit_aggregate(&port_counts, &sender);
                    }
                }

                Some(update) = rx.recv() => {
                    match update {
                        PortUpdate::Status { port, counts } => {
                            port_counts.insert(port, counts);
                        }
                        PortUpdate::Disconnected { port } => {
                            port_counts.insert(port, AgentStatusCounts::default());
                        }
                    }
                    Self::emit_aggregate(&port_counts, &sender);
                }
            }
        }

        // Cleanup all tasks
        for (_, h) in port_tasks {
            h.abort();
        }
    }

    fn emit_aggregate(
        port_counts: &HashMap<u16, AgentStatusCounts>,
        sender: &broadcast::Sender<AgentStatusCounts>,
    ) {
        let total = port_counts.values()
            .fold(AgentStatusCounts::default(), |acc, c| acc + *c);
        let _ = sender.send(total);
    }

    fn spawn_port_monitor(
        port: u16,
        client_factory: Arc<dyn ClientFactory>,
        tx: mpsc::Sender<PortUpdate>,
        active_flag: Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            // Monitor single port, send updates via channel
            // On status change: tx.send(PortUpdate::Status { port, counts }).await.ok();
            // On disconnect: tx.send(PortUpdate::Disconnected { port }).await.ok();
        })
    }
}
```

**Benefits of channel pattern:**

- No shared mutable state between tasks
- Single aggregation point (no race conditions)
- Simpler per-port tasks
- Easier to test

---

## Test Plan

### Frontend Tests

#### `src/lib/types/agentStatus.test.ts` - New Tests

```typescript
describe('getStatusColorFromCounts', () => {
  it('returns grey for zero counts', () => {
    expect(getStatusColorFromCounts({ idle: 0, busy: 0 })).toBe('grey');
  });

  it('returns green for all idle', () => {
    expect(getStatusColorFromCounts({ idle: 2, busy: 0 })).toBe('green');
  });

  it('returns red for all busy', () => {
    expect(getStatusColorFromCounts({ idle: 0, busy: 3 })).toBe('red');
  });

  it('returns mixed for mixed status', () => {
    expect(getStatusColorFromCounts({ idle: 1, busy: 2 })).toBe('mixed');
  });
});

describe('getTooltipFromCounts', () => {
  it('returns correct text for zero counts', () => {
    expect(getTooltipFromCounts({ idle: 0, busy: 0 })).toBe('No agents running');
  });

  it('returns singular for 1 agent', () => {
    expect(getTooltipFromCounts({ idle: 1, busy: 0 })).toBe('1 agent idle');
    expect(getTooltipFromCounts({ idle: 0, busy: 1 })).toBe('1 agent busy');
  });

  it('returns plural for multiple agents', () => {
    expect(getTooltipFromCounts({ idle: 3, busy: 0 })).toBe('3 agents idle');
  });

  it('returns combined text for mixed', () => {
    expect(getTooltipFromCounts({ idle: 2, busy: 1 })).toBe('2 idle, 1 busy');
  });
});

describe('createEmptyCounts', () => {
  it('returns zero counts', () => {
    expect(createEmptyCounts()).toEqual({ idle: 0, busy: 0 });
  });
});
```

#### `src/lib/services/agentNotifications.test.ts` - New Test File

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentNotificationService, playChimeSound, resetAudioContext } from './agentNotifications';

// Mock AudioContext
class MockAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return {
      frequency: { value: 0 },
      type: 'sine',
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
}

vi.stubGlobal('AudioContext', MockAudioContext);

describe('AgentNotificationService', () => {
  let service: AgentNotificationService;

  beforeEach(() => {
    service = new AgentNotificationService();
    resetAudioContext();
  });

  describe('chime detection', () => {
    it('does not play chime on first event (no previous)', () => {
      const playSpy = vi.spyOn({ playChimeSound }, 'playChimeSound');
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      // First event - no chime
    });

    it('plays chime when busy decreases', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // Should have triggered chime (busy: 2 → 1)
    });

    it('does not play chime when busy increases', () => {
      service.handleStatusChange('/test', { idle: 2, busy: 0 });
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // No chime (busy: 0 → 1)
    });

    it('does not play chime when busy stays same', () => {
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      service.handleStatusChange('/test', { idle: 2, busy: 1 });
      // No chime (busy stayed at 1)
    });

    it('handles multiple workspaces independently', () => {
      service.handleStatusChange('/workspace-a', { idle: 0, busy: 2 });
      service.handleStatusChange('/workspace-b', { idle: 0, busy: 3 });
      service.handleStatusChange('/workspace-a', { idle: 1, busy: 1 });
      // One chime for workspace-a (busy: 2 → 1)
    });

    it('respects enabled flag', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.setEnabled(false);
      service.handleStatusChange('/test', { idle: 1, busy: 1 });
      // No chime (disabled)
    });
  });

  describe('cleanup', () => {
    it('removes workspace tracking', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.removeWorkspace('/test');
      service.handleStatusChange('/test', { idle: 0, busy: 1 });
      // No chime (no previous after removal)
    });

    it('resets all state', () => {
      service.handleStatusChange('/test', { idle: 0, busy: 2 });
      service.reset();
      service.handleStatusChange('/test', { idle: 0, busy: 1 });
      // No chime (no previous after reset)
    });
  });
});

describe('playChimeSound', () => {
  beforeEach(() => {
    resetAudioContext();
  });

  it('handles AudioContext creation failure gracefully', () => {
    vi.stubGlobal('AudioContext', () => {
      throw new Error('Not supported');
    });
    expect(() => playChimeSound()).not.toThrow();
  });
});
```

#### `src/lib/stores/agentStatus.test.ts` - Updated Tests

```typescript
describe('agentCounts store', () => {
  it('stores raw counts instead of aggregated status', () => {
    updateWorkspaceCounts('/test', { idle: 2, busy: 1 });
    const counts = get(agentCounts).get('/test');
    expect(counts).toEqual({ idle: 2, busy: 1 });
  });

  it('creates new Map reference on update (Svelte reactivity)', () => {
    const before = get(agentCounts);
    updateWorkspaceCounts('/test', { idle: 1, busy: 0 });
    const after = get(agentCounts);
    expect(before).not.toBe(after);
  });
});
```

#### `src/lib/components/AgentStatusIndicator.test.ts` - Updated Tests

```typescript
describe('AgentStatusIndicator with counts', () => {
  it('renders green for all idle counts', () => {
    render(AgentStatusIndicator, { props: { counts: { idle: 2, busy: 0 } } });
    const element = screen.getByRole('status');
    expect(element.classList.contains('green')).toBe(true);
  });

  it('renders red for all busy counts', () => {
    render(AgentStatusIndicator, { props: { counts: { idle: 0, busy: 3 } } });
    const element = screen.getByRole('status');
    expect(element.classList.contains('red')).toBe(true);
  });

  it('renders mixed for mixed counts', () => {
    render(AgentStatusIndicator, { props: { counts: { idle: 1, busy: 2 } } });
    const element = screen.getByRole('status');
    expect(element.classList.contains('mixed')).toBe(true);
  });

  it('renders grey for zero counts', () => {
    render(AgentStatusIndicator, { props: { counts: { idle: 0, busy: 0 } } });
    const element = screen.getByRole('status');
    expect(element.classList.contains('grey')).toBe(true);
  });

  it('handles large agent counts correctly', () => {
    render(AgentStatusIndicator, { props: { counts: { idle: 100, busy: 50 } } });
    const element = screen.getByRole('status');
    expect(element.getAttribute('title')).toBe('100 idle, 50 busy');
  });

  it('transitions correctly when counts change', async () => {
    const { rerender } = render(AgentStatusIndicator, {
      props: { counts: { idle: 1, busy: 0 } },
    });
    expect(screen.getByRole('status').classList.contains('green')).toBe(true);

    await rerender({ counts: { idle: 0, busy: 0 } });
    expect(screen.getByRole('status').classList.contains('grey')).toBe(true);
  });
});
```

### Backend Tests

#### `src-tauri/src/opencode/discovery.rs` - New Tests

```rust
#[tokio::test]
async fn test_multiple_instances_same_workspace() {
    // Setup: Two OpenCode instances for same workspace
    let mut mock_scanner = MockPortScanner::new();
    let mut mock_probe = MockInstanceProbe::new();
    let mut mock_tree = MockProcessTree::new();

    mock_tree.expect_refresh().returning(|| {});
    mock_tree.expect_get_descendant_pids().returning(|_| {
        let mut descendants = HashSet::new();
        descendants.insert(1001);
        descendants.insert(1002);
        descendants
    });

    mock_scanner.expect_get_active_listeners().returning(|| {
        Ok(vec![
            PortInfo { port: 3000, pid: 1001 },
            PortInfo { port: 3001, pid: 1002 },
        ])
    });

    // Both ports return SAME workspace path
    mock_probe.expect_probe()
        .returning(|_| Box::pin(async { Ok(PathBuf::from("/same/workspace")) }));

    let service = OpenCodeDiscoveryService::new_with_deps(
        Box::new(mock_scanner),
        Box::new(mock_probe),
        Arc::new(mock_tree),
    );

    service.set_code_server_pid(Some(1000)).await;
    service.scan_and_update().await.unwrap();

    // Should return BOTH ports
    let ports = service.get_ports(Path::new("/same/workspace")).await;
    assert_eq!(ports.len(), 2);
    assert!(ports.contains(&3000));
    assert!(ports.contains(&3001));
}

#[tokio::test]
async fn test_two_instances_discovered_same_scan_cycle() {
    // Setup: Scanner returns both ports in single call
    // Verify both are added atomically
}

#[tokio::test]
async fn test_instance_removal_preserves_others() {
    // Setup: Start with two instances, remove one
    // First scan: Both instances
    // Second scan: Only one instance (port 3001 gone)
    // Verify remaining port still tracked
}

#[tokio::test]
async fn test_all_ports_for_workspace_removed() {
    // Both ports disappear
    // Verify workspace entry is cleaned up completely
}

#[tokio::test]
async fn test_get_ports_with_symlinked_paths() {
    // Path A and Path B are symlinks to same location
    // Both should resolve to same port set
}
```

#### `src-tauri/src/opencode/provider.rs` - New Tests

```rust
#[tokio::test]
async fn test_provider_aggregates_multiple_instances() {
    // Setup provider with mock discovery returning 2 ports
    // Port 3000: {idle: 1, busy: 1}
    // Port 3001: {idle: 0, busy: 2}
    // Expected aggregate: {idle: 1, busy: 3}
}

#[tokio::test]
async fn test_provider_handles_dynamic_instance_addition() {
    // Start with 1 instance
    // Add second instance mid-monitoring
    // Verify counts update
}

#[tokio::test]
async fn test_provider_handles_instance_removal() {
    // Start with 2 instances
    // Remove one mid-monitoring
    // Verify counts update to only remaining instance
}

#[tokio::test]
async fn test_one_port_disconnects_others_remain() {
    // Two ports active, one loses connection
    // Verify remaining port's counts still tracked
}

#[tokio::test]
async fn test_all_ports_disconnect() {
    // All connections lost
    // Verify clean fallback to {idle: 0, busy: 0}
}
```

#### `src-tauri/tests/agent_status_integration.rs` - New Tests

```rust
#[tokio::test]
async fn test_mixed_status_with_multiple_instances() {
    // Full integration test:
    // 1. Create workspace
    // 2. Simulate two OpenCode instances (one busy, one idle)
    // 3. Verify status is Mixed { idle: 1, busy: 1 }
}

#[tokio::test]
async fn test_rapid_workspace_add_remove() {
    // Add and remove workspaces rapidly
    // Verify no memory leaks or stale subscriptions
}
```

---

## File Change Summary

| File                                              | Change Type | Description                              |
| ------------------------------------------------- | ----------- | ---------------------------------------- |
| `src/lib/components/AgentStatusIndicator.svelte`  | Modify      | Widen indicator, accept counts prop      |
| `src/lib/components/AgentStatusIndicator.test.ts` | Modify      | Update tests for counts-based props      |
| `src/lib/types/agentStatus.ts`                    | Modify      | Add counts-based utility functions       |
| `src/lib/types/agentStatus.test.ts`               | Modify      | Add tests for new functions              |
| `src/lib/stores/agentStatus.ts`                   | Modify      | Store counts, use notification service   |
| `src/lib/stores/agentStatus.test.ts`              | Modify      | Update store tests                       |
| `src/lib/services/agentNotifications.ts`          | **New**     | Chime notification service               |
| `src/lib/services/agentNotifications.test.ts`     | **New**     | Tests for notification service           |
| `src/lib/components/Sidebar.svelte`               | Modify      | Pass counts to indicator                 |
| `src-tauri/src/opencode/discovery.rs`             | Modify      | Multi-port support with BTreeSet         |
| `src-tauri/src/opencode/provider.rs`              | Modify      | Channel-based multi-instance aggregation |
| `src-tauri/tests/agent_status_integration.rs`     | Modify      | Add multi-instance tests                 |

---

## Implementation Order

**Updated per Architect review** - Frontend changes don't depend on backend since event already contains counts.

1. **Task 1** (Widen indicator) - Quick win, CSS only, no dependencies
2. **Task 2** (Frontend counts tracking + notification service) - Can start immediately
3. **Task 3** (Chime sound) - Part of Task 2.3
4. **Task 4** (Discovery multi-port) - Backend, can be parallel with 2-3
5. **Task 5** (Provider aggregation) - Depends on Task 4

**Parallelization:** Tasks 1, 2, and 4 can all be done in parallel.

---

**Document Version:** 2.0  
**Last Updated:** 2025-11-25
