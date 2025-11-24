use crate::opencode::{InstanceProbe, OpenCodeError, PortScanner};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct DefaultPortScanner;

impl PortScanner for DefaultPortScanner {
    fn get_active_listeners(&self) -> Result<Vec<(u16, String)>, OpenCodeError> {
        let list = listeners::get_all().map_err(|e| {
            OpenCodeError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;
        Ok(list
            .into_iter()
            .map(|l| (l.socket.port(), l.process.name))
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

#[async_trait]
impl InstanceProbe for DefaultInstanceProbe {
    async fn probe(&self, port: u16) -> Result<PathBuf, OpenCodeError> {
        // Use localhost to allow system resolver to handle IPv4/IPv6
        let url = format!("http://localhost:{}/path", port);
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
    active_instances: Arc<RwLock<HashMap<PathBuf, u16>>>,
    // Reverse map: Port -> Path. Used to track which ports we are currently monitoring
    // so we can detect when they disappear.
    known_ports: Arc<RwLock<HashMap<u16, PathBuf>>>,
    scanner: Box<dyn PortScanner>,
    probe: Box<dyn InstanceProbe>,
}

impl OpenCodeDiscoveryService {
    pub fn new() -> Self {
        Self {
            active_instances: Arc::new(RwLock::new(HashMap::new())),
            known_ports: Arc::new(RwLock::new(HashMap::new())),
            scanner: Box::new(DefaultPortScanner),
            probe: Box::new(DefaultInstanceProbe::new()),
        }
    }

    pub fn new_with_deps(
        scanner: Box<dyn PortScanner>,
        probe: Box<dyn InstanceProbe>,
    ) -> Self {
        Self {
            active_instances: Arc::new(RwLock::new(HashMap::new())),
            known_ports: Arc::new(RwLock::new(HashMap::new())),
            scanner,
            probe,
        }
    }

    pub async fn get_port(&self, path: &Path) -> Option<u16> {
        let map = self.active_instances.read().await;
        
        // Try exact match first
        if let Some(port) = map.get(path).copied() {
            return Some(port);
        }
        
        // Try canonicalized path match (handles symlinks)
        if let Ok(canonical) = path.canonicalize() {
            if let Some(port) = map.get(&canonical).copied() {
                return Some(port);
            }
            
            // Also try matching against canonicalized keys
            for (stored_path, port) in map.iter() {
                if let Ok(stored_canonical) = stored_path.canonicalize() {
                    if stored_canonical == canonical {
                        return Some(*port);
                    }
                }
            }
        }
        
        None
    }

    pub async fn run_loop(self: Arc<Self>) {
        loop {
            if let Err(e) = self.scan_and_update().await {
                eprintln!("OpenCode discovery error: {}", e);
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }

    /// Perform a single scan cycle
    pub async fn scan_and_update(&self) -> Result<(), OpenCodeError> {
        // 1. Get all listeners
        let listeners = self.scanner.get_active_listeners()?;

        // 2. Filter for potential candidates (node processes that might be OpenCode)
        let candidates: Vec<u16> = listeners
            .into_iter()
            .filter(|(_, name)| {
                let n = name.to_lowercase();
                n.contains("node") || n.contains("opencode") || n.contains("code-server") || n.contains("code")
            })
            .map(|(port, _)| port)
            .collect();

        let candidate_set: HashSet<u16> = candidates.iter().copied().collect();
        
        // 3. Identify new and removed ports
        let mut known_ports_guard = self.known_ports.write().await;
        let mut active_instances_guard = self.active_instances.write().await;

        // Detect Removed
        let mut removed_ports = Vec::new();
        for port in known_ports_guard.keys() {
            if !candidate_set.contains(port) {
                removed_ports.push(*port);
            }
        }

        for port in removed_ports {
            if let Some(path) = known_ports_guard.remove(&port) {
                active_instances_guard.remove(&path);
            }
        }

        // Detect New
        let mut new_ports = Vec::new();
        for port in candidates {
            if !known_ports_guard.contains_key(&port) {
                new_ports.push(port);
            }
        }

        drop(known_ports_guard);
        drop(active_instances_guard);

        // 4. Probe new ports (concurrently would be better, but serial is safer for now)
        for port in new_ports {
            match self.probe.probe(port).await {
                Ok(path) => {
                    // Update locks again
                    let mut known = self.known_ports.write().await;
                    let mut active = self.active_instances.write().await;
                    
                    // Check if this path is already served by another port (stale?)
                    // If so, we overwrite it (assuming new one is correct)
                    if let Some(old_port) = active.insert(path.clone(), port) {
                        known.remove(&old_port);
                    }
                    known.insert(port, path);
                }
                Err(_) => {
                    // Probe failed, probably not OpenCode. Ignore silently.
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
    use crate::opencode::{MockInstanceProbe, MockPortScanner};

    #[tokio::test]
    async fn test_discovery_loop_detects_new_instance() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();

        // Setup: Scanner returns port 3000
        mock_scanner
            .expect_get_active_listeners()
            .returning(|| Ok(vec![(3000, "node".to_string())]));

        // Setup: Probe confirms it's /foo/bar
        mock_probe
            .expect_probe()
            .with(mockall::predicate::eq(3000))
            .returning(|_| Box::pin(async { Ok(PathBuf::from("/foo/bar")) }));

        let service = OpenCodeDiscoveryService::new_with_deps(
            Box::new(mock_scanner),
            Box::new(mock_probe),
        );

        // Action: Run scan
        service.scan_and_update().await.unwrap();

        // Assert: Port is mapped
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));
    }

    #[tokio::test]
    async fn test_discovery_lifecycle() {
        let mut mock_scanner = MockPortScanner::new();
        let mut mock_probe = MockInstanceProbe::new();
        
        // Sequence of returns
        let mut seq = mockall::Sequence::new();
        
        // 1. Found
        mock_scanner
            .expect_get_active_listeners()
            .times(1)
            .in_sequence(&mut seq)
            .returning(|| Ok(vec![(3000, "node".to_string())]));
            
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
        );

        // 1. Scan -> Found
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, Some(3000));

        // 2. Scan -> Gone
        service.scan_and_update().await.unwrap();
        assert_eq!(service.get_port(Path::new("/foo/bar")).await, None);
    }
}
