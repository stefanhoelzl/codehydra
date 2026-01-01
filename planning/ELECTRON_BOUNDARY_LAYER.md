---
status: CLEANUP
last_updated: 2026-01-01
reviewers: [review-arch, review-typescript, review-testing, review-docs, review-platform]
---

# ELECTRON_BOUNDARY_LAYER

## Overview

- **Problem**: Electron APIs are used directly throughout the codebase, making testing difficult. Each test file recreates similar Electron mocks (`vi.mock("electron", ...)`), leading to repetitive boilerplate and leaky abstractions (e.g., `IViewManager` returns `WebContentsView` directly).

- **Solution**: Abstract all Electron-specific APIs behind testable interfaces following the established `FileSystemLayer` pattern. Create two domains:
  - **Shell** (`src/services/shell/`) - Visual container abstractions (Window, View, Session)
  - **Platform** (`src/services/platform/`) - OS/runtime abstractions (IPC, Dialog, Image, App, Menu)

- **Risks**:
  - Large scope (8 layers) - mitigated by vertical slices with user testing after each slice
  - Boundary tests need display - mitigated by programmatic xvfb setup and `show: false`
  - Migration effort for existing managers - mitigated by each slice completing one manager

- **Alternatives Considered**:
  - Single unified `ElectronLayer` - rejected (too large, violates single responsibility)
  - Keep layers in `src/main/` - rejected (inconsistent with existing `src/services/platform/` pattern)
  - Skip boundary tests in CI - rejected (lose contract verification on Linux)
  - Use `xvfb-run` shell command - rejected (want `npm test` to just work without wrapper commands)
  - Horizontal phases (all layers → all managers) - rejected (only 2 user testing points)

## Approvals Required

Per AGENTS.md critical rules, this plan requires explicit user approval for:

1. **8 New Boundary Interfaces** (per "New Boundary Interfaces" rule):
   - Shell: `WindowLayer`, `ViewLayer`, `SessionLayer`
   - Platform: `IpcLayer`, `DialogLayer`, `ImageLayer`, `AppLayer`, `MenuLayer`

2. **IViewManager Interface Change** (per "API/IPC Interface Changes" rule):
   - Current: `getWorkspaceView(path: string): WebContentsView | undefined`
   - New: `getWorkspaceView(path: string): ViewHandle | undefined`
   - Affected files: `view-manager.interface.ts`, `view-manager.ts`, `view-manager.test.ts`, any code calling `getWorkspaceView()`

**USER APPROVAL REQUIRED BEFORE IMPLEMENTATION**

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              src/services/                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │        shell/               │    │           platform/                  │ │
│  │                             │    │                                      │ │
│  │  ┌───────────────────────┐  │    │  ┌────────────────────────────────┐ │ │
│  │  │     WindowLayer       │  │    │  │  filesystem.ts (existing)      │ │ │
│  │  │  - createWindow()     │  │    │  │  process.ts (existing)         │ │ │
│  │  │  - destroy()          │  │    │  │  path.ts (existing)            │ │ │
│  │  │  - getBounds()        │  │    │  ├────────────────────────────────┤ │ │
│  │  │  - setOverlayIcon()   │  │    │  │  ipc.ts (NEW)                  │ │ │
│  │  └───────────────────────┘  │    │  │  - handle()                    │ │ │
│  │           │                 │    │  │  - removeHandler()             │ │ │
│  │           │ uses            │    │  ├────────────────────────────────┤ │ │
│  │           ▼                 │    │  │  dialog.ts (NEW)               │ │ │
│  │  ┌───────────────────────┐  │    │  │  - showOpenDialog()            │ │ │
│  │  │      ViewLayer        │  │    │  │  - showErrorBox()              │ │ │
│  │  │  - createView()       │  │    │  ├────────────────────────────────┤ │ │
│  │  │  - loadURL()          │  │    │  │  image.ts (NEW)                │ │ │
│  │  │  - setBounds()        │  │    │  │  - createFromPath()            │ │ │
│  │  │  - attach/detach()    │  │    │  │  - createFromDataURL()         │ │ │
│  │  └───────────────────────┘  │    │  ├────────────────────────────────┤ │ │
│  │           │                 │    │  │  app.ts (NEW)                  │ │ │
│  │           │ uses            │    │  │  - setBadgeCount()             │ │ │
│  │           ▼                 │    │  │  - getPath()                   │ │ │
│  │  ┌───────────────────────┐  │    │  │  - dock.setBadge()             │ │ │
│  │  │    SessionLayer       │  │    │  ├────────────────────────────────┤ │ │
│  │  │  - fromPartition()    │  │    │  │  menu.ts (NEW)                 │ │ │
│  │  │  - clearStorageData() │  │    │  │  - setApplicationMenu()        │ │ │
│  │  │  - setPermissions()   │  │    │  └────────────────────────────────┘ │ │
│  │  └───────────────────────┘  │    │                                      │ │
│  │                             │    │  ┌────────────────────────────────┐ │ │
│  │  ┌───────────────────────┐  │    │  │  errors.ts (NEW)               │ │ │
│  │  │      types.ts         │  │    │  │  - PlatformError               │ │ │
│  │  │  - WindowHandle       │  │    │  └────────────────────────────────┘ │ │
│  │  │  - ViewHandle         │  │    │                                      │ │
│  │  │  - SessionHandle      │  │    └─────────────────────────────────────┘ │
│  │  │  - Rectangle          │  │                                            │
│  │  └───────────────────────┘  │                                            │
│  │                             │                                            │
│  │  ┌───────────────────────┐  │                                            │
│  │  │      errors.ts        │  │                                            │
│  │  │  - ShellError         │  │                                            │
│  │  └───────────────────────┘  │                                            │
│  │                             │                                            │
│  └─────────────────────────────┘                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Used by
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              src/main/                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           managers/                                      ││
│  │                                                                          ││
│  │  WindowManager ──────► WindowLayer, ImageLayer                           ││
│  │  ViewManager ────────► ViewLayer, SessionLayer, WindowLayer              ││
│  │  BadgeManager ───────► AppLayer, ImageLayer, WindowManager               ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                             api/                                         ││
│  │                                                                          ││
│  │  ApiRegistry ────────► IpcLayer                                          ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          bootstrap.ts                                    ││
│  │                                                                          ││
│  │  Uses ───────────────► DialogLayer, MenuLayer, AppLayer                  ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer Dependency Rules

