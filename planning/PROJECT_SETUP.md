---
status: IMPLEMENTING
last_updated: 2025-12-06
reviewers: [review-typescript, review-electron, review-arch, review-docs]
---

# PROJECT_SETUP

## Overview

- **Problem**: CodeHydra needs a properly configured Electron + Svelte 5 + TypeScript project foundation before any feature development can begin.
- **Solution**: Initialize git repository, set up project with electron-vite, strict TypeScript, ESLint (warnings as errors), Prettier, and Vitest. Create minimal Electron shell with BaseWindow + WebContentsView.
- **Risks**:
  - electron-vite configuration complexity with Svelte 5 (mitigated by following official docs)
  - TypeScript strict mode may require careful type definitions (acceptable trade-off for type safety)
- **Alternatives Considered**:
  - Manual Vite setup: Rejected - electron-vite handles main/preload/renderer builds elegantly
  - SvelteKit: Rejected - overkill for Electron app, adds unnecessary complexity

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Build System                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    electron-vite                             ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  ││
│  │  │ Main Build  │  │Preload Build│  │  Renderer Build     │  ││
│  │  │ (Node.js)   │  │ (Isolated)  │  │  (Svelte + Browser) │  ││
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Source Structure                            │
│                                                                  │
│  src/                                                            │
│  ├── main/              # Electron main process                  │
│  │   └── index.ts       # App entry, BaseWindow + WebContentsView│
│  ├── preload/           # Preload scripts (context bridge)       │
│  │   └── index.ts       # UI layer preload (webview-preload.ts   │
│  │                      # will be added in Phase 3)              │
│  ├── renderer/          # Svelte frontend                        │
│  │   ├── index.html     # HTML entry point                       │
│  │   ├── main.ts        # Svelte mount point                     │
│  │   ├── App.svelte     # Root component                         │
│  │   ├── vite-env.d.ts  # Vite/Svelte type references            │
│  │   └── lib/           # Shared code                            │
│  │       ├── components/# Svelte components (Phase 4)            │
│  │       ├── stores/    # Svelte stores (Phase 4)                │
│  │       └── api/       # IPC wrapper (Phase 3-4)                │
│  ├── services/          # Pure Node.js services (Phase 2)        │
│  ├── shared/            # Types shared across processes          │
│  │   ├── electron-api.d.ts # Window.electronAPI type definitions │
│  │   └── ipc.ts         # IPC contract types (placeholder)       │
│  └── test/              # Test utilities                         │
│      └── setup.ts       # Vitest setup                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Output Structure                            │
│                                                                  │
│  out/                                                            │
│  ├── main/              # Compiled main process                  │
│  ├── preload/           # Compiled preload scripts               │
│  └── renderer/          # Compiled Svelte app                    │
└─────────────────────────────────────────────────────────────────┘
```

## UI Design

```
┌─────────────────────────────────────────────────────────────────┐
│  CodeHydra                                               [─][□][×]│
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                                                                  │
│                                                                  │
│                    CodeHydra - Phase 1 Complete                  │
│                                                                  │
│                                                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Minimal placeholder UI - just proves the Electron + Svelte pipeline works.

## Implementation Steps

- [x] **Step 1: Initialize git repository**
  - Verify git repo exists (already initialized on main branch)
  - Update `.gitignore` with Electron and electron-vite specific entries:
    - Verify: `out/` exists (already in .gitignore)
    - Add: `.vite/` (Vite cache)
  - Files: `.gitignore`
  - Test: `git status` works, `.gitignore` contains required patterns

- [x] **Step 2: Create package.json**
  - Initialize with `pnpm init`
  - Configure as ES module (`"type": "module"`)
  - Add project metadata:
    - `"name": "codehydra"`
    - `"version": "0.1.0"`
    - `"description": "Multi-workspace IDE for parallel AI agent development"`
  - Set Electron entry point: `"main": "out/main/index.js"`
  - Add minimum engine requirements:
    ```json
    "engines": {
      "node": ">=18.0.0"
    }
    ```
  - Add npm scripts:
    | Script | Command |
    |--------|---------|
    | dev | `electron-vite dev` |
    | build | `electron-vite build` |
    | preview | `electron-vite preview` |
    | test | `vitest run` |
    | test:watch | `vitest` |
    | lint | `eslint . --max-warnings 0` |
    | lint:fix | `eslint . --fix` |
    | format | `prettier --write .` |
    | format:check | `prettier --check .` |
    | check | `svelte-check --tsconfig ./tsconfig.web.json --fail-on-warnings` |
    | validate | `pnpm format:check && pnpm lint && pnpm check && pnpm test && pnpm build` |
  - Files: `package.json`
  - Test: `package.json` exists with correct structure

