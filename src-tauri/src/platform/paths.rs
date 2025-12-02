//! Path handling utilities for URLs and filesystem operations.
//!
//! This module provides:
//! - Path encoding for use in URLs (percent-encoding)
//! - Path normalization (canonicalization)
//! - Data directory helpers for debug/release modes
//!
//! ## Directory Structure
//!
//! ```text
//! <data-root>/                    # get_data_root_dir()
//! ├── 0.1.0/                      # get_data_version_dir("0.1.0")
//! │   ├── node/
//! │   ├── node_modules/
//! │   ├── extensions/
//! │   └── user-data/
//! ├── 0.2.0/                      # Another version
//! │   └── ...
//! └── projects/                   # get_data_projects_dir() - SHARED across versions
//!     ├── codehydra-a1b2c3d4/
//!     │   └── config.json
//!     └── my-app-f8e9d0c1/
//!         └── config.json
//! ```

use crate::error::CodeServerError;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use std::path::{Path, PathBuf};

/// Characters that need to be percent-encoded in URLs.
///
/// This set includes control characters plus characters that have special
/// meaning in URLs or could cause issues.
const PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'{')
    .add(b'}');

/// Encode a path for use in URLs.
///
/// This applies percent-encoding to characters that could cause issues in URLs,
/// such as spaces, quotes, and special characters.
///
/// # Example
///
/// ```
/// use std::path::Path;
/// use codehydra_lib::platform::paths::encode_path_for_url;
///
/// let path = Path::new("/home/user/my project");
/// let encoded = encode_path_for_url(path);
/// assert_eq!(encoded, "/home/user/my%20project");
/// ```
pub fn encode_path_for_url(path: &Path) -> String {
    utf8_percent_encode(&path.to_string_lossy(), PATH_ENCODE_SET).to_string()
}

/// Normalize a path by canonicalizing it.
///
/// This resolves symlinks and relative path components (`.` and `..`).
/// Returns an error if the path does not exist or cannot be accessed.
///
/// # Errors
///
/// Returns `CodeServerError::InvalidPath` if:
/// - The path does not exist
/// - The path cannot be accessed (permission denied)
/// - The path contains invalid characters
pub fn normalize_path(path: &Path) -> Result<PathBuf, CodeServerError> {
    path.canonicalize()
        .map_err(|e| CodeServerError::InvalidPath(format!("{}: {}", path.display(), e)))
}

/// Get the root data directory for the app.
///
/// In debug builds, uses a local `app-data` directory relative to
/// the current working directory. In release builds, uses the platform-specific
/// user data directory.
///
/// # Returns
///
/// The path to the root data directory (e.g., `~/.local/share/codehydra` or `./app-data`).
///
/// # Note
///
/// This function does not create the directory; callers should ensure
/// it exists before use.
pub fn get_data_root_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        // Development: use local directory relative to project root
        // current_dir() in Tauri dev mode is src-tauri/, so we go up one level
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".."))
            .join("app-data")
    } else {
        // Production: use platform-specific user data directory
        // This matches the directories that Tauri uses
        get_platform_data_dir()
    }
}

/// Get the versioned data directory for the app.
///
/// This is where version-specific runtime files are stored (Node.js, extensions, etc.).
///
/// # Arguments
///
/// * `app_version` - The application version string (e.g., "0.1.0")
///
/// # Returns
///
/// The path to the versioned data directory (e.g., `<root>/0.1.0/`).
///
/// # Note
///
/// This function does not create the directory; callers should ensure
/// it exists before use.
pub fn get_data_version_dir(app_version: &str) -> PathBuf {
    get_data_root_dir().join(app_version)
}

/// Get the projects directory for persisted project data.
///
/// This directory is shared across all app versions, so projects persist
/// through updates.
///
/// # Returns
///
/// The path to the projects directory (e.g., `<root>/projects/`).
///
/// # Note
///
/// This function does not create the directory; callers should ensure
/// it exists before use.
pub fn get_data_projects_dir() -> PathBuf {
    get_data_root_dir().join("projects")
}

/// Sanitize a workspace name for use as a directory name.
///
/// Git branch names can contain `/` (e.g., `feature/auth`), but using such names
/// directly as directory names causes issues because `/` is a path separator.
/// This function converts problematic characters to filesystem-safe alternatives.
///
/// # Conversions
///
/// - `/` → `%` (slash would create nested directories; `%` is invalid in git branch names)
///
/// # Example
///
/// ```
/// use codehydra_lib::platform::paths::sanitize_workspace_name_for_path;
///
/// assert_eq!(sanitize_workspace_name_for_path("feature/auth"), "feature%auth");
/// assert_eq!(sanitize_workspace_name_for_path("simple-name"), "simple-name");
/// ```
pub fn sanitize_workspace_name_for_path(name: &str) -> String {
    name.replace('/', "%")
}

