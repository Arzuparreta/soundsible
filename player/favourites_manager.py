"""Saved/favourite compatibility API over the account's canonical collection.

Musical items and their properties live in SQLite alongside playlist references
and source bindings. Legacy favourites.json is imported once and retained as
restoration data. Python entry lists are transaction-local scratch; a second
manager always reads committed state before changing it.
"""

from shared import library_dates
from shared.library_lifecycle import serialized
from functools import wraps
import logging
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional, Set

from shared.user_context import user_config_dir

logger = logging.getLogger(__name__)

#: v3 split "saved" from "favourite". Files written before it hold only songs
#: the user hearted, back when the heart was the sole way to save one — so
#: every v1/v2 entry migrates in as a favourite.
FILE_VERSION = "3.0"

#: Namespace for "a track in this account's library". The only prefix this
#: module has to understand — every other namespace is opaque to it.
LIB_PREFIX = "lib:"

from shared.collection_entries import _clean_keys, _normalise_entry, _fill_snapshot, _stamp_mark

#: "When has this account's library held a song under any of these keys?" —
#: answered from the library's tracks by the core that owns both stores.
HeldSince = Callable[[List[str]], Optional[str]]


def library_key(track_id: str) -> str:
    """The identity key for a library track id."""
    return f"{LIB_PREFIX}{track_id}"


def saved_operation(method):
    """Reload under the cross-process lifecycle lock, then commit atomically.

    A manager is a compatibility facade over collection properties. Its Python
    list is transaction-local scratch, never a second persisted song store.
    """
    @wraps(method)
    @serialized
    def operation(self, *args, **kwargs):
        with self._lock, self._collection.transaction() as conn:
            from shared.collection import entries
            self._transaction = conn
            self._entries = entries(conn)
            self._reindex()
            try:
                return method(self, *args, **kwargs)
            finally:
                self._transaction = None
    return operation