- **Shell layers may depend on each other**: ViewLayer → SessionLayer, ViewLayer → WindowLayer
- **Platform layers are independent**: No dependencies between platform layers
- **Shell may use Platform**: WindowLayer → ImageLayer (for overlay icons)
- **Platform may NOT use Shell**: Platform layers are lower-level primitives

### Handle Pattern

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Opaque Handle Pattern                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  // Branded types prevent accidental mixing                               │
│  interface ViewHandle {                                                   │
│    readonly id: string;                                                   │
│    readonly __brand: 'ViewHandle';                                        │
│  }                                                                        │
│                                                                           │
│  interface WindowHandle {                                                 │
│    readonly id: string;                                                   │
│    readonly __brand: 'WindowHandle';                                      │
│  }                                                                        │
│                                                                           │
│  // ID format: "<layer-prefix>-<counter>" e.g., "view-1", "window-1"      │
│  // IDs are unique within each layer, not globally                        │
│                                                                           │
│  // Internal mapping in DefaultViewLayer:                                 │
│  private readonly views = new Map<string, WebContentsView>();             │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Manager Code                                                         │ │
│  │                                                                      │ │
│  │   const handle = viewLayer.createView({ ... });                      │ │
│  │   await viewLayer.loadURL(handle, "http://localhost:3000");          │ │
│  │   viewLayer.setBounds(handle, { x: 0, y: 0, width: 800, height: 600 });│
│  │   viewLayer.destroy(handle);                                         │ │
│  │                                                                      │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Benefits:                                                                │
│  - Managers never see WebContentsView, BaseWindow, etc.                  │
│  - Mocks just return { id: "test-1", __brand: "ViewHandle" }             │
│  - All Electron access centralized in layer implementations              │
│  - Map lookup overhead is O(1) and negligible vs. Electron IPC           │
│                                                                           │
│  Error Handling:                                                          │
│  - Operations on invalid handle: throw ShellError("VIEW_NOT_FOUND")       │
│  - Operations on destroyed handle: throw ShellError("VIEW_DESTROYED")     │
│  - Layer validates handle ownership before operations                     │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Type Definitions

```typescript
// src/services/shell/types.ts

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WebPreferences {
  readonly nodeIntegration?: boolean;
  readonly contextIsolation?: boolean;
  readonly sandbox?: boolean;
  readonly partition?: string;
  readonly preload?: string;
}

export interface WindowHandle {
  readonly id: string;
  readonly __brand: "WindowHandle";
}

export interface ViewHandle {
  readonly id: string;
  readonly __brand: "ViewHandle";
}

export interface SessionHandle {
  readonly id: string;
  readonly __brand: "SessionHandle";
}

// Helper to create handles (used by layer implementations)
export function createViewHandle(id: string): ViewHandle {
  return { id, __brand: "ViewHandle" };
}
```

### Pattern Example: Complete ViewLayer

