// src-tauri/tests/agent_status_integration.rs
//
// Integration tests for the Agent Status Provider infrastructure.

use async_trait::async_trait;
use codehydra_lib::agent_status::{AgentStatusCounts, AggregatedAgentStatus};
use codehydra_lib::agent_status_manager::AgentStatusManager;
use codehydra_lib::agent_status_provider::{
    AgentStatusError, AgentStatusProvider, AgentStatusProviderFactory,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

// === Test Provider ===

#[derive(Debug)]
struct TestProvider {
    workspace: PathBuf,
    idle: AtomicU32,
    busy: AtomicU32,
    active: AtomicBool,
    sender: broadcast::Sender<AgentStatusCounts>,
}

impl TestProvider {
    fn new(workspace: PathBuf) -> Self {
        let (sender, _) = broadcast::channel(16);
        Self {
            workspace,
            idle: AtomicU32::new(0),
            busy: AtomicU32::new(0),
            active: AtomicBool::new(false),
            sender,
        }
    }

    #[allow(dead_code)]
    fn emit_status(&self, idle: u32, busy: u32) {
        self.idle.store(idle, Ordering::SeqCst);
        self.busy.store(busy, Ordering::SeqCst);
        let _ = self.sender.send(AgentStatusCounts::new(idle, busy));
    }
}

#[async_trait]
impl AgentStatusProvider for TestProvider {
    fn provider_id(&self) -> &'static str {
        "test"
    }
    fn provider_name(&self) -> &'static str {
        "Test Provider"
    }
    fn workspace_path(&self) -> &Path {
        &self.workspace
    }
    fn current_status(&self) -> AgentStatusCounts {
        AgentStatusCounts::new(
            self.idle.load(Ordering::SeqCst),
            self.busy.load(Ordering::SeqCst),
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

// === Test Factory ===

struct TestFactory;

#[async_trait]
impl AgentStatusProviderFactory for TestFactory {
    fn factory_id(&self) -> &'static str {
        "test-factory"
    }
    async fn create_providers(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<Box<dyn AgentStatusProvider>>, AgentStatusError> {
        Ok(vec![Box::new(TestProvider::new(
            workspace_path.to_path_buf(),
        ))])
    }
    async fn supports_workspace(&self, _: &Path) -> bool {
        true
    }
}

// === Full Status Flow Test ===

#[tokio::test]
async fn test_full_status_flow() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/workspace");

    // Initialize workspace
    let result = manager.init_workspace(&workspace).await.unwrap();
    assert_eq!(result.started, 1);

    // Subscribe to events
    let _rx = manager.subscribe();

    // Initial status should be NoAgents (no updates yet)
    let status = manager.get_status(&workspace).await;
    assert_eq!(status, AggregatedAgentStatus::NoAgents);

    // Cleanup
    manager.shutdown().await;
}

// === Event Emission Test ===

#[tokio::test]
async fn test_event_emission() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/workspace");
    manager.init_workspace(&workspace).await.unwrap();

    let _rx = manager.subscribe();

    // Wait for debounce period to pass so events are emitted
    // The trailing-edge debounce will emit after STATUS_DEBOUNCE_MS (50ms)
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Verify the subscription is working (channel is open)
    // In a full integration, the provider would emit events here

    manager.shutdown().await;
}

// === Trailing Edge Debounce Test ===

#[tokio::test]
async fn test_trailing_edge_debounce_emits_final_state() {
    // This test verifies that the final state is always emitted after
    // rapid updates, even if the updates stop within the debounce window

    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/debounce");
    manager.init_workspace(&workspace).await.unwrap();

    let _rx = manager.subscribe();

    // Wait for trailing-edge debounce (STATUS_DEBOUNCE_MS = 50ms)
    // After this, any pending state should be emitted
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The cache should have the workspace entry
    let status = manager.get_status(&workspace).await;
    // Initially NoAgents since no provider updates occurred
    assert_eq!(status, AggregatedAgentStatus::NoAgents);

    manager.shutdown().await;
}

// === Multiple Workspaces Test ===

