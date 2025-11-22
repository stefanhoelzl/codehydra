pub mod bootstrapper;
pub mod code_server;
pub mod config;
pub mod error;
pub mod git_worktree_provider;
pub mod platform;
pub mod runtime_versions;
pub mod setup;
pub mod test_utils;
pub mod workspace_provider;

use bootstrapper::{
    ArchiveExtractorImpl, EventEmitter, NoOpEventEmitter, ReqwestHttpClient, RuntimeBootstrapper,
    StdFileSystem, StdProcessSpawner,
};
use code_server::CodeServerManager;
use config::CodeServerConfig;
use setup::SetupEvent;
use git_worktree_provider::GitWorktreeProvider;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::window::Color;
use tauri::{Emitter, Manager, Theme};
use tokio::sync::RwLock;
use workspace_provider::{ProjectHandle, ToTauriResult, Workspace, WorkspaceError, WorkspaceProvider};

/// Application state managing projects and code servers
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
}

pub struct ProjectContext {
    provider: Arc<GitWorktreeProvider>,
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
    pub fn new(code_server_manager: Arc<CodeServerManager>) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
        }
    }
}

/// Tauri-specific EventEmitter that uses app.emit() to send events to the frontend.
pub struct TauriEventEmitter {
    app: tauri::AppHandle,
}

impl TauriEventEmitter {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EventEmitter for TauriEventEmitter {
    fn emit(&self, event: SetupEvent) {
        if let Err(e) = self.app.emit("setup-progress", &event) {
            eprintln!("Failed to emit setup event: {}", e);
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

    let folder = app.dialog().file().blocking_pick_folder();

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
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects); // Release lock before long operation

    // Discover all workspaces
    let workspaces = provider.discover().await.to_tauri()?;

    // Ensure the code-server is running
    let manager = state.code_server_manager.clone();
    let port = manager.ensure_running().await.map_err(|e| e.to_string())?;

    // Build workspace infos with URLs
    let workspace_infos: Vec<WorkspaceInfo> = workspaces
        .iter()
        .map(|workspace| {
            let workspace_path = workspace.path();
            let url = format!(
                "http://localhost:{}/?folder={}",
                port,
                crate::platform::paths::encode_path_for_url(workspace_path)
            );

            WorkspaceInfo {
                name: workspace.name().to_string(),
                path: workspace_path.to_string_lossy().to_string(),
                branch: workspace.branch().map(String::from),
                port,
                url,
            }
        })
        .collect();

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
    let _context = projects
        .remove(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    drop(projects);

    // Note: We no longer stop code-servers per-project since we use a single global instance
    // The code-server will be stopped when the app exits

    Ok(())
}

#[tauri::command]
async fn close_project(state: tauri::State<'_, AppState>, handle: String) -> Result<(), String> {
    close_project_impl(&state, handle).await
}

/// Ensure the code-server is running and return its port
#[tauri::command]
async fn ensure_code_server_running(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    state
        .code_server_manager
        .ensure_running()
        .await
        .map_err(|e| e.to_string())
}

/// Get the URL for a workspace folder
#[tauri::command]
async fn get_workspace_url(
    state: tauri::State<'_, AppState>,
    folder_path: String,
) -> Result<Option<String>, String> {
    let path = PathBuf::from(&folder_path);
    Ok(state.code_server_manager.url_for_folder(&path).await)
}

/// Stop the code-server
#[tauri::command]
async fn stop_code_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .code_server_manager
        .stop()
        .await
        .map_err(|e| e.to_string())
}

/// Check if the code-server is running
#[tauri::command]
async fn is_code_server_running(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.code_server_manager.is_running().await)
}

/// Check if the runtime (Bun, code-server, extensions) is ready.
#[tauri::command]
async fn check_runtime_ready() -> Result<bool, String> {
    let config = CodeServerConfig::new(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;

    let bootstrapper: RuntimeBootstrapper<
        ReqwestHttpClient,
        StdFileSystem,
        ArchiveExtractorImpl,
        NoOpEventEmitter,
        StdProcessSpawner,
    > = RuntimeBootstrapper::new(config);

    Ok(bootstrapper.is_ready())
}

/// Start the runtime setup process with progress events.
#[tauri::command]
async fn setup_runtime(app: tauri::AppHandle) -> Result<(), String> {
    let config = CodeServerConfig::new(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;

    let event_emitter = TauriEventEmitter::new(app);

    let bootstrapper = RuntimeBootstrapper::with_deps(
        config,
        ReqwestHttpClient::new(),
        StdFileSystem,
        ArchiveExtractorImpl,
        event_emitter,
        StdProcessSpawner,
    );

    bootstrapper
        .ensure_ready()
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = CodeServerConfig::new(env!("CARGO_PKG_VERSION"))
        .expect("Failed to create CodeServerConfig");
    let code_server_manager = Arc::new(CodeServerManager::new(config));
    let app_state = AppState::new(code_server_manager.clone());

    // Clone for cleanup handler
    let cleanup_manager = code_server_manager.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            greet,
            open_directory,
            open_project,
            discover_workspaces,
            close_project,
            show_window,
            check_runtime_ready,
            setup_runtime,
            ensure_code_server_running,
            get_workspace_url,
            stop_code_server,
            is_code_server_running
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
                let _ = cleanup_manager.stop().await;
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
                    let _ = app_state.code_server_manager.stop().await;
                });
            }
        });
}
