"""Auto Mode: what to play next, and how to get there.

Two halves that share a candidate pool. The planner turns a seed into a ranked
queue drawn from the local library, the related-video graph and discovery; the
DJ engine orders those candidates by how well they mix and describes the
transition between each pair.
"""

from __future__ import annotations

import hashlib
import logging
import random
import threading
import time
import uuid
from concurrent.futures import Future, wait
from typing import NamedTuple

from flask import has_request_context, jsonify, request

from shared import request_scope
from shared.database import instance_db
from shared.discovery_intelligence import (
    build_music_recommendations,
    rank_recommendation_rows,
)
from shared.dj_engine import (
    analyse_audio,
    analysis_identity,
    cached_analysis,
    order_continuous_route,
    order_route,
    plan_transition,
    request_analysis,
)
from shared.dj.routes import (
    REPAIR_ROUTE_CAP as _DJ_REPAIR_ROUTE_CAP,
    choose_placement,
    choose_request_segment,
    repair_route,
)
from shared.dj.contracts import analysis_summary as _dj_analysis_summary
from shared.dj_pool import ANALYSIS_COHORT_SIZE, add_measured_bridges
from shared.hardening import rate_limit
from shared.listening_planner import (
    AUTO_PROFILES,
    LISTENING_INTENTS,
    auto_source_sequence,
    plan_generated_queue,
)
from shared.music_identity import canonical_music_identity, clean_artist, youtube_music_metadata
from shared.path_resolver import resolve_local_track_path
from shared.providers import deezer
from shared.url_utils import validate_youtube_video_id

from .discovery_bp import discovery_bp
from .discovery_common import (
    _AUTO_CONTEXT_MAX,
    _AUTO_GRAPH_ANCHORS,
    _AUTO_GRAPH_FETCH_MISSES,
    _AUTO_GRAPH_RETRY_AFTER_SEC,
    _AUTO_GRAPH_WAIT_SEC,
    _AUTO_RAW_LIMIT,
    _AUTO_ROUTER_LIMIT,
    _AUTO_SHORTLIST_LIMIT,
    _CANONICAL_RESOLVE_BUDGET_SEC,
    _PLAN_RESOLVE_EXECUTOR,
    _get_api,
)
from .discovery_feed import _build_discovery_feed_body, _deezer_artist_top_rows
from .discovery_graph import _resolve_seed_yt_id
from shared.dj.session import scoped as _dj_scoped
from shared import work
_RESOLUTION_WORK = work.Executor("planner-resolution", 4)


def _submit_resolution(fn, *args):
    if work.current() is None:
        return _PLAN_RESOLVE_EXECUTOR.submit(fn, *args)
    name = getattr(fn, "__qualname__", type(fn).__name__)
    key = hashlib.sha256(f"{name}:{args!r}".encode()).hexdigest()
    return _RESOLUTION_WORK.submit(key, fn, *args)

logger = logging.getLogger(__name__)

def _planner_track_index(metadata) -> dict:
    """`{track_id: track}` for this library, built once per request.

    `dj-plan` looks a track up once per candidate, once per request target and
    once per accepted route item — up to ~40 times. Each lookup used to copy the
    whole track list and scan it, so the handler was O(candidates x library).
    """
    tracks = getattr(metadata, "tracks", None) or []
    if not tracks:
        return {}
    return request_scope.scoped(
        f"planner_track_index:{id(metadata)}:{len(tracks)}",
        lambda: {str(getattr(track, "id", "")): track for track in tracks},
    )


def _planner_track_by_id(metadata, track_id: str):
    if not track_id:
        return None
    return _planner_track_index(metadata).get(str(track_id))


def _library_identity(track) -> str:
    """A library track's song key, from its own tags rather than an upload's."""
    return canonical_music_identity(track.artist, track.title, authoritative=True).key


def _reconcile_library_sources(metadata, items: list[dict]) -> list[dict]:
    """Recommendations of a video the library already holds, as that track.

    YouTube keeps recommending the uploads a listener has saved, under whatever
    the channel calls itself. The song is already known — with the listener's
    own edits — so the candidate takes the track's id and metadata. Score, pool,
    recommendation identity and discovery video stay the candidate's: knowing
    the song must not change how it was chosen. A video held by two library
    tracks names neither; picking one would be arbitrary.
    """
    tracks = getattr(metadata, "tracks", None) or []

    def build() -> dict:
        by_video: dict = {}
        for track in tracks:
            video_id = str(getattr(track, "youtube_id", "") or "")
            if video_id and getattr(track, "media_kind", None) != "podcast_episode":
                by_video[video_id] = None if video_id in by_video else track
        return by_video

    by_video = request_scope.scoped(f"planner_video_index:{id(metadata)}:{len(tracks)}", build)
    reconciled = []
    for item in items:
        track = None if item.get("track_id") else by_video.get(str(item.get("youtube_id") or ""))
        if track is None:
            reconciled.append(item)
            continue
        reconciled.append({
            **item,
            "id": str(track.id),
            "track_id": str(track.id),
            "source": "library",
            "title": str(track.title or "Unknown"),
            "artist": str(track.artist or track.album_artist or ""),
            "artists": getattr(track, "artists", None),
            "artist_is_channel": False,
            "album": str(track.album or ""),
            "duration": int(track.duration or 0),
            "cover": str(getattr(track, "cover_art_key", "") or item.get("cover") or ""),
            "canonical_identity": _library_identity(track),
        })
    return reconciled


def _planner_item_from_related(row: dict) -> dict | None:
    video_id = str(row.get("video_id") or row.get("id") or "").strip()
    if not validate_youtube_video_id(video_id):
        return None
    music = youtube_music_metadata(row)
    return {
        "id": video_id,
        "youtube_id": video_id,
        "discovery_youtube_id": video_id,
        **music,
        "duration": int(row.get("duration") or 0),
        "cover": str(row.get("thumbnail") or ""),
        "source": "preview",
        "source_pool": "related",
        "reason": row.get("reason"),
        "reason_code": row.get("reason_code") or "seed_related",
        "recommendation_identity": row.get("recommendation_identity") or f"music:youtube:{video_id}",
        "score": float(row.get("score") or 0.5),
        "external_ids": {"youtube_id": video_id},
    }


def _planner_item_from_feed(item: dict, *, pool: str) -> dict | None:
    external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
    video_id = str(external.get("youtube_id") or item.get("youtube_id") or "").strip()
    track_id = str(item.get("track_id") or "").strip()
    if not track_id and not validate_youtube_video_id(video_id):
        return None
    item_id = track_id or video_id
    title = str(item.get("title") or "Unknown")
    artist = str(item.get("artist") or "")
    source_title = str(item.get("source_title") or title)
    source_artist = str(item.get("source_artist") or artist)
    identity = canonical_music_identity(
        artist,
        title,
        channel=source_artist,
        authoritative=bool(track_id) or item.get("artist_is_channel") is False,
        source_title=source_title,
    )
    return {
        "id": item_id,
        "track_id": track_id or None,
        "youtube_id": video_id or None,
        "title": identity.title,
        "artist": identity.artist,
        "source_title": source_title,
        "source_artist": source_artist,
        "playback_source_kind": identity.source_kind,
        "canonical_identity": identity.key,
        "artist_is_channel": item.get("artist_is_channel", False),
        "artists": item.get("artists"),
        "deezer_artist_id": item.get("deezer_artist_id") or external.get("deezer_artist_id"),
        "deezer_album_id": item.get("deezer_album_id") or external.get("deezer_album_id"),
        "album": str(item.get("album") or ""),
        "duration": int(item.get("duration") or 0),
        "cover": str(item.get("cover") or ""),
        "source": "library" if track_id else "preview",
        "source_pool": pool,
        "reason": item.get("reason"),
        "reason_code": item.get("reason_code"),
        "recommendation_identity": item.get("recommendation_identity")
        or (f"music:track:{track_id}" if track_id else f"music:youtube:{video_id}"),
        "score": float(item.get("score") or 0.5),
        "external_ids": {**external, **({"youtube_id": video_id} if video_id else {})},
    }


def _candidate_keys(item: dict) -> set[str]:
    """Every id a planner candidate can legitimately be recognised by.

    The browser excludes what it already holds using raw playback ids
    (`youtube_id or id`), while the planner names the same song
    `music:youtube:<id>` or `music:track:<id>`. Comparing only the namespaced
    form let the seed of a session come back as its own route: the browser
    dropped it as a duplicate and then read the empty result as a dry pool.
    """
    external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
    values = (
        item.get("recommendation_identity"),
        item.get("canonical_identity"),
        item.get("track_id"),
        item.get("youtube_id"),
        item.get("discovery_youtube_id"),
        external.get("youtube_id"),
        item.get("id"),
    )
    return {str(value) for value in values if value}


