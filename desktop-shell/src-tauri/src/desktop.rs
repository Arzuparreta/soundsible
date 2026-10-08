//! The remote player may publish media state, never manage the local station.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct MediaState {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub rate: f64,
    pub volume: f64,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_seek: bool,
    pub shuffle: bool,
    pub seek_serial: u64,
    pub repeat: String,
    pub artwork: Option<String>,
}

impl MediaState {
    pub fn validate(&self) -> Result<(), String> {
        if [&self.track_id, &self.title, &self.artist, &self.album]
            .iter()
            .any(|s| s.len() > 4096)
            || [self.position, self.duration, self.rate, self.volume]
                .iter()
                .any(|v| !v.is_finite())
            || self.position < 0.0
            || self.duration < 0.0
            || !(0.0..=1.0).contains(&self.volume)
            || !(0.0..=4.0).contains(&self.rate)
            || self
                .artwork
                .as_ref()
                .is_some_and(|s| s.len() > 3 * 1024 * 1024)
        {
            return Err("Invalid desktop media state.".into());
        }
        Ok(())
    }
    pub fn status(&self) -> &'static str {
        if self.track_id.is_empty() {
            "Stopped"
        } else if self.playing {
            "Playing"
        } else {
            "Paused"
        }
    }
    pub fn track_path(&self) -> String {
        if self.track_id.is_empty() {
            return "/org/mpris/MediaPlayer2/TrackList/NoTrack".into();
        }
        let hex: String = self
            .track_id
            .as_bytes()
            .iter()
            .take(512)
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("/org/soundsible/track/t{hex}")
    }
}

pub struct Session {
    pub label: String,
    pub origin: String,
    pub generation: u64,
    pub ready: bool,
    pub updated: Instant,
    pub media: MediaState,
    pub art_path: Option<std::path::PathBuf>,
}

#[derive(Clone, Default)]
pub struct DesktopState {
    pub session: Arc<Mutex<Option<Session>>>,
    #[cfg(target_os = "linux")]
    pub native: crate::linux_media::Native,
}

pub fn validate_session(
    session: &Session,
    label: &str,
    origin: &str,
    generation: u64,
) -> Result<(), String> {
    if session.label != label || session.origin != origin || session.generation != generation {
        Err("Desktop connection is no longer active.".into())
    } else {
        Ok(())
    }
}

fn check<'a>(
    guard: &'a mut Option<Session>,
    window: &WebviewWindow,
    generation: u64,
) -> Result<&'a mut Session, String> {
    let s = guard.as_mut().ok_or("No active desktop connection.")?;
    let origin = window
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    validate_session(s, window.label(), &origin, generation)?;
    Ok(s)
}

#[derive(Serialize)]
pub struct Features {
    media: bool,
}

#[tauri::command]
pub fn desktop_handshake(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> Result<Features, String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let s = check(&mut guard, &window, generation)?;
    s.ready = true;
    s.updated = Instant::now();
    drop(guard);
    crate::tray::refresh_media_status(&window.app_handle());
    #[cfg(target_os = "linux")]
    let media = state.native.available();
    #[cfg(not(target_os = "linux"))]
    let media = false;
    Ok(Features { media })
}

#[tauri::command]
pub fn desktop_snapshot(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    mut state_value: MediaState,
) -> Result<(), String> {
    state_value.validate()?;
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let s = check(&mut guard, &window, generation)?;
    if !s.ready {
        return Err("Desktop bridge is not connected.".into());
    }
    if state_value.artwork != s.media.artwork {
        s.art_path = cache_artwork(generation, state_value.artwork.as_deref());
    }
    // No credentials or remote artwork URLs leave the WebView.
    if state_value.artwork.is_none() {
        s.art_path = None;
    }
    let previous = s.media.clone();
    s.media = std::mem::take(&mut state_value);
    s.updated = Instant::now();
    drop(guard);
    #[cfg(target_os = "linux")]
    state.native.update(app, previous);
    #[cfg(not(target_os = "linux"))]
    let _ = (app, previous);
    Ok(())
}

fn cache_artwork(generation: u64, data: Option<&str>) -> Option<std::path::PathBuf> {
    use base64::Engine;
    let (header, value) = data?.split_once(',')?;
    let extension = match header {
        "data:image/png;base64" => "png",
        "data:image/jpeg;base64" => "jpg",
        "data:image/webp;base64" => "webp",
        _ => return None,
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()?;
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?;
    let (w, h) = reader.into_dimensions().ok()?;
    if w > 2048 || h > 2048 {
        return None;
    }
    let dir = crate::state::config_dir().join("desktop-artwork");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!(
        "{generation}-{}.{}",
        GENERATION.fetch_add(1, Ordering::Relaxed),
        extension
    ));
    std::fs::write(&path, bytes).ok()?;
    // Bound the cache to the current cover.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for item in entries.flatten() {
            if item.path() != path {
                let _ = std::fs::remove_file(item.path());
            }
        }
    }
    Some(path)
}

#[tauri::command]
pub fn desktop_appearance(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    theme: String,
    colors: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    check(&mut guard, &window, generation)?;
    if theme.len() > 64
        || colors.len() > 32
        || colors
            .iter()
            .any(|(k, v)| k.len() > 64 || crate::parse_hex_color(v).is_none())
    {
        return Err("Invalid desktop appearance.".into());
    }
    let prefs = serde_json::json!({"theme": theme, "colors": colors});
    std::fs::create_dir_all(crate::state::config_dir()).map_err(|e| e.to_string())?;
    std::fs::write(
        crate::state::config_dir().join("desktop-appearance.json"),
        prefs.to_string(),
    )
    .map_err(|e| e.to_string())?;
    drop(guard);
    crate::apply_window_appearance(&app);
    Ok(())
}

