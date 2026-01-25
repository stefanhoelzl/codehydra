---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-25
reviewers: []
---

# AUTO_UPDATE

## Overview

- **Problem**: CodeHydra has no auto-update mechanism. Users must manually download new releases from GitHub.

- **Solution**: Integrate `electron-updater` with minimal wrapping:
  - Single `AutoUpdater` class wrapping electron-updater directly
  - Check once per day, download in background
  - Title bar shows when update is ready
  - Update applies automatically on next app quit (electron-updater default behavior)

- **Risks**:
  | Risk | Mitigation |
  |------|------------|
  | Update fails mid-download | electron-updater handles resume |
  | Code signing issues | Test on all platforms; document in RELEASE.md |
  | electron-updater errors | Log errors, don't crash - updates are non-critical |

- **Alternatives Considered**:
  - **Full abstraction (UpdaterLayer + UpdaterService)**: Over-engineered for simple feature; electron-updater is a singleton with Electron-specific lifecycle integration that cannot be meaningfully abstracted
  - **IPC-based with renderer UI**: Unnecessary; title bar is sufficient

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Main Process                                   │
│                                                                          │
│  src/main/index.ts                                                       │
│    startServices()                                                       │
│      └─► creates AutoUpdater(configService, logger)                      │
│      └─► autoUpdater.start()                                             │
│      └─► autoUpdater.onUpdateAvailable(version =>                        │
│              windowManager.setUpdateTitle(version))                      │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ AutoUpdater (src/services/auto-updater.ts)                          │ │
│  │                                                                     │ │
│  │ constructor(configService, logger, isPackaged)                      │ │
│  │ start(): void         - check if 24h passed, then check for updates │ │
│  │ onUpdateAvailable(cb) - callback when update downloaded             │ │
│  │ dispose(): void       - cleanup event listeners                     │ │
│  │                                                                     │ │
│  │ Behavior:                                                           │ │
│  │ - No-op if !isPackaged (dev mode) or unsupported platform           │ │
│  │ - Waits 10s after start() before first check (avoid startup I/O)    │ │
│  │ - Listens for 'error' event, logs without crashing                  │ │
│  │ - Uses logger named "updater"                                       │ │
│  │                                                                     │ │
│  │ Uses electron-updater's autoUpdater directly:                       │ │
│  │ - autoUpdater.checkForUpdates()                                     │ │
│  │ - autoUpdater.on('update-downloaded', ...)                          │ │
│  │ - autoUpdater.on('error', ...)                                      │ │
│  │ - autoUpdater.autoInstallOnAppQuit = true (default)                 │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Update Flow

```
App Start
    │
    ▼
autoUpdater.start()
    │
    ├─► isPackaged? ──NO──► Done (dev mode, skip)
    │         │
    │        YES
    │         │
    ├─► Supported platform? ──NO──► Done (portable/deb/rpm, skip)
    │         │
    │        YES
    │         │
    ├─► Wait 10 seconds (avoid competing with startup)
    │         │
    │         ▼
    │    Read lastUpdateCheck from config
    │         │
    │         ▼
    │    24h since last check? ──NO──► Done
    │         │
    │        YES
    │         │
    │         ▼
    │    autoUpdater.checkForUpdates()
    │    Save lastUpdateCheck to config via configService.save()
    │         │
    │         ▼
    │    electron-updater downloads in background (if update available)
    │         │
    │         ▼
    │    'update-downloaded' event fires
    │         │
    │         ▼
    │    Call onUpdateAvailable callbacks
    │    WindowManager updates title via setUpdateTitle(version)
    │
    └──────────────────────────────────────────────────────────┐
                                                               │
                        User quits app ◄───────────────────────┘
                              │
                              ▼
                    electron-updater auto-applies update
                    (autoInstallOnAppQuit = true by default)
                              │
                              ▼
                    App relaunches with new version
```

### Platform Support

| Platform           | Behavior                           |
| ------------------ | ---------------------------------- |
| Windows (NSIS)     | Full auto-update                   |
| macOS (DMG)        | Full auto-update                   |
| Linux (AppImage)   | Full auto-update                   |
| Windows (portable) | Not supported - `start()` is no-op |
| Linux (.deb/.rpm)  | Not supported - `start()` is no-op |

### Title Bar Integration

`WindowManager.setUpdateTitle(version)` stores the update version and integrates with existing title logic:

- Current format: `"CodeHydra - Project/Workspace"`
- With update: `"CodeHydra - Project/Workspace - (1.2.3 update available)"`
- The update suffix persists across workspace switches
- Call `setUpdateTitle(null)` to clear (not needed for this feature, but available)

## Testing Strategy

### Manual Testing Only

This feature directly uses electron-updater (a singleton with Electron-specific lifecycle integration) and requires packaged builds to test. The business logic is minimal (24h check, callback invocation) and doesn't justify the complexity of mocking electron-updater's global state.

**Why no abstraction layer**: electron-updater is a singleton module that directly hooks into Electron's `app` lifecycle events. Creating an abstraction would provide no testing benefit since there's only one real implementation, and the mock would need to simulate the same global singleton behavior.

