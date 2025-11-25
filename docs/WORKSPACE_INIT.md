# Workspace Initialization Loading Screen

## Problem

When a workspace is opened, VSCode needs time to initialize (theme, extensions, layout). During this time, the user sees visual artifacts - wrong theme, windows closing/opening, etc. This creates a confusing user experience.

## Solution

Show a loading screen while the workspace initializes, and switch to showing the VSCode iframe when:

1. An agent becomes available (any agent detected), OR
2. A 3-second timeout expires (fallback for when no agents are running)

## State Model

Use a consolidated single-state model per workspace instead of multiple overlapping states:

```typescript
type WorkspaceState = 'loading' | 'initializing' | 'ready' | 'error';
workspaceState: SvelteMap<string, WorkspaceState>;
```

- **Not in map**: workspace not yet activated
- **`'loading'`**: fetching URL / starting code-server
- **`'initializing'`**: iframe mounted but hidden, waiting for agent or timeout
- **`'ready'`**: iframe visible to user
- **`'error'`**: failed to start code-server

This replaces the current separate `loadingWorkspaces`, `workspaceErrors`, and adds initialization tracking.

## Triggers for Transitioning to `'ready'`

1. **Agent available**: When `idle > 0 OR busy > 0` (any agent detected for the workspace)
2. **Timeout**: 3 seconds after entering `'initializing'` state
3. Whichever comes first wins

## State Flow

```
Workspace activated
    ↓
set state to 'loading'
    ↓
ensureWorkspaceReady() called
    ↓
URL obtained → check if agents already present
    ↓
agents present? → set to 'ready' immediately
    ↓
no agents → set state to 'initializing' + start 3s timer
    ↓
iframe mounts (hidden behind overlay)
    ↓
EITHER: agent detected (idle > 0 OR busy > 0) → set to 'ready' + clear timer
    OR: 3s timeout expires → set to 'ready'
    ↓
Fade out overlay, show iframe
```

## Rendering Logic

```
state === 'loading':
    show "Starting code-server..." with spinner
state === 'error':
    show error message
state === 'initializing':
    show "Initializing workspace..." overlay with spinner (on top of hidden iframe)
    mount iframe (hidden)
state === 'ready':
    show iframe (overlay faded out)
```

Key: The iframe must always be mounted once the URL exists, so it can load in the background during the `'initializing'` phase.

## Implementation Details

### Files to Modify

**`src/lib/components/WorkspaceView.svelte`**:

### 1. Use SvelteMap for Fine-Grained Reactivity

Use `SvelteMap` (already imported) instead of `$state<Map>` to avoid full map reconstruction on every update:

```typescript
import { SvelteMap } from 'svelte/reactivity';

// Consolidated state - replaces loadingWorkspaces, workspaceErrors
type WorkspaceState = 'loading' | 'initializing' | 'ready' | 'error';
const workspaceState = new SvelteMap<string, WorkspaceState>();

// Store errors separately (only for error state)
const workspaceErrors = new SvelteMap<string, string>();

// Timeout tracking (plain Map, not reactive)
const initTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// Initialization timeout in ms
const INIT_TIMEOUT_MS = 3000;
```

### 2. Start Initialization with Race Condition Guard

Check agent status immediately when URL is obtained to handle the case where agents are already present:

```typescript
import { agentCounts } from '$lib/stores/agentStatus';

function startInitialization(workspacePath: string) {
  // Guard: don't re-initialize if already in map
  if (workspaceState.has(workspacePath)) {
    return;
  }

  // Check if agents are already present (race condition guard)
  const counts = get(agentCounts).get(workspacePath);
  if (counts && (counts.idle > 0 || counts.busy > 0)) {
    workspaceState.set(workspacePath, 'ready');
    return;
  }

  // No agents yet - enter initializing state with timeout
  workspaceState.set(workspacePath, 'initializing');

  const timeout = setTimeout(() => {
    markWorkspaceReady(workspacePath);
  }, INIT_TIMEOUT_MS);

  initTimeouts.set(workspacePath, timeout);
}
```

### 3. Mark Workspace Ready with Timeout Cleanup

```typescript
function markWorkspaceReady(workspacePath: string) {
  const currentState = workspaceState.get(workspacePath);
  if (currentState === 'initializing') {
    workspaceState.set(workspacePath, 'ready');
    clearInitTimeout(workspacePath);
  }
}

function clearInitTimeout(workspacePath: string) {
  const timeout = initTimeouts.get(workspacePath);
  if (timeout) {
    clearTimeout(timeout);
    initTimeouts.delete(workspacePath);
  }
}
```

### 4. Watch Agent Counts with Proper Reactivity

Use `$agentCounts` (store subscription syntax) for proper reactive subscription:

```typescript
$effect(() => {
  const counts = $agentCounts; // Reactive subscription

  for (const [path, state] of workspaceState) {
    if (state === 'initializing') {
      const workspaceCounts = counts.get(path);
      if (workspaceCounts && (workspaceCounts.idle > 0 || workspaceCounts.busy > 0)) {
        markWorkspaceReady(path);
      }
    }
  }
});
```

### 5. Cleanup on Component Destroy

