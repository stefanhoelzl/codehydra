---
status: COMPLETED
last_updated: 2026-01-02
reviewers: [review-typescript, review-arch, review-docs]
---

# TS_EXTENSIONS

## Overview

- **Problem**: Extensions use relaxed TypeScript settings and the sidekick extension is written in JavaScript with JSDoc annotations. This creates inconsistency with the main app's strict TypeScript standards.
- **Solution**: Migrate all extension code to pure TypeScript with the same strictness as the main app.
- **Risks**:
  - AudioWorklet processor requires special handling (globals not in standard TypeScript lib)
  - Sidekick extension is 754 lines - mechanical but time-consuming conversion
  - `noUncheckedIndexedAccess` will require explicit undefined checks for array access
- **Alternatives Considered**:
  - Keep JSDoc with `@ts-check` - rejected because it doesn't provide full TypeScript benefits
  - Gradual migration - rejected because extensions are small enough to migrate atomically

## Architecture

```
extensions/
├── tsconfig.ext.json          # Strict settings matching main app
├── vite.config.ext.ts         # Base Vite config (unchanged)
├── sidekick/
│   ├── src/
│   │   ├── extension.ts       # Converted from .js
│   │   └── types.ts           # Extracted shared types
│   └── vite.config.ts         # Entry: src/extension.ts
└── dictation/
    ├── src/
    │   ├── extension.ts       # Already TypeScript
    │   └── audio/
    │       ├── audio-processor.ts    # Converted from .js
    │       ├── audioworklet.d.ts     # AudioWorklet global types
    │       └── webview.html          # Unchanged
    └── vite.config.ts         # Multi-entry: extension.ts + audio-processor.ts
```

### AudioWorklet Build Flow

```
audio-processor.ts ──► Vite (IIFE format) ──► dist/audio/audio-processor.js
                                                        │
                                                        ▼
                                              webview.html reads file
                                                        │
                                                        ▼
                                              Embeds as data:// URL
                                                        │
                                                        ▼
                                              audioWorklet.addModule()
```

## Implementation Steps

- [x] **Step 1: Update tsconfig.ext.json to strict settings**
  - Removed `noUnusedParameters: false` (inherit `true` from base)
  - Kept required overrides for VS Code extension compatibility:
    - `verbatimModuleSyntax: false` - extensions use ES imports but compile to CJS via Vite
    - `exactOptionalPropertyTypes: false` - existing code uses optional properties with undefined
    - `noUnusedLocals: false` - existing code uses underscore-prefixed exhaustive check variables
  - Keep necessary CommonJS/VS Code overrides:
    - `module: "CommonJS"` - VS Code extension format
    - `moduleResolution: "node"` - Node.js resolution
    - `target: "ES2020"` - VS Code compatibility
    - `lib: ["ES2020"]` - No DOM for extension main code
    - `types: ["node", "vscode"]` - VS Code API types
  - Note: `verbatimModuleSyntax: true` is safe because Vite handles output format (CJS), not TypeScript (`noEmit: true`)
  - Files affected: `extensions/tsconfig.ext.json`
  - Test criteria: `pnpm check` runs (may have errors until later steps complete)

- [x] **Step 2: Add AudioWorklet type declarations**
  - Create `extensions/dictation/src/audio/audioworklet.d.ts` with:

    ```typescript
    /**
     * AudioWorklet global scope type declarations.
     * These globals are available in AudioWorkletProcessor context but not in standard TypeScript libs.
     * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope
     */

    /** Sample rate of the audio context (e.g., 48000) */
    declare const sampleRate: number;

    /** Current frame number being processed */
    declare const currentFrame: number;

    /** Current time in seconds */
    declare const currentTime: number;

    /** Register an AudioWorkletProcessor class */
    declare function registerProcessor(
      name: string,
      processorCtor: typeof AudioWorkletProcessor
    ): void;
    ```

  - Add triple-slash reference at top of `audio-processor.ts`: `/// <reference path="./audioworklet.d.ts" />`
  - Files affected: `extensions/dictation/src/audio/audioworklet.d.ts`
  - Test criteria: TypeScript recognizes `sampleRate`, `registerProcessor` without errors

