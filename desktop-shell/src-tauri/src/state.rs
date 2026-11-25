use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const STATE_FILENAME: &str = "desktop-engine-state.json";

// The engine writes more than this (pid, version, other directories); serde
// skips what the shell never reads.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EngineRuntimeState {
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub launch_id: String,
    pub base_url: String,
    pub health: String,
    pub owner_token_file: Option<String>,
    pub log_dir: String,
}

impl EngineRuntimeState {
    pub fn belongs_to(&self, launch_id: &str, engine_pid: Option<u32>) -> bool {
        !launch_id.is_empty()
            && self.launch_id == launch_id
            && self.pid != 0
            && engine_pid == Some(self.pid)
    }

    pub fn health_url(&self) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), self.health)
    }

    pub fn player_url(&self) -> String {
        format!("{}/player/desktop/", self.base_url.trim_end_matches('/'))
    }
}

pub fn config_dir() -> PathBuf {
    std::env::var("SOUNDSIBLE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("soundsible")
        })
}

pub fn state_file_path() -> PathBuf {
    config_dir().join(STATE_FILENAME)
}

pub fn load_runtime_state() -> Option<EngineRuntimeState> {
    let path = state_file_path();
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod readiness_tests {
    use super::*;

    #[test]
    fn readiness_requires_the_owned_launch_and_reported_python_pid() {
        let raw = r#"{"pid":42,"launch_id":"own-launch","base_url":"http://127.0.0.1:49152","health":"/api/health","log_dir":"logs"}"#;
        let state: EngineRuntimeState = serde_json::from_str(raw).unwrap();
        assert!(state.belongs_to("own-launch", Some(42)));
        assert!(!state.belongs_to("own-launch", Some(43)));
        assert!(!state.belongs_to("another-launch", Some(42)));
        assert!(!state.belongs_to("own-launch", None));
        let missing_pid = raw.replace("\"pid\":42,", "");
        let old: EngineRuntimeState = serde_json::from_str(&missing_pid).unwrap();
        assert!(!old.belongs_to("own-launch", Some(42)));
    }
}

pub fn read_owner_token() -> Result<String, String> {
    let runtime = load_runtime_state().ok_or_else(|| "Engine is not running.".to_string())?;
    let token_path = runtime
        .owner_token_file
        .as_ref()
        .ok_or_else(|| "Owner token file is missing.".to_string())?;
    let token = std::fs::read_to_string(token_path)
        .map_err(|e| format!("Could not read owner token: {e}"))?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("Owner token is empty.".into());
    }
    Ok(token)
}

pub fn has_consumer_config() -> bool {
    config_dir().join("config.json").is_file()
}

#[derive(Debug, Deserialize)]
struct MusicDirPrefs {
    path: Option<String>,
    music_dir: Option<String>,
}

