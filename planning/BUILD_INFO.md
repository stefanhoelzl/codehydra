---
status: COMPLETED
last_updated: 2025-01-10
reviewers: []
---

# BUILD_INFO

## Overview

- **Problem**: Build mode detection (`NODE_ENV`, `app.isPackaged`) is scattered across the codebase with direct `process.env` access, making it hard to test and inconsistent between services and Electron main process.
- **Solution**: Create `BuildInfo`, `PlatformInfo`, and `PathProvider` interfaces in services with injectable implementations. Electron main provides `ElectronBuildInfo` and `NodePlatformInfo`, services provide `DefaultPathProvider` that uses injected dependencies.
- **Risks**:
  - Signature changes across many files (mitigated by doing it in one PR)
  - Breaking existing tests (mitigated by TDD approach)
- **Alternatives Considered**:
  - Pass `buildInfo` to each path function - rejected due to signature explosion
  - Global singleton - rejected due to poor testability
  - Keep current approach - rejected due to inconsistent dev detection methods
  - Use Electron's `app.getPath('userData')` - rejected to keep services layer pure (no Electron deps)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           src/main/                                     │
│                                                                         │
│  // MODULE LEVEL (before app.whenReady)                                 │
│  ┌──────────────────┐  ┌──────────────────┐                             │
│  │ ElectronBuildInfo│  │ NodePlatformInfo │                             │
│  │  isDevelopment   │  │  platform        │                             │
│  │ (app.isPackaged) │  │  homeDir         │                             │
│  └────────┬─────────┘  └────────┬─────────┘                             │
│           │                     │                                       │
│           └──────────┬──────────┘                                       │
│                      │                                                  │
│                      ▼                                                  │
│           ┌─────────────────────┐                                       │
│           │ DefaultPathProvider │  created at module level              │
│           └──────────┬──────────┘                                       │
│                      │                                                  │
│                      ▼                                                  │
│           redirectElectronDataPaths(pathProvider)  // uses electronDir  │
│                      │                                                  │
│                      ▼                                                  │
│           app.whenReady() → bootstrap()                                 │
│                      │                                                  │
│                      ▼                                                  │
│           Services receive pathProvider via DI                          │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              │ pathProvider instance
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         src/services/                                   │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────────┐    │
│  │ BuildInfo        │  │ PlatformInfo     │  │ PathProvider        │    │
│  │ (interface)      │  │ (interface)      │  │ (interface)         │    │
│  │  isDevelopment   │  │  platform        │  │  dataRootDir        │    │
│  └──────────────────┘  │  homeDir         │  │  projectsDir        │    │
│                        └──────────────────┘  │  vscodeDir          │    │
│                                              │  ...                │    │
│                                              └──────────┬──────────┘    │
│                                                         │               │
│                                                         │ implemented   │
│                                                         ▼               │
│                                              ┌─────────────────────┐    │
│                                              │ DefaultPathProvider │    │
│                                              │ constructor(        │    │
│                                              │   buildInfo,        │    │
│                                              │   platformInfo      │    │
│                                              │ )                   │    │
│                                              └─────────────────────┘    │
│                                                                         │
│  Services receive PathProvider via constructor DI:                      │
│  - VscodeSetupService(processRunner, pathProvider, codeServerBin)       │
│  - ProjectStore(pathProvider.projectsDir)                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
// MODULE LEVEL - BEFORE app.whenReady()
const buildInfo = new ElectronBuildInfo()           // uses app.isPackaged
const platformInfo = new NodePlatformInfo()         // uses process.platform, os.homedir()
const pathProvider = new DefaultPathProvider(buildInfo, platformInfo)

redirectElectronDataPaths(pathProvider)             // uses pathProvider.electronDataDir
       │
       ▼
app.whenReady()
       │
       ▼
