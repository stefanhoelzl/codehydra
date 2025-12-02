//! Error types for code-server and project store operations.

use thiserror::Error;

/// Error types for code-server operations
#[derive(Debug, Error)]
pub enum CodeServerError {
    // Setup errors
    #[error("Failed to download {component}: {source}")]
    DownloadFailed {
        component: String,
        #[source]
        source: reqwest::Error,
    },

    #[error("Checksum mismatch for {file}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        file: String,
        expected: String,
        actual: String,
    },

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

/// Error types for project store operations
#[derive(Debug, Error)]
pub enum ProjectStoreError {
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Failed to serialize/deserialize project config: {0}")]
    SerializationError(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_download_failed() {
        // Create a mock reqwest error by attempting an invalid request
        let error = CodeServerError::DownloadFailed {
            component: "Bun".to_string(),
            source: reqwest::blocking::get("http://[::1]:0/invalid")
                .expect_err("Expected error for invalid URL"),
        };
        let display = format!("{error}");
        assert!(display.contains("Failed to download Bun"));
    }

    #[test]
    fn test_error_display_checksum_mismatch() {
        let error = CodeServerError::ChecksumMismatch {
            file: "bun-linux-x64.zip".to_string(),
            expected: "abc123".to_string(),
            actual: "def456".to_string(),
        };
        let display = format!("{error}");
        assert_eq!(
            display,
            "Checksum mismatch for bun-linux-x64.zip: expected abc123, got def456"
        );
    }

    #[test]
    fn test_error_display_extraction_failed() {
        let error = CodeServerError::ExtractionFailed("Invalid ZIP header".to_string());
        assert_eq!(
            format!("{error}"),
            "Failed to extract archive: Invalid ZIP header"
        );
    }

    #[test]
    fn test_error_display_unsupported_platform() {
        let error = CodeServerError::UnsupportedPlatform;
        assert_eq!(format!("{error}"), "Unsupported platform");
    }

    #[test]
    fn test_error_display_permission_error() {
        let io_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let error = CodeServerError::PermissionError(io_error);
        let display = format!("{error}");
        assert!(display.contains("Permission error"));
    }

    #[test]
    fn test_error_display_invalid_path() {
        let error = CodeServerError::InvalidPath("/invalid/path".to_string());
        assert_eq!(format!("{error}"), "Invalid path: /invalid/path");
    }

    #[test]
    fn test_error_display_no_available_ports() {
        let error = CodeServerError::NoAvailablePorts { start: 50000 };
        assert_eq!(format!("{error}"), "No available ports starting from 50000");
    }

    #[test]
    fn test_error_display_spawn_failed() {
        let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, "binary not found");
        let error = CodeServerError::SpawnFailed(io_error);
        let display = format!("{error}");
        assert!(display.contains("Failed to spawn process"));
    }

    #[test]
    fn test_error_display_health_check_failed() {
        let error = CodeServerError::HealthCheckFailed { attempts: 300 };
        assert_eq!(format!("{error}"), "Health check failed after 300 attempts");
    }

    #[test]
    fn test_error_display_process_terminated() {
        let error = CodeServerError::ProcessTerminated { code: Some(1) };
        assert_eq!(
            format!("{error}"),
            "Process terminated unexpectedly with code Some(1)"
        );

        let error_none = CodeServerError::ProcessTerminated { code: None };
        assert_eq!(
            format!("{error_none}"),
            "Process terminated unexpectedly with code None"
        );
    }

    #[test]
    fn test_error_display_process_kill_failed() {
        let error = CodeServerError::ProcessKillFailed("ESRCH: No such process".to_string());
        assert_eq!(
            format!("{error}"),
            "Failed to kill process: ESRCH: No such process"
        );
    }

    #[test]
    fn test_error_display_instance_not_running() {
        let error = CodeServerError::InstanceNotRunning;
        assert_eq!(format!("{error}"), "Instance not running");
    }

    #[test]
    fn test_error_display_invalid_state_transition() {
        let error = CodeServerError::InvalidStateTransition;
        assert_eq!(format!("{error}"), "Invalid state transition");
    }

    #[test]
    fn test_error_display_extension_install_failed() {
        let error = CodeServerError::ExtensionInstallFailed {
            extension: "Anthropic.claude-code".to_string(),
            reason: "Network timeout".to_string(),
        };
        assert_eq!(
            format!("{error}"),
            "Failed to install extension Anthropic.claude-code: Network timeout"
        );
    }

    #[test]
    fn test_error_is_debug() {
        let error = CodeServerError::UnsupportedPlatform;
        let debug = format!("{error:?}");
        assert!(debug.contains("UnsupportedPlatform"));
    }

    // ProjectStoreError tests
    #[test]
    fn test_project_store_error_display_io() {
        let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let error = ProjectStoreError::IoError(io_error);
        let display = format!("{error}");
        assert!(display.contains("IO error"));
    }

    #[test]
    fn test_project_store_error_display_serialization() {
        // Create a JSON parse error
        let json_error = serde_json::from_str::<serde_json::Value>("invalid json{")
            .expect_err("Expected JSON parse error");
        let error = ProjectStoreError::SerializationError(json_error);
        let display = format!("{error}");
        assert!(display.contains("serialize/deserialize"));
    }

    #[test]
    fn test_project_store_error_is_debug() {
        let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, "test");
        let error = ProjectStoreError::IoError(io_error);
        let debug = format!("{error:?}");
        assert!(debug.contains("IoError"));
    }

    #[test]
    fn test_project_store_error_from_io() {
        let io_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let error: ProjectStoreError = io_error.into();
        assert!(matches!(error, ProjectStoreError::IoError(_)));
    }

    #[test]
    fn test_project_store_error_from_serde() {
        let json_error = serde_json::from_str::<serde_json::Value>("not json")
            .expect_err("Expected JSON parse error");
        let error: ProjectStoreError = json_error.into();
        assert!(matches!(error, ProjectStoreError::SerializationError(_)));
    }
}
