use crate::startup::{output_lines, ready_engine_pid, startup_budget, tools_wait_event};
use crate::state::{
    load_runtime_state, python_executable, repo_root, sidecar_binary, state_file_path,
    EngineRuntimeState,
};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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
    waiting_for_tools: bool,
    generation: u64,
    launch_id: String,
    engine_pid: Option<u32>,
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
            waiting_for_tools: false,
            generation: 0,
            launch_id: String::new(),
            engine_pid: None,
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
        status_snapshot(&guard)
    }

    pub fn start(&self, app: AppHandle, music_dir: PathBuf) -> Result<(), String> {
        crate::client::cancel_pending_connections();
        self.start_if_current(app, music_dir, None)
    }

    fn start_if_current(
        &self,
        app: AppHandle,
        music_dir: PathBuf,
        expected: Option<u64>,
    ) -> Result<(), String> {
        let generation = {
            let mut guard = self.inner.lock().expect("engine lock");
            if expected.is_some_and(|generation| generation != guard.generation) {
                return Ok(());
            }
            stop_child(&mut guard);
            self.stop_flag.store(false, Ordering::SeqCst);
            guard.launch_id = uuid::Uuid::new_v4().to_string();
            guard.music_dir = Some(music_dir.clone());
            guard.phase = EnginePhase::Booting;
            guard.message = "Starting Soundsible…".into();
            guard.log_lines.clear();
            push_log(
                &mut guard,
                format!("engine: music_dir={}", music_dir.display()),
            );
            guard.generation
        };
        self.emit_status(&app);
        if let Err(error) = bootstrap_config(&music_dir) {
            let mut guard = self.inner.lock().expect("engine lock");
            if guard.generation == generation && guard.phase == EnginePhase::Booting {
                guard.phase = EnginePhase::Error;
                guard.message = "Couldn't start".into();
                push_log(&mut guard, error.clone());
            }
            return Err(error);
        }
        let (pid, stdout, stderr) = {
            let mut guard = self.inner.lock().expect("engine lock");
            if guard.generation != generation || self.stop_flag.load(Ordering::SeqCst) {
                return Ok(());
            }
            let mut child = match spawn_engine(&music_dir, &mut guard) {
                Ok(child) => child,
                Err(error) => {
                    guard.phase = EnginePhase::Error;
                    guard.message = "Couldn't start".into();
                    push_log(&mut guard, error.clone());
                    return Err(error);
                }
            };
            let pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            guard.child = Some(child);
            (pid, stdout, stderr)
        };
        self.emit_status(&app);
        if let Some(stdout) = stdout {
            read_engine_output(
                Arc::clone(&self.inner),
                app.clone(),
                generation,
                pid,
                stdout,
                true,
            );
        }
        if let Some(stderr) = stderr {
            read_engine_output(
                Arc::clone(&self.inner),
                app.clone(),
                generation,
                pid,
                stderr,
                false,
            );
        }
        let inner = Arc::clone(&self.inner);
        let stop_flag = Arc::clone(&self.stop_flag);
        let app_handle = app.clone();
        thread::spawn(move || wait_for_ready(inner, stop_flag, app_handle, generation));
        let inner = Arc::clone(&self.inner);
        let stop_flag = Arc::clone(&self.stop_flag);
        thread::spawn(move || health_watchdog(inner, stop_flag, app, generation));
        Ok(())
    }

    pub fn restart(&self, app: AppHandle) -> Result<(), String> {
        crate::client::cancel_pending_connections();
        let (generation, music_dir) = {
            let guard = self.inner.lock().expect("engine lock");
            (
                guard.generation,
                guard
                    .music_dir
                    .clone()
                    .ok_or_else(|| "Choose a music folder first.".to_string())?,
            )
        };
        self.start_if_current(app, music_dir, Some(generation))
    }

    pub fn stop(&self, app: Option<&AppHandle>) -> Result<(), String> {
        {
            let mut guard = self.inner.lock().expect("engine lock");
            self.stop_flag.store(true, Ordering::SeqCst);
            stop_child(&mut guard);
            guard.phase = EnginePhase::Idle;
            guard.message = "Stopped".into();
            push_log(&mut guard, "engine: stopped".into());
        }
        if let Some(app) = app {
            self.emit_status(app);
        }
        Ok(())
    }

    fn emit_status(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit("engine-status", status);
    }
}

fn status_snapshot(guard: &SupervisorInner) -> EngineStatus {
    EngineStatus {
        phase: guard.phase.clone(),
        message: guard.message.clone(),
        base_url: guard.runtime.as_ref().map(|r| r.base_url.clone()),
        player_url: guard.runtime.as_ref().map(|r| r.player_url()),
        log_lines: guard.log_lines.clone(),
    }
}

