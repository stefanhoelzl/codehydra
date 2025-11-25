// src-tauri/src/agent_status_provider.rs

use async_trait::async_trait;
use std::path::Path;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::agent_status::AgentStatusCounts;

/// Error type for agent status operations
#[derive(Debug, Error)]
pub enum AgentStatusError {
    #[error("Provider initialization failed: {message}")]
    InitializationFailed {
        message: String,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    #[error("Subscription failed: {0}")]
    SubscriptionFailed(String),

    #[error("Provider not supported for workspace: {0}")]
    NotSupported(String),

    #[error("Provider already started")]
    AlreadyStarted,

    #[error("Provider not started")]
    NotStarted,

    #[error("Internal error: {message}")]
    Internal {
        message: String,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    #[error("Operation cancelled")]
    Cancelled,
}

impl AgentStatusError {
    /// Create an initialization error with a message
    pub fn initialization_failed(message: impl Into<String>) -> Self {
        Self::InitializationFailed {
            message: message.into(),
            source: None,
        }
    }

    /// Create an initialization error with a source error
    pub fn initialization_failed_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::InitializationFailed {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// Create an internal error with a message
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            source: None,
        }
    }

    /// Create an internal error with a source error
    pub fn internal_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::Internal {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }
}

/// Trait for providers that observe agent status in a workspace
///
/// Implementations will watch specific agent types (Claude Code, OpenCode, etc.)
/// and emit status change events when agents become idle or busy.
///
/// # Threading Model
/// - Providers must be `Send + Sync` for use across async tasks
/// - The `subscribe()` method returns a broadcast receiver for status updates
/// - Implementations should use atomic operations or internal locks for state
#[async_trait]
pub trait AgentStatusProvider: Send + Sync + std::fmt::Debug {
    /// Unique identifier for this provider type (e.g., "claude-code", "opencode")
    fn provider_id(&self) -> &'static str;

    /// Human-readable name for this provider
    fn provider_name(&self) -> &'static str;

    /// The workspace path this provider is watching
    fn workspace_path(&self) -> &Path;

    /// Get current status counts
    fn current_status(&self) -> AgentStatusCounts;

    /// Subscribe to status change events
    /// Returns a receiver that will get AgentStatusCounts whenever status changes
    fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts>;

    /// Start watching for agent status changes
    /// This should be called once after creation to begin monitoring
    async fn start(&self) -> Result<(), AgentStatusError>;

    /// Stop watching for agent status changes
    async fn stop(&self) -> Result<(), AgentStatusError>;

    /// Check if this provider is currently active/watching
    fn is_active(&self) -> bool;
}

/// Factory trait for creating AgentStatusProviders
#[async_trait]
pub trait AgentStatusProviderFactory: Send + Sync {
    /// Unique identifier for this factory
    fn factory_id(&self) -> &'static str;

    /// Create providers for a workspace
    /// Returns empty vec if no supported agents are detected
    async fn create_providers(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError>;

    /// Check if this factory can potentially create providers for the workspace
    /// This is async because detection may require I/O (checking config files, etc.)
    /// Returns true if this factory might be able to create providers.
    /// Actual creation may still fail.
    async fn supports_workspace(&self, workspace_path: &Path) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tokio::sync::broadcast;

    /// Mock implementation of AgentStatusProvider for testing
    #[derive(Debug)]
    struct MockProvider {
        id: &'static str,
        name: &'static str,
        workspace: PathBuf,
        idle_count: AtomicU32,
        busy_count: AtomicU32,
        active: AtomicBool,
        sender: broadcast::Sender<AgentStatusCounts>,
    }

    impl MockProvider {
        fn new(workspace: PathBuf) -> Self {
            let (sender, _) = broadcast::channel(16);
            Self {
                id: "mock-provider",
                name: "Mock Provider",
                workspace,
                idle_count: AtomicU32::new(0),
                busy_count: AtomicU32::new(0),
                active: AtomicBool::new(false),
                sender,
            }
        }

        fn set_counts(&self, idle: u32, busy: u32) {
            self.idle_count.store(idle, Ordering::SeqCst);
            self.busy_count.store(busy, Ordering::SeqCst);
            let counts = AgentStatusCounts::new(idle, busy);
            let _ = self.sender.send(counts);
        }
    }

    #[async_trait]
    impl AgentStatusProvider for MockProvider {
        fn provider_id(&self) -> &'static str {
            self.id
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }

        fn workspace_path(&self) -> &Path {
            &self.workspace
        }

        fn current_status(&self) -> AgentStatusCounts {
            AgentStatusCounts::new(
                self.idle_count.load(Ordering::SeqCst),
                self.busy_count.load(Ordering::SeqCst),
            )
        }

        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            self.sender.subscribe()
        }