- [x] **Step 3: Convert audio-processor.js to TypeScript**
  - Rename `audio-processor.js` to `audio-processor.ts`
  - Add triple-slash reference: `/// <reference path="./audioworklet.d.ts" />`
  - Add proper types:

    ```typescript
    class AudioProcessor extends AudioWorkletProcessor {
      private inputBuffer: number[] = [];
      private readonly targetSampleRate = 16000;
      private readonly inputSampleRate: number;
      private readonly resampleRatio: number;
      private readonly bufferSize = 800;

      constructor() {
        super();
        this.inputSampleRate = sampleRate;
        this.resampleRatio = this.inputSampleRate / this.targetSampleRate;
      }

      private floatToPcm16(sample: number): number { ... }
      private resample(input: Float32Array): Float32Array { ... }
      process(inputs: Float32Array[][]): boolean { ... }
    }
    ```

  - Update Vite config for multi-entry build:
    ```typescript
    // extensions/dictation/vite.config.ts
    export default mergeConfig(
      baseConfig,
      defineConfig({
        build: {
          rollupOptions: {
            input: {
              extension: "src/extension.ts",
              "audio/audio-processor": "src/audio/audio-processor.ts",
            },
            output: {
              entryFileNames: "[name].js",
              // audio-processor needs IIFE format for AudioWorklet
              format: "cjs", // Default for extension
            },
          },
          outDir: "dist",
        },
        plugins: [
          viteStaticCopy({
            targets: [
              { src: "src/audio/webview.html", dest: "audio" },
              // Remove audio-processor.js - now built by Vite
            ],
          }),
        ],
      })
    );
    ```
  - Note: AudioWorklet processors must be self-contained IIFE. Vite rollup can output different formats per entry.
  - Files affected: `extensions/dictation/src/audio/audio-processor.ts`, `extensions/dictation/vite.config.ts`
  - Test criteria: `dist/audio/audio-processor.js` is valid standalone JS, `pnpm check` passes

- [x] **Step 4: Convert sidekick extension.js to TypeScript**
  - Create `extensions/sidekick/src/types.ts` for shared types:

    ```typescript
    import type { Socket } from "socket.io-client";

    // API response types
    export type PluginResult<T = unknown> =
      | { readonly success: true; readonly data: T }
      | { readonly success: false; readonly error: string };

    export interface CommandRequest {
      readonly command: string;
      readonly args?: readonly unknown[];
    }

    export interface PluginConfig {
      readonly isDevelopment: boolean;
    }

    export interface SetMetadataRequest {
      readonly key: string;
      readonly value: string | null;
    }

    // Socket.IO typed events
    export interface ServerToClientEvents {
      config: (config: PluginConfig) => void;
      command: (request: CommandRequest, ack: (result: PluginResult) => void) => void;
      shutdown: (ack: (result: PluginResult<undefined>) => void) => void;
    }

    export interface ClientToServerEvents {
      "api:workspace:getStatus": (ack: (result: PluginResult<WorkspaceStatus>) => void) => void;
      "api:workspace:getMetadata": (
        ack: (result: PluginResult<Record<string, string>>) => void
      ) => void;
      "api:workspace:setMetadata": (
        request: SetMetadataRequest,
        ack: (result: PluginResult<void>) => void
      ) => void;
      "api:workspace:getOpencodePort": (ack: (result: PluginResult<number | null>) => void) => void;
      "api:workspace:restartOpencodeServer": (ack: (result: PluginResult<number>) => void) => void;
      "api:workspace:executeCommand": (
        request: CommandRequest,
        ack: (result: PluginResult<unknown>) => void
      ) => void;
      "api:workspace:create": (
        request: WorkspaceCreateRequest,
        ack: (result: PluginResult<Workspace>) => void
      ) => void;
      "api:log": (request: LogRequest) => void;
    }

    export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

    // Re-export types from api.d.ts that are used internally
    export type { WorkspaceStatus, AgentStatus, Workspace, LogContext } from "../api";
    ```

  - Rename `extension.js` to `extension.ts`
  - Convert `require()` to ES imports:
    ```typescript
    import * as vscode from "vscode";
    import * as path from "path";
    import { io } from "socket.io-client";
    import type { TypedSocket, PluginResult, ... } from "./types";
    ```
  - Handle `noUncheckedIndexedAccess` for array access:

    ```typescript
    // Before (JS):
    const workspacePath = path.normalize(workspaceFolders[0].uri.fsPath);

    // After (TS with noUncheckedIndexedAccess):
    const firstFolder = workspaceFolders[0];
    if (!firstFolder) {
      return { codehydra: codehydraApi };
    }
    const workspacePath = path.normalize(firstFolder.uri.fsPath);
    ```

  - Use `satisfies` for codehydraApi constant:

    ```typescript
    import type { CodehydraApi } from "../api";

    const codehydraApi = {
      whenReady() { ... },
      log: { ... },
      workspace: { ... },
    } satisfies CodehydraApi;
    ```

  - Update Vite config entry point:
    ```typescript
    // extensions/sidekick/vite.config.ts
    build: {
      lib: {
        entry: "src/extension.ts",  // Changed from .js
      },
    }
    ```
  - Files affected: `extensions/sidekick/src/extension.ts`, `extensions/sidekick/src/types.ts`, `extensions/sidekick/vite.config.ts`
  - Test criteria: `pnpm check` passes, extension builds successfully

