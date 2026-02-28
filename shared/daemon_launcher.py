"""
Single source of truth for starting and stopping the Soundsible Station Engine (daemon).
Used by the web launcher and the CLI so both behave the same.
"""
import os
import socket
import subprocess
from pathlib import Path
from typing import Tuple

# Port the Station Engine listens on
STATION_PORT = 5005

# Canonical user-facing messages (one place for consistency and i18n)
MSG_STATION_STARTING = "Station Engine is starting."
MSG_STATION_STOPPED = "Station Engine stopped."
MSG_STATION_NOT_RUNNING = "Station Engine was not running."
MSG_KEEP_TERMINAL_OPEN = "Keep this terminal open while the Station Engine is running. Closing it will stop the Station Engine."
MSG_CAN_CLOSE_TERMINAL = "You can close this terminal; the Station Engine keeps running in the background."
MSG_CONFIG_MISSING = "Configuration missing. Run the launcher once without --daemon to set up."
MSG_VENV_NOT_FOUND = "Virtual environment not found."
MSG_VENV_HINT = "Create it with: python3 -m venv venv"
MSG_RUNPY_NOT_FOUND = "run.py not found."
MSG_RUNPY_HINT = "Make sure you run this from the project root."
MSG_ALREADY_RUNNING = "Station Engine is already running."


def _project_root(root_dir: Path = None) -> Path:
    if root_dir is not None:
        return Path(root_dir).resolve()
    return Path(__file__).resolve().parent.parent


def _venv_python(root: Path) -> Path:
    if os.name == "nt":
        return root / "venv" / "Scripts" / "python.exe"
    return root / "venv" / "bin" / "python"


def _run_py(root: Path) -> Path:
    return root / "run.py"


def is_port_in_use(port: int = STATION_PORT) -> bool:
    """Return True if something is listening on the given port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_daemon_process(root_dir: Path = None, env_extra: dict = None, detach: bool = True) -> Tuple[bool, str]:
    """
    Start the Station Engine (run.py --daemon). Same env, cwd, and Popen options everywhere.
    Returns (success, message). Message is user-facing (for toasts/CLI/errors).
    env_extra: optional dict merged into the child process env.
    detach: if True (default), child runs in new session and survives parent exit (CLI).
            if False, child stays attached so closing the parent terminal kills it too (web launcher).
    """
    root = _project_root(root_dir)
    venv_py = _venv_python(root)
    run_py = _run_py(root)

    if not venv_py.exists():
        return False, f"{MSG_VENV_NOT_FOUND} {MSG_VENV_HINT}"
    if not run_py.exists():
        return False, f"{MSG_RUNPY_NOT_FOUND} {MSG_RUNPY_HINT}"
    if is_port_in_use(STATION_PORT):
        return False, MSG_ALREADY_RUNNING

    env = os.environ.copy()
    env["PYTHONPATH"] = str(root)
    if env_extra:
        env.update(env_extra)
    popen_kw = {
        "cwd": str(root),
        "env": env,
    }
    if detach:
        if os.name == "nt":
            popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            popen_kw["start_new_session"] = True

    try:
        subprocess.Popen(
            [str(venv_py), str(run_py), "--daemon"],
            **popen_kw,
        )
        return True, MSG_STATION_STARTING
    except Exception as e:
        return False, str(e)


def stop_daemon_process(port: int = STATION_PORT) -> Tuple[bool, str]:
    """
    Stop the process listening on the Station Engine port.
    Returns (success, message). Message is user-facing.
    """
    if not is_port_in_use(port):
        return True, MSG_STATION_NOT_RUNNING
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if out.returncode != 0:
                return False, "Could not list processes."
            for line in out.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        subprocess.run(
                            ["taskkill", "/PID", pid, "/F"],
                            capture_output=True,
                            timeout=5,
                        )
                        return True, MSG_STATION_STOPPED
            return False, "Process on port not found."
        subprocess.run(
            ["fuser", "-k", f"{port}/tcp"],
            stderr=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            timeout=5,
        )
        return True, MSG_STATION_STOPPED
    except Exception as e:
        return False, str(e)
