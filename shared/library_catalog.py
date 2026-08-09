"""Deterministic artist and album entities derived from library tracks.

The per-account SQLite library is authoritative. This module gives its track
rows a normalized catalog projection without teaching the database to
guess structure that the source did not provide.  In particular, a legacy
``artist`` display string is one artist; only ``Track.artists`` can describe
several performers.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass
from typing import Iterable

from shared.models import Track


_CATALOG_NAMESPACE = uuid.UUID("5274f9d0-7ca4-5a61-9234-cdf923fd8e5d")
_WHITESPACE = re.compile(r"\s+")
_VARIOUS_ARTISTS = "Various Artists"


def entity_key(value: object) -> str:
    """Exact-ish identity key: Unicode/case/spacing insensitive, not fuzzy."""
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    return _WHITESPACE.sub(" ", text).casefold()


def _clean(value: object) -> str:
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", str(value or "")).strip())


def artist_id(name: str) -> str:
    return str(uuid.uuid5(_CATALOG_NAMESPACE, f"artist:{entity_key(name)}"))


def album_id(title: str, album_artist: str) -> str:
    return str(
        uuid.uuid5(
            _CATALOG_NAMESPACE,
            f"album:{entity_key(album_artist)}\x00{entity_key(title)}",
        )
    )


def track_artists(track: Track) -> list[str]:
    """Return ordered, de-duplicated performers without parsing display text."""
    raw = track.artists if isinstance(track.artists, list) and track.artists else [track.artist]
    names: list[str] = []
    seen: set[str] = set()
    for value in raw:
        name = _clean(value)
        key = entity_key(name)
        if name and key and key not in seen:
            names.append(name)
            seen.add(key)
    return names


@dataclass(frozen=True)
class ArtistEntity:
    id: str
    name: str
    name_key: str


@dataclass(frozen=True)
class AlbumEntity:
    id: str
    title: str
    title_key: str
    album_artist_id: str
    album_artist: str
    year: int | None
    genre: str | None
    is_compilation: bool


@dataclass(frozen=True)
class TrackCatalogLink:
    track_id: str
    album_id: str | None
    artist_ids: tuple[str, ...]


@dataclass(frozen=True)
class CatalogSnapshot:
    artists: tuple[ArtistEntity, ...]
    albums: tuple[AlbumEntity, ...]
    tracks: tuple[TrackCatalogLink, ...]


def album_identity(track: Track, performers: list[str] | None = None) -> tuple[str | None, str, str]:
    """``(album id, album title, album artist)`` for one track.

    The single definition of which release a track belongs to. Callers that
    only need to *name* the album a track is on — a serializer, an API
    response — ask here instead of re-deriving the rule and drifting from the
    projection that actually built the row.
    """
    title = _clean(track.album)
    if not title:
        return None, "", ""
    if track.is_compilation and not _clean(track.album_artist):
        album_artist = _VARIOUS_ARTISTS
    else:
        names = performers if performers is not None else track_artists(track)
        album_artist = _clean(track.album_artist) or (names[0] if names else _clean(track.artist))
    if not album_artist:
        return None, "", ""
    return album_id(title, album_artist), title, album_artist


def _prefer_display(current: str, candidate: str) -> str:
    """Choose deterministically when equivalent spellings differ only in case."""
    if not current:
        return candidate
    return min((current, candidate), key=lambda value: (value.casefold(), value))


def build_catalog_snapshot(tracks: Iterable[Track]) -> CatalogSnapshot:
    """Project flat tracks into deterministic normalized catalog rows."""
    artist_names: dict[str, str] = {}
    albums: dict[str, AlbumEntity] = {}
    links: list[TrackCatalogLink] = []

    for track in tracks:
        # A podcast episode shares the manifest with songs but is not one. Left
        # in, a show becomes an album and its host becomes an artist — wrong in
        # the player and wrong for every client that browses this catalog. The
        # link is still emitted so a track that changes kind loses its old one.
        if getattr(track, "media_kind", None) == "podcast_episode":
            links.append(TrackCatalogLink(track_id=track.id, album_id=None, artist_ids=()))
            continue

        performers = track_artists(track)
        performer_ids: list[str] = []
        for name in performers:
            identifier = artist_id(name)
            artist_names[identifier] = _prefer_display(artist_names.get(identifier, ""), name)
            performer_ids.append(identifier)

        resolved_album_id, title, album_artist = album_identity(track, performers)
        if resolved_album_id:
            album_artist_identifier = artist_id(album_artist)
            artist_names[album_artist_identifier] = _prefer_display(
                artist_names.get(album_artist_identifier, ""), album_artist
            )
            candidate = AlbumEntity(
                id=resolved_album_id,
                title=title,
                title_key=entity_key(title),
                album_artist_id=album_artist_identifier,
                album_artist=album_artist,
                year=int(track.year) if track.year else None,
                genre=_clean(track.genre) or None,
                is_compilation=bool(track.is_compilation),
            )
            existing = albums.get(resolved_album_id)
            if existing is None:
                albums[resolved_album_id] = candidate
            else:
                albums[resolved_album_id] = AlbumEntity(
                    id=existing.id,
                    title=_prefer_display(existing.title, candidate.title),
                    title_key=existing.title_key,
                    album_artist_id=existing.album_artist_id,
                    album_artist=_prefer_display(existing.album_artist, candidate.album_artist),
                    year=existing.year if existing.year is not None else candidate.year,
                    genre=existing.genre if existing.genre is not None else candidate.genre,
                    is_compilation=existing.is_compilation or candidate.is_compilation,
                )

        links.append(
            TrackCatalogLink(
                track_id=track.id,
                album_id=resolved_album_id,
                artist_ids=tuple(performer_ids),
            )
        )

    artists = tuple(
        ArtistEntity(identifier, name, entity_key(name))
        for identifier, name in sorted(artist_names.items())
    )
    return CatalogSnapshot(
        artists=artists,
        albums=tuple(albums[key] for key in sorted(albums)),
        tracks=tuple(links),
    )