fn stop_child(guard: &mut SupervisorInner) {
    guard.generation = guard.generation.wrapping_add(1);
    if let Some(mut child) = guard.child.take() {
        terminate_child_process(&mut child);
    }
    guard.runtime = None;
    guard.health_failures = 0;
    guard.waiting_for_tools = false;
    guard.launch_id.clear();
    guard.engine_pid = None;
}

fn owns_launch(guard: &SupervisorInner, generation: u64, pid: u32) -> bool {
    guard.generation == generation && guard.child.as_ref().map(Child::id) == Some(pid)
}

fn accept_ready(
    guard: &mut SupervisorInner,
    generation: u64,
    pid: u32,
    state: EngineRuntimeState,
) -> bool {
    if guard.phase != EnginePhase::Booting
        || !owns_launch(guard, generation, pid)
        || !state.belongs_to(&guard.launch_id, guard.engine_pid)
    {
        return false;
    }
    guard.runtime = Some(state);
    guard.phase = EnginePhase::Ready;
    guard.message = "Ready".into();
    push_log(guard, "engine: ready".into());
    true
}

fn present_ready(
    inner: &Arc<Mutex<SupervisorInner>>,
    generation: u64,
    child_pid: u32,
    state: EngineRuntimeState,
    present: impl FnOnce(&str) -> String,
) -> Option<String> {
    let player_url = {
        let mut guard = inner.lock().expect("engine lock");
        if !accept_ready(&mut guard, generation, child_pid, state) {
            return None;
        }
        guard.runtime.as_ref().unwrap().player_url()
    };
    // WebView2 construction pumps native messages and can synchronously call
    // stop(). Never retain a supervisor/session mutex across this callback.
    let target = present(&player_url);
    let guard = inner.lock().expect("engine lock");
    (owns_launch(&guard, generation, child_pid) && guard.phase == EnginePhase::Ready)
        .then_some(target)
}

fn read_engine_output<R: Read + Send + 'static>(
    inner: Arc<Mutex<SupervisorInner>>,
    app: AppHandle,
    generation: u64,
    pid: u32,
    stream: R,
    startup_events: bool,
) {
    thread::spawn(move || {
        output_lines(stream, |line| {
            let mut guard = inner.lock().expect("engine lock");
            if !owns_launch(&guard, generation, pid) {
                return false;
            }
            if let Some(pid) = startup_events
                .then(|| ready_engine_pid(line, &guard.launch_id))
                .flatten()
            {
                guard.engine_pid = Some(pid);
            } else if let Some(waiting) = startup_events.then(|| tools_wait_event(&line)).flatten()
            {
                guard.waiting_for_tools = waiting;
            } else {
                push_log(&mut guard, line.chars().take(2000).collect());
            }
            if guard.phase == EnginePhase::Booting {
                // The existing startup panel and CI's native UI dump retain
                // the last six lines if a child never publishes its state.
                let _ = app.emit("engine-status", status_snapshot(&guard));
            }
            true
        });
    });
}

fn push_log(guard: &mut SupervisorInner, line: String) {
    guard.log_lines.push(line);
    if guard.log_lines.len() > 6 {
        let drain = guard.log_lines.len() - 6;
        guard.log_lines.drain(0..drain);
    }
}

fn bootstrap_config(music_dir: &PathBuf) -> Result<(), String> {
    if let Some(sidecar) = sidecar_binary() {
        let output = Command::new(&sidecar)
            .args(["--bootstrap", &music_dir.to_string_lossy()])
            .output()
            .map_err(|e| format!("Failed to bootstrap via sidecar: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Sidecar bootstrap failed: {stderr}"));
    }

    let root = repo_root();
    let python = python_executable(&root);
    if !root.join("soundsible_engine.py").exists() {
        return Err(format!(
            "Missing soundsible_engine.py under {}",
            root.display()
        ));
    }
    let output = Command::new(&python)
        .current_dir(&root)
        .arg(root.join("soundsible_engine.py"))
        .arg("--bootstrap")
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
    let mut command = if let Some(sidecar) = sidecar_binary() {
        push_log(
            guard,
            format!("engine: spawning sidecar {}", sidecar.display()),
        );
        let mut cmd = Command::new(sidecar);
        cmd.arg("--music-dir").arg(music_dir);
        cmd
    } else {
        let python = python_executable(&root);
        let entry = root.join("soundsible_engine.py");
        if !entry.exists() {
            return Err(format!("Missing engine entry at {}", entry.display()));
        }
        push_log(
            guard,
            format!("engine: spawning {} {}", python.display(), entry.display()),
        );
        let mut cmd = Command::new(&python);
        cmd.current_dir(&root).arg(&entry);
        cmd.arg("--music-dir").arg(music_dir);
        cmd
    };

    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("SOUNDSIBLE_DESKTOP_LAUNCH_ID", &guard.launch_id)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .spawn()
        .map_err(|e| format!("Failed to spawn engine: {e}"))
}

