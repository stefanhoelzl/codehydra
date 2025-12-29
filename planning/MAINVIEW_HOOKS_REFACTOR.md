---
status: COMPLETED
last_updated: 2024-12-29
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

# MAINVIEW_HOOKS_REFACTOR

## Overview

- **Problem**: MainView.svelte has 451 lines with a 140-line `onMount` that handles initialization, event subscriptions, and multiple concerns. This makes the component difficult to test and violates single responsibility principle.
- **Solution**: Extract `onMount` logic into focused **setup functions** following the existing `setupDomainEvents` pattern. Each function returns a cleanup callback and can be tested independently.
- **Risks**: Minimal - follows established pattern already in codebase (`setupDomainEvents`)
- **Alternatives Considered**:
  - Component splitting (renderless components are unusual in Svelte)
  - Store-centric (violates current "stores are pure state" pattern)
  - Event bus (over-engineering)
  - Controller/Presenter (fights Svelte 5's design)

## Terminology

This plan uses **Svelte-native terminology**, not React patterns:

| Term             | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| Setup function   | A function called in `onMount` that returns a cleanup callback |
| Cleanup callback | `() => void` function called when component unmounts           |
| Composition      | Combining multiple setup functions in `onMount`                |

**Note**: We use `setup*` prefix (matching existing `setupDomainEvents`) instead of React's `use*` prefix. These are plain functions, not React hooks with special calling rules.

## Architecture

```
MainView.svelte
       │
       │ onMount()
       ▼
┌──────────────────────────────────────────────────────────┐
│                  Setup Function Composition               │
│                                                          │
│  ┌─────────────────────┐  ┌─────────────────────────┐   │
│  │ initializeApp       │  │ setupDomainEventBindings│   │
│  │ - Load projects     │  │ - Wraps setupDomainEvents│   │
│  │ - Load agent status │  │ - Binds to stores       │   │
│  │ - Set focus         │  │ - Returns cleanup       │   │
│  │ - Auto-open picker  │  └─────────────────────────┘   │
│  │ - Returns cleanup*  │                                 │
│  └─────────────────────┘                                 │
│  * cleanup is no-op but maintains consistent pattern     │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ setupDeletionProgress                               │ │
│  │ - Subscribe to deletion events                      │ │
│  │ - Returns cleanup                                   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
       │
       │ Each setup function returns () => void (cleanup)
       ▼
┌──────────────────────────────────────────────────────────┐
│                  MainView (simplified)                    │
│  - onMount: compose setup functions, combine cleanups    │
│  - $effect: UI mode sync (stays in component)            │
│  - Window event: inline (single use, no abstraction)     │
│  - Template: unchanged                                   │
└──────────────────────────────────────────────────────────┘
```

**Design decisions:**

- **No `setupWindowEvent` abstraction**: Only one window event listener exists (`codehydra:open-project`). A 3-line inline pattern is clearer than an abstraction for a single use case.
- **`initializeApp` returns cleanup**: Even though it's async and cleanup is a no-op, returning `() => void` maintains consistent composition pattern.
- **Functions live in `lib/utils/`**: Co-located with existing `domain-events.ts`, not a new top-level directory.

## Implementation Steps

- [x] **Step 1: Create setupDeletionProgress function**
  - Subscribe to `workspace:deletion-progress` events
  - Updates deletion store, auto-clears on success
  - Files affected: `src/renderer/lib/utils/setup-deletion-progress.ts`
  - Test criteria: Store state changes on event, auto-clear on success, cleanup stops updates

- [x] **Step 2: Create setupDomainEventBindings function**
  - Thin wrapper around `setupDomainEvents` with store bindings
  - Moves the 50+ lines of store binding callbacks from MainView (lines 196-250)
  - Type-safe API interface (no consumer-side casting)
  - Files affected: `src/renderer/lib/utils/setup-domain-event-bindings.ts`
  - Test criteria: All 6 event types correctly update stores, cleanup stops updates

- [x] **Step 3: Create initializeApp function**
  - Handles: project loading, agent status fetching, focus management, auto-open picker
  - Focus selector includes VSCode Elements (`vscode-button`, `vscode-textfield`, etc.)
  - Accepts: `{ containerRef, notificationService, onAutoOpenProject }`
  - Returns: `() => void` (no-op cleanup for consistent composition)
  - Files affected: `src/renderer/lib/utils/initialize-app.ts`
  - Test criteria: Store state contains loaded data, focus set correctly, auto-open called when empty

- [x] **Step 4: Refactor MainView.svelte to use setup functions**
  - Replace 140-line onMount with setup function composition (~25 lines)
  - Keep $effect blocks in component (they need component context)
  - Keep event handlers in component (they use local state)
  - Inline window event listener (single use case, no abstraction needed)
  - Files affected: `src/renderer/lib/components/MainView.svelte`
  - Test criteria: All functionality preserved, onMount simplified

- [x] **Step 5: Write integration tests with behavioral mocks**
  - Test each setup function through behavior verification, not call tracking
  - Use behavioral mocks with in-memory state (not `vi.fn()` call trackers)
  - Include error scenarios and cleanup verification
  - Follow existing `domain-events.test.ts` mock factory pattern
  - Files affected: `src/renderer/lib/utils/setup-*.test.ts`, `src/renderer/lib/utils/initialize-app.test.ts`
  - Test criteria: Tests verify state changes, not implementation calls

- [x] **Step 6: Update MainView.test.ts**
  - Remove tests now covered by setup function tests
  - Keep tests for component composition and wiring
  - Files affected: `src/renderer/lib/components/MainView.test.ts`
  - Test criteria: No duplicate coverage, all behaviors tested

- [x] **Step 7: Document setup function pattern in PATTERNS.md**
  - Add "Renderer Setup Functions" section
  - Explain when to extract (onMount >100 lines, multiple concerns)
  - Show composition pattern with cleanup
  - Files affected: `docs/PATTERNS.md`
  - Test criteria: Pattern documented with examples

## Testing Strategy

### Behavioral Mock Pattern

Tests verify **behavior outcomes** (state changes), not **implementation calls** (function invocations).

**Wrong (call tracking):**

```typescript
// DON'T DO THIS - verifies implementation, not behavior
const setDeletionState = vi.fn();
setupDeletionProgress(api, { setDeletionState });
expect(setDeletionState).toHaveBeenCalledWith(progress);
```

**Correct (behavioral verification):**

```typescript
// DO THIS - verifies actual behavior
const deletionStore = createBehavioralDeletionStore(); // has in-memory state
setupDeletionProgress(api, deletionStore);
mockApi.emit("workspace:deletion-progress", progress);
expect(deletionStore.getState(workspacePath)).toEqual(progress);
```

### Integration Tests

| #   | Test Case                                          | Entry Point                  | Behavior Verified                                               |
| --- | -------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- |
| 1   | setupDeletionProgress updates store on event       | emit deletion event          | `expect(store.getState(path)).toEqual(progress)`                |
| 2   | setupDeletionProgress auto-clears on success       | emit completed event         | `expect(store.getState(path)).toBeUndefined()`                  |
| 3   | setupDeletionProgress cleanup stops updates        | call cleanup, emit event     | `expect(store.getState(path)).toBeUndefined()`                  |
| 4   | setupDeletionProgress handles malformed event      | emit invalid data            | store unchanged, no error thrown                                |
| 5   | setupDomainEventBindings routes project:opened     | emit event                   | `expect(store.projects).toContain(project)`                     |
| 6   | setupDomainEventBindings routes project:closed     | emit event                   | `expect(store.projects).not.toContain(project)`                 |
| 7   | setupDomainEventBindings routes workspace:created  | emit event                   | `expect(store.workspaces).toContain(workspace)`                 |
| 8   | setupDomainEventBindings routes workspace:removed  | emit event                   | `expect(store.workspaces).not.toContain(workspace)`             |
| 9   | setupDomainEventBindings routes workspace:switched | emit event                   | `expect(store.activeWorkspacePath).toBe(path)`                  |
| 10  | setupDomainEventBindings routes status-changed     | emit event                   | `expect(store.agentStatus(path)).toEqual(status)`               |
| 11  | setupDomainEventBindings cleanup stops all updates | call cleanup, emit events    | stores unchanged                                                |
| 12  | initializeApp loads projects into store            | call with mock API           | `expect(store.projects).toEqual(projectList)`                   |
| 13  | initializeApp sets active workspace                | call with mock API           | `expect(store.activeWorkspacePath).toBe(path)`                  |
| 14  | initializeApp fetches agent statuses               | call with mock API           | `expect(store.agentStatuses).toEqual(statuses)`                 |
| 15  | initializeApp focuses VSCode Element               | call with container          | `expect(document.activeElement?.tagName).toBe('VSCODE-BUTTON')` |
| 16  | initializeApp calls onAutoOpenProject when empty   | call with empty project list | `expect(onAutoOpenProject).toHaveBeenCalled()`                  |
| 17  | initializeApp handles API failure gracefully       | mock API rejection           | `expect(store.loadingError).toBe(errorMessage)`                 |
| 18  | initializeApp handles status fetch failure         | mock status rejection        | projects loaded, status error ignored                           |

### Manual Testing Checklist

- [ ] App starts and loads projects correctly
- [ ] First focusable element (VSCode button) receives focus on load
- [ ] Switching workspaces works
- [ ] Creating workspace triggers events and updates UI
- [ ] Removing workspace shows deletion progress
- [ ] Agent status updates appear in UI
- [ ] Shortcut mode (Alt+X) opens project picker
- [ ] Chime plays when agent completes work
- [ ] Error states display correctly when API fails

## Dependencies

No new dependencies required. Uses existing:

- `$lib/api` (existing)
- `$lib/stores/*` (existing)
- `$lib/utils/domain-events` (existing)
- `$lib/services/agent-notifications` (existing)

## Documentation Updates

### Files to Update

| File               | Changes Required                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/PATTERNS.md` | Add "Renderer Setup Functions" section with pattern explanation and examples                                                         |
| `AGENTS.md`        | Update App/MainView Split Pattern to mention "onMount composes setup functions for initialization, domain events, deletion progress" |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed

---

## Appendix: Code Sketches

### setup-deletion-progress.ts

```typescript
/**
 * Setup function for workspace deletion progress events.
 * Subscribes to deletion events and updates the deletion store.
 *
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe
 */
import type { DeletionProgress } from "@shared/api/types";
import { setDeletionState, clearDeletion } from "$lib/stores/deletion.svelte";

/**
 * API interface for deletion progress events.
 * Constrained to the specific event type for type safety.
 */
export interface DeletionProgressApi {
  on(
    event: "workspace:deletion-progress",
    handler: (payload: DeletionProgress) => void
  ): () => void;
}

// Default API implementation (imported at module level for tree-shaking)
let defaultApi: DeletionProgressApi | undefined;

function getDefaultApi(): DeletionProgressApi {
  if (!defaultApi) {
    // Lazy import to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("$lib/api");
    defaultApi = { on: api.on };
  }
  return defaultApi;
}

export function setupDeletionProgress(apiImpl: DeletionProgressApi = getDefaultApi()): () => void {
  return apiImpl.on("workspace:deletion-progress", (progress) => {
    setDeletionState(progress);
    // Auto-clear on successful completion
    if (progress.completed && !progress.hasErrors) {
      clearDeletion(progress.workspacePath);
    }
  });
}
```

### setup-domain-event-bindings.ts

```typescript
/**
 * Setup function for domain event subscriptions with store bindings.
 * Thin wrapper around setupDomainEvents that wires events to stores.
 *
 * @param notificationService - Service for agent completion chimes
 * @param apiImpl - API with event subscription (injectable for testing)
 * @returns Cleanup function to unsubscribe from all events
 */
import {
  projects,
  addProject,
  removeProject,
  setActiveWorkspace,
  addWorkspace,
  removeWorkspace,
} from "$lib/stores/projects.svelte";
import { updateStatus } from "$lib/stores/agent-status.svelte";
import { dialogState, openCreateDialog } from "$lib/stores/dialogs.svelte";
import { setupDomainEvents, type DomainEventApi } from "$lib/utils/domain-events";
import { createLogger } from "$lib/logging";
import type { AgentNotificationService } from "$lib/services/agent-notifications";

const logger = createLogger("ui");

// Default API implementation - type-safe wrapper avoiding consumer-side casts
let defaultApi: DomainEventApi | undefined;

function getDefaultApi(): DomainEventApi {
  if (!defaultApi) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("$lib/api");
    defaultApi = { on: api.on };
  }
  return defaultApi;
}

