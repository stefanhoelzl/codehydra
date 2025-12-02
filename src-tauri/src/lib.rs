pub mod agent_status;
pub mod agent_status_manager;
pub mod agent_status_provider;
pub mod bootstrapper;
pub mod code_server;
pub mod config;
pub mod error;
pub mod git_worktree_provider;
pub mod opencode;
pub mod platform;
pub mod project_store;
pub mod runtime_versions;
pub mod setup;
pub mod test_utils;
pub mod workspace_provider;

use agent_status::AggregatedAgentStatus;
use agent_status_manager::AgentStatusManager;
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
use tokio::sync::{broadcast, RwLock};
use workspace_provider::{
    BranchInfo, ProjectHandle, RemovalResult, ToTauriResult, Workspace, WorkspaceError,
    WorkspaceProvider,
};

/// Application state managing projects and code servers
pub struct AppState {
    projects: Arc<RwLock<HashMap<ProjectHandle, ProjectContext>>>,
    code_server_manager: Arc<CodeServerManager>,
    project_store: Arc<ProjectStore>,
    agent_status_manager: Arc<AgentStatusManager>,
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

/// Status of a workspace (for removal dialog)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub has_uncommitted_changes: bool,
    pub is_main_worktree: bool,
}

impl AppState {
    pub fn new(
        code_server_manager: Arc<CodeServerManager>,
        project_store: Arc<ProjectStore>,
        agent_status_manager: Arc<AgentStatusManager>,
    ) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            code_server_manager,
            project_store,
            agent_status_manager,
        }
    }

    /// Get the agent status manager (exposed for testing)
    pub fn agent_status_manager(&self) -> &Arc<AgentStatusManager> {
        &self.agent_status_manager
    }

    /// Get the project store (exposed for testing)
    pub fn project_store(&self) -> &Arc<ProjectStore> {
        &self.project_store
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
            eprintln!("Failed to emit setup event: {e}");
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
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
        eprintln!("Failed to persist project: {e}");
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

    // Initialize agent status monitoring for each discovered workspace
    let agent_manager = state.agent_status_manager.clone();
    for workspace in &workspaces {
        if let Err(e) = agent_manager.init_workspace(workspace.path()).await {
            eprintln!(
                "Failed to initialize agent status for workspace {:?}: {}",
                workspace.path(),
                e
            );
        }
    }

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
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    // Remove persistence FIRST (for atomicity)
    let project_path = context.provider.project_root();
    state.project_store.remove_project(project_path).await
        .map_err(|e| format!("Failed to remove project persistence data: {e}"))?;

    // Then remove from memory
    projects.remove(&handle);

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

    // Initialize agent status monitoring for the new workspace
    if let Err(e) = state
        .agent_status_manager
        .init_workspace(workspace.path())
        .await
    {
        eprintln!(
            "Failed to initialize agent status for workspace {:?}: {}",
            workspace.path(),
            e
        );
    }

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

/// Internal implementation for checking workspace status
pub async fn check_workspace_status_impl(
    state: &AppState,
    handle: String,
    workspace_path: String,
) -> Result<WorkspaceStatus, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    let workspace_path = PathBuf::from(&workspace_path);
    let is_main_worktree = provider.is_main_worktree(&workspace_path);
    let has_uncommitted_changes = provider
        .has_uncommitted_changes(&workspace_path)
        .await
        .to_tauri()?;

    Ok(WorkspaceStatus {
        has_uncommitted_changes,
        is_main_worktree,
    })
}

#[tauri::command]
async fn check_workspace_status(
    state: tauri::State<'_, AppState>,
    handle: String,
    workspace_path: String,
) -> Result<WorkspaceStatus, String> {
    check_workspace_status_impl(&state, handle, workspace_path).await
}

/// Internal implementation for removing a workspace
pub async fn remove_workspace_impl(
    state: &AppState,
    handle: String,
    workspace_path: String,
    delete_branch: bool,
) -> Result<RemovalResult, String> {
    let handle: ProjectHandle = handle.parse().to_tauri()?;

    let projects = state.projects.read().await;
    let context = projects
        .get(&handle)
        .ok_or(WorkspaceError::ProjectNotFound)
        .to_tauri()?;

    let provider = context.provider.clone();
    drop(projects);

    let workspace_path = PathBuf::from(&workspace_path);
    provider
        .remove_workspace(&workspace_path, delete_branch)
        .await
        .to_tauri()
}