fn terminate_child_process(child: &mut Child) {
    let pid = child.id();
    terminate_pid(pid);
    #[cfg(not(windows))]
    let _ = child.kill();
    let _ = child.wait();
}

fn terminate_pid(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    let _ = std::fs::remove_file(state_file_path());
}

fn wait_for_ready(
    inner: Arc<Mutex<SupervisorInner>>,
    stop_flag: Arc<AtomicBool>,
    app: AppHandle,
    generation: u64,
) {
    let mut remaining = STARTUP_TIMEOUT;
    let mut last_check = Instant::now();
    while !stop_flag.load(Ordering::SeqCst) {
        let (child_pid, launch_id, engine_pid, waiting, exited) = {
            let mut guard = inner.lock().expect("engine lock");
            if guard.generation != generation || guard.phase != EnginePhase::Booting {
                return;
            }
            let waiting = guard.waiting_for_tools;
            let launch_id = guard.launch_id.clone();
            let engine_pid = guard.engine_pid;
            let Some(child) = guard.child.as_mut() else {
                return;
            };
            (
                child.id(),
                launch_id,
                engine_pid,
                waiting,
                child.try_wait().ok().flatten(),
            )
        };
        if let Some(status) = exited {
            let mut guard = inner.lock().expect("engine lock");
            if stop_flag.load(Ordering::SeqCst)
                || guard.phase != EnginePhase::Booting
                || !owns_launch(&guard, generation, child_pid)
            {
                return;
            }
            guard.phase = EnginePhase::Error;
            guard.message = "Couldn't start".into();
            push_log(
                &mut guard,
                format!("error: engine exited during startup ({status})"),
            );
            drop(guard);
            EngineSupervisor { inner, stop_flag }.emit_status(&app);
            return;
        }
        let now = Instant::now();
        remaining = startup_budget(remaining, now.duration_since(last_check), waiting);
        last_check = now;
        if remaining.is_zero() {
            break;
        }
        if let Some(state) = load_runtime_state() {
            if state.belongs_to(&launch_id, engine_pid) && health_check(&state.health_url()) {
                let ui_inner = Arc::clone(&inner);
                let ui_stop = Arc::clone(&stop_flag);
                let ui_app = app.clone();
                // Validate on the UI thread, but release locks across native
                // calls: WebView2 construction can reenter shortcut handlers.
                let result = app.run_on_main_thread(move || {
                    if ui_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let target =
                        present_ready(&ui_inner, generation, child_pid, state, |player_url| {
                            let target = crate::take_pending_player_url(&ui_app, player_url);
                            if let Err(error) = crate::desktop::open_player(&ui_app, &target) {
                                eprintln!("Could not open desktop player: {error}");
                            }
                            target
                        });
                    let guard = ui_inner.lock().expect("engine lock");
                    if let Some(target) =
                        target.filter(|_| owns_launch(&guard, generation, child_pid))
                    {
                        let _ = ui_app.emit("engine-ready", target);
                        let _ = ui_app.emit("engine-status", status_snapshot(&guard));
                    }
                });
                if let Err(error) = result {
                    eprintln!("Could not dispatch engine readiness: {error}");
                }
                return;
            }
        }
        thread::sleep(Duration::from_millis(250));
    }

    let mut guard = inner.lock().expect("engine lock");
    if guard.generation != generation || !fail_boot(&mut guard, stop_flag.load(Ordering::SeqCst)) {
        return;
    }
    drop(guard);
    let supervisor = EngineSupervisor { inner, stop_flag };
    supervisor.emit_status(&app);
}

