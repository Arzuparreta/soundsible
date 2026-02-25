"""
Launcher web server: serves the entry-point UI and API to start the ecosystem daemon.
"""
import os
import socket
import subprocess
from pathlib import Path

from flask import Flask, render_template, jsonify, request

ROOT_DIR = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT_DIR / "venv" / ("Scripts\\python.exe" if os.name == "nt" else "bin/python")
RUN_PY = ROOT_DIR / "run.py"
DEFAULT_PORT = 5099
API_PORT = 5005


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def get_local_ipv4() -> str:
    """Return this machine's local IPv4 (for LAN access)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


app = Flask(__name__, template_folder="templates", static_folder="static")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/local-ip")
def local_ip():
    return jsonify({"ip": get_local_ipv4()})


def stop_ecosystem_process() -> tuple[bool, str]:
    """Kill the process listening on API_PORT. Returns (success, message)."""
    if not is_port_in_use(API_PORT):
        return True, "Ecosystem was not running."
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
                if f":{API_PORT}" in line and "LISTENING" in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=5)
                        return True, "Ecosystem stopped."
            return False, "Process on port not found."
        else:
            subprocess.run(
                ["fuser", "-k", f"{API_PORT}/tcp"],
                stderr=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                timeout=5,
            )
            return True, "Ecosystem stopped."
    except Exception as e:
        return False, str(e)


@app.route("/api/stop-ecosystem", methods=["POST"])
def stop_ecosystem():
    ok, message = stop_ecosystem_process()
    if ok:
        return jsonify({"ok": True, "message": message}), 200
    return jsonify({"ok": False, "error": message}), 500


@app.route("/api/launch-ecosystem", methods=["POST"])
def launch_ecosystem():
    if is_port_in_use(API_PORT):
        return jsonify({"ok": True, "message": "Ecosystem is already running."}), 200
    if not VENV_PYTHON.exists():
        return jsonify({"ok": False, "error": "Virtual environment not found."}), 500
    if not RUN_PY.exists():
        return jsonify({"ok": False, "error": "run.py not found."}), 500
    try:
        log_dir = ROOT_DIR / "logs"
        log_dir.mkdir(exist_ok=True)
        log_file = open(log_dir / "daemon.log", "a")
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ROOT_DIR)
        popen_kw = {
            "stdout": log_file,
            "stderr": log_file,
            "cwd": str(ROOT_DIR),
            "env": env,
        }
        if os.name == "nt":
            popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            popen_kw["start_new_session"] = True
        subprocess.Popen(
            [str(VENV_PYTHON), str(RUN_PY), "--daemon"],
            **popen_kw,
        )
        return jsonify({"ok": True, "message": "Ecosystem is starting."}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def start_server(port: int = None, debug: bool = False):
    port = port or int(os.environ.get("LAUNCHER_PORT", DEFAULT_PORT))
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=False)


if __name__ == "__main__":
    start_server()