class _GraphWalk(NamedTuple):
    """One related-graph expansion, and how much of it actually arrived.

    `warming` is the difference between "this neighbourhood is empty" and "we
    have not finished reading it yet" — the distinction the route panel needs
    before it tells a listener there is nothing left to play.
    """

    items: list[dict]
    degraded: bool
    warming: bool
    cache_hit: int = 0
    cache_miss: int = 0


def _planner_artist_key(value: object) -> str:
    return clean_artist(value).casefold()


def _planner_video_id(metadata, item: dict) -> str:
    video_id = str(
        item.get("discovery_youtube_id")
        or item.get("youtube_id")
        or (
            (item.get("external_ids") or {}).get("youtube_id")
            if isinstance(item.get("external_ids"), dict)
            else ""
        )
        or (item.get("id") if item.get("source") == "preview" else "")
        or ""
    ).strip()
    if validate_youtube_video_id(video_id):
        return video_id
    track_id = str(item.get("track_id") or (item.get("id") if item.get("source") != "preview" else "") or "")
    track = _planner_track_by_id(metadata, track_id) if track_id else None
    candidate = str(getattr(track, "youtube_id", "") or "")
    return candidate if validate_youtube_video_id(candidate) else ""


def _resolve_generated_playback(item: dict, user_id: str | None) -> dict:
    """Prefer a canonical upload while retaining the discovery graph identity."""
    from shared.api.routes.catalog import _resolve_candidates
    from shared.resolution_confidence import CONFIDENCE_HIGH
    from shared.user_context import user_context

    current = canonical_music_identity(
        item.get("artist"),
        item.get("title"),
        channel=item.get("source_artist") or item.get("artist"),
        authoritative=item.get("artist_is_channel") is False,
        source_title=item.get("source_title"),
    )
    with user_context(user_id):
        best, candidates = _resolve_candidates(
            current.artist,
            current.title,
            int(item.get("duration") or 0) or None,
        )
    if not best or float(best.get("confidence") or 0) < CONFIDENCE_HIGH:
        return item
    best_title = str(best.get("title") or current.title)
    best_channel = str(best.get("channel") or best.get("uploader") or "")
    resolved = canonical_music_identity(current.artist, best_title, channel=best_channel)
    if resolved.version_tokens != current.version_tokens or resolved.source_rank <= current.source_rank:
        return item
    video_id = str(best.get("id") or "")
    if not validate_youtube_video_id(video_id):
        return item
    discovery_id = str(item.get("discovery_youtube_id") or item.get("youtube_id") or item.get("id") or "")
    return {
        **item,
        "id": video_id,
        "youtube_id": video_id,
        "discovery_youtube_id": discovery_id,
        "title": item.get("title") or resolved.title,
        "artist": item.get("artist") or resolved.artist,
        "source_title": best_title,
        "source_artist": best_channel,
        "playback_source_kind": resolved.source_kind,
        "canonical_identity": item.get("canonical_identity") or resolved.key,
        "external_ids": {
            **(item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}),
            "youtube_id": video_id,
            "discovery_youtube_id": discovery_id,
        },
        # Feedback and generated-lane exclusions stay attached to the graph node
        # that discovered the song, not to whichever upload happened to play it.
        "recommendation_identity": item.get("recommendation_identity"),
        "resolution_candidates": len(candidates),
    }


def _canonicalize_generated_items(items: list[dict], user_id: str | None) -> list[dict]:
    """Bounded best-effort playback-source upgrade for an already chosen plan.

    Song selection is finished before this runs. A failed/slow lookup therefore
    cannot remove discovery: it simply leaves the original video in place while
    the single-flight resolver warms its cache for a later plan.
    """
    futures = {}
    submitted = 0
    for index, item in enumerate(items):
        if item.get("source") != "preview":
            continue
        identity = canonical_music_identity(
            item.get("artist"),
            item.get("source_title") or item.get("title"),
            channel=item.get("source_artist") or item.get("artist"),
        )
        if identity.source_kind in {"official_audio", "artist_audio"}:
            continue
        if submitted >= 3:
            break
        future = _submit_resolution(_resolve_generated_playback, dict(item), user_id)
        futures[future] = index
        submitted += 1
    if not futures:
        return items
    done, _ = wait(futures, timeout=_CANONICAL_RESOLVE_BUDGET_SEC)
    resolved = list(items)
    for future in done:
        try:
            resolved[futures[future]] = future.result()
        except Exception as exc:
            logger.debug("Generated playback source resolve failed: %s", exc)
    return resolved


def _planner_context(seed: dict, raw_context: object) -> list[dict]:
    rows = [
        dict(item)
        for item in (raw_context if isinstance(raw_context, list) else [])
        if isinstance(item, dict)
    ][-_AUTO_CONTEXT_MAX:]
    rows.append(dict(seed))
    deduped: list[dict] = []
    seen: set[str] = set()
    for item in rows:
        identity = str(
            item.get("youtube_id")
            or item.get("track_id")
            or item.get("id")
            or f"{item.get('artist', '')}:{item.get('title', '')}"
        ).strip()
        if not identity or identity in seen:
            continue
        seen.add(identity)
        deduped.append(item)
    return deduped[-_AUTO_CONTEXT_MAX:]


def _planner_uncached_related(video_id: str) -> list[dict]:
    api = _get_api()
    rows = api["get_downloader"](open_browser=False).downloader.get_related_videos(
        video_id,
        max_results=25,
        enrich=False,
    )
    return rows


_GRAPH_INFLIGHT: dict[str, Future] = {}
_GRAPH_INFLIGHT_LOCK = threading.Lock()


def _planner_related_future(video_id: str) -> Future:
    """One fetch per seed, however many callers want it.

    A cold seed outlives the caller that asked for it: the wait expires, the
    listener retries, and without this every retry queued *another* copy of the
    same fetch against the same threads — so the retries were competing with the
    work that would have answered them. Joining the live future instead means a
    retry either finds the cache warm or waits on the fetch already running.
    """
    with _GRAPH_INFLIGHT_LOCK:
        from shared.related_work import submit
        future = submit(video_id, lambda: _planner_uncached_related(video_id))
        _GRAPH_INFLIGHT[video_id] = future

    def _release(_done: Future, key: str = video_id) -> None:
        with _GRAPH_INFLIGHT_LOCK:
            if _GRAPH_INFLIGHT.get(key) is _done:
                _GRAPH_INFLIGHT.pop(key, None)

    future.add_done_callback(_release)
    return future


def _planner_context_related(
    metadata,
    context: list[dict],
    *,
    personalise: bool = True,
) -> _GraphWalk:
    """Collect a bounded semantic neighbourhood around the route that survives."""
    anchors: list[tuple[str, float]] = []
    for index, item in enumerate(context[-_AUTO_GRAPH_ANCHORS:]):
        video_id = _planner_video_id(metadata, item)
        if not video_id:
            continue
        recency = 0.64 + 0.36 * ((index + 1) / min(len(context), _AUTO_GRAPH_ANCHORS))
        if all(existing != video_id for existing, _ in anchors):
            anchors.append((video_id, recency))

    mixes: dict[str, list[dict]] = {}
    misses: list[str] = []
    cached_mixes = instance_db().get_related_mixes(video_id for video_id, _ in anchors)
    for video_id, _ in anchors:
        cached = cached_mixes.get(video_id)
        if cached is None:
            misses.append(video_id)
        else:
            mixes[video_id] = cached

    warming = len(misses) > _AUTO_GRAPH_FETCH_MISSES
    futures = {
        _planner_related_future(video_id): video_id
        for video_id in misses[:_AUTO_GRAPH_FETCH_MISSES]
    }
    if futures:
        done, pending = wait(futures, timeout=_AUTO_GRAPH_WAIT_SEC)
        # A warming response lets an identical retry keep these seed interests.
        # Changed/cancelled requests retire them through the work scope.
        warming = warming or bool(pending)
        for future in done:
            try:
                mixes[futures[future]] = future.result()
            except Exception as exc:
                logger.info("Auto context graph unavailable for %s: %s", futures[future], exc)

    candidates: dict[str, dict] = {}
    for video_id, recency in anchors:
        rows = mixes.get(video_id) or []
        ranked_rows = rank_recommendation_rows(rows, source="auto_mode") if personalise else rows
        for rank, raw in enumerate(ranked_rows[:25]):
            item = _planner_item_from_related(raw)
            if not item:
                continue
            semantic = max(0.18, recency * (1 - min(rank, 24) / 36))
            identity = str(item["recommendation_identity"])
            previous = candidates.get(identity)
            if previous and float(previous.get("semantic_score") or 0) >= semantic:
                continue
            item.update({
                "semantic_score": round(semantic, 6),
                "semantic_basis": "related_track",
                "score": round(
                    max(0.0001, float(item.get("score") or 0.5) * (0.7 + semantic * 0.3)),
                    6,
                ),
            })
            candidates[identity] = item
            if len(candidates) >= _AUTO_RAW_LIMIT:
                break
        if len(candidates) >= _AUTO_RAW_LIMIT:
            break
    return _GraphWalk(
        _reconcile_library_sources(metadata, list(candidates.values())),
        any(video_id not in mixes for video_id, _ in anchors),
        warming,
        len(anchors) - len(misses),
        len(misses),
    )


