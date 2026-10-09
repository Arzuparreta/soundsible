// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK 2.54 composites with Skia, and that compositor presents a stale
    // frame as a CSS animation ends: opening Now Playing flashed the screen as
    // it was when the slide began. WebKit's previous compositor keeps hardware
    // acceleration and does not. Set before WebKit starts, so its web processes
    // inherit it; older WebKitGTK ignores it, and a value the user set wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_USE_SKIA_FOR_COMPOSITION").is_none() {
        std::env::set_var("WEBKIT_USE_SKIA_FOR_COMPOSITION", "0");
    }
    soundsible_desktop_lib::run()
}
