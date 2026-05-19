use crate::state::{
    load_runtime_state, python_executable, repo_root, sidecar_binary, EngineRuntimeState,
};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_HEALTH_FAILURES: u32 = 3;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnginePhase {
    Idle,
    Booting,
    Ready,
    Error,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineStatus {
    pub phase: EnginePhase,
    pub message: String,
    pub base_url: Option<String>,
    pub player_url: Option<String>,
    pub log_lines: Vec<String>,
}

pub struct EngineSupervisor {
    inner: Arc<Mutex<SupervisorInner>>,
    stop_flag: Arc<AtomicBool>,
}

struct SupervisorInner {
    child: Option<Child>,
    runtime: Option<EngineRuntimeState>,
    music_dir: Option<PathBuf>,
    log_lines: Vec<String>,
    phase: EnginePhase,
    message: String,
    health_failures: u32,
}

impl Default for SupervisorInner {
    fn default() -> Self {
        Self {
            child: None,
            runtime: None,
            music_dir: None,
            log_lines: Vec::new(),
            phase: EnginePhase::Idle,
            message: String::new(),
            health_failures: 0,
        }
    }
}

impl EngineSupervisor {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SupervisorInner::default())),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn status(&self) -> EngineStatus {
        let guard = self.inner.lock().expect("engine lock");
        EngineStatus {
            phase: guard.phase.clone(),
            message: guard.message.clone(),
            base_url: guard.runtime.as_ref().map(|r| r.base_url.clone()),
            player_url: guard.runtime.as_ref().map(|r| r.player_url()),
            log_lines: guard.log_lines.clone(),
        }
    }

    pub fn start(&self, app: AppHandle, music_dir: PathBuf) -> Result<(), String> {
        self.stop_flag.store(false, Ordering::SeqCst);
        bootstrap_config(&music_dir)?;
        self.stop_child()?;

        {
            let mut guard = self.inner.lock().expect("engine lock");
            guard.music_dir = Some(music_dir.clone());
            guard.phase = EnginePhase::Booting;
            guard.message = "Starting Soundsible…".into();
            guard.log_lines.clear();
            push_log(&mut guard, format!("engine: music_dir={}", music_dir.display()));
        }
        self.emit_status(&app);

        let child = spawn_engine(&music_dir, &mut self.inner.lock().expect("engine lock"))?;
        {
            let mut guard = self.inner.lock().expect("engine lock");
            guard.child = Some(child);
        }

        let inner = Arc::clone(&self.inner);
        let stop_flag = Arc::clone(&self.stop_flag);
        let app_handle = app.clone();
        thread::spawn(move || wait_for_ready(inner, stop_flag, app_handle));

        let inner = Arc::clone(&self.inner);
        let stop_flag = Arc::clone(&self.stop_flag);
        let app_handle = app.clone();
        thread::spawn(move || health_watchdog(inner, stop_flag, app_handle));

        Ok(())
    }

    pub fn restart(&self, app: AppHandle) -> Result<(), String> {
        let music_dir = {
            let guard = self.inner.lock().expect("engine lock");
            guard
                .music_dir
                .clone()
                .ok_or_else(|| "Choose a music folder first.".to_string())?
        };
        self.start(app, music_dir)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.stop_flag.store(true, Ordering::SeqCst);
        self.stop_child()
    }

    fn stop_child(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().expect("engine lock");
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.runtime = None;
        guard.health_failures = 0;
        Ok(())
    }

    fn emit_status(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit("engine-status", status);
    }
}

fn push_log(guard: &mut SupervisorInner, line: String) {
    guard.log_lines.push(line);
    if guard.log_lines.len() > 6 {
        let drain = guard.log_lines.len() - 6;
        guard.log_lines.drain(0..drain);
    }
}

fn bootstrap_config(music_dir: &PathBuf) -> Result<(), String> {
    let root = repo_root();
    let python = python_executable(&root);
    if !root.join("shared/desktop_bootstrap.py").exists() && !root.join("shared").join("desktop_bootstrap.py").exists() {
        return Err(format!("Missing shared/desktop_bootstrap.py under {}", root.display()));
    }
    let output = Command::new(&python)
        .current_dir(&root)
        .args(["-m", "shared.desktop_bootstrap"])
        .arg(music_dir)
        .output()
        .map_err(|e| format!("Failed to bootstrap config: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Config bootstrap failed: {stderr}"));
    }
    Ok(())
}