pub fn load_persisted_music_dir() -> Option<PathBuf> {
    let prefs_path = config_dir().join("music_dir.json");
    let raw = std::fs::read_to_string(prefs_path).ok()?;
    let data: MusicDirPrefs = serde_json::from_str(&raw).ok()?;
    data.path
        .or(data.music_dir)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

/// What the player last chose, written by the engine into the shared config
/// directory. The shell and the player live in
/// different origins, so this file is the only channel between them — and the
/// only one that is readable before the engine is even running, which is
/// exactly when the shell is on screen alone.
///
/// Custom colors arrive as resolved semantic tokens so the native window and
/// the shell match the player even before an engine connection is available.
#[derive(Debug, Clone, Deserialize)]
struct AppearancePrefs {
    theme: Option<String>,
    #[serde(default)]
    colors: HashMap<String, String>,
}

/// A palette resolved for painting: the name to stamp on `<html>`, and the
/// window background that stops the webview flashing white behind it.
#[derive(Debug, Clone, Serialize)]
pub struct Appearance {
    pub theme: String,
    pub color: Option<String>,
    pub colors: HashMap<String, String>,
}

pub const APPEARANCE_FILENAME: &str = "desktop-appearance.json";

/// Resolve the stored preference against the OS, the way the player's pre-paint
/// script does. `system` — and an absent, unreadable or unknown file — follow
/// the desktop; anything else is the listener overriding it.
pub fn resolve_appearance(raw: Option<&str>, os_prefers_dark: bool) -> Appearance {
    let fallback = if os_prefers_dark { "dark" } else { "light" };
    let prefs = raw.and_then(|raw| serde_json::from_str::<AppearancePrefs>(raw).ok());

    let mut appearance = Appearance {
        theme: fallback.to_string(),
        color: None,
        colors: HashMap::new(),
    };
    let Some(prefs) = prefs else {
        return appearance;
    };

    let custom = ["light", "dark"].iter().find_map(|&scheme| {
        let color = prefs.colors.get(&format!("custom-{scheme}"))?;
        (crate::parse_hex_color(color).is_some()).then_some((scheme, color))
    });
    match (prefs.theme.as_deref(), custom) {
        (Some("custom"), Some((scheme, color))) => {
            appearance.theme = scheme.to_string();
            appearance.color = Some(color.clone());
            appearance.colors = prefs
                .colors
                .into_iter()
                .filter(|(_, color)| crate::parse_hex_color(color).is_some())
                .collect();
        }
        (mode, _) => {
            let theme = match mode {
                Some("light") => "light",
                Some("dark") => "dark",
                _ => fallback,
            };
            appearance.theme = theme.to_string();
            appearance.color = prefs
                .colors
                .get(theme)
                .filter(|color| crate::parse_hex_color(color).is_some())
                .cloned();
        }
    }
    appearance
}

pub fn load_appearance(os_prefers_dark: bool) -> Appearance {
    let raw = std::fs::read_to_string(config_dir().join(APPEARANCE_FILENAME)).ok();
    resolve_appearance(raw.as_deref(), os_prefers_dark)
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupProfile {
    pub mode: String,
    pub server: Option<String>,
    pub returning_user: bool,
    pub music_dir: Option<String>,
    pub auto_start: bool,
    pub configured_but_missing: bool,
}

pub fn startup_profile(skip_autostart: bool) -> StartupProfile {
    let music_dir = load_persisted_music_dir().map(|p| p.display().to_string());
    let returning_user = has_consumer_config() && music_dir.is_some();
    let has_saved_path = config_dir().join("music_dir.json").is_file();
    StartupProfile {
        mode: "choose".into(),
        server: None,
        returning_user,
        music_dir,
        auto_start: returning_user && !skip_autostart,
        configured_but_missing: has_consumer_config() && has_saved_path && !returning_user,
    }
}

pub fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("SOUNDSIBLE_REPO_ROOT") {
        return PathBuf::from(root);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

pub fn python_executable(repo_root: &Path) -> PathBuf {
    if let Ok(bin) = std::env::var("SOUNDSIBLE_PYTHON") {
        return PathBuf::from(bin);
    }
    #[cfg(windows)]
    {
        let venv = repo_root.join("venv/Scripts/python.exe");
        if venv.exists() {
            return venv;
        }
    }
    #[cfg(not(windows))]
    {
        let venv = repo_root.join("venv/bin/python3");
        if venv.exists() {
            return venv;
        }
        let venv_py = repo_root.join("venv/bin/python");
        if venv_py.exists() {
            return venv_py;
        }
    }
    PathBuf::from("python3")
}

pub fn sidecar_binary() -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("SOUNDSIBLE_ENGINE_BIN") {
        let path = PathBuf::from(bin);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(windows)]
            let bundled = dir.join("soundsible-engine.exe");
            #[cfg(not(windows))]
            let bundled = dir.join("soundsible-engine");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binaries_dir = manifest.join("binaries");
    if binaries_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(binaries_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("soundsible-engine") {
                    return Some(path);
                }
            }
        }
    }

    let legacy = manifest.join("resources/soundsible-engine");
    legacy.is_file().then_some(legacy)
}

#[cfg(test)]
mod tests {
    use super::resolve_appearance;

    // r##..##: the colours contain `"#`, which closes a single-hash raw string.
    const TABLE: &str = r##"{"light":"#f6f6f7","dark":"#0c0c0e","custom-light":"#ffeeee","bg-base":"#ffeeee","accent":"#003333","forest-green":"#0b110d"}"##;

    fn stored(theme: &str) -> String {
        format!(r#"{{"theme":"{theme}","colors":{TABLE}}}"#)
    }

    #[test]
    fn paints_the_palette_the_player_chose() {
        let appearance = resolve_appearance(Some(&stored("custom")), true);
        assert_eq!(appearance.theme, "light");
        assert_eq!(appearance.color.as_deref(), Some("#ffeeee"));
        assert_eq!(appearance.colors["accent"], "#003333");
    }

    #[test]
    fn an_explicit_palette_ignores_the_desktop() {
        for os_prefers_dark in [true, false] {
            assert_eq!(
                resolve_appearance(Some(&stored("custom")), os_prefers_dark).theme,
                "light"
            );
        }
    }

    #[test]
    fn system_follows_the_desktop() {
        assert_eq!(
            resolve_appearance(Some(&stored("system")), true).theme,
            "dark"
        );
        assert_eq!(
            resolve_appearance(Some(&stored("system")), false).theme,
            "light"
        );
    }

    #[test]
    fn falls_back_before_the_player_has_ever_run() {
        // No file on a first launch, and no reason to fail over it.
        assert_eq!(resolve_appearance(None, true).theme, "dark");
        assert_eq!(resolve_appearance(None, false).theme, "light");
        assert_eq!(resolve_appearance(Some("{ not json"), false).theme, "light");
    }

    #[test]
    fn refuses_a_palette_it_was_given_no_colour_for() {
        let orphan = r##"{"theme":"custom","colors":{"dark":"#0c0c0e"}}"##;
        assert_eq!(resolve_appearance(Some(orphan), true).theme, "dark");
        let retired = resolve_appearance(Some(&stored("forest-green")), false);
        assert_eq!(retired.theme, "light");
        assert!(retired.colors.is_empty());
    }
}
