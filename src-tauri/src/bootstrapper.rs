//! Runtime bootstrapper for code-server setup.
//!
//! This module provides:
//! - `RuntimeBootstrapper` - orchestrates first-launch setup
//! - Mockable traits for HTTP, filesystem, process, and event operations
//! - Download with checksum verification
//! - Archive extraction (ZIP for Windows, tar.gz/tar.xz for Unix)
//! - code-server installation via `npm install`
//! - Extension installation via code-server CLI
//! - Default settings and keybindings generation
//!
//! ## Architecture
//!
//! The bootstrapper uses trait-based dependency injection to enable testing:
//! - `HttpClient` - for downloading files
//! - `FileSystem` - for filesystem operations
//! - `ArchiveExtractor` - for extracting archives (ZIP, tar.gz, tar.xz)
//! - `ProcessSpawner` - for running external processes (npm, code-server)
//! - `EventEmitter` - for emitting progress events
//!
//! Production implementations use real system calls, while tests can use mocks.

use crate::config::CodeServerConfig;
use crate::error::CodeServerError;
use crate::setup::{SetupEvent, StepState, StepsBuilder};
use crate::platform::{prepare_binary, Platform};
use crate::runtime_versions::{get_required_extensions, CODE_SERVER_VERSION};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::time::Duration;

/// Default timeout for code-server installation (5 minutes).
const CODE_SERVER_INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Default timeout for extension installation (2 minutes per extension).
const EXTENSION_INSTALL_TIMEOUT: Duration = Duration::from_secs(120);

// ============================================================================
// Traits for Dependency Injection
// ============================================================================

/// Trait for HTTP operations (mockable).
///
/// Note: `download_with_progress` is not in the trait because mockall doesn't
/// support mocking Fn objects. Use the concrete implementation when progress
/// reporting is needed.
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait HttpClient: Send + Sync {
    /// Download a file from a URL.
    async fn download(&self, url: &str) -> Result<Vec<u8>, CodeServerError>;
}

/// Trait for filesystem operations (mockable).
#[cfg_attr(test, mockall::automock)]
pub trait FileSystem: Send + Sync {
    /// Check if a path exists.
    fn exists(&self, path: &Path) -> bool;

    /// Create a directory and all parent directories.
    fn create_dir_all(&self, path: &Path) -> Result<(), std::io::Error>;

    /// Write bytes to a file.
    fn write(&self, path: &Path, contents: &[u8]) -> Result<(), std::io::Error>;

    /// Read bytes from a file.
    fn read(&self, path: &Path) -> Result<Vec<u8>, std::io::Error>;

    /// Read a file as a string.
    fn read_to_string(&self, path: &Path) -> Result<String, std::io::Error>;

    /// Remove a directory and all its contents.
    fn remove_dir_all(&self, path: &Path) -> Result<(), std::io::Error>;
}

/// Trait for archive extraction (mockable).
#[cfg_attr(test, mockall::automock)]
pub trait ArchiveExtractor: Send + Sync {
    /// Extract an archive to a destination directory.
    ///
    /// Supports ZIP (Windows), tar.gz (macOS), and tar.xz (Linux).
    /// Returns the path to the extracted directory containing binaries.
    fn extract_archive(
        &self,
        archive_data: &[u8],
        dest_dir: &Path,
        archive_name: &str,
        extension: &str,
    ) -> Result<std::path::PathBuf, CodeServerError>;
}

/// Trait for event emission (mockable).
#[cfg_attr(test, mockall::automock)]
pub trait EventEmitter: Send + Sync {
    /// Emit a setup event.
    fn emit(&self, event: SetupEvent);
}

/// Result of a process execution.
#[derive(Debug, Clone)]
pub struct ProcessResult {
    /// Exit code of the process.
    pub exit_code: i32,
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
}

/// Trait for spawning processes (mockable).
///
/// Note: This trait uses synchronous methods to enable mocking with mockall,
/// since mockall doesn't support async traits well. The production implementation
/// uses tokio::process internally.
#[cfg_attr(test, mockall::automock)]
pub trait ProcessSpawner: Send + Sync {
    /// Spawn a process and wait for it to complete with a timeout.
    ///
    /// # Arguments
    ///
    /// * `binary` - Path to the binary to execute
    /// * `args` - Command line arguments
    /// * `cwd` - Working directory
    /// * `timeout` - Maximum time to wait for the process
    ///
    /// # Returns
    ///
    /// The process result including exit code, stdout, and stderr.
    fn spawn_and_wait(
        &self,
        binary: &Path,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ProcessResult, CodeServerError>;
}

// ============================================================================
// Production Implementations
// ============================================================================

/// Production HTTP client using reqwest.
pub struct ReqwestHttpClient {
    client: reqwest::Client,
}

impl ReqwestHttpClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ReqwestHttpClient {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HttpClient for ReqwestHttpClient {
    async fn download(&self, url: &str) -> Result<Vec<u8>, CodeServerError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| CodeServerError::DownloadFailed {
                component: url.to_string(),
                source: e,
            })?;

        let bytes = response
            .bytes()
            .await
            .map_err(|e| CodeServerError::DownloadFailed {
                component: url.to_string(),
                source: e,
            })?;

        Ok(bytes.to_vec())
    }
}

impl ReqwestHttpClient {
    /// Download a file with progress callback.
    ///
    /// This is not part of the HttpClient trait because mockall doesn't support
    /// mocking Fn objects.
    pub async fn download_with_progress(
        &self,
        url: &str,
        on_progress: impl Fn(u64, u64) + Send,
    ) -> Result<Vec<u8>, CodeServerError> {
        use futures::StreamExt;

        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| CodeServerError::DownloadFailed {
                component: url.to_string(),
                source: e,
            })?;

        let total_size = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut data = Vec::with_capacity(total_size as usize);

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CodeServerError::DownloadFailed {
                component: url.to_string(),
                source: e,
            })?;
            data.extend_from_slice(&chunk);
            downloaded += chunk.len() as u64;
            on_progress(downloaded, total_size);
        }

        Ok(data)
    }
}

/// Production filesystem implementation using std::fs.
pub struct StdFileSystem;

impl FileSystem for StdFileSystem {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn create_dir_all(&self, path: &Path) -> Result<(), std::io::Error> {
        std::fs::create_dir_all(path)
    }

    fn write(&self, path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
        std::fs::write(path, contents)
    }

