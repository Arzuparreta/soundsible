"""Start the engine from `run.py`: upgrade the download tools, then the API."""

from __future__ import annotations


def start_engine(runtime, *, update_tools: bool = True) -> None:
    """Upgrade the download tools if asked to, then import and start the API.

    The order matters: `shared.api` imports yt-dlp, and an upgrade must not
    swap its files under a running copy. The desktop engine never upgrades:
    a packaged build carries its own copy, and its shell gives the whole
    start 120 s, which a slow pip run alone could spend.
    """
    if update_tools:
        from shared.logging_setup import configure_logging
        from shared.runtime_updates import apply_runtime_updates

        configure_logging()
        apply_runtime_updates()
    from shared.api import start_api

    start_api(host=runtime.host, port=runtime.port, runtime_config=runtime)