/// Convert a sanitized directory name back to the original workspace/branch name.
///
/// This reverses the transformation done by [`sanitize_workspace_name_for_path`].
///
/// # Example
///
/// ```
/// use codehydra_lib::platform::paths::unsanitize_workspace_name_from_path;
///
/// assert_eq!(unsanitize_workspace_name_from_path("feature%auth"), "feature/auth");
/// assert_eq!(unsanitize_workspace_name_from_path("simple-name"), "simple-name");
/// ```
pub fn unsanitize_workspace_name_from_path(sanitized: &str) -> String {
    sanitized.replace('%', "/")
}

/// Get the workspaces directory for a project.
///
/// This is where git worktrees for the project are stored.
///
/// # Arguments
///
/// * `project_path` - The path to the project root
///
/// # Returns
///
/// The path to the workspaces directory:
/// `<app-data>/projects/<project-name>-<8-char-hash>/workspaces/`
///
/// # Note
///
/// This function does not create the directory; callers should ensure
/// it exists before use.
pub fn get_project_workspaces_dir(project_path: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};

    let name = project_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string());

    let mut hasher = Sha256::new();
    hasher.update(project_path.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    get_data_projects_dir()
        .join(format!("{}-{}", name, &hash[..8]))
        .join("workspaces")
}

