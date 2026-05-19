use serde::Deserialize;
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
    std::env::var("SOUNDSIBLE_ENGINE_BIN")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/soundsible-engine");
            candidate.exists().then_some(candidate)
        })
}
