use serde::Serialize;
use thiserror::Error;

/// Progress events emitted during runtime setup.
///
/// These events are serialized and sent to the frontend via Tauri's event system.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetupEvent {
    /// A setup step has started.
    StepStarted { step: SetupStep },
    /// Progress update for a step.
    Progress {
        step: SetupStep,
        percent: u8,
        message: Option<String>,
    },
    /// A setup step completed successfully.
    StepCompleted { step: SetupStep },
    /// A setup step failed.
    StepFailed { step: SetupStep, error: String },
    /// All setup steps completed successfully.
    SetupComplete,
}

/// Setup steps for runtime initialization.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SetupStep {
    /// Downloading and extracting Node.js runtime.
    Node,
    /// Installing code-server via npm.
    CodeServer,
    /// Installing required extensions.
    Extensions,
}

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
        let display = format!("{}", error);
        assert!(display.contains("Failed to download Bun"));
    }

    #[test]
    fn test_error_display_checksum_mismatch() {
        let error = CodeServerError::ChecksumMismatch {
            file: "bun-linux-x64.zip".to_string(),
            expected: "abc123".to_string(),
            actual: "def456".to_string(),
        };
        let display = format!("{}", error);
        assert_eq!(
            display,
            "Checksum mismatch for bun-linux-x64.zip: expected abc123, got def456"
        );
    }

    #[test]
    fn test_error_display_extraction_failed() {
        let error = CodeServerError::ExtractionFailed("Invalid ZIP header".to_string());
        assert_eq!(
            format!("{}", error),
            "Failed to extract archive: Invalid ZIP header"
        );
    }

    #[test]
    fn test_error_display_unsupported_platform() {
        let error = CodeServerError::UnsupportedPlatform;
        assert_eq!(format!("{}", error), "Unsupported platform");
    }

    #[test]
    fn test_error_display_permission_error() {
        let io_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let error = CodeServerError::PermissionError(io_error);
        let display = format!("{}", error);
        assert!(display.contains("Permission error"));
    }

    #[test]
    fn test_error_display_invalid_path() {
        let error = CodeServerError::InvalidPath("/invalid/path".to_string());
        assert_eq!(format!("{}", error), "Invalid path: /invalid/path");
    }

    #[test]
    fn test_error_display_no_available_ports() {
        let error = CodeServerError::NoAvailablePorts { start: 50000 };
        assert_eq!(
            format!("{}", error),
            "No available ports starting from 50000"
        );
    }

    #[test]
    fn test_error_display_spawn_failed() {
        let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, "binary not found");
        let error = CodeServerError::SpawnFailed(io_error);
        let display = format!("{}", error);
        assert!(display.contains("Failed to spawn process"));
    }

    #[test]
    fn test_error_display_health_check_failed() {
        let error = CodeServerError::HealthCheckFailed { attempts: 300 };
        assert_eq!(
            format!("{}", error),
            "Health check failed after 300 attempts"
        );
    }

    #[test]
    fn test_error_display_process_terminated() {
        let error = CodeServerError::ProcessTerminated { code: Some(1) };
        assert_eq!(
            format!("{}", error),
            "Process terminated unexpectedly with code Some(1)"
        );

        let error_none = CodeServerError::ProcessTerminated { code: None };
        assert_eq!(
            format!("{}", error_none),
            "Process terminated unexpectedly with code None"
        );
    }

    #[test]
    fn test_error_display_process_kill_failed() {
        let error = CodeServerError::ProcessKillFailed("ESRCH: No such process".to_string());
        assert_eq!(
            format!("{}", error),
            "Failed to kill process: ESRCH: No such process"
        );
    }

    #[test]
    fn test_error_display_instance_not_running() {
        let error = CodeServerError::InstanceNotRunning;
        assert_eq!(format!("{}", error), "Instance not running");
    }

    #[test]
    fn test_error_display_invalid_state_transition() {
        let error = CodeServerError::InvalidStateTransition;
        assert_eq!(format!("{}", error), "Invalid state transition");
    }

    #[test]
    fn test_error_display_extension_install_failed() {
        let error = CodeServerError::ExtensionInstallFailed {
            extension: "Anthropic.claude-code".to_string(),
            reason: "Network timeout".to_string(),
        };
        assert_eq!(
            format!("{}", error),
            "Failed to install extension Anthropic.claude-code: Network timeout"
        );
    }

    #[test]
    fn test_error_is_debug() {
        let error = CodeServerError::UnsupportedPlatform;
        let debug = format!("{:?}", error);
        assert!(debug.contains("UnsupportedPlatform"));
    }
}
