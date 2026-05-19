use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const STATE_FILENAME: &str = "desktop-engine-state.json";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EngineRuntimeState {
    pub mode: String,
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub health: String,
    pub version: String,
    pub owner_token_file: Option<String>,
    pub config_dir: String,
    pub log_dir: String,
    pub music_dir: String,
}

impl EngineRuntimeState {
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

#[derive(Debug, Clone, Serialize)]
pub struct StartupProfile {
    pub returning_user: bool,
    pub music_dir: Option<String>,
    pub auto_start: bool,
}

pub fn startup_profile(skip_autostart: bool) -> StartupProfile {
    let music_dir = load_persisted_music_dir().map(|p| p.display().to_string());
    let returning_user = has_consumer_config() && music_dir.is_some();
    StartupProfile {
        returning_user,
        music_dir,
        auto_start: returning_user && !skip_autostart,
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