- [x] **Step 3: Install dependencies**
  - Install production dependencies:
    ```bash
    pnpm add @vscode-elements/elements @vscode/codicons
    ```
  - Install development dependencies:
    ```bash
    pnpm add -D electron electron-vite vite
    pnpm add -D svelte @sveltejs/vite-plugin-svelte svelte-check
    pnpm add -D typescript @types/node
    pnpm add -D vitest @testing-library/svelte @testing-library/jest-dom happy-dom
    pnpm add -D eslint @eslint/js @eslint/compat typescript-eslint eslint-plugin-svelte eslint-config-prettier globals
    pnpm add -D prettier prettier-plugin-svelte
    ```
  - Files: `package.json`, `pnpm-lock.yaml`
  - Test: `pnpm install` succeeds, all packages in node_modules

- [x] **Step 4: Create TypeScript configuration**
  - Create `tsconfig.json` (base config - not used directly, only extended):
    ```json
    {
      "compilerOptions": {
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "noImplicitReturns": true,
        "noFallthroughCasesInSwitch": true,
        "exactOptionalPropertyTypes": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "isolatedModules": true,
        "verbatimModuleSyntax": true,
        "resolveJsonModule": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
      },
      "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }],
      "files": []
    }
    ```
  - Create `tsconfig.node.json` (main/preload/services):
    ```json
    {
      "extends": "./tsconfig.json",
      "compilerOptions": {
        "composite": true,
        "module": "ESNext",
        "moduleResolution": "bundler",
        "target": "ESNext",
        "outDir": "out",
        "types": ["node"]
      },
      "include": ["src/main/**/*", "src/preload/**/*", "src/services/**/*", "src/shared/**/*"]
    }
    ```
  - Create `tsconfig.web.json` (renderer):
    ```json
    {
      "extends": "./tsconfig.json",
      "compilerOptions": {
        "composite": true,
        "module": "ESNext",
        "moduleResolution": "bundler",
        "target": "ESNext",
        "lib": ["ESNext", "DOM", "DOM.Iterable"],
        "outDir": "out",
        "baseUrl": ".",
        "paths": {
          "$lib/*": ["src/renderer/lib/*"]
        }
      },
      "include": ["src/renderer/**/*", "src/shared/**/*"]
    }
    ```
  - Files: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
  - Test: `tsc --noEmit -p tsconfig.node.json` passes (after source files exist)

- [x] **Step 5: Create ESLint configuration**
  - Create `eslint.config.js` using ESLint 9 flat config:
    - Import and use `@eslint/js` recommended config
    - Import and use `typescript-eslint` recommended config
    - Import and use `eslint-plugin-svelte` flat/recommended config
    - Import and use `eslint-config-prettier` to disable conflicting rules
    - Configure globals for browser and node environments
    - Configure Svelte files to use TypeScript parser
    - Ban ts-ignore and ts-expect-error comments via `@typescript-eslint/ban-ts-comment` rule
    - Set `linterOptions.noInlineConfig: true` to disallow eslint-disable comments
    - Set `linterOptions.reportUnusedDisableDirectives: "error"`
    - Ignore patterns: `out/`, `node_modules/`, `.vite/`
  - Files: `eslint.config.js`
  - Test: `pnpm lint` passes with 0 warnings (after source files exist)

- [x] **Step 6: Create Prettier configuration**
  - Create `.prettierrc`:
    ```json
    {
      "semi": true,
      "singleQuote": false,
      "tabWidth": 2,
      "useTabs": false,
      "trailingComma": "es5",
      "printWidth": 100,
      "plugins": ["prettier-plugin-svelte"],
      "overrides": [
        {
          "files": "*.svelte",
          "options": {
            "parser": "svelte"
          }
        }
      ]
    }
    ```
  - Create `.prettierignore`:
    ```
    node_modules/
    out/
    pnpm-lock.yaml
    .vite/
    ```
  - Files: `.prettierrc`, `.prettierignore`
  - Test: `pnpm format:check` passes (after source files exist)

- [x] **Step 7: Create Vitest configuration**
  - Create `vitest.config.ts`:

    ```typescript
    import { defineConfig } from "vitest/config";
    import { svelte } from "@sveltejs/vite-plugin-svelte";
    import { svelteTesting } from "@testing-library/svelte/vite";
    import { resolve } from "path";

    export default defineConfig({
      plugins: [svelte(), svelteTesting()],
      test: {
        environment: "happy-dom",
        include: ["src/**/*.{test,spec}.{js,ts}"],
        globals: true,
        setupFiles: ["./src/test/setup.ts"],
        isolate: true,
        restoreMocks: true,
        clearMocks: true,
      },
      resolve: {
        alias: {
          $lib: resolve("./src/renderer/lib"),
        },
      },
    });
    ```

  - Create `src/test/setup.ts`:
    ```typescript
    import "@testing-library/jest-dom/vitest";
    ```
  - Files: `vitest.config.ts`, `src/test/setup.ts`
  - Test: `pnpm test` runs without errors

