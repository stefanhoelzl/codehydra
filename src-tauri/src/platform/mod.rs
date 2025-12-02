//! Platform detection and cross-platform utilities.
//!
//! This module provides platform-specific functionality for:
//! - Platform detection (OS + architecture)
//! - Download URLs and checksums for Node.js binaries
//! - Path encoding and normalization
//! - Process spawning with process groups/job objects

pub mod download;
pub mod paths;
pub mod process;

/// Supported platforms for Chime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX64,
    LinuxArm64,
    MacOSX64,
    MacOSArm64,
    WindowsX64,
}

impl Platform {
    /// Detect the current platform.
    ///
    /// Returns `None` if the platform is not supported.
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

    /// Get the Node.js archive name for this platform (without extension).
    ///
    /// This matches the naming convention used by Node.js releases.
    pub fn node_archive_name(&self, version: &str) -> String {
        match self {
            Self::LinuxX64 => format!("node-v{version}-linux-x64"),
            Self::LinuxArm64 => format!("node-v{version}-linux-arm64"),
            Self::MacOSX64 => format!("node-v{version}-darwin-x64"),
            Self::MacOSArm64 => format!("node-v{version}-darwin-arm64"),
            Self::WindowsX64 => format!("node-v{version}-win-x64"),
        }
    }

    /// Get the archive file extension for this platform.
    ///
    /// Returns ".zip" on Windows, ".tar.xz" on Linux, ".tar.gz" on macOS.
    pub fn node_archive_extension(&self) -> &'static str {
        match self {
            Self::WindowsX64 => ".zip",
            Self::MacOSX64 | Self::MacOSArm64 => ".tar.gz",
            Self::LinuxX64 | Self::LinuxArm64 => ".tar.xz",
        }
    }

    /// Get the Node.js binary name for this platform.
    ///
    /// Returns "node.exe" on Windows, "node" on all other platforms.
    pub fn node_binary_name(&self) -> &'static str {
        match self {
            Self::WindowsX64 => "node.exe",
            _ => "node",
        }
    }
    /// Check if this platform is Windows.
    pub fn is_windows(&self) -> bool {
        matches!(self, Self::WindowsX64)
    }

    /// Check if this platform is macOS.
    pub fn is_macos(&self) -> bool {
        matches!(self, Self::MacOSX64 | Self::MacOSArm64)
    }

    /// Check if this platform is Linux.
    pub fn is_linux(&self) -> bool {
        matches!(self, Self::LinuxX64 | Self::LinuxArm64)
    }
}

// Re-export commonly used items
pub use download::{node_checksum, node_download_url};
pub use paths::{encode_path_for_url, normalize_path};
pub use process::{prepare_binary, remove_quarantine, set_executable, spawn_code_server};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_detection_linux_x64() {
        let platform = Platform::LinuxX64;
        assert!(platform.is_linux());
        assert!(!platform.is_macos());
        assert!(!platform.is_windows());
        assert_eq!(
            platform.node_archive_name("24.11.1"),
            "node-v24.11.1-linux-x64"
        );
        assert_eq!(platform.node_binary_name(), "node");
        assert_eq!(platform.node_archive_extension(), ".tar.xz");
    }

    #[test]
    fn test_platform_detection_macos_arm64() {
        let platform = Platform::MacOSArm64;
        assert!(platform.is_macos());
        assert!(!platform.is_linux());
        assert!(!platform.is_windows());
        assert_eq!(
            platform.node_archive_name("24.11.1"),
            "node-v24.11.1-darwin-arm64"
        );
        assert_eq!(platform.node_binary_name(), "node");
        assert_eq!(platform.node_archive_extension(), ".tar.gz");
    }

    #[test]
    fn test_platform_detection_windows() {
        let platform = Platform::WindowsX64;
        assert!(platform.is_windows());
        assert!(!platform.is_linux());
        assert!(!platform.is_macos());
        assert_eq!(
            platform.node_archive_name("24.11.1"),
            "node-v24.11.1-win-x64"
        );
        assert_eq!(platform.node_binary_name(), "node.exe");
        assert_eq!(platform.node_archive_extension(), ".zip");
    }

    #[test]
    fn test_platform_detection_unsupported() {
        let current = Platform::current();
        if let Some(platform) = current {
            assert!(platform.is_linux() || platform.is_macos() || platform.is_windows());
        }
    }

    #[test]
    fn test_node_binary_name_windows_has_exe() {
        assert_eq!(Platform::WindowsX64.node_binary_name(), "node.exe");
    }

    #[test]
    fn test_node_binary_name_unix_no_extension() {
        assert_eq!(Platform::LinuxX64.node_binary_name(), "node");
        assert_eq!(Platform::LinuxArm64.node_binary_name(), "node");
        assert_eq!(Platform::MacOSX64.node_binary_name(), "node");
        assert_eq!(Platform::MacOSArm64.node_binary_name(), "node");
    }

    #[test]
    fn test_platform_equality() {
        assert_eq!(Platform::LinuxX64, Platform::LinuxX64);
        assert_ne!(Platform::LinuxX64, Platform::LinuxArm64);
        assert_ne!(Platform::MacOSArm64, Platform::WindowsX64);
    }

    #[test]
    fn test_platform_clone() {
        let platform = Platform::MacOSArm64;
        let cloned = platform;
        assert_eq!(platform, cloned);
    }

    #[test]
    fn test_platform_debug() {
        let platform = Platform::LinuxX64;
        let debug = format!("{platform:?}");
        assert!(debug.contains("LinuxX64"));
    }
}
