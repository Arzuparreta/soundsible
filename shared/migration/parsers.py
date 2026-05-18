from __future__ import annotations

import csv
import io
import json
from typing import Any, List

from shared.migration.models import SourceTrack


class ParseError(ValueError):
    """Raised when export payload cannot be interpreted."""


def _clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _spotify_artists(track_obj: dict) -> str:
    artists = track_obj.get("artists")
    if not isinstance(artists, list):
        return ""
    names = []
    for a in artists:
        if isinstance(a, dict):
            n = _clean_str(a.get("name"))
            if n:
                names.append(n)
        elif isinstance(a, str) and a.strip():
            names.append(a.strip())
    return ", ".join(names)


def _album_name(track_obj: dict) -> str:
    album = track_obj.get("album")
    if isinstance(album, dict):
        return _clean_str(album.get("name"))
    return ""


def _append_spotify_track(out: List[SourceTrack], track_obj: Any) -> None:
    if not isinstance(track_obj, dict):
        return
    title = _clean_str(track_obj.get("name") or track_obj.get("track_name"))
    if not title:
        return
    artist = _spotify_artists(track_obj) or _clean_str(track_obj.get("artist"))
    album = _album_name(track_obj) or _clean_str(track_obj.get("album"))
    out.append(SourceTrack(title=title, artist=artist, album=album))


def _walk_spotify_obj(data: Any, out: List[SourceTrack]) -> None:
    if isinstance(data, list):
        for item in data:
            _walk_spotify_obj(item, out)
        return
    if not isinstance(data, dict):
        return

    if "tracks" in data:
        tr = data["tracks"]
        if isinstance(tr, dict) and isinstance(tr.get("items"), list):
            for item in tr["items"]:
                if isinstance(item, dict) and isinstance(item.get("track"), dict):
                    _append_spotify_track(out, item["track"])
                else:
                    _append_spotify_track(out, item if isinstance(item, dict) else {})
        elif isinstance(tr, list):
            for item in tr:
                if isinstance(item, dict) and isinstance(item.get("track"), dict):
                    _append_spotify_track(out, item["track"])
                else:
                    _append_spotify_track(out, item if isinstance(item, dict) else {})
        return

    if isinstance(data.get("track"), dict):
        _append_spotify_track(out, data["track"])
        return

    if _clean_str(data.get("name") or data.get("title")):
        _append_spotify_track(out, data)


def parse_spotify_json(text: str) -> List[SourceTrack]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ParseError(f"Invalid JSON: {e}") from e
    out: List[SourceTrack] = []
    _walk_spotify_obj(data, out)
    if not out:
        raise ParseError("No tracks found in Spotify-format JSON")
    return out


def _normalize_header(h: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "" for ch in h)


def parse_apple_music_csv(text: str) -> List[SourceTrack]:
    if not text.strip():
        raise ParseError("Empty CSV")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise ParseError("CSV has no header row")

    norm_map = {_normalize_header(h): h for h in reader.fieldnames if h}

    def pick(*candidates: str) -> str | None:
        for c in candidates:
            key = _normalize_header(c)
            if key in norm_map:
                return norm_map[key]
        return None

    title_col = pick("name", "track name", "title", "song", "track")
    artist_col = pick("artist", "album artist", "artist name")
    album_col = pick("album", "album name")
    if not title_col:
        raise ParseError("CSV must include a track title column (Name / Title / Track)")

    out: List[SourceTrack] = []
    for row in reader:
        title = _clean_str(row.get(title_col))
        if not title:
            continue
        artist = _clean_str(row.get(artist_col)) if artist_col else ""
        album = _clean_str(row.get(album_col)) if album_col else ""
        out.append(SourceTrack(title=title, artist=artist, album=album))

    if not out:
        raise ParseError("No data rows in CSV")
    return out


def parse_export(format_name: str, text: str) -> List[SourceTrack]:
    """Dispatch parser by explicit ``format_name``."""
    key = (format_name or "").strip().lower().replace("-", "_")
    if key in {"spotify_json", "spotify", "spotify_playlist"}:
        return parse_spotify_json(text)
    if key in {"apple_music_csv", "apple_music", "csv"}:
        return parse_apple_music_csv(text)
    raise ParseError(f"Unsupported migration format: {format_name!r}")
