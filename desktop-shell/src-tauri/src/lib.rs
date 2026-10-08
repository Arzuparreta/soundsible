mod client;
mod desktop;
mod engine;
#[cfg(target_os = "linux")]
mod flatpak;
#[cfg(target_os = "linux")]
mod linux_media;
mod pairing;
mod state;
mod tray;

use engine::{EnginePhase, EngineSupervisor};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Theme, WindowEvent};
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

static WRITE_PROBE_ID: AtomicU64 = AtomicU64::new(0);

pub struct AppState {
    pub engine: EngineSupervisor,
    selected_folder: Mutex<Option<PathBuf>>,
    skip_autostart_once: Mutex<bool>,
    pending_track_capsule: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
struct FolderPreview {
    path: String,
    track_count: u64,
    size_bytes: u64,
    scan_ms: u64,
    inaccessible_entries: u64,
    writable: bool,
}

/// The desktop's own light/dark preference, which is what `system` resolves to
/// here — the shell has no prefers-color-scheme to read, but Tauri knows.
fn os_prefers_dark(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.theme().ok())
        .map(|theme| theme != Theme::Light)
        .unwrap_or(true)
}

fn parse_hex_color(value: &str) -> Option<Color> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

/// Paint the window itself, then tell the shell UI which palette it is in.
///
/// The background colour is the half that cannot be done in CSS: without it the
/// webview paints its platform default — white — for a frame on launch and on
/// every navigation between the shell and the player.
fn apply_window_appearance(app: &AppHandle) {
    let appearance = state::load_appearance(os_prefers_dark(app));
    for window in app.webview_windows().into_values() {
        if let Some(color) = appearance.color.as_deref().and_then(parse_hex_color) {
            let _ = window.set_background_color(Some(color));
        }
    }
    let _ = app.emit("shell://appearance", &appearance.theme);
}

/// Kept apart from `get_startup_profile`, which consumes the skip-autostart
/// flag and so must be called exactly once.
#[tauri::command]
fn get_shell_theme(app: AppHandle) -> String {
    state::load_appearance(os_prefers_dark(&app)).theme
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
    let mut profile = state::startup_profile(skip);
    profile.mode = match client::load().mode {
        client::ConnectionMode::Choose => "choose",
        client::ConnectionMode::Local => "local",
        client::ConnectionMode::Server => "server",
    }
    .into();
    profile.server = client::load().server;
    if profile.mode != "local" {
        profile.auto_start = false;
    }
    profile
}

#[tauri::command]
fn stop_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if client::is_server() {
        return Err("The desktop does not manage this server.".into());
    }
    desktop::close_player(&app);
    state.engine.stop(Some(&app))?;
    if let Ok(mut skip) = state.skip_autostart_once.lock() {
        *skip = true;
    }
    return_to_shell(&app)
}

#[tauri::command]
async fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if flatpak::sandboxed() {
        return flatpak::set_autostart(enabled).await;
    }
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    if flatpak::sandboxed() {
        return Ok(flatpak::autostart_enabled());
    }
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_configured_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !state::has_consumer_config() {
        return Err("Soundsible is not configured yet.".into());
    }
    let music_dir = state::load_persisted_music_dir().ok_or_else(|| {
        "Configured music folder is missing. Choose a folder again from first-run.".to_string()
    })?;
    if let Ok(mut slot) = state.selected_folder.lock() {
        *slot = Some(music_dir.clone());
    }
    client::save(&client::Preferences {
        mode: client::ConnectionMode::Local,
        server: client::load().server,
    })?;
    tray::refresh_mode(&app);
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

fn scan_music_folder(path: String) -> Result<FolderPreview, String> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Folder does not exist or is not a directory.".into());
    }

    let probe = root.join(format!(
        ".soundsible-write-probe-{}-{}",
        std::process::id(),
        WRITE_PROBE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let writable = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map(|_| {
            let _ = std::fs::remove_file(&probe);
            true
        })
        .unwrap_or(false);
    if !writable {
        return Err(
            "Folder is not writable. Soundsible needs write access for downloads and metadata."
                .into(),
        );
    }

    let mut track_count = 0u64;
    let mut size_bytes = 0u64;
    let mut inaccessible_entries = 0u64;
    let extensions = [
        "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif",
    ];
    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                inaccessible_entries += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if ext
            .as_deref()
            .map(|e| extensions.contains(&e))
            .unwrap_or(false)
        {
            track_count += 1;
            match entry.metadata() {
                Ok(metadata) => size_bytes += metadata.len(),
                Err(_) => inaccessible_entries += 1,
            }
        }
    }
    Ok(FolderPreview {
        path,
        track_count,
        size_bytes,
        scan_ms: started.elapsed().as_millis() as u64,
        inaccessible_entries,
        writable,
    })
}

#[tauri::command]
async fn preview_music_folder(path: String) -> Result<FolderPreview, String> {
    tauri::async_runtime::spawn_blocking(move || scan_music_folder(path))
        .await
        .map_err(|error| format!("Folder scan task failed: {error}"))?
}

