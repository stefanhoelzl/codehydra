mod code_server;

use code_server::{ProcessManager, start_code_server, stop_code_server, cleanup_all_servers};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessManager::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_directory,
            start_code_server,
            stop_code_server,
            cleanup_all_servers
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
