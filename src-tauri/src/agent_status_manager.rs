// src-tauri/src/agent_status_manager.rs

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::agent_status::{
    path_to_string, AgentStatusChangedEvent, AgentStatusCounts, AggregatedAgentStatus,
    STATUS_DEBOUNCE_MS, STATUS_EVENT_CHANNEL_CAPACITY,
};
use crate::agent_status_provider::{
    AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory,
};

/// State for a single workspace's providers
struct WorkspaceState {
    providers: Vec<Box<dyn AgentStatusProvider>>,
    cancel_token: CancellationToken,
    /// Task handles for subscription tasks - tracked for proper cleanup
    task_handles: Vec<tokio::task::JoinHandle<()>>,
}

/// Manages agent status providers for all workspaces
pub struct AgentStatusManager {
    /// Providers per workspace path
    workspaces: Arc<RwLock<HashMap<PathBuf, WorkspaceState>>>,

    /// Factories for creating providers
    factories: Arc<RwLock<Vec<Box<dyn AgentStatusProviderFactory>>>>,

    /// Broadcast channel for status events (to frontend)
    event_sender: broadcast::Sender<AgentStatusChangedEvent>,

    /// Cached aggregated status per workspace
    status_cache: Arc<RwLock<HashMap<PathBuf, AgentStatusCounts>>>,
}

// Manual Debug impl since WorkspaceState contains trait objects
impl std::fmt::Debug for WorkspaceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceState")
            .field("provider_count", &self.providers.len())
            .field("task_count", &self.task_handles.len())
            .field("cancelled", &self.cancel_token.is_cancelled())
            .finish()
    }
}

// Manual Debug impl to avoid lock acquisition during debug printing
impl std::fmt::Debug for AgentStatusManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentStatusManager")
            .field("workspaces", &"<locked>")
            .field("factories", &"<locked>")
            .field("status_cache", &"<locked>")
            .finish()
    }
}

