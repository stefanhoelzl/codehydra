//! Code-server instance management
//!
//! Manages a single global code-server instance that serves all workspaces.

use crate::config::CodeServerConfig;
use crate::error::CodeServerError;
use crate::platform::paths::encode_path_for_url;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Child;
use tokio::sync::RwLock;

const HEALTH_CHECK_ATTEMPTS: u32 = 300;
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(100);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum InstanceState {
    Stopped,
    Starting,
    Running { child: Child },
    Stopping,
    Failed { error: String },
}

pub struct CodeServerInstance {
    port: u16,
    state: InstanceState,
}

impl CodeServerInstance {
    pub fn url_for_folder(&self, folder_path: &Path) -> String {
        let path_str = if cfg!(windows) {
            let s = folder_path.to_string_lossy();
            if s.chars().nth(1) == Some(':') {
                format!("/{}", s.replace('\\', "/"))
            } else {
                s.replace('\\', "/")
            }
        } else {
            folder_path.to_string_lossy().to_string()
        };
        let encoded = encode_path_for_url(Path::new(&path_str));
        format!("http://localhost:{}/?folder={}", self.port, encoded)
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, InstanceState::Running { .. })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[derive(Serialize, Clone)]
pub struct CodeServerInfo {
    pub port: u16,
    pub url: String,
}

pub struct CodeServerManager {
    config: Arc<CodeServerConfig>,
    instance: RwLock<Option<CodeServerInstance>>,
}

impl CodeServerManager {
    pub fn new(config: CodeServerConfig) -> Self {
        Self {
            config: Arc::new(config),
            instance: RwLock::new(None),
        }
    }

    pub async fn ensure_running(&self) -> Result<u16, CodeServerError> {
        let mut instance = self.instance.write().await;

        // Check if already running
        if let Some(inst) = instance.as_ref() {
            if inst.is_running() {
                return Ok(inst.port);
            }
        }

        // Find available port
        let port = self.find_available_port()?;

        // Transition to Starting
        *instance = Some(CodeServerInstance {
            port,
            state: InstanceState::Starting,
        });

        // Build command
        let child = self.spawn_code_server(port).await?;

        // Wait for health check
        drop(instance); // Release lock during health check
        self.wait_for_ready(port).await?;

        // Transition to Running
        let mut instance = self.instance.write().await;
        if let Some(inst) = instance.as_mut() {
            inst.state = InstanceState::Running { child };
        }

        Ok(port)
    }

    async fn spawn_code_server(&self, port: u16) -> Result<Child, CodeServerError> {
        use std::process::Stdio;
        use tokio::process::Command;

        let node_path = &self.config.node_binary_path;
        let code_server_entry = self.config.code_server_entry_path();
        let user_data_dir = &self.config.user_data_dir;
        let extensions_dir = &self.config.extensions_dir;

        // Run: node <code-server/out/node/entry.js> <args>
        let child = Command::new(node_path)
            .arg(&code_server_entry)
            .arg("--bind-addr")
            .arg(format!("127.0.0.1:{port}"))
            .arg("--auth")
            .arg("none")
            .arg("--user-data-dir")
            .arg(user_data_dir)
            .arg("--extensions-dir")
            .arg(extensions_dir)
            .arg("--disable-telemetry")
            .arg("--disable-update-check")
            .arg("--disable-workspace-trust")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(CodeServerError::SpawnFailed)?;

        Ok(child)
    }

    pub async fn stop(&self) -> Result<(), CodeServerError> {
        let mut instance = self.instance.write().await;

        if let Some(mut inst) = instance.take() {
            if let InstanceState::Running { mut child } = inst.state {
                inst.state = InstanceState::Stopping;

                // Try graceful shutdown
                let timeout =
                    tokio::time::timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await;

                if timeout.is_err() {
                    child
                        .kill()
                        .await
                        .map_err(|e| CodeServerError::ProcessKillFailed(e.to_string()))?;
                    child
                        .wait()
                        .await
                        .map_err(|e| CodeServerError::ProcessKillFailed(e.to_string()))?;
                }
            }
        }

        Ok(())
    }

    pub async fn url_for_folder(&self, folder_path: &Path) -> Option<String> {
        let instance = self.instance.read().await;
        instance
            .as_ref()
            .filter(|i| i.is_running())
            .map(|i| i.url_for_folder(folder_path))
    }

    pub async fn is_running(&self) -> bool {
        let instance = self.instance.read().await;
        instance.as_ref().is_some_and(|i| i.is_running())
    }

    pub async fn port(&self) -> Option<u16> {
        let instance = self.instance.read().await;
        instance.as_ref().filter(|i| i.is_running()).map(|i| i.port)
    }

