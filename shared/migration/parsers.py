from __future__ import annotations

import csv
import io
import json
import plistlib
import re
import zipfile
from xml.parsers.expat import ExpatError
from pathlib import Path
from typing import Any, Iterable

from shared.migration.models import MigrationManifest, SourcePlaylist, SourceTrack
from shared.text_utils import collapse_text


def _clean(value: Any, limit: int = 500) -> str:
    return collapse_text(value, limit)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = 100
MAX_MEMBER_BYTES = 25 * 1024 * 1024
_LIKED_NAMES = {
    "liked songs",
    "your liked songs",
    "saved songs",
    "tus me gusta",
    "canciones que te gustan",
    "titres likés",
    "titres favoris",
}


class ParseError(ValueError):
    """Raised when an uploaded export cannot be interpreted safely."""




def _integer(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _source_id(uri: str) -> str:
    value = _clean(uri, 1000)
    if ":" in value:
        return value.rsplit(":", 1)[-1]
    if "/" in value:
        return value.rstrip("/").rsplit("/", 1)[-1].split("?", 1)[0]
    return value


def _put_track(manifest: MigrationManifest, track: SourceTrack) -> str:
    key = track.key(manifest.provider)
    if key not in manifest.tracks:
        manifest.tracks[key] = track
    return key


def _spotify_track(raw: Any) -> SourceTrack | None:
    if not isinstance(raw, dict):
        return None
    title = _clean(raw.get("trackName") or raw.get("name") or raw.get("track_name") or raw.get("title"))
    if not title:
        return None
    artist_names: list[str] = []
    if isinstance(raw.get("artists"), list):
        for artist in raw["artists"]:
            name = _clean(artist.get("name") if isinstance(artist, dict) else artist)
            if name:
                artist_names.append(name)
    artist = ", ".join(artist_names) or _clean(raw.get("artistName") or raw.get("artist"))
    album_obj = raw.get("album")
    album = _clean(album_obj.get("name") if isinstance(album_obj, dict) else raw.get("albumName") or album_obj)
    uri = _clean(raw.get("trackUri") or raw.get("uri") or raw.get("external_url"), 1000)
    external_ids = raw.get("external_ids") if isinstance(raw.get("external_ids"), dict) else {}
    return SourceTrack(
        title=title,
        artist=artist,
        album=album,
        source_id=_clean(raw.get("id") or _source_id(uri)),
        source_uri=uri,
        duration=max(_integer(raw.get("duration_ms")) // 1000, _integer(raw.get("duration"))),
        isrc=_clean(external_ids.get("isrc"), 32),
        added_at=_clean(raw.get("addedDate") or raw.get("added_at"), 80),
        local_only=bool(raw.get("is_local")),
    )


def _spotify_item_track(item: Any) -> SourceTrack | None:
    if not isinstance(item, dict):
        return None
    if isinstance(item.get("track"), dict):
        merged = dict(item["track"])
        merged.setdefault("addedDate", item.get("addedDate") or item.get("added_at"))
        return _spotify_track(merged)
    if isinstance(item.get("localTrack"), dict):
        raw = item["localTrack"]
        return SourceTrack(
            title=_clean(raw.get("trackName") or raw.get("name")),
            artist=_clean(raw.get("artistName") or raw.get("artist")),
            album=_clean(raw.get("albumName") or raw.get("album")),
            added_at=_clean(item.get("addedDate"), 80),
            local_only=True,
        )
    return _spotify_track(item)


def _spotify_manifest(data: Any, source_name: str) -> MigrationManifest:
    manifest = MigrationManifest(provider="spotify", source_name=source_name)
    if isinstance(data, dict) and isinstance(data.get("playlists"), list):
        playlists_raw = data["playlists"]
    elif isinstance(data, dict) and "tracks" in data:
        tracks = data.get("tracks")
        items = tracks.get("items", []) if isinstance(tracks, dict) else tracks
        playlists_raw = [{"name": source_name, "items": items}]
    elif isinstance(data, list):
        playlists_raw = [{"name": source_name, "items": data}]
    elif isinstance(data, dict):
        playlists_raw = [{"name": source_name, "items": [data]}]
    else:
        playlists_raw = []

    for index, raw_playlist in enumerate(playlists_raw):
        if not isinstance(raw_playlist, dict):
            continue
        name = _clean(raw_playlist.get("name")) or f"Playlist {index + 1}"
        source_id = _clean(raw_playlist.get("id") or raw_playlist.get("uri")) or f"playlist-{index}"
        raw_items = raw_playlist.get("items")
        if raw_items is None and isinstance(raw_playlist.get("tracks"), dict):
            raw_items = raw_playlist["tracks"].get("items")
        if not isinstance(raw_items, list):
            raw_items = []
        keys: list[str] = []
        for item in raw_items:
            track = _spotify_item_track(item)
            if track and track.title:
                keys.append(_put_track(manifest, track))
        liked = name.casefold() in _LIKED_NAMES
        manifest.playlists.append(
            SourcePlaylist(
                source_id=source_id,
                name=name,
                track_keys=keys,
                description=_clean(raw_playlist.get("description"), 2000),
                is_favourites=liked,
            )
        )
        if liked:
            manifest.library_keys.extend(keys)
            manifest.favourite_keys.extend(keys)

    if not manifest.tracks:
        raise ParseError("No songs were found in the Spotify export")
    if not manifest.library_keys:
        manifest.library_keys.extend(manifest.tracks)
    return manifest


def parse_spotify_json(text: str, source_name: str = "Spotify import") -> list[SourceTrack]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ParseError(f"Invalid JSON: {exc}") from exc
    return list(_spotify_manifest(data, source_name).tracks.values())


def parse_spotify_manifest(text: str, source_name: str = "Spotify import") -> MigrationManifest:
    try:
        return _spotify_manifest(json.loads(text), source_name)
    except json.JSONDecodeError as exc:
        raise ParseError(f"Invalid JSON: {exc}") from exc


def _normalize_header(header: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "" for ch in header)


def _tabular_manifest(text: str, source_name: str, provider: str = "apple_music") -> MigrationManifest:
    if not text.strip():
        raise ParseError("The text export is empty")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel_tab if "\t" in sample else csv.excel
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), dialect=dialect)
    if not reader.fieldnames:
        raise ParseError("The export has no header row")
    norm_map = {_normalize_header(header): header for header in reader.fieldnames if header}

    def pick(*names: str) -> str | None:
        return next((norm_map[_normalize_header(name)] for name in names if _normalize_header(name) in norm_map), None)

    title_col = pick("name", "track name", "title", "song", "track")
    artist_col = pick("artist", "album artist", "artist name")
    album_col = pick("album", "album name")
    duration_col = pick("total time", "duration", "duration ms", "time")
    persistent_col = pick("persistent id", "track id", "id")
    loved_col = pick("loved", "favorite", "favourite")
    if not title_col:
        raise ParseError("The export needs a Name, Title, or Track column")

    manifest = MigrationManifest(provider=provider, source_name=source_name)
    keys: list[str] = []
    for row in reader:
        title = _clean(row.get(title_col))
        if not title:
            continue
        raw_duration = _integer(row.get(duration_col)) if duration_col else 0
        track = SourceTrack(
            title=title,
            artist=_clean(row.get(artist_col)) if artist_col else "",
            album=_clean(row.get(album_col)) if album_col else "",
            source_id=_clean(row.get(persistent_col)) if persistent_col else "",
            duration=raw_duration // 1000 if raw_duration > 10000 else raw_duration,
        )
        keys.append(_put_track(manifest, track))
        if loved_col and _clean(row.get(loved_col)).casefold() in {"1", "true", "yes", "y", "loved"}:
            manifest.favourite_keys.append(keys[-1])
    if not keys:
        raise ParseError("No songs were found in the text export")
    manifest.library_keys = list(keys)
    manifest.playlists = [SourcePlaylist(source_id="playlist-0", name=source_name, track_keys=keys)]
    return manifest


