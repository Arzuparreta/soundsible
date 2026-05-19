use tauri::{AppHandle, Emitter, Manager};

fn idle_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-idle.png"))
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn restart_engine(app: &AppHandle) {
    if let Some(state) = app.try_state::<super::AppState>() {
        let _ = state.engine.restart(app.clone());
    }
}

pub fn stop_engine(app: &AppHandle) {
    if let Some(state) = app.try_state::<super::AppState>() {
        let _ = state.engine.stop(Some(app));
        if let Ok(mut skip) = state.skip_autostart_once.lock() {
            *skip = true;
        }
        let _ = super::return_to_shell(app);
    }
}

pub fn quit_app(app: &AppHandle) {
    shutdown(app);
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<super::AppState>() {
        let _ = state.engine.stop(Some(app));
    }
    app.exit(0);
}

pub fn open_pairing(app: &AppHandle) {
    if let Some(state) = app.try_state::<super::AppState>() {
        if state.engine.status().phase != super::engine::EnginePhase::Ready {
            focus_main_window(app);
            let _ = app.emit("shell-view", "pairing-unavailable");
            return;
        }
    }
    let _ = super::return_to_shell(app);
    let _ = app.emit("shell-view", "pairing");
    focus_main_window(app);
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    // Accelerators appear in the tray menu and work while the menu is open.
    let open_i = MenuItem::with_id(app, "tray_open", "Open", true, Some("Ctrl+Alt+O"))?;
    let restart_i = MenuItem::with_id(
        app,
        "tray_restart",
        "Restart engine",
        true,
        Some("Ctrl+Alt+R"),
    )?;
    let stop_i = MenuItem::with_id(
        app,
        "tray_stop",
        "Stop engine",
        true,
        Some("Ctrl+Alt+S"),
    )?;
    let pair_i = MenuItem::with_id(
        app,
        "tray_pair",
        "Pair phone…",
        true,
        Some("Ctrl+Alt+P"),
    )?;
    let quit_i = MenuItem::with_id(app, "tray_quit", "Quit", true, Some("Ctrl+Alt+Q"))?;
    let menu = Menu::with_items(app, &[&open_i, &pair_i, &restart_i, &stop_i, &quit_i])?;

    let icon = idle_tray_icon()?;

    let builder = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Soundsible (Beta) — Ctrl+Alt+O open")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_open" => focus_main_window(app),
            "tray_pair" => open_pairing(app),
            "tray_restart" => restart_engine(app),
            "tray_stop" => stop_engine(app),
            "tray_quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(false);

    builder.build(app)?;
    Ok(())
}

#[cfg(desktop)]
pub fn register_global_shortcuts(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["Ctrl+Alt+O", "Ctrl+Alt+P", "Ctrl+Alt+R", "Ctrl+Alt+S", "Ctrl+Alt+Q"])
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
