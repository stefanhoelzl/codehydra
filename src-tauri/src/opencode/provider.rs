use crate::agent_status::AgentStatusCounts;
use crate::agent_status_provider::{AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory};
use crate::opencode::{discovery::OpenCodeDiscoveryService, client::DefaultClientFactory, ClientFactory};
use crate::opencode::types::{SessionStatus, SessionStatusEventProperties};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio::task::JoinHandle;

/// Events from per-port monitor tasks
enum PortUpdate {
    Status { port: u16, counts: AgentStatusCounts },
    Disconnected { port: u16 },
}

#[derive(Debug)]
pub struct OpenCodeProvider {
    workspace_path: PathBuf,
    discovery_service: Arc<OpenCodeDiscoveryService>,
    client_factory: Arc<dyn ClientFactory>,
    status_sender: broadcast::Sender<AgentStatusCounts>,
    current_counts: Arc<RwLock<AgentStatusCounts>>,
    active: Arc<AtomicBool>,
    task_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
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

    /// Aggregate counts from all active ports
    fn aggregate_counts(port_counts: &HashMap<u16, AgentStatusCounts>) -> AgentStatusCounts {
        port_counts.values().fold(AgentStatusCounts::default(), |acc, c| {
            AgentStatusCounts::new(acc.idle + c.idle, acc.busy + c.busy)
        })
    }

    /// Emit aggregated counts to sender and update current_counts
    async fn emit_aggregate(
        port_counts: &HashMap<u16, AgentStatusCounts>,
        current_counts: &RwLock<AgentStatusCounts>,
        sender: &broadcast::Sender<AgentStatusCounts>,
    ) {
        let total = Self::aggregate_counts(port_counts);
        {
            let mut guard = current_counts.write().await;
            *guard = total;
        }
        let _ = sender.send(total);
    }

