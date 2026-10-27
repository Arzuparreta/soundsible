"""Serial background analysis of every account's local music, including additions."""

import logging
import threading
from pathlib import Path

from shared.dj_engine import analyse_audio, analysis_identity, cached_analysis
from shared.dj.store import requests_waiting
from shared.path_resolver import resolve_local_track_path

logger = logging.getLogger(__name__)
_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def library_inventory():
    from shared.api import get_user_core
    from shared.request_scope import request_scope
    from shared.user_context import user_context
    from shared.users import list_users

    seen = set()
    for account in list_users():
        with request_scope(), user_context(account["id"]):
            library = get_user_core(account["id"]).library
            tracks = list(library.metadata.tracks if library.metadata else [])
            for track in tracks:
                if track.id in seen or getattr(track, "media_kind", None) == "podcast_episode":
                    continue
                path = resolve_local_track_path(track)
                if path:
                    seen.add(track.id)
                    yield path, analysis_identity({"track_id": track.id}), float(track.duration or 0)


def sweep_library(inventory, stop):
    """One bounded-memory pass. A missing/broken file never aborts the rest.

    Songs a DJ session is waiting for go first: before measuring an unmeasured
    library song the sweep waits until no session request is pending.
    """
    for path, identity, duration in inventory:
        if stop.is_set():
            break
        try:
            # Empty/disappearing files are picked up on the next pass.
            if Path(path).stat().st_size:
                if cached_analysis(path, identity) is None:
                    while requests_waiting():
                        if stop.wait(0.5):
                            return
                analyse_audio(path, identity, duration_hint=duration)
        except Exception:
            logger.debug("DJ library analysis failed: %s", identity, exc_info=True)
        if stop.wait(0.1):
            break


def _run():
    while not _stop.is_set():
        try:
            sweep_library(library_inventory(), _stop)
        except Exception:
            logger.exception("DJ library inventory failed")
        # Recheck new/changed files. Current entries are cheap SQLite hits.
        _stop.wait(300)


def start():
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_run, name="dj-library", daemon=True)
        _thread.start()


def stop():
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=3)