class FavouritesManager:
    """
    Ordered saved properties of stable collection items, newest first.

    Order is part of the data (not an accident of set iteration), so the
    library looks the same after a reload as it did before one.
    """

    def __init__(self, library_held_since: Optional[HeldSince] = None):
        """`library_held_since` is how an entry learns that the library already
        holds its song as a file, and since when. Without it (tests, tools with
        no library) every new entry is simply dated now."""
        self._library_held_since = library_held_since
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
            self._refresh()
            return [dict(entry, keys=list(entry["keys"])) for entry in self._entries]

    def get_favourite_entries(self) -> List[Dict[str, Any]]:
        """The subset the user marked out, newest first."""
        return [entry for entry in self.get_entries() if entry.get("favourite")]

    @saved_operation
    def toggle_saved(self, raw_entry: Dict[str, Any], *, added_at: Optional[str] = None) -> bool:
        """
        Add or remove one song, preferring its stable collection identity.

        Returns True if the song is now saved, False if it was removed. Removing
        takes the favourite mark with it — there is nothing left to mark.
        Raises ValueError when the entry carries no usable identity key.

        `added_at` is what an importer knows about when the song was acquired
        elsewhere; it only dates a song the library does not already hold.
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
            self._admit(entry, proposed=added_at)
            return True

    @saved_operation
    def set_saved(
        self,
        raw_entries: Iterable[Dict[str, Any]],
        saved: bool,
        enriched: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Put many songs in the library, or take them out, in one write.

        Unlike `toggle_saved` this never flips: saving skips songs already held,
        removing skips songs that are not. Removing also keeps a song that is
        marked — the heart is a choice of its own — and one the library holds as
        a file, since unsaving a downloaded song would mean deleting it. Returns
        the entries that changed. Saving a song already held still fills in its
        snapshot from the richer one (an album's ＋ after a search row's); those
        entries are appended to `enriched`, not returned.
        """
        changed: List[Dict[str, Any]] = []
        filled = False
        # Newest first: saving from the end keeps a record's songs in its order.
        ordered = list(raw_entries)
        if saved:
            ordered.reverse()
        with self._lock:
            for raw in ordered:
                entry = _normalise_entry(raw, default_favourite=False) if isinstance(raw, dict) else None
                if entry is None:
                    continue
                matches = self._find_all(entry["keys"])
                if saved:
                    if matches:
                        for match in matches:
                            if _fill_snapshot(match, entry):
                                filled = True
                                if enriched is not None:
                                    enriched.append(dict(match, keys=list(match["keys"])))
                        continue
                    entry["added_at"] = self._held_by_library(entry["keys"]) or library_dates.now()
                    _stamp_mark(entry)
                    self._entries.insert(0, entry)
                    self._reindex()
                    changed.append(entry)
                    continue
                for match in matches:
                    if match.get("favourite") or self._transaction.execute("SELECT 1 FROM collection_files WHERE item_id=?", (match["item_id"],)).fetchone():
                        continue
                    self._entries.remove(match)
                    self._reindex()
                    changed.append(match)
            if changed or filled:
                self._persist()
        return [dict(entry, keys=list(entry["keys"])) for entry in changed]

    @saved_operation
    def set_favourite(self, raw_entry: Dict[str, Any], favourite: Optional[bool] = None, *, save_if_missing: bool = True) -> bool:
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
                if favourite is False and not save_if_missing:
                    return False
                # Favouriting a song you had not saved saves it, in one act.
                entry["favourite"] = True if favourite is None else bool(favourite)
                self._admit(entry)
                return entry["favourite"]
            resolved = (not existing.get("favourite")) if favourite is None else bool(favourite)
            if bool(existing.get("favourite")) == resolved:
                # Already marked from another device: what this one knows
                # about the song still counts.
                if self._fill_all(entry):
                    self._persist()
                return resolved
            existing["favourite"] = resolved
            _stamp_mark(existing)
            self._fill_all(entry)
            self._persist()
            return resolved

    def _fill_all(self, entry: Dict[str, Any]) -> bool:
        """Fill every held copy of a song from `entry`. Under the lock."""
        filled = False
        for match in self._find_all(entry["keys"]):
            filled = _fill_snapshot(match, entry) or filled
        return filled

    def is_saved_keys(self, keys: Iterable[str]) -> bool:
        """Is any of these identities in the library (file or not)?"""
        with self._lock:
            self._refresh()
            return bool(self._find_all(keys))

    def is_favourite_keys(self, keys: Iterable[str]) -> bool:
        """Is any of these identities marked out?"""
        with self._lock:
            self._refresh()
            return any(entry.get('favourite') for entry in self._find_all(keys))

    @saved_operation
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
            # The new identity can reveal that the library already held this
            # song as a file — a Deezer row saved today resolving to a video
            # downloaded in spring. It is one song, held since the earlier of the
            # two. (The file is never the later one by more than the few seconds
            # a fresh entry waits for its video: a download of a saved song
            # carries the entry's keys and is dated from it when it lands.)
            entry["added_at"] = library_dates.earliest(entry.get("added_at"), self._held_by_library(added))
            self._reindex()
            self._persist()
            return True

    @saved_operation
    def remap_library_id(self, old_id: str, new_id: str) -> bool:
        """
        Follow a library track whose id was rewritten (a repair re-keys ids to
        content hashes). Keeps the snapshot and `added_at` intact, which
        remove()+add() would throw away.
        """
        if not old_id or not new_id or old_id == new_id:
            return False
        with self._lock:
            entry = self._index.get(library_key(old_id))
            if entry is None:
                return False
            self._transaction.execute("DELETE FROM collection_keys WHERE key=? AND item_id=?",
                                      (library_key(old_id), entry["item_id"]))
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
            self._refresh()
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
            self._refresh()
            return sum(1 for entry in self._entries if entry.get("favourite"))

    @saved_operation
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

    def _admit(self, entry: Dict[str, Any], proposed: Optional[str] = None) -> None:
        """Put a new entry in the library, dated by the one rule.

        A song the library already holds as a file keeps the date it has been
        held since — hearting a downloaded song does not make it new. Anything
        else joins now, or when an importer says it was acquired. Always called
        under the lock.
        """
        entry["added_at"] = self._held_by_library(entry["keys"]) or proposed or library_dates.now()
        _stamp_mark(entry)
        self._entries.insert(0, entry)
        self._reindex()
        self._persist()

    def _held_by_library(self, keys: List[str]) -> Optional[str]:
        if self._library_held_since is None:
            return None
        try:
            return self._library_held_since(list(keys))
        except Exception as exc:  # the library is never load-bearing here
            logger.debug("Could not read when the library took hold of %s: %s", keys, exc)
            return None

    def _persist(self) -> None:
        """Save, then notify. Always called under the lock."""
        self._save_to_file()
        from shared.library_lifecycle import after_release
        after_release(self._notify_change, key=('collection-marks', id(self)))

    def _reindex(self) -> None:
        """Rebuild key → entry. First entry wins, so order decides duplicates."""
        index: Dict[str, Dict[str, Any]] = {}
        for entry in self._entries:
            for key in entry["keys"]:
                index.setdefault(key, entry)
        self._index = index

    def _find(self, keys: Iterable[str]) -> Optional[Dict[str, Any]]:
        matches = self._find_all(keys)
        return matches[0] if len(matches) == 1 else None

    def _find_all(self, keys: Iterable[str]) -> List[Dict[str, Any]]:
        keys = list(keys)
        internal = [key[5:] for key in keys if key.startswith('item:')]
        if internal:
            return [entry for entry in self._entries if entry.get('item_id') in internal]
        if self._transaction is not None:
            from shared.collection import admission_item
            identified = admission_item(self._transaction, keys)
            if identified:
                return [entry for entry in self._entries if entry.get('item_id') == identified]
        # A provider key shared by multiple elements is evidence of ambiguity,
        # never permission to toggle or remove all those elements together.
        matches = [entry for entry in self._entries if not set(keys).isdisjoint(entry['keys'])]
        return matches if len(matches) == 1 else []

    def _save_to_file(self) -> None:
        """Compatibility method name: SQLite is the only writable authority."""
        from shared.collection import save_entries
        if self._transaction is None:
            self._collection.write_saved(self._entries)
        else:
            save_entries(self._transaction, self._entries)

    def _load_from_file(self) -> None:
        """Import legacy JSON once; all later opens read the account database."""
        from shared.collection import Collection
        from shared.database import _manager_for
        self._collection = Collection(_manager_for(self._favourites_file.with_name("library.db")))
        self._transaction = None
        self._collection.ensure_saved_store()
        self._refresh()

    def _refresh(self):
        self._entries = self._collection.saved()
        self._reindex()