### Manual Testing Checklist

- [ ] Build and publish test release v0.0.1 to GitHub
- [ ] Install v0.0.1
- [ ] Build and publish test release v0.0.2
- [ ] Launch app, verify logs show update check (logger: "updater")
- [ ] Wait for download, verify title bar shows "- (0.0.2 update available)"
- [ ] Quit app
- [ ] Verify app relaunches with v0.0.2
- [ ] Verify lastUpdateCheck is persisted (no re-check within 24h)
- [ ] Verify dev mode (`pnpm dev`) does not attempt update check
- [ ] Test on Windows (NSIS)
- [ ] Test on macOS (DMG)
- [ ] Test on Linux (AppImage)

## Implementation Steps

- [x] **Step 1: Add electron-updater dependency**
  - Run `pnpm add electron-updater`
  - Files: `package.json`

- [x] **Step 2: Add lastUpdateCheck to config**
  - Add `lastUpdateCheck?: string` (ISO timestamp) to `AppConfig` type at root level
  - Files: `src/services/config/types.ts`

- [x] **Step 3: Create AutoUpdater class**
  - Single class wrapping electron-updater
  - Constructor: `(configService: ConfigService, logger: Logger, isPackaged: boolean)`
  - Methods: `start()`, `onUpdateAvailable(cb)`, `dispose()`
  - Use logger name `"updater"` via `loggingService.createLogger("updater")`
  - Early return in `start()` if `!isPackaged` or unsupported platform
  - Wait 10s before first check to avoid startup I/O contention
  - Check 24h interval: read config via `configService.load()`, compare timestamps
  - Save timestamp: merge into config via `configService.save({ ...config, lastUpdateCheck: new Date().toISOString() })`
  - Listen for `error` event: log error, do not throw or crash
  - Listen for `update-downloaded` event: invoke registered callbacks with version
  - `dispose()`: remove all event listeners from autoUpdater
  - Files: `src/services/auto-updater.ts` (new)

- [x] **Step 4: Add WindowManager.setUpdateTitle()**
  - Store update version in WindowManager state
  - Modify existing title formatting to append " - (version update available)" when version is set
  - Integrate with workspace switch logic so suffix persists
  - Files: `src/main/managers/window-manager.ts`

- [x] **Step 5: Integrate in startServices()**
  - Create AutoUpdater: `new AutoUpdater(configService, logger, app.isPackaged)`
  - Call `autoUpdater.start()`
  - Wire: `autoUpdater.onUpdateAvailable(v => windowManager.setUpdateTitle(v))`
  - Add `autoUpdater.dispose()` to cleanup sequence
  - Files: `src/main/index.ts`

- [x] **Step 6: Configure electron-builder**
  - Replace `publish: null` with GitHub provider config
  - Use values from existing repo (stefanhoelzl/codehydra or configured origin)
  - Files: `electron-builder.yaml`

  ```yaml
  publish:
    provider: github
    owner: stefanhoelzl
    repo: codehydra
  ```

- [x] **Step 7: Update documentation**
  - **CLAUDE.md**: Add "Documented Exceptions" section explaining AutoUpdater uses electron-updater directly because it's a singleton with Electron lifecycle integration that cannot be meaningfully abstracted or tested in isolation
  - **ARCHITECTURE.md**: Add to App Services table: `| AutoUpdater | Check for updates daily, apply on quit (electron-updater) | Implemented |`
  - **RELEASE.md**: Add "Auto-Update Requirements" section:
    - Asset naming: electron-builder auto-generates correct names
    - Metadata files: `latest.yml`, `latest-mac.yml`, `latest-linux.yml` auto-generated
    - Releases must be published (not draft) for auto-update to detect them
    - Code signing: Required for macOS (Gatekeeper), recommended for Windows
  - **USER_INTERFACE.md**: Update title bar format to include update suffix
  - Files: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/RELEASE.md`, `docs/USER_INTERFACE.md`

- [ ] **Step 8: Manual testing**
  - Follow Manual Testing Checklist
  - Test on all three platforms

## Dependencies

| Package          | Purpose                       | Approved |
| ---------------- | ----------------------------- | -------- |
| electron-updater | Auto-update for Electron apps | [x]      |

## Documentation Updates

| File                     | Changes                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`              | Add "Documented Exceptions" section: AutoUpdater uses electron-updater directly (singleton with Electron lifecycle, no abstraction benefit) |
| `docs/ARCHITECTURE.md`   | Add to App Services table: `AutoUpdater - Check for updates daily, apply on quit`                                                           |
| `docs/RELEASE.md`        | Add "Auto-Update Requirements" section: asset naming, metadata files, draft vs published, code signing                                      |
| `docs/USER_INTERFACE.md` | Update title bar format: `"CodeHydra - Project/Workspace - (version update available)"`                                                     |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Manual testing on Windows, macOS, Linux passes
- [ ] Documentation updated
- [ ] Merged to main