- [x] **Step 8: Create electron-vite configuration**
  - Create `electron.vite.config.ts`:
    - Main config: TypeScript for Node.js, entry `src/main/index.ts`
    - Preload config: TypeScript with sandbox support, entry `src/preload/index.ts`
    - Renderer config: Svelte plugin, path alias `$lib` → `src/renderer/lib`
  - Create `svelte.config.js` for consistency across tools:

    ```javascript
    import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

    export default {
      preprocess: vitePreprocess(),
    };
    ```

  - Files: `electron.vite.config.ts`, `svelte.config.js`
  - Test: `pnpm build` succeeds (after source files exist)

- [x] **Step 9: Create main process**
  - Create `src/main/index.ts`:

    ```typescript
    import { app, BaseWindow, WebContentsView, Menu } from "electron";
    import { fileURLToPath } from "node:url";
    import path from "node:path";

    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // Disable application menu
    Menu.setApplicationMenu(null);

    let mainWindow: BaseWindow | null = null;
    let mainView: WebContentsView | null = null;

    function createWindow(): void {
      mainWindow = new BaseWindow({
        width: 1200,
        height: 800,
        title: "CodeHydra",
      });

      mainView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, "../preload/index.js"),
        },
      });

      mainWindow.contentView.addChildView(mainView);
      updateViewBounds();

      mainView.webContents.loadFile(path.join(__dirname, "../renderer/index.html"));

      // Open DevTools in development only
      if (!app.isPackaged) {
        mainView.webContents.openDevTools();
      }

      mainWindow.on("resize", updateViewBounds);
      mainWindow.on("closed", () => {
        mainWindow = null;
        mainView = null;
      });
    }

    function updateViewBounds(): void {
      if (!mainWindow || !mainView) return;
      const bounds = mainWindow.getBounds();
      mainView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    }

    app.whenReady().then(createWindow);

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.on("activate", () => {
      if (mainWindow === null) createWindow();
    });
    ```

  - Files: `src/main/index.ts`
  - Test: App launches without errors

- [x] **Step 10: Create preload script**
  - Create `src/preload/index.ts`:

    ```typescript
    import { contextBridge } from "electron";

    // TODO: Phase 3 - Add webview-preload.ts for code-server views

    contextBridge.exposeInMainWorld("electronAPI", {
      // Phase 3 will add IPC methods here
    });
    ```

  - Create `src/shared/electron-api.d.ts` for renderer type definitions (in shared/ so both tsconfigs can access it):

    ```typescript
    /**
     * Type definitions for the Electron API exposed via contextBridge.
     * This file is in shared/ so both main/preload and renderer can access the types.
     */
    export interface ElectronAPI {
      // Phase 3 will define IPC methods here
    }

    declare global {
      interface Window {
        electronAPI: ElectronAPI;
      }
    }

    export {};
    ```

  - Files: `src/preload/index.ts`, `src/shared/electron-api.d.ts`
  - Test: No console errors on app launch

- [x] **Step 11: Create renderer**
  - Create `src/renderer/index.html`:
    ```html
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
        />
        <title>CodeHydra</title>
      </head>
      <body>
        <div id="app"></div>
        <script type="module" src="./main.ts"></script>
      </body>
    </html>
    ```
  - Create `src/renderer/main.ts`:

    ```typescript
    import { mount } from "svelte";
    import App from "./App.svelte";

    const app = mount(App, {
      target: document.getElementById("app")!,
    });

    export default app;
    ```

  - Create `src/renderer/App.svelte`:

    ```svelte
    <main>
      <h1>CodeHydra - Phase 1 Complete</h1>
    </main>

    <style>
      main {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        font-family: system-ui, sans-serif;
      }
    </style>
    ```

  - Create `src/renderer/vite-env.d.ts`:
    ```typescript
    /// <reference types="vite/client" />
    /// <reference types="svelte" />
    ```
  - Create directory structure:
    - `src/renderer/lib/components/.gitkeep`
    - `src/renderer/lib/stores/.gitkeep`
    - `src/renderer/lib/api/.gitkeep`
  - Files: `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/App.svelte`, `src/renderer/vite-env.d.ts`, lib subdirectories
  - Test: UI displays "CodeHydra - Phase 1 Complete"

