from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from shared.text_utils import collapse_text


def _clean(value: Any, limit: int = 500) -> str:
    return collapse_text(value, limit)


def metadata_key(title: str, artist: str, album: str = "") -> str:
    raw = json.dumps(
        [_clean(title).casefold(), _clean(artist).casefold(), _clean(album).casefold()],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


@dataclass(frozen=True)
class SourceTrack:
    """One distinct track from a user's external-library export."""

    title: str
    artist: str
    album: str = ""
    source_id: str = ""
    source_uri: str = ""
    duration: int = 0
    isrc: str = ""
    added_at: str = ""
    local_only: bool = False
    # Where a catalog collection places the song, and the identities its row
    # answers to. Exports carry none of these; they stay out of `to_dict` when
    # empty so an export's fingerprint is what it always was.
    album_artist: str = ""
    track_number: int = 0
    disc_number: int = 0
    year: int = 0
    identity_keys: tuple[str, ...] = ()

    def key(self, provider: str = "external") -> str:
        identity = self.source_id or self.source_uri or metadata_key(self.title, self.artist, self.album)
        return f"{provider}:{identity}"

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "title": _clean(self.title),
            "artist": _clean(self.artist),
            "album": _clean(self.album),
            "source_id": _clean(self.source_id),
            "source_uri": _clean(self.source_uri, 1000),
            "duration": max(0, int(self.duration or 0)),
            "isrc": _clean(self.isrc, 32),
            "added_at": _clean(self.added_at, 80),
            "local_only": bool(self.local_only),
        }
        if self.album_artist:
            out["album_artist"] = _clean(self.album_artist)
        for name in ("track_number", "disc_number", "year"):
            value = _whole(getattr(self, name))
            if value:
                out[name] = value
        if self.identity_keys:
            out["identity_keys"] = list(_identity_keys(self.identity_keys))
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceTrack":
        return cls(
            title=_clean(data.get("title")),
            artist=_clean(data.get("artist")),
            album=_clean(data.get("album")),
            source_id=_clean(data.get("source_id")),
            source_uri=_clean(data.get("source_uri"), 1000),
            duration=max(0, int(data.get("duration") or 0)),
            isrc=_clean(data.get("isrc"), 32),
            added_at=_clean(data.get("added_at"), 80),
            local_only=bool(data.get("local_only")),
            album_artist=_clean(data.get("album_artist")),
            track_number=_whole(data.get("track_number")),
            disc_number=_whole(data.get("disc_number")),
            year=_whole(data.get("year")),
            identity_keys=_identity_keys(data.get("identity_keys")),
        )


def _whole(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _identity_keys(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    keys: list[str] = []
    for key in value:
        key = _clean(key, 200)
        if key and ":" in key and key not in keys:
            keys.append(key)
    return tuple(keys[:16])


@dataclass
class SourcePlaylist:
    source_id: str
    name: str
    track_keys: list[str] = field(default_factory=list)
    description: str = ""
    is_favourites: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "name": self.name,
            "track_keys": list(self.track_keys),
            "description": self.description,
            "is_favourites": self.is_favourites,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourcePlaylist":
        return cls(
            source_id=_clean(data.get("source_id"), 300),
            name=_clean(data.get("name")) or "Imported",
            track_keys=[str(x) for x in data.get("track_keys") or [] if str(x)],
            description=_clean(data.get("description"), 2000),
            is_favourites=bool(data.get("is_favourites")),
        )


@dataclass
class MigrationManifest:
    provider: str
    source_name: str
    tracks: dict[str, SourceTrack] = field(default_factory=dict)
    playlists: list[SourcePlaylist] = field(default_factory=list)
    library_keys: list[str] = field(default_factory=list)
    favourite_keys: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "source_name": self.source_name,
            "tracks": {key: track.to_dict() for key, track in self.tracks.items()},
            "playlists": [playlist.to_dict() for playlist in self.playlists],
            "library_keys": list(dict.fromkeys(self.library_keys)),
            "favourite_keys": list(dict.fromkeys(self.favourite_keys)),
            "warnings": list(dict.fromkeys(self.warnings)),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MigrationManifest":
        return cls(
            provider=_clean(data.get("provider"), 40) or "external",
            source_name=_clean(data.get("source_name")) or "Import",
            tracks={
                str(key): SourceTrack.from_dict(value)
                for key, value in (data.get("tracks") or {}).items()
                if isinstance(value, dict)
            },
            playlists=[
                SourcePlaylist.from_dict(value)
                for value in data.get("playlists") or []
                if isinstance(value, dict)
            ],
            library_keys=[str(x) for x in data.get("library_keys") or [] if str(x)],
            favourite_keys=[str(x) for x in data.get("favourite_keys") or [] if str(x)],
            warnings=[_clean(x, 1000) for x in data.get("warnings") or [] if _clean(x)],
        )