#[tauri::command]
fn log_shell_event(level: String, message: String) -> Result<(), String> {
    use std::io::Write;

    let log_dir = state::config_dir().join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let path = log_dir.join("desktop-shell.log");
    if path
        .metadata()
        .map(|metadata| metadata.len() > 1_048_576)
        .unwrap_or(false)
    {
        let previous = log_dir.join("desktop-shell.previous.log");
        let _ = std::fs::remove_file(&previous);
        std::fs::rename(&path, previous).map_err(|error| error.to_string())?;
    }
    let level = match level.to_ascii_lowercase().as_str() {
        "debug" => "DEBUG",
        "warning" | "warn" => "WARN",
        "error" => "ERROR",
        _ => "INFO",
    };
    let clean = message.replace('\r', " ").replace('\n', " ");
    let clean = clean.chars().take(2000).collect::<String>();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{timestamp} {level} {clean}").map_err(|error| error.to_string())
}

#[tauri::command]
fn start_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let music_dir = state
        .selected_folder
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Choose a music folder first.".to_string())?;
    client::save(&client::Preferences {
        mode: client::ConnectionMode::Local,
        server: client::load().server,
    })?;
    tray::refresh_mode(&app);
    state.engine.start(app, music_dir)
}

#[tauri::command]
fn start_engine_with_path(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Ok(mut slot) = state.selected_folder.lock() {
        *slot = Some(PathBuf::from(&path));
    }
    client::save(&client::Preferences {
        mode: client::ConnectionMode::Local,
        server: client::load().server,
    })?;
    tray::refresh_mode(&app);
    state.engine.start(app, PathBuf::from(path))
}