/// Get the platform-specific user data directory.
///
/// - Linux: `~/.local/share/codehydra`
/// - macOS: `~/Library/Application Support/Codehydra`
/// - Windows: `%APPDATA%\Codehydra`
fn get_platform_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("codehydra")
    }

    #[cfg(target_os = "macos")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("~/Library/Application Support"))
            .join("Codehydra")
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Default\\AppData\\Local"))
            .join("Codehydra")
    }

    // Fallback for other platforms (shouldn't happen given our Platform enum)
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from(".").join("codehydra-data")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_path_encoding_spaces() {
        let path = Path::new("/home/user/my project/file.txt");
        let encoded = encode_path_for_url(path);
        assert_eq!(encoded, "/home/user/my%20project/file.txt");
    }

    #[test]
    fn test_path_encoding_special_chars() {
        // Test various special characters that need encoding
        let path = Path::new("/path/with spaces/and#hash/and?query");
        let encoded = encode_path_for_url(path);
        assert!(encoded.contains("%20"), "Space should be encoded");
        assert!(encoded.contains("%23"), "Hash should be encoded");
        assert!(encoded.contains("%3F"), "Question mark should be encoded");
    }

    #[test]
    fn test_path_encoding_preserves_slashes() {
        let path = Path::new("/a/b/c/d");
        let encoded = encode_path_for_url(path);
        // Forward slashes should be preserved
        assert_eq!(encoded, "/a/b/c/d");
    }

    #[test]
    fn test_path_encoding_quotes() {
        let path = Path::new("/path/with\"quotes");
        let encoded = encode_path_for_url(path);
        assert!(encoded.contains("%22"), "Double quote should be encoded");
    }

    #[test]
    fn test_path_encoding_angle_brackets() {
        let path = Path::new("/path/<with>/brackets");
        let encoded = encode_path_for_url(path);
        assert!(encoded.contains("%3C"), "Less than should be encoded");
        assert!(encoded.contains("%3E"), "Greater than should be encoded");
    }

    #[test]
    fn test_path_encoding_braces() {
        let path = Path::new("/path/{with}/braces");
        let encoded = encode_path_for_url(path);
        assert!(encoded.contains("%7B"), "Open brace should be encoded");
        assert!(encoded.contains("%7D"), "Close brace should be encoded");
    }

    #[test]
    fn test_path_normalization_success() {
        // Create a temporary directory to test with a real path
        let temp = tempdir().expect("Failed to create temp dir");
        let path = temp.path();

        let normalized = normalize_path(path);
        assert!(
            normalized.is_ok(),
            "Should successfully normalize existing path"
        );

        let normalized_path = normalized.unwrap();
        assert!(
            normalized_path.is_absolute(),
            "Normalized path should be absolute"
        );
    }

    #[test]
    fn test_path_normalization_error_on_nonexistent() {
        let path = Path::new("/this/path/definitely/does/not/exist/12345");
        let result = normalize_path(path);

        assert!(result.is_err(), "Should fail for non-existent path");

        if let Err(CodeServerError::InvalidPath(msg)) = result {
            assert!(
                msg.contains("/this/path/definitely/does/not/exist/12345"),
                "Error message should contain the path"
            );
        } else {
            panic!("Expected InvalidPath error");
        }
    }

    #[test]
    fn test_path_normalization_resolves_relative() {
        // Create temp directory with a subdirectory
        let temp = tempdir().expect("Failed to create temp dir");
        let subdir = temp.path().join("subdir");
        fs::create_dir(&subdir).expect("Failed to create subdir");

        // Create a path with relative components
        let relative_path = subdir.join("..");
        let normalized = normalize_path(&relative_path);

        assert!(
            normalized.is_ok(),
            "Should normalize path with relative components"
        );
        let normalized_path = normalized.unwrap();

        // The normalized path should be equivalent to temp.path() (canonicalized)
        let expected = temp.path().canonicalize().unwrap();
        assert_eq!(
            normalized_path, expected,
            "Should resolve .. to parent directory"
        );
    }

    #[test]
    fn test_get_data_root_dir_not_empty() {
        let root = get_data_root_dir();
        assert!(!root.as_os_str().is_empty());
    }

    #[test]
    fn test_get_data_root_dir_debug_mode() {
        // In debug mode (which is how tests run), should use app-data
        let root = get_data_root_dir();
        let path_str = root.to_string_lossy();

        // Debug builds use app-data directory
        if cfg!(debug_assertions) {
            assert!(
                path_str.contains("app-data"),
                "Debug build should use app-data directory: {path_str}"
            );
        }
    }

    #[test]
    fn test_get_data_version_dir_includes_version() {
        let version = "1.2.3";
        let dir = get_data_version_dir(version);
        assert!(
            dir.to_string_lossy().contains(version),
            "Version dir should include version"
        );
        assert!(
            dir.starts_with(get_data_root_dir()),
            "Version dir should be under root dir"
        );
    }

    #[test]
    fn test_get_data_version_dir_debug_mode() {
        // In debug mode (which is how tests run), should use app-data
        let data_dir = get_data_version_dir("0.1.0");
        let path_str = data_dir.to_string_lossy();

        // Debug builds use app-data directory
        if cfg!(debug_assertions) {
            assert!(
                path_str.contains("app-data"),
                "Debug build should use app-data directory: {path_str}"
            );
        }
    }

    #[test]
    fn test_get_data_projects_dir() {
        let dir = get_data_projects_dir();
        assert!(
            dir.ends_with("projects"),
            "Projects dir should end with 'projects'"
        );
        assert!(
            dir.starts_with(get_data_root_dir()),
            "Projects dir should be under root dir"
        );
    }

    #[test]
    fn test_get_data_projects_dir_debug_mode() {
        let dir = get_data_projects_dir();
        let path_str = dir.to_string_lossy();

        if cfg!(debug_assertions) {
            assert!(
                path_str.contains("app-data"),
                "Debug build should use app-data directory: {path_str}"
            );
        }
    }

    #[test]
    fn test_sanitize_workspace_name_replaces_slashes() {
        assert_eq!(
            sanitize_workspace_name_for_path("feature/auth"),
            "feature%auth"
        );
        assert_eq!(
            sanitize_workspace_name_for_path("feature/auth/oauth"),
            "feature%auth%oauth"
        );
    }

    #[test]
    fn test_sanitize_workspace_name_preserves_other_chars() {
        assert_eq!(
            sanitize_workspace_name_for_path("simple-name"),
            "simple-name"
        );
        assert_eq!(
            sanitize_workspace_name_for_path("with_underscore"),
            "with_underscore"
        );
        assert_eq!(sanitize_workspace_name_for_path("with.dot"), "with.dot");
    }

    #[test]
    fn test_unsanitize_workspace_name_restores_slashes() {
        assert_eq!(
            unsanitize_workspace_name_from_path("feature%auth"),
            "feature/auth"
        );
        assert_eq!(
            unsanitize_workspace_name_from_path("feature%auth%oauth"),
            "feature/auth/oauth"
        );
    }

    #[test]
    fn test_unsanitize_workspace_name_preserves_other_chars() {
        assert_eq!(
            unsanitize_workspace_name_from_path("simple-name"),
            "simple-name"
        );
        assert_eq!(
            unsanitize_workspace_name_from_path("with_underscore"),
            "with_underscore"
        );
        assert_eq!(unsanitize_workspace_name_from_path("with.dot"), "with.dot");
    }

    #[test]
    fn test_sanitize_unsanitize_roundtrip() {
        let names = vec![
            "feature/auth",
            "feature/auth/oauth",
            "simple-name",
            "bugfix/issue-123",
            "release/v1.0.0",
        ];

        for name in names {
            let sanitized = sanitize_workspace_name_for_path(name);
            let restored = unsanitize_workspace_name_from_path(&sanitized);
            assert_eq!(restored, name, "Roundtrip failed for: {name}");
        }
    }
}
