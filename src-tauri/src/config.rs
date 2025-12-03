//! Configuration for code-server and runtime management.
//!
//! This module provides:
//! - `CodeServerConfig` - immutable configuration for code-server instances
//!
//! ## Directory Structure
//!
//! The runtime directory is versioned by app version:
//!
//! ```text
//! <app-version>/
//! ├── node/                       # Node.js installation directory
//! │   ├── bin/
//! │   │   ├── node               # Node.js binary
//! │   │   ├── npm                # npm binary
//! │   │   └── npx                # npx binary
//! │   └── lib/
//! ├── node_modules/               # code-server + dependencies
//! │   └── code-server/
//! ├── extensions/                 # Installed VSCode extensions
//! │   └── Anthropic.claude-code/
//! └── user-data/                  # Single shared user-data-dir for ALL workspaces
//!     ├── User/
//!     │   ├── settings.json
//!     │   └── keybindings.json
//!     └── workspaceStorage/
//! ```

use crate::error::CodeServerError;
use crate::platform::{paths::get_data_version_dir, Platform};
use std::path::PathBuf;

/// Starting port for code-server instances.
pub const PORT_RANGE_START: u16 = 50000;

/// Configuration for code-server (immutable after creation).
///
/// This struct holds all paths and settings needed to run code-server.
/// All paths are computed based on the runtime directory.
#[derive(Debug, Clone)]
pub struct CodeServerConfig {
    /// The versioned runtime directory (e.g., `<app-data>/0.1.0/`)
    pub runtime_dir: PathBuf,

    /// Path to the Node.js installation directory (e.g., `<runtime>/node/`)
    pub node_dir: PathBuf,

    /// Path to the Node.js binary (e.g., `<runtime>/node/bin/node`)
    pub node_binary_path: PathBuf,

    /// Directory for installed VSCode extensions
    pub extensions_dir: PathBuf,

    /// Directory for VSCode user data (settings, state, etc.)
    pub user_data_dir: PathBuf,

    /// Starting port for code-server (default: 50000)
    pub port_start: u16,
}

impl CodeServerConfig {
    /// Create a new CodeServerConfig for the given app version.
    ///
    /// This computes all paths based on the platform and app version.
    ///
    /// # Arguments
    ///
    /// * `app_version` - The application version string (e.g., "0.1.0")
    ///
    /// # Errors
    ///
    /// Returns `CodeServerError::UnsupportedPlatform` if the current platform
    /// is not supported.
    ///
    /// # Example
    ///
    /// ```ignore
    /// use codehydra_lib::config::CodeServerConfig;
    ///
    /// let config = CodeServerConfig::new("0.1.0")?;
    /// println!("Node binary: {:?}", config.node_binary_path);
    /// ```
    pub fn new(app_version: &str) -> Result<Self, CodeServerError> {
        let platform = Platform::current().ok_or(CodeServerError::UnsupportedPlatform)?;
        let runtime_dir = get_data_version_dir(app_version);
        let node_dir = runtime_dir.join("node");

        // On Windows, binaries are directly in the node folder
        // On Unix, binaries are in node/bin/
        let bin_dir = if platform.is_windows() {
            node_dir.clone()
        } else {
            node_dir.join("bin")
        };

        Ok(Self {
            node_dir,
            node_binary_path: bin_dir.join(platform.node_binary_name()),
            extensions_dir: runtime_dir.join("extensions"),
            user_data_dir: runtime_dir.join("user-data"),
            port_start: PORT_RANGE_START,
            runtime_dir,
        })
    }

    /// Get the path to the node_modules directory.
    pub fn node_modules_dir(&self) -> PathBuf {
        self.runtime_dir.join("node_modules")
    }

    /// Get the path to the code-server installation.
    pub fn code_server_dir(&self) -> PathBuf {
        self.node_modules_dir().join("code-server")
    }

    /// Get the path to the User settings directory.
    pub fn user_settings_dir(&self) -> PathBuf {
        self.user_data_dir.join("User")
    }

    /// Get the path to the settings.json file.
    pub fn settings_json_path(&self) -> PathBuf {
        self.user_settings_dir().join("settings.json")
    }

    /// Get the path to the keybindings.json file.
    pub fn keybindings_json_path(&self) -> PathBuf {
        self.user_settings_dir().join("keybindings.json")
    }

    /// Get the path to the npm CLI script.
    /// This is the actual JS file that should be run with node.
    pub fn npm_cli_path(&self) -> PathBuf {
        let base = if cfg!(target_os = "windows") {
            self.node_dir.join("node_modules")
        } else {
            self.node_dir.join("lib").join("node_modules")
        };
        base.join("npm").join("bin").join("npm-cli.js")
    }

    /// Get the path to the code-server entry point.
    /// This is the main JS file that should be run with node.
    pub fn code_server_entry_path(&self) -> PathBuf {
        self.node_modules_dir()
            .join("code-server")
            .join("out")
            .join("node")
            .join("entry.js")
    }

    /// Get the path to the node_modules/.bin directory.
    /// This is added to PATH when spawning code-server so it can find opencode.
    pub fn node_modules_bin_dir(&self) -> PathBuf {
        self.node_modules_dir().join(".bin")
    }

