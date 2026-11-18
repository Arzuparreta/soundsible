"""Candidate pools for generated queues: Autoplay, Radio and the DJ.

A seed becomes candidates drawn from the local library, the related-video graph
and related artists, each reconciled to the listener's own copy and resolved to
a playable source. `music_plan` ranks them into a queue; `shared.dj.planning`
orders them into a DJ route.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from concurrent.futures import Future, wait
from typing import NamedTuple


from shared import catalog_resolution, deezer_catalog, request_scope
from shared.database import instance_db
from shared.discovery_intelligence import (
    rank_recommendation_rows,
)
from shared.music_identity import canonical_music_identity, clean_artist, youtube_music_metadata
from shared.url_utils import validate_youtube_video_id

from shared import work
from concurrent.futures import ThreadPoolExecutor

from shared.download_pump import get_downloader, queue_manager_dl, start_downloader_pump
from shared.download_queue import parse_intake_item
from shared.realtime import emit_to_user
from shared.user_context import current_user_id
from shared.user_cores import favourite_library_ids, get_library

logger = logging.getLogger(__name__)

# Resolution of generated candidates to playable sources runs off the request
# thread. Related extraction has a shared demand-owned lane in shared/related_work.py.
_PLAN_RESOLVE_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="soundsible-plan-resolve")
CANONICAL_RESOLVE_BUDGET_SEC = 2.5
AUTO_CONTEXT_MAX = 5
AUTO_GRAPH_ANCHORS = 4
AUTO_GRAPH_FETCH_MISSES = 4
# How long a caller waits for a cold related mix before answering "still
# warming". The fetch it started is never thrown away: it keeps running, fills
# the cache, and the next call is a hit.
AUTO_GRAPH_WAIT_SEC = 8
AUTO_GRAPH_RETRY_AFTER_SEC = 2.0
AUTO_RAW_LIMIT = 100
AUTO_SHORTLIST_LIMIT = 48
AUTO_ROUTER_LIMIT = 24


def engine_api() -> dict:
    """The engine services the planner calls, looked up at call time.

    One module attribute, so a test can replace every planner and DJ caller's
    view of the library and downloader at once.
    """
    return {
        "get_library": get_library,
        "user_id": current_user_id(),
        "get_downloader": get_downloader,
        "queue_manager_dl": queue_manager_dl,
        "start_downloader_pump": start_downloader_pump,
        "parse_intake_item": parse_intake_item,
        "favourite_library_ids": favourite_library_ids,
        "emit_to_user": emit_to_user,
    }

_RESOLUTION_WORK = work.Executor("planner-resolution", 4)


def submit_resolution(fn, *args):
    if work.current() is None:
        return _PLAN_RESOLVE_EXECUTOR.submit(fn, *args)
    name = getattr(fn, "__qualname__", type(fn).__name__)
    key = hashlib.sha256(f"{name}:{args!r}".encode()).hexdigest()
    return _RESOLUTION_WORK.submit(key, fn, *args)

def track_index(metadata) -> dict:
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


def track_by_id(metadata, track_id: str):
    if not track_id:
        return None
    return track_index(metadata).get(str(track_id))


def library_identity(track) -> str:
    """A library track's song key, from its own tags rather than an upload's."""
    return canonical_music_identity(track.artist, track.title, authoritative=True).key


def reconcile_library_sources(metadata, items: list[dict]) -> list[dict]:
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
    by_item = request_scope.scoped(f"planner_item_index:{id(metadata)}:{len(tracks)}",
        lambda: {track.item_id: track for track in reversed(tracks) if getattr(track, 'item_id', None)})
    reconciled = []
    for item in items:
        if item.get("track_id"):
            track = None
        elif item.get("item_id"):
            # Known musical identity is authoritative even if another edition
            # happens to use the same video. A missing source stays missing.
            track = by_item.get(item['item_id'])
        else:
            track = by_video.get(str(item.get("youtube_id") or ""))
        if track is None:
            reconciled.append(item)
            continue
        reconciled.append({
            **item,
            "id": str(track.id),
            "item_id": getattr(track, "item_id", None),
            "track_id": str(track.id),
            "source": "library",
            "title": str(track.title or "Unknown"),
            "artist": str(track.artist or track.album_artist or ""),
            "artists": getattr(track, "artists", None),
            "artist_is_channel": False,
            "album": str(track.album or ""),
            "duration": int(track.duration or 0),
            "cover": str(getattr(track, "cover_art_key", "") or item.get("cover") or ""),
            "canonical_identity": library_identity(track),
        })
    return reconciled


def collection_item_id(video_id, supplied=None, file_id=None):
    from shared.collection import Collection
    return request_scope.scoped(f'collection_item:{video_id}:{supplied or ""}:{file_id or ""}',
        lambda: Collection().identify(([f'item:{supplied}'] if supplied else []) + ([f'lib:{file_id}'] if file_id else []) + [f'yt:{video_id}']))


def item_from_related(row: dict) -> dict | None:
    video_id = str(row.get("video_id") or row.get("id") or "").strip()
    if not validate_youtube_video_id(video_id):
        return None
    music = youtube_music_metadata(row)
    return {
        "id": video_id,
        "item_id": collection_item_id(video_id),
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


def item_from_feed(item: dict, *, pool: str) -> dict | None:
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
        "item_id": item.get("item_id") or collection_item_id(video_id),
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


def candidate_keys(item: dict) -> set[str]:
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


class GraphWalk(NamedTuple):
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


def planner_artist_key(value: object) -> str:
    return clean_artist(value).casefold()


def video_id_for(metadata, item: dict) -> str:
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
    track = track_by_id(metadata, track_id) if track_id else None
    candidate = str(getattr(track, "youtube_id", "") or "")
    return candidate if validate_youtube_video_id(candidate) else ""


def resolve_generated_playback(item: dict, user_id: str | None) -> dict:
    """Prefer a canonical upload while retaining the discovery graph identity."""
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
        best, candidates = catalog_resolution.resolve_candidates(
            engine_api()["get_downloader"],
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


def canonicalize_generated_items(items: list[dict], user_id: str | None) -> list[dict]:
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
        future = submit_resolution(resolve_generated_playback, dict(item), user_id)
        futures[future] = index
        submitted += 1
    if not futures:
        return items
    done, _ = wait(futures, timeout=CANONICAL_RESOLVE_BUDGET_SEC)
    resolved = list(items)
    for future in done:
        try:
            resolved[futures[future]] = future.result()
        except Exception as exc:
            logger.debug("Generated playback source resolve failed: %s", exc)
    return resolved


def planner_context(seed: dict, raw_context: object) -> list[dict]:
    rows = [
        dict(item)
        for item in (raw_context if isinstance(raw_context, list) else [])
        if isinstance(item, dict)
    ][-AUTO_CONTEXT_MAX:]
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
    return deduped[-AUTO_CONTEXT_MAX:]


def uncached_related(video_id: str) -> list[dict]:
    api = engine_api()
    rows = api["get_downloader"](open_browser=False).downloader.get_related_videos(
        video_id,
        max_results=25,
        enrich=False,
    )
    return rows


_GRAPH_INFLIGHT: dict[str, Future] = {}
_GRAPH_INFLIGHT_LOCK = threading.Lock()


def related_future(video_id: str) -> Future:
    """One fetch per seed, however many callers want it.

    A cold seed outlives the caller that asked for it: the wait expires, the
    listener retries, and without this every retry queued *another* copy of the
    same fetch against the same threads — so the retries were competing with the
    work that would have answered them. Joining the live future instead means a
    retry either finds the cache warm or waits on the fetch already running.
    """
    with _GRAPH_INFLIGHT_LOCK:
        from shared.related_work import submit
        future = submit(video_id, lambda: uncached_related(video_id))
        _GRAPH_INFLIGHT[video_id] = future

    def _release(_done: Future, key: str = video_id) -> None:
        with _GRAPH_INFLIGHT_LOCK:
            if _GRAPH_INFLIGHT.get(key) is _done:
                _GRAPH_INFLIGHT.pop(key, None)

    future.add_done_callback(_release)
    return future


def context_related(
    metadata,
    context: list[dict],
    *,
    personalise: bool = True,
) -> GraphWalk:
    """Collect a bounded semantic neighbourhood around the route that survives."""
    anchors: list[tuple[str, float]] = []
    for index, item in enumerate(context[-AUTO_GRAPH_ANCHORS:]):
        video_id = video_id_for(metadata, item)
        if not video_id:
            continue
        recency = 0.64 + 0.36 * ((index + 1) / min(len(context), AUTO_GRAPH_ANCHORS))
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

    warming = len(misses) > AUTO_GRAPH_FETCH_MISSES
    futures = {
        related_future(video_id): video_id
        for video_id in misses[:AUTO_GRAPH_FETCH_MISSES]
    }
    if futures:
        done, pending = wait(futures, timeout=AUTO_GRAPH_WAIT_SEC)
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
            item = item_from_related(raw)
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
            if len(candidates) >= AUTO_RAW_LIMIT:
                break
        if len(candidates) >= AUTO_RAW_LIMIT:
            break
    return GraphWalk(
        reconcile_library_sources(metadata, list(candidates.values())),
        any(video_id not in mixes for video_id, _ in anchors),
        warming,
        len(anchors) - len(misses),
        len(misses),
    )


def related_artist_pool(
    seed_artist: str,
    user_id: str | None,
    limit: int = 6,
) -> tuple[list[str], list[dict]]:
    """Return related artist names plus one playable representative per artist."""
    if not seed_artist:
        return [], []
    try:
        artist_id, _ = deezer_catalog.resolve_artist_id(seed_artist)
        if not artist_id:
            return [], []
        related_rows = deezer_catalog.related_artists(artist_id, max(6, limit))[:limit]
    except Exception as exc:
        logger.info("Auto related artists unavailable for %s: %s", seed_artist, exc)
        return [], []

    names = [str(row.get("name") or "").strip() for row in related_rows if str(row.get("name") or "").strip()]
    futures = {
        submit_resolution(deezer_catalog.artist_top_tracks, str(row["deezer_id"]), 1): index
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
        submit_resolution(resolve_artist_candidate, item, user_id): index
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


def local_item(track, *, semantic_score: float, basis: str, favourite: bool) -> dict:
    video_id = str(getattr(track, "youtube_id", "") or "")
    score = min(1.0, semantic_score * 0.82 + (0.16 if favourite else 0.06))
    return {
        "id": str(track.id),
        "item_id": getattr(track, "item_id", None),
        "track_id": str(track.id),
        "youtube_id": video_id or None,
        "title": str(track.title or "Unknown"),
        "artist": str(track.artist or track.album_artist or ""),
        "album": str(track.album or ""),
        "duration": int(track.duration or 0),
        "cover": str(getattr(track, "cover_art_key", "") or ""),
        "source": "library",
        "source_pool": "local",
        "canonical_identity": library_identity(track),
        "reason": "From your library and inside this session's musical path.",
        "reason_code": "session_library",
        "recommendation_identity": f"music:track:{track.id}",
        "score": round(score, 6),
        "semantic_score": round(semantic_score, 6),
        "semantic_basis": basis,
        "personal_score": 1.0 if favourite else 0.55,
        "external_ids": {"youtube_id": video_id} if video_id else {},
    }


def build_auto_pools(
    metadata,
    context: list[dict],
    *,
    favourite_ids: set[str],
    user_id: str | None,
) -> tuple[dict[str, list[dict]], bool]:
    walk = context_related(metadata, context)
    related = list(walk.items)
    # This pool feeds the legacy plan and the discovery feed, neither of which
    # has a "still warming" state to show. For them an unfinished walk is simply
    # one more way of being degraded.
    graph_degraded = walk.degraded or walk.warming
    seed_artist = str(context[-1].get("artist") or "") if context else ""
    related_artists, discovery = related_artist_pool(seed_artist, user_id)
    related_artist_keys = {planner_artist_key(name) for name in related_artists}
    context_artist_keys = {
        planner_artist_key(item.get("artist"))
        for item in context
        if planner_artist_key(item.get("artist"))
    }
    semantic_by_video = {
        str(item.get("youtube_id") or ""): float(item.get("semantic_score") or 0)
        for item in related
        if item.get("youtube_id")
    }

    local: list[dict] = []
    for track in list(metadata.tracks if metadata and metadata.tracks else []):
        artist_key = planner_artist_key(track.artist or track.album_artist)
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
        local.append(local_item(
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
        "local": local[:AUTO_SHORTLIST_LIMIT],
        "related": related[:AUTO_SHORTLIST_LIMIT],
        "discovery": discovery[:AUTO_SHORTLIST_LIMIT],
    }, graph_degraded


def resolve_artist_candidate(item: dict, user_id: str | None) -> dict | None:
    from shared.user_context import user_context

    with user_context(user_id):
        best, _ = catalog_resolution.resolve_candidates(
            engine_api()["get_downloader"],
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
    return item_from_feed(resolved, pool="related")


def annotate_plan_loudness(metadata, items: list[dict]) -> list[dict]:
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
        track = track_by_id(metadata, str(row.get("track_id") or row.get("id") or ""))
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
