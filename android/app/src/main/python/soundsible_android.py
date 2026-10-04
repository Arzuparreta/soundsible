"""Boot the real Soundsible engine inside the Android app process.

Runs the same code the desktop sidecar runs
(`shared/desktop_engine_entry.run_desktop_engine`): bootstrap a LOCAL
consumer config, mint the owner token, and serve the full API on loopback.
The Kotlin side reads the runtime state file and the owner token file to
connect to itself -- no pairing screen needed for the local engine.

Threading: call :func:`start` from a background thread and poll
:func:`state_file_contents` until the server is ready. Never throws: failures
are reported through :func:`status`.
"""

import argparse
import os
import threading
import traceback

_status = {"phase": "idle", "error": None}
_lock = threading.Lock()
_started = False


def _set_phase(phase, error=None):
    with _lock:
        _status["phase"] = phase
        _status["error"] = error


def status():
    """Current boot phase for the UI. Never throws."""
    with _lock:
        return dict(_status)


def configure(config_dir, data_dir, cache_dir, log_dir, music_dir, ui_dist):
    """Point the engine at app-private directories. Call before :func:`start`."""
    os.environ["SOUNDSIBLE_CONFIG_DIR"] = config_dir
    os.environ["SOUNDSIBLE_DATA_DIR"] = data_dir
    os.environ["SOUNDSIBLE_CACHE_DIR"] = cache_dir
    os.environ["SOUNDSIBLE_LOG_DIR"] = log_dir
    os.environ["SOUNDSIBLE_MUSIC_DIR"] = music_dir
    os.environ["SOUNDSIBLE_UI_DIST"] = ui_dist
    # The native client uses /api only; never shell out to npm on the phone.
    os.environ["SOUNDSIBLE_SKIP_UI_BUILD"] = "1"
    # yt-dlp runtime: its cache, temp files and file downloads all stay in
    # app-private storage. HOME is already the app dir under Chaquopy; pin
    # the XDG variables so no library ever reaches for shared storage.
    os.makedirs(cache_dir, exist_ok=True)
    os.environ["XDG_CACHE_HOME"] = cache_dir
    for key in ("TMPDIR", "TEMP", "TMP"):
        os.environ.setdefault(key, cache_dir + "/tmp")
    os.makedirs(os.environ["TMPDIR"], exist_ok=True)


def state_file_contents():
    """Runtime state JSON written on readiness, or None while booting."""
    from shared.desktop_runtime import runtime_state_file, RuntimeConfig

    try:
        probe = RuntimeConfig.default()
    except Exception:
        return None
    # runtime_state_file only needs config_dir; build a minimal probe.
    try:
        from shared.runtime import runtime_with_overrides

        runtime = runtime_with_overrides(base=probe, host="127.0.0.1", port=0)
        path = runtime_state_file(runtime)
    except Exception:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def read_owner_token(owner_token_file):
    try:
        with open(owner_token_file, encoding="utf-8") as fh:
            token = fh.read().strip()
        return token or None
    except OSError:
        return None


def _run():
    from shared.desktop_engine_entry import build_runtime_config
    from shared.desktop_runtime import ensure_owner_token, write_runtime_state
    from shared.ffmpeg_runtime import configure_ffmpeg
    from shared.runtime import configure_runtime
    from shared.version import resolve_version
    from shared.api import start_api

    args = argparse.Namespace(
        host="127.0.0.1",
        port=0,
        config_dir=None,
        data_dir=None,
        cache_dir=None,
        log_dir=None,
        music_dir=None,
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )
    _set_phase("starting")
    try:
        configure_ffmpeg()
    except Exception:
        pass
    runtime = build_runtime_config(args)
    runtime, _ = ensure_owner_token(runtime)
    configure_runtime(runtime)

    def _on_ready(ready_runtime):
        write_runtime_state(ready_runtime, version=resolve_version())
        _set_phase("ready")

    try:
        start_api(
            host=runtime.host,
            port=runtime.port,
            runtime_config=runtime,
            on_ready=_on_ready,
        )
    except Exception:
        _set_phase("error", traceback.format_exc())
        raise


def start():
    """Boot the engine on a background thread. Idempotent. Never throws."""
    global _started
    if _started:
        return True
    _started = True
    try:
        thread = threading.Thread(target=_run, name="soundsible-engine", daemon=True)
        thread.start()
        return True
    except Exception:
        _set_phase("error", traceback.format_exc())
        return False


def stop():
    """Stop the API server. Best-effort; never throws."""
    try:
        from shared.api import stop_api

        stop_api()
    except Exception:
        pass
    _set_phase("stopped")
