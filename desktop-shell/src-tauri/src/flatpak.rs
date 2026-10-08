//! What changes when the desktop runs inside a Flatpak sandbox.
//!
//! Login autostart: tauri-plugin-autostart writes
//! `~/.config/autostart/Soundsible.desktop` pointing at its own executable. In
//! a Flatpak both halves are wrong: that directory is the sandbox's private
//! copy, which the session never reads, and the executable is
//! `/app/bin/soundsible-desktop`, which only exists inside the sandbox. The
//! Background portal writes the entry on the host instead, with a
//! `flatpak run` command line, once the desktop has agreed to it. The portal
//! can be asked but not queried, so its last answer is remembered next to the
//! rest of the desktop's preferences.
//!
//! Tray icon: the StatusNotifier host loads the icon by path, from outside the
//! sandbox, and the only runtime directory both sides can see is the app's own.
//!
//! Bus names: Flatpak lets an app own names under its own ID, plus the ones its
//! manifest lists. Flathub refuses a manifest that lists one it does not need.

use futures_lite::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const AUTOSTART_PREFERENCE: &str = "flatpak-autostart";

static REQUESTS: AtomicU32 = AtomicU32::new(0);

pub fn sandboxed() -> bool {
    Path::new("/.flatpak-info").is_file()
}

/// The Flatpak ID, when running inside one.
pub fn app_id() -> Option<String> {
    if !sandboxed() {
        return None;
    }
    std::env::var("FLATPAK_ID").ok().filter(|id| !id.is_empty())
}

pub fn tray_icon_dir() -> Option<PathBuf> {
    Some(
        dirs::runtime_dir()?
            .join("app")
            .join(app_id()?)
            .join("tray-icon"),
    )
}

fn autostart_preference() -> PathBuf {
    crate::state::config_dir().join(AUTOSTART_PREFERENCE)
}

pub fn autostart_enabled() -> bool {
    autostart_preference().is_file()
}

pub async fn set_autostart(enabled: bool) -> Result<(), String> {
    let applied = request_background(enabled)
        .await
        .map_err(|error| format!("Background portal unavailable: {error}"))?;
    if !applied {
        return Err("The desktop declined to change Soundsible's login autostart.".into());
    }
    let path = autostart_preference();
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, b"").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }
}

/// Whether the portal applied what was asked. A refusal is an answer, not an
/// error; only an unreachable portal is.
async fn request_background(autostart: bool) -> zbus::Result<bool> {
    let connection = Connection::session().await?;
    let token = format!(
        "soundsible_{}_{}",
        std::process::id(),
        REQUESTS.fetch_add(1, Ordering::Relaxed)
    );
    let sender = connection
        .unique_name()
        .map(|name| name.trim_start_matches(':').replace('.', "_"))
        .ok_or_else(|| zbus::Error::Failure("session bus gave no unique name".into()))?;
    // Subscribe before asking: the response can arrive before the call returns.
    let request = zbus::Proxy::new(
        &connection,
        PORTAL,
        format!("{PORTAL_PATH}/request/{sender}/{token}"),
        "org.freedesktop.portal.Request",
    )
    .await?;
    let mut responses = request.receive_signal("Response").await?;
    let options: HashMap<&str, Value<'_>> = HashMap::from([
        ("handle_token", Value::from(token.as_str())),
        ("reason", Value::from("Start Soundsible when you log in")),
        ("autostart", Value::from(autostart)),
        ("commandline", Value::from(vec!["soundsible-desktop"])),
    ]);
    let portal = zbus::Proxy::new(
        &connection,
        PORTAL,
        PORTAL_PATH,
        "org.freedesktop.portal.Background",
    )
    .await?;
    let _: OwnedObjectPath = portal.call("RequestBackground", &("", options)).await?;
    let message = responses
        .next()
        .await
        .ok_or_else(|| zbus::Error::Failure("portal closed the request".into()))?;
    let (response, results): (u32, HashMap<String, OwnedValue>) = message.body().deserialize()?;
    Ok(applied(response, &results, autostart))
}

fn applied(response: u32, results: &HashMap<String, OwnedValue>, asked: bool) -> bool {
    response == 0
        && results
            .get("autostart")
            .and_then(|value| bool::try_from(value).ok())
            == Some(asked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn results(autostart: bool) -> HashMap<String, OwnedValue> {
        HashMap::from([("autostart".to_string(), OwnedValue::from(autostart))])
    }

    #[test]
    fn only_an_accepted_matching_answer_counts() {
        assert!(applied(0, &results(true), true));
        assert!(applied(0, &results(false), false));
        // The user dismissed the dialog, or the desktop kept the old setting.
        assert!(!applied(1, &results(true), true));
        assert!(!applied(0, &results(false), true));
        assert!(!applied(0, &HashMap::new(), true));
    }
}
