"""Apply launcher arguments before loading the runtime or its dependencies."""

import argparse
import os


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
