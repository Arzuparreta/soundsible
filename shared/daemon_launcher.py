"""
Single source of truth for starting and stopping the Soundsible Station Engine (daemon).
Used by the web launcher and the CLI so both behave the same.
"""
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

from shared.constants import STATION_PORT
from shared.runtime import get_config_dir
from shared.service_guard import listener_pid, pid_owns_listener, service_owner

# Note: Canonical user-facing messages (one place for consistency and i18n)
MSG_STATION_STARTING = "Station Engine is starting."
MSG_STATION_STOPPED = "Station Engine stopped."
MSG_STATION_NOT_RUNNING = "Station Engine was not running."
MSG_KEEP_TERMINAL_OPEN = "Keep this terminal open while the Station Engine is running. Closing it will stop the Station Engine."
MSG_CAN_CLOSE_TERMINAL = "You can close this terminal; the Station Engine keeps running in the background."
MSG_CONFIG_MISSING = "Configuration missing. Start setup first: python3 run.py --setup."
MSG_VENV_NOT_FOUND = "Virtual environment not found."
MSG_VENV_HINT = "Create it with: python3 -m venv venv"
MSG_RUNPY_NOT_FOUND = "run.py not found."
MSG_RUNPY_HINT = "Make sure you run this from the project root."
MSG_ALREADY_RUNNING = "Station Engine is already running."
MSG_SETUP_REQUIRED = MSG_CONFIG_MISSING
MSG_STATION_NOT_STOPPED = "Station Engine did not stop."

# How long the engine is given to shut itself down before it is killed. It
# closes its listener and its background work on SIGTERM; a few seconds of
# patience is the difference between a clean stop and a half-written queue.
STOP_TIMEOUT_SEC = 10.0

# The engines this process started, by port. Ownership is the whole point:
# anything else answering on the port — a systemd service, an engine somebody
# started in another terminal — belongs to somebody else and is left alone
# unless the user asks for it explicitly.
_owned_daemons: Dict[int, subprocess.Popen] = {}


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
    if not (get_config_dir() / "config.json").exists():
        return False, MSG_SETUP_REQUIRED
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
        process = subprocess.Popen(
            [str(venv_py), str(run_py), "--daemon"],
            **popen_kw,
        )
        _owned_daemons[STATION_PORT] = process
        return True, MSG_STATION_STARTING
    except Exception as e:
        return False, str(e)


def _live_owned_process(port: int) -> Optional[subprocess.Popen]:
    """The engine we started on ``port``, while it is still running."""
    process = _owned_daemons.get(port)
    if process is None:
        return None
    if process.poll() is not None:
        # It exited on its own; whatever holds the port now is not ours.
        _owned_daemons.pop(port, None)
        return None
    return process


def _owns_listener(process: subprocess.Popen, port: int) -> bool:
    """Whether the engine we started is the one answering on ``port``."""
    if sys.platform.startswith("linux"):
        return pid_owns_listener(process.pid, port)
    # Elsewhere /proc cannot answer; a live child we started is close enough.
    return True


def _stop_process(process: subprocess.Popen, timeout: float = STOP_TIMEOUT_SEC) -> bool:
    """Ask our engine to shut down, then insist. True when it is gone."""
    try:
        process.terminate()
    except OSError:
        return process.poll() is not None
    try:
        process.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        pass
    try:
        process.kill()
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return process.poll() is not None
    return True


def _stop_pid(pid: int, port: int, timeout: float = STOP_TIMEOUT_SEC) -> bool:
    """Stop an engine we did not start, without resorting to SIGKILL first."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return not is_port_in_use(port)
        time.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    time.sleep(0.5)
    return not is_port_in_use(port)


def stop_owned_daemon(port: int = STATION_PORT) -> bool:
    """Stop the engine this process started, and nothing else.

    This is what leaving the terminal menu runs. The menu used to kill
    whatever held the port, so quitting it also killed an engine running
    under systemd — which systemd then restarted, leaving listeners with a
    gap nobody had asked for.
    """
    process = _live_owned_process(port)
    if process is None:
        return False
    stopped = _stop_process(process)
    if stopped:
        _owned_daemons.pop(port, None)
    return stopped


def stop_daemon_process(port: int = STATION_PORT) -> Tuple[bool, str]:
    """
    Stop the Station Engine listening on ``port``, when it is ours to stop.
    Returns (success, message). Message is user-facing.

    An engine supervised by systemd is not ours: killing it only makes the
    unit restart, so say where it lives instead of pretending it stopped.
    """
    if not is_port_in_use(port):
        return True, MSG_STATION_NOT_RUNNING

    process = _live_owned_process(port)
    if process is not None and _owns_listener(process, port):
        if _stop_process(process):
            _owned_daemons.pop(port, None)
            return True, MSG_STATION_STOPPED
        return False, MSG_STATION_NOT_STOPPED

    foreign_pid = listener_pid(port)
    if foreign_pid is not None:
        owner = service_owner(foreign_pid)
        if owner is not None:
            return False, (
                f"The Station Engine on port {port} is run by systemd "
                f"({owner.unit}). Stop it with: {owner.stop_command()}"
            )
        if _stop_pid(foreign_pid, port):
            return True, MSG_STATION_STOPPED
        return False, MSG_STATION_NOT_STOPPED

    if os.name == "nt":
        try:
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
        except Exception as e:
            return False, str(e)

    # Nothing identified the listener, so nothing here knows whose it is.
    # Killing by port was how a menu used to take down a service it had never
    # started; say what is true instead.
    return False, (
        f"Something is listening on port {port} and this menu did not start it. "
        "Stop it where it was started."
    )
