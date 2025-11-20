use tokio::sync::Mutex;
use std::collections::HashMap;
use tokio::process::Child;
use serde::Serialize;
use std::time::Duration;

const CODE_SERVER_BINARY: &str = "/var/home/stefan/Development/repos/chime/.temp/code-server-4.106.0-linux-amd64/bin/code-server";
const PORT_START: u16 = 7000;
const PORT_END: u16 = 7100;

#[derive(Serialize, Clone)]
pub struct CodeServerInfo {
    pub port: u16,
    pub url: String,
}

pub struct ProcessManager {
    processes: Mutex<HashMap<u16, Child>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    /// Get the number of running code-server processes (for testing)
    pub async fn process_count(&self) -> usize {
        let processes = self.processes.lock().await;
        processes.len()
    }
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Find an available port that's not already reserved in the processes map
fn find_available_port(reserved_ports: &HashMap<u16, Child>) -> Result<u16, String> {
    for port in PORT_START..=PORT_END {
        // Check if port is not already reserved and is available on the system
        if !reserved_ports.contains_key(&port) && port_scanner::local_port_available(port) {
            return Ok(port);
        }
    }
    Err("No available ports in range 7000-7100".to_string())
}

async fn wait_for_server(port: u16) -> Result<(), String> {
    let url = format!("http://localhost:{}/healthz", port);
    
    // Poll every 100ms for faster startup (300 attempts = 30 seconds max)
    for i in 0..300 {
        match reqwest::get(&url).await {
            Ok(response) => {
                if response.status().is_success() {
                    println!("Health check succeeded on attempt {} (~{}ms)", i + 1, i * 100);
                    return Ok(());
                }
            },
            Err(e) => {
                if i == 0 || i % 50 == 0 {
                    eprintln!("Health check attempt {}: {}", i + 1, e);
                }
            },
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Server failed to start within 30 seconds".to_string())
}

/// Internal function to start code-server
pub async fn start_code_server_internal(
    project_path: String,
    manager: &ProcessManager,
) -> Result<CodeServerInfo, String> {
    use tokio::process::Command;
    use std::process::Stdio;
    
    // Find and reserve port atomically to prevent race conditions in parallel startup
    let port = {
        let processes = manager.processes.lock().await;
        find_available_port(&processes)?
    };
    
    println!("Starting code-server on port {} for path: {}", port, project_path);
    
    let child = Command::new(CODE_SERVER_BINARY)
        .env("VSCODE_PROXY_URI", "")
        .arg("--bind-addr").arg(format!("127.0.0.1:{}", port))
        .arg("--auth").arg("none")
        .arg("--disable-telemetry")
        .arg("--disable-update-check")
        .arg("--disable-workspace-trust")
        .arg(&project_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn code-server: {}", e))?;
    
    println!("Code-server process spawned, waiting for health check...");
    
    // Store process immediately to reserve the port
    {
        let mut processes = manager.processes.lock().await;
        processes.insert(port, child);
    }
    
    // Wait for server to be ready
    wait_for_server(port).await?;
    
    println!("Health check passed!");
    
    // URL with folder parameter so code-server opens the correct directory
    let url = format!("http://localhost:{}/?folder={}", port, project_path);
    Ok(CodeServerInfo { port, url })
}

#[tauri::command]
pub async fn start_code_server(
    project_path: String,
    state: tauri::State<'_, ProcessManager>,
) -> Result<CodeServerInfo, String> {
    start_code_server_internal(project_path, &state).await
}

/// Internal function to stop code-server
pub async fn stop_code_server_internal(
    port: u16,
    manager: &ProcessManager,
) -> Result<(), String> {
    let mut processes = manager.processes.lock().await;
    
    if let Some(mut child) = processes.remove(&port) {
        drop(processes); // Release lock before awaiting
        let _ = child.kill().await;
        // Wait for the process to actually terminate
        let _ = child.wait().await;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn stop_code_server(
    port: u16,
    state: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    stop_code_server_internal(port, &state).await
}

/// Internal function to cleanup all servers
pub async fn cleanup_all_servers_internal(manager: &ProcessManager) -> Result<(), String> {
    let mut processes = manager.processes.lock().await;
    let children: Vec<Child> = processes.drain().map(|(_, child)| child).collect();
    drop(processes); // Release lock before awaiting
    
    for mut child in children {
        let _ = child.kill().await;
        // Wait for the process to actually terminate
        let _ = child.wait().await;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn cleanup_all_servers(
    state: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    cleanup_all_servers_internal(&state).await
}