```typescript
// src/services/shell/view.ts

import type { ViewHandle, Rectangle, WebPreferences } from "./types";
import { ShellError } from "./errors";
import type { SessionHandle } from "./session";
import type { WindowHandle } from "./window";

// ============================================================================
// Types
// ============================================================================

export interface ViewOptions {
  readonly webPreferences?: WebPreferences;
  readonly backgroundColor?: string;
}

export interface WindowOpenDetails {
  readonly url: string;
  readonly frameName: string;
  readonly disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
}

export type WindowOpenAction = { action: "allow" } | { action: "deny" };
export type WindowOpenHandler = (details: WindowOpenDetails) => WindowOpenAction;
export type Unsubscribe = () => void;

// ============================================================================
// Interface
// ============================================================================

export interface ViewLayer {
  // Lifecycle
  createView(options: ViewOptions): ViewHandle;
  destroy(handle: ViewHandle): void;
  destroyAll(): void;

  // Navigation
  loadURL(handle: ViewHandle, url: string): Promise<void>;
  getURL(handle: ViewHandle): string;

  // Layout
  setBounds(handle: ViewHandle, bounds: Rectangle): void;
  getBounds(handle: ViewHandle): Rectangle;
  setBackgroundColor(handle: ViewHandle, color: string): void;

  // Focus
  focus(handle: ViewHandle): void;

  // Window attachment
  attachToWindow(handle: ViewHandle, window: WindowHandle): void;
  detachFromWindow(handle: ViewHandle): void;

  // Events
  onDidFinishLoad(handle: ViewHandle, callback: () => void): Unsubscribe;
  onWillNavigate(handle: ViewHandle, callback: (url: string) => void): Unsubscribe;
  setWindowOpenHandler(handle: ViewHandle, handler: WindowOpenHandler | null): void;

  // Cleanup
  dispose(): Promise<void>;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { WebContentsView } from "electron";
import type { Logger } from "../logging";

export class DefaultViewLayer implements ViewLayer {
  private readonly views = new Map<string, WebContentsView>();
  private nextId = 1;

  constructor(private readonly logger: Logger) {}

  createView(options: ViewOptions): ViewHandle {
    const id = `view-${this.nextId++}`;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: options.webPreferences?.nodeIntegration ?? false,
        contextIsolation: options.webPreferences?.contextIsolation ?? true,
        sandbox: options.webPreferences?.sandbox ?? true,
        partition: options.webPreferences?.partition,
        preload: options.webPreferences?.preload,
      },
    });

    if (options.backgroundColor) {
      view.setBackgroundColor(options.backgroundColor);
    }

    this.views.set(id, view);
    this.logger.debug("View created", { id });
    return { id, __brand: "ViewHandle" };
  }

  destroy(handle: ViewHandle): void {
    const view = this.getView(handle);
    this.views.delete(handle.id);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.logger.debug("View destroyed", { id: handle.id });
  }

  destroyAll(): void {
    for (const [id] of this.views) {
      this.destroy({ id, __brand: "ViewHandle" });
    }
  }

  async loadURL(handle: ViewHandle, url: string): Promise<void> {
    const view = this.getView(handle);
    await view.webContents.loadURL(url);
  }

  getURL(handle: ViewHandle): string {
    const view = this.getView(handle);
    return view.webContents.getURL();
  }

  // ... other methods follow same pattern

  private getView(handle: ViewHandle): WebContentsView {
    const view = this.views.get(handle.id);
    if (!view) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    if (view.webContents.isDestroyed()) {
      this.views.delete(handle.id);
      throw new ShellError("VIEW_DESTROYED", `View ${handle.id} was destroyed`, handle.id);
    }
    return view;
  }

  async dispose(): Promise<void> {
    this.destroyAll();
  }
}
```

```typescript
// src/services/shell/view.test-utils.ts

import type { ViewLayer, ViewOptions, WindowOpenHandler, Unsubscribe } from "./view";
import type { ViewHandle, Rectangle } from "./types";
import type { WindowHandle } from "./window";
import { ShellError } from "./errors";

interface ViewState {
  url: string | null;
  bounds: Rectangle | null;
  backgroundColor: string | null;
  attachedTo: string | null; // WindowHandle.id
  options: ViewOptions;
}

interface ViewLayerState {
  views: Map<string, ViewState>;
}

export function createBehavioralViewLayer(): ViewLayer & { _getState(): ViewLayerState } {
  const views = new Map<string, ViewState>();
  let nextId = 1;

  function getView(handle: ViewHandle): ViewState {
    const view = views.get(handle.id);
    if (!view) {
      throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
    }
    return view;
  }

  return {
    createView(options: ViewOptions): ViewHandle {
      const id = `view-${nextId++}`;
      views.set(id, {
        url: null,
        bounds: null,
        backgroundColor: options.backgroundColor ?? null,
        attachedTo: null,
        options,
      });
      return { id, __brand: "ViewHandle" };
    },

    destroy(handle: ViewHandle): void {
      if (!views.delete(handle.id)) {
        throw new ShellError("VIEW_NOT_FOUND", `View ${handle.id} not found`, handle.id);
      }
    },

    destroyAll(): void {
      views.clear();
    },

    async loadURL(handle: ViewHandle, url: string): Promise<void> {
      const view = getView(handle);
      view.url = url;
    },

    getURL(handle: ViewHandle): string {
      const view = getView(handle);
      return view.url ?? "";
    },

    setBounds(handle: ViewHandle, bounds: Rectangle): void {
      const view = getView(handle);
      view.bounds = bounds;
    },

    getBounds(handle: ViewHandle): Rectangle {
      const view = getView(handle);
      return view.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    },

    setBackgroundColor(handle: ViewHandle, color: string): void {
      const view = getView(handle);
      view.backgroundColor = color;
    },

    focus(_handle: ViewHandle): void {
      getView(_handle); // Validate handle exists
    },

    attachToWindow(handle: ViewHandle, window: WindowHandle): void {
      const view = getView(handle);
      view.attachedTo = window.id;
    },

    detachFromWindow(handle: ViewHandle): void {
      const view = getView(handle);
      view.attachedTo = null;
    },

    onDidFinishLoad(_handle: ViewHandle, _callback: () => void): Unsubscribe {
      getView(_handle); // Validate handle exists
      return () => {};
    },

    onWillNavigate(_handle: ViewHandle, _callback: (url: string) => void): Unsubscribe {
      getView(_handle); // Validate handle exists
      return () => {};
    },

    setWindowOpenHandler(_handle: ViewHandle, _handler: WindowOpenHandler | null): void {
      getView(_handle); // Validate handle exists
    },

    async dispose(): Promise<void> {
      views.clear();
    },

    // State inspection for tests
    _getState(): ViewLayerState {
      return { views: new Map(views) };
    },
  };
}
```