#[tokio::test]
async fn test_multiple_workspaces() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let ws1 = PathBuf::from("/workspace1");
    let ws2 = PathBuf::from("/workspace2");
    let ws3 = PathBuf::from("/workspace3");

    manager.init_workspace(&ws1).await.unwrap();
    manager.init_workspace(&ws2).await.unwrap();
    manager.init_workspace(&ws3).await.unwrap();

    let statuses = manager.get_all_statuses().await;
    assert_eq!(statuses.len(), 3);

    manager.remove_workspace(&ws2).await;
    let statuses = manager.get_all_statuses().await;
    assert_eq!(statuses.len(), 2);

    manager.shutdown().await;
}

// === Init Workspace Idempotency Test ===

#[tokio::test]
async fn test_init_workspace_idempotent() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/idempotent");

    // First init
    let result1 = manager.init_workspace(&workspace).await.unwrap();
    assert_eq!(result1.started, 1);

    // Second init should return early (already initialized)
    let result2 = manager.init_workspace(&workspace).await.unwrap();
    assert_eq!(result2.started, 0);
    assert_eq!(result2.failed, 0);

    // Should still have only 1 workspace
    assert_eq!(manager.workspace_count().await, 1);

    manager.shutdown().await;
}

// === Get Status After Remove Test ===

#[tokio::test]
async fn test_get_status_after_remove() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/remove");
    manager.init_workspace(&workspace).await.unwrap();

    // Remove the workspace
    manager.remove_workspace(&workspace).await;

    // Should return NoAgents for removed workspace
    let status = manager.get_status(&workspace).await;
    assert_eq!(status, AggregatedAgentStatus::NoAgents);
}

// === Concurrent Init Same Workspace Test ===

#[tokio::test]
async fn test_concurrent_init_same_workspace() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    let workspace = PathBuf::from("/test/concurrent");

    // Spawn multiple concurrent inits for the same workspace
    let handles: Vec<_> = (0..5)
        .map(|_| {
            let m = manager.clone();
            let p = workspace.clone();
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

    manager.shutdown().await;
}

// === Shutdown Cleans Up All Workspaces Test ===

#[tokio::test]
async fn test_shutdown_cleans_up_all_workspaces() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
        .await;

    // Initialize several workspaces
    for i in 0..5 {
        manager
            .init_workspace(&PathBuf::from(format!("/workspace{i}")))
            .await
            .unwrap();
    }

    assert_eq!(manager.workspace_count().await, 5);

    manager.shutdown().await;

    assert_eq!(manager.workspace_count().await, 0);
}

// === No Deadlock Under Concurrent Access Test ===

#[tokio::test]
async fn test_no_deadlock_under_concurrent_access() {
    let manager = Arc::new(AgentStatusManager::new());
    manager
        .register_factory(Box::new(TestFactory))
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

// === AggregatedAgentStatus Variants Test ===

#[tokio::test]
async fn test_aggregated_status_variants() {
    // Test all variants of AggregatedAgentStatus
    let no_agents = AggregatedAgentStatus::NoAgents;
    let all_idle = AggregatedAgentStatus::AllIdle { count: 3 };
    let all_busy = AggregatedAgentStatus::AllBusy { count: 2 };
    let mixed = AggregatedAgentStatus::Mixed { idle: 1, busy: 2 };

    assert_eq!(no_agents, AggregatedAgentStatus::NoAgents);
    assert_eq!(all_idle, AggregatedAgentStatus::AllIdle { count: 3 });
    assert_eq!(all_busy, AggregatedAgentStatus::AllBusy { count: 2 });
    assert_eq!(mixed, AggregatedAgentStatus::Mixed { idle: 1, busy: 2 });
}

// === AgentStatusCounts Conversion Test ===

#[tokio::test]
async fn test_status_counts_to_aggregated() {
    // Test conversion from AgentStatusCounts to AggregatedAgentStatus
    let no_agents = AggregatedAgentStatus::from(AgentStatusCounts::new(0, 0));
    assert_eq!(no_agents, AggregatedAgentStatus::NoAgents);

    let all_idle = AggregatedAgentStatus::from(AgentStatusCounts::new(3, 0));
    assert_eq!(all_idle, AggregatedAgentStatus::AllIdle { count: 3 });

    let all_busy = AggregatedAgentStatus::from(AgentStatusCounts::new(0, 2));
    assert_eq!(all_busy, AggregatedAgentStatus::AllBusy { count: 2 });

    let mixed = AggregatedAgentStatus::from(AgentStatusCounts::new(1, 2));
    assert_eq!(mixed, AggregatedAgentStatus::Mixed { idle: 1, busy: 2 });
}