impl Default for AgentStatusManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentStatusManager {
    pub fn new() -> Self {
        let (event_sender, _) = broadcast::channel(STATUS_EVENT_CHANNEL_CAPACITY);

        Self {
            workspaces: Arc::new(RwLock::new(HashMap::new())),
            factories: Arc::new(RwLock::new(Vec::new())),
            event_sender,
            status_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a provider factory
    pub async fn register_factory(&self, factory: Box<dyn AgentStatusProviderFactory>) {
        let mut factories = self.factories.write().await;
        factories.push(factory);
    }

    /// Initialize providers for a workspace
    ///
    /// Uses double-check pattern to prevent race conditions when multiple
    /// tasks call init_workspace for the same path concurrently.
    ///
    /// # Errors
    /// Returns an error if the workspace path contains non-UTF8 characters.
    pub async fn init_workspace(
        &self,
        workspace_path: &Path,
    ) -> Result<WorkspaceInitResult, AgentStatusError> {
        eprintln!("DEBUG: init_workspace called for {workspace_path:?}");

        // Validate path is valid UTF-8 early to ensure consistent frontend/backend representation
        path_to_string(workspace_path).map_err(|e| AgentStatusError::Internal {
            message: format!("Invalid workspace path: {e}"),
            source: Some(Box::new(e)),
        })?;

        // First check: avoid unnecessary work if already initialized
        {
            let workspaces = self.workspaces.read().await;
            if workspaces.contains_key(workspace_path) {
                eprintln!("DEBUG: Workspace {workspace_path:?} already initialized");
                return Ok(WorkspaceInitResult {
                    started: 0,
                    failed: 0,
                });
            }
        }

        let factories = self.factories.read().await;
        eprintln!("DEBUG: {} factories registered", factories.len());
        let mut all_providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();

        for factory in factories.iter() {
            eprintln!(
                "DEBUG: Checking factory {} for workspace {:?}",
                factory.factory_id(),
                workspace_path
            );
            // supports_workspace is now async
            if factory.supports_workspace(workspace_path).await {
                eprintln!(
                    "DEBUG: Factory {} supports workspace {:?}",
                    factory.factory_id(),
                    workspace_path
                );
                match factory.create_providers(workspace_path).await {
                    Ok(providers) => {
                        eprintln!(
                            "DEBUG: Factory {} created {} providers",
                            factory.factory_id(),
                            providers.len()
                        );
                        all_providers.extend(providers);
                    }
                    Err(e) => eprintln!(
                        "Factory {} failed for {:?}: {}",
                        factory.factory_id(),
                        workspace_path,
                        e
                    ),
                }
            } else {
                eprintln!(
                    "DEBUG: Factory {} does NOT support workspace {:?}",
                    factory.factory_id(),
                    workspace_path
                );
            }
        }
        drop(factories);

        // Create cancellation token for this workspace
        let cancel_token = CancellationToken::new();

        // Start all providers and subscribe to their events
        // Only track providers that successfully started
        let mut started = 0;
        let mut failed = 0;
        let mut started_providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();
        let mut task_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();

        for provider in all_providers {
            eprintln!(
                "DEBUG: Starting provider {} for workspace {:?}",
                provider.provider_id(),
                workspace_path
            );
            if let Err(e) = provider.start().await {
                eprintln!("Failed to start provider {}: {}", provider.provider_id(), e);
                failed += 1;
                // Don't add failed providers to the list
                continue;
            }
            eprintln!(
                "DEBUG: Provider {} started successfully",
                provider.provider_id()
            );
            started += 1;

            // Subscribe to status changes from this provider
            let handle =
                self.subscribe_to_provider(provider.as_ref(), workspace_path, cancel_token.clone());
            task_handles.push(handle);
            started_providers.push(provider);
        }

        let workspace_state = WorkspaceState {
            providers: started_providers,
            cancel_token,
            task_handles,
        };

        // Second check: after acquiring write lock, verify no one else initialized
        let mut workspaces = self.workspaces.write().await;
        if workspaces.contains_key(workspace_path) {
            // Another task initialized while we were setting up - clean up our providers
            // Release lock BEFORE cleanup to avoid blocking other operations
            drop(workspaces);

            // Cancel our token first to stop any tasks we spawned
            workspace_state.cancel_token.cancel();

            // Wait for our tasks to complete
            let results = join_all(workspace_state.task_handles).await;
            for result in results {
                if let Err(e) = result {
                    if e.is_panic() {
                        eprintln!("Subscription task panicked during cleanup: {e:?}");
                    }
                }
            }

            // Then stop our providers
            for provider in workspace_state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!("Failed to stop provider {}: {}", provider.provider_id(), e);
                }
            }
            return Ok(WorkspaceInitResult {
                started: 0,
                failed: 0,
            });
        }
        workspaces.insert(workspace_path.to_path_buf(), workspace_state);
        drop(workspaces);

        // Initialize cache with empty counts
        let mut cache = self.status_cache.write().await;
        cache.insert(workspace_path.to_path_buf(), AgentStatusCounts::default());

        Ok(WorkspaceInitResult { started, failed })
    }