def _planner_related_artist_pool(
    seed_artist: str,
    user_id: str | None,
    limit: int = 6,
) -> tuple[list[str], list[dict]]:
    """Return related artist names plus one playable representative per artist."""
    if not seed_artist:
        return [], []
    try:
        from shared.api.routes.catalog import (
            _deezer_artist_top_tracks,
            _deezer_related_artists,
            _resolve_artist_id,
        )

        artist_id, _ = _resolve_artist_id(seed_artist)
        if not artist_id:
            return [], []
        related_rows = _deezer_related_artists(artist_id, max(6, limit))[:limit]
    except Exception as exc:
        logger.info("Auto related artists unavailable for %s: %s", seed_artist, exc)
        return [], []

    names = [str(row.get("name") or "").strip() for row in related_rows if str(row.get("name") or "").strip()]
    futures = {
        _submit_resolution(_deezer_artist_top_tracks, str(row["deezer_id"]), 1): index
        for index, row in enumerate(related_rows)
        if row.get("deezer_id")
    }
    done, pending = wait(futures, timeout=5)
    if work.current() is None:
        for future in pending:
            future.cancel()
    seeds: list[tuple[int, dict]] = []
    for future in done:
        try:
            top = future.result()
        except Exception:
            top = []
        if not top:
            continue
        item = dict(top[0])
        item.update({
            "score": 0.62,
            "semantic_score": 0.62,
            "semantic_basis": "related_artist",
            "reason": f"Related to {seed_artist}.",
            "reason_code": "related_artist",
        })
        seeds.append((futures[future], item))
    seeds.sort(key=lambda pair: pair[0])

    resolution_futures = {
        _submit_resolution(_planner_resolve_artist_candidate, item, user_id): index
        for index, item in seeds
    }
    done, pending = wait(resolution_futures, timeout=8)
    if work.current() is None:
        for future in pending:
            future.cancel()
    resolved: list[tuple[int, dict]] = []
    for future in done:
        try:
            item = future.result()
        except Exception:
            item = None
        if item:
            item["source_pool"] = "discovery"
            item["semantic_score"] = 0.62
            item["semantic_basis"] = "related_artist"
            resolved.append((resolution_futures[future], item))
    resolved.sort(key=lambda pair: pair[0])
    return names, [item for _, item in resolved[:limit]]


def _planner_local_item(track, *, semantic_score: float, basis: str, favourite: bool) -> dict:
    video_id = str(getattr(track, "youtube_id", "") or "")
    score = min(1.0, semantic_score * 0.82 + (0.16 if favourite else 0.06))
    return {
        "id": str(track.id),
        "track_id": str(track.id),
        "youtube_id": video_id or None,
        "title": str(track.title or "Unknown"),
        "artist": str(track.artist or track.album_artist or ""),
        "album": str(track.album or ""),
        "duration": int(track.duration or 0),
        "cover": str(getattr(track, "cover_art_key", "") or ""),
        "source": "library",
        "source_pool": "local",
        "canonical_identity": _library_identity(track),
        "reason": "From your library and inside this session's musical path.",
        "reason_code": "session_library",
        "recommendation_identity": f"music:track:{track.id}",
        "score": round(score, 6),
        "semantic_score": round(semantic_score, 6),
        "semantic_basis": basis,
        "personal_score": 1.0 if favourite else 0.55,
        "external_ids": {"youtube_id": video_id} if video_id else {},
    }


def _build_auto_pools(
    metadata,
    context: list[dict],
    *,
    favourite_ids: set[str],
    user_id: str | None,
) -> tuple[dict[str, list[dict]], bool]:
    walk = _planner_context_related(metadata, context)
    related = list(walk.items)
    # This pool feeds the legacy plan and the discovery feed, neither of which
    # has a "still warming" state to show. For them an unfinished walk is simply
    # one more way of being degraded.
    graph_degraded = walk.degraded or walk.warming
    seed_artist = str(context[-1].get("artist") or "") if context else ""
    related_artists, discovery = _planner_related_artist_pool(seed_artist, user_id)
    related_artist_keys = {_planner_artist_key(name) for name in related_artists}
    context_artist_keys = {
        _planner_artist_key(item.get("artist"))
        for item in context
        if _planner_artist_key(item.get("artist"))
    }
    semantic_by_video = {
        str(item.get("youtube_id") or ""): float(item.get("semantic_score") or 0)
        for item in related
        if item.get("youtube_id")
    }

    local: list[dict] = []
    for track in list(metadata.tracks if metadata and metadata.tracks else []):
        artist_key = _planner_artist_key(track.artist or track.album_artist)
        video_id = str(getattr(track, "youtube_id", "") or "")
        if video_id and video_id in semantic_by_video:
            semantic = semantic_by_video[video_id]
            basis = "related_track"
        elif artist_key and artist_key in context_artist_keys:
            semantic = 0.76
            basis = "same_artist"
        elif artist_key and artist_key in related_artist_keys:
            semantic = 0.62
            basis = "related_artist"
        else:
            continue
        local.append(_planner_local_item(
            track,
            semantic_score=semantic,
            basis=basis,
            favourite=str(track.id) in favourite_ids,
        ))

    local.sort(
        key=lambda item: (
            float(item.get("semantic_score") or 0),
            float(item.get("personal_score") or 0),
            float(item.get("score") or 0),
        ),
        reverse=True,
    )
    owned_video_ids = {
        str(item.get("youtube_id") or "")
        for item in local
        if item.get("youtube_id")
    }
    related = [
        item for item in related
        if str(item.get("youtube_id") or "") not in owned_video_ids
    ]
    discovery = [
        item for item in discovery
        if str(item.get("youtube_id") or "") not in owned_video_ids
    ]
    related.sort(key=lambda item: float(item.get("semantic_score") or 0), reverse=True)
    discovery.sort(key=lambda item: float(item.get("semantic_score") or 0), reverse=True)
    return {
        "local": local[:_AUTO_SHORTLIST_LIMIT],
        "related": related[:_AUTO_SHORTLIST_LIMIT],
        "discovery": discovery[:_AUTO_SHORTLIST_LIMIT],
    }, graph_degraded


def _planner_resolve_artist_candidate(item: dict, user_id: str | None) -> dict | None:
    from shared.api.routes.catalog import _resolve_candidates
    from shared.user_context import user_context

    with user_context(user_id):
        best, _ = _resolve_candidates(
            str(item.get("artist") or ""),
            str(item.get("title") or ""),
            int(item.get("duration") or 0) or None,
        )
    video_id = str(best.get("id") or "").strip()
    if not validate_youtube_video_id(video_id):
        return None
    resolved = dict(item)
    resolved["external_ids"] = {
        **(item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}),
        "youtube_id": video_id,
    }
    resolved["youtube_id"] = video_id
    resolved["id"] = video_id
    resolved["source"] = "preview"
    resolved["source_title"] = str(best.get("title") or item.get("title") or "")
    resolved["source_artist"] = str(best.get("channel") or best.get("uploader") or "")
    resolved["recommendation_identity"] = f"music:youtube:{video_id}"
    return _planner_item_from_feed(resolved, pool="related")


def _planner_artist_candidates(seed_artist: str, user_id: str | None, limit: int) -> list[dict]:
    if not seed_artist:
        return []
    try:
        rows = _deezer_artist_top_rows(seed_artist, max(8, limit * 2))
    except Exception as exc:
        logger.info("Listening plan artist pool unavailable for %s: %s", seed_artist, exc)
        return []
    seeds: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
        title = str(row.get("title_short") or row.get("title") or "").strip()
        artist = str(artist_row.get("name") or seed_artist).strip()
        if not title or not artist:
            continue
        seeds.append({
            "id": f"deezer:{row.get('id')}",
            "title": title,
            "artist": artist,
            "album": str(album_row.get("title") or ""),
            "duration": int(row.get("duration") or 0),
            "cover": deezer.image(album_row, "cover"),
            "score": max(0.1, float(row.get("rank") or 0) / 1_000_000),
            "reason": f"More from {seed_artist}.",
            "reason_code": "seed_artist",
            "external_ids": {"deezer_id": str(row.get("id") or "")},
            # Catalog metadata: resolving the audio must not swap it for the uploader.
            "artist_is_channel": False,
            "deezer_artist_id": str(artist_row.get("id") or "") or None,
            "deezer_album_id": str(album_row.get("id") or "") or None,
        })
        if len(seeds) >= max(4, limit):
            break
    futures = {
        _submit_resolution(_planner_resolve_artist_candidate, item, user_id): index
        for index, item in enumerate(seeds)
    }
    done, pending = wait(futures, timeout=8)
    if work.current() is None:
        for future in pending:
            future.cancel()
    resolved: list[tuple[int, dict]] = []
    for future in done:
        try:
            item = future.result()
        except Exception:
            item = None
        if item:
            resolved.append((futures[future], item))
    resolved.sort(key=lambda pair: pair[0])
    return [item for _, item in resolved[:limit]]