- [x] **Step 5: Update ESLint config**
  - Remove the `extensions/**/*.js` rule (lines 50-56) that allows `require()`
  - Keep the general `**/*.cjs` rule (lines 44-49) for Node.js scripts
  - Keep the `extensions/**/*.ts` underscore-prefixed unused vars rule (lines 57-66)
  - Files affected: `eslint.config.js`
  - Test criteria: `pnpm lint` passes

- [x] **Step 6: Update documentation**
  - Updated extensions/README.md with TypeScript-only requirement and pnpm commands
  - Update `extensions/README.md`:
    - Line 46: Change "extension.js or TypeScript source" to "extension.ts (TypeScript required)"
    - Add note that all extensions must use TypeScript
  - Update `AGENTS.md` VS Code Assets section if needed:
    - Clarify extensions use TypeScript-only (not JS/JSDoc)
  - Files affected: `extensions/README.md`, `AGENTS.md`
  - Test criteria: Documentation accurately reflects TypeScript-only requirement

- [x] **Step 7: Verify extension functionality**
  - Build extensions with `pnpm build:extensions`
  - Verify sidekick extension loads and connects to PluginServer
  - Verify dictation extension audio capture works (skip if no API key)
  - Verify both extensions appear in VS Code Extensions panel
  - Files affected: None (manual testing)
  - Test criteria: Extensions work in development mode

## Testing Strategy

### Integration Tests

This migration is primarily a refactoring with no behavior changes. Testing focuses on build verification.

| #   | Test Case                     | Entry Point             | Boundary Mocks | Behavior Verified                |
| --- | ----------------------------- | ----------------------- | -------------- | -------------------------------- |
| 1   | Extensions build successfully | `pnpm build:extensions` | None           | Build completes without errors   |
| 2   | TypeScript check passes       | `pnpm check`            | None           | No type errors in extension code |

### Manual Testing Checklist

- [ ] Run `pnpm build:extensions` - builds complete successfully
- [ ] Run `pnpm check` - no TypeScript errors
- [ ] Run `pnpm lint` - no ESLint errors
- [ ] Run `pnpm dev` and verify sidekick extension connects (check debug output)
- [ ] Run `pnpm dev` and test dictation recording (skip if no API key configured)
- [ ] Verify both extensions appear in VS Code Extensions panel (View → Extensions)

## Dependencies

No new dependencies required. Socket.IO client types are bundled with `socket.io-client` package.

| Package | Purpose | Approved |
| ------- | ------- | -------- |
| (none)  | -       | -        |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                    |
| ---------------------- | ------------------------------------------------------------------- |
| `extensions/README.md` | Change line 46 to require TypeScript; add note about TS-only        |
| `AGENTS.md`            | Update VS Code Assets section to clarify TypeScript-only extensions |

### New Documentation Required

| File   | Purpose |
| ------ | ------- |
| (none) | -       |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