pub fn dispatch(app: &AppHandle, action: serde_json::Value) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let guard = state.session.lock().map_err(|e| e.to_string())?;
    let s = guard
        .as_ref()
        .filter(|s| s.ready)
        .ok_or("This server has no desktop media bridge.")?;
    let script = format!(
        "window.__SOUNDSIBLE_DESKTOP__?.receive({}, {});",
        s.generation, action
    );
    let window = app
        .get_webview_window(&s.label)
        .ok_or("Player is closed.")?;
    window.eval(&script).map_err(|e| e.to_string())
}

pub fn close_player(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let session = state.session.lock().ok().and_then(|mut guard| guard.take());
    #[cfg(target_os = "linux")]
    let previous = session
        .as_ref()
        .map(|s| s.media.clone())
        .unwrap_or_default();
    // Release the session lock before dispatching native window destruction.
    // This also avoids a tail-expression borrow on non-Linux builds.
    if let Some(s) = session {
        if let Some(w) = app.get_webview_window(&s.label) {
            let _ = w.destroy();
        }
    }
    #[cfg(target_os = "linux")]
    state.native.update(app.clone(), previous);
}

pub fn open_player(app: &AppHandle, value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|e| e.to_string())?;
    let origin = url.origin().ascii_serialization();
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Invalid player address.".into());
    }
    // Reopening after pairing should preserve the running player and its queue.
    {
        let state = app.state::<DesktopState>();
        let guard = state.session.lock().map_err(|e| e.to_string())?;
        if let Some(s) = guard.as_ref().filter(|s| s.origin == origin) {
            if let Some(window) = app.get_webview_window(&s.label) {
                if url.fragment().is_some() {
                    window.navigate(url).map_err(|e| e.to_string())?;
                }
                window.show().map_err(|e| e.to_string())?;
                let _ = window.set_focus();
                if let Some(shell) = app.get_webview_window("main") {
                    let _ = shell.hide();
                }
                return Ok(());
            }
        }
    }
    close_player(app);
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("player-{generation}");
    let permission_url = format!("{origin}/player/*");
    app.add_capability(serde_json::json!({
        "identifier": label,
        "description": "Only the active player's media and appearance bridge",
        "local": false,
        "remote": { "urls": [permission_url] },
        "windows": [label],
        "permissions": ["allow-desktop-handshake", "allow-desktop-snapshot", "allow-desktop-appearance"],
    }).to_string()).map_err(|e| e.to_string())?;
    let script = include_str!("bridge-init.js")
        .replace("__ORIGIN__", &serde_json::to_string(&origin).unwrap())
        .replace("__GENERATION__", &generation.to_string());
    *app.state::<DesktopState>()
        .session
        .lock()
        .map_err(|e| e.to_string())? = Some(Session {
        label: label.clone(),
        origin: origin.clone(),
        generation,
        ready: false,
        updated: Instant::now(),
        media: MediaState::default(),
        art_path: None,
    });
    let navigation_origin = origin.clone();
    let nav_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url));
    // Tauri enables WebKit automation only for the first WebContext. Its
    // standard WebDriver environment therefore needs one shared context;
    // installed launches retain the per-origin cookie store below. The smoke
    // runner supplies disposable XDG directories for this automation context.
    if std::env::var("TAURI_WEBVIEW_AUTOMATION").as_deref() != Ok("true") {
        builder = builder.data_directory(
            crate::state::config_dir().join("desktop-webviews").join(
                origin
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>(),
            ),
        );
    }
    let window = builder
        .title("Soundsible")
        .inner_size(960.0, 640.0)
        .min_inner_size(640.0, 480.0)
        .initialization_script(script)
        .on_navigation(move |url| {
            if url.origin().ascii_serialization() == navigation_origin
                && url.path().starts_with("/player/")
            {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                use tauri_plugin_opener::OpenerExt;
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if crate::tray::available(&handle) {
                api.prevent_close();
                crate::tray::hide_player(&handle);
            } else {
                crate::tray::shutdown(&handle);
            }
        }
    });
    crate::tray::attach_window_menu(app, &window)?;
    if let Some(shell) = app.get_webview_window("main") {
        let _ = shell.hide();
    }
    crate::apply_window_appearance(app);
    // No handshake means an older server, not a failed connection.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        crate::tray::refresh_media_status(&handle);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_stale_or_cross_origin_publishers() {
        let s = Session {
            label: "player-1".into(),
            origin: "https://music.example".into(),
            generation: 1,
            ready: true,
            updated: Instant::now(),
            media: MediaState::default(),
            art_path: None,
        };
        assert!(validate_session(&s, "player-1", "https://music.example", 1).is_ok());
        assert!(validate_session(&s, "main", "https://music.example", 1).is_err());
        assert!(validate_session(&s, "player-1", "https://other.example", 1).is_err());
        assert!(validate_session(&s, "player-1", "https://music.example", 2).is_err());
    }
    #[test]
    fn validates_media_and_track_identifiers() {
        let mut media = MediaState {
            track_id: "../../private?token=secret".into(),
            volume: 0.5,
            rate: 1.0,
            ..Default::default()
        };
        assert!(media.validate().is_ok());
        assert!(!media.track_path().contains("private"));
        media.position = f64::NAN;
        assert!(media.validate().is_err());
        media.position = 0.0;
        media.volume = 2.0;
        assert!(media.validate().is_err());
    }
}