def _annotate_plan_loudness(metadata, items: list[dict]) -> list[dict]:
    """Confirmed local recording facts for accepted items, without exposing hashes.

    Selection and ordering are already complete. A failed measurement lookup
    leaves the selected music playable under the client's unmeasured policy.
    """
    from shared.loudness import LoudnessStore
    from shared.loudness.store import identity_for

    rows = [dict(item) for item in items]
    owned = {}
    for index, row in enumerate(rows):
        row.pop("loudness_lufs", None)
        row.pop("loudness_peak_dbtp", None)
        if row.get("source") != "library":
            continue
        track = _planner_track_by_id(metadata, str(row.get("track_id") or row.get("id") or ""))
        if track is not None:
            owned[index] = identity_for(track)
            row["duration"] = int(track.duration or 0)
    try:
        measured = LoudnessStore().measured_for(owned.values()) if owned else {}
        for index, identity in owned.items():
            facts = measured.get(identity)
            if facts is not None:
                rows[index]["loudness_lufs"] = round(facts[0], 2)
                rows[index]["loudness_peak_dbtp"] = round(facts[1], 2)
    except Exception:
        logger.debug("Generated plan loudness unavailable", exc_info=True)
    return rows


def _build_music_plan(data: dict) -> tuple[dict, int]:
    """Build one generated queue payload without binding it to a Flask route."""
    from shared.user_context import current_user_id

    intent = str(data.get("intent") or "").strip()
    profile = str(data.get("profile") or "balanced").strip()
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    exclude = data.get("exclude") if isinstance(data.get("exclude"), list) else []
    if intent not in LISTENING_INTENTS:
        return {"error": "intent must be autoplay, radio, or auto_mode"}, 400
    if profile not in AUTO_PROFILES:
        return {"error": "profile must be familiar, balanced, or explore"}, 400
    if not seed:
        return {"error": "seed is required"}, 400
    try:
        limit = min(24, max(1, int(data.get("limit") or 8)))
    except (TypeError, ValueError):
        return {"error": "limit must be an integer"}, 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    track_id = str(seed.get("track_id") or "").strip()
    library_seed = _planner_track_by_id(metadata, track_id) if track_id else None
    if library_seed and getattr(library_seed, "media_kind", None) == "podcast_episode":
        return {"error": "music plans do not accept podcast seeds"}, 400
    seed_title = str(seed.get("title") or getattr(library_seed, "title", "") or "").strip()
    seed_artist = str(seed.get("artist") or getattr(library_seed, "artist", "") or "").strip()
    seed_youtube_id = str(
        seed.get("discovery_youtube_id")
        or seed.get("youtube_id")
        or getattr(library_seed, "youtube_id", "")
        or (seed.get("id") if seed.get("source") == "preview" else "")
        or ""
    ).strip()
    if not validate_youtube_video_id(seed_youtube_id) and library_seed:
        seed_youtube_id = _resolve_seed_yt_id(library_seed)
    if not validate_youtube_video_id(seed_youtube_id) and seed_title and seed_artist:
        try:
            from shared.api.routes.catalog import _resolve_candidates

            best, _ = _resolve_candidates(seed_artist, seed_title, int(seed.get("duration") or 0) or None)
            seed_youtube_id = str(best.get("id") or "")
        except Exception:
            seed_youtube_id = ""
    if (
        not library_seed
        and not validate_youtube_video_id(seed_youtube_id)
        and not (seed_title and seed_artist)
    ):
        return {"error": "seed needs a track id, video id, or title and artist"}, 400

    fav_ids = api["_mod"].favourite_library_ids()
    if intent == "auto_mode":
        session_id = str(data.get("session_id") or "").strip()[:80]
        try:
            segment_index = max(0, int(data.get("segment_index") or 0))
        except (TypeError, ValueError):
            return {"error": "segment_index must be a non-negative integer"}, 400
        context_seed = {
            **seed,
            "track_id": track_id or None,
            "youtube_id": seed_youtube_id or None,
            "discovery_youtube_id": str(seed.get("discovery_youtube_id") or "") or None,
            "source": "library" if library_seed else "preview",
            "title": seed_title,
            "artist": seed_artist,
        }
        context = _planner_context(context_seed, data.get("context"))
        pools, graph_degraded = _build_auto_pools(
            metadata,
            context,
            favourite_ids={str(value) for value in fav_ids},
            user_id=current_user_id(),
        )
        entropy = f"{session_id}:{segment_index}" if session_id else str(uuid.uuid4())
        source_sequence = auto_source_sequence(profile, entropy=entropy)
        items = plan_generated_queue(
            pools,
            intent=intent,
            profile=profile,
            limit=limit,
            exclude=[str(value) for value in exclude[:200] if str(value).strip()],
            entropy=entropy,
            context_artists=[
                str(item.get("artist") or "")
                for item in context
                if str(item.get("artist") or "").strip()
            ],
        )
        items = _annotate_plan_loudness(metadata, _canonicalize_generated_items(items, current_user_id()))
        return {
            "v": 1,
            "plan_id": str(uuid.uuid4()),
            "intent": intent,
            "profile": profile,
            "seed_identity": seed_youtube_id or track_id or f"{seed_artist}:{seed_title}",
            "session_id": session_id or None,
            "segment_index": segment_index,
            "source_sequence": list(source_sequence),
            "items": items,
            "degraded": len(items) < limit or graph_degraded,
            "pool_counts": {pool: len(pools[pool]) for pool in ("local", "related", "discovery")},
            "generated_at": int(time.time()),
        }, 200

    local: list[dict] = []
    local_error = False
    try:
        local_response = build_music_recommendations(metadata, fav_ids, limit=max(24, limit * 3))
        for item in local_response.get("items") or []:
            candidate = _planner_item_from_feed(item, pool="local")
            if not candidate:
                continue
            local_track = _planner_track_by_id(metadata, str(candidate.get("track_id") or ""))
            if local_track and getattr(local_track, "media_kind", None) == "podcast_episode":
                continue
            local.append(candidate)
    except Exception as exc:
        local_error = True
        logger.info("Listening plan local pool unavailable: %s", exc)

    related: list[dict] = []
    related_error = False
    if validate_youtube_video_id(seed_youtube_id):
        try:
            raw_related = instance_db().get_related_mix(seed_youtube_id)
            if raw_related is None:
                dl = api["get_downloader"](open_browser=False)
                raw_related = dl.downloader.get_related_videos(
                    seed_youtube_id,
                    max_results=max(25, limit * 3),
                    enrich=False,
                )
                instance_db().set_related_mix(seed_youtube_id, raw_related)
            source = intent if intent in {"radio", "auto_mode"} else "autoplay"
            related = [
                candidate
                for row in rank_recommendation_rows(raw_related, source=source)
                if (candidate := _planner_item_from_related(row))
            ]
        except Exception as exc:
            related_error = True
            logger.info("Listening plan related pool unavailable for %s: %s", seed_youtube_id, exc)

    discovery: list[dict] = []
    discovery_error = False
    try:
        feed = _build_discovery_feed_body(max(8, limit), include_external=False)
        discovery = [
            candidate
            for item in feed.get("items") or []
            if (candidate := _planner_item_from_feed(item, pool="discovery"))
            and not candidate.get("track_id")
        ]
    except Exception as exc:
        discovery_error = True
        logger.info("Listening plan discovery pool unavailable: %s", exc)
    items = plan_generated_queue(
        {
            "local": local,
            "related": _reconcile_library_sources(metadata, related),
            "discovery": _reconcile_library_sources(metadata, discovery),
        },
        intent=intent,
        profile=profile,
        limit=limit,
        exclude=[str(value) for value in exclude[:200] if str(value).strip()],
    )
    items = _annotate_plan_loudness(metadata, _canonicalize_generated_items(items, current_user_id()))
    return {
        "v": 1,
        "plan_id": str(uuid.uuid4()),
        "intent": intent,
        "profile": profile,
        "seed_identity": seed_youtube_id or track_id or f"{seed_artist}:{seed_title}",
        "items": items,
        "degraded": len(items) < limit or local_error or related_error or discovery_error,
        "pool_counts": {
            "local": len(local),
            "related": len(related),
            "discovery": len(discovery),
        },
        "generated_at": int(time.time()),
    }, 200


@discovery_bp.route("/api/discovery/music/plan", methods=["POST"])
@rate_limit("discovery_music_plan", limit=60, window_sec=60)
def discovery_music_plan():
    """Build the final generated queue order for every music continuation."""
    payload, status = _build_music_plan(request.get_json(silent=True) or {})
    return jsonify(payload), status


