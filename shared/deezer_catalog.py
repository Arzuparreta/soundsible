"""Deezer as a catalog source, and the row shape every catalog source returns.

Catalog search and artist pages (`routes/catalog.py`) and the DJ's related
artist pools (`routes/auto_mode.py`) both read Deezer through these, so they
live outside either route module.
"""

from __future__ import annotations

import re
from typing import Any
import unicodedata

from shared.providers import deezer
from shared.text_utils import collapse_text, fold_text, identity_key, normalize_text


def _clean(value: object, max_len: int = 240) -> str:
    return collapse_text(value, max_len)


def duration_seconds(value: object) -> int | None:
    try:
        num = int(float(value))
    except (TypeError, ValueError):
        return None
    return num if num > 0 else None


def positive_int(value: object, upper: int) -> int | None:
    """A whole number in ``1..upper``, or None for anything else."""
    if isinstance(value, bool):
        return None
    try:
        num = int(value)
    except (TypeError, ValueError):
        return None
    return num if 0 < num <= upper else None


def catalog_item(
    *,
    item_id: str,
    item_type: str,
    source: str,
    title: str,
    subtitle: str = "",
    artist: str = "",
    album: str = "",
    duration: int | None = None,
    cover: str = "",
    popularity: float = 0.0,
    track_id: str | None = None,
    external_ids: dict[str, Any] | None = None,
    attribution_url: str = "",
    in_library: bool = False,
    playable: bool = False,
    downloadable: bool = True,
    raw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": item_type,
        "source": source,
        "title": title,
        "subtitle": subtitle,
        "artist": artist,
        "album": album,
        "duration": duration,
        "cover": cover,
        "popularity": round(float(popularity or 0), 4),
        "track_id": track_id,
        "external_ids": external_ids or {},
        "attribution_url": attribution_url,
        "action_state": {
            "in_library": bool(in_library),
            "playable": bool(playable),
            "downloadable": bool(downloadable),
            "needs_resolution": not bool(track_id),
        },
        "raw": raw or {},
    }


def deezer_track_raw(deezer_id: str, artist_row: dict, album_row: dict) -> dict[str, Any]:
    """The song's own id plus the artist and album pages it belongs to.

    The artist and album ids go here rather than in ``external_ids``: those are
    identity keys, and every song by one artist sharing one would collapse them
    into a single search row. Playback carries these through to the artist and
    album links, so nothing has to look the artist up by name again.
    """
    raw: dict[str, Any] = {"deezer_id": deezer_id}
    for key, row in (("deezer_artist_id", artist_row), ("deezer_album_id", album_row)):
        if row.get("id"):
            raw[key] = str(row["id"])
    return raw


def deezer_get(path: str, params: dict[str, Any] | None = None, timeout: int = 8) -> dict[str, Any]:
    """One artist page used to fire five of these, each uncached and on its own
    connection. `shared.providers.deezer` pools and caches them."""
    return deezer.get(path, params, timeout=timeout)


DEEZER_ARTIST_SEARCH_LIMIT = 25
_DIACRITIC_OVERRIDE_MIN_FANS = 1000
_DIACRITIC_OVERRIDE_RATIO = 100
_DIACRITIC_STUB_OVERRIDE_MIN_FANS = 50


def literal_artist_key(value: object) -> str:
    """Normalized artist name preserving diacritics (NFC) for exact vs folded disambiguation."""
    return unicodedata.normalize("NFC", normalize_text(value))


def _safe_nonneg_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def select_artist_matches(
    name: str,
    rows: list[dict[str, Any]],
    *,
    fans_key: str = "nb_fan",
) -> list[dict[str, Any]]:
    """Rank exact Deezer artist matches, keeping literal matches distinct from folded ones.

    Literal matches lead when the query already has diacritics or when a real
    literal artist exists (preventing small homonyms like ``HALŌ`` from matching
    ``Halo``), while undecorated queries (``Blue Oyster Cult``, ``Rosalia``,
    ``Motorhead``) still resolve to the decorated canonical artist when no
    literal match exists or the literal row is a zero/negligible stub.
    """
    wanted_literal = literal_artist_key(name)
    wanted_folded = fold_text(name)
    if not wanted_folded:
        return []
    wanted_folded_nfc = unicodedata.normalize("NFC", wanted_folded)

    literal: list[dict[str, Any]] = []
    folded_only: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw_name = row.get("name")
        if not str(raw_name or "").strip():
            continue
        if literal_artist_key(raw_name) == wanted_literal:
            literal.append(row)
        elif fold_text(raw_name) == wanted_folded:
            folded_only.append(row)

    literal.sort(key=lambda row: _safe_nonneg_int(row.get(fans_key)), reverse=True)
    folded_only.sort(key=lambda row: _safe_nonneg_int(row.get(fans_key)), reverse=True)

    if not literal:
        ordered = folded_only
    elif not folded_only:
        ordered = literal
    elif wanted_literal != wanted_folded_nfc:
        ordered = [*literal, *folded_only]
    else:
        best_literal = _safe_nonneg_int(literal[0].get(fans_key))
        best_folded = _safe_nonneg_int(folded_only[0].get(fans_key))
        folded_dominates = (
            best_folded >= _DIACRITIC_OVERRIDE_MIN_FANS
            and best_folded >= best_literal * _DIACRITIC_OVERRIDE_RATIO
        ) or (
            best_literal == 0
            and best_folded >= _DIACRITIC_STUB_OVERRIDE_MIN_FANS
        )
        if folded_dominates:
            tail = sorted(
                [*folded_only[1:], *literal],
                key=lambda row: _safe_nonneg_int(row.get(fans_key)),
                reverse=True,
            )
            ordered = [folded_only[0], *tail]
        else:
            ordered = [*literal, *folded_only]

    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for row in ordered:
        row_id = str(row.get("deezer_id") or row.get("id") or "").strip()
        if row_id:
            if row_id in seen_ids:
                continue
            seen_ids.add(row_id)
        deduped.append(row)
    return deduped


