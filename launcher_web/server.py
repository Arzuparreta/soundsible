"""
Launcher web server: serves the entry-point UI and API to start the ecosystem daemon.
"""
import os
import sys
import socket
import subprocess
import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from flask import Flask, render_template, jsonify, request
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
        return jsonify({"ok": True, "message": "Ecosystem is starting!"}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# --- Setup API (config + test connection + buckets) ---

def _config_path():
    from shared.constants import DEFAULT_CONFIG_DIR
    return Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"


def _sanitize_config(config) -> dict:
    """Return config dict safe for UI (no raw credentials)."""
    return {
        "configured": True,
        "provider": config.provider.value,
        "endpoint": config.endpoint,
        "bucket": config.bucket,
        "public": config.public,
        "region": config.region,
        "cache_max_size_gb": config.cache_max_size_gb,
        "cache_location": config.cache_location,
        "quality_preference": config.quality_preference,
        "watch_folders": config.watch_folders or [],
        "credentials_set": bool(config.access_key_id or config.secret_access_key),
    }


@app.route("/api/setup/config", methods=["GET"])
def get_setup_config():
    from shared.models import PlayerConfig
    path = _config_path()
    if not path.exists():
        return jsonify({"configured": False}), 200
    try:
        with open(path, "r") as f:
            data = json.load(f)
        config = PlayerConfig.from_dict(data)
        return jsonify(_sanitize_config(config)), 200
    except Exception as e:
        return jsonify({"error": str(e), "configured": False}), 500


def _validate_config_body(data: dict, for_save: bool) -> tuple[dict | None, str | None]:
    """Validate body for POST config. Returns (data_for_PlayerConfig, error_message)."""
    from shared.models import StorageProvider
    provider_val = (data.get("provider") or "").strip().lower()
    if not provider_val:
        return None, "provider is required"
    try:
        provider = StorageProvider(provider_val)
    except ValueError:
        return None, f"Unknown provider: {provider_val}"
    if provider not in (StorageProvider.CLOUDFLARE_R2, StorageProvider.BACKBLAZE_B2, StorageProvider.LOCAL):
        return None, f"Provider {provider_val} not supported in setup"
    bucket = (data.get("bucket") or "").strip()
    endpoint = (data.get("endpoint") or "").strip()
    if for_save and not bucket:
        return None, "bucket is required"
    if provider == StorageProvider.LOCAL:
        if for_save and not endpoint:
            return None, "endpoint (storage path) is required for local storage"
        access_key_id = ""
        secret_access_key = ""
    else:
        if for_save:
            access_key_id = (data.get("access_key_id") or "").strip()
            secret_access_key = (data.get("secret_access_key") or "").strip()
            if not access_key_id or not secret_access_key:
                return None, "access_key_id and secret_access_key are required"
        else:
            access_key_id = (data.get("access_key_id") or "").strip()
            secret_access_key = (data.get("secret_access_key") or "").strip()
    out = {
        "provider": provider,
        "endpoint": endpoint,
        "bucket": bucket,
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
        "region": data.get("region"),
        "public": bool(data.get("public", False)),
        "cache_max_size_gb": int(data.get("cache_max_size_gb", 50)),
        "cache_location": (data.get("cache_location") or "~/.cache/musicplayer/").strip(),
        "quality_preference": (data.get("quality_preference") or "high").strip(),
        "watch_folders": data.get("watch_folders") if isinstance(data.get("watch_folders"), list) else [],
    }
    return out, None


@app.route("/api/setup/config", methods=["POST"])
def post_setup_config():
    from shared.models import PlayerConfig, StorageProvider
    from shared.constants import BACKBLAZE_B2_ENDPOINT_TEMPLATE
    raw = request.get_json(silent=True) or {}
    validated, err = _validate_config_body(raw, for_save=True)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    try:
        provider = validated["provider"]
        endpoint = validated["endpoint"]
        if provider == StorageProvider.CLOUDFLARE_R2 and not endpoint:
            account_id = (raw.get("account_id") or "").strip()
            if account_id:
                endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
        if provider == StorageProvider.BACKBLAZE_B2 and not endpoint:
            region = validated.get("region") or "us-west-004"
            endpoint = BACKBLAZE_B2_ENDPOINT_TEMPLATE.format(region=region)
        config = PlayerConfig(
            provider=provider,
            endpoint=endpoint,
            bucket=validated["bucket"],
            access_key_id=validated["access_key_id"],
            secret_access_key=validated["secret_access_key"],
            region=validated.get("region"),
            public=validated["public"],
            cache_max_size_gb=validated["cache_max_size_gb"],
            cache_location=validated["cache_location"],
            quality_preference=validated["quality_preference"],
            watch_folders=validated["watch_folders"],
        )
        path = _config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            f.write(config.to_json())
        return jsonify({"ok": True, "message": "Configuration saved."}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _credentials_for_provider(provider_val: str, data: dict) -> dict:
    from shared.models import StorageProvider
    provider = StorageProvider(provider_val)
    if provider == StorageProvider.CLOUDFLARE_R2:
        return {
            "account_id": (data.get("account_id") or data.get("endpoint", "").replace("https://", "").split(".")[0] or "").strip(),
            "access_key_id": (data.get("access_key_id") or "").strip(),
            "secret_access_key": (data.get("secret_access_key") or "").strip(),
        }
    if provider == StorageProvider.BACKBLAZE_B2:
        return {
            "application_key_id": (data.get("access_key_id") or data.get("application_key_id") or "").strip(),
            "application_key": (data.get("secret_access_key") or data.get("application_key") or "").strip(),
        }
    if provider == StorageProvider.LOCAL:
        return {"base_path": (data.get("endpoint") or data.get("base_path") or "").strip()}
    return {}


@app.route("/api/setup/test-connection", methods=["POST"])
def setup_test_connection():
    from shared.models import StorageProvider
    from setup_tool.provider_factory import StorageProviderFactory
    raw = request.get_json(silent=True) or {}
    provider_val = (raw.get("provider") or "").strip().lower()
    if not provider_val:
        return jsonify({"ok": False, "error": "provider is required"}), 400
    try:
        provider = StorageProvider(provider_val)
    except ValueError:
        return jsonify({"ok": False, "error": f"Unknown provider: {provider_val}"}), 400
    if provider not in (StorageProvider.CLOUDFLARE_R2, StorageProvider.BACKBLAZE_B2, StorageProvider.LOCAL):
        return jsonify({"ok": False, "error": "Provider not supported"}), 400
    creds = _credentials_for_provider(provider_val, raw)
    if provider == StorageProvider.LOCAL:
        if not creds.get("base_path"):
            return jsonify({"ok": False, "error": "endpoint (storage path) is required"}), 400
    else:
        if not creds.get("access_key_id") and not creds.get("application_key_id"):
            return jsonify({"ok": False, "error": "Credentials required"}), 400
    try:
        storage = StorageProviderFactory.create(provider)
        if not storage.authenticate(creds):
            return jsonify({"ok": False, "error": "Authentication failed"}), 200
        buckets = storage.list_buckets()
        return jsonify({"ok": True, "buckets": buckets}), 200
    except NotImplementedError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


@app.route("/setup")
def setup_page():
    return render_template("setup.html")


def start_server(port: int = None, debug: bool = False):
    port = port or int(os.environ.get("LAUNCHER_PORT", DEFAULT_PORT))
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=False)


if __name__ == "__main__":
    start_server()