def parse_apple_music_csv(text: str) -> list[SourceTrack]:
    return list(_tabular_manifest(text, "Apple Music import").tracks.values())


def _apple_manifest(data: Any, source_name: str) -> MigrationManifest:
    if not isinstance(data, dict) or not isinstance(data.get("Tracks"), dict):
        raise ParseError("This is not an Apple Music/iTunes library XML export")
    manifest = MigrationManifest(provider="apple_music", source_name=source_name)
    apple_keys: dict[str, str] = {}
    for track_id, raw in data["Tracks"].items():
        if not isinstance(raw, dict):
            continue
        kind = _clean(raw.get("Kind")).casefold()
        if raw.get("Podcast") or "podcast" in kind or raw.get("Movie") or raw.get("Music Video"):
            continue
        title = _clean(raw.get("Name"))
        if not title:
            continue
        track = SourceTrack(
            title=title,
            artist=_clean(raw.get("Artist") or raw.get("Album Artist")),
            album=_clean(raw.get("Album")),
            source_id=_clean(raw.get("Persistent ID") or track_id),
            duration=_integer(raw.get("Total Time")) // 1000,
            added_at=_clean(raw.get("Date Added"), 80),
            local_only=str(raw.get("Track Type") or "").casefold() == "file",
        )
        key = _put_track(manifest, track)
        apple_keys[str(track_id)] = key
        manifest.library_keys.append(key)
        if raw.get("Loved") is True:
            manifest.favourite_keys.append(key)

    for index, raw_playlist in enumerate(data.get("Playlists") or []):
        if not isinstance(raw_playlist, dict):
            continue
        if raw_playlist.get("Master") or raw_playlist.get("Smart Info") or raw_playlist.get("Distinguished Kind"):
            continue
        name = _clean(raw_playlist.get("Name"))
        if not name:
            continue
        keys = [
            apple_keys[str(item.get("Track ID"))]
            for item in raw_playlist.get("Playlist Items") or []
            if isinstance(item, dict) and str(item.get("Track ID")) in apple_keys
        ]
        manifest.playlists.append(
            SourcePlaylist(
                source_id=_clean(raw_playlist.get("Playlist Persistent ID")) or f"playlist-{index}",
                name=name,
                track_keys=keys,
                is_favourites=name.casefold() in _LIKED_NAMES,
            )
        )
        if name.casefold() in _LIKED_NAMES:
            manifest.favourite_keys.extend(keys)
    if not manifest.tracks:
        raise ParseError("No music tracks were found in the Apple Music export")
    return manifest


