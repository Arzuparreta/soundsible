mod engine;
mod state;
mod tray;

use engine::EngineSupervisor;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub engine: EngineSupervisor,
    selected_folder: Mutex<Option<PathBuf>>,
    skip_autostart_once: Mutex<bool>,
}

#[derive(serde::Serialize)]
struct FolderPreview {
    path: String,
    track_count: u64,
    size_bytes: u64,
    scan_ms: u64,
}

#[tauri::command]
fn get_startup_profile(state: State<'_, AppState>) -> state::StartupProfile {
    let skip = state
        .skip_autostart_once
        .lock()
        .ok()
        .is_some_and(|mut flag| {
            if *flag {
                *flag = false;
                true
            } else {
                false
            }
        });
    state::startup_profile(skip)
}

#[tauri::command]
fn stop_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop(Some(&app))?;
    if let Ok(mut skip) = state.skip_autostart_once.lock() {
        *skip = true;
    }
    return_to_shell(&app)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autostart().enable().map_err(|e| e.to_string())
    } else {
        app.autostart().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autostart().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_configured_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !state::has_consumer_config() {
        return Err("Soundsible is not configured yet.".into());
    }
    let music_dir = state::load_persisted_music_dir().ok_or_else(|| {
        "Configured music folder is missing. Choose a folder again from first-run.".into()
    })?;
    if let Ok(mut slot) = state.selected_folder.lock() {
        *slot = Some(music_dir.clone());
    }
    state.engine.start(app, music_dir)
}

#[tauri::command]
fn get_engine_status(state: State<'_, AppState>) -> engine::EngineStatus {
    state.engine.status()
}

#[tauri::command]
fn get_selected_folder(state: State<'_, AppState>) -> Option<String> {
    state
        .selected_folder
        .lock()
        .ok()
        .and_then(|v| v.as_ref().map(|p| p.display().to_string()))
}

#[tauri::command]
async fn pick_music_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("Choose your music folder")
        .blocking_pick_folder();
    if let Some(path) = folder {
        let pb = path.into_path().map_err(|e| e.to_string())?;
        if let Ok(mut slot) = state.selected_folder.lock() {
            *slot = Some(pb.clone());
        }
        Ok(Some(pb.display().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn preview_music_folder(path: String) -> Result<FolderPreview, String> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Folder does not exist".into());
    }
    let mut track_count = 0u64;
    let mut size_bytes = 0u64;
    let extensions = ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif"];
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if ext.as_deref().map(|e| extensions.contains(&e)).unwrap_or(false) {
            track_count += 1;
            size_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(FolderPreview {
        path,
        track_count,
        size_bytes,
        scan_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
fn start_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let music_dir = state
        .selected_folder
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Choose a music folder first.".to_string())?;
    state.engine.start(app, music_dir)
}

#[tauri::command]
fn restart_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.engine.restart(app)
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<(), String> {
    let log_dir = state::load_runtime_state()
        .map(|s| PathBuf::from(s.log_dir))
        .unwrap_or_else(|| state::config_dir().join("logs"));
    app.opener()
        .open_path(log_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_player(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let url = state
        .engine
        .status()
        .player_url
        .ok_or_else(|| "Engine is not ready.".to_string())?;
    navigate_main_window(&app, &url)
}

pub fn return_to_shell(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window
        .navigate(WebviewUrl::App("index.html".into()))
        .map_err(|e| e.to_string())
}

fn navigate_main_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let parsed = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .manage(AppState {
            engine: EngineSupervisor::new(),
            selected_folder: Mutex::new(None),
            skip_autostart_once: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_profile,
            start_configured_engine,
            stop_engine,
            set_autostart,
            get_autostart,
            get_engine_status,
            get_selected_folder,
            pick_music_folder,
            preview_music_folder,
            start_engine,
            restart_engine,
            open_logs,
            open_player
        ])
        .setup(|app| {
            tray::build_tray(app.handle())?;
            tray::register_global_shortcuts(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::CloseRequested { .. }) {
                        tray::shutdown(&app_handle);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.engine.stop(None);
                }
            }
        });
}