    /// Spawn a monitor task for a single port
    fn spawn_port_monitor(
        port: u16,
        client_factory: Arc<dyn ClientFactory>,
        tx: mpsc::Sender<PortUpdate>,
        active_flag: Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            if !active_flag.load(Ordering::Relaxed) {
                return;
            }

            let client = client_factory.create_client(port);
            let mut session_statuses: HashMap<String, SessionStatus> = HashMap::new();

            // Send initial connected state
            let counts = Self::counts_from_sessions(&session_statuses);
            let _ = tx.send(PortUpdate::Status { port, counts }).await;

            // Subscribe to events
            if let Ok(mut stream) = client.subscribe_events().await {
                while let Some(result) = stream.next().await {
                    if !active_flag.load(Ordering::Relaxed) {
                        return;
                    }

                    match result {
                        Ok(event) => {
                            let mut changed = false;

                            if event.event_type == "session.status" {
                                if let Ok(props) = serde_json::from_value::<SessionStatusEventProperties>(
                                    event.properties.clone(),
                                ) {
                                    session_statuses.insert(props.session_id, props.status);
                                    changed = true;
                                }
                            } else if event.event_type == "session.idle" {
                                if let Some(session_id) =
                                    event.properties.get("sessionID").and_then(|v| v.as_str())
                                {
                                    session_statuses.insert(session_id.to_string(), SessionStatus::Idle);
                                    changed = true;
                                }
                            } else if event.event_type == "session.deleted" {
                                if let Some(session_id) =
                                    event.properties.get("sessionID").and_then(|v| v.as_str())
                                {
                                    session_statuses.remove(session_id);
                                    changed = true;
                                }
                            }

                            if changed {
                                let counts = Self::counts_from_sessions(&session_statuses);
                                if tx.send(PortUpdate::Status { port, counts }).await.is_err() {
                                    return; // Channel closed
                                }
                            }
                        }
                        Err(_) => {
                            break; // Connection lost
                        }
                    }
                }
            }

            // Connection lost - notify main loop
            let _ = tx.send(PortUpdate::Disconnected { port }).await;
        })
    }

    /// Calculate counts from session status map
    /// IMPORTANT: When connected but no sessions, report 1 idle (green indicator)
    fn counts_from_sessions(session_statuses: &HashMap<String, SessionStatus>) -> AgentStatusCounts {
        let mut idle = 0u32;
        let mut busy = 0u32;

        for status in session_statuses.values() {
            if status.is_busy() {
                busy += 1;
            } else {
                idle += 1;
            }
        }

        // If connected but no sessions, show as "1 idle" (green)
        if idle == 0 && busy == 0 {
            idle = 1;
        }

        AgentStatusCounts::new(idle, busy)
    }

    /// Main monitor loop with channel-based multi-instance aggregation
    async fn run_monitor(
        workspace_path: PathBuf,
        discovery: Arc<OpenCodeDiscoveryService>,
        client_factory: Arc<dyn ClientFactory>,
        current_counts: Arc<RwLock<AgentStatusCounts>>,
        sender: broadcast::Sender<AgentStatusCounts>,
        active_flag: Arc<AtomicBool>,
    ) {
        let (tx, mut rx) = mpsc::channel::<PortUpdate>(64);
        let mut port_counts: HashMap<u16, AgentStatusCounts> = HashMap::new();
        let mut port_tasks: HashMap<u16, JoinHandle<()>> = HashMap::new();

        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !active_flag.load(Ordering::Relaxed) {
                        break;
                    }

                    // Get current ports from discovery
                    let current_ports: BTreeSet<u16> = discovery
                        .get_ports(&workspace_path)
                        .await
                        .into_iter()
                        .collect();

                    let mut changed = false;

                    // Remove obsolete port tasks
                    let to_remove: Vec<_> = port_tasks
                        .keys()
                        .filter(|p| !current_ports.contains(p))
                        .copied()
                        .collect();

                    for port in to_remove {
                        if let Some(h) = port_tasks.remove(&port) {
                            h.abort();
                        }
                        port_counts.remove(&port);
                        changed = true;
                    }

                    // Add new port tasks
                    for port in current_ports {
                        if let std::collections::hash_map::Entry::Vacant(e) = port_tasks.entry(port) {
                            let handle = Self::spawn_port_monitor(
                                port,
                                client_factory.clone(),
                                tx.clone(),
                                active_flag.clone(),
                            );
                            e.insert(handle);
                            port_counts.insert(port, AgentStatusCounts::default());
                            changed = true;
                        }
                    }

                    // Emit aggregate after discovery update if ports changed
                    if changed {
                        Self::emit_aggregate(&port_counts, &current_counts, &sender).await;
                    }
                }

                Some(update) = rx.recv() => {
                    match update {
                        PortUpdate::Status { port, counts } => {
                            port_counts.insert(port, counts);
                        }
                        PortUpdate::Disconnected { port } => {
                            // Mark as disconnected but keep entry so aggregate updates
                            port_counts.insert(port, AgentStatusCounts::default());
                        }
                    }
                    Self::emit_aggregate(&port_counts, &current_counts, &sender).await;
                }
            }
        }

        // Cleanup all tasks
        for (_, h) in port_tasks {
            h.abort();
        }

        // Reset to disconnected state
        {
            let mut guard = current_counts.write().await;
            *guard = AgentStatusCounts::default();
        }
        let _ = sender.send(AgentStatusCounts::default());
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
        // Use try_read to avoid blocking. If lock is held, return default.
        // This is acceptable since the status is updated frequently.
        match self.current_counts.try_read() {
            Ok(guard) => *guard,
            Err(_) => AgentStatusCounts::default(),
        }
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

    #[tokio::test]
    async fn test_provider_aggregates_multiple_instances() {
        // Setup: Two OpenCode instances for the same workspace
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mut mock_tree = MockProcessTree::new();

        mock_tree.expect_refresh().returning(|| {});
        mock_tree.expect_get_descendant_pids().returning(|_| {
            let mut descendants = HashSet::new();
            descendants.insert(1001);
            descendants.insert(1002);
            descendants
        });

        mock_scanner.expect_get_active_listeners().returning(|| {
            Ok(vec![
                PortInfo { port: 3000, pid: 1001 },
                PortInfo { port: 3001, pid: 1002 },
            ])
        });

        // Both ports return the SAME workspace path
        mock_probe
            .expect_probe()
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/same/workspace")) }));

        let discovery = Arc::new(OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        ));

        discovery.set_code_server_pid(Some(CODE_SERVER_PID)).await;
        discovery.scan_and_update().await.unwrap();

        // Verify both ports are discovered
        let ports = discovery.get_ports(Path::new("/same/workspace")).await;
        assert_eq!(ports.len(), 2);

        // Create mock factory that creates clients for both ports
        let mut mock_factory = MockClientFactory::new();
        
        // Port 3000: sends idle event
        mock_factory
            .expect_create_client()
            .with(mockall::predicate::eq(3000))
            .returning(|_| {
                let mut client = MockOpenCodeClient::new();
                client.expect_subscribe_events().returning(|| {
                    Box::pin(async {
                        // Connected but no sessions - will report 1 idle
                        Ok(Box::pin(stream::pending())
                            as BoxStream<'static, Result<crate::opencode::types::Event, crate::opencode::OpenCodeError>>)
                    })
                });
                Box::new(client)
            });

        // Port 3001: sends busy event
        mock_factory
            .expect_create_client()
            .with(mockall::predicate::eq(3001))
            .returning(|_| {
                let mut client = MockOpenCodeClient::new();
                client.expect_subscribe_events().returning(|| {
                    Box::pin(async {
                        let event = crate::opencode::types::Event {
                            event_type: "session.status".to_string(),
                            properties: serde_json::json!({
                                "sessionID": "456",
                                "status": { "type": "busy" }
                            }),
                        };
                        let s = stream::iter(vec![Ok(event)]).chain(stream::pending());
                        Ok(Box::pin(s)
                            as BoxStream<'static, Result<crate::opencode::types::Event, crate::opencode::OpenCodeError>>)
                    })
                });
                Box::new(client)
            });

        let provider = OpenCodeProvider::new_with_factory(
            PathBuf::from("/same/workspace"),
            discovery,
            Arc::new(mock_factory),
        );

        let mut rx = provider.subscribe();
        provider.start().await.unwrap();

        // Wait for aggregated status (should be mixed: 1 idle from port 3000, 1 busy from port 3001)
        let mut found_aggregated = false;
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(3));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                Ok(status) = rx.recv() => {
                    // Looking for aggregated status with at least 1 idle and 1 busy
                    if status.idle >= 1 && status.busy >= 1 {
                        found_aggregated = true;
                        break;
                    }
                }
                _ = &mut timeout => {
                    break;
                }
            }
        }

        assert!(found_aggregated, "Did not receive aggregated status with both idle and busy");
        provider.stop().await.unwrap();
    }
}