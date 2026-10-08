use tauri::{AppHandle, Emitter, Manager};

fn idle_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-idle.png"))
}

pub fn available(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    if !app
        .state::<super::desktop::DesktopState>()
        .native
        .tray_available
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return false;
    }
    app.tray_by_id("soundsible").is_some()
}

pub fn hide_player(app: &AppHandle) {
    let state = app.state::<super::desktop::DesktopState>();
    if let Ok(guard) = state.session.lock() {
        if let Some(s) = guard.as_ref() {
            if let Some(window) = app.get_webview_window(&s.label) {
                let _ = window.hide();
            }
        }
    };
}

pub fn focus_main_window(app: &AppHandle) {
    let label = app
        .state::<super::desktop::DesktopState>()
        .session
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.label.clone()))
        .unwrap_or_else(|| "main".into());
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn restart_engine(app: &AppHandle) {
    if super::client::is_server() {
        return;
    }
    if let Some(state) = app.try_state::<super::AppState>() {
        super::desktop::close_player(app);
        let _ = state.engine.restart(app.clone());
    }
}

pub fn stop_engine(app: &AppHandle) {
    if super::client::is_server() {
        return;
    }
    if let Some(state) = app.try_state::<super::AppState>() {
        super::desktop::close_player(app);
        let _ = state.engine.stop(Some(app));
        if let Ok(mut skip) = state.skip_autostart_once.lock() {
            *skip = true;
        }
        let _ = super::return_to_shell(app);
        let _ = app.emit("shell-view", "local");
    }
}

pub fn quit_app(app: &AppHandle) {
    shutdown(app);
}
pub fn shutdown(app: &AppHandle) {
    super::desktop::close_player(app);
    if let Some(state) = app.try_state::<super::AppState>() {
        let _ = state.engine.stop(Some(app));
    }
    app.exit(0);
}

pub fn open_pairing(app: &AppHandle) {
    if super::client::is_server() {
        return;
    }
    if let Some(state) = app.try_state::<super::AppState>() {
        if state.engine.status().phase != super::engine::EnginePhase::Ready {
            let _ = super::return_to_shell(app);
            let _ = app.emit("shell-view", "pairing-unavailable");
            return;
        }
    }
    let _ = super::return_to_shell(app);
    let _ = app.emit("shell-view", "pairing");
}

#[cfg(target_os = "linux")]
fn media_status(app: &AppHandle) -> String {
    let state = app.state::<super::desktop::DesktopState>();
    let guard = state.session.lock().ok();
    if guard.as_ref().and_then(|g| g.as_ref()).is_none() {
        return "No player connection".into();
    }
    if guard
        .as_ref()
        .and_then(|g| g.as_ref())
        .is_some_and(|s| s.ready)
    {
        #[cfg(target_os = "linux")]
        if !state.native.available() {
            return "Desktop media controls unavailable".into();
        }
        "Desktop media controls connected".into()
    } else {
        "Native media controls need an updated server".into()
    }
}

#[cfg(not(target_os = "linux"))]
fn media_status(_app: &AppHandle) -> String {
    "Browser media controls".into()
}

fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let local = !super::client::is_server();
    let open = MenuItem::with_id(app, "tray_open", "Open", true, Some("Ctrl+Alt+O"))?;
    let change = MenuItem::with_id(app, "connection", "Change connection…", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "media_status", media_status(app), false, None::<&str>)?;
    let pair = MenuItem::with_id(app, "tray_pair", "Pair phone…", local, Some("Ctrl+Alt+P"))?;
    let restart = MenuItem::with_id(
        app,
        "tray_restart",
        "Restart engine",
        local,
        Some("Ctrl+Alt+R"),
    )?;
    let stop = MenuItem::with_id(app, "tray_stop", "Stop engine", local, Some("Ctrl+Alt+S"))?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, Some("Ctrl+Alt+Q"))?;
    Menu::with_items(
        app,
        &[&open, &change, &status, &pair, &restart, &stop, &quit],
    )
}

pub fn attach_window_menu(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_menu(menu(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn refresh_media_status(app: &AppHandle) {
    refresh_mode(app);
}
pub fn refresh_mode(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("soundsible") {
        if let Ok(menu) = menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    for window in app.webview_windows().into_values() {
        let _ = attach_window_menu(app, &window);
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let builder = TrayIconBuilder::with_id("soundsible")
        .icon(idle_tray_icon()?)
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .tooltip("Soundsible")
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                focus_main_window(tray.app_handle());
            }
        });
    #[cfg(target_os = "linux")]
    let builder = match crate::flatpak::tray_icon_dir() {
        Some(dir) => builder.temp_dir_path(dir),
        None => builder,
    };
    builder.build(app)?;
    Ok(())
}

pub fn handle_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "tray_open" => focus_main_window(app),
        "connection" => {
            let _ = super::change_connection(app.clone());
        }
        "tray_pair" => open_pairing(app),
        "tray_restart" => restart_engine(app),
        "tray_stop" => stop_engine(app),
        "tray_quit" => shutdown(app),
        _ => {}
    }
}

#[cfg(desktop)]
pub fn register_global_shortcuts(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts([
            "Ctrl+Alt+O",
            "Ctrl+Alt+P",
            "Ctrl+Alt+R",
            "Ctrl+Alt+S",
            "Ctrl+Alt+Q",
        ])
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?
        .with_handler(move |app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyO) {
                focus_main_window(app);
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyP) {
                open_pairing(app);
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyR) {
                restart_engine(app);
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyS) {
                stop_engine(app);
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyQ) {
                quit_app(app);
            }
        })
        .build();
    app.plugin(plugin)
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn register_global_shortcuts(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}