#[tauri::command]
async fn remove_workspace(
    state: tauri::State<'_, AppState>,
    handle: String,
    workspace_path: String,
    delete_branch: bool,
) -> Result<RemovalResult, String> {
    remove_workspace_impl(&state, handle, workspace_path, delete_branch).await
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

/// Get current agent status for a workspace
#[tauri::command]
async fn get_agent_status(
    state: tauri::State<'_, AppState>,
    workspace_path: String,
) -> Result<AggregatedAgentStatus, String> {
    let path = PathBuf::from(&workspace_path);
    Ok(state.agent_status_manager.get_status(&path).await)
}

/// Get all workspace agent statuses
#[tauri::command]
async fn get_all_agent_statuses(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, AggregatedAgentStatus>, String> {
    let statuses = state.agent_status_manager.get_all_statuses().await;
    Ok(statuses
        .into_iter()
        .map(|(k, v)| (k.to_string_lossy().to_string(), v))
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
    // Force X11 backend for global shortcuts to work on Wayland via XWayland
    // This is safe to set unconditionally - ignored on native X11, required on Wayland
    std::env::set_var("GDK_BACKEND", "x11");

    let config = CodeServerConfig::new(env!("CARGO_PKG_VERSION"))
        .expect("Failed to create CodeServerConfig");
    let code_server_manager = Arc::new(CodeServerManager::new(config));
    let project_store = Arc::new(ProjectStore::new());
    let agent_status_manager = Arc::new(AgentStatusManager::new());

    // Create global shutdown token for background tasks
    let shutdown_token = Arc::new(tokio_util::sync::CancellationToken::new());
    let shutdown_token_for_setup = shutdown_token.clone();

    let app_state = AppState::new(
        code_server_manager.clone(),
        project_store,
        agent_status_manager.clone(),
    );

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
            check_workspace_status,
            remove_workspace,
            show_window,
            check_runtime_ready,
            setup_runtime,
            ensure_code_server_running,
            get_workspace_url,
            stop_code_server,
            is_code_server_running,
            load_persisted_projects,
            get_agent_status,
            get_all_agent_statuses
        ])
        .setup(move |app| {
            let shutdown_token = shutdown_token_for_setup;
            // Set up global shortcuts for Chime keyboard navigation
            // Alt+X activates shortcut mode (must hold both Alt and X)
            // Alt+{ActionKey} performs actions while active
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // Activation shortcut - handles both press and release
                let activation_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyX);

                // Action shortcuts - only fire on press
                let action_shortcuts: Vec<(Shortcut, &'static str)> = vec![
                    // Navigation
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::ArrowUp),
                        "codehydra-action-up",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::ArrowDown),
                        "codehydra-action-down",
                    ),
                    // Workspace actions
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Enter),
                        "codehydra-action-create",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Delete),
                        "codehydra-action-remove",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Backspace),
                        "codehydra-action-remove",
                    ),
                    // Jump to workspace (1-9, 0 for 10th)
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit1),
                        "codehydra-action-jump-1",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit2),
                        "codehydra-action-jump-2",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit3),
                        "codehydra-action-jump-3",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit4),
                        "codehydra-action-jump-4",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit5),
                        "codehydra-action-jump-5",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit6),
                        "codehydra-action-jump-6",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit7),
                        "codehydra-action-jump-7",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit8),
                        "codehydra-action-jump-8",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit9),
                        "codehydra-action-jump-9",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::ALT), Code::Digit0),
                        "codehydra-action-jump-0",
                    ),
                ];

                // Clone for the handler closure
                let action_shortcuts_for_handler = action_shortcuts.clone();
                let activation_shortcut_for_handler = activation_shortcut;
                let app_handle = app.handle().clone();

                // Register plugin with handler
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |_app, shortcut, event| {
                            // Handle activation shortcut (Alt+X) - both press and release
                            if shortcut == &activation_shortcut_for_handler {
                                match event.state() {
                                    ShortcutState::Pressed => {
                                        let _ = app_handle.emit("codehydra-shortcut-activated", ());
                                    }
                                    ShortcutState::Released => {
                                        let _ = app_handle.emit("codehydra-shortcut-deactivated", ());
                                    }
                                }
                                return;
                            }

                            // Handle action shortcuts - only on press
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }

                            // Find matching shortcut and emit event
                            for (s, event_name) in &action_shortcuts_for_handler {
                                if shortcut == s {
                                    let _ = app_handle.emit(event_name, ());
                                    break;
                                }
                            }
                        })
                        .build(),
                )?;

                // Combine all shortcuts for registration
                let all_shortcuts: Vec<(Shortcut, &'static str)> = std::iter::once((
                    activation_shortcut,
                    "codehydra-shortcut-activated/deactivated",
                ))
                .chain(action_shortcuts)
                .collect();

                // Register all shortcuts (ignore registration failures for now)
                for (shortcut, event_name) in &all_shortcuts {
                    if let Err(e) = app.global_shortcut().register(*shortcut) {
                        eprintln!("[Chime] Failed to register shortcut for {event_name}: {e:?}");
                    }
                }
            }

            // Initialize OpenCode integration
            let opencode_discovery =
                Arc::new(crate::opencode::discovery::OpenCodeDiscoveryService::new());
            let discovery_clone = opencode_discovery.clone();

            // Wire up code-server PID to discovery service
            let discovery_pid_monitor = opencode_discovery.clone();
            let code_server_for_pid = code_server_manager.clone();
            let pid_monitor_token = shutdown_token.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        _ = pid_monitor_token.cancelled() => {
                            break;
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {
                            let pid = code_server_for_pid.pid().await;
                            discovery_pid_monitor.set_code_server_pid(pid).await;
                        }
                    }
                }
            });

            let discovery_token = shutdown_token.clone();
            tauri::async_runtime::spawn(async move {
                discovery_clone.run_loop(discovery_token).await;
            });

            let opencode_factory = Box::new(
                crate::opencode::provider::OpenCodeProviderFactory::new(opencode_discovery),
            );

            // Register factory synchronously to avoid race conditions
            // where init_workspace is called before the factory is registered
            let asm = agent_status_manager.clone();
            tauri::async_runtime::block_on(async move {
                asm.register_factory(opencode_factory).await;
            });

            // Configure window appearance for dark theme
            // Background color #1e1e1e = RGB(30, 30, 30)
            let window = app.get_webview_window("main").expect("main window not found");

            // Set dark background color for window and webview
            window.set_background_color(Some(Color(30, 30, 30, 255)))?;

            // Set dark theme for window decorations (title bar)
            window.set_theme(Some(Theme::Dark))?;

            // Window starts hidden (visible: false in tauri.conf.json)
            // Frontend will call show_window command when ready

            // Set up event forwarding from AgentStatusManager to frontend
            let app_handle = app.handle().clone();
            let status_manager = agent_status_manager.clone();
            let event_forward_token = shutdown_token.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = status_manager.subscribe();
                loop {
                    tokio::select! {
                        _ = event_forward_token.cancelled() => {
                            break;
                        }
                        result = rx.recv() => {
                            match result {
                                Ok(event) => {
                                    if let Err(e) = app_handle.emit("agent-status-changed", &event) {
                                        eprintln!("Failed to emit agent status event: {e}");
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(n)) => {
                                    eprintln!("Agent status event listener lagged by {n} events");
                                    continue;
                                }
                                Err(broadcast::error::RecvError::Closed) => {
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            // Register cleanup handler for Ctrl+C
            let ctrl_c_code_server = code_server_manager.clone();
            let ctrl_c_status_manager = agent_status_manager.clone();
            let ctrl_c_token = shutdown_token.clone();
            tauri::async_runtime::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                println!("Ctrl+C received - cleaning up...");
                ctrl_c_token.cancel(); // Cancel background tasks
                ctrl_c_status_manager.shutdown().await;
                let _ = ctrl_c_code_server.stop().await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            // Handle app exit event
            if let tauri::RunEvent::Exit = event {
                println!("App exiting - cleaning up...");
                let shutdown_token_clone = shutdown_token.clone();

                // Cancel background tasks immediately
                shutdown_token_clone.cancel();

                // Perform cleanup with timeout to avoid blocking app exit indefinitely
                let app_state: tauri::State<AppState> = app_handle.state();
                let agent_manager = app_state.agent_status_manager.clone();
                let code_server_manager = app_state.code_server_manager.clone();

                // Use block_on with timeout for critical cleanup
                let cleanup_result = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(2), // 2 second timeout for cleanup
                        async {
                            agent_manager.shutdown().await;
                            let _ = code_server_manager.stop().await;
                        }
                    ).await
                });

                match cleanup_result {
                    Ok(_) => println!("Cleanup completed successfully"),
                    Err(_) => eprintln!("Cleanup timed out - forcing exit"),
                }
            }
        });
}