def parse_apple_music_xml(payload: bytes, source_name: str) -> MigrationManifest:
    try:
        return _apple_manifest(plistlib.loads(payload), source_name)
    except (plistlib.InvalidFileException, ExpatError, ValueError, TypeError) as exc:
        raise ParseError(f"Invalid Apple Music XML: {exc}") from exc


def _merge_manifests(manifests: Iterable[MigrationManifest], source_name: str) -> MigrationManifest:
    merged = MigrationManifest(provider="spotify", source_name=source_name)
    playlist_ids: set[str] = set()
    for manifest in manifests:
        merged.tracks.update({key: value for key, value in manifest.tracks.items() if key not in merged.tracks})
        for playlist in manifest.playlists:
            candidate = playlist.source_id
            suffix = 2
            while candidate in playlist_ids:
                candidate = f"{playlist.source_id}-{suffix}"
                suffix += 1
            playlist.source_id = candidate
            playlist_ids.add(candidate)
            merged.playlists.append(playlist)
        merged.library_keys.extend(manifest.library_keys)
        merged.favourite_keys.extend(manifest.favourite_keys)
        merged.warnings.extend(manifest.warnings)
    if not merged.tracks:
        raise ParseError("No supported Spotify playlist data was found in the archive")
    return merged


def _zip_manifest(payload: bytes, source_name: str) -> MigrationManifest:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise ParseError("The uploaded ZIP is invalid") from exc
    infos = [info for info in archive.infolist() if not info.is_dir()]
    if len(infos) > MAX_ARCHIVE_FILES:
        raise ParseError(f"The archive contains too many files (maximum {MAX_ARCHIVE_FILES})")
    manifests: list[MigrationManifest] = []
    for info in infos:
        if info.file_size > MAX_MEMBER_BYTES:
            raise ParseError(f"{Path(info.filename).name} is too large")
        if info.compress_size and info.file_size / info.compress_size > 200:
            raise ParseError(f"{Path(info.filename).name} has an unsafe compression ratio")
        name = Path(info.filename).name
        if not name.lower().endswith(".json") or not re.search(r"playlist", name, re.I):
            continue
        try:
            manifests.append(parse_spotify_manifest(archive.read(info).decode("utf-8-sig"), Path(name).stem))
        except (UnicodeDecodeError, ParseError):
            continue
    return _merge_manifests(manifests, source_name)


def parse_upload(filename: str, payload: bytes) -> MigrationManifest:
    """Autodetect an official Spotify or Apple Music export."""
    if not payload:
        raise ParseError("The uploaded file is empty")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise ParseError(f"The uploaded file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    name = Path(filename or "import").name
    suffix = Path(name).suffix.casefold()
    stem = Path(name).stem or "Imported"
    if suffix == ".zip" or payload.startswith(b"PK\x03\x04"):
        return _zip_manifest(payload, stem)
    if suffix in {".xml", ".plist"} or payload.lstrip().startswith((b"<?xml", b"<plist")):
        return parse_apple_music_xml(payload, stem)
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = payload.decode("utf-16")
        except UnicodeDecodeError as exc:
            raise ParseError("The export is not valid UTF-8 or UTF-16 text") from exc
    if suffix == ".json" or text.lstrip().startswith(("{", "[")):
        return parse_spotify_manifest(text, stem)
    return _tabular_manifest(text, stem)


def parse_export(format_name: str, text: str) -> list[SourceTrack]:
    """Compatibility dispatcher retained for the legacy preview endpoint."""
    key = (format_name or "").strip().lower().replace("-", "_")
    if key in {"spotify_json", "spotify", "spotify_playlist"}:
        return parse_spotify_json(text)
    if key in {"apple_music_csv", "apple_music", "csv", "apple_music_text"}:
        return parse_apple_music_csv(text)
    if key in {"apple_music_xml", "xml"}:
        return list(parse_apple_music_xml(text.encode("utf-8"), "Apple Music import").tracks.values())
    raise ParseError(f"Unsupported migration format: {format_name!r}")