```typescript
import { onDestroy } from 'svelte';

onDestroy(() => {
  // Clear all pending timeouts to prevent memory leaks
  for (const timeout of initTimeouts.values()) {
    clearTimeout(timeout);
  }
  initTimeouts.clear();
});
```

### 6. Cleanup on Workspace Removal

When a workspace is removed, clean up its timeout:

```typescript
function cleanupWorkspace(workspacePath: string) {
  clearInitTimeout(workspacePath);
  workspaceState.delete(workspacePath);
  workspaceErrors.delete(workspacePath);
  workspaceUrls.delete(workspacePath);
}
```

### 7. CSS for Overlay Positioning

The overlay must cover the hidden iframe:

```css
.initializing-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--vscode-descriptionForeground, #ababab);
  background: var(--vscode-editor-background, #1e1e1e);
}
```

### 8. Fade Transition for Overlay

Use Svelte's built-in fade transition for smooth overlay dismissal:

```svelte
<script>
  import { fade } from 'svelte/transition';
</script>

{#if state === 'initializing'}
  <div class="initializing-overlay" transition:fade={{ duration: 150 }} aria-live="polite">
    <vscode-icon name="loading" size="48"></vscode-icon>
    <p>Initializing workspace...</p>
  </div>
{/if}
```

### 9. Accessibility

Add `aria-live="polite"` to the overlay so screen readers announce loading state changes.

## Edge Cases Handled

- **No opencode running**: 3s timeout ensures workspace becomes usable
- **Switching between workspaces**: State persists in map, already-ready workspaces show immediately
- **Multiple workspaces**: Each has independent timer and state
- **Workspace removed**: Clean up timeout via `cleanupWorkspace()`
- **Agent arrives before initialization**: Race condition guard checks agents immediately
- **Double initialization**: Guard prevents re-initialization if workspace already in state map
- **Component unmount**: `onDestroy` clears all pending timeouts

## UI During Initialization

- Show centered spinner (`<vscode-icon name="loading">`) with text "Initializing workspace..."
- Use same styling as existing "Starting code-server..." loading state
- Fade out overlay when transitioning to ready (150ms)
- `aria-live="polite"` for screen reader accessibility

## TDD Implementation Order

Write tests first, then implement. Use `vi.useFakeTimers()` for deterministic timeout testing.

### Phase 1: Extract and Test Pure Logic

Extract initialization logic to a testable module `src/lib/services/workspaceInit.ts` with unit tests.

**Tests to write first** (`src/lib/services/workspaceInit.test.ts`):

1. **State transitions**
   - `startInitialization` sets state to 'initializing' when no agents present
   - `startInitialization` sets state to 'ready' immediately when agents already present
   - `startInitialization` does nothing if workspace already in state map (double-init guard)
   - `markWorkspaceReady` transitions from 'initializing' to 'ready'
   - `markWorkspaceReady` does nothing if state is not 'initializing'

2. **Timeout behavior**
   - `startInitialization` starts a timeout when entering 'initializing'
   - Timeout fires after 3 seconds and calls `markWorkspaceReady`
   - `markWorkspaceReady` clears pending timeout
   - `clearInitTimeout` clears timeout and removes from tracking map

3. **Agent detection**
   - `checkAgentsPresent` returns true when idle > 0
   - `checkAgentsPresent` returns true when busy > 0
   - `checkAgentsPresent` returns false when both are 0

4. **Cleanup**
   - `cleanupWorkspace` clears timeout for workspace
   - `cleanupWorkspace` removes workspace from state map
   - `cleanupAllTimeouts` clears all pending timeouts

### Phase 2: Component Integration Tests

**Tests to write** (`src/lib/components/WorkspaceView.test.ts`):

1. **Rendering states**
   - Shows "Starting code-server..." when state is 'loading'
   - Shows error message when state is 'error'
   - Shows "Initializing workspace..." overlay when state is 'initializing'
   - Shows iframe (no overlay) when state is 'ready'
   - Iframe is mounted but hidden during 'initializing'

2. **State transitions via agent status**
   - Transitions to 'ready' when agentCounts updates with idle > 0
   - Transitions to 'ready' when agentCounts updates with busy > 0
   - Does not transition if agentCounts has idle=0 and busy=0

3. **Timeout integration**
   - Transitions to 'ready' after 3s timeout when no agents detected
   - Clears timeout when agent detected before timeout fires

4. **Multiple workspaces**
   - Each workspace has independent state
   - Switching workspaces preserves state of previous workspace

### Phase 3: Implementation

After tests are written and failing:

1. Create `src/lib/services/workspaceInit.ts` with exported functions
2. Update `src/lib/components/WorkspaceView.svelte` to use the service
3. Run tests until all pass
4. Run `pnpm validate` to ensure all quality checks pass

### Test Utilities

```typescript
// Use fake timers for deterministic timeout testing
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

// Advance time to trigger timeout
vi.advanceTimersByTime(3000);
```

### Module Structure

```
src/lib/services/
├── workspaceInit.ts        # Pure logic, testable
└── workspaceInit.test.ts   # Unit tests

src/lib/components/
├── WorkspaceView.svelte    # Uses workspaceInit service
└── WorkspaceView.test.ts   # Integration tests
```
