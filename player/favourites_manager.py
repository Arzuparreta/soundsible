"""
Saved-songs store for Music Player.

Two independent facts about a song live here, and keeping them apart is the
whole point of this module:

- **Saved** — the song is in this account's library. An entry exists for it.
- **Favourite** — the song is *marked out* among the ones you have. An entry
  with ``favourite: True``.

Saving is not downloading. A song can be in the library with no file behind it
(it streams), and downloading it later changes nothing here — the entry simply
starts resolving to a local track. Owning a file is likewise its own fact: a
downloaded song is in your library whether or not it has an entry.

That gives one rule per direction, and no others:

- Favouriting an unsaved song saves it (you cannot mark out what you do not have).
- Unsaving drops the favourite with it.
- Unfavouriting leaves the song saved — it removes a mark, not a song.

An entry is not a track id — it is an **identity plus a snapshot**.

A song changes id every time it crosses a boundary: a Deezer row is
`deezer:track:123`, playing it resolves to a YouTube video id, downloading it
mints a content hash in the library. Storing one of those ids means the entry
survives exactly one hop, which is why saving a search result used to write a
video id that no view could ever render.

So an entry carries the whole set of namespaced keys the song answers to
(`lib:`, `yt:`, `isrc:`, `mb:`, `deezer:`, `cat:` — mirroring
`ui_web/src/lib/playbackIdentity.ts`) plus enough metadata to render and stream
it without the library. Two entries are the same song when their key sets
intersect.

The keys are derived by the client, which already owns that logic; this module
only stores them, matches on intersection, and knows that `lib:` means "a track
in this account's library".
"""

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set

from shared.time_utils import utc_now_iso_naive
from shared.user_context import user_config_dir

logger = logging.getLogger(__name__)

#: v3 split "saved" from "favourite". Files written before it hold only songs
#: the user hearted, back when the heart was the sole way to save one — so
#: every v1/v2 entry migrates in as a favourite.
FILE_VERSION = "3.0"

#: Namespace for "a track in this account's library". The only prefix this
#: module has to understand — every other namespace is opaque to it.
LIB_PREFIX = "lib:"

#: Snapshot fields kept alongside the keys, so a saved song that is not
#: downloaded is still renderable and playable.
_TEXT_FIELDS = ("title", "artist", "album", "thumbnail")


def library_key(track_id: str) -> str:
    """The identity key for a library track id."""
    return f"{LIB_PREFIX}{track_id}"