- [x] **Step 12: Create services placeholder and IPC types**
  - Create `src/shared/ipc.ts`:
    ```typescript
    /**
     * IPC channel names and payload types.
     * Shared between main, preload, and renderer processes.
     *
     * TODO: Phase 3 will define the IPC contract here.
     */
    export {};
    ```
  - Create `src/services/.gitkeep`
  - Note: `src/shared/electron-api.d.ts` is created in Step 10
  - Files: `src/shared/ipc.ts`, `src/services/.gitkeep`
  - Test: Directories exist, TypeScript compiles

- [x] **Step 13: Run full validation**
  - Run all validation commands in order:
    1. `pnpm format` - Auto-format all files
    2. `pnpm format:check` - Verify formatting
    3. `pnpm lint` - Check for lint errors
    4. `pnpm check` - Run svelte-check
    5. `pnpm test` - Run tests (should pass with no tests)
    6. `pnpm build` - Build the application
    7. `pnpm dev` - Launch and manually verify
  - Fix any issues that arise
  - Test: All validation checks pass

## Testing Strategy

### Unit Tests (vitest)

| Test Case          | Description                   | File |
| ------------------ | ----------------------------- | ---- |
| (none for Phase 1) | No business logic to test yet | -    |

### Integration Tests

| Test Case          | Description         | File |
| ------------------ | ------------------- | ---- |
| (none for Phase 1) | No integrations yet | -    |

### Manual Testing Checklist

- [ ] `pnpm install` completes without errors
- [ ] `pnpm dev` launches Electron window
- [ ] Window title is "CodeHydra"
- [ ] Window displays "CodeHydra - Phase 1 Complete"
- [ ] DevTools opens automatically in dev mode
- [ ] `pnpm build` completes without errors
- [ ] `pnpm test` runs without errors
- [ ] `pnpm lint` passes with 0 warnings
- [ ] `pnpm format:check` passes
- [ ] `pnpm check` passes (svelte-check)
- [ ] `pnpm validate` passes all checks
- [ ] On macOS: closing window doesn't quit app, dock icon click reopens window

## Dependencies

All dependencies installed via `pnpm add <package>` (or `pnpm add -D <package>` for dev) to get latest versions.

### Production Dependencies

| Package                   | Purpose                      |
| ------------------------- | ---------------------------- |
| @vscode-elements/elements | VS Code-styled UI components |
| @vscode/codicons          | VS Code icons                |

### Development Dependencies

| Package                      | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| electron                     | Electron runtime                                 |
| electron-vite                | Build tooling for Electron + Vite                |
| vite                         | Build tool                                       |
| svelte                       | Svelte 5 framework                               |
| @sveltejs/vite-plugin-svelte | Svelte Vite integration                          |
| svelte-check                 | Svelte type checker                              |
| typescript                   | TypeScript compiler                              |
| @types/node                  | Node.js type definitions                         |
| vitest                       | Test framework                                   |
| @testing-library/svelte      | Svelte testing utilities                         |
| @testing-library/jest-dom    | DOM matchers                                     |
| happy-dom                    | DOM implementation for tests                     |
| eslint                       | Linter                                           |
| @eslint/js                   | ESLint JS config                                 |
| @eslint/compat               | ESLint compatibility utilities                   |
| typescript-eslint            | TypeScript ESLint integration                    |
| eslint-plugin-svelte         | Svelte ESLint plugin                             |
| eslint-config-prettier       | Disable ESLint rules that conflict with Prettier |
| globals                      | Global variables for ESLint                      |
| prettier                     | Code formatter                                   |
| prettier-plugin-svelte       | Prettier Svelte plugin                           |

## Documentation Updates

### Files to Update

| File         | Changes Required                         |
| ------------ | ---------------------------------------- |
| `.gitignore` | Verify `out/` exists, add `.vite/` entry |

### New Documentation Required

| File   | Purpose                 |
| ------ | ----------------------- |
| (none) | No new docs for Phase 1 |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm lint` passes (0 errors, 0 warnings)
- [ ] `pnpm test` passes (all tests green)
- [ ] `pnpm format:check` passes
- [ ] `pnpm check` passes (svelte-check)
- [ ] `pnpm build` completes successfully
- [ ] `pnpm dev` launches working Electron window with WebContentsView
- [ ] Window displays "CodeHydra - Phase 1 Complete"
- [ ] Security settings verified (contextIsolation, sandbox, CSP)
- [ ] User acceptance testing passed
- [ ] Changes committed
