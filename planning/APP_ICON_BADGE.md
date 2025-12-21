---
status: COMPLETED
last_updated: 2025-12-22
reviewers: [review-typescript, review-arch, review-testing, review-docs, review-ui]
---

# APP_ICON_BADGE

## Overview

- **Problem**: Users have no visual indicator of workspace status when CodeHydra is minimized or in the background. They must switch to the app to check if agents have finished working.
- **Solution**: Display a badge on the app icon showing the count of idle workspaces (agents that have finished and are waiting for input, including those waiting for permission responses).
- **Risks**:
  - Linux support is fragmented (Unity only for `setBadgeCount`)
  - Windows overlay icons require 16x16 images (generated in memory)
  - Badge count aggregation must handle project open/close lifecycle
- **Alternatives Considered**:
  - **Tray icon with badge**: More complex, requires managing separate tray lifecycle. Native badge APIs are simpler and provide better platform integration.
  - **System notifications**: Too intrusive for frequent status changes. Badge is passive and non-disruptive.
  - **Pre-generated PNG files**: Requires file I/O, ASAR packaging concerns, and asset management. In-memory generation is simpler.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Main Process                                  │
│                                                                          │
│  ┌─────────────────────┐      ┌───────────────────────────────────────┐ │
│  │ AgentStatusManager  │      │           BadgeManager                │ │
│  │                     │      │  (src/main/managers/badge-manager.ts) │ │
│  │                     │      │                                       │ │
│  │ onStatusChanged ────┼──────┼──► aggregateAndUpdate()               │ │
│  │                     │      │         │                             │ │
│  │ getAllStatuses() ◄──┼──────┼─────────┤ (sum idle counts)           │ │
│  │                     │      │         ▼                             │ │
│  └─────────────────────┘      │  ┌─────────────────────────────────┐  │ │
│                               │  │ PlatformInfo.platform           │  │ │
│                               │  └─────────────────────────────────┘  │ │
│                               │         │                             │ │
│                               │    ┌────┴────┬────────┬───────┐       │ │
│                               │    ▼         ▼        ▼       ▼       │ │
│                               │  darwin    win32    linux   other     │ │
│                               │    │         │        │       │       │ │
│                               │    ▼         ▼        ▼       ▼       │ │
│                               │  ElectronAppApi      app.set (skip)   │ │
│                               │  .dock.setBadge()    BadgeCount()     │ │
│                               │             │                         │ │
│                               └─────────────┼─────────────────────────┘ │
│                                             ▼                           │
│  ┌─────────────────────┐      ┌───────────────────────────────────────┐ │
│  │   WindowManager     │◄─────│  generateBadgeImage(count)            │ │
│  │   .setOverlayIcon() │      │  → nativeImage from SVG data URL      │ │
│  │   (Windows only)    │      │  → 16x16 red circle + white number    │ │
│  └─────────────────────┘      └───────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Badge Count Aggregation:
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  Workspace A (idle: 1, busy: 0)  ─┐                                     │
│  Workspace B (idle: 2, busy: 1)  ─┼──► Sum idle: 1+2+0 = 3              │
│  Workspace C (none)              ─┘         │                           │
│                                             ▼                           │
│                      Badge shows: [3] (actual count), hidden if = 0     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

Dependency Injection:
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  BadgeManager receives via constructor:                                  │
│  ├── PlatformInfo        (platform detection, testable)                 │
│  ├── ElectronAppApi      (app.dock.setBadge, app.setBadgeCount)         │
│  ├── WindowManager       (setOverlayIcon for Windows)                   │
│  └── AgentStatusManager  (getAllStatuses, onStatusChanged)              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Platform Implementation Details

| Platform | API                                      | Badge Location              | Notes                                |
| -------- | ---------------------------------------- | --------------------------- | ------------------------------------ |
| macOS    | `app.dock.setBadge(string)`              | Dock icon                   | Shows actual count as string         |
| Windows  | `BaseWindow.setOverlayIcon(image, desc)` | Taskbar icon (bottom-right) | 16x16 generated in memory            |
| Linux    | `app.setBadgeCount(number)`              | Dock/launcher               | Unity only, silently fails elsewhere |

## Implementation Steps

- [x] **Step 1: Create ElectronAppApi interface**
  - Create `src/main/managers/electron-app-api.ts`
  - Interface abstracts Electron's `app` module for testability:
    ```typescript
    export interface ElectronAppApi {
      dock?: {
        setBadge(badge: string): void;
      };
      setBadgeCount(count: number): boolean;
    }
    ```
  - Create `DefaultElectronAppApi` class that wraps actual `app` module
  - Create `createMockElectronAppApi()` in test-utils for unit tests
  - Test criteria: Unit test verifies interface methods delegate to real app module

