# ruff: noqa: F821
"""Frozen pre-optimization selector from e6b1a4e, used for equivalence checks.

The harness binds this function to the current catalog helpers so this fixture
only fixes the selection algorithm, not unrelated payload or ranking contracts.
"""
from __future__ import annotations
from typing import Any

def _local_catalog(query: str, limit: int) -> list[dict[str, Any]]:
    """The best local matches per shape, instead of the first N in library order.

    Two things were wrong here. Tracks, artists and albums drew on one shared
    budget and the scan stopped at the first match past it, so in a large library
    the artist you were searching for could sit behind two dozen of their own
    songs and never be emitted at all. And the match test was a substring of
    ``"title artist album"`` joined together, which matched across field
    boundaries.

    Scoring runs on the raw strings and only the winners are materialised: each
    `_catalog_item` embeds a full `track.to_dict()`, so building one per match
    would mean tens of thousands of them per keystroke on a big library.

    `limit` is accepted so this reads like the other providers, and ignored: the
    per-shape budgets below are what bound the output.
    """
    q_folded = fold_text(query)
    q_tokens = frozenset(match_tokens(query))
    scored: list[tuple[float, str, Any]] = []
    artists: dict[str, tuple[float, str, Any]] = {}
    albums: dict[str, tuple[float, str, Any]] = {}

    def score(value: object, *, coverage: bool) -> float:
        return _text_score(
            q_folded, q_tokens, value,
            _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=coverage,
        )

    for track in _library_tracks():
        title = getattr(track, "title", "") or ""
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        album = getattr(track, "album", "") or ""
        title_score = score(title, coverage=True)
        artist_score = score(artist, coverage=False)
        album_score = score(album, coverage=False)
        if not (title_score or artist_score or album_score):
            continue
        track_id = str(getattr(track, "id", ""))
        scored.append((title_score * 2 + artist_score + album_score, track_id, track))
        if artist and artist_score:
            key = fold_text(artist)
            if artist_score > artists.get(key, (0.0, "", None))[0]:
                artists[key] = (artist_score, artist, track)
        if album and (album_score or artist_score):
            key = f"{fold_text(artist)}\x00{fold_text(album)}"
            weight = max(album_score, artist_score)
            if weight > albums.get(key, (0.0, "", None))[0]:
                albums[key] = (weight, album, track)

    out: list[dict[str, Any]] = []
    best_tracks = sorted(scored, key=lambda row: (-row[0], row[1]))[:_LOCAL_TRACK_BUDGET]
    for _, _, track in best_tracks:
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            _catalog_item(
                item_id=f"library:track:{track.id}",
                item_type="library_track",
                source="library",
                title=getattr(track, "title", "") or "",
                subtitle=artist,
                artist=artist,
                album=getattr(track, "album", "") or "",
                duration=_duration(getattr(track, "duration", None)),
                cover=_cover_from_track(track),
                track_id=track.id,
                external_ids={
                    "youtube_id": getattr(track, "youtube_id", None),
                    "isrc": getattr(track, "isrc", None),
                    "musicbrainz_id": getattr(track, "musicbrainz_id", None),
                },
                in_library=True,
                playable=True,
                downloadable=False,
                raw=_track_dict(track),
            )
        )

    for key, (_, name, track) in sorted(artists.items(), key=lambda kv: (-kv[1][0], kv[0]))[:_LOCAL_ENTITY_BUDGET]:
        out.append(
            _catalog_item(
                item_id=f"library:artist:{key}",
                item_type="artist",
                source="library",
                title=name,
                subtitle="",
                artist=name,
                cover=_cover_from_track(track),
                track_id=None,
                in_library=True,
                playable=False,
                downloadable=False,
                raw={"artist": name},
            )
        )

    for key, (_, name, track) in sorted(albums.items(), key=lambda kv: (-kv[1][0], kv[0]))[:_LOCAL_ENTITY_BUDGET]:
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            _catalog_item(
                item_id=f"library:album:{key}",
                item_type="album",
                source="library",
                title=name,
                subtitle=artist,
                artist=artist,
                album=name,
                cover=_cover_from_track(track),
                in_library=True,
                playable=False,
                downloadable=False,
                raw={"artist": artist, "album": name},
            )
        )
    # Deliberately not truncated by `limit`: the per-shape budgets above already
    # bound this at 40 rows, and slicing here would cut the entity rows off the
    # end again — the exact bug this rewrite exists to fix.
    return out