    /// Get the path to the opencode binary.
    /// Used to check if opencode is installed.
    pub fn opencode_binary_path(&self) -> PathBuf {
        let binary_name = if cfg!(windows) {
            "opencode.cmd"
        } else {
            "opencode"
        };
        self.node_modules_bin_dir().join(binary_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new_creates_valid_paths() {
        let config = CodeServerConfig::new("0.1.0");
        assert!(config.is_ok(), "Should create config on supported platform");

        let config = config.unwrap();

        // Verify all paths are set
        assert!(!config.runtime_dir.as_os_str().is_empty());
        assert!(!config.node_binary_path.as_os_str().is_empty());
        assert!(!config.extensions_dir.as_os_str().is_empty());
        assert!(!config.user_data_dir.as_os_str().is_empty());

        // Verify paths are based on runtime_dir
        assert!(
            config.node_binary_path.starts_with(&config.runtime_dir),
            "node_binary_path should be under runtime_dir"
        );
        assert!(
            config.extensions_dir.starts_with(&config.runtime_dir),
            "extensions_dir should be under runtime_dir"
        );
        assert!(
            config.user_data_dir.starts_with(&config.runtime_dir),
            "user_data_dir should be under runtime_dir"
        );

        // Verify port is set
        assert_eq!(config.port_start, PORT_RANGE_START);
    }

    #[test]
    fn test_config_paths_include_version() {
        let version = "1.2.3";
        let config = CodeServerConfig::new(version).expect("Should create config");

        let runtime_str = config.runtime_dir.to_string_lossy();
        assert!(
            runtime_str.contains(version),
            "runtime_dir should include version: {runtime_str}"
        );
    }

    #[test]
    fn test_config_node_binary_name_platform_specific() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");

        let binary_name = config
            .node_binary_path
            .file_name()
            .expect("Should have file name")
            .to_string_lossy();

        #[cfg(windows)]
        assert_eq!(binary_name, "node.exe", "Windows should use node.exe");

        #[cfg(not(windows))]
        assert_eq!(binary_name, "node", "Unix should use node");
    }

    #[test]
    fn test_config_extensions_dir_name() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");

        let dir_name = config
            .extensions_dir
            .file_name()
            .expect("Should have directory name")
            .to_string_lossy();

        assert_eq!(dir_name, "extensions");
    }

    #[test]
    fn test_config_user_data_dir_name() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");

        let dir_name = config
            .user_data_dir
            .file_name()
            .expect("Should have directory name")
            .to_string_lossy();

        assert_eq!(dir_name, "user-data");
    }

    #[test]
    fn test_config_helper_methods() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");

        // Test node_modules_dir
        assert!(config.node_modules_dir().ends_with("node_modules"));
        assert!(config.node_modules_dir().starts_with(&config.runtime_dir));

        // Test code_server_dir
        assert!(config.code_server_dir().ends_with("code-server"));
        assert!(config
            .code_server_dir()
            .starts_with(config.node_modules_dir()));

        // Test user_settings_dir
        assert!(config.user_settings_dir().ends_with("User"));
        assert!(config
            .user_settings_dir()
            .starts_with(&config.user_data_dir));

        // Test settings_json_path
        assert!(config.settings_json_path().ends_with("settings.json"));
        assert!(config
            .settings_json_path()
            .starts_with(config.user_settings_dir()));

        // Test keybindings_json_path
        assert!(config.keybindings_json_path().ends_with("keybindings.json"));
        assert!(config
            .keybindings_json_path()
            .starts_with(config.user_settings_dir()));

        // Test node_modules_bin_dir
        assert!(config.node_modules_bin_dir().ends_with(".bin"));
        assert!(config
            .node_modules_bin_dir()
            .starts_with(config.node_modules_dir()));

        // Test opencode_binary_path
        #[cfg(windows)]
        assert!(config.opencode_binary_path().ends_with("opencode.cmd"));
        #[cfg(not(windows))]
        assert!(config.opencode_binary_path().ends_with("opencode"));
        assert!(config
            .opencode_binary_path()
            .starts_with(config.node_modules_bin_dir()));
    }

    #[test]
    fn test_get_data_version_dir_debug_mode() {
        // This test runs in debug mode, so should use app-data
        let data_dir = get_data_version_dir("0.1.0");
        let path_str = data_dir.to_string_lossy();

        if cfg!(debug_assertions) {
            assert!(
                path_str.contains("app-data"),
                "Debug build should use app-data directory: {path_str}"
            );
        }
    }

    #[test]
    fn test_config_clone() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");
        let cloned = config.clone();

        assert_eq!(config.runtime_dir, cloned.runtime_dir);
        assert_eq!(config.node_binary_path, cloned.node_binary_path);
        assert_eq!(config.node_dir, cloned.node_dir);
        assert_eq!(config.extensions_dir, cloned.extensions_dir);
        assert_eq!(config.user_data_dir, cloned.user_data_dir);
        assert_eq!(config.port_start, cloned.port_start);
    }

    #[test]
    fn test_config_debug_format() {
        let config = CodeServerConfig::new("0.1.0").expect("Should create config");
        let debug = format!("{config:?}");

        assert!(debug.contains("CodeServerConfig"));
        assert!(debug.contains("runtime_dir"));
        assert!(debug.contains("node_binary_path"));
    }
}