fn spawn_engine(music_dir: &PathBuf, guard: &mut SupervisorInner) -> Result<Child, String> {
    let root = repo_root();
    if let Some(sidecar) = sidecar_binary() {
        push_log(guard, format!("engine: spawning sidecar {}", sidecar.display()));
        return Command::new(sidecar)
            .arg("--music-dir")
            .arg(music_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"));
    }

    let python = python_executable(&root);
    let entry = root.join("soundsible_engine.py");
    if !entry.exists() {
        return Err(format!("Missing engine entry at {}", entry.display()));
    }
    push_log(
        guard,
        format!("engine: spawning {} {}", python.display(), entry.display()),
    );
    Command::new(&python)
        .current_dir(&root)
        .arg(&entry)
        .arg("--music-dir")
        .arg(music_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn engine: {e}"))
}

fn wait_for_ready(inner: Arc<Mutex<SupervisorInner>>, stop_flag: Arc<AtomicBool>, app: AppHandle) {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline && !stop_flag.load(Ordering::SeqCst) {
        if let Some(state) = load_runtime_state() {
            if health_check(&state.health_url()) {
                let player_url = state.player_url();
                {
                    let mut guard = inner.lock().expect("engine lock");
                    guard.runtime = Some(state);
                    guard.phase = EnginePhase::Ready;
                    guard.message = "Ready".into();
                    push_log(&mut guard, "engine: ready".into());
                }
                let _ = app.emit("engine-ready", player_url.clone());
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(parsed) = player_url.parse() {
                        let _ = window.navigate(parsed);
                    }
                }
                let supervisor = EngineSupervisor {
                    inner: Arc::clone(&inner),
                    stop_flag: Arc::clone(&stop_flag),
                };
                supervisor.emit_status(&app);
                return;
            }
        }
        thread::sleep(Duration::from_millis(250));
    }

    let mut guard = inner.lock().expect("engine lock");
    if guard.phase != EnginePhase::Ready {
        guard.phase = EnginePhase::Error;
        guard.message = "Couldn't start".into();
        push_log(
            &mut guard,
            "error: engine did not become ready within timeout".into(),
        );
    }
    drop(guard);
    let supervisor = EngineSupervisor {
        inner,
        stop_flag,
    };
    supervisor.emit_status(&app);
}

fn health_watchdog(inner: Arc<Mutex<SupervisorInner>>, stop_flag: Arc<AtomicBool>, app: AppHandle) {
    while !stop_flag.load(Ordering::SeqCst) {
        thread::sleep(HEALTH_INTERVAL);
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        let health_url = {
            let guard = inner.lock().expect("engine lock");
            if !matches!(guard.phase, EnginePhase::Ready) {
                continue;
            }
            guard.runtime.as_ref().map(|r| r.health_url())
        };

        let Some(url) = health_url else {
            continue;
        };

        let ok = health_check(&url);
        let mut restart_needed = false;
        {
            let mut guard = inner.lock().expect("engine lock");
            if ok {
                guard.health_failures = 0;
            } else {
                guard.health_failures += 1;
                push_log(
                    &mut guard,
                    format!(
                        "error: health check failed ({}/{})",
                        guard.health_failures, MAX_HEALTH_FAILURES
                    ),
                );
                if guard.health_failures >= MAX_HEALTH_FAILURES {
                    guard.phase = EnginePhase::Error;
                    guard.message = "Couldn't start".into();
                    restart_needed = true;
                }
            }
        }

        let supervisor = EngineSupervisor {
            inner: Arc::clone(&inner),
            stop_flag: Arc::clone(&stop_flag),
        };
        supervisor.emit_status(&app);

        if restart_needed {
            let music_dir = {
                let guard = inner.lock().expect("engine lock");
                guard.music_dir.clone()
            };
            if let Some(dir) = music_dir {
                let _ = supervisor.stop();
                stop_flag.store(false, Ordering::SeqCst);
                let _ = supervisor.start(app.clone(), dir);
            }
            break;
        }
    }
}

fn health_check(url: &str) -> bool {
    match ureq::get(url).timeout(HEALTH_TIMEOUT).call() {
        Ok(resp) => resp.status() == 200,
        Err(_) => false,
    }
}