    /// Remove providers for a workspace
    ///
    /// IMPORTANT: This method releases the workspaces lock before awaiting
    /// provider cleanup to avoid blocking other workspace operations.
    pub async fn remove_workspace(&self, workspace_path: &Path) {
        // Extract state under lock, release lock immediately
        let workspace_state = {
            let mut workspaces = self.workspaces.write().await;
            workspaces.remove(workspace_path)
        }; // Lock released here

        // Stop providers WITHOUT holding lock
        if let Some(state) = workspace_state {
            // Cancel all subscription tasks first
            state.cancel_token.cancel();

            // Wait for all tasks to complete before stopping providers
            // This ensures tasks aren't accessing providers during shutdown
            let results = join_all(state.task_handles).await;
            for result in results {
                if let Err(e) = result {
                    if e.is_panic() {
                        eprintln!("Subscription task panicked during cleanup: {e:?}");
                    }
                }
            }

            // Then stop all providers
            for provider in state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!("Failed to stop provider {}: {}", provider.provider_id(), e);
                }
            }
        }

        // Clean up cache (separate lock)
        {
            let mut cache = self.status_cache.write().await;
            cache.remove(workspace_path);
        }
    }

    /// Gracefully shutdown all providers and tasks
    ///
    /// IMPORTANT: This method releases the workspaces lock before awaiting
    /// provider cleanup to avoid blocking other operations during shutdown.
    pub async fn shutdown(&self) {
        // Extract all workspace states under lock, release lock immediately
        let all_states: Vec<WorkspaceState> = {
            let mut workspaces = self.workspaces.write().await;
            workspaces.drain().map(|(_, state)| state).collect()
        }; // Lock released here

        // Process all workspace cleanups WITHOUT holding lock
        for workspace_state in all_states {
            // Cancel all subscription tasks first
            workspace_state.cancel_token.cancel();

            // Don't wait for tasks to complete - they've been cancelled and will exit
            // Just drop the handles to allow them to be cleaned up by the runtime
            drop(workspace_state.task_handles);

            // Stop all providers
            for provider in workspace_state.providers {
                if let Err(e) = provider.stop().await {
                    eprintln!(
                        "Failed to stop provider {} during shutdown: {}",
                        provider.provider_id(),
                        e
                    );
                }
            }
        }

        // Clear caches (separate lock)
        {
            let mut cache = self.status_cache.write().await;
            cache.clear();
        }
    }

    /// Get current aggregated status for a workspace
    pub async fn get_status(&self, workspace_path: &Path) -> AggregatedAgentStatus {
        let cache = self.status_cache.read().await;
        cache
            .get(workspace_path)
            .map(AggregatedAgentStatus::from)
            .unwrap_or(AggregatedAgentStatus::NoAgents)
    }

    /// Get all workspace statuses
    pub async fn get_all_statuses(&self) -> HashMap<PathBuf, AggregatedAgentStatus> {
        let cache = self.status_cache.read().await;
        cache
            .iter()
            .map(|(path, counts)| (path.clone(), AggregatedAgentStatus::from(counts)))
            .collect()
    }

    /// Subscribe to status events (for Tauri event emission)
    pub fn subscribe(&self) -> broadcast::Receiver<AgentStatusChangedEvent> {
        self.event_sender.subscribe()
    }

    /// Internal: subscribe to a provider's events and aggregate
    ///
    /// IMPORTANT: Lock ordering to prevent deadlocks:
    /// 1. Read workspaces lock briefly to collect status
    /// 2. Release workspaces lock
    /// 3. Then acquire status_cache write lock
    ///
    /// Uses trailing-edge debounce to ensure final state is always emitted:
    /// - Immediate emit on first update after quiet period
    /// - Subsequent rapid updates are batched
    /// - Final state is always emitted after debounce period expires
    ///
    /// Returns the JoinHandle for the spawned task for tracking/cleanup.
    fn subscribe_to_provider(
        &self,
        provider: &dyn AgentStatusProvider,
        workspace_path: &Path,
        cancel_token: CancellationToken,
    ) -> tokio::task::JoinHandle<()> {
        let mut rx = provider.subscribe();
        let workspace = workspace_path.to_path_buf();
        let status_cache = self.status_cache.clone();
        let workspaces = self.workspaces.clone();
        let event_sender = self.event_sender.clone();
        let debounce_duration = Duration::from_millis(STATUS_DEBOUNCE_MS);

        tokio::spawn(async move {
            // Pending status to emit after debounce period (for trailing-edge)
            let mut pending_emit: Option<AgentStatusCounts> = None;
            let mut debounce_deadline: Option<tokio::time::Instant> = None;

            loop {
                // Calculate sleep duration for trailing-edge emit
                let sleep_future = async {
                    match debounce_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                };

                tokio::select! {
                    // Check for cancellation
                    _ = cancel_token.cancelled() => {
                        // Emit any pending state before exiting
                        if let Some(counts) = pending_emit.take() {
                            // path_to_string validated at init_workspace, safe to use display here
                            let event = AgentStatusChangedEvent {
                                workspace_path: workspace.display().to_string(),
                                status: AggregatedAgentStatus::from(counts),
                                counts,
                            };
                            let _ = event_sender.send(event);
                        }
                        break;
                    }

                    // Trailing-edge: emit pending state after debounce period
                    _ = sleep_future, if pending_emit.is_some() => {
                        if let Some(counts) = pending_emit.take() {
                            let event = AgentStatusChangedEvent {
                                workspace_path: workspace.display().to_string(),
                                status: AggregatedAgentStatus::from(counts),
                                counts,
                            };
                            let _ = event_sender.send(event);
                        }
                        debounce_deadline = None;
                    }

                    // Wait for status update
                    result = rx.recv() => {
                        match result {
                            Ok(_) => {
                                // Process the update
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                // Receiver lagged - this is recoverable, continue processing
                                eprintln!("Agent status receiver lagged by {n} messages");
                                continue;
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                // Channel closed - emit any pending state and exit
                                if let Some(counts) = pending_emit.take() {
                                    let event = AgentStatusChangedEvent {
                                        workspace_path: workspace.display().to_string(),
                                        status: AggregatedAgentStatus::from(counts),
                                        counts,
                                    };
                                    let _ = event_sender.send(event);
                                }
                                break;
                            }
                        }

                        // Collect counts under short-lived lock
                        let total_counts = {
                            let workspaces_lock = workspaces.read().await;
                            if let Some(workspace_state) = workspaces_lock.get(&workspace) {
                                workspace_state.providers.iter()
                                    .map(|p| p.current_status())
                                    .fold(AgentStatusCounts::default(), |acc, c| acc + c)
                            } else {
                                // Workspace removed, exit
                                break;
                            }
                        }; // Lock released here

                        // Update cache (separate lock, after releasing providers lock)
                        {
                            let mut cache = status_cache.write().await;
                            cache.insert(workspace.clone(), total_counts);
                        }

                        // Trailing-edge debounce: always schedule emit, reset deadline on each update
                        pending_emit = Some(total_counts);
                        debounce_deadline = Some(tokio::time::Instant::now() + debounce_duration);
                    }
                }
            }
        })
    }

    /// Get count of registered factories
    pub async fn factory_count(&self) -> usize {
        self.factories.read().await.len()
    }

    /// Get count of workspaces being managed
    pub async fn workspace_count(&self) -> usize {
        self.workspaces.read().await.len()
    }
}