- [x] **Step 2: Add setOverlayIcon method to WindowManager**
  - Add `setOverlayIcon(image: NativeImage | null, description: string): void` method
  - Add platform guard: no-op if `platformInfo.platform !== "win32"`
  - Call `this.window.setOverlayIcon(image, description)`
  - Handle null to clear overlay
  - Add error handling with try/catch (log but don't throw)
  - Inject `PlatformInfo` into WindowManager constructor
  - Test criteria: Unit test with mock BaseWindow verifies method delegation and platform guard

- [x] **Step 3: Create BadgeManager with in-memory image generation**
  - Create `src/main/managers/badge-manager.ts`
  - Constructor dependencies (injected):
    - `platformInfo: PlatformInfo`
    - `appApi: ElectronAppApi`
    - `windowManager: WindowManager`
  - Public method: `updateBadge(idleCount: number): void`
  - Private method: `generateBadgeImage(count: number): NativeImage`
    - Generate 16x16 image using `nativeImage.createFromDataURL()` with SVG:
    ```typescript
    private generateBadgeImage(count: number): NativeImage {
      const text = String(count);
      // Adjust font size for larger numbers
      const fontSize = text.length === 1 ? 10 : text.length === 2 ? 8 : 6;
      const svg = `
        <svg width="16" height="16" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="7" fill="#E51400"/>
          <text x="8" y="12" text-anchor="middle"
                font-size="${fontSize}" font-weight="bold" font-family="Arial" fill="white">
            ${text}
          </text>
        </svg>`;
      return nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
      );
    }
    ```
  - Cache generated images in `Map<number, NativeImage>` for lazy reuse
  - Platform-specific logic in `updateBadge()`:
    - macOS (`darwin`): `appApi.dock?.setBadge(count > 0 ? String(count) : "")`
    - Windows (`win32`): Generate image, call `windowManager.setOverlayIcon(image, description)`
    - Linux (`linux`): `appApi.setBadgeCount(count)` (silently fails on non-Unity)
    - Other: no-op
  - Test criteria: Unit tests verify correct API calls per platform using mocks

- [x] **Step 4: Create BadgeManager integration with AgentStatusManager**
  - Add method to `BadgeManager`: `connectToStatusManager(statusManager: AgentStatusManager): void`
  - Inside this method:
    - Subscribe to `statusManager.onStatusChanged()`
    - On each change: call `statusManager.getAllStatuses()`, sum idle counts, call `updateBadge()`
  - Aggregation logic (private method `aggregateIdleCounts`):
    ```typescript
    private aggregateIdleCounts(statuses: Map<WorkspacePath, AggregatedAgentStatus>): number {
      let total = 0;
      for (const status of statuses.values()) {
        total += status.counts.idle;
      }
      return total;
    }
    ```
  - Wire up in `startServices()` in `src/main/index.ts`:
    - Create `BadgeManager` after `WindowManager` and `AgentStatusManager`
    - Call `badgeManager.connectToStatusManager(agentStatusManager)`
  - Add cleanup: store unsubscribe function, call in dispose
  - Test criteria: Integration test verifies badge updates when workspace status changes

- [x] **Step 5: Handle workspace lifecycle**
  - Badge automatically recalculates on each `onStatusChanged` callback
  - When workspace is removed, `AgentStatusManager` emits status change with `none` status
  - `getAllStatuses()` returns only active workspaces, so removed workspaces don't contribute
  - When last project closes: all statuses removed → idle count = 0 → badge cleared
  - No additional event subscriptions needed - existing mechanism handles lifecycle
  - Test criteria: Badge clears when last project closes, updates when project opens

- [x] **Step 6: Create test utilities**
  - Create `src/main/managers/badge-manager.test-utils.ts`:

    ```typescript
    export function createMockElectronAppApi(): ElectronAppApi & {
      dockSetBadgeCalls: string[];
      setBadgeCountCalls: number[];
    };

    export function createMockWindowManager(): Pick<WindowManager, "setOverlayIcon"> & {
      setOverlayIconCalls: Array<{ image: NativeImage | null; description: string }>;
    };
    ```

  - Test criteria: Mocks capture all calls for assertion in tests

- [x] **Step 7: Update documentation**
  - Update `docs/ARCHITECTURE.md`:
    - Add BadgeManager to managers table
    - Document dependency injection pattern
  - Update `docs/USER_INTERFACE.md`:
    - Add "App Icon Badge" section
    - Document badge behavior, platform support, what "idle" means
  - Update `AGENTS.md`:
    - Add badge behavior to Key Concepts or relevant section
  - Test criteria: Documentation accurately describes feature

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                   | Description                                    | File                                         |
| ------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `ElectronAppApi interface`                  | DefaultElectronAppApi delegates to real app    | `src/main/managers/electron-app-api.test.ts` |
| `WindowManager.setOverlayIcon (win32)`      | Calls BaseWindow.setOverlayIcon on Windows     | `src/main/managers/window-manager.test.ts`   |
| `WindowManager.setOverlayIcon (darwin)`     | No-ops on macOS                                | `src/main/managers/window-manager.test.ts`   |
| `WindowManager.setOverlayIcon (null)`       | Clears overlay when null passed                | `src/main/managers/window-manager.test.ts`   |
| `WindowManager.setOverlayIcon error`        | Handles nativeImage errors gracefully          | `src/main/managers/window-manager.test.ts`   |
| `BadgeManager.updateBadge (darwin)`         | Calls appApi.dock.setBadge with correct string | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.updateBadge (win32)`          | Generates image and calls setOverlayIcon       | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.updateBadge (linux)`          | Calls appApi.setBadgeCount                     | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.updateBadge (0)`              | Clears badge on all platforms                  | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.updateBadge (large count)`    | Shows actual count (e.g., 42)                  | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.updateBadge (negative)`       | Treats negative as 0 (defensive)               | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.aggregateIdleCounts`          | Sums idle counts from all workspaces           | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.generateBadgeImage`           | Returns valid NativeImage                      | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager.generateBadgeImage font size` | Adjusts font for 1, 2, 3+ digit counts         | `src/main/managers/badge-manager.test.ts`    |
| `BadgeManager image caching`                | Reuses cached images for same count            | `src/main/managers/badge-manager.test.ts`    |

### Integration Tests

| Test Case                              | Description                              | File                                                  |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Badge updates on status change         | End-to-end: status change → badge update | `src/main/managers/badge-manager.integration.test.ts` |
| Badge clears on last workspace removed | Verify lifecycle handling                | `src/main/managers/badge-manager.integration.test.ts` |
| Badge shows large counts correctly     | Counts like 15, 42 display properly      | `src/main/managers/badge-manager.integration.test.ts` |
| Multiple rapid status changes          | Badge reflects final state               | `src/main/managers/badge-manager.integration.test.ts` |

### Manual Testing Checklist

- [ ] macOS: Badge appears on dock icon with correct count
- [ ] macOS: Badge shows large numbers correctly (e.g., 15, 42)
- [ ] macOS: Badge disappears when idle count = 0
- [ ] Windows: Overlay appears on taskbar icon with correct number
- [ ] Windows: Overlay shows large numbers correctly (e.g., 15, 42)
- [ ] Windows: Overlay disappears when idle count = 0
- [ ] Linux (Unity): Badge count appears on launcher icon
- [ ] Linux (GNOME): App doesn't crash (badge silently fails)
- [ ] Badge updates in real-time as agents finish work
- [ ] Badge recalculates when project is opened
- [ ] Badge clears when all projects are closed

## Dependencies

| Package | Purpose                                           | Approved |
| ------- | ------------------------------------------------- | -------- |
| (none)  | No new dependencies - uses Electron built-in APIs | N/A      |

## Documentation Updates

### Files to Update

| File                     | Changes Required                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`   | Add BadgeManager to managers table with responsibility: "Display app icon badge showing count of idle workspaces". Document DI pattern (receives PlatformInfo, ElectronAppApi, WindowManager, AgentStatusManager).           |
| `docs/USER_INTERFACE.md` | Add "App Icon Badge" section describing: badge shows idle workspace count (actual number, no cap), platform support (macOS dock, Windows taskbar, Linux Unity), what "idle" means (agents waiting for input or permissions). |
| `AGENTS.md`              | Add badge behavior to Key Concepts: "App icon badge shows count of idle workspaces (green status). Platform support: macOS dock badge, Windows taskbar overlay, Linux Unity launcher. Badge hidden when count is 0."         |

### New Documentation Required

| File   | Purpose                              |
| ------ | ------------------------------------ |
| (none) | Feature documented in existing files |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [x] User acceptance testing passed
- [x] Changes committed
