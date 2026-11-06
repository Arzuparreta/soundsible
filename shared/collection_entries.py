"""Validated musical descriptors and metadata merge rules, independent of storage."""
from typing import Any, Dict, List, Optional, Set
from shared import library_dates

#: Snapshot fields kept alongside the keys, so a saved song that is not
#: downloaded is still renderable and playable.
_TEXT_FIELDS = ("title", "artist", "album", "album_artist", "thumbnail")

#: Where the song sits on its record, and when the record came out: what a
#: download of a saved song that is not a file yet is filed under. Bounded as
#: `/api/catalog/save` bounds them; anything else is dropped.
_RELEASE_FIELDS = (("track_number", 1, 999), ("disc_number", 1, 99), ("year", 1000, 9999))

#: A record as one thing: the album and everything that places the song on
#: it. Merged whole, never field by field, so two releases never mix.
_RELEASE_KEYS = ("album", "album_artist", *(name for name, _, _ in _RELEASE_FIELDS))


def _fill_snapshot(existing: Dict[str, Any], entry: Dict[str, Any]) -> bool:
    """Fill a saved entry's snapshot from another one of the same song.

    A song saved bare (＋ from a search row) has no snapshot worth the name;
    the heart usually arrives from a surface that has one. Returns whether
    anything changed.
    """
    before = dict(existing)
    for field in ("title", "artist", "duration"):
        if field in entry and not existing.get(field):
            existing[field] = entry[field]
    _fill_release(existing, entry)
    return existing != before


def _fill_release(existing: Dict[str, Any], entry: Dict[str, Any]) -> None:
    """Fill an entry's record from another snapshot of the same song.

    Records never mix (the client's `withRecord` follows the same rule): the
    same album fills in what is missing; another album replaces the record
    whole, but only when it places the song on it — an album named and
    nothing else is too little to overrule. An entry with no album takes any.
    The cover belongs to the record and follows the same decision.
    """
    album = entry.get("album")
    current = existing.get("album")
    if not album or (current and current.casefold() == album.casefold()):
        for field in (*(_RELEASE_KEYS[1:] if album else ()), "thumbnail"):
            if field in entry and not existing.get(field):
                existing[field] = entry[field]
        return
    if current and not entry.get("track_number"):
        return
    # The cover is the record's too: a new record brings its own, or none.
    for field in (*_RELEASE_KEYS, "thumbnail"):
        existing.pop(field, None)
        if field in entry:
            existing[field] = entry[field]


#: Dates the engine decides. A client payload never sets them; a stored entry
#: keeps whatever it was written with.
_DATE_FIELDS = ("added_at", "favourited_at")


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
    if isinstance(raw.get("item_id"), str) and raw["item_id"]:
        keys.insert(0, f'item:{raw["item_id"]}')
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
    for field, low, high in _RELEASE_FIELDS:
        value = raw.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
            entry[field] = value
    return entry


def _stored_entry(raw: Any, default_favourite: bool) -> Optional[Dict[str, Any]]:
    """An entry read back from disk: normalised, with the dates it was written with.

    A date that is missing stays missing. An entry from before dates existed
    has no record of when it was saved, and stamping it with the moment the file
    happened to be loaded would move it every time the engine restarted.
    """
    entry = _normalise_entry(raw, default_favourite=default_favourite)
    if entry is None:
        return None
    for field in _DATE_FIELDS:
        value = raw.get(field)
        if isinstance(value, str) and value.strip():
            entry[field] = value.strip()
    entry.setdefault("added_at", None)
    return entry


def _stamp_mark(entry: Dict[str, Any]) -> None:
    """Keep `favourited_at` in step with the mark: set as it goes on, gone with it."""
    if not entry.get("favourite"):
        entry.pop("favourited_at", None)
    elif not entry.get("favourited_at"):
        entry["favourited_at"] = library_dates.now()
