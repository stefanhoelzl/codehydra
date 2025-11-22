# Code-Server Integration Plan

This document outlines the plan for integrating code-server into Chime using Bun as the JavaScript runtime.

## Overview

Chime runs a **single global code-server instance** that serves all workspaces across all projects. This mirrors how native VSCode works - one installation, multiple windows. Each workspace is opened via a different `?folder=` URL parameter, and VSCode automatically manages per-folder state in `workspaceStorage/`.

---

## Pinned Versions (as of Nov 22, 2025)

| Component                 | Version | Source          |
| ------------------------- | ------- | --------------- |
| **Bun**                   | 1.3.3   | GitHub releases |
| **code-server**           | 4.106.2 | npm registry    |
| **Claude Code Extension** | 2.0.50  | Open VSX        |

These versions are hardcoded and will be manually updated as needed.

```rust
// src-tauri/src/runtime_versions.rs

use std::collections::HashMap;

/// Pinned runtime versions - manually update when needed
pub const BUN_VERSION: &str = "1.3.3";
pub const CODE_SERVER_VERSION: &str = "4.106.2";

/// Extensions to install (extension_id -> version)
/// Uses Open VSX registry (code-server default)
pub fn get_required_extensions() -> HashMap<&'static str, &'static str> {
    let mut extensions = HashMap::new();
    extensions.insert("Anthropic.claude-code", "2.0.50");
    // Add more extensions here in the future
    extensions
}
```

---

## Error Types

