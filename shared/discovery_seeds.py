"""Shared discovery seed selection and per-user rotation memory."""

from __future__ import annotations

from collections import OrderedDict
import threading

from shared.discovery_intelligence import (
    artist_recommendation_multiplier,
    load_listening_event_rollups,
)
from shared.text_utils import fold_text
from shared.user_context import current_user_id, user_context

_MAX_TRACKED_USERS = 128
_MAX_RECENT_TASTE_SEEDS = 10
_MAX_RECENT_GRAPH_SEEDS = 12
_DEFAULT_ROTATION_PENALTY = 0.02
_DEEZER_ARTIST_KEY_PREFIX = "artist:deezer:"

_SEED_LOCK = threading.Lock()
_RECENT_TASTE_SEEDS: OrderedDict[str, list[str]] = OrderedDict()
_RECENT_GRAPH_SEEDS: OrderedDict[str, list[str]] = OrderedDict()


def _scope_key(user_id: str | None) -> str:
    resolved = user_id if user_id is not None else current_user_id()
    return str(resolved or "__default__")


def _get_recent(store: OrderedDict[str, list[str]], user_id: str | None) -> set[str]:
    scope = _scope_key(user_id)
    with _SEED_LOCK:
        values = store.get(scope)
        if not values:
            return set()
        store.move_to_end(scope)
        return set(values)


def _record_recent(
    store: OrderedDict[str, list[str]],
    user_id: str | None,
    entries: list[str],
    max_entries: int,
) -> None:
    cleaned = [entry for entry in dict.fromkeys(entries) if entry]
    if not cleaned:
        return
    scope = _scope_key(user_id)
    with _SEED_LOCK:
        existing = store.get(scope, [])
        merged = [*cleaned, *[item for item in existing if item not in cleaned]][:max_entries]
        store[scope] = merged
        store.move_to_end(scope)
        while len(store) > _MAX_TRACKED_USERS:
            store.popitem(last=False)


def record_recent_taste_seeds(user_id: str | None, artists: list[str]) -> None:
    """Remember recently used artist seeds (stored as diacritic-folded keys)."""
    _record_recent(
        _RECENT_TASTE_SEEDS,
        user_id,
        [fold_text(name) for name in artists if fold_text(name)],
        _MAX_RECENT_TASTE_SEEDS,
    )


def record_recent_graph_seeds(user_id: str | None, track_ids: list[str]) -> None:
    """Remember recently used library track seeds for graph/feed rotation."""
    _record_recent(
        _RECENT_GRAPH_SEEDS,
        user_id,
        [str(track_id).strip() for track_id in track_ids if str(track_id).strip()],
        _MAX_RECENT_GRAPH_SEEDS,
    )


def clear_recent_seeds(user_id: str | None = None, *, clear_all: bool = False) -> None:
    """Clear seed rotation history for one account or all tracked accounts."""
    with _SEED_LOCK:
        if clear_all:
            _RECENT_TASTE_SEEDS.clear()
            _RECENT_GRAPH_SEEDS.clear()
            return
        scope = _scope_key(user_id)
        _RECENT_TASTE_SEEDS.pop(scope, None)
        _RECENT_GRAPH_SEEDS.pop(scope, None)


def load_saved_entity_artists(user_id: str | None = None) -> list[dict[str, str]]:
    """Return artist seeds extracted from bookmarked artists and albums, newest first."""
    try:
        from player.saved_entities import get_entries

        if user_id is not None:
            with user_context(user_id):
                entries = get_entries()
        else:
            entries = get_entries()
    except Exception:
        return []

    out: list[dict[str, str]] = []
    by_folded: dict[str, dict[str, str]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("kind") or "").strip()
        if kind == "artist":
            name = str(entry.get("name") or "").strip()
            deezer_id = ""
            for key in entry.get("keys") or ():
                if isinstance(key, str) and key.startswith(_DEEZER_ARTIST_KEY_PREFIX):
                    candidate = key[len(_DEEZER_ARTIST_KEY_PREFIX):].strip()
                    if candidate.isdigit():
                        deezer_id = candidate
                        break
        elif kind == "album":
            name = str(entry.get("artist") or "").strip()
            deezer_id = ""
        else:
            continue
        folded = fold_text(name)
        if not folded:
            continue
        existing = by_folded.get(folded)
        if existing is not None:
            if kind == "artist" and existing["kind"] != "artist":
                existing["kind"] = "artist"
                existing["name"] = name
            if deezer_id and not existing["deezer_id"]:
                existing["deezer_id"] = deezer_id
            continue
        item = {"name": name, "deezer_id": deezer_id, "kind": kind}
        by_folded[folded] = item
        out.append(item)
    return out