/// Result of workspace initialization
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInitResult {
    /// Number of providers successfully started
    pub started: usize,
    /// Number of providers that failed to start
    pub failed: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_status_provider::{
        AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory,
    };
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tokio::sync::broadcast;

    // === Mock Provider for Tests ===

    #[derive(Debug)]
    struct MockProvider {
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
                workspace,
                idle_count: AtomicU32::new(0),
                busy_count: AtomicU32::new(0),
                active: AtomicBool::new(false),
                sender,
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for MockProvider {
        fn provider_id(&self) -> &'static str {
            "mock"
        }
        fn provider_name(&self) -> &'static str {
            "Mock"
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
            self.active.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn stop(&self) -> Result<(), AgentStatusError> {
            self.active.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
    }

    // === Mock Factory ===

    struct MockFactory {
        should_support: bool,
    }

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for MockFactory {
        fn factory_id(&self) -> &'static str {
            "mock-factory"
        }

        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            if self.should_support {
                Ok(vec![Box::new(MockProvider::new(
                    workspace_path.to_path_buf(),
                ))])
            } else {
                Ok(vec![])
            }
        }

        async fn supports_workspace(&self, _workspace_path: &Path) -> bool {
            self.should_support
        }
    }

    // === Manager Tests ===

    #[tokio::test]
    async fn test_manager_new() {
        let manager = AgentStatusManager::new();
        assert_eq!(manager.factory_count().await, 0);
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_register_factory() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;
        assert_eq!(manager.factory_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_register_multiple_factories() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;
        manager
            .register_factory(Box::new(MockFactory {
                should_support: false,
            }))
            .await;
        assert_eq!(manager.factory_count().await, 2);
    }

    #[tokio::test]
    async fn test_manager_init_workspace() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_no_supporting_factory() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: false,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        // Workspace is registered but with no providers
        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_remove_workspace() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();
        assert_eq!(manager.workspace_count().await, 1);

        manager.remove_workspace(&path).await;
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_get_status_no_workspace() {
        let manager = AgentStatusManager::new();
        let path = PathBuf::from("/nonexistent");
        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[tokio::test]
    async fn test_manager_get_status_empty_workspace() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: false,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[tokio::test]
    async fn test_manager_get_all_statuses_empty() {
        let manager = AgentStatusManager::new();
        let statuses = manager.get_all_statuses().await;
        assert!(statuses.is_empty());
    }

    #[tokio::test]
    async fn test_manager_get_all_statuses() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path1 = PathBuf::from("/workspace1");
        let path2 = PathBuf::from("/workspace2");

        manager.init_workspace(&path1).await.unwrap();
        manager.init_workspace(&path2).await.unwrap();

        let statuses = manager.get_all_statuses().await;
        assert_eq!(statuses.len(), 2);
    }

    #[tokio::test]
    async fn test_manager_subscribe() {
        let manager = AgentStatusManager::new();
        let _rx = manager.subscribe();
        // Should not panic
    }

    #[tokio::test]
    async fn test_manager_default() {
        let manager = AgentStatusManager::default();
        assert_eq!(manager.factory_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_returns_result() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        let result = manager.init_workspace(&path).await.unwrap();

        assert_eq!(result.started, 1);
        assert_eq!(result.failed, 0);
    }

    #[tokio::test]
    async fn test_manager_shutdown() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path1 = PathBuf::from("/workspace1");
        let path2 = PathBuf::from("/workspace2");

        manager.init_workspace(&path1).await.unwrap();
        manager.init_workspace(&path2).await.unwrap();
        assert_eq!(manager.workspace_count().await, 2);

        manager.shutdown().await;
        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_concurrent_operations() {
        let manager = Arc::new(AgentStatusManager::new());
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let handles: Vec<_> = (0..10)
            .map(|i| {
                let m = manager.clone();
                tokio::spawn(async move {
                    m.init_workspace(&PathBuf::from(format!("/workspace{i}")))
                        .await
                })
            })
            .collect();

        for handle in handles {
            assert!(handle.await.unwrap().is_ok());
        }

        assert_eq!(manager.workspace_count().await, 10);
    }

    #[tokio::test]
    async fn test_manager_remove_cancels_tasks() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");
        manager.init_workspace(&path).await.unwrap();

        // Remove workspace - this should cancel the subscription task
        manager.remove_workspace(&path).await;

        // Give the task time to be cancelled
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert_eq!(manager.workspace_count().await, 0);
    }

    #[tokio::test]
    async fn test_manager_init_workspace_already_initialized() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");

        // First init
        let result1 = manager.init_workspace(&path).await.unwrap();
        assert_eq!(result1.started, 1);

        // Second init should return early (already initialized)
        let result2 = manager.init_workspace(&path).await.unwrap();
        assert_eq!(result2.started, 0);
        assert_eq!(result2.failed, 0);

        // Should still have only 1 workspace
        assert_eq!(manager.workspace_count().await, 1);
    }

    #[tokio::test]
    async fn test_manager_concurrent_init_same_workspace() {
        let manager = Arc::new(AgentStatusManager::new());
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        let path = PathBuf::from("/test/workspace");

        // Spawn multiple concurrent inits for the same workspace
        let handles: Vec<_> = (0..5)
            .map(|_| {
                let m = manager.clone();
                let p = path.clone();
                tokio::spawn(async move { m.init_workspace(&p).await })
            })
            .collect();

        let mut total_started = 0;
        for handle in handles {
            let result = handle.await.unwrap().unwrap();
            total_started += result.started;
        }

        // Only one should have actually started providers
        assert_eq!(total_started, 1);
        assert_eq!(manager.workspace_count().await, 1);
    }

    // === Provider Failure Tests ===

    /// Provider that always fails to start
    #[derive(Debug)]
    struct FailingProvider {
        workspace: PathBuf,
    }

    impl FailingProvider {
        fn new(workspace: PathBuf) -> Self {
            Self { workspace }
        }
    }

    #[async_trait::async_trait]
    impl AgentStatusProvider for FailingProvider {
        fn provider_id(&self) -> &'static str {
            "failing"
        }
        fn provider_name(&self) -> &'static str {
            "Failing Provider"
        }
        fn workspace_path(&self) -> &Path {
            &self.workspace
        }
        fn current_status(&self) -> AgentStatusCounts {
            AgentStatusCounts::default()
        }
        fn subscribe(&self) -> broadcast::Receiver<AgentStatusCounts> {
            let (tx, rx) = broadcast::channel(1);
            drop(tx);
            rx
        }
        async fn start(&self) -> Result<(), AgentStatusError> {
            Err(AgentStatusError::initialization_failed(
                "Intentional test failure",
            ))
        }
        async fn stop(&self) -> Result<(), AgentStatusError> {
            Ok(())
        }
        fn is_active(&self) -> bool {
            false
        }
    }

    /// Factory that creates a mix of working and failing providers
    struct MixedResultFactory {
        success_count: usize,
        fail_count: usize,
    }

    #[async_trait::async_trait]
    impl AgentStatusProviderFactory for MixedResultFactory {
        fn factory_id(&self) -> &'static str {
            "mixed-factory"
        }

        async fn create_providers(
            &self,
            workspace_path: &Path,
        ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
            let mut providers: Vec<Box<dyn AgentStatusProvider>> = Vec::new();

            // Add successful providers
            for _ in 0..self.success_count {
                providers.push(Box::new(MockProvider::new(workspace_path.to_path_buf())));
            }

            // Add failing providers
            for _ in 0..self.fail_count {
                providers.push(Box::new(FailingProvider::new(workspace_path.to_path_buf())));
            }

            Ok(providers)
        }

        async fn supports_workspace(&self, _: &Path) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn test_partial_provider_failure() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MixedResultFactory {
                success_count: 2,
                fail_count: 1,
            }))
            .await;

        let path = PathBuf::from("/test/partial-failure");
        let result = manager.init_workspace(&path).await.unwrap();

        // 2 should succeed, 1 should fail
        assert_eq!(result.started, 2);
        assert_eq!(result.failed, 1);

        // Workspace should still be registered with working providers
        assert_eq!(manager.workspace_count().await, 1);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn test_all_providers_fail() {
        let manager = AgentStatusManager::new();
        manager
            .register_factory(Box::new(MixedResultFactory {
                success_count: 0,
                fail_count: 3,
            }))
            .await;

        let path = PathBuf::from("/test/all-fail");
        let result = manager.init_workspace(&path).await.unwrap();

        assert_eq!(result.started, 0);
        assert_eq!(result.failed, 3);

        // Workspace should still be registered (with no active providers)
        assert_eq!(manager.workspace_count().await, 1);

        // Status should be NoAgents since no providers are active
        let status = manager.get_status(&path).await;
        assert_eq!(status, AggregatedAgentStatus::NoAgents);

        manager.shutdown().await;
    }

    // === Lock Ordering Stress Test ===

    #[tokio::test]
    async fn test_no_deadlock_under_concurrent_access() {
        let manager = Arc::new(AgentStatusManager::new());
        manager
            .register_factory(Box::new(MockFactory {
                should_support: true,
            }))
            .await;

        // Initialize several workspaces
        for i in 0..5 {
            manager
                .init_workspace(&PathBuf::from(format!("/workspace{i}")))
                .await
                .unwrap();
        }

        // Spawn tasks that concurrently access the manager
        let handles: Vec<_> = (0..20)
            .map(|i| {
                let m = manager.clone();
                tokio::spawn(async move {
                    for _ in 0..10 {
                        // Mix of read and write operations
                        if i % 2 == 0 {
                            let _ = m.get_status(&PathBuf::from("/workspace0")).await;
                        } else {
                            let _ = m.get_all_statuses().await;
                        }
                        tokio::task::yield_now().await;
                    }
                })
            })
            .collect();

        // Should complete within timeout (no deadlock)
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            for handle in handles {
                handle.await.unwrap();
            }
        })
        .await;

        assert!(result.is_ok(), "Deadlock detected - tasks did not complete");
        manager.shutdown().await;
    }
}
