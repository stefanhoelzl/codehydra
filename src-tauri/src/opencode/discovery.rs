use crate::opencode::{
    InstanceProbe, OpenCodeError, PortInfo, PortScanner, ProcessTree, SysinfoProcessTree,
};
use async_trait::async_trait;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct DefaultPortScanner;

impl PortScanner for DefaultPortScanner {
    fn get_active_listeners(&self) -> Result<Vec<PortInfo>, OpenCodeError> {
        let list = listeners::get_all().map_err(|e| {
            OpenCodeError::Io(std::io::Error::other(e.to_string()))
        })?;
        Ok(list
            .into_iter()
            .map(|l| PortInfo {
                port: l.socket.port(),
                pid: l.process.pid,
            })
            .collect())
    }
}

pub struct DefaultInstanceProbe {
    client: reqwest::Client,
}

impl DefaultInstanceProbe {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(500))
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Default for DefaultInstanceProbe {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl InstanceProbe for DefaultInstanceProbe {
    async fn probe(&self, port: u16) -> Result<PathBuf, OpenCodeError> {
        // Use localhost to allow system resolver to handle IPv4/IPv6
        let url = format!("http://localhost:{port}/path");
        let resp = self.client.get(&url).send().await?;
        let data: crate::opencode::types::PathResponse = resp.json().await?;
        
        let path_str = if !data.worktree.is_empty() {
            data.worktree
        } else {
            data.directory
        };
        let path = PathBuf::from(path_str);
        
        // Try to canonicalize the path to handle symlinks consistently
        // If canonicalization fails (e.g., path doesn't exist), use the original
        Ok(path.canonicalize().unwrap_or(path))
    }
}

pub struct OpenCodeDiscoveryService {
    // Maps workspace path to set of ports serving that path.
    // Uses BTreeSet for deterministic ordering (aids debugging and testing).
    active_instances: Arc<RwLock<HashMap<PathBuf, BTreeSet<u16>>>>,
    // Reverse map: Port -> Path. Used to track which ports we are currently monitoring
    // so we can detect when they disappear.
    known_ports: Arc<RwLock<HashMap<u16, PathBuf>>>,
    // Ports probed and confirmed NOT to be OpenCode instances
    // Maps port -> pid to detect when a different process reuses the same port
    non_opencode_ports: Arc<RwLock<HashMap<u16, u32>>>,
    // Code-server PID for ancestry filtering
    code_server_pid: Arc<RwLock<Option<u32>>>,
    // Process tree for ancestry checking (mockable)
    process_tree: Arc<dyn ProcessTree>,
    scanner: Box<dyn PortScanner>,
    probe: Box<dyn InstanceProbe>,
}

impl Default for OpenCodeDiscoveryService {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenCodeDiscoveryService {
    pub fn new() -> Self {
        Self {
            active_instances: Arc::new(RwLock::new(HashMap::new())),
            known_ports: Arc::new(RwLock::new(HashMap::new())),
            non_opencode_ports: Arc::new(RwLock::new(HashMap::new())),
            code_server_pid: Arc::new(RwLock::new(None)),
            process_tree: Arc::new(SysinfoProcessTree::new()),
            scanner: Box::new(DefaultPortScanner),
            probe: Box::new(DefaultInstanceProbe::new()),
        }
    }

    pub fn new_with_deps(
        scanner: Box<dyn PortScanner>,
        probe: Box<dyn InstanceProbe>,
        process_tree: Arc<dyn ProcessTree>,
    ) -> Self {
        Self {
            active_instances: Arc::new(RwLock::new(HashMap::new())),
            known_ports: Arc::new(RwLock::new(HashMap::new())),
            non_opencode_ports: Arc::new(RwLock::new(HashMap::new())),
            code_server_pid: Arc::new(RwLock::new(None)),
            process_tree,
            scanner,
            probe,
        }
    }

    /// Set the code-server PID for ancestry filtering.
    /// When the PID changes, the non-opencode ports cache is cleared.
    pub async fn set_code_server_pid(&self, pid: Option<u32>) {
        let mut pid_guard = self.code_server_pid.write().await;
        let old_pid = *pid_guard;
        *pid_guard = pid;

        // If PID changed, clear the non-opencode cache
        // (process ancestry has changed)
        if old_pid != pid {
            self.non_opencode_ports.write().await.clear();
        }
    }

    /// Get the current code-server PID
    pub async fn get_code_server_pid(&self) -> Option<u32> {
        *self.code_server_pid.read().await
    }

    /// Get all ports serving a workspace path.
    /// Returns an empty Vec if no instances are found.
    pub async fn get_ports(&self, path: &Path) -> Vec<u16> {
        let map = self.active_instances.read().await;
        
        // Try exact match first
        if let Some(ports) = map.get(path) {
            return ports.iter().copied().collect();
        }
        
        // Try canonicalized path match (handles symlinks)
        let canonical = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        
        if let Some(ports) = map.get(&canonical) {
            return ports.iter().copied().collect();
        }
        
        // Check canonicalized keys - O(n) but rare path
        for (stored_path, ports) in map.iter() {
            if stored_path.canonicalize().ok() == Some(canonical.clone()) {
                return ports.iter().copied().collect();
            }
        }
        
        Vec::new()
    }

    /// Get a single port for a workspace path (for backward compatibility).
    /// Returns the first port if multiple are available.
    pub async fn get_port(&self, path: &Path) -> Option<u16> {
        let ports = self.get_ports(path).await;
        ports.into_iter().next()
    }

    pub async fn run_loop(self: Arc<Self>) {
        loop {
            if let Err(e) = self.scan_and_update().await {
                eprintln!("OpenCode discovery error: {e}");
            }
            // Changed from 2 seconds to 1 second for faster feedback
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
    }

    /// Perform a single scan cycle
    pub async fn scan_and_update(&self) -> Result<(), OpenCodeError> {
        // 1. Get code-server PID (if not set, skip scanning)
        let code_server_pid = match *self.code_server_pid.read().await {
            Some(pid) => pid,
            None => return Ok(()), // No code-server running, skip scan
        };

        // 2. Refresh process tree in blocking task to avoid blocking async runtime
        // sysinfo refresh can take 50-200ms on systems with many processes
        let process_tree = self.process_tree.clone();
        tokio::task::spawn_blocking(move || {
            process_tree.refresh();
        })
        .await
        .map_err(|e| OpenCodeError::Io(std::io::Error::other(e)))?;

        // 3. Pre-compute descendant PIDs of code-server (O(n) once, not O(n*d) per port)
        let descendant_pids = self.process_tree.get_descendant_pids(code_server_pid);

        // 4. Get all listeners
        let listeners = self.scanner.get_active_listeners()?;

        // 5. Filter to only descendant PIDs
        // - Filter out PID 0 (kernel sockets)
        // - Filter to only descendants (excludes code-server itself and unrelated processes)
        let candidates: Vec<PortInfo> = listeners
            .into_iter()
            .filter(|info| info.pid != 0 && descendant_pids.contains(&info.pid))
            .collect();

        let candidate_set: HashSet<u16> = candidates.iter().map(|info| info.port).collect();
        let candidate_map: HashMap<u16, u32> = candidates
            .iter()
            .map(|info| (info.port, info.pid))
            .collect();

        // 6. Handle removed ports and PID changes
        let mut known_ports_guard = self.known_ports.write().await;
        let mut active_instances_guard = self.active_instances.write().await;
        let mut non_opencode_guard = self.non_opencode_ports.write().await;

        // 6a. Detect removed from known_ports
        let mut removed_known_ports = Vec::new();
        for port in known_ports_guard.keys() {
            if !candidate_set.contains(port) {
                removed_known_ports.push(*port);
            }
        }

        for port in removed_known_ports {
            if let Some(path) = known_ports_guard.remove(&port) {
                // Remove this port from the path's port set
                if let Some(ports) = active_instances_guard.get_mut(&path) {
                    ports.remove(&port);
                    // If no more ports for this path, remove the path entry
                    if ports.is_empty() {
                        active_instances_guard.remove(&path);
                    }
                }
            }
        }

        // 6b. Clean up non_opencode_ports for ports that are no longer in candidates
        let mut removed_non_opencode_ports = Vec::new();
        for port in non_opencode_guard.keys() {
            if !candidate_set.contains(port) {
                removed_non_opencode_ports.push(*port);
            }
        }

        for port in removed_non_opencode_ports {
            non_opencode_guard.remove(&port);
        }

        // 6c. Handle PID changes on existing non-opencode ports
        // If a port's PID changed, it may now be an OpenCode instance
        let mut pid_changed_ports = Vec::new();
        for (port, old_pid) in non_opencode_guard.iter() {
            if let Some(new_pid) = candidate_map.get(port) {
                if *new_pid != *old_pid {
                    pid_changed_ports.push(*port);
                }
            }
        }

        for port in pid_changed_ports {
            non_opencode_guard.remove(&port);
        }

        // 7. Find new ports to probe
        // Ports in candidate_set that are NOT in known_ports AND NOT in non_opencode_ports
        let mut new_ports = Vec::new();
        for info in &candidates {
            if !known_ports_guard.contains_key(&info.port)
                && !non_opencode_guard.contains_key(&info.port)
            {
                new_ports.push(info.clone());
            }
        }

        drop(known_ports_guard);
        drop(active_instances_guard);
        drop(non_opencode_guard);

        // 8. Probe new ports
        for info in new_ports {
            match self.probe.probe(info.port).await {
                Ok(path) => {
                    // Success: add to known_ports and active_instances
                    let mut known = self.known_ports.write().await;
                    let mut active = self.active_instances.write().await;

                    // Add port to the path's port set (supports multiple instances per path)
                    active
                        .entry(path.clone())
                        .or_insert_with(BTreeSet::new)
                        .insert(info.port);
                    known.insert(info.port, path);
                }
                Err(_) => {
                    // Failure: add to non_opencode_ports with current PID
                    let mut non_opencode = self.non_opencode_ports.write().await;
                    non_opencode.insert(info.port, info.pid);
                }
            }
        }

        Ok(())
    }
}

impl std::fmt::Debug for OpenCodeDiscoveryService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenCodeDiscoveryService")
            .field("active_instances", &"<locked>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opencode::{MockInstanceProbe, MockPortScanner, MockProcessTree};

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
    async fn test_discovery_loop_detects_new_instance() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        // Setup: Scanner returns port 3000 from descendant process
        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Setup: Probe confirms it's /foo/bar
        mock_probe
            .expect_probe()
            .with(mockall::predicate::eq(3000))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        // Set code-server PID
        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Action: Run scan
        service.scan_and_update().await.unwrap();

        // Assert: Port is mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_discovery_lifecycle() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        // Sequence of returns
        let mut seq = mockall::Sequence::new();

        // 1. Found
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // 2. Empty (Died)
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![]));

        mock_probe
            .expect_probe()
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        // Set code-server PID
        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // 1. Scan -> Found
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));

        // 2. Scan -> Gone
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);
    }

    #[tokio::test]
    async fn test_no_code_server_pid_skips_all() {
        let mut mock_scanner = MockPortScanner::new();
        let mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        // Scanner should NOT be called since code-server PID is not set
        mock_scanner.expect_get_active_listeners().times(0);

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        // Don't set code-server PID

        // Action: Run scan - should complete without errors
        service.scan_and_update().await.unwrap();

        // Assert: Nothing mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);
    }

    #[tokio::test]
    async fn test_non_opencode_port_not_reprobed() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        // Scanner returns port 3000 twice
        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Probe fails (not OpenCode) - should only be called ONCE
        mock_probe
            .expect_probe()
            .times(1)
            .with(mockall::predicate::eq(3000))
            .returning(|_| {
                Box::pin(async {
                    Err(OpenCodeError::Io(std::io::Error::new(
                        std::io::ErrorKind::ConnectionRefused,
                        "not opencode",
                    )))
                })
            });

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // First scan - probe fails, port added to non_opencode_ports
        service.scan_and_update().await.unwrap();

        // Second scan - port should NOT be probed again
        service.scan_and_update().await.unwrap();

        // Assert: Nothing mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);
    }

    #[tokio::test]
    async fn test_non_opencode_port_reprobed_after_disappearing() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        let mut seq = mockall::Sequence::new();

        // Scan 1: Port exists, fails probe
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Scan 2: Port gone
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![]));

        // Scan 3: Port back (should be probed again)
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Probe called twice: first fail, then success
        let mut probe_seq = mockall::Sequence::new();
        mock_probe
            .expect_probe()
            .times(1)
            .in_sequence(&mut probe_seq)
            .returning(|_| {
                Box::pin(async {
                    Err(OpenCodeError::Io(std::io::Error::new(
                        std::io::ErrorKind::ConnectionRefused,
                        "not opencode",
                    )))
                })
            });
        mock_probe
            .expect_probe()
            .times(1)
            .in_sequence(&mut probe_seq)
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Scan 1: Fails, added to non_opencode_ports
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);

        // Scan 2: Port gone, removed from non_opencode_ports
        service.scan_and_update().await.unwrap();

        // Scan 3: Port back, probed again, succeeds
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_port_reused_by_different_pid() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mut mock_tree = MockProcessTree::new();

        // Tree needs to be flexible for different descendant sets
        mock_tree.expect_refresh().returning(|| {});
        let call_count = std::sync::atomic::AtomicUsize::new(0);
        mock_tree.expect_get_descendant_pids().returning(move |_| {
            let count = call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut descendants = HashSet::new();
            if count == 0 {
                // First scan: only PID 1001
                descendants.insert(1001);
            } else {
                // Second scan: only PID 1002 (different process reused port)
                descendants.insert(1002);
            }
            descendants
        });

        let mut seq = mockall::Sequence::new();

        // Scan 1: Port 3000 from PID 1001 (non-OpenCode)
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: 1001 }]));

        // Scan 2: Port 3000 from PID 1002 (different process, OpenCode)
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: 1002 }]));

        // Probe: First fails, second succeeds
        let mut probe_seq = mockall::Sequence::new();
        mock_probe
            .expect_probe()
            .times(1)
            .in_sequence(&mut probe_seq)
            .returning(|_| {
                Box::pin(async {
                    Err(OpenCodeError::Io(std::io::Error::new(
                        std::io::ErrorKind::ConnectionRefused,
                        "not opencode",
                    )))
                })
            });
        mock_probe
            .expect_probe()
            .times(1)
            .in_sequence(&mut probe_seq)
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Scan 1: PID 1001, probe fails
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);

        // Scan 2: PID changed to 1002, should re-probe and succeed
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_only_descendants_are_probed() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mut mock_tree = MockProcessTree::new();

        // Only PID 1001 is a descendant
        mock_tree.expect_refresh().returning(|| {});
        mock_tree.expect_get_descendant_pids().returning(|_| {
            let mut descendants = HashSet::new();
            descendants.insert(1001);
            descendants
        });

        // Scanner returns two ports: one descendant, one not
        mock_scanner.expect_get_active_listeners().returning(|| {
            Ok(vec![
                PortInfo { port: 3000, pid: 1001 }, // Descendant
                PortInfo { port: 4000, pid: 9999 }, // Not a descendant
            ])
        });

        // Only port 3000 should be probed
        mock_probe
            .expect_probe()
            .times(1)
            .with(mockall::predicate::eq(3000))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        service.scan_and_update().await.unwrap();

        // Only the descendant port should be mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_pid_zero_filtered() {
        let mut mock_scanner = MockPortScanner::new();
        let mock_probe = MockInstanceProbe::new();
        let mut mock_tree = MockProcessTree::new();

        mock_tree.expect_refresh().returning(|| {});
        mock_tree.expect_get_descendant_pids().returning(|_| {
            let mut descendants = HashSet::new();
            descendants.insert(0); // Even if PID 0 were somehow a descendant
            descendants
        });

        // Scanner returns kernel socket (PID 0)
        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: 0 }]));

        // Probe should NOT be called (PID 0 is filtered)

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        service.scan_and_update().await.unwrap();

        // Nothing should be mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);
    }

    #[tokio::test]
    async fn test_code_server_restart_clears_cache() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        let mut seq = mockall::Sequence::new();

        // Scan 1: Port fails probe
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Scan 2: Same port, but code-server was restarted, so should re-probe
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Both scans trigger probe
        mock_probe.expect_probe().times(2).returning(|_| {
            Box::pin(async {
                Err(OpenCodeError::Io(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "not opencode",
                )))
            })
        });

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        // First code-server
        service.set_code_server_pid(Some(1000)).await;
        service.scan_and_update().await.unwrap();

        // Code-server restarts with new PID - should clear cache
        service.set_code_server_pid(Some(2000)).await;
        service.scan_and_update().await.unwrap();
    }

    #[tokio::test]
    async fn test_multiple_opencode_instances() {
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

        mock_probe
            .expect_probe()
            .with(mockall::predicate::eq(3000))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/project/a")) }));
        mock_probe
            .expect_probe()
            .with(mockall::predicate::eq(3001))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/project/b")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;
        service.scan_and_update().await.unwrap();

        assert_eq!(service.get_port(Path::new("/project/a")).await, Some(3000));
        assert_eq!(service.get_port(Path::new("/project/b")).await, Some(3001));
    }

    #[tokio::test]
    async fn test_opencode_instance_stops_and_restarts() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        let mock_tree = create_mock_process_tree();

        let mut seq = mockall::Sequence::new();

        // Scan 1: Running
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Scan 2: Stopped
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![]));

        // Scan 3: Restarted on same port
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: OPENCODE_PID }]));

        // Probed twice (initial and restart)
        mock_probe
            .expect_probe()
            .times(2)
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Scan 1: Found
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));

        // Scan 2: Gone
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);

        // Scan 3: Back
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_multiple_instances_same_workspace() {
        // Two OpenCode instances for the SAME workspace path
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

        // Scanner returns both ports
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

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;
        service.scan_and_update().await.unwrap();

        // Should return BOTH ports
        let ports = service.get_ports(Path::new("/same/workspace")).await;
        assert_eq!(ports.len(), 2);
        assert!(ports.contains(&3000));
        assert!(ports.contains(&3001));

        // get_port should return the first port (from BTreeSet, so lowest)
        assert_eq!(
            service.get_port(Path::new("/same/workspace")).await,
            Some(3000)
        );
    }

    #[tokio::test]
    async fn test_instance_removal_preserves_others() {
        // Start with two instances, remove one, verify other remains
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

        let mut seq = mockall::Sequence::new();

        // Scan 1: Both instances
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| {
                Ok(vec![
                    PortInfo { port: 3000, pid: 1001 },
                    PortInfo { port: 3001, pid: 1002 },
                ])
            });

        // Scan 2: Only one instance (port 3001 gone)
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![PortInfo { port: 3000, pid: 1001 }]));

        // Both ports return the same workspace path
        mock_probe
            .expect_probe()
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/same/workspace")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Scan 1: Both instances
        service.scan_and_update().await.unwrap();
        let ports = service.get_ports(Path::new("/same/workspace")).await;
        assert_eq!(ports.len(), 2);

        // Scan 2: One instance removed
        service.scan_and_update().await.unwrap();
        let ports = service.get_ports(Path::new("/same/workspace")).await;
        assert_eq!(ports.len(), 1);
        assert!(ports.contains(&3000));
    }

    #[tokio::test]
    async fn test_all_ports_for_workspace_removed() {
        // Both ports for a workspace disappear - workspace entry should be cleaned up
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

        let mut seq = mockall::Sequence::new();

        // Scan 1: Both instances
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| {
                Ok(vec![
                    PortInfo { port: 3000, pid: 1001 },
                    PortInfo { port: 3001, pid: 1002 },
                ])
            });

        // Scan 2: All gone
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![]));

        // Both ports return the same workspace path
        mock_probe
            .expect_probe()
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/same/workspace")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
            Arc::new(mock_tree),
        );

        service.set_code_server_pid(Some(CODE_SERVER_PID)).await;

        // Scan 1: Both instances
        service.scan_and_update().await.unwrap();
        let ports = service.get_ports(Path::new("/same/workspace")).await;
        assert_eq!(ports.len(), 2);

        // Scan 2: All gone
        service.scan_and_update().await.unwrap();
        let ports = service.get_ports(Path::new("/same/workspace")).await;
        assert!(ports.is_empty());
    }
}
