"""Each account's library and favourites, built once and cached.

The HTTP layer, the download pump and the background services all ask for an
account's library through here rather than through the Flask module.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from player.favourites_manager import FavouritesManager
from player.library import LibraryManager
from shared import library_dates
from shared.models import LibraryMetadata, Track

logger = logging.getLogger(__name__)


class _UserCore:
    """One person's library and favourites."""

    __slots__ = ("library", "favourites")

    def __init__(self, library, favourites):
        self.library = library
        self.favourites = favourites


_user_cores: dict[str, _UserCore] = {}


_user_cores_lock = threading.RLock()


def _build_user_core(user_id: str) -> _UserCore:
    logger.info("API: Initializing core services for user %s...", user_id)
    library = LibraryManager()
    # This loads SQLite when canonical, or performs the one-time manifest
    # migration for an existing account. A fresh account becomes an empty
    # canonical library here as well.
    library.sync_library(silent=True)

    def library_held_since(keys):
        # Read at call time: the manager swaps `metadata` on every reload.
        metadata = library.metadata
        return library_dates.held_since(keys, metadata.tracks if metadata else ())

    return _UserCore(library, FavouritesManager(library_held_since=library_held_since))


def get_user_core(user_id: Optional[str] = None) -> _UserCore:
    """Core services for ``user_id`` (default: the user bound to this request).

    Cores are cached per account. Building one reads that person's manifest, so
    it must happen inside their context — hence the explicit rebind below rather
    than trusting whatever is bound at call time.
    """
    from shared.user_context import require_user_id, user_context

    uid = user_id or require_user_id()
    with _user_cores_lock:
        core = _user_cores.get(uid)
    if core is not None:
        return core
    # Only construction may write. Ordinary playback reads never wait for the
    # lifecycle lock while another account uploads/edits metadata.
    from shared.library_lifecycle import coordinated
    with coordinated(), _user_cores_lock:
        core = _user_cores.get(uid)
        if core is None:
            with user_context(uid):
                core = _build_user_core(uid)
            _user_cores[uid] = core
        return core


def cached_cores() -> list[_UserCore]:
    """The cores built so far, without building any."""
    with _user_cores_lock:
        return list(_user_cores.values())


def reset_user_cores() -> None:
    """Forget every cached core (tests, storage reconfiguration)."""
    with _user_cores_lock:
        _user_cores.clear()


def get_library(user_id: Optional[str] = None):
    """This account's library (default: the account bound to this request)."""
    return get_user_core(user_id).library


def get_favourites_manager(user_id: Optional[str] = None):
    return get_user_core(user_id).favourites


def favourite_library_ids(user_id: Optional[str] = None) -> list:
    """
    Favourites resolved against this account's library, newest first.

    A favourite carries every identity its song answers to, so one marked as a
    YouTube preview and downloaded later is *the same entry* — it just starts
    resolving to a library track. Callers that only speak library ids (car,
    discovery seeds) go through here so that promotion is visible to them too,
    rather than reading the stored `lib:` keys directly.

    Saved-but-unmarked songs are not favourites and never appear here: these
    callers want the songs the user singled out, not the whole library.
    """
    from player.favourites_manager import LIB_PREFIX

    core = get_user_core(user_id)
    favourites = core.favourites
    if favourites is None:
        return []

    core.library.refresh_if_stale()
    metadata = core.library.metadata
    tracks = getattr(metadata, "tracks", None) or []
    owned = set()
    by_youtube = {}
    for track in tracks:
        owned.add(track.id)
        yt_id = getattr(track, "youtube_id", None)
        if yt_id:
            by_youtube.setdefault(yt_id, track.id)

    ids = []
    seen = set()
    for entry in favourites.get_favourite_entries():
        track_id = None
        for key in entry.get("keys") or []:
            if key.startswith(LIB_PREFIX) and key[len(LIB_PREFIX):] in owned:
                track_id = key[len(LIB_PREFIX):]
                break
            if key.startswith("yt:") and key[3:] in by_youtube:
                track_id = by_youtube[key[3:]]
                break
        if track_id and track_id not in seen:
            seen.add(track_id)
            ids.append(track_id)
    return ids


# Note: Helpers (used by blueprints)
def get_track_by_id(lib: LibraryManager, track_id: str) -> Optional[Track]:
    """Resolve a track against the account's current library revision."""
    lib.refresh_if_stale()
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
        if track:
            return track
    if lib.db:
        return lib.db.get_track(track_id)
    return None


def ensure_library_metadata():
    """The library and metadata a write is about to change, as they are *now*.

    Every caller of this mutates the snapshot it gets back and then saves the
    whole library from it, so it has to be the current one. The flat library
    read uses SQLite directly. Writes used to trust whatever this process
    last loaded, which is how a playlist could be
    renamed on one snapshot and a song added to another — the later save
    reverting the earlier change, and the client being told both succeeded.

    Downloads commit before reporting completion; no unsaved download snapshot
    is carried across requests.

    Returns (lib, metadata) or (None, None).
    """
    lib = get_library()
    if not lib.metadata:
        lib.sync_library()
    else:
        lib.refresh_if_stale()
    return lib, lib.metadata if lib else None


def loaded_library():
    """Current user's library manager with metadata guaranteed to be present."""
    lib = get_library()
    if not lib.metadata:
        lib.sync_library(silent=True)
    if not lib.metadata:
        lib.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    return lib
