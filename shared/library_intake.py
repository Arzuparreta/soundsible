"""Putting tracks into an account's library, and keeping its references right.

Downloads, imports and the download pool's sync all end here: the tracks are
saved, saved songs that now have a file are promoted, and the account's
sockets are told.
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Optional

from shared import library_dates, realtime, user_cores
from shared.library_lifecycle import serialized
from shared.models import Track

logger = logging.getLogger(__name__)


@serialized
def add_tracks_to_user_library(
    tracks,
    *,
    user_id: Optional[str] = None,
    operation_id=None,
    song_keys=(),
    keep_source_dates: bool = False,
) -> int:
    """Put specific tracks into one person's library.

    Downloads land in a pool everyone shares, so what makes a track *yours* is
    this entry. Only the tracks you asked for are added — merging the whole
    download pool would hand you everybody else's downloads.

    Each track is dated by :meth:`shared.library_dates.Holdings.claim`: a song
    this account already holds — saved without a file, say — keeps the day it
    was first held; the file is a new form of it, not a new song. The pool's own
    `added_at` says when *the pool* got the file, which is nobody's library date,
    so it is dropped unless `keep_source_dates` says the pool is this account's
    own catalog being merged in whole.

    `song_keys` are the identities the song was asked for under — a download of
    a saved song carries the entry's keys — so the file joins that song even
    when it shares no id with it yet (a Deezer row, before its video is known).
    """
    from shared.user_context import current_user_id

    target = user_id or current_user_id()
    if not target:
        logger.debug("API: no user bound; not adding %d track(s) to a library", len(list(tracks)))
        return 0

    core = user_cores.get_user_core(target)
    lib = core.library
    if not lib.metadata:
        lib.sync_library(silent=True)
    lib.refresh_if_stale()
    if operation_id and lib.db.has_library_operation(operation_id):
        return 0

    song_keys = [key for key in (song_keys or ()) if isinstance(key, str) and key]
    metadata = deepcopy(lib.metadata)
    holdings = library_dates.Holdings(metadata.tracks, _saved_entries(core))
    added = 0
    newly_added = []
    for track in tracks:
        if metadata.get_track_by_id(track.id):
            continue
        track_dict = track.to_dict()
        track_dict.pop("local_path", None)
        track_dict.pop("item_id", None)
        stored = Track.from_dict(track_dict)
        from shared.collection import Collection
        stored.item_id = Collection(lib.db).identify(song_keys)
        stored.added_at = holdings.claim(
            library_dates.track_keys(stored) + song_keys,
            proposed=stored.added_at if keep_source_dates else None,
        )
        metadata.add_track(stored)
        newly_added.append(stored)
        added += 1

    if added or operation_id:
        lib.require_saved(metadata=metadata, **({'operation_id': operation_id} if operation_id else {}))
        promoted = _promote_favourites_to_library(newly_added, user_id=target, song_keys=song_keys)
        realtime.emit_to_user('library_updated', user_id=target)
        if promoted:
            realtime.emit_to_user('favourites_updated', user_id=target)
        if added:
            try:
                from shared.discovery_signals import notify_discovery_signal

                notify_discovery_signal(target, always_refresh=False)
            except Exception:
                logger.debug("API: could not notify discovery feed after track intake", exc_info=True)
    return added


def _saved_entries(core) -> list:
    try:
        return core.favourites.get_entries()
    except Exception as exc:  # pragma: no cover — favourites are never load-bearing
        logger.debug("API: could not read saved songs: %s", exc)
        return []


def _promote_favourites_to_library(tracks, *, user_id: str, song_keys=()) -> int:
    """Give a saved song its ``lib:`` key once the file is actually here.

    Favouriting from a search row saves a bare ``yt:<video id>`` entry, because
    at that moment that is the only identity the song has. Downloading it later
    is supposed to promote the same entry rather than leave a second one — that
    is the whole point of matching on key intersection.

    Nothing ever performed that promotion, so the entry kept only its ``yt:``
    key. :meth:`FavouritesManager.get_all` reads ``lib:`` keys, which is what
    the Favourites view lists, so a song you had hearted and then downloaded
    disappeared from it: present in the library, present in favourites.json,
    and invisible in both views.

    The entry is found by the file's video *or* by the keys the download was
    asked for, and learns both the file and its video: a saved catalog row
    whose video was never resolved still becomes the file it was downloaded as.
    """
    try:
        manager = user_cores.get_favourites_manager(user_id)
    except Exception as exc:  # pragma: no cover — favourites are never load-bearing
        logger.debug("API: no favourites manager for %s: %s", user_id, exc)
        return 0

    from player.favourites_manager import library_key

    promoted = 0
    for track in tracks:
        video_id = getattr(track, "youtube_id", None)
        if not track.id or not (video_id or song_keys):
            continue
        match = ([f"yt:{video_id}"] if video_id else []) + list(song_keys)
        learned = [library_key(track.id)] + ([f"yt:{video_id}"] if video_id else [])
        try:
            if manager.update_keys(match, learned):
                promoted += 1
        except Exception as exc:  # pragma: no cover
            logger.debug("API: could not promote saved song %s: %s", track.id, exc)
    return promoted


@serialized
def remap_track_ids_for_all_users(id_map: dict, replacements=None) -> dict:
    """Rewrite track ids across every account after stored files changed.

    Persist source replacements for every account, retaining musical item IDs.
    The initiating account may already hold the new source objects in memory;
    its old SQLite binding still needs the same atomic replacement write.
    """
    from shared.user_context import user_context
    from shared.users import list_users

    if not id_map:
        return {}

    touched: dict[str, int] = {}
    failed = []
    replacement_ids = set(id_map.values())
    for account in list_users():
        user_id = account["id"]
        try:
            with user_context(user_id):
                core = user_cores.get_user_core(user_id)
                lib = core.library
                if not lib.metadata:
                    lib.sync_library(silent=True)
                if not lib.metadata:
                    continue

                lib.refresh_if_stale()
                metadata = deepcopy(lib.metadata)
                changed = metadata.remap_track_ids(id_map, references=False)
                # The repair caller can already have installed replacement
                # objects. A no-op model remap is not evidence that the source
                # association was committed in this account's database.
                changed |= any(track.id in replacement_ids for track in metadata.tracks)
                for track in metadata.tracks:
                    replacement = (replacements or {}).get(track.id)
                    if replacement:
                        for field in ('file_hash', 'format', 'file_size', 'bitrate', 'local_path'):
                            setattr(track, field, getattr(replacement, field))
                        changed = True

                if changed:
                    metadata.version += 1
                    if not lib._save_metadata(metadata=metadata, id_replacements=id_map):
                        raise RuntimeError("could not persist remapped library")
                    touched[user_id] = 1

                for old_id, new_id in id_map.items():
                    # Keeps the entry's snapshot and `added_at`, which a
                    # remove()+add() pair would silently reset.
                    core.favourites.remap_library_id(old_id, new_id)

                if changed:
                    realtime.emit_to_user("library_updated", user_id=user_id)
        except Exception as e:
            failed.append(user_id)
            logger.warning("API: could not remap repaired track ids for user %s: %s", user_id, e)
    if failed:
        raise RuntimeError("Some libraries could not commit repaired references; originals retained")
    return touched
