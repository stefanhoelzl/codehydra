pub mod code_server;
pub mod git_worktree_provider;
pub mod test_utils;
pub mod workspace_provider;

use code_server::{cleanup_all_servers, cleanup_all_servers_internal, start_code_server, start_code_server_internal, stop_code_server, stop_code_server_internal, ProcessManager};
use git_worktree_provider::GitWorktreeProvider;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::window::Color;
use tauri::Theme;
use tauri::Manager;
use tokio::sync::RwLock;
use workspace_provider::{ProjectHandle, ToTauriResult, Workspace, WorkspaceError, WorkspaceProvider};

/// Application state managing projects and code servers
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<ProcessManager>,
}

pub struct ProjectContext {
    provider: Arc<GitWorktreeProvider>,
    workspace_ports: Vec<u16>,  // Track ports so we can stop code-servers
}

/// Workspace with code-server information for frontend
#[derive(Serialize, Clone, Debug)]
pub struct WorkspaceInfo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub port: u16,
    pub url: String,
}

impl AppState {
    pub fn new(code_server_manager: Arc<ProcessManager>) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Show the main window - called by frontend when ready
#[tauri::command]
async fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.maximize().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let folder = app.dialog()
        .file()
        .blocking_pick_folder();
    
    match folder {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// Internal implementation for opening a project
pub async fn open_project_impl(state: &AppState, path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(path);

    // Async new() to avoid blocking
    let provider = GitWorktreeProvider::new(path_buf.clone())
        .await
        .to_tauri()?;

    let handle = ProjectHandle::new();
    let context = ProjectContext {
        provider: Arc::new(provider),
        workspace_ports: Vec::new(),  // Will be populated when workspaces are discovered
    };

    // Using write lock
    let mut projects = state.projects.write().await;
    projects.insert(handle, context);
    drop(projects); // Release lock

    Ok(handle.to_string())
}

#[tauri::command]
async fn open_project(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    open_project_impl(&state, path).await
}

/// Internal implementation for discovering workspaces
pub async fn discover_workspaces_impl(
    state: &AppState,
    handle: String,
) -> Result<Vec<WorkspaceInfo>, String> {
    // Proper handle parsing with error conversion
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    // Using read lock for better concurrency
    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or_else(|| WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects); // Release lock before long operation

    // Discover all workspaces
    let workspaces = provider.discover().await.to_tauri()?;
    
    // Start code-servers in parallel for better performance
    let manager = state.code_server_manager.clone();
    let startup_futures: Vec<_> = workspaces
        .iter()
        .map(|workspace| {
            let workspace_path = workspace.path().to_string_lossy().to_string();
            let workspace_name = workspace.name().to_string();
            let workspace_branch = workspace.branch().map(String::from);
            let manager_ref = manager.clone();
            
            async move {
                let code_server_info =
                    start_code_server_internal(workspace_path.clone(), &manager_ref).await?;
                
                Ok::<WorkspaceInfo, String>(WorkspaceInfo {
                    name: workspace_name,
                    path: workspace_path,
                    branch: workspace_branch,
                    port: code_server_info.port,
                    url: code_server_info.url,
                })
            }
        })
        .collect();
    
    // Await all code-server startups concurrently
    let results = futures::future::join_all(startup_futures).await;
    
    // Collect successful results and ports
    let mut workspace_infos = Vec::new();
    let mut ports = Vec::new();
    
    for result in results {
        let workspace_info = result.to_tauri()?;
        ports.push(workspace_info.port);
        workspace_infos.push(workspace_info);
    }
    
    // Store ports in project context for cleanup later
    let mut projects_write = state.projects.write().await;
    if let Some(context) = projects_write.get_mut(&handle) {
        context.workspace_ports = ports;
    }
    drop(projects_write);
    
    Ok(workspace_infos)
}

#[tauri::command]
async fn discover_workspaces(
    state: tauri::State<'_, AppState>,
    handle: String,
) -> Result<Vec<WorkspaceInfo>, String> {
    discover_workspaces_impl(&state, handle).await
}

/// Internal implementation for closing a project
pub async fn close_project_impl(state: &AppState, handle: String) -> Result<(), String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let mut projects = state.projects.write().await;
    let context = projects
        .remove(&handle)
        .ok_or_else(|| WorkspaceError::ProjectNotFound)
        .to_tauri()?;
    
    drop(projects);
    
    // Stop all code-servers for this project's workspaces
    for port in context.workspace_ports {
        let _ = stop_code_server_internal(port, &state.code_server_manager).await;
    }

    Ok(())
}

#[tauri::command]
async fn close_project(state: tauri::State<'_, AppState>, handle: String) -> Result<(), String> {
    close_project_impl(&state, handle).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let process_manager = Arc::new(ProcessManager::new());
    let app_state = AppState::new(process_manager.clone());

    // Clone for cleanup handler
    let cleanup_manager = process_manager.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(process_manager)
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            greet,
            open_directory,
            start_code_server,
            stop_code_server,
            cleanup_all_servers,
            open_project,
            discover_workspaces,
            close_project,
            show_window
        ])
        .setup(|app| {
            // Configure window appearance for dark theme
            // Background color #1e1e1e = RGB(30, 30, 30)
            let window = app.get_webview_window("main").expect("main window not found");
            
            // Set dark background color for window and webview
            window.set_background_color(Some(Color(30, 30, 30, 255)))?;
            
            // Set dark theme for window decorations (title bar)
            window.set_theme(Some(Theme::Dark))?;
            
            // Window starts hidden (visible: false in tauri.conf.json)
            // Frontend will call show_window command when ready
            
            // Register cleanup handler for Ctrl+C
            tauri::async_runtime::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                println!("Ctrl+C received - cleaning up code-servers...");
                let _ = cleanup_all_servers_internal(&cleanup_manager).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Handle app exit event
            if let tauri::RunEvent::Exit = event {
                println!("App exiting - cleaning up code-servers...");
                let app_state: tauri::State<AppState> = app_handle.state();
                tauri::async_runtime::block_on(async {
                    let _ = cleanup_all_servers_internal(&app_state.code_server_manager).await;
                });
            }
        });
}