bootstrap(pathProvider, buildInfo)
       │
       ├─► processRunner = new ExecaProcessRunner()
       │
       ├─► vscodeSetupService = new VscodeSetupService(
       │       processRunner, pathProvider, "code-server"
       │   )
       │
       ├─► // DevTools conditional (line ~447 in bootstrap)
       │   if (buildInfo.isDevelopment) {
       │     uiView.webContents.on("before-input-event", ...)
       │   }
       │
       └─► startServices(pathProvider)
                  │
                  ├─► const config = {
                  │     runtimeDir: join(pathProvider.dataRootDir, "runtime"),
                  │     extensionsDir: pathProvider.vscodeExtensionsDir,
                  │     userDataDir: pathProvider.vscodeUserDataDir,
                  │   }
                  │
                  ├─► codeServerManager = new CodeServerManager(config, processRunner)
                  │
                  └─► projectStore = new ProjectStore(pathProvider.projectsDir)
```

## Implementation Steps

Steps 1-5 create new code (no existing code changes). Steps 6-10 migrate existing code. Step 11 deletes old code.

**TDD Approach**: Each step writes failing tests FIRST, then implements to make tests pass.

- [x] **Step 1: Create BuildInfo interface and test utilities**
  - Create `src/services/platform/build-info.ts` with `BuildInfo` interface
  - Create `src/services/platform/build-info.test-utils.ts` with `createMockBuildInfo()` factory
  - Create `src/services/platform/build-info.test.ts` (tests for mock factory)
  - TDD: Write tests first, then implement mock factory
  - Files: `build-info.ts`, `build-info.test-utils.ts`, `build-info.test.ts`
  - Test criteria:
    - `createMockBuildInfo()` returns `{ isDevelopment: true }` by default
    - `createMockBuildInfo({ isDevelopment: false })` overrides correctly
    - Returned object satisfies `BuildInfo` interface

- [x] **Step 2: Create PlatformInfo interface and test utilities**
  - Create `src/services/platform/platform-info.ts` with `PlatformInfo` interface
  - Create `src/services/platform/platform-info.test-utils.ts` with `createMockPlatformInfo()` factory
  - Create `src/services/platform/platform-info.test.ts` (tests for mock factory)
  - TDD: Write tests first, then implement mock factory
  - Files: `platform-info.ts`, `platform-info.test-utils.ts`, `platform-info.test.ts`
  - Test criteria:
    - `createMockPlatformInfo()` returns sensible defaults (`platform: 'linux'`, `homeDir: '/home/test'`)
    - Overrides work for `platform` and `homeDir`
    - Returned object satisfies `PlatformInfo` interface

- [x] **Step 3: Create PathProvider interface and test utilities**
  - Create `src/services/platform/path-provider.ts` with `PathProvider` interface
  - Create `src/services/platform/path-provider.test-utils.ts` with `createMockPathProvider()` factory
  - Create `src/services/platform/path-provider.test.ts` (tests for mock factory)
  - TDD: Write tests first, then implement mock factory
  - Files: `path-provider.ts`, `path-provider.test-utils.ts`, `path-provider.test.ts`
  - Test criteria:
    - `createMockPathProvider()` returns sensible default paths
    - All path properties can be overridden
    - `getProjectWorkspacesDir()` method works with overrides
    - Returned object satisfies `PathProvider` interface

- [x] **Step 4: Create DefaultPathProvider implementation**
  - Implement `DefaultPathProvider` class in `src/services/platform/path-provider.ts`
  - Constructor takes `BuildInfo` and `PlatformInfo` instances
  - Add tests to `path-provider.test.ts` for DefaultPathProvider
  - TDD: Write failing tests first, then implement
  - Files: `path-provider.ts`, `path-provider.test.ts`
  - Test criteria (using mock BuildInfo and PlatformInfo):
    - Dev mode (`isDevelopment: true`): returns `./app-data/` based paths
    - Prod mode Linux (`isDevelopment: false`, `platform: 'linux'`): returns `~/.local/share/codehydra/`
    - Prod mode macOS (`platform: 'darwin'`): returns `~/Library/Application Support/Codehydra/`
    - Prod mode Windows (`platform: 'win32'`): returns `<homeDir>/AppData/Roaming/Codehydra/`
    - All derived paths (`projectsDir`, `vscodeDir`, etc.) are correct
    - `getProjectWorkspacesDir(projectPath)` validates absolute path, returns correct structure

- [x] **Step 5: Create Electron implementations**
  - Create `src/main/build-info.ts` with `ElectronBuildInfo` class
  - Create `src/main/platform-info.ts` with `NodePlatformInfo` class
  - Create `src/main/build-info.test.ts` and `src/main/platform-info.test.ts`
  - TDD: Write failing tests first, then implement
  - Files: `src/main/build-info.ts`, `src/main/platform-info.ts`, `src/main/build-info.test.ts`, `src/main/platform-info.test.ts`
  - Test criteria:
    - `ElectronBuildInfo.isDevelopment` returns `!app.isPackaged` (mock Electron's `app`)
    - `NodePlatformInfo.platform` returns `process.platform`
    - `NodePlatformInfo.homeDir` returns `os.homedir()`

- [x] **Step 6: Update services/index.ts exports**
  - Export `BuildInfo` type and `createMockBuildInfo`
  - Export `PlatformInfo` type and `createMockPlatformInfo`
  - Export `PathProvider` type, `DefaultPathProvider` class, and `createMockPathProvider`
  - Files: `src/services/index.ts`
  - Test criteria: All exports accessible via `import { ... } from '../services'`

- [x] **Step 7: Update VscodeSetupService to use PathProvider**
  - TDD: Update tests first to inject mock `PathProvider`, verify they fail
  - Add `pathProvider: PathProvider` parameter to constructor
  - Replace all direct path function calls:
    - `getVscodeDir()` → `pathProvider.vscodeDir`
    - `getDataRootDir()` → `pathProvider.dataRootDir`
    - `getVscodeExtensionsDir()` → `pathProvider.vscodeExtensionsDir`
    - `getVscodeUserDataDir()` → `pathProvider.vscodeUserDataDir`
    - `getVscodeSetupMarkerPath()` → `pathProvider.vscodeSetupMarkerPath`
  - Remove imports from `../platform/paths`
  - Files: `vscode-setup-service.ts`, `vscode-setup-service.test.ts`, `vscode-setup-service.integration.test.ts`
  - Test criteria: All existing tests pass with mock PathProvider injection

- [x] **Step 8: Wire up module-level instances in main/index.ts**
  - Create `ElectronBuildInfo`, `NodePlatformInfo`, `DefaultPathProvider` at **module level** (before `redirectElectronDataPaths()`)
  - Update `redirectElectronDataPaths()` to use `pathProvider.electronDataDir`
  - Pass `pathProvider` and `buildInfo` to `bootstrap()` function signature
  - Files: `src/main/index.ts`
  - Test criteria: App starts, `redirectElectronDataPaths` uses correct path

- [x] **Step 9: Update bootstrap() and startServices() to use PathProvider**
  - Update `createCodeServerConfig()` to use `pathProvider`:
    - `runtimeDir: join(pathProvider.dataRootDir, "runtime")`
    - `extensionsDir: pathProvider.vscodeExtensionsDir`
    - `userDataDir: pathProvider.vscodeUserDataDir`
  - Update `VscodeSetupService` instantiation to pass `pathProvider`
  - Update `ProjectStore` instantiation to use `pathProvider.projectsDir`
  - Replace `!app.isPackaged` with `buildInfo.isDevelopment` for DevTools (in bootstrap, around line 447, the `before-input-event` handler registration)
  - Files: `src/main/index.ts`
  - Test criteria: App starts correctly, all services receive correct paths

- [x] **Step 10: Create main process integration tests**
  - Create `src/main/index.test.ts` with integration tests
  - TDD: Write tests, verify they work with the new wiring
  - Files: `src/main/index.test.ts`
  - Test criteria:
    - `createCodeServerConfig()` returns paths from pathProvider
    - DevTools registration controlled by `buildInfo.isDevelopment`
    - Full wiring chain works (BuildInfo → PlatformInfo → PathProvider → services)

- [x] **Step 11: Delete old path functions and tests**
  - Delete from `src/services/platform/paths.ts`:
    - `getDataRootDir()`
    - `getDataProjectsDir()`
    - `getVscodeDir()`
    - `getVscodeExtensionsDir()`
    - `getVscodeUserDataDir()`
    - `getVscodeSetupMarkerPath()`
    - `getElectronDataDir()`
    - `getProjectWorkspacesDir()`
  - Keep utility functions (no build-mode dependency):
    - `projectDirName()`
    - `sanitizeWorkspaceName()`
    - `unsanitizeWorkspaceName()`
    - `encodePathForUrl()`
  - Delete corresponding tests from `paths.test.ts`
  - Update `src/services/index.ts` to remove deleted exports
  - Files: `paths.ts`, `paths.test.ts`, `src/services/index.ts`
  - Test criteria: No `process.env.NODE_ENV` references remain in paths.ts/paths.test.ts

- [x] **Step 12: Update documentation**
  - Update `docs/ARCHITECTURE.md`: Add "Build Mode and Path Abstraction" section under "App Services"
  - Update `AGENTS.md`: Update "Service Dependency Injection Pattern" with BuildInfo/PathProvider example
  - Files: `docs/ARCHITECTURE.md`, `AGENTS.md`
  - Test criteria: Documentation accurately describes the new pattern

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                     | Description                                        | File                             |
| --------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| `createMockBuildInfo defaults`                | Returns `isDevelopment: true` by default           | `build-info.test.ts`             |
| `createMockBuildInfo overrides`               | Accepts overrides for all properties               | `build-info.test.ts`             |
| `createMockPlatformInfo defaults`             | Returns sensible platform defaults                 | `platform-info.test.ts`          |
| `createMockPlatformInfo overrides`            | Accepts overrides for platform/homeDir             | `platform-info.test.ts`          |
| `createMockPathProvider defaults`             | Returns sensible default paths                     | `path-provider.test.ts`          |
| `createMockPathProvider overrides`            | Accepts overrides for all paths                    | `path-provider.test.ts`          |
| `DefaultPathProvider dev mode`                | Returns `./app-data/` based paths                  | `path-provider.test.ts`          |
| `DefaultPathProvider prod linux`              | Returns `~/.local/share/codehydra/`                | `path-provider.test.ts`          |
| `DefaultPathProvider prod darwin`             | Returns `~/Library/Application Support/Codehydra/` | `path-provider.test.ts`          |
| `DefaultPathProvider prod win32`              | Returns `<home>/AppData/Roaming/Codehydra/`        | `path-provider.test.ts`          |
| `DefaultPathProvider.getProjectWorkspacesDir` | Validates absolute path, returns correct structure | `path-provider.test.ts`          |
| `ElectronBuildInfo.isDevelopment`             | Returns `!app.isPackaged`                          | `src/main/build-info.test.ts`    |
| `NodePlatformInfo.platform`                   | Returns `process.platform`                         | `src/main/platform-info.test.ts` |
| `NodePlatformInfo.homeDir`                    | Returns `os.homedir()`                             | `src/main/platform-info.test.ts` |
| `VscodeSetupService with PathProvider`        | Uses injected paths correctly                      | `vscode-setup-service.test.ts`   |

### Integration Tests

| Test Case                                  | Description                                  | File                                       |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| `VscodeSetupService setup flow`            | Full setup with mock PathProvider            | `vscode-setup-service.integration.test.ts` |
| `createCodeServerConfig uses pathProvider` | Config paths match pathProvider              | `src/main/index.test.ts`                   |
| `DevTools controlled by buildInfo`         | isDevelopment controls DevTools registration | `src/main/index.test.ts`                   |

### Manual Testing Checklist

- [ ] `npm run dev` starts app with DevTools shortcut working (Ctrl+Shift+I)
- [ ] App creates files in `./app-data/` directory in dev mode
- [ ] All tests pass: `npm test`
- [ ] No TypeScript errors: `npm run check`
- [ ] No lint errors: `npm run lint`

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                          |
| ---------------------- | ------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add "Build Mode and Path Abstraction" section (see content below)         |
| `AGENTS.md`            | Update "Service Dependency Injection Pattern" section (see content below) |

### ARCHITECTURE.md Content

Add under "App Services" section:

```markdown
### Build Mode and Path Abstraction