---

## Implementation Steps

### Slice 1: IPC Layer + ApiRegistry

**Goal**: Abstract IPC handler registration, migrate ApiRegistry, verify app starts.

- [x] **Step 1.1: Test display setup**
  - Create `src/test/setup-display.ts` for programmatic xvfb on Linux CI
  - Use `xvfb` npm package in `optionalDependencies` (not devDependencies)
  - Add try-catch for dynamic import to handle missing package gracefully
  - Update `vitest.config.ts` to use global setup for boundary tests
  - All test windows use `show: false` to prevent visibility
  - Files: `src/test/setup-display.ts`, `vitest.config.ts`, `package.json`
  - Test: `npm test` works on all platforms, no windows visible locally

- [x] **Step 1.2: Platform error types**
  - Create `src/services/platform/errors.ts` with `PlatformError` class extending `Error`
  - Error codes: `IPC_HANDLER_EXISTS`, `IPC_HANDLER_NOT_FOUND`, `DIALOG_CANCELLED`, `IMAGE_LOAD_FAILED`, `APP_NOT_READY`
  - Files: `src/services/platform/errors.ts`, `src/services/platform/errors.test.ts`
  - Test: Error class instantiation, properties preserved

- [x] **Step 1.3: IpcLayer**
  - Interface: `handle(channel, handler)`, `removeHandler(channel)`, `removeAllHandlers()`
  - Note: IpcLayer wraps `ipcMain` only (handler registration). Sending to renderer is done via ViewLayer's webContents access.
  - Implementation: `DefaultIpcLayer` wraps `ipcMain`
  - Behavioral mock: `createBehavioralIpcLayer()` with in-memory handler map and `_getState()`
  - Boundary test: Handler registration, removal (skip invoke test - requires full Electron app)
  - Files: `src/services/platform/ipc.ts`, `src/services/platform/ipc.test-utils.ts`, `src/services/platform/ipc.boundary.test.ts`, `src/services/platform/ipc.integration.test.ts`
  - Test: Register handler, remove handler, removeAll clears all, duplicate registration throws

- [x] **Step 1.4: Migrate ApiRegistry to IpcLayer**
  - Update `ApiRegistry` constructor to accept `IpcLayer`
  - Replace `ipcMain.handle()` calls with `ipcLayer.handle()`
  - Replace `ipcMain.removeHandler()` with `ipcLayer.removeHandler()`
  - Update tests to use `createBehavioralIpcLayer()`
  - Remove `vi.mock("electron")` from registry tests
  - Verify behavioral mock errors match boundary test assertions
  - Files: `src/main/api/registry.ts`, `src/main/api/registry.test.ts`, `src/main/api/registry.integration.test.ts`
  - Test: All existing registry tests pass with behavioral mock, duplicate handler throws

- [x] **Step 1.5: Wire IpcLayer in bootstrap**
  - Update `bootstrap.ts` to instantiate `DefaultIpcLayer` and pass to `ApiRegistry`
  - Files: `src/main/bootstrap.ts`
  - Test: Application starts correctly

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT:**

- [ ] Application starts without errors
- [ ] Can open a project (IPC handlers work)
- [ ] Can list workspaces (API communication works)

**Rollback point: git commit after Slice 1**

---

### Slice 2: Badge Layers + BadgeManager

**Goal**: Abstract image creation and app badge APIs, migrate BadgeManager.

- [x] **Step 2.1: ImageLayer**
  - Interface: `createFromPath(path)`, `createFromDataURL(dataURL)`, `createEmpty(width, height)`, `getSize(handle)`, `isEmpty(handle)`, `toDataURL(handle)`
  - Returns `ImageHandle` (branded type in platform/types.ts)
  - Implementation: `DefaultImageLayer` wraps `nativeImage`
  - Behavioral mock: `createBehavioralImageLayer()` with in-memory image registry
  - Boundary test: Create from path (use test fixture), create from data URL, verify size
  - Files: `src/services/platform/image.ts`, `src/services/platform/types.ts`, `src/services/platform/image.test-utils.ts`, `src/services/platform/image.boundary.test.ts`, `src/services/platform/image.integration.test.ts`
  - Test: Create image, get size, isEmpty for empty vs non-empty, toDataURL format

- [x] **Step 2.2: AppLayer**
  - Interface: `setBadgeCount(count)`, `getPath(name)`, `dock.setBadge(text)` (macOS), `commandLine.appendSwitch(key, value)`
  - Platform handling: `dock` returns `undefined` on non-macOS, `setBadgeCount` no-ops gracefully on unsupported Linux desktops
  - Implementation: `DefaultAppLayer` wraps `app` (replaces existing `ElectronAppApi`)
  - Behavioral mock: `createBehavioralAppLayer()` with badge state, path map
  - Boundary test: Get paths, command line switches; skip badge tests on CI (visual only)
  - Platform-specific test skipping: `it.skipIf(platform() !== 'darwin')("dock.setBadge", ...)`
  - Files: `src/services/platform/app.ts`, `src/services/platform/app.test-utils.ts`, `src/services/platform/app.boundary.test.ts`, `src/services/platform/app.integration.test.ts`
  - Test: Set badge count, get app paths, dock on macOS only

