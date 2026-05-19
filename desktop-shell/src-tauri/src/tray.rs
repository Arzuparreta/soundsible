use tauri::{AppHandle, Manager};

fn idle_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-idle.png"))
        .map_err(|e| tauri::Error::FailedMessage(format!("tray icon: {e}")))
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

pub fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<super::AppState>() {
        let _ = state.engine.stop();
    }
    app.exit(0);
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
    let quit_i = MenuItem::with_id(app, "tray_quit", "Quit", true, Some("Ctrl+Alt+Q"))?;
    let menu = Menu::with_items(app, &[&open_i, &restart_i, &quit_i])?;

    let icon = idle_tray_icon()?;

    let builder = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Soundsible (Beta) — Ctrl+Alt+O open")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_open" => focus_main_window(app),
            "tray_restart" => restart_engine(app),
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

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["Ctrl+Alt+O", "Ctrl+Alt+R", "Ctrl+Alt+Q"])?
            .with_handler(move |app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyO) {
                    focus_main_window(app);
                } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyR) {
                    restart_engine(app);
                } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyQ) {
                    quit_app(app);
                }
            })
            .build(),
    )?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn register_global_shortcuts(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}