The application uses dependency injection to abstract build mode detection and path resolution, enabling testability and separation between Electron main process and pure Node.js services.

**Interfaces (defined in `src/services/platform/`):**

| Interface      | Purpose                                    |
| -------------- | ------------------------------------------ |
| `BuildInfo`    | Build mode detection (`isDevelopment`)     |
| `PlatformInfo` | Platform detection (`platform`, `homeDir`) |
| `PathProvider` | Application path resolution                |

**Implementations:**

| Class                 | Location        | Description                                  |
| --------------------- | --------------- | -------------------------------------------- |
| `ElectronBuildInfo`   | `src/main/`     | Uses `app.isPackaged`                        |
| `NodePlatformInfo`    | `src/main/`     | Uses `process.platform`, `os.homedir()`      |
| `DefaultPathProvider` | `src/services/` | Computes paths from BuildInfo + PlatformInfo |

**Instantiation Order (in `src/main/index.ts`):**

1. Module level (before `app.whenReady()`):
   - Create `ElectronBuildInfo`, `NodePlatformInfo`, `DefaultPathProvider`
   - Call `redirectElectronDataPaths(pathProvider)` - requires paths early
2. In `bootstrap()`:
   - Pass `pathProvider` to services via constructor DI
```

### AGENTS.md Content

Update "Service Dependency Injection Pattern" section to include:

````markdown
**BuildInfo/PathProvider Pattern:**

```typescript
// Main process creates implementations at module level
const buildInfo = new ElectronBuildInfo();
const platformInfo = new NodePlatformInfo();
const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