- [x] **Step 2.3: Migrate BadgeManager to AppLayer + ImageLayer**
  - Update `BadgeManager` constructor to accept `AppLayer`, `ImageLayer`
  - Replace `ElectronAppApi` usage with `AppLayer`
  - Replace `nativeImage` usage with `ImageLayer`
  - Update tests to use behavioral mocks
  - Remove `vi.mock("electron")` from badge tests
  - Delete `src/main/managers/electron-app-api.ts` (replaced by `AppLayer`)
  - Delete `src/main/managers/badge-manager.test-utils.ts` (replaced by layer mocks)
  - Files: `src/main/managers/badge-manager.ts`, `src/main/managers/badge-manager.test.ts`, `src/main/managers/badge-manager.integration.test.ts`
  - Test: All badge manager tests pass with behavioral mocks

- [x] **Step 2.4: Wire ImageLayer + AppLayer in bootstrap**
  - Update `bootstrap.ts` to instantiate layers and pass to `BadgeManager`
  - Files: `src/main/bootstrap.ts`
  - Test: Application starts correctly

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT:**

- [ ] Badge icon updates on workspace status change (macOS dock / Windows taskbar)
- [ ] Red circle when all workspaces working
- [ ] Half green/half red when mixed status
- [ ] No badge when all ready

**Rollback point: git commit after Slice 2**

---

### Slice 3: Dialog Layers + Bootstrap

**Goal**: Abstract dialog and menu APIs, migrate bootstrap error handling and menu setup.

- [x] **Step 3.1: DialogLayer**
  - Interface: `showOpenDialog(options)`, `showSaveDialog(options)`, `showMessageBox(options)`, `showErrorBox(title, content)`
  - Returns `Path` objects for file paths (normalized per AGENTS.md Path Handling)
  - Implementation: `DefaultDialogLayer` wraps `dialog`
  - Behavioral mock: `createBehavioralDialogLayer()` with configurable responses via `_setNextResponse()`
  - Boundary test: Limited - verify doesn't crash with hidden parent window
  - Files: `src/services/platform/dialog.ts`, `src/services/platform/dialog.test-utils.ts`, `src/services/platform/dialog.integration.test.ts`
  - Test: Mock returns configured paths, cancellation returns undefined

- [x] **Step 3.2: MenuLayer**
  - Interface: `setApplicationMenu(menu)`, `getApplicationMenu()`
  - Implementation: `DefaultMenuLayer` wraps `Menu`
  - Behavioral mock: `createBehavioralMenuLayer()` tracks menu state
  - Boundary test: Set null menu (minimal - menu visibility hard to verify)
  - Files: `src/services/platform/menu.ts`, `src/services/platform/menu.test-utils.ts`, `src/services/platform/menu.integration.test.ts`
  - Test: Set menu to null, get returns null

- [x] **Step 3.3: Update platform/index.ts**
  - Add exports for new layers: IpcLayer, ImageLayer, AppLayer, DialogLayer, MenuLayer
  - Add exports for PlatformError
  - Files: `src/services/platform/index.ts`
  - Test: Import from index works

- [x] **Step 3.4: Migrate bootstrap dialogs and menu**
  - Update `bootstrap.ts` to use `DialogLayer` for error dialogs
  - Update `bootstrap.ts` to use `MenuLayer` for menu setup
  - Files: `src/main/bootstrap.ts`
  - Test: Application starts correctly

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT:**

- [ ] Setup flow works for fresh install (dialogs appear correctly)
- [ ] File picker works when opening a project
- [ ] Error dialogs display correctly (simulate an error)

**Rollback point: git commit after Slice 3**

---

### Slice 4: Window Layer + WindowManager

**Goal**: Abstract window management, migrate WindowManager.

- [ ] **Step 4.1: Shell error types**
  - Create `src/services/shell/errors.ts` with `ShellError` class extending `Error`
  - Error codes: `WINDOW_NOT_FOUND`, `WINDOW_DESTROYED`, `VIEW_NOT_FOUND`, `VIEW_DESTROYED`, `SESSION_NOT_FOUND`, `NAVIGATION_FAILED`, `WINDOW_HAS_ATTACHED_VIEWS`
  - Include `handle` property for error context
  - Files: `src/services/shell/errors.ts`, `src/services/shell/errors.test.ts`
  - Test: Error class instantiation, properties preserved, instanceof works

- [ ] **Step 4.2: Shell types**
  - Create `src/services/shell/types.ts` with handle types and common interfaces
  - Types: `WindowHandle`, `ViewHandle`, `SessionHandle` (branded), `Rectangle`, `WebPreferences`
  - Add helper functions: `createWindowHandle()`, `createViewHandle()`, `createSessionHandle()`
  - Files: `src/services/shell/types.ts`, `src/services/shell/types.test.ts`
  - Test: Types compile correctly, branded types prevent mixing

