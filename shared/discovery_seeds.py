"""Shared discovery seed selection and per-user rotation memory."""

from __future__ import annotations

from collections import OrderedDict
import threading
from typing import Any

from shared.deezer_catalog import literal_artist_key
from shared.discovery_intelligence import (
    is_artist_demoted,
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
    by_literal: dict[str, dict[str, str]] = {}
    by_deezer_id: dict[str, dict[str, str]] = {}
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
        lit = literal_artist_key(name)
        if not lit:
            continue
        existing = by_literal.get(lit)
        if existing is None and deezer_id:
            existing = by_deezer_id.get(deezer_id)
        if existing is not None:
            if kind == "artist" and existing["kind"] != "artist":
                existing["kind"] = "artist"
                existing["name"] = name
            if deezer_id and not existing["deezer_id"]:
                existing["deezer_id"] = deezer_id
                by_deezer_id[deezer_id] = existing
            by_literal.setdefault(lit, existing)
            continue
        item = {"name": name, "deezer_id": deezer_id, "kind": kind}
        by_literal[lit] = item
        if deezer_id:
            by_deezer_id[deezer_id] = item
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
    """Rank taste seed artists using the multi-horizon taste profile (zero pins)."""
    from shared.discovery_profile import build_artist_taste_profile

    entries = build_artist_taste_profile(metadata, fav_ids, user_id=user_id, persist=True)
    if not entries:
        return []
    scores = {entry.artist_key: entry.effective_score for entry in entries}
    display = {entry.artist_key: entry.display_name for entry in entries}

    if rotate:
        recent = _get_recent(_RECENT_TASTE_SEEDS, user_id)
        for key in recent:
            if key in scores:
                scores[key] *= penalty

    ranked = sorted(scores, key=lambda key: scores[key], reverse=True)
    return [display[key] for key in ranked[:limit] if display.get(key)]


def _is_artist_excluded(artist: str, user_id: str | None = None, *, deezer_artist_id: str = "") -> bool:
    try:
        if user_id is not None:
            with user_context(user_id):
                return is_artist_demoted(artist, deezer_artist_id=deezer_artist_id)
        return is_artist_demoted(artist, deezer_artist_id=deezer_artist_id)
    except Exception:
        return False


def select_release_seed_artists(
    metadata,
    fav_ids: list[str],
    limit: int = 35,
    *,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Return unrotated taste-profile artist seeds for New Releases (zero pins)."""
    from shared.discovery_profile import (
        build_artist_taste_profile,
        select_release_profile_artists,
    )

    profile = build_artist_taste_profile(metadata, fav_ids, user_id=user_id, persist=True)
    selected = select_release_profile_artists(profile, limit=limit)
    return [
        {
            "name": entry.display_name,
            "deezer_id": entry.deezer_artist_id,
            "weight": entry.effective_score,
        }
        for entry in selected
    ]


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