// Services receive PathProvider via constructor
const vscodeSetupService = new VscodeSetupService(processRunner, pathProvider, "code-server");

// Tests use mock factories
const mockPathProvider = createMockPathProvider({
  vscodeDir: "/test/vscode",
});
const service = new VscodeSetupService(mockRunner, mockPathProvider, "code-server");
```
````

````

## API Reference

### BuildInfo Interface

```typescript
/**
 * Build/environment information provider.
 * Interface defined in services, implementation provided by main process.
 */
export interface BuildInfo {
  /**
   * Whether the app is running in development mode.
   * - true: Development (unpackaged, via electron-vite dev)
   * - false: Production (packaged .app/.exe/.AppImage)
   */
  readonly isDevelopment: boolean;
}
````

### PlatformInfo Interface

```typescript
/**
 * Platform information provider.
 * Abstracts process.platform and os.homedir() for testability.
 */
export interface PlatformInfo {
  /** Operating system platform: 'linux', 'darwin', 'win32' */
  readonly platform: NodeJS.Platform;

  /** User's home directory */
  readonly homeDir: string;
}
```

### PathProvider Interface

```typescript
/**
 * Application path provider.
 * Abstracts platform-specific and build-mode-specific paths.
 */
export interface PathProvider {
  /** Root directory for all application data */
  readonly dataRootDir: string;

  /** Directory for project data: `<dataRoot>/projects/` */
  readonly projectsDir: string;

  /** Directory for VS Code config: `<dataRoot>/vscode/` */
  readonly vscodeDir: string;

  /** Directory for VS Code extensions: `<dataRoot>/vscode/extensions/` */
  readonly vscodeExtensionsDir: string;

  /** Directory for VS Code user data: `<dataRoot>/vscode/user-data/` */
  readonly vscodeUserDataDir: string;

  /** Path to VS Code setup marker: `<dataRoot>/vscode/.setup-completed` */
  readonly vscodeSetupMarkerPath: string;

  /** Directory for Electron data: `<dataRoot>/electron/` */
  readonly electronDataDir: string;

  /**
   * Get the workspaces directory for a project.
   * @param projectPath Absolute path to the project
   * @returns `<projectsDir>/<name>-<hash>/workspaces/`
   * @throws TypeError if projectPath is not an absolute path
   */
  getProjectWorkspacesDir(projectPath: string): string;
}
```

### Utility Functions (remain in paths.ts)

These functions are pure utilities and don't depend on build mode:

```typescript
// Keep as-is (no changes needed)
export function projectDirName(projectPath: string): string;
export function sanitizeWorkspaceName(name: string): string;
export function unsanitizeWorkspaceName(sanitized: string): string;
export function encodePathForUrl(path: string): string;
```

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