    fn read(&self, path: &Path) -> Result<Vec<u8>, std::io::Error> {
        std::fs::read(path)
    }

    fn read_to_string(&self, path: &Path) -> Result<String, std::io::Error> {
        std::fs::read_to_string(path)
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), std::io::Error> {
        std::fs::remove_dir_all(path)
    }
}

/// Production archive extractor supporting ZIP, tar.gz, and tar.xz.
pub struct ArchiveExtractorImpl;

impl ArchiveExtractor for ArchiveExtractorImpl {
    fn extract_archive(
        &self,
        archive_data: &[u8],
        dest_dir: &Path,
        archive_name: &str,
        extension: &str,
    ) -> Result<std::path::PathBuf, CodeServerError> {
        match extension {
            ".zip" => self.extract_zip(archive_data, dest_dir, archive_name),
            ".tar.gz" => self.extract_tar_gz(archive_data, dest_dir, archive_name),
            ".tar.xz" => self.extract_tar_xz(archive_data, dest_dir, archive_name),
            _ => Err(CodeServerError::ExtractionFailed(format!(
                "Unsupported archive format: {extension}"
            ))),
        }
    }
}

impl ArchiveExtractorImpl {
    fn extract_zip(
        &self,
        archive_data: &[u8],
        dest_dir: &Path,
        archive_name: &str,
    ) -> Result<std::path::PathBuf, CodeServerError> {
        let cursor = Cursor::new(archive_data);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| CodeServerError::ExtractionFailed(e.to_string()))?;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| CodeServerError::ExtractionFailed(e.to_string()))?;

            let outpath = match file.enclosed_name() {
                Some(path) => dest_dir.join(path),
                None => continue,
            };

            if file.is_dir() {
                std::fs::create_dir_all(&outpath)
                    .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to create directory: {e}")))?;
            } else {
                if let Some(parent) = outpath.parent() {
                    if !parent.exists() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            CodeServerError::ExtractionFailed(format!("Failed to create parent directory: {e}"))
                        })?;
                    }
                }

                let mut outfile = std::fs::File::create(&outpath)
                    .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to create file: {e}")))?;

                let mut buffer = Vec::new();
                file.read_to_end(&mut buffer)
                    .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to read from archive: {e}")))?;

                outfile
                    .write_all(&buffer)
                    .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to write file: {e}")))?;
            }
        }

        // Return the extracted directory (e.g., node-v24.11.1-win-x64)
        Ok(dest_dir.join(archive_name))
    }

    fn extract_tar_gz(
        &self,
        archive_data: &[u8],
        dest_dir: &Path,
        archive_name: &str,
    ) -> Result<std::path::PathBuf, CodeServerError> {
        use flate2::read::GzDecoder;

        let cursor = Cursor::new(archive_data);
        let decoder = GzDecoder::new(cursor);
        let mut archive = tar::Archive::new(decoder);

        archive
            .unpack(dest_dir)
            .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to extract tar.gz: {e}")))?;

        Ok(dest_dir.join(archive_name))
    }

    fn extract_tar_xz(
        &self,
        archive_data: &[u8],
        dest_dir: &Path,
        archive_name: &str,
    ) -> Result<std::path::PathBuf, CodeServerError> {
        use xz2::read::XzDecoder;

        let cursor = Cursor::new(archive_data);
        let decoder = XzDecoder::new(cursor);
        let mut archive = tar::Archive::new(decoder);

        archive
            .unpack(dest_dir)
            .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to extract tar.xz: {e}")))?;

        Ok(dest_dir.join(archive_name))
    }
}

// Alias for backward compatibility in tests
pub type ZipExtractor = ArchiveExtractorImpl;

/// No-op event emitter for when events are not needed.
pub struct NoOpEventEmitter;

impl EventEmitter for NoOpEventEmitter {
    fn emit(&self, _event: SetupEvent) {
        // Do nothing
    }
}

/// Production process spawner using std::process.
pub struct StdProcessSpawner;

impl ProcessSpawner for StdProcessSpawner {
    fn spawn_and_wait(
        &self,
        binary: &Path,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ProcessResult, CodeServerError> {
        use std::process::{Command, Stdio};
        use std::time::Instant;

        // Prepend the binary's directory to PATH so child processes use our Node
        let bin_dir = binary.parent();
        let path_env = if let Some(dir) = bin_dir {
            let current_path = std::env::var("PATH").unwrap_or_default();
            format!("{}:{}", dir.display(), current_path)
        } else {
            std::env::var("PATH").unwrap_or_default()
        };

        // Set npm_config_user_agent to report our Node version
        // code-server's postinstall script parses this to check Node version
        let user_agent = format!(
            "npm/10.9.4 node/v{} {} {}",
            crate::runtime_versions::NODE_VERSION,
            std::env::consts::OS,
            std::env::consts::ARCH
        );

        let start = Instant::now();
        let mut child = Command::new(binary)
            .args(args)
            .current_dir(cwd)
            .env("PATH", path_env)
            .env("npm_config_user_agent", user_agent)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(CodeServerError::SpawnFailed)?;

        // Poll for completion with timeout
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Process completed
                    let stdout = child
                        .stdout
                        .take()
                        .map(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).ok();
                            buf
                        })
                        .unwrap_or_default();

                    let stderr = child
                        .stderr
                        .take()
                        .map(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).ok();
                            buf
                        })
                        .unwrap_or_default();

                    return Ok(ProcessResult {
                        exit_code: status.code().unwrap_or(-1),
                        stdout,
                        stderr,
                    });
                }
                Ok(None) => {
                    // Process still running
                    if start.elapsed() > timeout {
                        // Kill the process
                        let _ = child.kill();
                        return Err(CodeServerError::ExtensionInstallFailed {
                            extension: "process".to_string(),
                            reason: format!("Timed out after {timeout:?}"),
                        });
                    }
                    // Sleep briefly before polling again
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    return Err(CodeServerError::SpawnFailed(e));
                }
            }
        }
    }
}

// ============================================================================
// Checksum Verification
// ============================================================================

/// Verify the SHA256 checksum of data.
///
/// # Arguments
///
/// * `data` - The data to verify
/// * `expected_sha256` - The expected SHA256 checksum (lowercase hex)
///
/// # Returns
///
/// Returns `Ok(())` if the checksum matches, or `CodeServerError::ChecksumMismatch`
/// if it doesn't.
pub fn verify_checksum(data: &[u8], expected_sha256: &str, file_name: &str) -> Result<(), CodeServerError> {
    let actual = format!("{:x}", Sha256::digest(data));

    if actual != expected_sha256 {
        return Err(CodeServerError::ChecksumMismatch {
            file: file_name.to_string(),
            expected: expected_sha256.to_string(),
            actual,
        });
    }

    Ok(())
}