#[tauri::command]
fn restart_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if client::is_server() {
        return Err("The desktop does not manage this server.".into());
    }
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
fn open_pairing(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.engine.status().phase != EnginePhase::Ready {
        return Err("Start the engine before pairing a phone.".into());
    }
    return_to_shell(&app)?;
    app.emit("shell-view", "pairing")
        .map_err(|e| e.to_string())?;
    Ok(())
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
    tray::hide_player(app);
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn navigate_main_window(app: &AppHandle, url: &str) -> Result<(), String> {
    desktop::open_player(app, url)
}

#[tauri::command]
async fn connect_server(app: AppHandle, address: String) -> Result<(), String> {
    let origin = client::normalize_server(&address)?;
    let probe = origin.clone();
    tauri::async_runtime::spawn_blocking(move || client::probe_server(&probe))
        .await
        .map_err(|e| e.to_string())??;
    // Only a child owned by this desktop may be stopped.
    desktop::close_player(&app);
    app.state::<AppState>().engine.stop(Some(&app))?;
    client::save(&client::Preferences {
        mode: client::ConnectionMode::Server,
        server: Some(origin.clone()),
    })?;
    tray::refresh_mode(&app);
    let target = take_pending_player_url(&app, &format!("{origin}/player/"));
    desktop::open_player(&app, &target)
}

#[tauri::command]
fn change_connection(app: AppHandle) -> Result<(), String> {
    desktop::close_player(&app);
    if !client::is_server() {
        app.state::<AppState>().engine.stop(Some(&app))?;
    }
    return_to_shell(&app)?;
    app.emit("shell-view", "connection")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_desktop(app: AppHandle) {
    tray::shutdown(&app);
}

fn track_capsule_from_deep_link(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "soundsible" || parsed.host_str() != Some("track") {
        return None;
    }
    let capsule = parsed.path().trim_matches('/');
    if capsule.is_empty()
        || capsule.len() > 4096
        || !capsule
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(capsule.to_string())
}

fn player_url_for_capsule(player_url: &str, capsule: &str) -> Option<String> {
    if capsule.is_empty()
        || capsule.len() > 4096
        || !capsule
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let mut parsed = url::Url::parse(player_url).ok()?;
    parsed.set_fragment(Some(&format!("/search?shared={capsule}")));
    Some(parsed.into())
}

fn take_pending_player_url(app: &AppHandle, player_url: &str) -> String {
    let Some(state) = app.try_state::<AppState>() else {
        return player_url.to_string();
    };
    let capsule = state
        .pending_track_capsule
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    capsule
        .and_then(|value| player_url_for_capsule(player_url, &value))
        .unwrap_or_else(|| player_url.to_string())
}

fn handle_deep_link(app: &AppHandle, value: &str, start_if_idle: bool) {
    let Some(capsule) = track_capsule_from_deep_link(value) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(mut pending) = state.pending_track_capsule.lock() {
        *pending = Some(capsule);
    }

    if client::is_server() {
        if let Some(origin) = client::load().server {
            let url = take_pending_player_url(app, &format!("{origin}/player/"));
            let _ = desktop::open_player(app, &url);
        }
        tray::focus_main_window(app);
        return;
    }
    let status = state.engine.status();
    if status.phase == EnginePhase::Ready {
        if let Some(player_url) = status.player_url {
            let target = take_pending_player_url(app, &player_url);
            let _ = navigate_main_window(app, &target);
        }
    } else if start_if_idle && status.phase == EnginePhase::Idle && state::has_consumer_config() {
        if let Some(music_dir) = state::load_persisted_music_dir() {
            if let Ok(mut selected) = state.selected_folder.lock() {
                *selected = Some(music_dir.clone());
            }
            let _ = state.engine.start(app.clone(), music_dir);
        }
    }
    tray::focus_main_window(app);
}

#[cfg(desktop)]
fn single_instance() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri_plugin_single_instance::Builder::new().callback(|app, _argv, _cwd| {
        tray::focus_main_window(app);
    });
    // The plugin's bus name defaults to the Tauri identifier, and Flatpak only
    // lets an app own names under its own ID.
    #[cfg(target_os = "linux")]
    let builder = match flatpak::app_id() {
        Some(id) => builder.dbus_id(id),
        None => builder,
    };
    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // Must be first so a second protocol launch is forwarded to this process.
        .plugin(single_instance())
        .plugin(tauri_plugin_deep_link::init());

    builder
        .on_menu_event(tray::handle_menu)
        .manage(desktop::DesktopState::default())
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
            pending_track_capsule: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect_server,
            change_connection,
            quit_desktop,
            desktop::desktop_handshake,
            desktop::desktop_snapshot,
            desktop::desktop_appearance,
            get_startup_profile,
            get_shell_theme,
            start_configured_engine,
            stop_engine,
            set_autostart,
            get_autostart,
            get_engine_status,
            get_selected_folder,
            preview_music_folder,
            log_shell_event,
            start_engine,
            start_engine_with_path,
            restart_engine,
            open_logs,
            open_player,
            open_pairing,
            pairing::pairing_create_session,
            pairing::pairing_list_sessions,
            pairing::pairing_display_close,
            pairing::pairing_cancel_session,
            pairing::pairing_list_devices,
            pairing::pairing_revoke_device,
            pairing::pairing_qr_data_url,
        ])
        .setup(|app| {
            if let Err(error) = tray::build_tray(app.handle()) {
                eprintln!("Desktop tray unavailable: {error}");
            }
            if let Some(window) = app.get_webview_window("main") {
                tray::attach_window_menu(app.handle(), &window)?;
            }
            #[cfg(target_os = "linux")]
            linux_media::start(app.handle().clone());
            if let Err(error) = tray::register_global_shortcuts(app.handle()) {
                eprintln!("Desktop shortcuts unavailable: {error}");
            }

            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&app_handle, url.as_str(), true);
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        // The shell's normal startup path will start the engine;
                        // only queue the capsule here to avoid a double restart.
                        handle_deep_link(app.handle(), url.as_str(), false);
                    }
                }
            }

            apply_window_appearance(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        if !tray::available(&app_handle) {
                            tray::shutdown(&app_handle);
                            return;
                        }
                        api.prevent_close();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    // Only matters while the stored preference is `system`;
                    // load_appearance decides that, so this just re-asks.
                    WindowEvent::ThemeChanged(_) => apply_window_appearance(&app_handle),
                    _ => {}
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                desktop::close_player(app);
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.engine.stop(None);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{player_url_for_capsule, scan_music_folder, track_capsule_from_deep_link};

    #[test]
    fn parses_only_bounded_track_links() {
        assert_eq!(
            track_capsule_from_deep_link("soundsible://track/abc_DEF-123"),
            Some("abc_DEF-123".into())
        );
        assert_eq!(track_capsule_from_deep_link("soundsible://album/abc"), None);
        assert_eq!(
            track_capsule_from_deep_link("https://example.com/track/abc"),
            None
        );
        assert_eq!(
            track_capsule_from_deep_link("soundsible://track/a%2Fb"),
            None
        );
    }

    #[test]
    fn puts_shared_identity_in_the_player_fragment() {
        assert_eq!(
            player_url_for_capsule("http://127.0.0.1:5000/player/desktop/", "abc_DEF-123"),
            Some("http://127.0.0.1:5000/player/desktop/#/search?shared=abc_DEF-123".into())
        );
    }

    #[test]
    fn scans_unicode_music_folders_without_following_links() {
        let root = std::env::temp_dir().join(format!("soundsible-música-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Álbum")).expect("create fixture directory");
        std::fs::write(root.join("Álbum").join("canción.mp3"), [0_u8; 32])
            .expect("write fixture track");
        std::fs::write(root.join("notes.txt"), [0_u8; 8]).expect("write ignored fixture");

        let preview = scan_music_folder(root.display().to_string()).expect("scan succeeds");
        assert_eq!(preview.track_count, 1);
        assert_eq!(preview.size_bytes, 32);
        assert_eq!(preview.inaccessible_entries, 0);
        assert!(preview.writable);

        std::fs::remove_dir_all(root).expect("remove fixture directory");
    }

    #[test]
    fn rejects_missing_music_folder() {
        let missing =
            std::env::temp_dir().join(format!("soundsible-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(scan_music_folder(missing.display().to_string()).is_err());
    }
}
