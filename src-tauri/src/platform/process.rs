//! Process management utilities.
//!
//! This module provides cross-platform process spawning and management:
//! - Process group management (Unix) / job objects (Windows)
//! - Binary permission handling (set executable, remove quarantine)
//!
//! Uses the `process-wrap` crate for safe, cross-platform process group handling
//! without requiring unsafe code.

use crate::error::CodeServerError;
use process_wrap::tokio::{TokioChildWrapper, TokioCommandWrap};
use std::path::Path;

/// Spawn code-server in its own process group/job object.
///
/// This ensures that when the parent process terminates, all child processes
/// (including any processes spawned by code-server) are also terminated.
///
/// # Arguments
///
/// * `binary_path` - Path to the binary to run
/// * `args` - Command line arguments
/// * `cwd` - Working directory for the process
/// * `env_vars` - Environment variables to set as (key, value) pairs
///
/// # Errors
///
/// Returns `CodeServerError::SpawnFailed` if the process cannot be started.
pub async fn spawn_code_server_with_env(
    binary_path: &Path,
    args: &[&str],
    cwd: &Path,
    env_vars: &[(&str, &str)],
) -> Result<Box<dyn TokioChildWrapper>, CodeServerError> {
    let mut command = TokioCommandWrap::with_new(binary_path, |cmd| {
        cmd.args(args).current_dir(cwd);
        // Set environment variables
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    });

    // Set up process group/job object for proper cleanup
    #[cfg(unix)]
    {
        use process_wrap::tokio::ProcessGroup;
        command.wrap(ProcessGroup::leader());
    }

    #[cfg(windows)]
    {
        use process_wrap::tokio::JobObject;
        command.wrap(JobObject);
    }

    command.spawn().map_err(CodeServerError::SpawnFailed)
}

/// Spawn code-server in its own process group/job object.
///
/// This ensures that when the parent process terminates, all child processes
/// (including any processes spawned by code-server) are also terminated.
///
/// # Arguments
///
/// * `binary_path` - Path to the binary to run
/// * `args` - Command line arguments
/// * `cwd` - Working directory for the process
///
/// # Errors
///
/// Returns `CodeServerError::SpawnFailed` if the process cannot be started.
pub async fn spawn_code_server(
    binary_path: &Path,
    args: &[&str],
    cwd: &Path,
) -> Result<Box<dyn TokioChildWrapper>, CodeServerError> {
    spawn_code_server_with_env(binary_path, args, cwd, &[]).await
}

/// Set executable permissions on a file (Unix only).
///
/// On Unix systems, this sets the file permissions to 0755 (rwxr-xr-x).
/// On Windows, this is a no-op since executable permissions work differently.
///
/// # Errors
///
/// Returns `CodeServerError::PermissionError` if permissions cannot be set.
pub fn set_executable(path: &Path) -> Result<(), CodeServerError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(CodeServerError::PermissionError)?;
    }

    #[cfg(not(unix))]
    {
        let _ = path; // Silence unused variable warning on non-Unix
    }

    Ok(())
}

/// Remove macOS quarantine attribute from a file.
///
/// This intentionally ignores errors because:
/// - The file may not have the quarantine attribute (not downloaded from internet)
/// - The xattr command may not be available on some systems
/// - Failure here is non-fatal for app functionality
///
/// The quarantine attribute can prevent execution of downloaded binaries on macOS.
/// Removing it allows Bun to run without Gatekeeper warnings.
///
/// On non-macOS systems, this is a no-op.
pub fn remove_quarantine(path: &Path) -> Result<(), CodeServerError> {
    #[cfg(target_os = "macos")]
    {
        // Intentionally ignore errors - see function documentation
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(path)
            .output();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path; // Silence unused variable warning on non-macOS
    }

    Ok(())
}

/// Prepare a downloaded binary for execution.
///
/// This performs the necessary steps to make a downloaded binary executable:
/// 1. Set executable permissions (Unix)
/// 2. Remove quarantine attribute (macOS)
///
/// # Errors
///
/// Returns an error if permissions cannot be set (Unix only).
pub fn prepare_binary(path: &Path) -> Result<(), CodeServerError> {
    set_executable(path)?;
    remove_quarantine(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_set_executable_creates_executable_file() {
        let temp = tempdir().expect("Failed to create temp dir");
        let file_path = temp.path().join("test_binary");

        // Create the file
        File::create(&file_path).expect("Failed to create file");

        // Set executable
        let result = set_executable(&file_path);
        assert!(result.is_ok(), "Should successfully set executable permissions");

        // Verify on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&file_path).expect("Failed to get metadata");
            let mode = metadata.permissions().mode();
            // Check if user execute bit is set
            assert!(mode & 0o100 != 0, "User execute bit should be set");
        }
    }

    #[test]
    fn test_set_executable_nonexistent_file() {
        let path = Path::new("/nonexistent/path/binary");
        let result = set_executable(path);

        // Should fail on Unix, succeed (no-op) on Windows
        #[cfg(unix)]
        assert!(result.is_err(), "Should fail for non-existent file on Unix");

        #[cfg(windows)]
        assert!(result.is_ok(), "Should succeed (no-op) on Windows");
    }

    #[test]
    fn test_remove_quarantine_always_succeeds() {
        // remove_quarantine should always succeed (errors are ignored)
        let nonexistent = Path::new("/nonexistent/path");
        assert!(remove_quarantine(nonexistent).is_ok());

        let temp = tempdir().expect("Failed to create temp dir");
        let file_path = temp.path().join("test_file");
        File::create(&file_path).expect("Failed to create file");
        assert!(remove_quarantine(&file_path).is_ok());
    }

    #[test]
    fn test_prepare_binary_success() {
        let temp = tempdir().expect("Failed to create temp dir");
        let file_path = temp.path().join("test_binary");

        // Create the file
        File::create(&file_path).expect("Failed to create file");

        // Prepare binary
        let result = prepare_binary(&file_path);
        assert!(result.is_ok(), "Should successfully prepare binary");

        // Verify executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&file_path).expect("Failed to get metadata");
            let mode = metadata.permissions().mode();
            assert!(mode & 0o100 != 0, "Binary should be executable");
        }
    }

    #[test]
    fn test_prepare_binary_nonexistent_file() {
        let path = Path::new("/nonexistent/path/binary");
        let result = prepare_binary(path);

        // Should fail on Unix due to set_executable
        #[cfg(unix)]
        assert!(result.is_err(), "Should fail for non-existent file on Unix");

        #[cfg(windows)]
        assert!(result.is_ok(), "Should succeed (no-op) on Windows");
    }

    // Note: spawn_code_server is an async function that requires actual process spawning.
    // Testing it properly requires either:
    // 1. A real binary to spawn (not suitable for unit tests)
    // 2. Mocking the process spawner (implemented in later phases)
    //
    // For now, we test the synchronous helper functions and defer spawn testing
    // to integration tests or mock-based tests in Phase 6.
}
