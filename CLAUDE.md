# Chime Development Guide

## Project Overview

**Chime** is a multi-agent IDE that enables developers to orchestrate multiple AI agents working in parallel across isolated git worktrees. This is the base Tauri application that will be built into the full Chime application.

For detailed concept and architecture, see `docs/INITIAL_CONCEPT.md`.

## Current Status

This is a freshly scaffolded Tauri 2.0 application with:
- **Frontend**: Svelte 5 + TypeScript + SvelteKit
- **Backend**: Rust with Tauri 2.9
- **Package Manager**: pnpm
- **Build Tool**: Vite 6

## Tech Stack

### Frontend
- **Svelte 5.43.11** - Reactive UI framework
- **SvelteKit 2.48.5** - Application framework with routing
- **TypeScript 5.6.3** - Type safety
- **Vite 6.4.1** - Build tool and dev server

### Backend
- **Rust (Edition 2021)** - System programming language
- **Tauri 2.9** - Desktop application framework
- **serde & serde_json** - JSON serialization

### Tauri Plugins
- `@tauri-apps/plugin-opener` - Open URLs and files

## Project Structure

```
chime/
├── src/                      # Svelte frontend source
│   ├── app.html             # HTML template
│   └── routes/              # SvelteKit routes
├── src-tauri/               # Rust backend
│   ├── src/                 # Rust source code
│   │   ├── main.rs          # Entry point
│   │   └── lib.rs           # Library code
│   ├── capabilities/        # Tauri capability definitions
│   ├── icons/               # Application icons
│   ├── Cargo.toml           # Rust dependencies
│   ├── build.rs             # Build script
│   └── tauri.conf.json      # Tauri configuration
├── static/                  # Static assets
├── docs/                    # Documentation
│   └── INITIAL_CONCEPT.md   # Detailed project concept
├── package.json             # Node dependencies
├── svelte.config.js         # Svelte configuration
├── tsconfig.json            # TypeScript configuration
└── vite.config.js           # Vite configuration
```

## Development Setup

### Prerequisites

1. **Node.js & pnpm** - Already installed
2. **Rust** - Install via [rustup.rs](https://rustup.rs/)
3. **System Dependencies** (Linux):
   - webkit2gtk
   - rsvg2
   - See: https://v2.tauri.app/start/prerequisites/#linux

### Installation

Dependencies are already installed. If you need to reinstall:

```bash
pnpm install
```

## Development Commands

### Run Development Server

```bash
pnpm tauri dev
```

This will:
1. Start Vite dev server on http://localhost:1420
2. Compile Rust backend
3. Launch the Tauri desktop application with hot reload

### Build for Production

```bash
pnpm tauri build
```

This creates a production build with platform-specific installers in `src-tauri/target/release/bundle/`.

### Type Checking

```bash
pnpm check
```

Run TypeScript and Svelte type checking.

### Type Checking (Watch Mode)

```bash
pnpm check:watch
```

Continuously check types as you develop.

### Frontend Only Development

```bash
pnpm dev        # Start Vite dev server
pnpm build      # Build frontend only
pnpm preview    # Preview production build
```

## Key Configuration Files

### `src-tauri/tauri.conf.json`
- **Product name**: "chime"
- **Identifier**: "com.stefan.chime"
- **Window size**: 800x600 (default)
- **Dev URL**: http://localhost:1420
- **Frontend dist**: ../build (SvelteKit output)

### `package.json`
- **Name**: "chime"
- **Version**: 0.1.0
- **Type**: "module" (ES modules)

### `src-tauri/Cargo.toml`
- **Package name**: "chime"
- **Crate type**: staticlib, cdylib, rlib
- **Lib name**: chime_lib

## Development Workflow

### Frontend Development
1. Edit files in `src/` directory
2. Vite will hot-reload changes automatically
3. Use Svelte 5 syntax (latest version)
4. TypeScript strict mode is enabled

### Backend Development
1. Edit Rust files in `src-tauri/src/`
2. Define Tauri commands in `lib.rs`
3. Expose commands to frontend via `#[tauri::command]`
4. Backend recompiles on save (may take a few seconds)

### Adding Tauri Commands

Example Rust command:
```rust
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
```

Register in `main.rs`:
```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Call from Svelte:
```typescript
import { invoke } from '@tauri-apps/api/core';

const greeting = await invoke<string>('greet', { name: 'World' });
```

## Architecture Patterns

### Frontend (Svelte)
- Use **Svelte stores** for state management
- Follow **SvelteKit conventions** for routing
- Keep components small and focused
- Use **TypeScript** for all logic

### Backend (Rust)
- Follow the **Provider pattern** for components (see INITIAL_CONCEPT.md):
  - `WorkspaceProvider` - Git worktree management
  - `AgentProvider` - Code-server process management
  - `AgentObserver` - State monitoring
- Use **traits** for abstraction and future extensibility
- Handle errors properly with `Result<T, E>`
- Use **async/await** for concurrent operations

### IPC Communication
- Use Tauri commands for frontend → backend calls
- Use Tauri events for backend → frontend updates
- Keep payloads serializable (use serde)

## Future Development Plan

According to `docs/INITIAL_CONCEPT.md`, the next phases involve:

1. **Agent Manager** - Coordinate agent lifecycle
2. **WorkspaceProvider** - Git worktree isolation (GitWorktreeProvider)
3. **AgentProvider** - Code-server + Claude Code setup (ClaudeCodeAgentProvider)
4. **AgentObserver** - Monitor agent state transitions
5. **UI Components** - Sidebar, tabs, iframe embedding
6. **Notifications** - Audio chimes, system notifications

## Resources

- **Tauri v2 Docs**: https://v2.tauri.app/
- **Svelte 5 Docs**: https://svelte.dev/docs
- **SvelteKit Docs**: https://kit.svelte.dev/docs
- **Rust Book**: https://doc.rust-lang.org/book/

## Notes

- The app uses **Svelte 5** with the new runes API ($state, $effect, etc.)
- **SvelteKit** is configured with the static adapter for Tauri
- All frontend code is bundled into `build/` directory for Tauri
- The Rust backend compiles to a static/dynamic library linked with Tauri

## Troubleshooting

### Missing System Dependencies (Linux)
```bash
# Fedora/RHEL
sudo dnf install webkit2gtk4.1-devel librsvg2-devel

# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev
```

### Port Already in Use
If port 1420 is taken, kill the process or change the port in `tauri.conf.json` under `build.devUrl`.

### Rust Compilation Errors
```bash
cd src-tauri
cargo clean
cargo build
```

### pnpm Issues
```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

## Git Integration

The project is already initialized with git. Key files ignored:
- `node_modules/`
- `src-tauri/target/` (Rust build artifacts)
- `build/` (Frontend build output)

## Contributing

This is an early-stage project. Follow these principles:
1. Read `docs/INITIAL_CONCEPT.md` thoroughly
2. Keep frontend and backend concerns separated
3. Use the Provider pattern for backend components
4. Write type-safe code (TypeScript + Rust)
5. Test on all target platforms

---

**Current Version**: 0.1.0
**Last Updated**: 2025-11-18
