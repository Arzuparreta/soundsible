"""
Bootstrap minimal consumer desktop config before first engine start.

Used by the Tauri shell so ``run.py --desktop-engine`` / ``soundsible_engine.py`` can start
without running the legacy setup wizard.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from shared.models import PlayerConfig, StorageProvider
from shared.runtime import get_config_dir, save_persisted_music_dir


def ensure_consumer_config(music_dir: Path) -> Path:
    """Ensure ``config.json`` exists with a LOCAL provider pointing at *music_dir*."""
    music_dir = music_dir.expanduser().resolve()
    music_dir.mkdir(parents=True, exist_ok=True)

    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.json"

    if not config_path.exists():
        config = PlayerConfig(
            provider=StorageProvider.LOCAL,
            endpoint=str(music_dir),
            bucket="music",
            access_key_id="",
            secret_access_key="",
            cache_location=str(config_dir.parent / "cache" / "musicplayer"),
            watch_folders=[str(music_dir)],
        )
        config_path.write_text(config.to_json(), encoding="utf-8")
        try:
            (config_dir / "output_dir").write_text(str(music_dir), encoding="utf-8")
        except OSError:
            pass

    save_persisted_music_dir(config_dir, music_dir)
    return config_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bootstrap Soundsible consumer desktop config.")
    parser.add_argument("music_dir", help="Music library folder path")
    args = parser.parse_args(argv)
    path = ensure_consumer_config(Path(args.music_dir))
    print(json.dumps({"config_path": str(path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
