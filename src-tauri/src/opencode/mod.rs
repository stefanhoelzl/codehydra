pub mod client;
pub mod discovery;
pub mod provider;
pub mod types;

use async_trait::async_trait;
use futures::stream::BoxStream;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::RwLock;
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

/// Information about a listening port and its associated process
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
}

/// Trait for port scanning (mockable)
#[cfg_attr(test, mockall::automock)]
pub trait PortScanner: Send + Sync {
    /// Get all listening ports and their associated process IDs
    fn get_active_listeners(&self) -> Result<Vec<PortInfo>, OpenCodeError>;
}

/// Trait for process tree operations (mockable for testing)
#[cfg_attr(test, mockall::automock)]
pub trait ProcessTree: Send + Sync {
    /// Check if `pid` is a descendant of `ancestor_pid`
    fn is_descendant_of(&self, pid: u32, ancestor_pid: u32) -> bool;

    /// Refresh the process tree (call before ancestry checks)
    fn refresh(&self);

    /// Get all descendant PIDs of an ancestor (pre-computed for efficiency)
    fn get_descendant_pids(&self, ancestor_pid: u32) -> HashSet<u32>;
}

/// Implementation of ProcessTree using sysinfo crate
pub struct SysinfoProcessTree {
    system: RwLock<sysinfo::System>,
}

impl SysinfoProcessTree {
    pub fn new() -> Self {
        Self {
            system: RwLock::new(sysinfo::System::new()),
        }
    }
}

impl Default for SysinfoProcessTree {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTree for SysinfoProcessTree {
    fn refresh(&self) {
        // Note: sysinfo refresh can take 50-200ms on systems with many processes
        // Caller should use spawn_blocking to avoid blocking async runtime
        let mut sys = self.system.write().unwrap();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    }

    fn get_descendant_pids(&self, ancestor_pid: u32) -> HashSet<u32> {
        let sys = self.system.read().unwrap();
        let ancestor = sysinfo::Pid::from_u32(ancestor_pid);
        let mut descendants = HashSet::new();

        // Pre-compute all descendants in one pass (O(n) instead of O(n*d))
        for pid in sys.processes().keys() {
            let mut current = *pid;
            while let Some(proc) = sys.process(current) {
                if let Some(parent) = proc.parent() {
                    if parent == ancestor {
                        descendants.insert(pid.as_u32());
                        break;
                    }
                    current = parent;
                } else {
                    break;
                }
            }
        }
        descendants
    }

    fn is_descendant_of(&self, pid: u32, ancestor_pid: u32) -> bool {
        let sys = self.system.read().unwrap();
        let mut current = sysinfo::Pid::from_u32(pid);
        let ancestor = sysinfo::Pid::from_u32(ancestor_pid);

        while let Some(process) = sys.process(current) {
            if let Some(parent) = process.parent() {
                if parent == ancestor {
                    return true;
                }
                current = parent;
            } else {
                break;
            }
        }
        false
    }
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