fn fail_boot(guard: &mut SupervisorInner, cancelled: bool) -> bool {
    if cancelled || guard.phase != EnginePhase::Booting {
        return false;
    }
    guard.phase = EnginePhase::Error;
    guard.message = "Couldn't start".into();
    push_log(
        guard,
        "error: engine did not become ready within timeout".into(),
    );
    true
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[test]
    fn cancelled_boot_does_not_replace_the_connection_chooser_with_an_error() {
        let supervisor = EngineSupervisor::new();
        supervisor.inner.lock().unwrap().phase = EnginePhase::Booting;
        supervisor.stop(None).unwrap();
        let mut state = supervisor.inner.lock().unwrap();
        assert!(!fail_boot(
            &mut state,
            supervisor.stop_flag.load(Ordering::SeqCst)
        ));
        assert_eq!(state.phase, EnginePhase::Idle);
        assert_eq!(state.message, "Stopped");
    }

    #[test]
    fn packaged_python_readiness_is_accepted_only_for_its_current_bootloader_launch() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let mut guard = SupervisorInner::default();
        guard.child = Some(child);
        guard.phase = EnginePhase::Booting;
        guard.generation = 2;
        guard.launch_id = "own-launch".into();
        let python_pid = pid.wrapping_add(1);
        guard.engine_pid = Some(python_pid);
        let runtime = || EngineRuntimeState {
            pid: python_pid,
            launch_id: "own-launch".into(),
            base_url: "http://127.0.0.1:49152".into(),
            health: "/api/health".into(),
            owner_token_file: None,
            log_dir: "logs".into(),
        };
        assert!(!accept_ready(&mut guard, 1, pid, runtime()));
        assert_eq!(guard.phase, EnginePhase::Booting);
        assert!(guard.runtime.is_none());
        assert!(!accept_ready(&mut guard, 2, pid.wrapping_add(1), runtime()));
        assert!(accept_ready(&mut guard, 2, pid, runtime()));
        assert_eq!(guard.runtime.as_ref().unwrap().pid, python_pid);
        assert_eq!(guard.phase, EnginePhase::Ready);
    }

    #[test]
    fn cancelled_ready_dispatch_does_not_consume_a_link_or_open_a_player() {
        let supervisor = EngineSupervisor::new();
        {
            let mut guard = supervisor.inner.lock().unwrap();
            guard.phase = EnginePhase::Booting;
            guard.generation = 1;
        }
        // The HTTP result was obtained; the UI closure has not executed yet.
        supervisor.stop(None).unwrap();
        let mut guard = supervisor.inner.lock().unwrap();
        let state = EngineRuntimeState {
            pid: 43,
            launch_id: "own-launch".into(),
            base_url: "http://127.0.0.1:49152".into(),
            health: "/api/health".into(),
            owner_token_file: None,
            log_dir: "logs".into(),
        };
        let mut opened = false;
        if accept_ready(&mut guard, 1, 42, state) {
            opened = true;
        }
        assert!(!opened);
        assert_eq!(guard.phase, EnginePhase::Idle);
    }

    #[test]
    fn native_window_creation_can_reenter_stop_without_a_supervisor_deadlock() {
        let supervisor = EngineSupervisor::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        {
            let mut guard = supervisor.inner.lock().unwrap();
            guard.child = Some(child);
            guard.phase = EnginePhase::Booting;
            guard.generation = 1;
            guard.launch_id = "own-launch".into();
            guard.engine_pid = Some(43);
        }
        let state = EngineRuntimeState {
            pid: 43,
            launch_id: "own-launch".into(),
            base_url: "http://127.0.0.1:49152".into(),
            health: "/api/health".into(),
            owner_token_file: None,
            log_dir: "logs".into(),
        };
        let target = present_ready(&supervisor.inner, 1, pid, state, |url| {
            assert!(supervisor.inner.try_lock().is_ok());
            supervisor.stop(None).unwrap(); // A WM_HOTKEY dispatched inside construction.
            url.to_string()
        });
        assert!(target.is_none());
        assert_eq!(supervisor.status().phase, EnginePhase::Idle);
    }

    #[test]
    fn only_an_active_boot_timeout_becomes_an_error() {
        let mut state = SupervisorInner::default();
        state.phase = EnginePhase::Booting;
        assert!(fail_boot(&mut state, false));
        assert_eq!(state.phase, EnginePhase::Error);
        state.phase = EnginePhase::Ready;
        assert!(!fail_boot(&mut state, false));
        assert_eq!(state.phase, EnginePhase::Ready);
    }
}

fn health_watchdog(
    inner: Arc<Mutex<SupervisorInner>>,
    stop_flag: Arc<AtomicBool>,
    app: AppHandle,
    generation: u64,
) {
    while !stop_flag.load(Ordering::SeqCst) {
        thread::sleep(HEALTH_INTERVAL);
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        let health_url = {
            let guard = inner.lock().expect("engine lock");
            if guard.generation != generation {
                return;
            }
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
            if guard.generation != generation || guard.phase != EnginePhase::Ready {
                return;
            }
            if ok {
                guard.health_failures = 0;
            } else {
                guard.health_failures += 1;
                let failures = guard.health_failures;
                push_log(
                    &mut guard,
                    format!(
                        "error: health check failed ({}/{})",
                        failures, MAX_HEALTH_FAILURES
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
                let _ = supervisor.start_if_current(app.clone(), dir, Some(generation));
            }
            break;
        }
    }
}

fn health_check(url: &str) -> bool {
    match ureq::get(url)
        .config()
        .timeout_global(Some(HEALTH_TIMEOUT))
        .build()
        .call()
    {
        Ok(resp) => resp.status() == 200,
        Err(_) => false,
    }
}