/// Download data and verify its checksum.
pub async fn download_and_verify<H: HttpClient>(
    http_client: &H,
    url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, CodeServerError> {
    let data = http_client.download(url).await?;
    verify_checksum(&data, expected_sha256, url)?;
    Ok(data)
}

// ============================================================================
// Default Settings
// ============================================================================

/// Default VSCode settings for code-server.
pub const DEFAULT_SETTINGS: &str = r#"{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark+",
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "window.menuBarVisibility": "hidden"
}"#;

/// Default keybindings for code-server.
pub const DEFAULT_KEYBINDINGS: &str = r#"[]"#;

/// Chime extension package.json - defines the extension metadata.
pub const CHIME_EXTENSION_PACKAGE_JSON: &str = r#"{
  "name": "chime",
  "displayName": "Chime",
  "description": "Chime integration for VS Code",
  "version": "0.0.1",
  "publisher": "chime",
  "engines": {
    "vscode": "^1.74.0"
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./extension.js",
  "contributes": {}
}"#;

/// Chime extension JavaScript code - auto-opens OpenCode on startup.
pub const CHIME_EXTENSION_JS: &str = r#"const vscode = require('vscode');

async function activate(context) {
  // Wait a bit for other extensions to load
  setTimeout(async () => {
    try {
      // Close both sidebars
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      
      // Open OpenCode terminal
      await vscode.commands.executeCommand('opencode.openTerminal');
      
      // Close empty editor groups created by the terminal opening "beside"
      await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups');
    } catch (err) {
      console.error('Chime extension error:', err);
    }
  }, 1000);
}

function deactivate() {}

module.exports = { activate, deactivate };
"#;

// ============================================================================
// RuntimeBootstrapper
// ============================================================================

/// Orchestrates first-launch setup with injectable dependencies for testability.
///
/// The bootstrapper handles:
/// - Downloading and extracting Node.js
/// - Installing code-server via npm
/// - Installing required extensions
/// - Writing default settings
pub struct RuntimeBootstrapper<
    H: HttpClient,
    F: FileSystem,
    A: ArchiveExtractor,
    E: EventEmitter,
    P: ProcessSpawner,
> {
    config: CodeServerConfig,
    http_client: H,
    file_system: F,
    archive_extractor: A,
    event_emitter: E,
    process_spawner: P,
}

impl
    RuntimeBootstrapper<ReqwestHttpClient, StdFileSystem, ArchiveExtractorImpl, NoOpEventEmitter, StdProcessSpawner>
{
    /// Create a new RuntimeBootstrapper with production dependencies.
    pub fn new(config: CodeServerConfig) -> Self {
        Self {
            config,
            http_client: ReqwestHttpClient::new(),
            file_system: StdFileSystem,
            archive_extractor: ArchiveExtractorImpl,
            event_emitter: NoOpEventEmitter,
            process_spawner: StdProcessSpawner,
        }
    }
}

