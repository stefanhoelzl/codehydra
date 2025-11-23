pub mod bootstrapper;
pub mod code_server;
pub mod config;
pub mod error;
pub mod git_worktree_provider;
pub mod platform;
pub mod project_store;
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
use git_worktree_provider::GitWorktreeProvider;
use platform::paths::normalize_path;
use project_store::ProjectStore;
use serde::Serialize;
use setup::SetupEvent;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::window::Color;
use tauri::{Emitter, Manager, Theme};
use tokio::sync::RwLock;
use workspace_provider::{
    BranchInfo, ProjectHandle, ToTauriResult, Workspace, WorkspaceError, WorkspaceProvider,
};

/// Application state managing projects and code servers
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
    project_store: Arc<ProjectStore>,
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
    pub fn new(code_server_manager: Arc<CodeServerManager>, project_store: Arc<ProjectStore>) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
            project_store,
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
    let path_buf = PathBuf::from(&path);

    // Normalize path to resolve symlinks and get canonical path
    let normalized_path = normalize_path(&path_buf).to_tauri()?;

    // Check if already open - return existing handle
    {
        let projects = state.projects.read().await;
        for (handle, ctx) in projects.iter() {
            if ctx.provider.project_root() == normalized_path {
                return Ok(handle.to_string());
            }
        }
    }

    // Async new() to avoid blocking
    let provider = GitWorktreeProvider::new(normalized_path.clone())
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

    // Persist to disk (non-fatal if fails)
    if let Err(e) = state.project_store.save_project(&normalized_path).await {
        eprintln!("Failed to persist project: {}", e);
    }

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

/// Internal implementation for listing branches
pub async fn list_branches_impl(
    state: &AppState,
    handle: String,
) -> Result<Vec<BranchInfo>, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    provider.list_branches().await.to_tauri()
}

#[tauri::command]
async fn list_branches(
    state: tauri::State<'_, AppState>,
    handle: String,
) -> Result<Vec<BranchInfo>, String> {
    list_branches_impl(&state, handle).await
}

/// Internal implementation for creating a workspace
pub async fn create_workspace_impl(
    state: &AppState,
    handle: String,
    name: String,
    base_branch: String,
) -> Result<WorkspaceInfo, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    let workspace = provider
        .create_workspace(&name, &base_branch)
        .await
        .to_tauri()?;

    // Build WorkspaceInfo with code-server URL
    let port = state
        .code_server_manager
        .ensure_running()
        .await
        .map_err(|e| e.to_string())?;
    let url = format!(
        "http://localhost:{}/?folder={}",
        port,
        crate::platform::paths::encode_path_for_url(workspace.path())
    );

    Ok(WorkspaceInfo {
        name: workspace.name().to_string(),
        path: workspace.path().to_string_lossy().to_string(),
        branch: workspace.branch().map(String::from),
        port,
        url,
    })
}

#[tauri::command]
async fn create_workspace(
    state: tauri::State<'_, AppState>,
    handle: String,
    name: String,
    base_branch: String,
) -> Result<WorkspaceInfo, String> {
    create_workspace_impl(&state, handle, name, base_branch).await
}

/// Internal implementation for fetching branches
pub async fn fetch_branches_impl(state: &AppState, handle: String) -> Result<(), String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    provider.fetch_branches().await.to_tauri()
}

#[tauri::command]
async fn fetch_branches(state: tauri::State<'_, AppState>, handle: String) -> Result<(), String> {
    fetch_branches_impl(&state, handle).await
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

/// Load all persisted project paths from disk
#[tauri::command]
async fn load_persisted_projects(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let paths = state.project_store.load_all_projects().await.to_tauri()?;
    Ok(paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
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
    let project_store = Arc::new(ProjectStore::new());
    let app_state = AppState::new(code_server_manager.clone(), project_store);

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
            list_branches,
            create_workspace,
            fetch_branches,
            show_window,
            check_runtime_ready,
            setup_runtime,
            ensure_code_server_running,
            get_workspace_url,
            stop_code_server,
            is_code_server_running,
            load_persisted_projects
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
