"""
Desktop engine CLI entrypoint for dev, PyInstaller sidecar, and Tauri shell.

Kept separate from ``run.py`` so the packaged sidecar does not import the Rich TUI launcher.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path

from shared.daemon_launcher import MSG_CONFIG_MISSING
from shared.desktop_bootstrap import ensure_consumer_config
from shared.desktop_runtime import (
    clear_runtime_state,
    ensure_owner_token,
    write_runtime_state,
)
from shared.runtime import (
    RuntimeConfig,
    configure_runtime,
    ensure_runtime_directories,
    get_config_dir,
    migrate_legacy_app_dirs,
    runtime_with_overrides,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Soundsible desktop engine sidecar.")
    parser.add_argument("--desktop-engine", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--bootstrap", metavar="MUSIC_DIR", help="Bootstrap consumer config only.")
    parser.add_argument("--host", help="Bind host override.")
    parser.add_argument("--port", type=int, help="Bind port override. Use 0 for a random port.")
    parser.add_argument("--config-dir", help="Runtime config directory override.")
    parser.add_argument("--data-dir", help="Runtime data directory override.")
    parser.add_argument("--cache-dir", help="Runtime cache directory override.")
    parser.add_argument("--log-dir", help="Runtime log directory override.")
    parser.add_argument("--music-dir", help="Runtime music directory override.")
    parser.add_argument("--ui-dist", help="UI dist directory override.")
    parser.add_argument("--owner-token-file", help="Owner token file path override.")
    parser.add_argument("--lan-enabled", dest="lan_enabled", action="store_true")
    parser.add_argument("--no-lan", dest="lan_enabled", action="store_false")
    parser.add_argument("--advanced-mode", action="store_true")
    parser.set_defaults(lan_enabled=None)
    return parser


def seed_runtime_env_from_args(args: argparse.Namespace) -> None:
    mappings = {
        "config_dir": "SOUNDSIBLE_CONFIG_DIR",
        "data_dir": "SOUNDSIBLE_DATA_DIR",
        "cache_dir": "SOUNDSIBLE_CACHE_DIR",
        "log_dir": "SOUNDSIBLE_LOG_DIR",
        "music_dir": "SOUNDSIBLE_MUSIC_DIR",
        "ui_dist": "SOUNDSIBLE_UI_DIST",
        "owner_token_file": "SOUNDSIBLE_OWNER_TOKEN_FILE",
    }
    for attr, env_key in mappings.items():
        value = getattr(args, attr, None)
        if value:
            os.environ[env_key] = str(value)
    if args.host:
        os.environ["SOUNDSIBLE_HOST"] = args.host
    if args.port is not None:
        os.environ["SOUNDSIBLE_PORT"] = str(args.port)
    if args.lan_enabled is not None:
        os.environ["SOUNDSIBLE_LAN_ENABLED"] = "true" if args.lan_enabled else "false"
    if args.advanced_mode:
        os.environ["SOUNDSIBLE_ADVANCED_MODE"] = "true"


def build_runtime_config(args: argparse.Namespace) -> RuntimeConfig:
    base = RuntimeConfig.default()
    host = args.host if args.host is not None else "127.0.0.1"
    port = args.port if args.port is not None else 0
    runtime = runtime_with_overrides(
        base=base,
        host=host,
        port=port,
        config_dir=args.config_dir,
        data_dir=args.data_dir,
        cache_dir=args.cache_dir,
        log_dir=args.log_dir,
        music_dir=args.music_dir,
        ui_dist=args.ui_dist,
        owner_token_file=args.owner_token_file,
        lan_enabled=args.lan_enabled if args.lan_enabled is not None else False,
        advanced_mode=False,
    )
    if runtime.port == 0:
        bind_host, bind_port = runtime.resolved_bind()
        runtime = runtime_with_overrides(base=runtime, host=bind_host, port=bind_port)
    configure_runtime(runtime)
    migrate_legacy_app_dirs(runtime)
    ensure_runtime_directories(runtime)
    return runtime


def desktop_readiness_payload(runtime: RuntimeConfig) -> dict:
    return {
        "event": "ready",
        "base_url": f"http://{runtime.host}:{runtime.port}",
        "host": runtime.host,
        "port": runtime.port,
        "pid": os.getpid(),
        "version": os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"),
        "health": "/api/health",
        "owner_token_file": str(runtime.owner_token_file) if runtime.owner_token_file else None,
    }


def run_desktop_engine(args: argparse.Namespace) -> None:
    runtime = build_runtime_config(args)
    runtime, _ = ensure_owner_token(runtime)
    configure_runtime(runtime)

    def _handle_exit(*_: object) -> None:
        clear_runtime_state(runtime)
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _handle_exit)
    signal.signal(signal.SIGTERM, _handle_exit)

    from shared.api import start_api

    def _on_ready(ready_runtime: RuntimeConfig) -> None:
        write_runtime_state(ready_runtime, version=os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"))
        print(json.dumps(desktop_readiness_payload(ready_runtime)), flush=True)

    try:
        start_api(
            host=runtime.host,
            port=runtime.port,
            runtime_config=runtime,
            on_ready=_on_ready,
        )
    finally:
        clear_runtime_state(runtime)


def bootstrap_only(music_dir: str) -> int:
    path = ensure_consumer_config(Path(music_dir))
    print(json.dumps({"config_path": str(path)}))
    return 0


def run(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    seed_runtime_env_from_args(args)

    if args.bootstrap:
        return bootstrap_only(args.bootstrap)

    if args.music_dir and not (get_config_dir() / "config.json").exists():
        bootstrap_only(args.music_dir)

    if not (get_config_dir() / "config.json").exists():
        print(f"Daemon: {MSG_CONFIG_MISSING}")
        print("Start setup first: python3 run.py --setup")
        return 1

    run_desktop_engine(args)
    return 0


def run_desktop_engine_cli(argv: list[str] | None = None) -> int:
    """Backward-compatible alias used by ``run.py`` and tests."""
    return run(argv)