- [ ] **Step 4.3: WindowLayer**
  - Interface: `createWindow(options)`, `destroy(handle)`, `destroyAll()`, `getBounds(handle)`, `setBounds(handle, bounds)`, `setOverlayIcon(handle, image, description)`, `maximize(handle)`, `isMaximized(handle)`, `isDestroyed(handle)`, `onResize(handle, callback)`, `onClose(handle, callback)`, `getContentView(handle)`
  - `setOverlayIcon`: No-op on non-Windows (returns without error)
  - `destroyAll`: Throws `WINDOW_HAS_ATTACHED_VIEWS` if views still attached (caller must detach first)
  - Implementation: `DefaultWindowLayer` wraps `BaseWindow`
  - Dependencies: `ImageLayer` for overlay icons (passed via constructor)
  - Behavioral mock: `createBehavioralWindowLayer()` with window state map
  - Boundary test: Create window (show: false), get/set bounds, resize events
  - Platform-specific: `it.skipIf(platform() !== 'win32')("setOverlayIcon", ...)`
  - Files: `src/services/shell/window.ts`, `src/services/shell/window.test-utils.ts`, `src/services/shell/window.boundary.test.ts`, `src/services/shell/window.integration.test.ts`
  - Test: Create window, set bounds, overlay icon (Windows), resize callback, destroy non-existent throws

- [ ] **Step 4.4: Migrate WindowManager to WindowLayer + ImageLayer**
  - Update `WindowManager` constructor to accept `WindowLayer`, `ImageLayer`
  - Replace `BaseWindow` usage with `WindowLayer` handle pattern
  - Replace `nativeImage` usage with `ImageLayer`
  - Update `getWindow()` to return `WindowHandle` (breaking change)
  - **Special case**: For `ShortcutController` integration during `ViewManager.create()`, expose internal method `_getRawWindow(handle): BaseWindow` for construction-time access only. This is not part of the public interface.
  - Update tests to use behavioral mocks
  - Remove `vi.mock("electron")` from window manager tests
  - Files: `src/main/managers/window-manager.ts`, `src/main/managers/window-manager.test.ts`
  - Test: All window manager tests pass with behavioral mocks

- [ ] **Step 4.5: Wire WindowLayer in bootstrap**
  - Update `bootstrap.ts` to instantiate `WindowLayer` and pass to `WindowManager`
  - Files: `src/main/bootstrap.ts`
  - Test: Application starts correctly

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT:**

- [ ] Application window resizes correctly
- [ ] Window maximizes and restores
- [ ] Overlay icon appears on Windows taskbar (Windows only)
- [ ] Shortcut mode works (Alt+X, keyboard capture)

**Rollback point: git commit after Slice 4**

---

### Slice 5: View Layers + ViewManager

**Goal**: Abstract view and session management, migrate ViewManager (includes IViewManager interface change).

- [ ] **Step 5.1: SessionLayer**
  - Interface: `fromPartition(partition)` returns `SessionHandle`, `clearStorageData(handle)`, `setPermissionRequestHandler(handle, handler)`, `setPermissionCheckHandler(handle, handler)`
  - Implementation: `DefaultSessionLayer` wraps `session`
  - Behavioral mock: `createBehavioralSessionLayer()` with partition map, storage state, `_getState()`
  - Boundary test: Create partition, clear storage, verify cleared
  - Cleanup: `beforeEach`/`afterEach` create fresh sessions and clear them
  - Files: `src/services/shell/session.ts`, `src/services/shell/session.test-utils.ts`, `src/services/shell/session.boundary.test.ts`, `src/services/shell/session.integration.test.ts`
  - Test: Create session, set permissions, clear storage, clear already-cleared is no-op

- [ ] **Step 5.2: ViewLayer**
  - Interface: See Pattern Example above for full interface
  - Implementation: `DefaultViewLayer` wraps `WebContentsView`
  - Dependencies: `SessionLayer` for partition (via options.webPreferences.partition), `WindowLayer` for attachment (via `attachToWindow`)
  - Behavioral mock: `createBehavioralViewLayer()` with view state map, attachment tracking, `_getState()`
  - Boundary test: Create view (hidden window), load URL, verify navigation
  - Error cases: destroy already-destroyed throws, loadURL on destroyed throws
  - Edge cases: attach already-attached is no-op, detach already-detached is no-op
  - Files: `src/services/shell/view.ts`, `src/services/shell/view.test-utils.ts`, `src/services/shell/view.boundary.test.ts`, `src/services/shell/view.integration.test.ts`
  - Test: Create view, load URL, attach/detach, navigation events, error scenarios

- [ ] **Step 5.3: Shell index and exports**
  - Create `src/services/shell/index.ts` re-exporting all layers, types, errors
  - Files: `src/services/shell/index.ts`
  - Test: Import from index works

- [ ] **Step 5.4: Migrate ViewManager to ViewLayer + SessionLayer + WindowLayer**
  - Update `ViewManager` constructor to accept `ViewLayer`, `SessionLayer`, `WindowLayer`
  - Replace `WebContentsView` usage with `ViewLayer` handle pattern
  - Replace `session.fromPartition()` with `SessionLayer`
  - Update internal maps to use handles instead of `WebContentsView`
  - Update `IViewManager` interface to use `ViewHandle` instead of `WebContentsView` (BREAKING - see Approvals Required)
  - **ShortcutController integration**: During `ViewManager.create()`, use `windowLayer._getRawWindow()` to get real BaseWindow for ShortcutController. This is internal construction detail.
  - Update tests to use behavioral mocks
  - Remove `vi.mock("electron")` from view manager tests
  - Files: `src/main/managers/view-manager.ts`, `src/main/managers/view-manager.interface.ts`, `src/main/managers/view-manager.test.ts`
  - Test: All view manager tests pass with behavioral mocks