class FavouritesManager:
    """
    Ordered list of saved entries, persisted as JSON, newest first.

    Order is part of the data (not an accident of set iteration), so the
    library looks the same after a reload as it did before one.
    """

    def __init__(self):
        self._entries: List[Dict[str, Any]] = []
        self._index: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()  # Note: Use reentrant lock to prevent deadlocks with callbacks
        self._on_change_callbacks: List[Callable[[], None]] = []
        self._favourites_file = user_config_dir() / "favourites.json"

        # Note: Load existing favourites
        self._load_from_file()

    # ── Entry API ──

    def get_entries(self) -> List[Dict[str, Any]]:
        """Every saved entry, newest first. Copies, so callers cannot mutate state."""
        with self._lock:
            return [dict(entry, keys=list(entry["keys"])) for entry in self._entries]

    def get_favourite_entries(self) -> List[Dict[str, Any]]:
        """The subset the user marked out, newest first."""
        return [entry for entry in self.get_entries() if entry.get("favourite")]

    def toggle_saved(self, raw_entry: Dict[str, Any]) -> bool:
        """
        Add or remove a song from the library, matching on key intersection.

        Returns True if the song is now saved, False if it was removed. Removing
        takes the favourite mark with it — there is nothing left to mark.
        Raises ValueError when the entry carries no usable identity key.
        """
        entry = _normalise_entry(raw_entry, default_favourite=False)
        if entry is None:
            raise ValueError("saved entry needs at least one identity key")
        with self._lock:
            matches = self._find_all(entry["keys"])
            if matches:
                for match in matches:
                    self._entries.remove(match)
                self._reindex()
                self._persist()
                return False
            self._entries.insert(0, entry)
            self._reindex()
            self._persist()
            return True

    def set_favourite(self, raw_entry: Dict[str, Any], favourite: Optional[bool] = None) -> bool:
        """
        Mark or unmark a song, saving it first if it is not in the library yet.

        `favourite=None` toggles. Returns the resulting mark. Unmarking keeps the
        entry: the song stays in the library, it just stops standing out.
        Raises ValueError when the entry carries no usable identity key.
        """
        entry = _normalise_entry(raw_entry, default_favourite=True)
        if entry is None:
            raise ValueError("favourite entry needs at least one identity key")
        with self._lock:
            existing = self._find(entry["keys"])
            if existing is None:
                # Favouriting a song you had not saved saves it, in one act.
                entry["favourite"] = True if favourite is None else bool(favourite)
                self._entries.insert(0, entry)
                self._reindex()
                self._persist()
                return entry["favourite"]
            resolved = (not existing.get("favourite")) if favourite is None else bool(favourite)
            if bool(existing.get("favourite")) == resolved:
                return resolved
            if not resolved and any(k.startswith(LIB_PREFIX) for k in existing["keys"]):
                # The library already holds this song as a file, so the entry was
                # only ever carrying the mark. Drop it rather than leave a record
                # that says nothing — unsaving a downloaded song means deleting
                # it, which is a different act entirely.
                self._entries.remove(existing)
                self._reindex()
                self._persist()
                return False
            existing["favourite"] = resolved
            # A song saved bare (＋ from a search row) has no snapshot worth the
            # name; the heart usually arrives from a surface that has one.
            for field in _TEXT_FIELDS:
                if field in entry and not existing.get(field):
                    existing[field] = entry[field]
            if "duration" in entry and not existing.get("duration"):
                existing["duration"] = entry["duration"]
            self._persist()
            return resolved

    def is_saved_keys(self, keys: Iterable[str]) -> bool:
        """Is any of these identities in the library (file or not)?"""
        with self._lock:
            return any(key in self._index for key in keys)

    def is_favourite_keys(self, keys: Iterable[str]) -> bool:
        """Is any of these identities marked out?"""
        with self._lock:
            return any(
                bool(entry.get("favourite"))
                for entry in (self._index.get(key) for key in keys)
                if entry is not None
            )

    def update_keys(self, match_keys: Iterable[str], new_keys: Iterable[str]) -> bool:
        """
        Widen an existing entry with identities learned later — the video a
        catalog row resolved to, say. No-op (False) when nothing matches.
        """
        additions = [k for k in _clean_keys(new_keys)]
        if not additions:
            return False
        with self._lock:
            entry = self._find(match_keys)
            if entry is None:
                return False
            known = set(entry["keys"])
            added = [k for k in additions if k not in known]
            if not added:
                return False
            entry["keys"].extend(added)
            self._reindex()
            self._persist()
            return True

    def remap_library_id(self, old_id: str, new_id: str) -> bool:
        """
        Follow a library track whose id was rewritten (the optimizer re-keys ids
        to content hashes). Keeps the snapshot and `added_at` intact, which
        remove()+add() would throw away.
        """
        if not old_id or not new_id or old_id == new_id:
            return False
        with self._lock:
            entry = self._index.get(library_key(old_id))
            if entry is None:
                return False
            entry["keys"] = [k for k in entry["keys"] if k != library_key(old_id)]
            if library_key(new_id) not in entry["keys"]:
                entry["keys"].insert(0, library_key(new_id))
            self._reindex()
            self._persist()
            return True

    # ── Library-id API (unchanged contract for existing callers) ──
    #
    # Everything here speaks about the *mark*, because that is what a caller
    # holding a library id can mean: the song is already in the library, so
    # "saved" is not in question.

    def add(self, track_id: str) -> None:
        """Mark a library track as a favourite."""
        self.set_favourite({"keys": [library_key(track_id)]}, True)

    def remove(self, track_id: str) -> None:
        """Unmark a library track. The song stays in the library."""
        self.set_favourite({"keys": [library_key(track_id)]}, False)

    def toggle(self, track_id: str) -> bool:
        """
        Toggle favourite status of a library track.
        Returns True if now favourited, False if unfavourited.
        """
        return self.set_favourite({"keys": [library_key(track_id)]})

    def is_favourite(self, track_id: str) -> bool:
        """Check if a library track is favourited."""
        return self.is_favourite_keys([library_key(track_id)])

    def get_all(self) -> List[str]:
        """
        Favourite **library** track ids, newest first.

        Entries that are not (yet) owned as a local track carry no `lib:` key
        and are simply absent — which is what every existing caller already
        assumed, since they all intersect this list with the library.
        """
        with self._lock:
            ids: List[str] = []
            seen: Set[str] = set()
            for entry in self._entries:
                if not entry.get("favourite"):
                    continue
                for key in entry["keys"]:
                    if not key.startswith(LIB_PREFIX):
                        continue
                    track_id = key[len(LIB_PREFIX):]
                    if track_id and track_id not in seen:
                        seen.add(track_id)
                        ids.append(track_id)
            return ids

    def size(self) -> int:
        """Get count of favourited tracks."""
        with self._lock:
            return sum(1 for entry in self._entries if entry.get("favourite"))

    def clear(self) -> None:
        """Clear all favourites."""
        with self._lock:
            self._entries.clear()
            self._index.clear()
            logger.debug("Cleared all favourites")
            self._persist()

    # ── Change notification ──

    def add_change_callback(self, callback: Callable[[], None]) -> None:
        """Register a callback to be called when favourites change."""
        if callback not in self._on_change_callbacks:
            self._on_change_callbacks.append(callback)

    def remove_change_callback(self, callback: Callable[[], None]) -> None:
        """Unregister a favourites change callback."""
        if callback in self._on_change_callbacks:
            self._on_change_callbacks.remove(callback)

    def _notify_change(self) -> None:
        """Notify all registered callbacks that favourites have changed."""
        for callback in self._on_change_callbacks:
            try:
                callback()
            except Exception as e:
                logger.warning("Error in favourites change callback: %s", e)

    # ── Internals ──

    def _persist(self) -> None:
        """Save, then notify. Always called under the lock."""
        self._save_to_file()
        self._notify_change()

    def _reindex(self) -> None:
        """Rebuild key → entry. First entry wins, so order decides duplicates."""
        index: Dict[str, Dict[str, Any]] = {}
        for entry in self._entries:
            for key in entry["keys"]:
                index.setdefault(key, entry)
        self._index = index

    def _find(self, keys: Iterable[str]) -> Optional[Dict[str, Any]]:
        for key in keys:
            entry = self._index.get(key)
            if entry is not None:
                return entry
        return None

    def _find_all(self, keys: Iterable[str]) -> List[Dict[str, Any]]:
        """Every entry these identities name — defensive against duplicates."""
        found: List[Dict[str, Any]] = []
        for key in keys:
            entry = self._index.get(key)
            if entry is not None and not any(entry is f for f in found):
                found.append(entry)
        return found

    def _save_to_file(self) -> None:
        """Write favourites to JSON, atomically — a torn write would lose the lot."""
        try:
            self._favourites_file.parent.mkdir(parents=True, exist_ok=True)

            data = {
                "version": FILE_VERSION,
                # Written under both names: `saved` is what the list now is,
                # `favourites` keeps an older build readable rather than blank.
                "saved": self._entries,
                "favourites": self._entries,
            }

            fd, tmp_path = tempfile.mkstemp(
                dir=str(self._favourites_file.parent), prefix=".favourites-", suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, self._favourites_file)
            except Exception:
                Path(tmp_path).unlink(missing_ok=True)
                raise

            logger.debug("Saved %s favourites to %s", len(self._entries), self._favourites_file)
        except Exception as e:
            logger.warning("Error saving favourites to file: %s", e)

    def _load_from_file(self) -> None:
        """
        Load saved songs from JSON, migrating older shapes on the way in.
        The migrated form is written back on the next change, not eagerly.

        Before v3 the heart was the only way to save a song, so every entry in
        an older file is a favourite — that is what the user meant when they
        pressed it, and reading them as plain saves would silently wipe the
        marks off a whole library.
        """
        try:
            if not self._favourites_file.exists():
                logger.debug("No favourites file found at %s, starting fresh", self._favourites_file)
                return

            with open(self._favourites_file, 'r') as f:
                data = json.load(f)

            # Note: Validate data structure
            if not isinstance(data, dict) or ('saved' not in data and 'favourites' not in data):
                logger.warning("Invalid favourites file format, starting fresh")
                return

            raw_list = data.get('saved') if isinstance(data.get('saved'), list) else data.get('favourites')
            if not isinstance(raw_list, list):
                logger.warning("Invalid favourites list format, starting fresh")
                return

            version = str(data.get('version') or '1.0')
            pre_split = version < "3.0"

            entries: List[Dict[str, Any]] = []
            for raw in raw_list:
                # v1 stored bare library track ids; v2+ store entries.
                if isinstance(raw, str) and raw.strip():
                    entry = _bare_entry(library_key(raw))
                elif isinstance(raw, dict):
                    entry = _normalise_entry(raw, default_favourite=pre_split)
                else:
                    entry = None
                if entry is not None:
                    entries.append(entry)

            self._entries = entries
            self._reindex()
            logger.debug("Loaded %s favourites from %s", len(self._entries), self._favourites_file)

        except json.JSONDecodeError as e:
            logger.warning("Error decoding favourites JSON file: %s, starting fresh", e)
        except Exception as e:
            logger.warning("Error loading favourites from file: %s, starting fresh", e)


