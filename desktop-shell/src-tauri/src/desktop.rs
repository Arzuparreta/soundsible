//! The remote player may set the window's appearance, never manage the local station.
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[derive(Clone)]
pub struct Session {
    pub label: String,
    pub origin: String,
    pub generation: u64,
}

#[derive(Clone, Default)]
pub struct DesktopState {
    pub session: Arc<Mutex<Option<Session>>>,
    intent: Arc<crate::lifecycle::Generation>,
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
    label: &str,
    origin: &str,
    generation: u64,
) -> Result<&'a mut Session, String> {
    let s = guard.as_mut().ok_or("No active desktop connection.")?;
    validate_session(s, label, origin, generation)?;
    Ok(s)
}

/// What the shell offers the player. Native media controls existed only in the
/// Linux app, which is gone; players of every version still ask, and are told
/// to keep the browser's Media Session.
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
    let origin = window
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    check(&mut guard, window.label(), &origin, generation)?;
    Ok(Features { media: false })
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
    let origin = window
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    check(&mut guard, window.label(), &origin, generation)?;
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

pub fn close_player(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let generation = state.intent.advance();
    let session = state.session.lock().ok().and_then(|mut guard| {
        if state.intent.is_current(generation) {
            guard.take()
        } else {
            None
        }
    });
    // Release the session lock before dispatching native window destruction.
    if let Some(s) = session {
        if let Some(w) = app.get_webview_window(&s.label) {
            let _ = w.destroy();
        }
    }
}

fn discard_unowned_window(app: &AppHandle, window: &WebviewWindow) {
    let state = app.state::<DesktopState>();
    let active = state.session.lock().ok().and_then(|guard| guard.clone());
    // A reentrant open of the same origin may have adopted this window. Never
    // destroy a window that the newer intent still owns.
    if active
        .as_ref()
        .is_some_and(|session| session.label == window.label())
    {
        return;
    }
    let _ = window.destroy();
}

fn discard_cancelled_window(app: &AppHandle, window: &WebviewWindow) {
    discard_unowned_window(app, window);
    let state = app.state::<DesktopState>();
    let no_player = state.session.lock().is_ok_and(|guard| guard.is_none());
    if no_player {
        if let Some(shell) = app.get_webview_window("main") {
            let _ = shell.show();
        }
    }
}

fn native_step(
    app: &AppHandle,
    intent: &crate::lifecycle::Generation,
    generation: u64,
    window: &WebviewWindow,
    effect: impl FnOnce() -> tauri::Result<()>,
) -> Result<bool, String> {
    if !intent.is_current(generation) {
        discard_cancelled_window(app, window);
        return Ok(false);
    }
    let result = effect();
    if !intent.is_current(generation) {
        discard_cancelled_window(app, window);
        return Ok(false);
    }
    result.map_err(|e| e.to_string())?;
    Ok(true)
}

fn reveal_player(app: &AppHandle, generation: u64, window: &WebviewWindow) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if !native_step(app, &state.intent, generation, window, || window.show())? {
        return Ok(());
    }
    if !native_step(app, &state.intent, generation, window, || {
        window.set_focus()
    })? {
        return Ok(());
    }
    if let Some(shell) = app.get_webview_window("main") {
        native_step(app, &state.intent, generation, window, || shell.hide())?;
    }
    Ok(())
}

fn recover_failed_open(
    state: &DesktopState,
    generation: u64,
    discard: impl FnOnce(Option<Session>),
    show: impl FnOnce(),
    focus: impl FnOnce(),
) {
    let (recovery, failed) = {
        let Ok(mut guard) = state.session.lock() else {
            return;
        };
        if !state.intent.is_current(generation) {
            return;
        }
        (state.intent.advance(), guard.take())
    };
    discard(failed);
    // A failed builder may never have registered a window. Recovery must still
    // reveal Retry, without holding a mutex across reentrant native calls.
    let current = || {
        state.intent.is_current(recovery) && state.session.lock().is_ok_and(|guard| guard.is_none())
    };
    if current() {
        show();
        if current() {
            focus();
        }
    }
}

fn cleanup_failed_open(app: &AppHandle, generation: u64) {
    recover_failed_open(
        &app.state::<DesktopState>(),
        generation,
        |failed| {
            if let Some(window) = failed.and_then(|session| app.get_webview_window(&session.label))
            {
                discard_unowned_window(app, &window);
            }
        },
        || {
            if let Some(shell) = app.get_webview_window("main") {
                let _ = shell.show();
            }
        },
        || {
            if let Some(shell) = app.get_webview_window("main") {
                let _ = shell.set_focus();
            }
        },
    );
}

pub fn open_player(app: &AppHandle, value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Invalid player address.".into());
    }
    let generation = app.state::<DesktopState>().intent.advance();
    let result = open_player_at(app, url, generation);
    if result.is_err() {
        cleanup_failed_open(app, generation);
    }
    result
}