impl<H: HttpClient, F: FileSystem, A: ArchiveExtractor, E: EventEmitter, P: ProcessSpawner>
    RuntimeBootstrapper<H, F, A, E, P>
{
    /// Create with custom dependencies (for testing).
    pub fn with_deps(
        config: CodeServerConfig,
        http_client: H,
        file_system: F,
        archive_extractor: A,
        event_emitter: E,
        process_spawner: P,
    ) -> Self {
        Self {
            config,
            http_client,
            file_system,
            archive_extractor,
            event_emitter,
            process_spawner,
        }
    }

    /// Check if the runtime is ready (all components installed).
    pub fn is_ready(&self) -> bool {
        // Check if Node.js binary exists
        if !self.file_system.exists(&self.config.node_binary_path) {
            return false;
        }

        // Check if code-server is installed
        if !self.file_system.exists(&self.config.code_server_dir()) {
            return false;
        }

        // Check if required extensions are installed
        // Extensions are installed as <id>-<version>-<platform> (lowercase)
        if let Ok(entries) = std::fs::read_dir(&self.config.extensions_dir) {
            let installed_extensions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .collect();

            let required = get_required_extensions();
            for (id, _) in required {
                let id_lower = id.to_lowercase();
                let found = installed_extensions
                    .iter()
                    .any(|name| name.starts_with(&id_lower));
                if !found {
                    return false;
                }
            }
        } else {
            return false;
        }

        true
    }

    /// Write default settings if they don't exist.
    ///
    /// Creates the User directory and writes settings.json and keybindings.json
    /// only if they don't already exist.
    pub fn write_default_settings(&self) -> Result<(), CodeServerError> {
        let user_dir = self.config.user_settings_dir();
        let settings_path = self.config.settings_json_path();
        let keybindings_path = self.config.keybindings_json_path();

        // Create User directory if it doesn't exist
        if !self.file_system.exists(&user_dir) {
            self.file_system
                .create_dir_all(&user_dir)
                .map_err(CodeServerError::PermissionError)?;
        }

        // Write settings.json if it doesn't exist
        if !self.file_system.exists(&settings_path) {
            self.file_system
                .write(&settings_path, DEFAULT_SETTINGS.as_bytes())
                .map_err(CodeServerError::PermissionError)?;
        }

        // Write keybindings.json if it doesn't exist
        if !self.file_system.exists(&keybindings_path) {
            self.file_system
                .write(&keybindings_path, DEFAULT_KEYBINDINGS.as_bytes())
                .map_err(CodeServerError::PermissionError)?;
        }

        Ok(())
    }

    /// The directory name for the Chime extension following VS Code convention.
    /// Format: publisher.name-version-platform
    const CHIME_EXTENSION_DIR_NAME: &'static str = "chime.chime-0.0.1-universal";

    /// Install the built-in Chime extension for VS Code integration.
    ///
    /// Creates the extension directory, writes package.json and extension.js,
    /// and registers the extension in extensions.json so code-server recognizes it.
    /// This must be called BEFORE install_extensions() so code-server appends to
    /// the extensions.json rather than overwriting it.
    pub fn install_chime_extension(&self) -> Result<(), CodeServerError> {
        // Create extensions directory if it doesn't exist
        if !self.file_system.exists(&self.config.extensions_dir) {
            self.file_system
                .create_dir_all(&self.config.extensions_dir)
                .map_err(CodeServerError::PermissionError)?;
        }

        // Use proper VS Code extension directory naming: publisher.name-version-platform
        let chime_ext_dir = self
            .config
            .extensions_dir
            .join(Self::CHIME_EXTENSION_DIR_NAME);

        // Create extension directory if it doesn't exist
        if !self.file_system.exists(&chime_ext_dir) {
            self.file_system
                .create_dir_all(&chime_ext_dir)
                .map_err(CodeServerError::PermissionError)?;
        }

        // Write package.json
        let package_json_path = chime_ext_dir.join("package.json");
        if !self.file_system.exists(&package_json_path) {
            self.file_system
                .write(&package_json_path, CHIME_EXTENSION_PACKAGE_JSON.as_bytes())
                .map_err(CodeServerError::PermissionError)?;
        }

        // Write extension.js
        let extension_js_path = chime_ext_dir.join("extension.js");
        if !self.file_system.exists(&extension_js_path) {
            self.file_system
                .write(&extension_js_path, CHIME_EXTENSION_JS.as_bytes())
                .map_err(CodeServerError::PermissionError)?;
        }

        // Write extensions.json with Chime extension entry
        // This must be done before code-server installs other extensions
        // so it appends to this file rather than creating a new one
        let extensions_json_path = self.config.extensions_dir.join("extensions.json");
        if !self.file_system.exists(&extensions_json_path) {
            let chime_ext_path = self.config.extensions_dir.join(Self::CHIME_EXTENSION_DIR_NAME);
            let chime_ext_path_str = chime_ext_path.to_string_lossy();
            let extensions_json = format!(
                r#"[{{"identifier":{{"id":"chime.chime"}},"version":"0.0.1","location":{{"$mid":1,"fsPath":"{}","external":"file://{}","path":"{}","scheme":"file"}},"relativeLocation":"{}","metadata":{{"installedTimestamp":{},"pinned":true,"source":"local","targetPlatform":"universal","updated":false,"private":true,"isPreReleaseVersion":false,"hasPreReleaseVersion":false}}}}]"#,
                chime_ext_path_str,
                chime_ext_path_str,
                chime_ext_path_str,
                Self::CHIME_EXTENSION_DIR_NAME,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );
            self.file_system
                .write(&extensions_json_path, extensions_json.as_bytes())
                .map_err(CodeServerError::PermissionError)?;
        }

        Ok(())
    }

    /// Emit a setup event.
    fn emit(&self, event: SetupEvent) {
        self.event_emitter.emit(event);
    }

    /// Download and extract Node.js.
    pub async fn download_node(&self) -> Result<(), CodeServerError> {
        use crate::runtime_versions::NODE_VERSION;

        let platform = Platform::current().ok_or(CodeServerError::UnsupportedPlatform)?;

        // Create runtime directory
        self.file_system
            .create_dir_all(&self.config.runtime_dir)
            .map_err(CodeServerError::PermissionError)?;

        // Get download URL and checksum
        let url = crate::platform::node_download_url(platform);
        let checksum = crate::platform::node_checksum(platform);
        let archive_name = platform.node_archive_name(NODE_VERSION);
        let extension = platform.node_archive_extension();

        // Download the archive
        self.emit(SetupEvent::Update {
            message: "Downloading Node.js runtime...".into(),
            steps: StepsBuilder::new().node(StepState::InProgress).build(),
        });

        let archive_data = download_and_verify(&self.http_client, &url, checksum).await?;

        self.emit(SetupEvent::Update {
            message: "Extracting Node.js...".into(),
            steps: StepsBuilder::new().node(StepState::InProgress).build(),
        });

        // Extract the archive
        let extracted_dir = self.archive_extractor.extract_archive(
            &archive_data,
            &self.config.runtime_dir,
            &archive_name,
            extension,
        )?;

        // Rename extracted directory to "node" for consistent path
        let target_node_dir = &self.config.node_dir;
        if extracted_dir != *target_node_dir {
            // Use std::fs::rename or copy the directory
            if self.file_system.exists(target_node_dir) {
                self.file_system
                    .remove_dir_all(target_node_dir)
                    .map_err(CodeServerError::PermissionError)?;
            }
            std::fs::rename(&extracted_dir, target_node_dir)
                .map_err(|e| CodeServerError::ExtractionFailed(format!("Failed to rename directory: {e}")))?;
        }

        // Prepare the node binary (set executable permissions, remove quarantine)
        prepare_binary(&self.config.node_binary_path)?;

        Ok(())
    }

    /// Install code-server via npm install.
    ///
    /// Runs: `node <npm-cli.js> install --prefix <runtime-dir> code-server@<version>`
    ///
    /// # Errors
    ///
    /// Returns `CodeServerError::ExtensionInstallFailed` if installation fails.
    pub fn install_code_server(&self) -> Result<(), CodeServerError> {
        self.emit(SetupEvent::Update {
            message: "Installing code-server...".into(),
            steps: StepsBuilder::new()
                .node(StepState::Completed)
                .code_server(StepState::InProgress)
                .build(),
        });

        // First, create a package.json if it doesn't exist
        let package_json_path = self.config.runtime_dir.join("package.json");
        if !self.file_system.exists(&package_json_path) {
            self.file_system
                .write(&package_json_path, b"{}")
                .map_err(CodeServerError::PermissionError)?;
        }

        let args = self.code_server_install_args();

        // Run node directly with the npm CLI script to ensure we use our Node.js
        let result = self.process_spawner.spawn_and_wait(
            &self.config.node_binary_path,
            &args,
            &self.config.runtime_dir,
            CODE_SERVER_INSTALL_TIMEOUT,
        )?;

        if result.exit_code != 0 {
            return Err(CodeServerError::ExtensionInstallFailed {
                extension: "code-server".to_string(),
                reason: format!(
                    "npm install failed with exit code {}. stderr: {}",
                    result.exit_code, result.stderr
                ),
            });
        }

        Ok(())
    }

    /// Build the command arguments for installing code-server.
    ///
    /// Returns args for: `node <npm-cli.js> install --prefix <dir> code-server@<version>`
    ///
    /// This is a helper method exposed for testing.
    pub fn code_server_install_args(&self) -> Vec<String> {
        vec![
            self.config.npm_cli_path().to_string_lossy().to_string(),
            "install".to_string(),
            "--prefix".to_string(),
            self.config.runtime_dir.to_string_lossy().to_string(),
            format!("code-server@{}", CODE_SERVER_VERSION),
        ]
    }

    /// Install all required extensions.
    ///
    /// Runs: `npx code-server --install-extension <ext>@<version> --extensions-dir <dir>`
    ///
    /// # Errors
    ///
    /// Returns `CodeServerError::ExtensionInstallFailed` if any extension installation fails.
    /// This is a hard failure - all extensions must be installed successfully.
    pub fn install_extensions(&self) -> Result<(), CodeServerError> {
        let extensions = get_required_extensions();

        // Create extensions directory if it doesn't exist
        if !self.file_system.exists(&self.config.extensions_dir) {
            self.file_system
                .create_dir_all(&self.config.extensions_dir)
                .map_err(CodeServerError::PermissionError)?;
        }

        for (extension_id, version) in extensions.iter() {
            self.emit(SetupEvent::Update {
                message: format!("Installing {extension_id}..."),
                steps: StepsBuilder::new()
                    .node(StepState::Completed)
                    .code_server(StepState::Completed)
                    .extensions(StepState::InProgress)
                    .build(),
            });

            let args = self.extension_install_args(extension_id, version);

            // Run node directly with the npx CLI script to ensure we use our Node.js
            let result = self.process_spawner.spawn_and_wait(
                &self.config.node_binary_path,
                &args,
                &self.config.runtime_dir,
                EXTENSION_INSTALL_TIMEOUT,
            )?;

            if result.exit_code != 0 {
                return Err(CodeServerError::ExtensionInstallFailed {
                    extension: extension_id.to_string(),
                    reason: format!(
                        "code-server --install-extension failed with exit code {}. stderr: {}",
                        result.exit_code, result.stderr
                    ),
                });
            }
        }

        Ok(())
    }

    /// Build the command arguments for installing an extension.
    ///
    /// Returns args for: `node <code-server/entry.js> --install-extension ...`
    ///
    /// This is a helper method exposed for testing.
    pub fn extension_install_args(&self, extension_id: &str, version: &str) -> Vec<String> {
        vec![
            self.config.code_server_entry_path().to_string_lossy().to_string(),
            "--install-extension".to_string(),
            format!("{}@{}", extension_id, version),
            "--extensions-dir".to_string(),
            self.config.extensions_dir.to_string_lossy().to_string(),
        ]
    }

    /// Ensure the runtime is ready, downloading components if needed.
    pub async fn ensure_ready(&self) -> Result<(), CodeServerError> {
        if self.is_ready() {
            return Ok(());
        }

        // Step 1: Download Node.js
        if let Err(e) = self.download_node().await {
            self.emit(SetupEvent::Failed {
                error: e.to_string(),
            });
            return Err(e);
        }

        // Step 2: Install code-server
        if let Err(e) = self.install_code_server() {
            self.emit(SetupEvent::Failed {
                error: e.to_string(),
            });
            return Err(e);
        }

        // Step 3: Install Chime extension first (writes extensions.json)
        self.install_chime_extension()?;

        // Step 4: Install marketplace extensions (code-server appends to extensions.json)
        if let Err(e) = self.install_extensions() {
            self.emit(SetupEvent::Failed {
                error: e.to_string(),
            });
            return Err(e);
        }

        // Step 5: Write default settings
        self.write_default_settings()?;

        // Emit final success state
        self.emit(SetupEvent::Update {
            message: "Setup complete!".into(),
            steps: StepsBuilder::new()
                .node(StepState::Completed)
                .code_server(StepState::Completed)
                .extensions(StepState::Completed)
                .build(),
        });
        self.emit(SetupEvent::Complete);
        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as IoWrite;
    use tempfile::tempdir;

    // Helper to create a minimal valid ZIP archive with a binary
    // The archive_name is the directory name inside the archive (e.g., "node-v24.11.1-win-x64")
    fn create_test_zip(archive_name: &str, binary_content: &[u8]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // Add a directory entry (like node-v24.11.1-win-x64/)
            let dir_name = format!("{archive_name}/");
            zip.add_directory(&dir_name, options).unwrap();

            // Add a binary file inside (e.g., node.exe for Windows)
            let file_path = format!("{archive_name}/node.exe");
            zip.start_file(&file_path, options).unwrap();
            zip.write_all(binary_content).unwrap();

            zip.finish().unwrap();
        }
        buffer.into_inner()
    }

    // Helper to create an invalid ZIP archive
    fn create_invalid_zip() -> Vec<u8> {
        vec![0x00, 0x01, 0x02, 0x03] // Not a valid ZIP file
    }

    #[test]
    fn test_checksum_verification_success() {
        let data = b"hello world";
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

        let result = verify_checksum(data, expected, "test.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn test_checksum_verification_mismatch() {
        let data = b"hello world";
        let expected = "0000000000000000000000000000000000000000000000000000000000000000";

        let result = verify_checksum(data, expected, "test.txt");
        assert!(result.is_err());

        if let Err(CodeServerError::ChecksumMismatch {
            file,
            expected: exp,
            actual,
        }) = result
        {
            assert_eq!(file, "test.txt");
            assert_eq!(exp, expected);
            assert_eq!(
                actual,
                "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
            );
        } else {
            panic!("Expected ChecksumMismatch error");
        }
    }

    #[tokio::test]
    async fn test_download_network_error() {
        // Test with the real HTTP client against an invalid address
        // This verifies the error handling without needing complex async mocking
        let client = ReqwestHttpClient::new();
        let result = client.download("http://127.0.0.1:1/nonexistent").await;

        assert!(result.is_err());
        assert!(matches!(result, Err(CodeServerError::DownloadFailed { .. })));
    }

    #[test]
    fn test_is_ready_returns_false_when_missing() {
        let mut mock_fs = MockFileSystem::new();

        // Bun binary doesn't exist
        mock_fs.expect_exists().returning(|_| false);

        let config = CodeServerConfig::new("0.1.0").unwrap();
        let mock_http = MockHttpClient::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        let bootstrapper = RuntimeBootstrapper::with_deps(
            config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        assert!(!bootstrapper.is_ready());
    }

    #[test]
    fn test_is_ready_returns_true_when_complete() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        // Create extensions directory and dummy extension to satisfy read_dir check
        std::fs::create_dir_all(&test_config.extensions_dir).unwrap();
        std::fs::create_dir(test_config.extensions_dir.join("sst-dev.opencode-0.0.12")).unwrap();

        let mut mock_fs = MockFileSystem::new();

        // All paths exist (node binary, code-server dir)
        mock_fs.expect_exists().returning(|_| true);

        let mock_http = MockHttpClient::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        assert!(bootstrapper.is_ready());
    }

    #[test]
    fn test_write_default_settings_creates_file() {
        let temp = tempdir().unwrap();

        // Create a config pointing to our temp directory
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let bootstrapper = RuntimeBootstrapper::new(test_config.clone());

        // Write default settings
        let result = bootstrapper.write_default_settings();
        assert!(result.is_ok());

        // Verify settings.json was created
        let settings_path = test_config.settings_json_path();
        assert!(settings_path.exists());
        let settings_content = std::fs::read_to_string(&settings_path).unwrap();
        assert!(settings_content.contains("workbench.startupEditor"));
        assert!(settings_content.contains("none"));

        // Verify keybindings.json was created
        let keybindings_path = test_config.keybindings_json_path();
        assert!(keybindings_path.exists());
        let keybindings_content = std::fs::read_to_string(&keybindings_path).unwrap();
        assert_eq!(keybindings_content, "[]");
    }

    #[test]
    fn test_write_default_settings_skips_existing() {
        let temp = tempdir().unwrap();

        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        // Pre-create the User directory and settings with custom content
        let user_dir = test_config.user_settings_dir();
        std::fs::create_dir_all(&user_dir).unwrap();

        let settings_path = test_config.settings_json_path();
        let custom_settings = r#"{"custom": "settings"}"#;
        std::fs::write(&settings_path, custom_settings).unwrap();

        let bootstrapper = RuntimeBootstrapper::new(test_config.clone());

        // Write default settings (should skip existing)
        let result = bootstrapper.write_default_settings();
        assert!(result.is_ok());

        // Verify settings.json was NOT overwritten
        let settings_content = std::fs::read_to_string(&settings_path).unwrap();
        assert_eq!(settings_content, custom_settings);
    }

    #[test]
    fn test_zip_extraction_success() {
        let temp = tempdir().unwrap();
        let archive_name = "node-v24.11.1-win-x64";
        let archive_data = create_test_zip(archive_name, b"binary content");

        let extractor = ArchiveExtractorImpl;
        let result = extractor.extract_zip(&archive_data, temp.path(), archive_name);

        assert!(result.is_ok());
        let extracted_dir = result.unwrap();
        assert!(extracted_dir.exists(), "Extracted directory should exist");

        // Verify the binary file was extracted
        let binary_path = extracted_dir.join("node.exe");
        assert!(binary_path.exists(), "Binary file should exist");
        let content = std::fs::read(&binary_path).unwrap();
        assert_eq!(content, b"binary content");
    }

    #[test]
    fn test_zip_extraction_invalid_archive() {
        let temp = tempdir().unwrap();
        let invalid_data = create_invalid_zip();

        let extractor = ArchiveExtractorImpl;
        let result = extractor.extract_zip(&invalid_data, temp.path(), "node-v24.11.1-win-x64");

        assert!(result.is_err());
        assert!(matches!(result, Err(CodeServerError::ExtractionFailed(_))));
    }

    #[test]
    fn test_zip_extraction_archive_name_mismatch() {
        let temp = tempdir().unwrap();
        // Create archive with a specific name but extract with a different expected name
        let archive_data = create_test_zip("node-v24.11.1-win-x64", b"content");

        let extractor = ArchiveExtractorImpl;
        // Extract expects a different directory name than what's in the archive
        let result = extractor.extract_zip(&archive_data, temp.path(), "different-name");

        // The extraction succeeds but the returned path won't exist
        // because the archive contains node-v24.11.1-win-x64/, not different-name/
        assert!(result.is_ok());
        let returned_path = result.unwrap();
        // The returned path points to a non-existent directory
        assert!(!returned_path.exists(), "Returned path should not exist for mismatched archive name");
    }

    #[test]
    fn test_zip_extraction_permission_denied() {
        // Skip this test on non-Unix systems
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let temp = tempdir().unwrap();
            let archive_name = "node-v24.11.1-win-x64";
            let archive_data = create_test_zip(archive_name, b"binary content");

            // Make the temp directory read-only
            std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o444)).unwrap();

            let extractor = ArchiveExtractorImpl;
            let result = extractor.extract_zip(&archive_data, temp.path(), archive_name);

            // Restore permissions so temp dir can be cleaned up
            std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();

            assert!(result.is_err());
            assert!(matches!(result, Err(CodeServerError::ExtractionFailed(_))));
        }
    }

    #[test]
    fn test_default_settings_json_is_valid() {
        // Verify DEFAULT_SETTINGS is valid JSON
        let parsed: serde_json::Result<serde_json::Value> = serde_json::from_str(DEFAULT_SETTINGS);
        assert!(parsed.is_ok(), "DEFAULT_SETTINGS should be valid JSON");

        let obj = parsed.unwrap();
        assert!(obj.is_object());
        assert!(obj.get("workbench.startupEditor").is_some());
        assert!(obj.get("workbench.colorTheme").is_some());
        assert!(obj.get("extensions.autoUpdate").is_some());
        assert!(obj.get("telemetry.telemetryLevel").is_some());
        assert!(obj.get("window.menuBarVisibility").is_some());
    }

    #[test]
    fn test_default_keybindings_json_is_valid() {
        // Verify DEFAULT_KEYBINDINGS is valid JSON
        let parsed: serde_json::Result<serde_json::Value> = serde_json::from_str(DEFAULT_KEYBINDINGS);
        assert!(parsed.is_ok(), "DEFAULT_KEYBINDINGS should be valid JSON");

        let arr = parsed.unwrap();
        assert!(arr.is_array());
        let bindings = arr.as_array().unwrap();
        assert!(bindings.is_empty());
    }

    // Integration test with real filesystem (using temp directory)
    #[test]
    fn test_bootstrapper_write_settings_integration() {
        let temp = tempdir().unwrap();

        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let bootstrapper = RuntimeBootstrapper::new(test_config.clone());

        // First write should create files
        bootstrapper.write_default_settings().unwrap();

        // Verify files exist with correct content
        let settings = std::fs::read_to_string(test_config.settings_json_path()).unwrap();
        let keybindings = std::fs::read_to_string(test_config.keybindings_json_path()).unwrap();

        // Verify JSON is valid
        serde_json::from_str::<serde_json::Value>(&settings).unwrap();
        serde_json::from_str::<serde_json::Value>(&keybindings).unwrap();

        // Second write should not modify files
        let original_settings = settings.clone();
        bootstrapper.write_default_settings().unwrap();
        let settings_after = std::fs::read_to_string(test_config.settings_json_path()).unwrap();
        assert_eq!(settings_after, original_settings);
    }

    // ============================================================================
    // Phase 4 Tests: code-server and Extension Installation
    // ============================================================================

    #[test]
    fn test_code_server_install_command_format() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config.clone(),
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let args = bootstrapper.code_server_install_args();

        // Verify the command format: node <npm-cli.js> install --prefix <dir> code-server@<version>
        // args[0] is the npm-cli.js path
        assert!(args[0].ends_with("npm-cli.js"), "First arg should be npm-cli.js path");
        assert_eq!(args[1], "install");
        assert_eq!(args[2], "--prefix");
        assert_eq!(args[3], temp.path().to_string_lossy());
        assert!(
            args[4].starts_with("code-server@"),
            "Should include code-server with version"
        );
        assert!(
            args[4].contains(CODE_SERVER_VERSION),
            "Should include pinned version"
        );
    }

    #[test]
    fn test_extension_install_command_format() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config.clone(),
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let args = bootstrapper.extension_install_args("sst-dev.opencode", "0.0.12");

        // Verify the command format: node <entry.js> --install-extension <ext>@<version> --extensions-dir <dir>
        // args[0] is the code-server entry.js path
        assert!(args[0].ends_with("entry.js"), "First arg should be code-server entry.js path");
        assert_eq!(args[1], "--install-extension");
        assert_eq!(args[2], "sst-dev.opencode@0.0.12");
        assert_eq!(args[3], "--extensions-dir");
        assert_eq!(args[4], temp.path().join("extensions").to_string_lossy());
    }

    #[test]
    fn test_extension_install_iterates_all() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mut mock_emitter = MockEventEmitter::new();
        let mut mock_spawner = MockProcessSpawner::new();

        // Extensions dir doesn't exist initially
        mock_fs.expect_exists().returning(|_| false);
        mock_fs.expect_create_dir_all().returning(|_| Ok(()));

        // Expect events to be emitted
        mock_emitter.expect_emit().returning(|_| ());

        // Count how many times spawn_and_wait is called
        let extensions = get_required_extensions();
        let expected_calls = extensions.len();

        mock_spawner
            .expect_spawn_and_wait()
            .times(expected_calls)
            .returning(|_, _, _, _| {
                Ok(ProcessResult {
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            });

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_extensions();
        assert!(result.is_ok(), "Should successfully install all extensions");
    }

    #[test]
    fn test_extension_install_failure() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mut mock_emitter = MockEventEmitter::new();
        let mut mock_spawner = MockProcessSpawner::new();

        mock_fs.expect_exists().returning(|_| false);
        mock_fs.expect_create_dir_all().returning(|_| Ok(()));
        mock_emitter.expect_emit().returning(|_| ());

        // Simulate installation failure
        mock_spawner
            .expect_spawn_and_wait()
            .times(1)
            .returning(|_, _, _, _| {
                Ok(ProcessResult {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "Extension not found".to_string(),
                })
            });

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_extensions();
        assert!(result.is_err(), "Should fail when extension installation fails");

        if let Err(CodeServerError::ExtensionInstallFailed { extension, reason }) = result {
            assert!(reason.contains("exit code 1"));
            assert!(reason.contains("Extension not found"));
            // Extension ID should be captured
            assert!(!extension.is_empty());
        } else {
            panic!("Expected ExtensionInstallFailed error");
        }
    }

    #[test]
    fn test_extension_install_timeout() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mut mock_emitter = MockEventEmitter::new();
        let mut mock_spawner = MockProcessSpawner::new();

        mock_fs.expect_exists().returning(|_| false);
        mock_fs.expect_create_dir_all().returning(|_| Ok(()));
        mock_emitter.expect_emit().returning(|_| ());

        // Simulate timeout
        mock_spawner
            .expect_spawn_and_wait()
            .times(1)
            .returning(|_, _, _, _| {
                Err(CodeServerError::ExtensionInstallFailed {
                    extension: "process".to_string(),
                    reason: "Timed out after 120s".to_string(),
                })
            });

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_extensions();
        assert!(result.is_err(), "Should fail on timeout");

        if let Err(CodeServerError::ExtensionInstallFailed { reason, .. }) = result {
            assert!(reason.contains("Timed out"), "Error should mention timeout");
        } else {
            panic!("Expected ExtensionInstallFailed error");
        }
    }

    #[test]
    fn test_code_server_install_failure() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mut mock_emitter = MockEventEmitter::new();
        let mut mock_spawner = MockProcessSpawner::new();

        // Mock filesystem for package.json creation
        mock_fs.expect_exists().returning(|_| false);
        mock_fs.expect_write().returning(|_, _| Ok(()));

        mock_emitter.expect_emit().returning(|_| ());

        // Simulate npm install failure
        mock_spawner
            .expect_spawn_and_wait()
            .times(1)
            .returning(|_, _, _, _| {
                Ok(ProcessResult {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "npm ERR! 404 Not Found".to_string(),
                })
            });

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_code_server();
        assert!(result.is_err(), "Should fail when npm install fails");

        if let Err(CodeServerError::ExtensionInstallFailed { extension, reason }) = result {
            assert_eq!(extension, "code-server");
            assert!(reason.contains("exit code 1"));
            assert!(reason.contains("404 Not Found"));
        } else {
            panic!("Expected ExtensionInstallFailed error");
        }
    }

    #[test]
    fn test_code_server_install_success() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mut mock_emitter = MockEventEmitter::new();
        let mut mock_spawner = MockProcessSpawner::new();

        // Mock filesystem for package.json creation
        mock_fs.expect_exists().returning(|_| false);
        mock_fs.expect_write().returning(|_, _| Ok(()));

        mock_emitter.expect_emit().returning(|_| ());

        // Simulate successful installation
        mock_spawner
            .expect_spawn_and_wait()
            .times(1)
            .returning(|_, _, _, _| {
                Ok(ProcessResult {
                    exit_code: 0,
                    stdout: "added 1 package".to_string(),
                    stderr: String::new(),
                })
            });

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_code_server();
        assert!(result.is_ok(), "Should succeed when npm install succeeds");
    }

    #[test]
    fn test_process_result_fields() {
        let result = ProcessResult {
            exit_code: 0,
            stdout: "output".to_string(),
            stderr: "error".to_string(),
        };

        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "output");
        assert_eq!(result.stderr, "error");
    }

    // ============================================================================
    // Chime Extension Tests
    // ============================================================================

    #[test]
    fn test_chime_extension_package_json_is_valid() {
        // Verify CHIME_EXTENSION_PACKAGE_JSON is valid JSON
        let parsed: serde_json::Result<serde_json::Value> =
            serde_json::from_str(CHIME_EXTENSION_PACKAGE_JSON);
        assert!(
            parsed.is_ok(),
            "CHIME_EXTENSION_PACKAGE_JSON should be valid JSON"
        );

        let obj = parsed.unwrap();
        assert!(obj.is_object());
        assert_eq!(obj.get("name").unwrap(), "chime");
        assert_eq!(obj.get("displayName").unwrap(), "Chime");
        assert_eq!(obj.get("main").unwrap(), "./extension.js");
        assert!(obj.get("activationEvents").is_some());

        // Verify activationEvents contains onStartupFinished
        let activation_events = obj.get("activationEvents").unwrap().as_array().unwrap();
        assert!(activation_events
            .iter()
            .any(|v| v.as_str() == Some("onStartupFinished")));
    }

    #[test]
    fn test_chime_extension_js_contains_required_code() {
        // Verify CHIME_EXTENSION_JS contains all required components
        assert!(
            CHIME_EXTENSION_JS.contains("async function activate"),
            "Should contain async activate function"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("function deactivate"),
            "Should contain deactivate function"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("opencode.openTerminal"),
            "Should contain opencode.openTerminal command"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("workbench.action.closeSidebar"),
            "Should contain closeSidebar command"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("workbench.action.closeAuxiliaryBar"),
            "Should contain closeAuxiliaryBar command for secondary sidebar"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("workbench.action.closeEditorsInOtherGroups"),
            "Should contain closeEditorsInOtherGroups command to close empty splits"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("module.exports"),
            "Should export module"
        );
        assert!(
            CHIME_EXTENSION_JS.contains("require('vscode')"),
            "Should require vscode module"
        );
    }

    #[test]
    fn test_install_chime_extension_creates_directory_and_files() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        // Track which paths are checked and created
        mock_fs
            .expect_exists()
            .returning(|_| false); // Nothing exists initially

        mock_fs
            .expect_create_dir_all()
            .times(1)
            .returning(|_| Ok(()));

        mock_fs
            .expect_write()
            .times(2) // package.json and extension.js
            .returning(|_, _| Ok(()));

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_chime_extension();
        assert!(result.is_ok(), "Should successfully install Chime extension");
    }

    #[test]
    fn test_install_chime_extension_skips_existing_files() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        // All files already exist
        mock_fs.expect_exists().returning(|_| true);

        // Should not create directory or write files since they exist
        mock_fs.expect_create_dir_all().times(0);
        mock_fs.expect_write().times(0);

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_chime_extension();
        assert!(result.is_ok(), "Should succeed when files already exist");
    }

    #[test]
    fn test_install_chime_extension_handles_directory_error() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        mock_fs.expect_exists().returning(|_| false);

        // Simulate directory creation failure
        mock_fs
            .expect_create_dir_all()
            .times(1)
            .returning(|_| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")));

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_chime_extension();
        assert!(result.is_err(), "Should fail when directory creation fails");
        assert!(matches!(result, Err(CodeServerError::PermissionError(_))));
    }

    #[test]
    fn test_install_chime_extension_handles_write_error() {
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let mock_http = MockHttpClient::new();
        let mut mock_fs = MockFileSystem::new();
        let mock_extractor = MockArchiveExtractor::new();
        let mock_emitter = MockEventEmitter::new();
        let mock_spawner = MockProcessSpawner::new();

        // Directory exists, but files don't
        mock_fs.expect_exists().returning(|path| {
            // Only the directory exists, not the files
            path.ends_with("chime")
        });

        // Simulate file write failure
        mock_fs
            .expect_write()
            .times(1)
            .returning(|_, _| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied")));

        let bootstrapper = RuntimeBootstrapper::with_deps(
            test_config,
            mock_http,
            mock_fs,
            mock_extractor,
            mock_emitter,
            mock_spawner,
        );

        let result = bootstrapper.install_chime_extension();
        assert!(result.is_err(), "Should fail when file write fails");
        assert!(matches!(result, Err(CodeServerError::PermissionError(_))));
    }

    #[test]
    fn test_install_chime_extension_integration() {
        // Integration test using real filesystem
        let temp = tempdir().unwrap();
        let test_config = CodeServerConfig {
            runtime_dir: temp.path().to_path_buf(),
            node_dir: temp.path().join("node"),
            node_binary_path: temp.path().join("node").join("bin").join("node"),
            extensions_dir: temp.path().join("extensions"),
            user_data_dir: temp.path().join("user-data"),
            port_start: 50000,
        };

        let bootstrapper = RuntimeBootstrapper::new(test_config.clone());

        // First install should create files
        let result = bootstrapper.install_chime_extension();
        assert!(result.is_ok(), "Should successfully install Chime extension");

        // Verify files were created
        let chime_dir = test_config.extensions_dir.join("chime");
        assert!(chime_dir.exists(), "Chime extension directory should exist");

        let package_json_path = chime_dir.join("package.json");
        assert!(package_json_path.exists(), "package.json should exist");
        let package_json_content = std::fs::read_to_string(&package_json_path).unwrap();
        assert_eq!(package_json_content, CHIME_EXTENSION_PACKAGE_JSON);

        let extension_js_path = chime_dir.join("extension.js");
        assert!(extension_js_path.exists(), "extension.js should exist");
        let extension_js_content = std::fs::read_to_string(&extension_js_path).unwrap();
        assert_eq!(extension_js_content, CHIME_EXTENSION_JS);

        // Second install should not overwrite
        std::fs::write(&package_json_path, "custom content").unwrap();
        let result = bootstrapper.install_chime_extension();
        assert!(result.is_ok());
        let content_after = std::fs::read_to_string(&package_json_path).unwrap();
        assert_eq!(content_after, "custom content", "Should not overwrite existing files");
    }
}