def _artist_search(name: str, limit: int = DEEZER_ARTIST_SEARCH_LIMIT) -> list[dict[str, Any]]:
    data = deezer_get("search/artist", {"q": name, "limit": min(limit, 25)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_id = str(row.get("id") or "")
        artist_name = str(row.get("name") or "").strip()
        if not artist_id or not artist_name:
            continue
        out.append({
            "deezer_id": artist_id,
            "name": artist_name,
            "picture": deezer.image(row, "picture"),
            "nb_fans": _safe_nonneg_int(row.get("nb_fan")),
            "nb_album": _safe_nonneg_int(row.get("nb_album")),
        })
    return out


def resolve_artist_id(name: str, deezer_id: str | None = None) -> tuple[str | None, list[dict[str, Any]]]:
    """Resolve an artist name to a Deezer artist id, returning candidates for disambiguation."""
    if deezer_id:
        return deezer_id, []

    candidates = _artist_search(name, limit=DEEZER_ARTIST_SEARCH_LIMIT)
    if not candidates:
        return None, []

    exact = select_artist_matches(name, candidates, fans_key="nb_fans")
    if exact:
        return exact[0]["deezer_id"], exact[1:9]
    # No exact match — pick most popular among the top relevance hits
    fallback = sorted(candidates[:10], key=lambda c: c["nb_fans"], reverse=True)
    return fallback[0]["deezer_id"], fallback[1:4]


def artist_top_tracks(artist_id: str, limit: int = 50, library_keys: set[str] | None = None) -> list[dict[str, Any]]:
    data = deezer_get(f"artist/{artist_id}/top", {"limit": min(limit, 100)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        item = track_to_catalog_item(row, library_keys)
        if item:
            out.append(item)
    return out


def track_to_catalog_item(row: dict[str, Any], library_keys: set[str] | None = None) -> dict[str, Any] | None:
    artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
    album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
    # title_short drops recording versions such as "(Directo Mérida, Teatro
    # Romano)". Keep those when resolving audio and reconciling owned files.
    title = _clean(row.get("title") or row.get("title_short"))
    artist = _clean(artist_row.get("name"))
    if not title or not artist:
        return None
    deezer_id = str(row.get("id") or "")
    in_library = False
    if library_keys is not None:
        in_library = identity_key(title, artist) in library_keys
    raw = deezer_track_raw(deezer_id, artist_row, album_row)
    isrc = re.sub(r"[\s-]", "", str(row.get("isrc") or "")).upper()[:15]
    # Only `album/{id}/tracks` rows carry these: where the song sits on the
    # record, which a download needs to file it there.
    for key, field in (("track_number", "track_position"), ("disc_number", "disk_number")):
        position = positive_int(row.get(field), 999)
        if position:
            raw[key] = position
    # And when the record came out and whose record it is, where the row was
    # listed from one (an album page or a discography). A search row's album
    # names neither, and a download keeps none rather than the upload's.
    year = extract_year(album_row.get("release_date"))
    if year and 1000 <= year <= 9999:
        raw["year"] = year
    album_artist_row = album_row.get("artist") if isinstance(album_row.get("artist"), dict) else {}
    album_artist = _clean(album_artist_row.get("name"))
    if album_artist:
        raw["album_artist"] = album_artist
    return catalog_item(
        item_id=f"deezer:track:{deezer_id}",
        item_type="track",
        source="deezer",
        title=title,
        subtitle=artist,
        artist=artist,
        album=_clean(album_row.get("title")),
        duration=duration_seconds(row.get("duration")),
        cover=deezer.image(album_row, "cover"),
        popularity=float(row.get("rank") or 0),
        # The recording code rides along where Deezer gives it (album listings
        # do): it is the key that bridges catalogs, and one recording released
        # twice shares it.
        external_ids={"deezer_id": deezer_id, **({"isrc": isrc} if isrc else {})},
        attribution_url=row.get("link") or "",
        in_library=in_library,
        playable=False,
        downloadable=not in_library,
        raw=raw,
    )


def related_artists(artist_id: str, limit: int = 20) -> list[dict[str, Any]]:
    data = deezer_get(f"artist/{artist_id}/related", {"limit": min(limit, 50)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        aid = str(row.get("id") or "")
        aname = (row.get("name") or "").strip()
        if not aid or not aname:
            continue
        out.append({
            "deezer_id": aid,
            "name": aname,
            "picture": deezer.image(row, "picture"),
            "nb_fans": int(row.get("nb_fan") or 0),
        })
    return out


def main_contributors(album: dict[str, Any]) -> list[tuple[str, str]]:
    """The `(deezer_id, name)` of each artist Deezer credits as a main artist of
    an album, once each, in Deezer's order.

    `album/{id}` names a single `artist`, which is only the first of these: a
    label compilation credited to four composers reports the first of them as
    its artist. `artist/{id}/albums` rows carry no artist at all.
    """
    contributors = album.get("contributors") if isinstance(album.get("contributors"), list) else []
    credits: list[tuple[str, str]] = []
    seen: set[str] = set()
    for row in contributors:
        if not isinstance(row, dict) or _clean(row.get("role")).casefold() != "main":
            continue
        name = _clean(row.get("name"))
        if not name or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        credits.append((_clean(row.get("id"), 32), name))
    return credits


def extract_year(release_date: Any) -> int | None:
    if not release_date:
        return None
    text = str(release_date).strip()
    m = re.match(r"(\d{4})", text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None