All code-server operations use a typed error enum instead of `String` errors:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CodeServerError {
    // Setup errors
    #[error("Failed to download {component}: {source}")]
    DownloadFailed { component: String, #[source] source: reqwest::Error },

    #[error("Checksum mismatch for {file}: expected {expected}, got {actual}")]
    ChecksumMismatch { file: String, expected: String, actual: String },

    #[error("Failed to extract archive: {0}")]
    ExtractionFailed(String),

    #[error("Unsupported platform")]
    UnsupportedPlatform,

    // Permission/filesystem errors
    #[error("Permission error: {0}")]
    PermissionError(#[source] std::io::Error),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    // Runtime errors
    #[error("No available ports starting from {start}")]
    NoAvailablePorts { start: u16 },

    #[error("Failed to spawn process: {0}")]
    SpawnFailed(#[source] std::io::Error),

    #[error("Health check failed after {attempts} attempts")]
    HealthCheckFailed { attempts: u32 },

    #[error("Process terminated unexpectedly with code {code:?}")]
    ProcessTerminated { code: Option<i32> },

    #[error("Failed to kill process: {0}")]
    ProcessKillFailed(String),

    #[error("Instance not running")]
    InstanceNotRunning,

    #[error("Invalid state transition")]
    InvalidStateTransition,

    // Extension errors
    #[error("Failed to install extension {extension}: {reason}")]
    ExtensionInstallFailed { extension: String, reason: String },
}
```

**Migration note:** Existing `Result<T, String>` errors in `code_server.rs`, `lib.rs`, `workspace_provider.rs`, and `git_worktree_provider.rs` should be migrated to use this enum.

---

## Platform Module

All platform-specific code is centralized in a `platform` module:

```
src-tauri/src/
├── platform/
│   ├── mod.rs          # Platform detection, public exports
│   ├── download.rs     # Download URLs, checksums
│   ├── paths.rs        # Path handling, URL encoding
│   └── process.rs      # Process spawning, permissions
```

### Platform Detection (`platform/mod.rs`)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX64,
    LinuxArm64,
    MacOSX64,
    MacOSArm64,
    WindowsX64,
}

impl Platform {
    pub fn current() -> Option<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => Some(Self::LinuxX64),
            ("linux", "aarch64") => Some(Self::LinuxArm64),
            ("macos", "x86_64") => Some(Self::MacOSX64),
            ("macos", "aarch64") => Some(Self::MacOSArm64),
            ("windows", "x86_64") => Some(Self::WindowsX64),
            _ => None,
        }
    }

    pub fn bun_archive_name(&self) -> &'static str {
        match self {
            Self::LinuxX64 => "bun-linux-x64",
            Self::LinuxArm64 => "bun-linux-aarch64",
            Self::MacOSX64 => "bun-darwin-x64",
            Self::MacOSArm64 => "bun-darwin-aarch64",
            Self::WindowsX64 => "bun-windows-x64",
        }
    }

    pub fn bun_binary_name(&self) -> &'static str {
        match self {
            Self::WindowsX64 => "bun.exe",
            _ => "bun",
        }
    }
}
```

### Download URLs and Checksums (`platform/download.rs`)

```rust
use super::Platform;
use crate::runtime_versions::BUN_VERSION;

/// SHA256 checksums for Bun binaries (verify after download)
pub fn bun_checksum(platform: Platform) -> &'static str {
    match platform {
        Platform::LinuxX64 => "TODO_GET_ACTUAL_CHECKSUM",
        Platform::LinuxArm64 => "TODO_GET_ACTUAL_CHECKSUM",
        Platform::MacOSX64 => "TODO_GET_ACTUAL_CHECKSUM",
        Platform::MacOSArm64 => "TODO_GET_ACTUAL_CHECKSUM",
        Platform::WindowsX64 => "TODO_GET_ACTUAL_CHECKSUM",
    }
}

pub fn bun_download_url(platform: Platform) -> String {
    format!(
        "https://github.com/oven-sh/bun/releases/download/bun-v{}/{}.zip",
        BUN_VERSION,
        platform.bun_archive_name()
    )
}

pub async fn download_and_verify(
    url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, CodeServerError> {
    let data = download(url).await?;

    use sha2::{Sha256, Digest};
    let actual = format!("{:x}", Sha256::digest(&data));

    if actual != expected_sha256 {
        return Err(CodeServerError::ChecksumMismatch {
            file: url.to_string(),
            expected: expected_sha256.to_string(),
            actual,
        });
    }
    Ok(data)
}
```

### Path Handling (`platform/paths.rs`)

```rust
use std::path::{Path, PathBuf};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

const PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ').add(b'"').add(b'#').add(b'<')
    .add(b'>').add(b'?').add(b'{').add(b'}');

/// Encode a path for use in URLs
pub fn encode_path_for_url(path: &Path) -> String {
    utf8_percent_encode(&path.to_string_lossy(), PATH_ENCODE_SET).to_string()
}

/// Normalize a path (canonicalize, resolve symlinks)
pub fn normalize_path(path: &Path) -> Result<PathBuf, CodeServerError> {
    path.canonicalize().map_err(|e| {
        CodeServerError::InvalidPath(format!("{}: {}", path.display(), e))
    })
}

/// Get the data directory for the app
pub fn get_data_dir(app_handle: &tauri::AppHandle, app_version: &str) -> Result<PathBuf, tauri::Error> {
    let base = if cfg!(debug_assertions) {
        // Development: use local directory relative to project
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("app-data")
    } else {
        // Production: use platform-specific user data directory
        app_handle.path().app_local_data_dir()?
    };
    Ok(base.join(app_version))
}
```

### Process Management (`platform/process.rs`)

Uses `process-wrap` crate for safe cross-platform process group management (no unsafe code):

```rust
use std::path::Path;
use process_wrap::tokio::*;
use crate::error::CodeServerError;

/// Spawn code-server in its own process group/job object
pub async fn spawn_code_server(
    bun_path: &Path,
    args: &[&str],
    cwd: &Path,
) -> Result<Box<dyn TokioChildWrapper>, CodeServerError> {
    let mut command = CommandWrap::with_new(bun_path, |cmd| {
        cmd.args(args).current_dir(cwd);
    });

    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());

    #[cfg(windows)]
    command.wrap(JobObject);

    command.spawn().map_err(CodeServerError::SpawnFailed)
}

/// Set executable permissions (Unix only)
pub fn set_executable(path: &Path) -> Result<(), CodeServerError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(CodeServerError::PermissionError)?;
    }
    Ok(())
}

/// Remove macOS quarantine attribute.
///
/// This intentionally ignores errors because:
/// - The file may not have the quarantine attribute (not downloaded from internet)
/// - The xattr command may not be available on some systems
/// - Failure here is non-fatal for app functionality
///
/// The quarantine attribute can prevent execution of downloaded binaries on macOS.
/// Removing it allows Bun to run without Gatekeeper warnings.
pub fn remove_quarantine(path: &Path) -> Result<(), CodeServerError> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(path)
            .output();
    }
    Ok(())
}

/// Prepare a downloaded binary for execution
pub fn prepare_binary(path: &Path) -> Result<(), CodeServerError> {
    set_executable(path)?;
    remove_quarantine(path)?;
    Ok(())
}
```

---

## Progress Event Types

Events emitted from Rust to frontend during setup:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetupEvent {
    StepStarted { step: SetupStep },
    Progress { step: SetupStep, percent: u8, message: Option<String> },
    StepCompleted { step: SetupStep },
    StepFailed { step: SetupStep, error: String },
    SetupComplete,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SetupStep {
    Bun,
    CodeServer,
    Extensions,
}
```

**Emitting from Rust:**

```rust
app.emit("setup-progress", SetupEvent::Progress {
    step: SetupStep::Bun,
    percent: 45,
    message: Some("Downloading...".to_string()),
})?;
```

**Listening in Svelte:**

```typescript
import { listen } from '@tauri-apps/api/event';

listen<SetupEvent>('setup-progress', (event) => {
  const { type, step, percent, message, error } = event.payload;
  // Update UI state
});
```

---

## RuntimeBootstrapper Component

Orchestrates first-launch setup. Uses trait bounds for dependency injection to enable testing:

```rust
use async_trait::async_trait;

/// RuntimeBootstrapper with injectable dependencies for testability
pub struct RuntimeBootstrapper<H: HttpClient, F: FileSystem, P: ProcessSpawner> {
    config: CodeServerConfig,
    http_client: H,
    file_system: F,
    process_spawner: P,
}

/// Production implementation with concrete types
impl RuntimeBootstrapper<ReqwestHttpClient, StdFileSystem, TokioProcessSpawner> {
    pub fn new(config: CodeServerConfig) -> Self {
        Self {
            config,
            http_client: ReqwestHttpClient::new(),
            file_system: StdFileSystem,
            process_spawner: TokioProcessSpawner,
        }
    }
}

/// Generic implementation for all trait bounds (enables testing)
impl<H: HttpClient, F: FileSystem, P: ProcessSpawner> RuntimeBootstrapper<H, F, P> {
    /// Create with custom dependencies (for testing)
    pub fn with_deps(config: CodeServerConfig, http_client: H, file_system: F, process_spawner: P) -> Self {
        Self { config, http_client, file_system, process_spawner }
    }

    /// Check if runtime is ready
    pub fn is_ready(&self) -> bool {
        self.file_system.exists(&self.config.bun_binary_path)
            && self.file_system.exists(&self.config.runtime_dir.join("node_modules/code-server"))
            && self.file_system.exists(&self.config.extensions_dir.join("Anthropic.claude-code"))
    }

    /// Ensure runtime is ready, download if not
    pub async fn ensure_ready(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<(), CodeServerError> {
        if self.is_ready() {
            return Ok(());
        }

        // Step 1: Download Bun
        emit_progress(app, SetupEvent::StepStarted { step: SetupStep::Bun });
        self.download_bun(app).await?;
        emit_progress(app, SetupEvent::StepCompleted { step: SetupStep::Bun });

        // Step 2: Install code-server
        emit_progress(app, SetupEvent::StepStarted { step: SetupStep::CodeServer });
        self.install_code_server(app).await?;
        emit_progress(app, SetupEvent::StepCompleted { step: SetupStep::CodeServer });

        // Step 3: Install extensions
        emit_progress(app, SetupEvent::StepStarted { step: SetupStep::Extensions });
        self.install_extensions(app).await?;
        emit_progress(app, SetupEvent::StepCompleted { step: SetupStep::Extensions });

        // Step 4: Write default settings
        self.write_default_settings()?;

        emit_progress(app, SetupEvent::SetupComplete);
        Ok(())
    }
}

/// Helper that doesn't fail setup on emit errors
fn emit_progress(app: &tauri::AppHandle, event: SetupEvent) {
    if let Err(e) = app.emit("setup-progress", &event) {
        tracing::warn!("Failed to emit progress event: {}", e);
    }
}
```

---

## Download URLs

### Bun Binary Downloads

| Platform    | URL                                                                                  |
| ----------- | ------------------------------------------------------------------------------------ |
| Linux x64   | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64.zip`      |
| Linux arm64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-aarch64.zip`  |
| macOS x64   | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-darwin-x64.zip`     |
| macOS arm64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-darwin-aarch64.zip` |
| Windows x64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-windows-x64.zip`    |

### code-server Installation

```bash
bun add --cwd <runtime-dir> code-server@4.106.2
```

### Extension Installation

```bash
bun --cwd <runtime-dir> x code-server \
    --install-extension Anthropic.claude-code@2.0.50 \
    --extensions-dir <runtime-dir>/extensions
```

---

## Key Decisions

| Aspect                     | Decision                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| **Architecture**           | Single global code-server instance for all workspaces              |
| **Behavior**               | Mirrors native VSCode (one installation, multiple windows)         |
| **Runtime**                | Bun (cross-platform, single binary, npm compatible)                |
| **code-server source**     | npm package (run via `bun --cwd <runtime> x code-server`)          |
| **Auth**                   | `--auth none` (localhost binding only)                             |
| **Extensions**             | Downloaded via code-server's `--install-extension` on first launch |
| **User-data-dir**          | Single shared directory for all workspaces                         |
| **Per-workspace state**    | Managed by VSCode in `workspaceStorage/` (automatic)               |
| **Per-workspace settings** | Via `.vscode/settings.json` in each repository                     |
| **Port**                   | Single port starting at 50000                                      |
| **Testing**                | Unit tests only, mock external dependencies                        |
| **Extension failures**     | Hard fail (same as Bun/code-server failures)                       |

---

## Directory Structure

### Runtime Directory

The runtime directory is versioned by app version. The directory's existence indicates setup is complete.

**Development (Debug builds):** `./app-data/<app-version>/`
**Production (Release builds):** Platform-specific user data directory

```
Linux:   ~/.local/share/chime/<app-version>/
macOS:   ~/Library/Application Support/Chime/<app-version>/
Windows: %APPDATA%\Chime\<app-version>\
```

### Runtime Directory Layout

```
<app-version>/
├── bun                         # Bun binary (bun.exe on Windows)
├── node_modules/               # code-server + dependencies
│   └── code-server/
├── extensions/                 # Installed VSCode extensions
│   └── Anthropic.claude-code/
└── user-data/                  # Single shared user-data-dir for ALL workspaces
    ├── User/
    │   ├── settings.json       # Default VSCode settings (written on first use)
    │   └── keybindings.json    # Default keybindings (written on first use)
    └── workspaceStorage/       # Per-folder state (managed automatically by VSCode)
        ├── <hash-of-folder-a>/ # State for workspace A (tabs, cursors, etc.)
        └── <hash-of-folder-b>/ # State for workspace B
```

**Note:** Default settings and keybindings are written directly to `user-data/User/` on first use if they don't already exist.

**Note:** The `workspaceStorage/` directory is managed automatically by VSCode. Each folder opened via `?folder=` parameter gets its own storage keyed by a hash of the folder path. This means:

- Open files/tabs are preserved per workspace
- Cursor positions are preserved per workspace
- Terminal sessions are per workspace
- Undo history is per workspace

---

## code-server Invocation

Single instance started once on app launch:

```bash
<runtime-dir>/bun --cwd <runtime-dir> x code-server \
    --bind-addr 127.0.0.1:<port> \
    --auth none \
    --user-data-dir <runtime-dir>/user-data \
    --extensions-dir <runtime-dir>/extensions \
    --disable-telemetry \
    --disable-update-check \
    --disable-workspace-trust
```

**Note:** No `<workspace-path>` argument - the folder is specified via URL parameter.

**Port allocation:** Starts at 50000, increments until an available port is found.

**Workspace URLs:** Each workspace is accessed via:

```
http://localhost:<port>/?folder=<encoded-workspace-path>
```

---

## First Launch Flow

```
App Launch
    │
    ▼
┌─────────────────────────────────────────┐
│ Check <app-version>/ directory exists?  │
└─────────────────────────────────────────┘
    │ No                          │ Yes
    ▼                             │
┌─────────────────────────┐       │
│ Show setup modal        │       │
│ Download Bun (~40MB)    │       │
│ Verify checksum         │       │
│ Extract + set perms     │       │
└─────────────────────────┘       │
    │                             │
    ▼                             │
┌─────────────────────────┐       │
│ Run: bun add --cwd      │       │
│ <runtime> code-server   │       │
│ (~100MB download)       │       │
└─────────────────────────┘       │
    │                             │
    ▼                             │
┌─────────────────────────┐       │
│ Run: bun --cwd x        │       │
│ code-server             │       │
│ --install-extension     │       │
│ --extensions-dir        │       │
│ (for each extension)    │       │
└─────────────────────────┘       │
    │                             │
    ▼                             │
┌─────────────────────────┐       │
│ Write default settings  │       │
│ and keybindings to      │       │
│ user-data/User/         │       │
└─────────────────────────┘       │
    │                             │
    ▼                             ▼
┌─────────────────────────────────────────┐
│ Start single code-server instance       │
│ Wait for health check                   │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ Ready - Show main UI                    │
└─────────────────────────────────────────┘
```

**Failure handling:** If any step fails (Bun download, checksum verification, code-server install, or extension install), show error and allow retry. All failures are treated the same - hard fail with retry option.

---

## Setup UI (Blocking Modal)

### Layout

```
┌─────────────────────────────────────┐
│                                     │
│        Setting up Chime             │
│                                     │
│  [Caption - changes per step]       │
│  [Progress bar - resets each step]  │
│                                     │
│  [Icon]  Bun runtime                │
│  [Icon]  code-server                │
│  [Icon]  Extensions                 │
│                                     │
│  [Error message - if failed]        │
│  [Retry button - if failed]         │
│                                     │
└─────────────────────────────────────┘
```

### Step States

| State       | Icon | Visual                                  |
| ----------- | ---- | --------------------------------------- |
| Pending     | `○`  | Empty circle (gray/dim)                 |
| In Progress | `●`  | Filled circle (pulsing animation, blue) |
| Complete    | `✓`  | Checkmark (green)                       |
| Failed      | `✗`  | X (red)                                 |

### Captions

| Step                    | Caption                      |
| ----------------------- | ---------------------------- |
| Bun in progress         | "Downloading Bun runtime..." |
| code-server in progress | "Downloading code-server..." |
| Extensions in progress  | "Downloading extensions..."  |
| All complete            | "Setup complete!"            |
| Any step failed         | "Setup failed!"              |

### Progress Bar Behavior

- Progress bar resets to 0% at the start of each step
- Shows percentage progress during download
- Reaches 100% when step completes

---

## Architecture

### Constants

```rust
use std::time::Duration;

/// Health check configuration
const HEALTH_CHECK_ATTEMPTS: u32 = 300;
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// Graceful shutdown timeout before force kill
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Starting port for code-server
const PORT_RANGE_START: u16 = 50000;
```

### Path Helper

```rust
/// Convert a Path to &str, returning CodeServerError on non-UTF8 paths
fn path_to_str(path: &Path) -> Result<&str, CodeServerError> {
    path.to_str().ok_or_else(|| {
        CodeServerError::InvalidPath(format!("Non-UTF8 path: {:?}", path))
    })
}
```

### Instance State

```rust
#[derive(Debug)]
pub enum InstanceState {
    Stopped,
    Starting,
    Running { child: Box<dyn TokioChildWrapper> },
    Stopping,
    Failed { error: String },
}
```

### CodeServerConfig

```rust
/// Configuration for code-server (immutable after creation)
pub struct CodeServerConfig {
    pub runtime_dir: PathBuf,       // <app-version>/ directory
    pub bun_binary_path: PathBuf,   // <runtime>/bun or bun.exe
    pub extensions_dir: PathBuf,    // <runtime>/extensions
    pub user_data_dir: PathBuf,     // <runtime>/user-data/
    pub port_start: u16,            // 50000
}

impl CodeServerConfig {
    pub fn new(app_handle: &tauri::AppHandle, app_version: &str) -> Result<Self, CodeServerError> {
        let platform = Platform::current().ok_or(CodeServerError::UnsupportedPlatform)?;
        let runtime_dir = crate::platform::get_data_dir(app_handle, app_version)?;

        Ok(Self {
            bun_binary_path: runtime_dir.join(platform.bun_binary_name()),
            extensions_dir: runtime_dir.join("extensions"),
            user_data_dir: runtime_dir.join("user-data"),
            port_start: 50000,
            runtime_dir,
        })
    }
}
```

### CodeServerInstance

```rust
/// Single global code-server instance
pub struct CodeServerInstance {
    port: u16,
    state: InstanceState,
}

impl CodeServerInstance {
    /// Get URL for any workspace folder
    /// Handles Windows paths by converting them to URL-compatible format
    pub fn url_for_folder(&self, folder_path: &Path) -> String {
        let path_str = if cfg!(windows) {
            // Convert C:\Users\... to /C:/Users/... for URL compatibility
            let s = folder_path.to_string_lossy();
            if s.chars().nth(1) == Some(':') {
                format!("/{}", s.replace('\\', "/"))
            } else {
                s.replace('\\', "/")
            }
        } else {
            folder_path.to_string_lossy().to_string()
        };

        let encoded = crate::platform::encode_path_for_url(std::path::Path::new(&path_str));
        format!("http://localhost:{}/?folder={}", self.port, encoded)
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, InstanceState::Running { .. })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}
```

### CodeServerManager

```rust
/// Manages the single global code-server instance
pub struct CodeServerManager {
    config: Arc<CodeServerConfig>,
    instance: tokio::sync::RwLock<Option<CodeServerInstance>>,
}

impl CodeServerManager {
    pub fn new(config: CodeServerConfig) -> Self {
        Self {
            config: Arc::new(config),
            instance: tokio::sync::RwLock::new(None),
        }
    }

    /// Ensure the code-server instance is running
    pub async fn ensure_running(&self) -> Result<(), CodeServerError> {
        let mut instance = self.instance.write().await;

        // Check current state and handle accordingly
        match instance.as_ref().map(|i| &i.state) {
            Some(InstanceState::Running { .. }) => return Ok(()),
            Some(InstanceState::Starting) => {
                return Err(CodeServerError::InvalidStateTransition);
            }
            _ => {}
        }

        // Transition to Starting state
        let port = self.find_available_port()?;
        *instance = Some(CodeServerInstance {
            port,
            state: InstanceState::Starting,
        });

        // Build command arguments (using path_to_str to avoid unwrap panics)
        let runtime_dir_str = path_to_str(&self.config.runtime_dir)?;
        let user_data_dir_str = path_to_str(&self.config.user_data_dir)?;
        let extensions_dir_str = path_to_str(&self.config.extensions_dir)?;
        let bind_addr = format!("127.0.0.1:{}", port);

        let args = vec![
            "--cwd", runtime_dir_str,
            "x", "code-server",
            "--bind-addr", &bind_addr,
            "--auth", "none",
            "--user-data-dir", user_data_dir_str,
            "--extensions-dir", extensions_dir_str,
            "--disable-telemetry",
            "--disable-update-check",
            "--disable-workspace-trust",
        ];

        // Spawn process
        let child = crate::platform::spawn_code_server(
            &self.config.bun_binary_path,
            &args,
            &self.config.runtime_dir,
        ).await?;

        // Wait for health check
        self.wait_for_ready(port).await?;

        // Transition to Running state
        if let Some(inst) = instance.as_mut() {
            inst.state = InstanceState::Running { child };
        }

        Ok(())
    }

    /// Stop the code-server instance with graceful shutdown
    pub async fn stop(&self) -> Result<(), CodeServerError> {
        let mut instance = self.instance.write().await;

        if let Some(mut inst) = instance.take() {
            if let InstanceState::Running { mut child } = inst.state {
                // process-wrap handles cross-platform termination:
                // - Unix: signals are sent to the process group
                // - Windows: job object is terminated

                // Wait up to GRACEFUL_SHUTDOWN_TIMEOUT for graceful shutdown
                let timeout = tokio::time::timeout(
                    GRACEFUL_SHUTDOWN_TIMEOUT,
                    child.wait()
                ).await;

                if timeout.is_err() {
                    // Force kill if graceful shutdown didn't work
                    child.kill().await
                        .map_err(|e| CodeServerError::ProcessKillFailed(e.to_string()))?;
                    child.wait().await
                        .map_err(|e| CodeServerError::ProcessKillFailed(e.to_string()))?;
                }
            }
        }

        Ok(())
    }

    /// Get URL for a workspace folder
    pub async fn url_for_folder(&self, folder_path: &Path) -> Option<String> {
        let instance = self.instance.read().await;
        instance.as_ref()
            .filter(|i| i.is_running())
            .map(|i| i.url_for_folder(folder_path))
    }

    /// Check if instance is running
    pub async fn is_running(&self) -> bool {
        let instance = self.instance.read().await;
        instance.as_ref().map(|i| i.is_running()).unwrap_or(false)
    }

    fn find_available_port(&self) -> Result<u16, CodeServerError> {
        let mut port = PORT_RANGE_START;
        loop {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return Ok(port);
            }
            port = port.checked_add(1)
                .ok_or(CodeServerError::NoAvailablePorts { start: PORT_RANGE_START })?;
        }
    }

    async fn wait_for_ready(&self, port: u16) -> Result<(), CodeServerError> {
        let url = format!("http://127.0.0.1:{}/healthz", port);
        let client = reqwest::Client::new();

        for _ in 0..HEALTH_CHECK_ATTEMPTS {
            if client.get(&url).send().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
        }

        Err(CodeServerError::HealthCheckFailed { attempts: HEALTH_CHECK_ATTEMPTS })
    }
}
```

---

## Integration with AppState

Updated `AppState` structure in `lib.rs`:

```rust
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
}
```

### Tauri Commands

```rust
#[tauri::command]
async fn check_runtime_ready(app: tauri::AppHandle) -> Result<bool, String> {
    let config = CodeServerConfig::new(&app, env!("CARGO_PKG_VERSION"))
        .map_err(|e| e.to_string())?;
    let bootstrapper = RuntimeBootstrapper::new(config);
    Ok(bootstrapper.is_ready())
}

#[tauri::command]
async fn setup_runtime(app: tauri::AppHandle) -> Result<(), String> {
    let config = CodeServerConfig::new(&app, env!("CARGO_PKG_VERSION"))
        .map_err(|e| e.to_string())?;
    let bootstrapper = RuntimeBootstrapper::new(config);
    bootstrapper.ensure_ready(&app).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_code_server_running(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.code_server_manager.ensure_running().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_workspace_url(
    state: tauri::State<'_, AppState>,
    folder_path: String,
) -> Result<Option<String>, String> {
    let path = std::path::Path::new(&folder_path);
    Ok(state.code_server_manager.url_for_folder(path).await)
}
```

---

## Workspace Switching (Frontend)

When user switches between workspaces:

1. **Keep iframes alive** - don't destroy them, just hide
2. **Show the selected workspace's iframe**
3. **Instant switching** - no process startup, no health check

```svelte
<script>
  let workspaces = ['path/to/workspace1', 'path/to/workspace2'];
  let activeWorkspace = workspaces[0];

  function switchWorkspace(path) {
    activeWorkspace = path;
  }
</script>

{#each workspaces as workspace (workspace)}
  <iframe
    src="http://localhost:{port}/?folder={encodeURIComponent(workspace)}"
    class:hidden={workspace !== activeWorkspace}
  />
{/each}
```

**Benefits:**

- Each iframe maintains its own VSCode window state (tabs, cursors, terminals)
- Switching is instant (just CSS visibility change)
- Matches native VSCode behavior (multiple windows)

---

## Default VSCode Settings

The following settings are written directly to `<runtime>/user-data/User/settings.json` on first use (if the file doesn't already exist):

```json
{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark+",
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "window.menuBarVisibility": "hidden"
}
```

### Settings Explanation

| Setting                    | Value             | Purpose                                                                         |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `workbench.startupEditor`  | `"none"`          | Don't show welcome tab or recent files on startup - cleaner embedded experience |
| `workbench.colorTheme`     | `"Default Dark+"` | Consistent dark theme matching Chime's UI                                       |
| `extensions.autoUpdate`    | `false`           | We control extension versions via pinned versions - prevent unexpected updates  |
| `telemetry.telemetryLevel` | `"off"`           | Privacy - don't send telemetry to Microsoft                                     |
| `window.menuBarVisibility` | `"hidden"`        | Hide VSCode menu bar since it's embedded in iframe (Chime provides its own UI)  |

### User Settings

Users can customize settings at two levels:

1. **Global** (applies to all workspaces): `<runtime>/user-data/User/settings.json`
2. **Per-workspace** (overrides global): `.vscode/settings.json` in the workspace directory

---

## Default Keybindings

The following keybindings are written directly to `<runtime>/user-data/User/keybindings.json` on first use (if the file doesn't already exist):

```json
[
  {
    "key": "alt+c",
    "command": "claude-vscode.focus"
  }
]
```

### Keybindings Explanation

| Key     | Command               | Purpose                                     |
| ------- | --------------------- | ------------------------------------------- |
| `Alt+C` | `claude-vscode.focus` | Quickly focus the Claude Code panel/sidebar |

Users can override or add keybindings in `<runtime>/user-data/User/keybindings.json`.

---

## Implementation Phases

Each phase includes its own unit tests. **All tests must pass before moving to the next phase.**

### Phase 0: Migration (Preparation)

- [ ] Add `thiserror` dependency
- [ ] Create `CodeServerError` enum
- [ ] Migrate existing `String` errors to `CodeServerError`
- [ ] Add `process-wrap` dependency
- [ ] Remove existing `ProcessManager` (will be replaced)
- [ ] **Tests:** Verify error types compile and display correctly
- [ ] **Run `cargo test` - all tests must pass**

### Phase 1: Platform Module

- [ ] Create `platform/` module structure
- [ ] Implement `Platform` enum and detection
- [ ] Implement download URLs and checksums
- [ ] Implement path encoding and normalization
- [ ] Implement process spawning with `process-wrap`
- [ ] Implement `set_executable` and `remove_quarantine`
- [ ] **Tests:**
  - [ ] `test_platform_detection_linux_x64`
  - [ ] `test_platform_detection_macos_arm64`
  - [ ] `test_platform_detection_windows`
  - [ ] `test_platform_detection_unsupported`
  - [ ] `test_bun_download_url_format`
  - [ ] `test_bun_binary_name_windows_has_exe`
  - [ ] `test_bun_binary_name_unix_no_extension`
  - [ ] `test_path_encoding_spaces`
  - [ ] `test_path_encoding_special_chars`
  - [ ] `test_path_normalization_success`
  - [ ] `test_path_normalization_error_on_nonexistent`
- [ ] **Run `cargo test` - all tests must pass**

### Phase 2: Config and Directory Setup

- [ ] Implement `CodeServerConfig::new()` with platform detection
- [ ] Implement `get_data_dir()` for debug/release modes
- [ ] Create runtime directory structure
- [ ] **Tests:**
  - [ ] `test_config_new_creates_valid_paths`
  - [ ] `test_get_data_dir_debug_mode`
  - [ ] `test_get_data_dir_release_mode` (if testable)
- [ ] **Run `cargo test` - all tests must pass**

### Phase 3: Runtime Setup (Bun + code-server)

- [ ] Implement `RuntimeBootstrapper`
- [ ] Implement Bun download with checksum verification
- [ ] Implement ZIP extraction
- [ ] Implement `bun add --cwd <runtime> code-server@version`
- [ ] Implement progress events
- [ ] Write default settings directly to `user-data/User/settings.json`
- [ ] Write default keybindings directly to `user-data/User/keybindings.json`
- [ ] **Tests:**
  - [ ] `test_checksum_verification_success` (mock HTTP)
  - [ ] `test_checksum_verification_mismatch` (mock HTTP)
  - [ ] `test_download_network_error` (mock HTTP)
  - [ ] `test_is_ready_returns_false_when_missing`
  - [ ] `test_is_ready_returns_true_when_complete`
  - [ ] `test_write_default_settings_creates_file`
  - [ ] `test_write_default_settings_skips_existing`
  - [ ] `test_zip_extraction_invalid_archive`
  - [ ] `test_zip_extraction_permission_denied`
- [ ] **Run `cargo test` - all tests must pass**

### Phase 4: Extension Installation

- [ ] Implement extension installation via code-server CLI with `--extensions-dir`
- [ ] Iterate over extensions HashMap
- [ ] Handle installation errors (hard fail)
- [ ] **Tests:**
  - [ ] `test_extension_install_command_format`
  - [ ] `test_extension_install_iterates_all`
  - [ ] `test_extension_install_timeout`
- [ ] **Run `cargo test` - all tests must pass**

### Phase 5: Setup UI

- [ ] Create setup modal component (Svelte)
- [ ] Listen to `setup-progress` events
- [ ] Implement progress bar with step states
- [ ] Add retry functionality
- [ ] Auto-dismiss on completion
- [ ] **Tests:** Manual UI testing (Svelte components)
- [ ] **Run `pnpm check` - TypeScript must pass**

### Phase 6: CodeServerManager Implementation

- [ ] Implement `InstanceState` enum
- [ ] Implement `CodeServerInstance`
- [ ] Implement `CodeServerManager` with single instance
- [ ] Port allocation starting at 50000
- [ ] Health check polling
- [ ] Integration with `AppState`
- [ ] **Tests:**
  - [ ] `test_is_running_when_running`
  - [ ] `test_is_running_when_stopped`
  - [ ] `test_is_running_when_starting`
  - [ ] `test_ensure_running_starts_instance` (mock process)
  - [ ] `test_ensure_running_noop_when_running`
  - [ ] `test_ensure_running_concurrent_calls_single_instance`
  - [ ] `test_stop_kills_process` (mock process)
  - [ ] `test_stop_noop_when_not_running`
  - [ ] `test_stop_during_starting_state`
  - [ ] `test_state_transitions_are_atomic`
  - [ ] `test_url_for_folder_returns_encoded_url`
  - [ ] `test_url_for_folder_none_when_not_running`
  - [ ] `test_url_for_folder_windows_path_conversion`
  - [ ] `test_port_allocation_finds_available`
  - [ ] `test_port_allocation_skips_unavailable`
  - [ ] `test_health_check_timeout` (mock HTTP)
  - [ ] `test_spawn_failure` (mock process)
  - [ ] `test_process_dies_during_health_check`
  - [ ] `test_graceful_shutdown_timeout_then_kill`
- [ ] **Run `cargo test` - all tests must pass**

### Phase 7: Frontend Workspace Switching

- [ ] Implement iframe-per-workspace pattern
- [ ] Keep iframes alive when hidden
- [ ] Instant workspace switching via CSS visibility
- [ ] **Tests:** Manual UI testing
- [ ] **Run `pnpm check` - TypeScript must pass**

### Phase 8: Final Validation

- [ ] **Run `pnpm validate:full` - all checks must pass**
- [ ] Manual end-to-end testing of complete flow
- [ ] Verify first-launch setup works
- [ ] Verify workspace switching works
- [ ] Verify code-server cleanup on app exit

---

## Testing Strategy

### Unit Tests Only (No Integration Tests)

All external dependencies are mocked via traits. **Tests are distributed across implementation phases** - each phase includes its own tests that must pass before moving to the next phase.

### Mock Traits

All async traits require the `async-trait` crate for compatibility with `mockall`:

```rust
use async_trait::async_trait;
use std::path::Path;
use std::process::ExitStatus;

/// Trait for HTTP operations (mockable)
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait HttpClient: Send + Sync {
    async fn download(&self, url: &str) -> Result<Vec<u8>, reqwest::Error>;
    async fn download_with_progress(
        &self,
        url: &str,
        on_progress: Box<dyn Fn(u64, u64) + Send>,
    ) -> Result<Vec<u8>, reqwest::Error>;
}

/// Trait for filesystem operations (mockable)
#[cfg_attr(test, mockall::automock)]
pub trait FileSystem: Send + Sync {
    fn exists(&self, path: &Path) -> bool;
    fn create_dir_all(&self, path: &Path) -> Result<(), std::io::Error>;
    fn write(&self, path: &Path, contents: &[u8]) -> Result<(), std::io::Error>;
    fn read(&self, path: &Path) -> Result<Vec<u8>, std::io::Error>;
    fn read_to_string(&self, path: &Path) -> Result<String, std::io::Error>;
    fn set_permissions(&self, path: &Path, mode: u32) -> Result<(), std::io::Error>;
    fn remove_dir_all(&self, path: &Path) -> Result<(), std::io::Error>;
}

/// Trait for port checking (mockable)
#[cfg_attr(test, mockall::automock)]
pub trait PortChecker: Send + Sync {
    fn is_available(&self, port: u16) -> bool;
}

/// Trait for process spawning (mockable)
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait ProcessSpawner: Send + Sync {
    async fn spawn(
        &self,
        binary: &Path,
        args: &[&str],
        cwd: &Path,
    ) -> Result<Box<dyn ProcessHandle>, CodeServerError>;
}

/// Trait for process handle operations (mockable)
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait ProcessHandle: Send + Sync {
    async fn kill(&mut self) -> Result<(), std::io::Error>;
    async fn wait(&mut self) -> Result<ExitStatus, std::io::Error>;
    fn try_wait(&mut self) -> Result<Option<ExitStatus>, std::io::Error>;
    fn id(&self) -> Option<u32>;
}
```

### Test Distribution by Phase

See **Implementation Phases** section above for the complete list of tests per phase. Key principles:

1. **Each phase has its own tests** - tests are written alongside the code they verify
2. **All tests must pass before moving to the next phase** - run `cargo test` at the end of each Rust phase
3. **Frontend phases use `pnpm check`** - TypeScript type checking validates Svelte components
4. **Final validation uses `pnpm validate:full`** - runs all checks (Rust + TypeScript + linting)

---

## Required Dependencies

Add dependencies via `cargo add` (do not manually edit `Cargo.toml`):

```bash
# Error handling
cargo add thiserror

# Process management (cross-platform, no unsafe)
cargo add process-wrap --features tokio1,process-group,job-object

# Checksums
cargo add sha2

# URL encoding
cargo add percent-encoding

# Async traits for mockable interfaces
cargo add async-trait

# HTTP client (already present, ensure stream feature)
cargo add reqwest --features stream

# Dev dependencies
cargo add --dev mockall tempfile
```

---

## Error Handling

### All Setup Failures are Hard Failures

Any failure during setup (Bun download, checksum verification, code-server install, or extension install) results in:

1. Setup modal shows "Setup failed!" caption
2. Failed step shows `✗` icon
3. Error message displayed
4. Retry button shown
5. User must retry or close app

### Runtime Failures

- **Port unavailable:** Try next port automatically
- **Health check timeout:** Report error, allow retry
- **Process crash:** Detect via `child.wait()`, report to user

---

## Security Considerations

- **`--auth none`** is safe because we bind to `127.0.0.1` only
- **No external network access** to code-server instances
- **Tauri webview** connects via localhost
- **Binary verification** via SHA256 checksum before execution
- **Process isolation** via process groups (Unix) / job objects (Windows)

### Security Notes

Update `tauri.conf.json` to enable CSP with all required directives for code-server:

```json
"security": {
    "csp": "default-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' http://127.0.0.1:* data:; img-src 'self' http://127.0.0.1:* data: blob:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:*"
}
```

**CSP Directive Explanations:**

- `frame-src`: Allow embedding code-server iframes from localhost
- `script-src 'unsafe-inline' 'unsafe-eval'`: Required by VSCode/code-server internals
- `style-src 'unsafe-inline'`: Required for code-server's dynamic styles
- `font-src data:`: Required for code-server's embedded fonts
- `img-src blob: data:`: Required for code-server's icons and images
- `connect-src ws:// wss://`: Required for code-server's WebSocket connections

---

## Out of Scope

The following are explicitly **not** planned:

- **Offline mode**: Internet access is required for AI agents anyway
- **Custom extension management**: Users can install additional extensions directly via VSCode UI
- **Automatic version updates**: Versions are pinned and manually updated
- **Per-project settings**: Global settings + per-workspace `.vscode/settings.json` is sufficient
- **Multiple code-server instances**: Single instance mirrors native VSCode behavior
