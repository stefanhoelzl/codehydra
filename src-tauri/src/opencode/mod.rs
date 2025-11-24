pub mod client;
pub mod discovery;
pub mod provider;
pub mod types;

use async_trait::async_trait;
use futures::stream::BoxStream;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenCodeError {
    #[error("Discovery service not initialized")]
    DiscoveryNotReady,
    #[error("Connection failed: {0}")]
    ConnectionFailed(#[from] reqwest::Error),
    #[error("Stream interrupted")]
    StreamInterrupted,
    #[error("Invalid workspace path")]
    InvalidPath,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Trait for port scanning (mockable)
#[cfg_attr(test, mockall::automock)]
pub trait PortScanner: Send + Sync {
    /// Get all listening ports and their associated process names
    fn get_active_listeners(&self) -> Result<Vec<(u16, String)>, OpenCodeError>;
}

/// Trait for probing a port to see if it's an OpenCode instance (mockable)
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait InstanceProbe: Send + Sync {
    async fn probe(&self, port: u16) -> Result<PathBuf, OpenCodeError>;
}

/// Trait for OpenCode API interaction (mockable)
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait OpenCodeClient: Send + Sync {
    async fn get_workspace_path(&self) -> Result<PathBuf, OpenCodeError>;
    async fn get_session_status(&self) -> Result<types::SessionStatusMap, OpenCodeError>;
    async fn subscribe_events(
        &self,
    ) -> Result<BoxStream<'static, Result<types::Event, OpenCodeError>>, OpenCodeError>;
}

/// Factory for creating clients (mockable)
#[cfg_attr(test, mockall::automock)]
pub trait ClientFactory: Send + Sync + std::fmt::Debug {
    fn create_client(&self, port: u16) -> Box<dyn OpenCodeClient>;
}