def _dj_source_path(metadata, item: dict) -> str | None:
    """Where this item's audio already lives locally, if anywhere.

    Looking up analysis is read-only. Only the frozen, cache-independent DJ
    cohort may request speculative acquisition, via `_dj_prepare_cohort`.
    """
    track_id = str(item.get("track_id") or "").strip()
    video_id = str(item.get("youtube_id") or (item.get("id") if item.get("source") == "preview" else "") or "").strip()
    if track_id:
        track = _planner_track_by_id(metadata, track_id)
        return resolve_local_track_path(track) if track else None
    if not validate_youtube_video_id(video_id):
        return None
    from shared import preview_cache

    cached = preview_cache.get_cached(video_id)
    if cached:
        return str(cached[0])
    return None


def _dj_item_analysis(metadata, item: dict, *, schedule: bool = False) -> dict:
    """Features for one route item, without ever blocking on FFmpeg.

    Planning is on the interaction path: a listener adding a source must not
    wait on a decode. Whatever has already been measured is used, the
    rest is queued, and the route is built from a conservative fallback that the
    player is required to treat as such. The refinement endpoint picks up the
    real numbers once they land, before the transition is ever committed.
    """
    duration_hint = float(item.get("duration") or 0)
    identity = analysis_identity(item)
    path = _dj_source_path(metadata, item)
    if not path:
        return _dj_fallback_analysis(duration_hint)
    cached = cached_analysis(path, identity)
    if cached is not None:
        return cached
    if schedule and (not has_request_context() or not request.headers.get("X-Soundsible-Work")
                     or request.path.endswith(("dj-work", "dj-transition"))):
        request_analysis(path, identity, duration_hint=duration_hint)
    return _dj_fallback_analysis(duration_hint)


def _dj_prepare_cohort(metadata, items: list[dict]) -> None:
    """Queue a bounded, already chosen cohort; never rank by cache state."""
    from shared import preview_cache
    from .playback import _get_preview_stream_cached, _invalidate_stream

    video_ids = []
    demand = work.current()
    if demand is not None:
        work.check()
        tracks = getattr(demand, "tracks", {})
        tracks.update({analysis_identity(item): {key: item[key] for key in
                       ("id", "track_id", "youtube_id", "source", "duration") if key in item}
                       for item in items})
        demand.tracks = tracks
    for item in items:
        _dj_item_analysis(metadata, item, schedule=True)
        if not item.get("track_id"):
            # Acquisition follows the playback upload; discovery_youtube_id
            # belongs to the recommendation graph and can name another upload.
            video_id = str(item.get("youtube_id") or
                           (item.get("id") if item.get("source") == "preview" else "") or "").strip()
            if validate_youtube_video_id(video_id):
                video_ids.append(video_id)
    if not video_ids or preview_cache.cache_limit_bytes() <= 0:
        return
    api = _get_api()

    def refresh(video_id):
        _invalidate_stream(video_id)
        return _get_preview_stream_cached(api, video_id, skip_fast_path=True)

    preview_cache.request_prefetch(
        video_ids, download=True,
        resolver=lambda video_id: _get_preview_stream_cached(api, video_id),
        refresh_resolver=refresh,
    )


def _dj_fallback_analysis(duration_hint: float) -> dict:
    return analyse_audio("", "", duration_hint=duration_hint)


def _normalise_dj_request(raw: dict) -> dict | None:
    if str(raw.get("kind") or "").strip() == "artist":
        artist_row = raw.get("artist") if isinstance(raw.get("artist"), dict) else {}
        artist_name = str(artist_row.get("name") or raw.get("label") or "").strip()
        if not artist_name:
            return None
        return {
            "kind": "artist",
            "artist_name": artist_name,
            "label": artist_name,
            "request_id": str(raw.get("id") or uuid.uuid4()),
        }
    track = raw.get("track") if isinstance(raw.get("track"), dict) else raw
    is_preview = str(track.get("source") or "") == "preview"
    video_id = str(track.get("youtube_id") or (track.get("id") if is_preview else "") or "").strip()
    track_id = str(track.get("track_id") or (track.get("id") if not is_preview else "") or "").strip()
    title = str(track.get("title") or "").strip()
    artist = str(track.get("artist") or track.get("channel") or "").strip()
    if not title or not artist or (not track_id and not validate_youtube_video_id(video_id)):
        return None
    is_preview = not track_id
    return {
        "kind": "track",
        "label": title,
        "id": video_id if is_preview else track_id,
        "track_id": track_id or None,
        "youtube_id": video_id if is_preview else track.get("youtube_id"),
        "title": title,
        "artist": artist,
        "album": str(track.get("album") or ""),
        "duration": int(track.get("duration") or 0),
        "cover": str(track.get("cover") or track.get("thumbnail") or ""),
        "source": "preview" if is_preview else "library",
        "source_pool": "related",
        "reason": "Requested by the listener",
        "reason_code": "dj_request",
        "recommendation_identity": str(track.get("recommendation_identity") or f"dj-request:{track_id or video_id}"),
        "recommendation_source": "auto_mode",
        "score": 1.0,
        "request_id": str(raw.get("id") or uuid.uuid4()),
    }


def _music_set_item(raw: dict, *, source_id: str, label: str, weight: float = 1.0) -> dict | None:
    """Turn a browser track into a planner item without consulting taste history."""
    track = dict(raw)
    if track.get("source") == "preview":
        track.setdefault("youtube_id", track.get("id"))
    else:
        track.setdefault("track_id", track.get("id"))
    item = _planner_item_from_feed(track, pool="local" if track.get("source") != "preview" else "related")
    if not item:
        return None
    item.update({
        "source_set_id": source_id,
        "source_set_label": label,
        "source_weight": max(0.05, min(1.0, weight)),
        "lineage": [item["recommendation_identity"]],
        "reason": f"From {label}",
        "reason_code": "music_set_source",
        "recommendation_source": "auto_mode",
    })
    return item


# A song the DJ mixes in and out of. Past this a file is a DJ set, a live
# recording or a whole album in one take: not something to blend between, and
# on a phone a stream of hundreds of megabytes that will not buffer in time.
_DJ_MAX_SONG_SECONDS = 20 * 60


def _song_sized(item: dict) -> bool:
    try:
        duration = float(item.get("duration") or 0)
    except (TypeError, ValueError):
        return True
    return duration <= 0 or duration <= _DJ_MAX_SONG_SECONDS


def _exploration_related(metadata, heard_roots: list[dict]) -> _GraphWalk:
    """One hop out of confirmed automatic playback in the current direction."""
    if not heard_roots:
        return _GraphWalk([], False, False)
    walk = _planner_context_related(metadata, heard_roots, personalise=False)
    related = list(walk.items)
    for item in related:
        item.update({
            "source_set_id": "exploration",
            "source_set_label": "Session",
            "source_weight": 0.3,
            "lineage": ["exploration", item["recommendation_identity"]],
            "reason": "Reached from this DJ session",
            "reason_code": "heard_context",
            "recommendation_source": "auto_mode",
        })
        item["score"] = float(item.get("score") or 0.5) * 0.3
    return walk._replace(items=related)