- [ ] **Step 5.5: Wire ViewLayer + SessionLayer in bootstrap**
  - Update `bootstrap.ts` to wire layers to `ViewManager`
  - Initialization order: IpcLayer → AppLayer → ImageLayer → MenuLayer → DialogLayer → SessionLayer → WindowLayer → ViewLayer
  - Add `dispose()` calls during app shutdown (reverse order)
  - Files: `src/main/bootstrap.ts`
  - Test: Application starts correctly

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT:**

- [ ] Can create a workspace (view loads correctly)
- [ ] Can switch between workspaces (attach/detach works)
- [ ] Workspace deletion clears session storage
- [ ] Create/delete workspace rapidly (no race conditions)
- [ ] Alt+X during workspace loading overlay

**Rollback point: git commit after Slice 5**

---

### Slice 6: Cleanup + Documentation

**Goal**: Remove obsolete mocks, update all documentation, final validation.

- [ ] **Step 6.1: Remove obsolete Electron mocks**
  - Search for remaining `vi.mock("electron")` calls in manager/api tests
  - Replace with behavioral layer mocks
  - Delete any unused mock factories
  - `vi.mock("electron")` should ONLY remain in layer boundary tests
  - Files: Various test files
  - Test: No `vi.mock("electron")` remains in manager/api tests

- [ ] **Step 6.2: Update AGENTS.md**
  - Add to External System Access Rules table:
    | External System | Required Interface | Forbidden Direct Access |
    |-----------------|-------------------|------------------------|
    | Electron Window | `WindowLayer` | `BaseWindow` directly |
    | Electron View | `ViewLayer` | `WebContentsView` directly |
    | Electron Session | `SessionLayer` | `session` directly |
    | Electron IPC | `IpcLayer` | `ipcMain` directly |
    | Electron Dialog | `DialogLayer` | `dialog` directly |
    | Electron Image | `ImageLayer` | `nativeImage` directly |
    | Electron App | `AppLayer` | `app` directly |
    | Electron Menu | `MenuLayer` | `Menu` directly |
  - Update Project Structure to document `src/services/shell/` as established pattern for visual container abstractions
  - Files: `AGENTS.md`

- [ ] **Step 6.3: Update docs/PATTERNS.md**
  - Add "Shell and Platform Layer Patterns" section with:
    - How to inject layers via constructor DI
    - Example of creating a behavioral mock for tests
    - Pattern for layer interface design (handle-based)
    - Error handling pattern (ShellError, PlatformError)
  - Files: `docs/PATTERNS.md`

- [ ] **Step 6.4: Update docs/ARCHITECTURE.md**
  - Add component diagram showing Shell and Platform layers between Main Process Components and Electron APIs
  - Document layer dependency rules
  - Files: `docs/ARCHITECTURE.md`

- [ ] **Step 6.5: Update docs/TESTING.md**
  - Add Shell/Platform layers to boundary interface list
  - Document xvfb setup for Electron boundary tests
  - Document platform-specific test skipping patterns
  - Files: `docs/TESTING.md`

- [ ] **Step 6.6: Final validation**
  - Run full test suite: `npm test`
  - Run boundary tests specifically: `npm run test:boundary`
  - Verify all tests < 50ms (integration) or acceptable time (boundary)
  - Files: None
  - Test: `npm run validate:fix` passes

**🧪 AGENT VERIFICATION: `npm run validate:fix` passes**

**🧪 USER TESTING CHECKPOINT (Full Manual Testing):**

- [ ] Application starts without errors
- [ ] Can open a project
- [ ] Can create a workspace (view loads correctly)
- [ ] Can switch between workspaces (attach/detach works)
- [ ] Workspace deletion clears session storage
- [ ] Badge icon updates correctly (macOS dock / Windows taskbar)
- [ ] Shortcut mode works (Alt+X, keyboard capture)
- [ ] Setup flow works for fresh install
- [ ] No Electron console errors
- [ ] Create/delete workspace rapidly (no race conditions)
- [ ] Alt+X during workspace loading overlay
- [ ] Workspace switch mid-deletion (graceful handling)
- [ ] Badge update with 10+ workspaces

---

## Testing Strategy

### Integration Tests

Test managers with behavioral layer mocks. File naming: `*.integration.test.ts`

| #   | Test Case                             | Entry Point                            | Boundary Mocks          | Behavior Verified                                                                        |
| --- | ------------------------------------- | -------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 1   | View created with correct options     | `ViewManager.createWorkspaceView()`    | ViewLayer, SessionLayer | `viewLayer._getState().views.has(id)`                                                    |
| 2   | View attached on activation           | `ViewManager.setActiveWorkspace()`     | ViewLayer, WindowLayer  | `viewLayer._getState().views.get(id).attachedTo !== null`                                |
| 3   | Session cleared on view destroy       | `ViewManager.destroyWorkspaceView()`   | ViewLayer, SessionLayer | `sessionLayer._getState().partitions.get(name).cleared === true`                         |
| 4   | Badge updated on status change        | `BadgeManager.updateBadge()`           | AppLayer, ImageLayer    | `appLayer._getState().badgeCount === expected`                                           |
| 5   | IPC handler registered                | `ApiRegistry.register()`               | IpcLayer                | `ipcLayer._getState().handlers.has(channel)`                                             |
| 6   | Window resize triggers callback       | `WindowManager.onResize()`             | WindowLayer             | Callback args contain expected bounds: `expect(callbackBounds).toEqual({ x: 100, ... })` |
| 7   | Destroy non-existent view throws      | `ViewManager.destroyWorkspaceView()`   | ViewLayer               | `expect(...).rejects.toThrow(ShellError)`                                                |
| 8   | Duplicate IPC handler throws          | `ApiRegistry.register()`               | IpcLayer                | `expect(...).toThrow(PlatformError)`                                                     |
| 9   | Attach already-attached view is no-op | `ViewManager.setActiveWorkspace()`     | ViewLayer               | No error, state unchanged                                                                |
| 10  | Detach already-detached view is no-op | `ViewManager.setActiveWorkspace(null)` | ViewLayer               | No error, state unchanged                                                                |

