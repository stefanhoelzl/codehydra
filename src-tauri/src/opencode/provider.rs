use crate::agent_status::AgentStatusCounts;
use crate::agent_status_provider::{AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory};
use crate::opencode::{discovery::OpenCodeDiscoveryService, client::DefaultClientFactory, ClientFactory};
use crate::opencode::types::{SessionStatus, SessionStatusMap, SessionStatusEventProperties};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{broadcast, Mutex};

#[derive(Debug)]
pub struct OpenCodeProvider {
    workspace_path: PathBuf,
    discovery_service: Arc<OpenCodeDiscoveryService>,
    client_factory: Arc<dyn ClientFactory>,
    status_sender: broadcast::Sender<AgentStatusCounts>,
    current_counts: Arc<RwLock<AgentStatusCounts>>,
    active: Arc<AtomicBool>,
    task_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl OpenCodeProvider {
    pub fn new(
        workspace_path: PathBuf,
        discovery_service: Arc<OpenCodeDiscoveryService>,
    ) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            workspace_path,
            discovery_service,
            client_factory: Arc::new(DefaultClientFactory),
            status_sender: tx,
            current_counts: Arc::new(RwLock::new(AgentStatusCounts::default())),
            active: Arc::new(AtomicBool::new(false)),
            task_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn new_with_factory(
        workspace_path: PathBuf,
        discovery_service: Arc<OpenCodeDiscoveryService>,
        client_factory: Arc<dyn ClientFactory>,
    ) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            workspace_path,
            discovery_service,
            client_factory,
            status_sender: tx,
            current_counts: Arc::new(RwLock::new(AgentStatusCounts::default())),
            active: Arc::new(AtomicBool::new(false)),
            task_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Update counts from session status map
    /// Each session can be idle, busy, or retrying
    /// 
    /// IMPORTANT: When connected to OpenCode but no sessions are active/busy,
    /// we report 1 idle to show a green indicator (connected state).
    /// This distinguishes "connected but idle" from "not connected" (grey).
    fn update_counts_from_status(
        status_map: &SessionStatusMap,
        counts: &Arc<RwLock<AgentStatusCounts>>,
        sender: &broadcast::Sender<AgentStatusCounts>,
    ) {
        let mut idle = 0u32;
        let mut busy = 0u32;
        
        for status in status_map.values() {
            if status.is_busy() {
                busy += 1;
            } else {
                idle += 1;
            }
        }

        // If we're connected to OpenCode but have no sessions tracked,
        // report as "1 idle" to show green (connected) instead of grey (not connected)
        if idle == 0 && busy == 0 {
            idle = 1;
        }

        let new_counts = AgentStatusCounts::new(idle, busy);
        {
            let mut guard = counts.write().unwrap();
            *guard = new_counts;
        }
        let _ = sender.send(new_counts);
    }

    async fn run_monitor(
        workspace_path: PathBuf,
        discovery: Arc<OpenCodeDiscoveryService>,
        client_factory: Arc<dyn ClientFactory>,
        counts: Arc<RwLock<AgentStatusCounts>>,
        sender: broadcast::Sender<AgentStatusCounts>,
        active_flag: Arc<AtomicBool>,
    ) {
        loop {
            if !active_flag.load(Ordering::Relaxed) {
                break;
            }

            // 1. Discovery - look up the workspace path directly
            // OpenCode reports its actual working directory (including worktree paths)
            let port = loop {
                if !active_flag.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(p) = discovery.get_port(&workspace_path).await {
                    break p;
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            };

            // 2. Connect
            let client = client_factory.create_client(port);

            // 3. Initial state - connected but no known session statuses yet
            // We'll track session statuses from SSE events
            let mut session_statuses: HashMap<String, SessionStatus> = HashMap::new();
            
            // Mark as connected (idle) initially
            Self::update_counts_from_status(&session_statuses, &counts, &sender);

            // 4. Event Stream
            if let Ok(mut stream) = client.subscribe_events().await {
                while let Some(result) = stream.next().await {
                    if !active_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    
                    match result {
                        Ok(event) => {
                            // Handle session.status events - update our local tracking
                            if event.event_type == "session.status" {
                                if let Ok(props) = serde_json::from_value::<SessionStatusEventProperties>(event.properties.clone()) {
                                    session_statuses.insert(props.session_id, props.status);
                                    Self::update_counts_from_status(&session_statuses, &counts, &sender);
                                }
                            }
                            // Handle session.idle events - mark session as idle
                            else if event.event_type == "session.idle" {
                                if let Some(session_id) = event.properties.get("sessionID").and_then(|v| v.as_str()) {
                                    session_statuses.insert(session_id.to_string(), SessionStatus::Idle);
                                    Self::update_counts_from_status(&session_statuses, &counts, &sender);
                                }
                            }
                            // Handle session.deleted events - remove from tracking
                            else if event.event_type == "session.deleted" {
                                if let Some(session_id) = event.properties.get("sessionID").and_then(|v| v.as_str()) {
                                    session_statuses.remove(session_id);
                                    Self::update_counts_from_status(&session_statuses, &counts, &sender);
                                }
                            }
                        }
                        Err(_) => {
                            break; 
                        }
                    }
                }
            }

            // Connection lost - reset to disconnected state
            {
                let mut guard = counts.write().unwrap();
                *guard = AgentStatusCounts::default();
                let _ = sender.send(AgentStatusCounts::default());
            }
            
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
    }
}

#[async_trait]
impl AgentStatusProvider for OpenCodeProvider {
    fn provider_id(&self) -> &'static str {
        "sst-dev.opencode"
    }

    fn provider_name(&self) -> &'static str {
        "OpenCode"
    }

    fn workspace_path(&self) -> &Path {
        &self.workspace_path
    }

    fn current_status(&self) -> AgentStatusCounts {
        self.current_counts.read().unwrap().clone()
    }

    fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
        self.status_sender.subscribe()
    }