fn open_player_at(app: &AppHandle, url: url::Url, generation: u64) -> Result<(), String> {
    let origin = url.origin().ascii_serialization();
    let state = app.state::<DesktopState>();
    // Snapshot under the mutex, then release it before any native operation.
    let previous = state.session.lock().map_err(|e| e.to_string())?.clone();
    if let Some(session) = previous.as_ref().filter(|session| session.origin == origin) {
        if let Some(window) = app.get_webview_window(&session.label) {
            if url.fragment().is_some()
                && !native_step(app, &state.intent, generation, &window, || {
                    window.navigate(url.clone())
                })?
            {
                return Ok(());
            }
            return reveal_player(app, generation, &window);
        }
    }
    let old = {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        if !state.intent.is_current(generation) {
            return Ok(());
        }
        guard.take()
    };
    if let Some(session) = old {
        if let Some(window) = app.get_webview_window(&session.label) {
            let _ = window.destroy();
        }
    }
    if !state.intent.is_current(generation) {
        return Ok(());
    }
    let label = format!("player-{generation}");
    let permission_url = format!("{origin}/player/*");
    app.add_capability(
        serde_json::json!({
            "identifier": label,
            "description": "Only the active player's appearance bridge",
            "local": false,
            "remote": { "urls": [permission_url] },
            "windows": [label],
            "permissions": ["allow-desktop-handshake", "allow-desktop-appearance"],
        })
        .to_string(),
    )
    .map_err(|e| e.to_string())?;
    let script = include_str!("bridge-init.js")
        .replace("__ORIGIN__", &serde_json::to_string(&origin).unwrap())
        .replace("__GENERATION__", &generation.to_string());
    {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        if !state.intent.is_current(generation) {
            return Ok(());
        }
        *guard = Some(Session {
            label: label.clone(),
            origin: origin.clone(),
            generation,
        });
    }
    let navigation_origin = origin.clone();
    let nav_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url));
    // Under WebDriver automation the webview keeps one shared context;
    // installed launches retain the per-origin cookie store below.
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
    let window = state
        .intent
        .construct(
            generation,
            || {
                builder
                    .visible(false)
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
            },
            |window| discard_cancelled_window(app, window),
        )
        .map_err(|e| e.to_string())?;
    let Some(window) = window else {
        return Ok(());
    };
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
    if !state.intent.is_current(generation) {
        discard_cancelled_window(app, &window);
        return Ok(());
    }
    crate::apply_window_appearance(app);
    reveal_player(app, generation, &window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed_restart() -> (DesktopState, u64) {
        let state = DesktopState::default();
        let generation = state.intent.advance();
        *state.session.lock().unwrap() = Some(Session {
            label: "replacement-not-created".into(),
            origin: "http://localhost".into(),
            generation,
        });
        (state, generation)
    }

    #[test]
    fn failed_restart_reveals_and_focuses_retry_without_a_player_window() {
        let (state, generation) = failed_restart();
        let visible = std::cell::Cell::new(false);
        let focused = std::cell::Cell::new(false);
        recover_failed_open(
            &state,
            generation,
            |failed| {
                assert!(failed.is_some()); // The builder never created its window.
                assert!(state.session.try_lock().unwrap().is_none());
            },
            || visible.set(true),
            || {
                assert!(visible.get());
                assert!(state.session.try_lock().unwrap().is_none());
                focused.set(true);
            },
        );
        assert!(visible.get());
        assert!(focused.get());
    }

    #[test]
    fn failure_before_session_registration_also_reveals_retry() {
        let state = DesktopState::default();
        let generation = state.intent.advance();
        let focused = std::cell::Cell::new(false);
        recover_failed_open(
            &state,
            generation,
            |failed| assert!(failed.is_none()),
            || {},
            || focused.set(true),
        );
        assert!(focused.get());
    }

    #[test]
    fn superseded_failure_leaves_the_new_session_and_shell_alone() {
        let (state, generation) = failed_restart();
        state.intent.advance();
        recover_failed_open(
            &state,
            generation,
            |_| panic!("discarded a newer session"),
            || panic!("showed the obsolete shell"),
            || panic!("focused the obsolete shell"),
        );
        assert!(state.session.lock().unwrap().is_some());
    }

    #[test]
    fn native_reentry_during_cleanup_or_show_cancels_remaining_recovery() {
        for cancel_during_cleanup in [true, false] {
            let (state, generation) = failed_restart();
            let shown = std::cell::Cell::new(false);
            recover_failed_open(
                &state,
                generation,
                |_| {
                    if cancel_during_cleanup {
                        state.intent.advance();
                    }
                },
                || {
                    assert!(state.session.try_lock().unwrap().is_none());
                    shown.set(true);
                    state.intent.advance();
                },
                || panic!("stole focus after a newer intent"),
            );
            assert_eq!(shown.get(), !cancel_during_cleanup);
        }
    }

    #[test]
    fn rejects_stale_or_cross_origin_publishers() {
        let s = Session {
            label: "player-1".into(),
            origin: "https://music.example".into(),
            generation: 1,
        };
        assert!(validate_session(&s, "player-1", "https://music.example", 1).is_ok());
        assert!(validate_session(&s, "main", "https://music.example", 1).is_err());
        assert!(validate_session(&s, "player-1", "https://other.example", 1).is_err());
        assert!(validate_session(&s, "player-1", "https://music.example", 2).is_err());
    }
}