        async fn start(&self) -> Result<(), AgentStatusError> {
            if self.active.load(Ordering::SeqCst) {
                return Err(AgentStatusError::AlreadyStarted);
            }
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }

        async fn stop(&self) -> Result<(), AgentStatusError> {
            if !self.active.load(Ordering::SeqCst) {
                return Err(AgentStatusError::NotStarted);
            }
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn is_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
    }

    // === Provider Tests ===

    #[test]
    fn test_provider_id() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert_eq!(provider.provider_id(), "mock-provider");
    }

    #[test]
    fn test_provider_name() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert_eq!(provider.provider_name(), "Mock Provider");
    }

    #[test]
    fn test_provider_workspace_path() {
        let path = PathBuf::from("/test/workspace");
        let provider = MockProvider::new(path.clone());
        assert_eq!(provider.workspace_path(), path.as_path());
    }

    #[test]
    fn test_provider_current_status_default() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let status = provider.current_status();
        assert_eq!(status.idle, 0);
        assert_eq!(status.busy, 0);
    }

    #[test]
    fn test_provider_current_status_after_update() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.set_counts(2, 3);
        let status = provider.current_status();
        assert_eq!(status.idle, 2);
        assert_eq!(status.busy, 3);
    }

    #[tokio::test]
    async fn test_provider_start() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        assert!(!provider.is_active());
        provider.start().await.unwrap();
        assert!(provider.is_active());
    }

    #[tokio::test]
    async fn test_provider_start_already_started() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.start().await.unwrap();
        let result = provider.start().await;
        assert!(matches!(result, Err(AgentStatusError::AlreadyStarted)));
    }

    #[tokio::test]
    async fn test_provider_stop() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        provider.start().await.unwrap();
        assert!(provider.is_active());
        provider.stop().await.unwrap();
        assert!(!provider.is_active());
    }

    #[tokio::test]
    async fn test_provider_stop_not_started() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let result = provider.stop().await;
        assert!(matches!(result, Err(AgentStatusError::NotStarted)));
    }

    #[tokio::test]
    async fn test_provider_subscribe_receives_updates() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let mut rx = provider.subscribe();

        provider.set_counts(1, 2);

        let received = rx.recv().await.unwrap();
        assert_eq!(received.idle, 1);
        assert_eq!(received.busy, 2);
    }

    #[tokio::test]
    async fn test_provider_multiple_subscribers() {
        let provider = MockProvider::new(PathBuf::from("/test"));
        let mut rx1 = provider.subscribe();
        let mut rx2 = provider.subscribe();

        provider.set_counts(3, 4);

        let received1 = rx1.recv().await.unwrap();
        let received2 = rx2.recv().await.unwrap();

        assert_eq!(received1, received2);
        assert_eq!(received1.idle, 3);
    }

    // === Error Tests ===

    #[test]
    fn test_error_display_initialization_failed() {
        let err = AgentStatusError::initialization_failed("test reason");
        assert_eq!(
            err.to_string(),
            "Provider initialization failed: test reason"
        );
    }

    #[test]
    fn test_error_display_initialization_failed_with_source() {
        let source = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err = AgentStatusError::initialization_failed_with_source("test reason", source);
        assert_eq!(
            err.to_string(),
            "Provider initialization failed: test reason"
        );
        assert!(std::error::Error::source(&err).is_some());
    }

    #[test]
    fn test_error_display_not_supported() {
        let err = AgentStatusError::NotSupported("/path".to_string());
        assert_eq!(
            err.to_string(),
            "Provider not supported for workspace: /path"
        );
    }

    #[test]
    fn test_error_display_already_started() {
        let err = AgentStatusError::AlreadyStarted;
        assert_eq!(err.to_string(), "Provider already started");
    }

    #[test]
    fn test_error_display_not_started() {
        let err = AgentStatusError::NotStarted;
        assert_eq!(err.to_string(), "Provider not started");
    }

    #[test]
    fn test_error_display_cancelled() {
        let err = AgentStatusError::Cancelled;
        assert_eq!(err.to_string(), "Operation cancelled");
    }

    #[test]
    fn test_error_internal() {
        let err = AgentStatusError::internal("something went wrong");
        assert!(err.to_string().contains("something went wrong"));
    }

    #[test]
    fn test_error_internal_with_source() {
        let source = std::io::Error::other("io error");
        let err = AgentStatusError::internal_with_source("internal failure", source);
        assert!(err.to_string().contains("internal failure"));
        assert!(std::error::Error::source(&err).is_some());
    }
}