export function setupDomainEventBindings(
  notificationService: AgentNotificationService,
  apiImpl: DomainEventApi = getDefaultApi()
): () => void {
  return setupDomainEvents(
    apiImpl,
    {
      addProject: (project) => {
        addProject(project);
        logger.debug("Store updated", { store: "projects" });
      },
      removeProject: (projectId) => {
        const project = projects.value.find((p) => p.id === projectId);
        if (project) {
          removeProject(project.path);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      addWorkspace: (projectId, workspace) => {
        const project = projects.value.find((p) => p.id === projectId);
        if (project) {
          addWorkspace(project.path, workspace);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      removeWorkspace: (ref) => {
        const project = projects.value.find((p) => p.id === ref.projectId);
        if (project) {
          removeWorkspace(project.path, ref.path);
          logger.debug("Store updated", { store: "projects" });
        }
      },
      setActiveWorkspace: (ref) => {
        setActiveWorkspace(ref?.path ?? null);
        logger.debug("Store updated", { store: "projects" });
      },
      updateAgentStatus: (ref, status) => {
        updateStatus(ref.path, status.agent);
        logger.debug("Store updated", { store: "agent-status" });
      },
    },
    {
      onProjectOpenedHook: (project) => {
        if (project.workspaces.length === 0 && dialogState.value.type === "closed") {
          openCreateDialog(project.id);
        }
      },
    },
    { notificationService }
  );
}
```

### initialize-app.ts

```typescript
/**
 * Initialize the application: load projects, agent statuses, set focus, auto-open picker.
 *
 * This is an async setup function that returns a cleanup callback for consistent
 * composition, even though the cleanup is a no-op (initialization is one-time).
 *
 * @param options - Initialization options
 * @param apiImpl - API for data fetching (injectable for testing)
 * @returns Cleanup function (no-op for consistent composition pattern)
 */
import { tick } from "svelte";
import { setProjects, setActiveWorkspace, setLoaded, setError } from "$lib/stores/projects.svelte";
import { setAllStatuses } from "$lib/stores/agent-status.svelte";
import type { Project, WorkspaceStatus, AgentStatus } from "@shared/api/types";
import type { AgentNotificationService } from "$lib/services/agent-notifications";

export interface InitializeAppOptions {
  /** Container element for focus management */
  containerRef: HTMLElement | undefined;
  /** Notification service to seed with initial agent counts */
  notificationService: AgentNotificationService;
  /** Callback when no projects exist (first launch experience) */
  onAutoOpenProject?: () => Promise<void>;
}

export interface InitializeAppApi {
  projects: { list(): Promise<Project[]> };
  workspaces: { getStatus(projectId: string, name: string): Promise<WorkspaceStatus> };
  ui: { getActiveWorkspace(): Promise<{ path: string } | null> };
}

/**
 * Focus selector that includes VSCode Elements components.
 * VSCode Elements are custom elements that should be focusable.
 */
const FOCUSABLE_SELECTOR = [
  'vscode-button:not([disabled]):not([tabindex="-1"])',
  'vscode-textfield:not([disabled]):not([tabindex="-1"])',
  'vscode-checkbox:not([disabled]):not([tabindex="-1"])',
  'vscode-dropdown:not([disabled]):not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

async function fetchAllAgentStatuses(
  projectList: readonly Project[],
  apiImpl: InitializeAppApi
): Promise<Record<string, AgentStatus>> {
  const result: Record<string, AgentStatus> = {};
  const promises: Promise<void>[] = [];

  for (const project of projectList) {
    for (const workspace of project.workspaces) {
      promises.push(
        apiImpl.workspaces
          .getStatus(project.id, workspace.name)
          .then((status) => {
            result[workspace.path] = status.agent;
          })
          .catch(() => {
            // Individual workspace status fetch failures are non-critical
            // Continue with other workspaces
          })
      );
    }
  }
  await Promise.all(promises);
  return result;
}

// Default API - lazy loaded to avoid circular dependencies
let defaultApi: InitializeAppApi | undefined;

function getDefaultApi(): InitializeAppApi {
  if (!defaultApi) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("$lib/api");
    defaultApi = {
      projects: api.projects,
      workspaces: api.workspaces,
      ui: api.ui,
    };
  }
  return defaultApi;
}

export async function initializeApp(
  options: InitializeAppOptions,
  apiImpl: InitializeAppApi = getDefaultApi()
): Promise<() => void> {
  const { containerRef, notificationService, onAutoOpenProject } = options;

  try {
    // Load projects
    const projectList = await apiImpl.projects.list();
    setProjects([...projectList]);

    // Get initial active workspace
    const activeRef = await apiImpl.ui.getActiveWorkspace();
    if (activeRef) {
      setActiveWorkspace(activeRef.path);
    }
    setLoaded();

    // Focus first focusable element (including VSCode Elements)
    await tick();
    const firstFocusable = containerRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    // Fetch agent statuses (optional, don't fail on error)
    try {
      const statuses = await fetchAllAgentStatuses(projectList, apiImpl);
      setAllStatuses(statuses);

      // Seed notification service with initial counts for chime detection
      const initialCounts = Object.fromEntries(
        Object.entries(statuses).map(([path, status]) => [
          path,
          status.type === "none"
            ? { idle: 0, busy: 0 }
            : { idle: status.counts.idle, busy: status.counts.busy },
        ])
      );
      notificationService.seedInitialCounts(initialCounts);
    } catch {
      // Agent status is optional, don't fail initialization
    }

    // Auto-open project picker on first launch (no projects)
    if (projectList.length === 0 && onAutoOpenProject) {
      await onAutoOpenProject();
    }
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : "Failed to load projects");
  }

  // Return no-op cleanup for consistent composition pattern
  return () => {};
}
```

### MainView.svelte (after refactoring)

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import {
    projects,
    activeWorkspacePath,
    loadingState,
    loadingError,
    getAllWorkspaces,
  } from "$lib/stores/projects.svelte";
  import {
    dialogState,
    openCreateDialog,
    openRemoveDialog,
    openCloseProjectDialog,
  } from "$lib/stores/dialogs.svelte";
  import {
    shortcutModeActive,
    setDialogOpen,
    syncMode,
    desiredMode,
  } from "$lib/stores/ui-mode.svelte";
  import { getDeletionState, getDeletionStatus, clearDeletion } from "$lib/stores/deletion.svelte";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import { createLogger } from "$lib/logging";

  // Setup functions
  import { setupDeletionProgress } from "$lib/utils/setup-deletion-progress";
  import { setupDomainEventBindings } from "$lib/utils/setup-domain-event-bindings";
  import { initializeApp } from "$lib/utils/initialize-app";

  // Components
  import Sidebar from "./Sidebar.svelte";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import CloseProjectDialog from "./CloseProjectDialog.svelte";
  import OpenProjectErrorDialog from "./OpenProjectErrorDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import DeletionProgressView from "./DeletionProgressView.svelte";
  import Logo from "./Logo.svelte";

  import type { ProjectId, WorkspaceRef } from "$lib/api";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  // Container ref for focus management
  let containerRef: HTMLElement;

  // Error state for open project dialog
  let openProjectError = $state<string | null>(null);

  // Sync dialog state to central ui-mode store
  $effect(() => {
    const isDialogOpen = dialogState.value.type !== "closed";
    setDialogOpen(isDialogOpen);
  });

  // Sync desiredMode with main process
  // Note: desiredMode.value is accessed to establish reactive dependency,
  // then syncMode() reads it internally and sends to main process
  $effect(() => {
    void desiredMode.value;
    syncMode();
  });

  // Derive deletion state for active workspace
  const activeDeletionState = $derived(
    activeWorkspacePath.value ? getDeletionState(activeWorkspacePath.value) : undefined
  );

  // Event handlers (stay in component - use local state)
  async function handleOpenProject(): Promise<void> {
    const path = await api.ui.selectFolder();
    if (!path) return;

    try {
      await api.projects.open(path);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project", { path, error: message });
      openProjectError = message;
    }
  }

  async function handleOpenProjectRetry(): Promise<void> {
    const path = await api.ui.selectFolder();
    if (!path) return;

    openProjectError = null;
    try {
      await api.projects.open(path);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project", { path, error: message });
      openProjectError = message;
    }
  }

  function handleOpenProjectErrorClose(): void {
    openProjectError = null;
  }

  function handleCloseProject(projectId: ProjectId): void {
    const project = projects.value.find((p) => p.id === projectId);
    if (!project) return;
    logger.debug("Dialog opened", { type: "close-project" });
    openCloseProjectDialog(projectId);
  }

  async function handleSwitchWorkspace(workspaceRef: WorkspaceRef): Promise<void> {
    logger.debug("Workspace selected", { workspaceName: workspaceRef.workspaceName });
    await api.ui.switchWorkspace(workspaceRef.projectId, workspaceRef.workspaceName);
  }

  function handleOpenCreateDialog(projectId: ProjectId): void {
    logger.debug("Dialog opened", { type: "create-workspace" });
    openCreateDialog(projectId);
  }

  function handleOpenRemoveDialog(workspaceRef: WorkspaceRef): void {
    logger.debug("Dialog opened", { type: "remove-workspace" });
    openRemoveDialog(workspaceRef);
  }

  function handleRetry(): void {
    if (!activeDeletionState) return;
    logger.debug("Retrying deletion", { workspaceName: activeDeletionState.workspaceName });
    void api.workspaces.remove(
      activeDeletionState.projectId,
      activeDeletionState.workspaceName,
      activeDeletionState.keepBranch,
      true
    );
  }

  async function handleCloseAnyway(): Promise<void> {
    if (!activeDeletionState) return;
    logger.debug("Force removing workspace", { workspaceName: activeDeletionState.workspaceName });
    try {
      await api.workspaces.forceRemove(
        activeDeletionState.projectId,
        activeDeletionState.workspaceName
      );
      clearDeletion(activeDeletionState.workspacePath);
    } catch (error) {
      logger.warn("Force remove failed", { error: getErrorMessage(error) });
    }
  }

  // Initialize and subscribe to events on mount
  onMount(() => {
    const notificationService = new AgentNotificationService();

    // Compose setup functions - each returns cleanup callback
    const cleanupDeletion = setupDeletionProgress();
    const cleanupDomainEvents = setupDomainEventBindings(notificationService);

    // Window event listener - inline (single use case, no abstraction needed)
    const handleOpenProjectEvent = (): void => {
      void handleOpenProject();
    };
    window.addEventListener("codehydra:open-project", handleOpenProjectEvent);

    // Initialize app (async with no-op cleanup for consistent composition)
    let cleanupInit = (): void => {};
    void initializeApp({
      containerRef,
      notificationService,
      onAutoOpenProject: handleOpenProject,
    }).then((cleanup) => {
      cleanupInit = cleanup;
    });

    // Combined cleanup
    return () => {
      cleanupDeletion();
      cleanupDomainEvents();
      cleanupInit();
      window.removeEventListener("codehydra:open-project", handleOpenProjectEvent);
    };
  });
</script>

<!-- Template unchanged from original -->
<div class="main-view" bind:this={containerRef}>
  <Sidebar
    projects={projects.value}
    activeWorkspacePath={activeWorkspacePath.value}
    loadingState={loadingState.value}
    loadingError={loadingError.value}
    shortcutModeActive={shortcutModeActive.value}
    totalWorkspaces={getAllWorkspaces().length}
    onOpenProject={handleOpenProject}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenCreateDialog={handleOpenCreateDialog}
    onOpenRemoveDialog={handleOpenRemoveDialog}
  />

  {#if dialogState.value.type === "create"}
    <CreateWorkspaceDialog open={true} projectId={dialogState.value.projectId} />
  {:else if dialogState.value.type === "remove"}
    <RemoveWorkspaceDialog open={true} workspaceRef={dialogState.value.workspaceRef} />
  {:else if dialogState.value.type === "close-project"}
    <CloseProjectDialog open={true} projectId={dialogState.value.projectId} />
  {/if}

  <OpenProjectErrorDialog
    open={openProjectError !== null}
    errorMessage={openProjectError ?? ""}
    onRetry={handleOpenProjectRetry}
    onClose={handleOpenProjectErrorClose}
  />

  <ShortcutOverlay
    active={shortcutModeActive.value}
    workspaceCount={getAllWorkspaces().length}
    hasActiveProject={projects.value.length > 0}
    hasActiveWorkspace={activeWorkspacePath.value !== null}
    activeWorkspaceDeletionInProgress={activeWorkspacePath.value !== null &&
      getDeletionStatus(activeWorkspacePath.value) === "in-progress"}
  />

  {#if activeDeletionState}
    <DeletionProgressView
      progress={activeDeletionState}
      onRetry={handleRetry}
      onCloseAnyway={handleCloseAnyway}
    />
  {:else if activeWorkspacePath.value === null}
    <div class="empty-backdrop" aria-hidden="true">
      <div class="backdrop-logo">
        <Logo animated={false} />
      </div>
    </div>
  {/if}
</div>

<style>
  /* Styles unchanged */
</style>
```

**Result**: `onMount` goes from ~140 lines to ~25 lines.

### PATTERNS.md Addition

````markdown
## Renderer Setup Functions

Complex `onMount` logic can be extracted into focused **setup functions** that return cleanup callbacks. This improves testability and single responsibility.

### When to Extract

- `onMount` exceeds ~100 lines
- Multiple unrelated concerns in one `onMount`
- Logic needs to be tested in isolation
- Similar setup logic could be reused

### Pattern

```typescript
// lib/utils/setup-feature.ts
export interface FeatureApi {
  on(event: "feature:event", handler: (data: Data) => void): () => void;
}

export function setupFeature(apiImpl: FeatureApi = defaultApi): () => void {
  const unsubscribe = apiImpl.on("feature:event", (data) => {
    updateStore(data);
  });
  return unsubscribe; // cleanup callback
}

// Component.svelte
onMount(() => {
  const cleanup1 = setupFeature();
  const cleanup2 = setupOtherFeature();

  return () => {
    cleanup1();
    cleanup2();
  };
});
```
````

### Testing Setup Functions

Use **behavioral mocks** that verify state changes, not call tracking:

```typescript
// Create behavioral mock with in-memory state
const store = createBehavioralStore();
const api = createMockApi();

// Call setup function
const cleanup = setupFeature(api);

// Emit event and verify BEHAVIOR (state change)
api.emit("feature:event", testData);
expect(store.getState()).toEqual(expectedState);

// Verify cleanup stops updates
cleanup();
api.emit("feature:event", otherData);
expect(store.getState()).toEqual(expectedState); // unchanged
```

### Naming Convention

- Use `setup*` prefix (e.g., `setupDomainEvents`, `setupDeletionProgress`)
- For one-time async initialization, use `initialize*` (e.g., `initializeApp`)
- Always return `() => void` cleanup callback for consistent composition

```

```
