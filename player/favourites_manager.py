"""
Favourites Manager for Music Player.

A favourite is not a track id — it is an **identity plus a snapshot**.

A song changes id every time it crosses a boundary: a Deezer row is
`deezer:track:123`, playing it resolves to a YouTube video id, downloading it
mints a content hash in the library. Storing one of those ids means the
favourite survives exactly one hop, which is why favouriting a search result
used to write a video id that the Favourites view could never render.

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

FILE_VERSION = "2.0"

#: Namespace for "a track in this account's library". The only prefix this
#: module has to understand — every other namespace is opaque to it.
LIB_PREFIX = "lib:"

#: Snapshot fields kept alongside the keys, so a favourite that is not
#: downloaded is still renderable and playable.
_TEXT_FIELDS = ("title", "artist", "album", "thumbnail")


def library_key(track_id: str) -> str:
    """The identity key for a library track id."""
    return f"{LIB_PREFIX}{track_id}"


class FavouritesManager:
    """
    Ordered list of favourite entries, persisted as JSON, newest first.

    Order is part of the data (not an accident of set iteration), so the
    Favourites view looks the same after a reload as it did before one.
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
        """All favourite entries, newest first. Copies, so callers cannot mutate state."""
        with self._lock:
            return [dict(entry, keys=list(entry["keys"])) for entry in self._entries]

    def toggle_entry(self, raw_entry: Dict[str, Any]) -> bool:
        """
        Add or remove a favourite, matching on key intersection.

        Returns True if the song is now favourited, False if it was removed.
        Raises ValueError when the entry carries no usable identity key.
        """
        entry = _normalise_entry(raw_entry)
        if entry is None:
            raise ValueError("favourite entry needs at least one identity key")
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

    def is_favourite_keys(self, keys: Iterable[str]) -> bool:
        """Does any entry answer to one of these identities?"""
        with self._lock:
            return any(key in self._index for key in keys)

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

    def add(self, track_id: str) -> None:
        """Add a library track to favourites."""
        with self._lock:
            if self.is_favourite(track_id):
                return
            self._entries.insert(0, _bare_entry(library_key(track_id)))
            self._reindex()
            logger.debug("Added to favourites: %s", track_id)
            self._persist()

    def remove(self, track_id: str) -> None:
        """Remove whatever entry claims this library track."""
        with self._lock:
            matches = self._find_all([library_key(track_id)])
            if not matches:
                return
            for match in matches:
                self._entries.remove(match)
            self._reindex()
            logger.debug("Removed from favourites: %s", track_id)
            self._persist()

    def toggle(self, track_id: str) -> bool:
        """
        Toggle favourite status of a library track.
        Returns True if now favourited, False if unfavourited.
        """
        return self.toggle_entry({"keys": [library_key(track_id)]})

    def is_favourite(self, track_id: str) -> bool:
        """Check if a library track is favourited."""
        with self._lock:
            return library_key(track_id) in self._index

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
            return len(self._entries)

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
        Load favourites from JSON, migrating the v1 id-array shape on the way in.
        The migrated form is written back on the next change, not eagerly.
        """
        try:
            if not self._favourites_file.exists():
                logger.debug("No favourites file found at %s, starting fresh", self._favourites_file)
                return

            with open(self._favourites_file, 'r') as f:
                data = json.load(f)

            # Note: Validate data structure
            if not isinstance(data, dict) or 'favourites' not in data:
                logger.warning("Invalid favourites file format, starting fresh")
                return

            raw_list = data['favourites']
            if not isinstance(raw_list, list):
                logger.warning("Invalid favourites list format, starting fresh")
                return

            entries: List[Dict[str, Any]] = []
            for raw in raw_list:
                # v1 stored bare library track ids; v2 stores entries.
                entry = _bare_entry(library_key(raw)) if isinstance(raw, str) and raw.strip() \
                    else _normalise_entry(raw) if isinstance(raw, dict) else None
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
    """An entry with an identity and no snapshot — what a v1 id migrates to."""
    return {"keys": [key], "added_at": None}


def _normalise_entry(raw: Any) -> Optional[Dict[str, Any]]:
    """
    Coerce a client payload into a storable entry, dropping anything unknown.
    Returns None when there is no identity to match on.
    """
    if not isinstance(raw, dict):
        return None
    keys = _clean_keys(raw.get("keys"))
    if not keys:
        return None

    entry: Dict[str, Any] = {"keys": keys}
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