def _build_music_set_route(data: dict) -> tuple[dict, int]:
    """Auto v6: conduct accumulating sources without semantic fences.

    Explicit sources and confirmed automatic playback are the only graph roots.
    Candidates never become roots merely because a previous plan recommended
    them, which prevents self-reinforcing recommendation walks.
    """
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    sources = [row for row in data.get("sources", []) if isinstance(row, dict)]
    raw_heard = data.get("heard") if isinstance(data.get("heard"), list) else []
    if not sources and not raw_heard:
        return {"error": "at least one source or heard track is required"}, 400
    try:
        limit = min(8, max(1, int(data.get("limit") or 8)))
        segment_index = max(0, int(data.get("segment_index") or 0))
    except (TypeError, ValueError):
        return {"error": "limit and segment_index must be numeric"}, 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    candidates: list[dict] = []
    degraded = False
    warming = False
    cache_hit = cache_miss = 0
    ordered_sources = sorted(
        sources,
        key=lambda row: int(row.get("activation") or 0),
    )
    source_count = max(1, len(ordered_sources))
    for source_index, source in enumerate(ordered_sources):
        source_id = str(source.get("id") or uuid.uuid4())
        label = str(source.get("label") or "Music set").strip()
        # Old sources stay alive while the latest direction dominates. The
        # floor deliberately remains non-zero: decay is not deletion.
        weight = 0.38 + 0.62 * ((source_index + 1) / source_count)
        roots = [
            item for raw in source.get("tracks", [])
            if isinstance(raw, dict)
            and (item := _music_set_item(raw, source_id=source_id, label=label, weight=weight))
        ]
        candidates.extend(roots)
        if not roots:
            continue
        walk = _planner_context_related(metadata, roots[-4:], personalise=False)
        related = list(walk.items)
        degraded = degraded or walk.degraded
        warming = warming or walk.warming
        cache_hit += walk.cache_hit
        cache_miss += walk.cache_miss
        root_identity = roots[-1]["recommendation_identity"]
        for item in related:
            item.update({
                "source_set_id": source_id,
                "source_set_label": label,
                "source_weight": weight,
                "lineage": [root_identity, item["recommendation_identity"]],
                "reason": f"Reached from {label}",
                "reason_code": "music_set_graph_walk",
                "recommendation_source": "auto_mode",
            })
            item["score"] = float(item.get("score") or 0.5) * weight
        candidates.extend(related)

    # Exploration is supplied separately from repeat history. Legacy clients
    # have no provenance, so only their non-explicit policy uses heard roots.
    raw_exploration = data.get("exploration")
    if not isinstance(raw_exploration, list):
        raw_exploration = raw_heard if data.get("source_policy") != "explicit" else []
    exploration_roots = [
        item for raw in raw_exploration[-4:] if isinstance(raw, dict)
        and (item := _music_set_item(raw, source_id="exploration", label="Session", weight=0.3))
    ]
    exploration_walk = _exploration_related(metadata, exploration_roots)
    degraded = degraded or exploration_walk.degraded
    warming = warming or exploration_walk.warming
    cache_hit += exploration_walk.cache_hit
    cache_miss += exploration_walk.cache_miss
    candidates.extend(exploration_walk.items)
    heard_order = [
        item["recommendation_identity"] for raw in raw_heard[-4:]
        if isinstance(raw, dict)
        and (item := _music_set_item(raw, source_id="heard", label="Heard"))
    ]
    heard = set(heard_order)
    excluded = {str(value) for value in data.get("exclude", []) if str(value)}
    # The song a route continues from is never a candidate for that route. It
    # reaches the pool as a source root, and the browser names it in the
    # playback namespace (`<video id>`) rather than the planner's
    # (`music:youtube:<video id>`), so matching on one key alone let the seed
    # come back as its own runway — which the browser then dropped as a
    # duplicate and reported as a dry pool.
    if seed:
        excluded |= _candidate_keys(seed)
    unique: dict[str, dict] = {}
    seen: set[str] = set()
    for item in candidates:
        keys = _candidate_keys(item)
        if not keys or keys & excluded or keys & seen:
            continue
        seen |= keys
        unique[str(item.get("recommendation_identity") or item.get("id") or "")] = item
    # Repeating something the session has already heard beats stopping, but only
    # once the rest has been tried. Relaxing all the way back is what used to
    # hand the listener the track that was already playing.
    recent_heard = set(heard_order[-2:])
    available = [item for key, item in unique.items() if key not in heard]
    if not available:
        available = [item for key, item in unique.items() if key not in recent_heard]
    # Songs before anything song-sized is given up on: a source made only of
    # long recordings still opens rather than going silent.
    available = [item for item in available if _song_sized(item)] or available

    seed_material = f"{data.get('session_id', '')}:{segment_index}:{','.join(sorted(unique))}"
    entropy = int.from_bytes(hashlib.blake2s(seed_material.encode(), digest_size=8).digest(), "big")
    rng = random.Random(entropy)
    rng.shuffle(available)
    opening: dict | None = None
    opening_analysis: dict | None = None
    if not seed:
        # An empty session must open *inside the collection the listener just
        # handed to the DJ*, never on a related walk or implicit taste history.
        # Recent sources win; within a source the deterministic shuffle picks.
        roots = [
            item for item in available
            if item.get("reason_code") == "music_set_source"
        ]
        if not roots:
            return {"error": "sources contain no playable opening tracks"}, 400
        roots.sort(key=lambda item: -float(item.get("source_weight") or 0))
        opening = dict(roots[0])
        available = [item for item in available if item is not roots[0]]
        opening_analysis = _dj_item_analysis(metadata, opening, schedule=True)
        opening["analysis"] = opening_analysis
        opening.pop("transition", None)
        seed = opening
    # Sources and recommendation walks choose the music. Freeze membership
    # before reading any analysis so measured/local audio cannot displace cold
    # external songs. The DJ only orders this short, cache-independent set.
    cohort = available[:ANALYSIS_COHORT_SIZE]
    # Membership and the possible bridge pool are fixed before *any* cache read.
    # Coverage is observational: it cannot change who gets analysed or selected.
    snapshots = {id(item): _dj_item_analysis(metadata, item) for item in available}
    analysed = [(item, snapshots[id(item)]) for item in cohort[:limit]]
    spares = [(item, snapshots[id(item)]) for item in cohort[limit:]]
    previous = opening_analysis or _dj_item_analysis(metadata, seed, schedule=True)
    route = add_measured_bridges(previous, order_continuous_route(previous, analysed), spares)
    # Cold alternatives are not revisited after this response. Only actual
    # route members have a consumer for newly acquired bytes/measurements.
    if not has_request_context() or not request.headers.get("X-Soundsible-Work"):
        _dj_prepare_cohort(metadata, [seed, *route])
    coverage = {
        "candidates": len(available),
        "analysed": sum(bool(analysis.get("analysed")) for analysis in snapshots.values()),
        "cohort": len(cohort),
        "cohort_analysed": sum(bool(snapshots[id(item)].get("analysed")) for item in cohort),
        "bridges": sum(item.get("route_kind") == "bridge" for item in route),
    }
    # `empty_reason` is the only failure signal the route panel acts on, and
    # "exhausted" is terminal there: it stops the automatic retry and asks the
    # listener to press a button. Reserve it for a neighbourhood we actually
    # finished reading and found nothing in.
    if route:
        empty_reason = None
    elif degraded or warming:
        empty_reason = "temporary_failure"
    else:
        empty_reason = "exhausted"
    logger.info(
        "dj-plan session=%s segment=%d sources=%d candidates=%d unique=%d "
        "excluded=%d heard=%d cache_hit=%d cache_miss=%d warming=%s degraded=%s empty_reason=%s route=%d "
        "analysis_candidates=%d analysis_ready=%d analysis_cohort=%d analysis_cohort_ready=%d bridges=%d",
        data.get("session_id") or "-",
        segment_index,
        len(ordered_sources),
        len(candidates),
        len(unique),
        len(excluded),
        len(heard),
        cache_hit,
        cache_miss,
        warming,
        degraded,
        empty_reason,
        len(route),
        *coverage.values(),
    )
    return {
        "v": 6,
        "analysis_coverage": coverage,
        "plan_id": str(uuid.uuid4()),
        "intent": "auto_mode",
        "profile": "balanced",
        "source_profile": "balanced",
        "seed_identity": str(seed.get("id") or seed.get("youtube_id") or ""),
        "seed_analysis": _dj_analysis_summary(previous),
        **({"opening": {**opening, "analysis": _dj_analysis_summary(opening_analysis)}} if opening else {}),
        "items": [{**item, "analysis": _dj_analysis_summary(item["analysis"])} for item in route],
        "degraded": degraded,
        "warming": warming,
        "retry_after": _AUTO_GRAPH_RETRY_AFTER_SEC if warming else None,
        "empty_reason": empty_reason,
        "direction_revision": data.get("direction_revision"),
        "pool_counts": {
            "local": sum(1 for item in unique.values() if item.get("source_pool") == "local"),
            "related": sum(1 for item in unique.values() if item.get("source_pool") == "related"),
            "discovery": 0,
        },
        "generated_at": int(time.time()),
        "session_id": data.get("session_id"),
        "segment_index": segment_index,
    }, 200


