"""Container-first Soundsible startup.

The regular launcher intentionally requires an interactive first-run setup.
Containers need a deterministic unattended boot, so this module creates the
equivalent local-storage configuration once and then starts the same Station
API used by ``run.py --daemon``.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Mapping


logger = logging.getLogger(__name__)


def _truthy(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def bootstrap_local_config(environment: Mapping[str, str] | None = None) -> bool:
    """Create the first-run local storage config, returning whether it was created.

    Existing configuration is never changed. Set
    ``SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE=false`` to require a pre-populated
    ``/config/config.json`` instead.
    """
    env = environment or os.environ
    config_dir = Path(env.get("SOUNDSIBLE_CONFIG_DIR", "/config")).expanduser().resolve()
    music_dir = Path(env.get("SOUNDSIBLE_MUSIC_DIR", "/music")).expanduser().resolve()
    config_path = config_dir / "config.json"

    config_dir.mkdir(parents=True, exist_ok=True)
    music_dir.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        return False
    if not _truthy(env.get("SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE"), default=True):
        raise RuntimeError(
            f"Soundsible is not configured: place config.json in {config_dir} "
            "or enable SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE"
        )

    payload = {
        "provider": "local",
        "endpoint": str(music_dir),
        "bucket": "soundsible",
        "access_key_id": "",
        "secret_access_key": "",
        "region": None,
        "public": False,
        "cache_max_size_gb": 50,
        "cache_location": env.get("SOUNDSIBLE_CACHE_DIR", "/cache"),
        "last_sync": None,
        "quality_preference": "high",
        "watch_folders": [str(music_dir)],
        "is_encrypted": False,
    }
    config_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    (config_dir / "output_dir").write_text(str(music_dir) + "\n", encoding="utf-8")
    (config_dir / "music_dir.json").write_text(
        json.dumps({"path": str(music_dir)}, indent=2) + "\n",
        encoding="utf-8",
    )
    return True


def main() -> int:
    logging.basicConfig(
        level=os.getenv("SOUNDSIBLE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    created = bootstrap_local_config()
    if created:
        logger.info("Created first-run local configuration in %s", os.environ.get("SOUNDSIBLE_CONFIG_DIR", "/config"))

    # Socket and thread monkey-patching must precede imports of the API server.
    from gevent import monkey

    monkey.patch_all()

    from shared.api import start_api
    from shared.runtime import RuntimeConfig

    runtime = RuntimeConfig.default()
    start_api(host=runtime.host, port=runtime.port, runtime_config=runtime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