    async fn start(&self) -> Result<(), AgentStatusError> {
        if self.active.swap(true, Ordering::Relaxed) {
             return Err(AgentStatusError::AlreadyStarted);
        }

        let wp = self.workspace_path.clone();
        let ds = self.discovery_service.clone();
        let cf = self.client_factory.clone();
        let counts = self.current_counts.clone();
        let sender = self.status_sender.clone();
        let active = self.active.clone();

        let handle = tokio::spawn(async move {
            Self::run_monitor(wp, ds, cf, counts, sender, active).await;
        });

        *self.task_handle.lock().await = Some(handle);
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentStatusError> {
        if !self.active.swap(false, Ordering::Relaxed) {
             return Err(AgentStatusError::NotStarted);
        }
        
        let mut handle = self.task_handle.lock().await;
        if let Some(h) = handle.take() {
            h.abort();
        }
        Ok(())
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

pub struct OpenCodeProviderFactory {
    discovery_service: Arc<OpenCodeDiscoveryService>,
}

impl OpenCodeProviderFactory {
    pub fn new(discovery_service: Arc<OpenCodeDiscoveryService>) -> Self {
        Self { discovery_service }
    }
}

#[async_trait]
impl AgentStatusProviderFactory for OpenCodeProviderFactory {
    fn factory_id(&self) -> &'static str {
        "opencode-factory"
    }

    async fn create_providers(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
        let provider = OpenCodeProvider::new(workspace_path.to_path_buf(), self.discovery_service.clone());
        Ok(vec![Box::new(provider)])
    }

    async fn supports_workspace(&self, _workspace_path: &Path) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opencode::{MockClientFactory, MockOpenCodeClient, MockPortScanner, MockInstanceProbe};
    use crate::opencode::discovery::OpenCodeDiscoveryService;
    use crate::opencode::types::SessionStatus;
    use crate::opencode::{MockProcessTree, PortInfo};
    use futures::stream::{self, BoxStream};
    use std::collections::{HashMap, HashSet};

    const CODE_SERVER_PID: u32 = 1000;
    const OPENCODE_PID: u32 = 1001;

    fn create_mock_process_tree() -> MockProcessTree {
        let mut mock_tree = MockProcessTree::new();
        mock_tree.expect_refresh().returning(|| {});
        mock_tree.expect_get_descendant_pids().returning(|_| {
            let mut descendants = HashSet::new();
            descendants.insert(OPENCODE_PID);
            descendants
        });
        mock_tree
    }

    #[tokio::test]
    async fn test_provider_connects_when_port_discovered() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        mock_probe
            .expect_probe()
            .with(mockall::predicate::eq(3000))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo")) }));

        let discovery = Arc::new(OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        ));

        discovery.set_code_server_pid(Some(CODE_SERVER_PID)).await;
        discovery.scan_and_update().await.unwrap();

        let mut mock_factory = MockClientFactory::new();
        mock_factory.expect_create_client()
            .with(mockall::predicate::eq(3000))
            .returning(|_| {
                let mut client = MockOpenCodeClient::new();
                client.expect_get_session_status()
                    .returning(|| Box::pin(async { Ok(HashMap::new()) }));
                client.expect_subscribe_events()
                    .returning(|| Box::pin(async { 
                        Ok(Box::pin(stream::pending()) as BoxStream<'static, Result<crate::opencode::types::Event, crate::opencode::OpenCodeError>>) 
                    })); 
                Box::new(client)
            });

        let provider = OpenCodeProvider::new_with_factory(
            PathBuf::from("/foo"),
            discovery,
            Arc::new(mock_factory),
        );

        provider.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(provider.is_active());
        provider.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_live_status_updates() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));
        mock_probe
            .expect_probe()
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo")) }));
        let discovery = Arc::new(OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        ));
        discovery.set_code_server_pid(Some(CODE_SERVER_PID)).await;
        discovery.scan_and_update().await.unwrap();

        let mut mock_factory = MockClientFactory::new();
        mock_factory.expect_create_client()
            .returning(|_| {
                let mut client = MockOpenCodeClient::new();
                // Initial status: empty (no sessions)
                client.expect_get_session_status()
                    .times(1)
                    .returning(|| Box::pin(async { Ok(HashMap::new()) }));
                
                // Event stream that sends a session.status event
                client.expect_subscribe_events()
                    .returning(|| Box::pin(async {
                        let event = crate::opencode::types::Event {
                            event_type: "session.status".to_string(),
                            properties: serde_json::json!({
                                "sessionID": "123",
                                "status": { "type": "busy" }
                            }),
                        };
                        let s = stream::iter(vec![Ok(event)]).chain(stream::pending());
                        Ok(Box::pin(s) as BoxStream<'static, Result<crate::opencode::types::Event, crate::opencode::OpenCodeError>>)
                    }));
                    
                // After event, status shows busy session
                client.expect_get_session_status()
                    .times(1)
                    .returning(|| Box::pin(async { 
                        let mut map = HashMap::new();
                        map.insert("123".to_string(), SessionStatus::Busy);
                        Ok(map)
                    }));
                    
                Box::new(client)
            });

        let provider = OpenCodeProvider::new_with_factory(
            PathBuf::from("/foo"),
            discovery,
            Arc::new(mock_factory),
        );
        
        let mut rx = provider.subscribe();
        provider.start().await.unwrap();
        
        let mut found_busy = false;
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(1));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                Ok(status) = rx.recv() => {
                    if status.busy == 1 {
                        found_busy = true;
                        break;
                    }
                }
                _ = &mut timeout => {
                    break;
                }
            }
        }
        
        assert!(found_busy, "Did not receive busy status update");
        provider.stop().await.unwrap();
    }
}