@discovery_bp.route("/api/discovery/music/dj-plan", methods=["POST"])
@rate_limit("discovery_music_dj_plan", limit=60, window_sec=60)
@_dj_scoped
def discovery_music_dj_plan():
    """Build a short transition-aware route exclusively for Auto Mode."""
    data = request.get_json(silent=True) or {}
    if isinstance(data.get("sources"), list):
        payload, status = _build_music_set_route(data)
        return jsonify(payload), status
    # Older clients may still send dj_profile; technique selection is automatic.
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    if not seed:
        return jsonify({"error": "seed is required"}), 400
    try:
        requested_limit = min(8, max(3, int(data.get("limit") or 8)))
    except (TypeError, ValueError):
        return jsonify({"error": "limit must be numeric"}), 400
    source_profile = "balanced"
    base, status = _build_music_plan({
        "intent": "auto_mode",
        "profile": source_profile,
        "seed": seed,
        "context": data.get("context") or [],
        "session_id": data.get("session_id"),
        "segment_index": data.get("segment_index"),
        "exclude": data.get("exclude") or [],
        "limit": _AUTO_ROUTER_LIMIT,
    })
    if status != 200:
        return jsonify(base), status

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)
    candidates = []
    for candidate in base.get("items") or []:
        candidate_analysis = _dj_item_analysis(metadata, candidate)
        semantic_fit = max(0.0, min(1.0, float(candidate.get("semantic_score") or 0.5)))
        personal_fit = max(0.0, min(1.0, float(candidate.get("personal_score") or 0.5)))
        candidate["score"] = max(
            0.0,
            min(
                1.0,
                semantic_fit * 0.5
                + personal_fit * 0.15
                + float(candidate.get("score") or 0.5) * 0.05,
            ),
        )
        candidates.append((candidate, candidate_analysis))
    requests = [
        item
        for raw in (data.get("requests") if isinstance(data.get("requests"), list) else [])
        if isinstance(raw, dict) and (item := _normalise_dj_request(raw))
    ]

    route: list[dict] = []
    previous = seed_analysis
    remaining = list(candidates)
    max_items = requested_limit
    request_statuses: list[dict] = []
    for requested in requests:
        if len(route) >= max_items:
            break
        targets: list[dict]
        if requested["kind"] == "artist":
            from shared.user_context import current_user_id

            targets = _planner_artist_candidates(requested["artist_name"], current_user_id(), 8)
            for target in targets:
                target.update({
                    "request_id": requested["request_id"],
                    "reason": f"Requested artist: {requested['artist_name']}",
                    "reason_code": "dj_artist_request",
                })
        else:
            targets = [requested]
        measured_targets = [(target, _dj_item_analysis(metadata, target)) for target in targets]
        candidate_segment = choose_request_segment(previous, remaining, measured_targets,
                                                   max_starts=min(5, max_items - len(route)))
        if candidate_segment is None:
            request_statuses.append({
                "id": requested["request_id"],
                "kind": requested["kind"],
                "label": requested["label"],
                "status": "failed",
                "eta_tracks": None,
                "scheduled_position": None,
                "failure_code": "unavailable",
            })
            continue
        segment, requested_analysis = candidate_segment
        route.extend(segment)
        used = {str(item.get("recommendation_identity") or item.get("id")) for item in segment}
        remaining = [
            (item, analysis)
            for item, analysis in remaining
            if str(item.get("recommendation_identity") or item.get("id")) not in used
        ]
        previous = requested_analysis
        eta = next(
            (index + 1 for index, row in enumerate(route) if row.get("request_id") == requested["request_id"]),
            None,
        )
        request_statuses.append({
            "id": requested["request_id"],
            "kind": requested["kind"],
            "label": requested["label"],
            "status": "planned",
            "track_identity": next(
                (row.get("recommendation_identity") for row in route if row.get("request_id") == requested["request_id"]),
                None,
            ),
            "eta_tracks": eta,
            "scheduled_position": eta + 1 if eta is not None else None,
            "preferred_position": 2,
            "max_position": 6,
            "failure_code": None,
        })
    if len(route) < max_items:
        route.extend(order_route(
            previous,
            remaining,
            limit=max_items - len(route),
            source_sequence=base.get("source_sequence") or auto_source_sequence(source_profile),
            source_offset=len(route),
        ))

    # Only the accepted route is allowed to schedule local analysis. External
    # previews are fetched by the existing browser runway prefetch, then refined
    # shortly before their handoff.
    for item in route:
        _dj_item_analysis(metadata, item, schedule=True)

    return jsonify({
        **base,
        "v": 4,
        "source_profile": source_profile,
        "seed_analysis": seed_analysis,
        "items": route,
        "requests": request_statuses,
    })


def _dj_occupied_keys(data: dict, items) -> set[str]:
    """Every key of the songs a bridge must not repeat: the seed, `items`, avoided ones.

    One recording has several identities: `music:track:<id>` from the
    library, `music:youtube:<id>` from the catalogue, its canonical artist and
    title. Comparing one of them let a requested song come back as its own
    bridge — the library copy of «Teardrops (Rules Remix)» before the
    catalogue one, a perfect mix into itself — and the browser showed it twice.
    """
    occupied = {str(value) for value in (data.get("exclude") or []) if value}
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    if seed:
        occupied |= _candidate_keys(seed)
        parsed = _music_set_item(seed, source_id="route", label="Route")
        if parsed:
            occupied |= _candidate_keys(parsed)
    for item in items:
        occupied |= _candidate_keys(item)
    return occupied


def _dj_place_bridge_pool(metadata, data: dict, occupied: set[str]) -> list[tuple[dict, dict]]:
    """Build one-hop bridges from explicit sources and heard music only."""
    source_roots = []
    sources = data.get("sources") if isinstance(data.get("sources"), list) else []
    for source in sources:
        if not isinstance(source, dict):
            continue
        tracks = source.get("tracks") if isinstance(source.get("tracks"), list) else []
        for raw in tracks:
            if not isinstance(raw, dict):
                continue
            item = _music_set_item(
                raw,
                source_id=str(source.get("id") or "source"),
                label=str(source.get("label") or "Source"),
            )
            if item:
                source_roots.append(item)
    heard = data.get("exploration")
    if not isinstance(heard, list):
        heard = data.get("heard", []) if data.get("source_policy") != "explicit" else []
    if not isinstance(heard, list):
        heard = []
    heard_roots = []
    for raw in heard[-4:]:
        if not isinstance(raw, dict):
            continue
        item = _music_set_item(raw, source_id="heard", label="Heard", weight=0.3)
        if item:
            heard_roots.append(item)
    def walk(roots: list[dict]) -> list[tuple[dict, dict]]:
        if not roots:
            return []
        related = list(_planner_context_related(metadata, roots[-8:], personalise=False).items)
        candidates = []
        for item in related:
            keys = _candidate_keys(item)
            if not keys or keys & occupied or not _song_sized(item):
                continue
            occupied.update(keys)
            candidates.append((item, _dj_item_analysis(metadata, item)))
            if len(candidates) >= 12:
                break
        return candidates

    return walk([*source_roots, *heard_roots])


@discovery_bp.route("/api/discovery/music/dj-place", methods=["POST"])
@rate_limit("discovery_music_dj_place", limit=90, window_sec=60)
@_dj_scoped
def discovery_music_dj_place():
    """Place songs in the current route without rebuilding existing occurrences."""
    data = request.get_json(silent=True) or {}
    requests = data.get("requests")
    if requests is None:
        body, status = _dj_place_one(data)
        return jsonify(body), status
    if not isinstance(requests, list) or not requests:
        return jsonify({"error": "requests must be a non-empty list"}), 400
    ids = [str(row.get("requested_queue_id") or "") for row in requests if isinstance(row, dict)]
    if len(ids) != len(requests) or not all(ids) or len(set(ids)) != len(ids):
        return jsonify({"error": "each request needs a unique requested_queue_id"}), 400
    route = list(data.get("route") or [])
    placements = []
    for requested in requests:
        result, status = _dj_place_one({**data, **requested, "route": route})
        if status != 200:
            return jsonify(result), status
        # Give bridge occurrences identities that the browser can reproduce.
        for index, item in enumerate(result["items"]):
            item["queue_id"] = (result["requested_queue_id"] if item["route_kind"] == "user"
                                else f"{result['requested_queue_id']}:bridge:{index}")
        route[result["insert_at"]:result["insert_at"]] = result["items"]
        placements.append(result)
    return jsonify({"placements": placements}), 200


def _dj_place_one(data: dict) -> tuple[dict, int]:
    """Plan one insertion; collection requests reuse the same scoring contract."""
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    raw_track = data.get("track") if isinstance(data.get("track"), dict) else {}
    raw_route = data.get("route") if isinstance(data.get("route"), list) else []
    requested_queue_id = str(data.get("requested_queue_id") or "").strip()
    if not seed or not raw_track or not requested_queue_id:
        return ({"error": "seed, track and requested_queue_id are required"}), 400
    # Older clients may still send dj_profile; technique selection is automatic.

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)
    target = _music_set_item(raw_track, source_id="route", label="Route")
    if not target:
        return ({"error": "track cannot be placed"}), 400
    target.update({
        "request_id": requested_queue_id,
        "reason": "Placed in route",
        "reason_code": "route_user",
    })
    target_analysis = _dj_item_analysis(metadata, target, schedule=True)

    # A listener-selected seam may sit beyond the automatic analysis horizon.
    # Score only its immediate neighbours, then translate the local insertion
    # back to the full route. Long collections must not invalidate that seam.
    before_queue_id = str(data.get("before_queue_id") or "").strip()
    route_offset = 0
    if before_queue_id:
        raw_index = next((index for index, row in enumerate(raw_route)
                          if isinstance(row, dict) and row.get("queue_id") == before_queue_id), None)
        if raw_index is None:
            return {"error": "before_queue_id is not in the editable route"}, 409
        if raw_index >= 16:
            seed = raw_route[raw_index - 1]
            route_offset = raw_index

    route: list[tuple[dict, dict]] = []
    horizon = raw_route[route_offset:route_offset + (1 if route_offset else 16)]
    for raw in horizon:
        if not isinstance(raw, dict):
            continue
        item = _music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        route.append((item, _dj_item_analysis(metadata, item)))
    occupied = _dj_occupied_keys(data, [target, *(item for item, _ in route)])

    fixed_index = next(
        (index for index, (item, _) in enumerate(route) if item.get("queue_id") == before_queue_id),
        None,
    ) if before_queue_id else None
    if before_queue_id and fixed_index is None:
        return ({"error": "before_queue_id is not in the editable route"}), 409
    bridge_pool = [] if fixed_index is not None else _dj_place_bridge_pool(metadata, data, occupied)
    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)

    placement = choose_placement(seed_analysis, route, (target, target_analysis), bridge_pool,
                                 fixed_index=fixed_index)
    if placement is None:
        return ({"error": "route has no editable gap"}), 409
    insert_at, segment, following = placement
    items = []
    for row in segment:
        placed = dict(row)
        is_target = placed.get("request_id") == requested_queue_id
        placed["route_kind"] = "user" if is_target else "bridge"
        if not is_target:
            placed["owner_queue_id"] = requested_queue_id
        items.append(placed)
        _dj_item_analysis(metadata, placed, schedule=True)
    return ({
        "v": 1,
        "insert_at": route_offset + insert_at,
        "before_queue_id": route[insert_at][0].get("queue_id") if insert_at < len(route) else None,
        "requested_queue_id": requested_queue_id,
        "items": items,
        "following_transition": following,
        "degraded": not bool(target_analysis.get("analysed")),
    }), 200