    /// Get the PID of the running code-server process
    pub async fn pid(&self) -> Option<u32> {
        let instance = self.instance.read().await;
        instance.as_ref().and_then(|i| match &i.state {
            InstanceState::Running { child } => child.id(),
            _ => None,
        })
    }

    fn find_available_port(&self) -> Result<u16, CodeServerError> {
        let start = self.config.port_start;
        for port in start..=start + 100 {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return Ok(port);
            }
        }
        Err(CodeServerError::NoAvailablePorts { start })
    }

    async fn wait_for_ready(&self, port: u16) -> Result<(), CodeServerError> {
        let url = format!("http://127.0.0.1:{port}/healthz");

        for _ in 0..HEALTH_CHECK_ATTEMPTS {
            if reqwest::get(&url).await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
        }

        Err(CodeServerError::HealthCheckFailed {
            attempts: HEALTH_CHECK_ATTEMPTS,
        })
    }
}

// ============================================================================
// Internal Helper Functions (used by lib.rs)
// ============================================================================

/// Internal function to start code-server for a workspace path.
///
/// This is used by lib.rs for workspace discovery.
pub async fn start_code_server_internal(
    workspace_path: String,
    manager: &CodeServerManager,
) -> Result<CodeServerInfo, CodeServerError> {
    let port = manager.ensure_running().await?;
    let url = manager
        .url_for_folder(Path::new(&workspace_path))
        .await
        .ok_or(CodeServerError::InstanceNotRunning)?;
    Ok(CodeServerInfo { port, url })
}

/// Internal function to stop code-server.
pub async fn stop_code_server_internal(
    manager: &CodeServerManager,
) -> Result<(), CodeServerError> {
    manager.stop().await
}

/// Internal function to cleanup (stop) the server.
pub async fn cleanup_all_servers_internal(
    manager: &CodeServerManager,
) -> Result<(), CodeServerError> {
    manager.stop().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_config() -> CodeServerConfig {
        CodeServerConfig {
            runtime_dir: PathBuf::from("/tmp/test-runtime"),
            node_dir: PathBuf::from("/tmp/test-runtime/node"),
            node_binary_path: PathBuf::from("/tmp/test-runtime/node/bin/node"),
            extensions_dir: PathBuf::from("/tmp/test-runtime/extensions"),
            user_data_dir: PathBuf::from("/tmp/test-runtime/user-data"),
            port_start: 50000,
        }
    }

    #[test]
    fn test_url_for_folder_simple_path() {
        let instance = CodeServerInstance {
            port: 50000,
            state: InstanceState::Stopped,
        };

        let url = instance.url_for_folder(Path::new("/home/user/project"));
        assert_eq!(url, "http://localhost:50000/?folder=/home/user/project");
    }

    #[test]
    fn test_url_for_folder_with_spaces() {
        let instance = CodeServerInstance {
            port: 50000,
            state: InstanceState::Stopped,
        };

        let url = instance.url_for_folder(Path::new("/home/user/my project"));
        assert_eq!(url, "http://localhost:50000/?folder=/home/user/my%20project");
    }

    #[test]
    fn test_url_for_folder_with_special_chars() {
        let instance = CodeServerInstance {
            port: 50000,
            state: InstanceState::Stopped,
        };

        let url = instance.url_for_folder(Path::new("/home/user/project#test"));
        assert!(url.contains("%23"), "Hash should be encoded");
    }

    #[test]
    fn test_instance_is_running() {
        let stopped = CodeServerInstance {
            port: 50000,
            state: InstanceState::Stopped,
        };
        assert!(!stopped.is_running());

        let starting = CodeServerInstance {
            port: 50000,
            state: InstanceState::Starting,
        };
        assert!(!starting.is_running());

        let failed = CodeServerInstance {
            port: 50000,
            state: InstanceState::Failed {
                error: "test".to_string(),
            },
        };
        assert!(!failed.is_running());
    }

    #[test]
    fn test_instance_port() {
        let instance = CodeServerInstance {
            port: 50123,
            state: InstanceState::Stopped,
        };
        assert_eq!(instance.port(), 50123);
    }

    #[test]
    fn test_manager_new() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        assert!(manager.config.port_start == 50000);
    }

    #[tokio::test]
    async fn test_manager_is_running_when_no_instance() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        assert!(!manager.is_running().await);
    }

    #[tokio::test]
    async fn test_manager_port_when_no_instance() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        assert!(manager.port().await.is_none());
    }

    #[tokio::test]
    async fn test_manager_url_for_folder_when_not_running() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        let url = manager.url_for_folder(Path::new("/test")).await;
        assert!(url.is_none());
    }

    #[test]
    fn test_find_available_port_success() {
        let config = test_config();
        let manager = CodeServerManager::new(config);
        let port = manager.find_available_port();
        assert!(port.is_ok());
        let port = port.unwrap();
        assert!((50000..=50100).contains(&port));
    }
}