def select_taste_artists(
    metadata,
    fav_ids: list[str],
    limit: int = 5,
    *,
    user_id: str | None = None,
    rotate: bool = False,
    penalty: float = _DEFAULT_ROTATION_PENALTY,
) -> list[str]:
    """Rank taste seed artists across favourites, bookmarks, playlists, library, and listens."""
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    rollup = load_listening_event_rollups()
    saved_artists = load_saved_entity_artists(user_id)
    by_id = {track.id: track for track in tracks}
    scores: dict[str, float] = {}
    display: dict[str, str] = {}

    def add_artist(raw: object, score: float, *, title_fallback: bool = False) -> None:
        name = str(raw or "").strip()
        key = fold_text(name)
        if not key:
            return
        scores[key] = scores.get(key, 0.0) + score
        display.setdefault(key, name.title() if title_fallback else name)

    for idx, tid in enumerate(fav_ids):
        track = by_id.get(str(tid))
        if track:
            add_artist(track.album_artist or track.artist, 9.0 - min(idx, 8) * 0.35)

    for idx, saved in enumerate(saved_artists):
        if saved["kind"] == "artist":
            add_artist(saved["name"], 8.5 - min(idx, 8) * 0.35)
        else:
            add_artist(saved["name"], 5.5 - min(idx, 8) * 0.25)

    playlists = metadata.playlists if metadata and isinstance(metadata.playlists, dict) else {}
    playlist_track_ids: set[str] = set()
    for ids in playlists.values():
        if isinstance(ids, list):
            playlist_track_ids.update(str(x) for x in ids)
    for tid in playlist_track_ids:
        track = by_id.get(tid)
        if track:
            add_artist(track.album_artist or track.artist, 3.0)

    artist_counts: dict[str, int] = {}
    for track in tracks:
        name = str(track.album_artist or track.artist or "").strip()
        key = fold_text(name)
        if not key:
            continue
        artist_counts[key] = artist_counts.get(key, 0) + 1
        display.setdefault(key, name)
    for key, count in artist_counts.items():
        scores[key] = scores.get(key, 0.0) + min(8.0, count * 1.4)

    for raw_key, count in rollup.artist_plays.items():
        add_artist(raw_key, min(12.0, count * 2.0), title_fallback=True)
    for raw_key, count in rollup.artist_saves.items():
        add_artist(raw_key, min(10.0, count * 3.0), title_fallback=True)

    for key in list(scores):
        mult = _artist_seed_multiplier(key, user_id)
        if mult < 1.0:
            scores[key] *= mult * 0.25

    if rotate:
        recent = _get_recent(_RECENT_TASTE_SEEDS, user_id)
        for key in recent:
            if key in scores:
                scores[key] *= penalty

    ranked = sorted(scores, key=lambda key: scores[key], reverse=True)
    return [display[key] for key in ranked[:limit] if display.get(key)]


def _artist_seed_multiplier(artist: str, user_id: str | None = None, *, deezer_artist_id: str = "") -> float:
    try:
        if user_id is not None:
            with user_context(user_id):
                return artist_recommendation_multiplier(artist, deezer_artist_id=deezer_artist_id)
        return artist_recommendation_multiplier(artist, deezer_artist_id=deezer_artist_id)
    except Exception:
        return 1.0


def select_release_seed_artists(
    metadata,
    fav_ids: list[str],
    limit: int = 8,
    *,
    user_id: str | None = None,
) -> list[dict[str, str]]:
    """Return unrotated artist seeds for release-radar checks, prioritizing bookmarks."""
    saved_artists = load_saved_entity_artists(user_id)
    deezer_by_folded = {
        fold_text(item["name"]): item["deezer_id"]
        for item in saved_artists
        if fold_text(item["name"]) and item["deezer_id"]
    }

    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def push(name: str, deezer_id: str = "") -> None:
        if len(out) >= limit:
            return
        folded = fold_text(name)
        if not folded or folded in seen:
            return
        seen.add(folded)
        out.append({"name": name, "deezer_id": deezer_id or deezer_by_folded.get(folded, "")})

    for kind in ("artist", "album"):
        for item in saved_artists:
            if item["kind"] == kind:
                push(item["name"], item["deezer_id"])

    for name in select_taste_artists(metadata, fav_ids, limit=limit, user_id=user_id, rotate=False):
        push(name)

    out.sort(
        key=lambda item: _artist_seed_multiplier(
            item["name"],
            user_id,
            deezer_artist_id=item["deezer_id"],
        ),
        reverse=True,
    )
    return out[:limit]


def select_graph_seed_tracks(
    metadata,
    fav_ids: list[str],
    limit: int = 8,
    *,
    user_id: str | None = None,
    rotate: bool = False,
    require_youtube_id: bool = False,
    penalty: float = _DEFAULT_ROTATION_PENALTY,
) -> list:
    """Rank non-podcast library tracks as graph expansion seeds with soft rotation."""
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    if not tracks:
        return []

    rollup = load_listening_event_rollups()
    recent_artists = {fold_text(name) for name in rollup.recent_artists if fold_text(name)}
    recent_seeds = _get_recent(_RECENT_GRAPH_SEEDS, user_id) if rotate else set()
    fav_order = {str(tid): idx for idx, tid in enumerate(fav_ids)}

    # Sort newest first with stable original order tiebreak before scoring.
    indexed = sorted(
        enumerate(tracks),
        key=lambda pair: (str(getattr(pair[1], "added_at", None) or ""), pair[0]),
        reverse=True,
    )

    scored: list[tuple[float, int, object]] = []
    for recency_rank, (_, track) in enumerate(indexed):
        if getattr(track, "media_kind", None) == "podcast_episode":
            continue
        if require_youtube_id and not str(getattr(track, "youtube_id", "") or "").strip():
            continue
        if not require_youtube_id and (
            not str(getattr(track, "artist", "") or "").strip()
            or not str(getattr(track, "title", "") or "").strip()
        ):
            continue

        score = 1.0 / (1.0 + recency_rank * 0.05)
        tid = str(getattr(track, "id", "") or "")
        if tid in fav_order:
            score += 2.0 + max(0.0, 0.2 - fav_order[tid] * 0.01)
        artist_key = fold_text(
            getattr(track, "album_artist", None) or getattr(track, "artist", None)
        )
        if artist_key and artist_key in recent_artists:
            score += 1.0
        if rotate and tid in recent_seeds:
            score *= penalty
        scored.append((score, recency_rank, track))

    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return [track for _, _, track in scored[:limit]]