def _dj_repair_anchor(raw: dict) -> dict:
    """A pinned song keeps its slot even when the planner cannot name it.

    Placement is free to skip a reference it cannot read; repair is not. The
    listener put this song where it is, so an unreadable reference becomes an
    opaque anchor with a conservative reading rather than a hole in their route.
    """
    item = _music_set_item(raw, source_id="route", label="Route")
    if item:
        return item
    title = str(raw.get("title") or "Unknown")
    artist = str(raw.get("artist") or "")
    identity = canonical_music_identity(artist, title, channel=artist)
    recommendation_identity = str(raw.get("recommendation_identity") or identity.key)
    return {
        "id": str(raw.get("id") or raw.get("queue_id") or ""),
        "track_id": None,
        "youtube_id": None,
        "title": identity.title,
        "artist": identity.artist,
        "source_title": title,
        "source_artist": artist,
        "playback_source_kind": identity.source_kind,
        "canonical_identity": identity.key,
        "album": str(raw.get("album") or ""),
        "duration": int(raw.get("duration") or 0),
        "cover": str(raw.get("cover") or ""),
        "source": "preview",
        "source_pool": "local",
        "reason": "Placed in route",
        "reason_code": "route_user",
        "recommendation_identity": recommendation_identity,
        "score": 1.0,
        "external_ids": {},
        "source_set_id": "route",
        "source_set_label": "Route",
        "source_weight": 1.0,
        "lineage": [recommendation_identity],
    }


@discovery_bp.route("/api/discovery/music/dj-repair", methods=["POST"])
@rate_limit("discovery_music_dj_repair", limit=30, window_sec=60)
@_dj_scoped
def discovery_music_dj_repair():
    """Rebuild the mix around whatever the listener has done to the route.

    Every song they placed keeps its slot and its order; the material between
    those anchors is re-chosen so each seam mixes. Placement can pin a song or
    bridge into one, never both — `dj-place` drops its bridge pool the moment a
    position is fixed. This does both at once, which is what makes "move things
    around, then press the button" safe.

    Stateless like the rest of the DJ surface: the whole route is posted, and
    the whole repaired route comes back. A diff would force the caller to
    rebuild a transition chain across items it never received, which is exactly
    how a cue ends up belonging to the wrong song.
    """
    data = request.get_json(silent=True) or {}
    seed = data.get("seed") if isinstance(data.get("seed"), dict) else {}
    raw_route = data.get("route") if isinstance(data.get("route"), list) else []
    if not seed or not raw_route:
        return jsonify({"error": "seed and route are required"}), 400
    # Older clients may still send dj_profile; technique selection is automatic.
    raw_limit = data.get("limit")
    if raw_limit is not None and not isinstance(raw_limit, int):
        return jsonify({"error": "limit must be an integer"}), 400

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)

    refs = [raw for raw in raw_route[:_DJ_REPAIR_ROUTE_CAP] if isinstance(raw, dict)]
    parsed: list[tuple[bool, dict, dict]] = []
    for raw in refs:
        pinned = str(raw.get("route_kind") or "generated").strip() == "user"
        item = _dj_repair_anchor(raw) if pinned else _music_set_item(raw, source_id="route", label="Route")
        if not item:
            continue
        item["queue_id"] = str(raw.get("queue_id") or "")
        parsed.append((pinned, item, _dj_item_analysis(metadata, item)))
    if not parsed:
        return jsonify({"error": "route has nothing to repair"}), 400

    anchors = [(item, analysis) for pinned, item, analysis in parsed if pinned]
    spares = [(item, analysis) for pinned, item, analysis in parsed if not pinned]
    occupied = _dj_occupied_keys(data, [item for item, _ in (*anchors, *spares)])
    extra_pool = _dj_place_bridge_pool(metadata, data, occupied)
    seed_analysis = _dj_item_analysis(metadata, seed, schedule=True)
    target = min(_DJ_REPAIR_ROUTE_CAP, max(len(refs), int(raw_limit or len(refs))))
    built = repair_route(seed_analysis, parsed, extra_pool, target=target)

    for row in built:
        row["queue_id"] = row.get("queue_id") or None
        _dj_item_analysis(metadata, row, schedule=True)

    kept = {row["queue_id"] for row in built if row["queue_id"]}
    return jsonify({
        "v": 1,
        "seed_analysis": seed_analysis,
        "items": built,
        "dropped": [
            queue_id for raw in refs
            if (queue_id := str(raw.get("queue_id") or "")) and queue_id not in kept
        ],
        "degraded": any(not analysis.get("analysed") for _, analysis in anchors),
    }), 200


@discovery_bp.route("/api/discovery/music/dj-transition", methods=["POST"])
@rate_limit("discovery_music_dj_transition", limit=240, window_sec=60)
@_dj_scoped
def discovery_music_dj_transition():
    """Re-plan a single transition against whatever is now measured.

    The route endpoint answers immediately with conservative transitions for
    anything it has not measured yet. This is how those become real ones: the
    player asks again shortly before it commits a handoff, and if the background
    analysis has landed it gets the beatmatched plan instead of the fade. It is
    cache-only by design — it never triggers a decode, so it always returns fast.
    """
    data = request.get_json(silent=True) or {}
    # Older clients may still send dj_profile; technique selection is automatic.
    outgoing = data.get("from") if isinstance(data.get("from"), dict) else None
    incoming = data.get("to") if isinstance(data.get("to"), dict) else None
    if not outgoing or not incoming:
        return jsonify({"error": "from and to are required"}), 400

    demand = work.current()
    if demand is not None and not request.headers.get("X-Soundsible-Work"):
        interested = getattr(demand, "tracks", {})
        interested.update({analysis_identity(item): dict(item) for item in (outgoing, incoming)})
        demand.tracks = interested

    api = _get_api()
    lib, _, _ = api["get_core"]()
    metadata = getattr(lib, "metadata", None)

    def measured(item: dict) -> tuple[dict, bool]:
        path = _dj_source_path(metadata, item)
        analysis = cached_analysis(path, analysis_identity(item)) if path else None
        if analysis is not None:
            return analysis, True
        if path and not request.headers.get("X-Soundsible-Work"):
            request_analysis(path, analysis_identity(item), duration_hint=float(item.get("duration") or 0))
        return _dj_fallback_analysis(float(item.get("duration") or 0)), False

    out_analysis, out_ready = measured(outgoing)
    in_analysis, in_ready = measured(incoming)
    return jsonify({
        "transition": plan_transition(out_analysis, in_analysis),
        "analysis": {"from": out_analysis, "to": in_analysis},
        "measured": out_ready and in_ready,
    })


@discovery_bp.route("/api/discovery/music/dj-work", methods=["POST"])
@rate_limit("discovery_music_dj_work", limit=120, window_sec=60)
@_dj_scoped
def discovery_music_dj_work():
    data = request.get_json(silent=True) or {}
    demand = work.current()
    cancelled = data.get("cancel_request")
    if isinstance(cancelled, str):
        if not work._KEY.fullmatch(cancelled):
            return jsonify({"error": "invalid request id"}), 400
        demand.finish_request(cancelled)
        child = demand.children.pop(cancelled, None)
        if child is not None:
            child.close()
        return jsonify({"cancelled": True})
    if not data.get("active", True):
        demand.close()
        return jsonify({"active": False})
    tracks = data.get("tracks", [])
    if not isinstance(tracks, list) or len(tracks) > 64 or any(not isinstance(item, dict) for item in tracks):
        return jsonify({"error": "invalid runway"}), 400
    api = _get_api()
    lib, _, _ = api["get_core"]()
    from shared.dj.session import sync
    sync(getattr(lib, "metadata", None), tracks, data.get("revision", 0))
    return jsonify({"active": True})