def _clean_keys(keys: Any) -> List[str]:
    """Trimmed, de-duplicated, order-preserving identity keys."""
    if not isinstance(keys, (list, tuple)):
        return []
    out: List[str] = []
    seen: Set[str] = set()
    for key in keys:
        if not isinstance(key, str):
            continue
        trimmed = key.strip()
        if trimmed and trimmed not in seen:
            seen.add(trimmed)
            out.append(trimmed)
    return out


def _bare_entry(key: str) -> Dict[str, Any]:
    """An entry with an identity and no snapshot — what a v1 id migrates to.
    v1 files predate saving, so its songs are favourites."""
    return {"keys": [key], "favourite": True, "added_at": None}


def _normalise_entry(raw: Any, default_favourite: bool = False) -> Optional[Dict[str, Any]]:
    """
    Coerce a client payload into a storable entry, dropping anything unknown.
    Returns None when there is no identity to match on.

    `default_favourite` decides what an entry with no `favourite` field means —
    which depends entirely on who is speaking. A pre-v3 file only ever held
    hearted songs; a client saving one is not hearting it.
    """
    if not isinstance(raw, dict):
        return None
    keys = _clean_keys(raw.get("keys"))
    if not keys:
        return None

    favourite = raw.get("favourite")
    entry: Dict[str, Any] = {
        "keys": keys,
        "favourite": bool(favourite) if isinstance(favourite, bool) else default_favourite,
    }
    for field in _TEXT_FIELDS:
        value = raw.get(field)
        if isinstance(value, str) and value.strip():
            entry[field] = value.strip()

    duration = raw.get("duration")
    if isinstance(duration, bool):
        duration = None
    if isinstance(duration, (int, float)) and duration > 0:
        entry["duration"] = int(duration)

    added_at = raw.get("added_at")
    entry["added_at"] = added_at if isinstance(added_at, str) and added_at.strip() else utc_now_iso_naive()
    return entry
