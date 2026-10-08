//! Desktop connection preferences are independent of the station's configuration.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const PREFS_FILE: &str = "desktop-client.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    #[default]
    Choose,
    Local,
    Server,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Preferences {
    pub mode: ConnectionMode,
    pub server: Option<String>,
}

pub fn normalize_server(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() > 2048 {
        return Err("Server address is too long.".into());
    }
    let url =
        url::Url::parse(value).map_err(|_| "Enter an HTTP or HTTPS server address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an HTTP or HTTPS address without embedded credentials.".into());
    }
    if !matches!(
        url.path(),
        "" | "/" | "/player" | "/player/" | "/player/desktop" | "/player/desktop/"
    ) {
        return Err("Soundsible must be served at the domain root.".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn load_at(dir: &Path) -> Preferences {
    if let Ok(raw) = std::fs::read_to_string(dir.join(PREFS_FILE)) {
        if let Ok(mut prefs) = serde_json::from_str::<Preferences>(&raw) {
            prefs.server = prefs
                .server
                .as_deref()
                .and_then(|s| normalize_server(s).ok());
            if matches!(prefs.mode, ConnectionMode::Server) && prefs.server.is_none() {
                return Preferences::default();
            }
            return prefs;
        }
    }
    // Native and Docker stations also write config.json and music_dir.json.
    // Only the desktop engine creates this owner credential marker.
    if dir.join("desktop-owner-token").is_file() && dir.join("config.json").is_file() {
        return Preferences {
            mode: ConnectionMode::Local,
            server: None,
        };
    }
    Preferences::default()
}

pub fn load() -> Preferences {
    load_at(&crate::state::config_dir())
}
pub fn is_server() -> bool {
    matches!(load().mode, ConnectionMode::Server)
}
pub fn save(prefs: &Preferences) -> Result<(), String> {
    let dir = crate::state::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(prefs).map_err(|e| e.to_string())?;
    let tmp = dir.join("desktop-client.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(PREFS_FILE)).map_err(|e| e.to_string())
}

pub fn probe_server(origin: &str) -> Result<(), String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(8)))
        .max_redirects(0)
        .build();
    let response: serde_json::Value = ureq::Agent::new_with_config(config)
        .get(&format!("{origin}/api/health"))
        .call()
        .map_err(|_| {
            "Could not reach Soundsible. Check the address, connection and TLS certificate."
                .to_string()
        })?
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_json()
        .map_err(|_| "This address did not return a Soundsible health response.".to_string())?;
    if !matches!(
        response.get("status").and_then(|v| v.as_str()),
        Some("healthy" | "degraded")
    ) || !response.get("version").is_some_and(|v| v.is_string())
    {
        return Err("This address is not a Soundsible server.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_origins_and_known_player_entries() {
        assert_eq!(
            normalize_server(" http://localhost:5005/player/#/library ").unwrap(),
            "http://localhost:5005"
        );
        assert_eq!(
            normalize_server("https://music.example/player/desktop/").unwrap(),
            "https://music.example"
        );
        assert_eq!(
            normalize_server("http://[::1]:5005/").unwrap(),
            "http://[::1]:5005"
        );
        for url in [
            "file:///tmp/music",
            "https://u:p@example.com",
            "https://example.com/proxy/",
            "javascript:alert(1)",
            "localhost:5005",
        ] {
            assert!(normalize_server(url).is_err(), "{url}");
        }
    }
    #[test]
    fn a_station_config_is_not_a_desktop_installation() {
        let dir =
            std::env::temp_dir().join(format!("soundsible-client-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        assert!(matches!(load_at(&dir).mode, ConnectionMode::Choose));
        std::fs::write(dir.join("desktop-owner-token"), "test").unwrap();
        assert!(matches!(load_at(&dir).mode, ConnectionMode::Local));
        std::fs::write(
            dir.join(PREFS_FILE),
            r#"{"mode":"server","server":"http://localhost:5005"}"#,
        )
        .unwrap();
        assert!(matches!(load_at(&dir).mode, ConnectionMode::Server));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