**Performance requirement**: All integration tests < 50ms. No artificial delays in mocks.

### Boundary Tests

Test layer implementations against real Electron. File naming: `*.boundary.test.ts`

| #   | Test Case               | Layer        | External System | Behavior Verified               |
| --- | ----------------------- | ------------ | --------------- | ------------------------------- |
| 1   | Handler registered      | IpcLayer     | ipcMain         | Handler in ipcMain internal map |
| 2   | Image created from path | ImageLayer   | nativeImage     | Size matches expected           |
| 3   | Session storage cleared | SessionLayer | session         | Storage empty after clear       |
| 4   | Window bounds updated   | WindowLayer  | BaseWindow      | getBounds returns new values    |
| 5   | View loads URL          | ViewLayer    | WebContentsView | getURL returns loaded URL       |
| 6   | App paths accessible    | AppLayer     | app             | Paths are valid directories     |

**Contract verification**: Behavioral mock error behaviors must match boundary test assertions. If boundary test verifies `loadURL` on destroyed view throws `ShellError("VIEW_DESTROYED")`, mock must throw same error.

**Cleanup requirement**: Each boundary test file must have:

```typescript
beforeEach(() => {
  /* Create fresh resources */
});
afterEach(() => {
  layer.destroyAll(); /* Clean up */
});
```

**Platform skipping**:

```typescript
it.skipIf(platform() !== 'darwin')("dock.setBadge sets badge", ...);
it.skipIf(platform() !== 'win32')("setOverlayIcon sets overlay", ...);
```

### Focused Tests

Test error classes and types. File naming: `*.test.ts`

| #   | Test Case                            | Function              | Input/Output                                |
| --- | ------------------------------------ | --------------------- | ------------------------------------------- |
| 1   | ShellError preserves code and handle | `new ShellError()`    | code, handle → error with properties        |
| 2   | PlatformError preserves code         | `new PlatformError()` | code, message → error with properties       |
| 3   | Handles with same ID are equal       | Handle comparison     | same id → equal                             |
| 4   | Branded handles prevent mixing       | Type check            | ViewHandle !== WindowHandle at compile time |

### Manual Testing Checklist

- [ ] Application starts without errors
- [ ] Can open a project
- [ ] Can create a workspace (view loads correctly)
- [ ] Can switch between workspaces (attach/detach works)
- [ ] Workspace deletion clears session storage
- [ ] Badge icon updates correctly (macOS dock / Windows taskbar)
- [ ] Shortcut mode works (Alt+X, keyboard capture)
- [ ] Setup flow works for fresh install
- [ ] No Electron console errors
- [ ] Create/delete workspace rapidly (no race conditions)
- [ ] Alt+X during workspace loading overlay
- [ ] Workspace switch mid-deletion (graceful handling)
- [ ] Badge update with 10+ workspaces

## Dependencies

| Package | Purpose                                     | Location             | Approved |
| ------- | ------------------------------------------- | -------------------- | -------- |
| xvfb    | Virtual display for Linux CI boundary tests | optionalDependencies | [ ]      |

**Note:** `xvfb` is added to `optionalDependencies` (not devDependencies). It only installs on Linux. Import is wrapped in try-catch to handle missing package gracefully on Windows/macOS.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Add 8 rows to External System Access Rules table (WindowLayer, ViewLayer, SessionLayer, IpcLayer, DialogLayer, ImageLayer, AppLayer, MenuLayer). Update Project Structure to document `src/services/shell/` pattern. |
| `docs/PATTERNS.md`     | Add "Shell and Platform Layer Patterns" section: constructor DI injection, behavioral mock creation, handle-based interface design, ShellError/PlatformError usage, layer disposal.                                  |
| `docs/ARCHITECTURE.md` | Add component diagram showing Shell (Window, View, Session) and Platform (IPC, Dialog, Image, App, Menu) layers between Main Process and Electron APIs. Document layer dependency rules.                             |
| `docs/TESTING.md`      | Add Shell/Platform layers to boundary interface list. Document xvfb setup for Electron tests. Document platform-specific test skipping patterns (`it.skipIf`).                                                       |

### New Documentation Required

| File | Purpose                       |
| ---- | ----------------------------- |
| None | All updates to existing files |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] All boundary tests pass (including on CI with xvfb)
- [ ] All integration tests pass with behavioral mocks
- [ ] All integration tests < 50ms
- [ ] No `vi.mock("electron")` in manager/api tests (only in layer boundary tests)
- [ ] Behavioral mock errors match boundary test assertions
- [ ] Documentation updated (AGENTS.md, PATTERNS.md, ARCHITECTURE.md, TESTING.md)
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
