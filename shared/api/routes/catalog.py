from __future__ import annotations

import logging
import re
import time
from typing import Any

import requests
from flask import Blueprint, jsonify, request

try:
    import gevent
    from gevent import spawn, joinall
    _HAS_GEVENT = True
except ImportError:  # pragma: no cover
    _HAS_GEVENT = False

from shared.database import DatabaseManager
from shared.hardening import rate_limit
from shared.resolution_confidence import best_candidate, classify_confidence
from shared.text_utils import sanitize_cli_message
from shared.url_utils import validate_youtube_video_id

logger = logging.getLogger(__name__)

catalog_bp = Blueprint("catalog", __name__, url_prefix="")

_DEEZER_HOST = "https://api.deezer.com"
_MUSICBRAINZ_HOST = "https://musicbrainz.org/ws/2"
_CATALOG_CACHE_TTL_SEC = 180
_CATALOG_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_ARTIST_CACHE_TTL_SEC = 600
_ARTIST_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_ALBUM_CACHE_TTL_SEC = 600
_ALBUM_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
# Every distinct query/artist/album mints a cache entry, so an unbounded dict
# grows for the lifetime of a long-running server. Expired entries are dropped
# on write and the cache is capped by evicting whatever expires soonest.
_CACHE_MAX_ENTRIES = 256
_DEEZER_FANOUT_TIMEOUT_SEC = 12
_MUSICBRAINZ_HEADERS = {
    "User-Agent": "Soundsible/1.0 (https://github.com/Arzuparreta/soundsible)",
    "Accept": "application/json",
}


def _cache_get(cache: dict[str, tuple[float, dict[str, Any]]], key: str) -> dict[str, Any] | None:
    entry = cache.get(key)
    if not entry:
        return None
    if entry[0] <= time.time():
        cache.pop(key, None)
        return None
    return dict(entry[1])


def _cache_put(
    cache: dict[str, tuple[float, dict[str, Any]]],
    key: str,
    ttl_sec: int,
    body: dict[str, Any],
) -> None:
    now = time.time()
    cache[key] = (now + ttl_sec, dict(body))
    for expired in [k for k, (expires_at, _) in cache.items() if expires_at <= now]:
        cache.pop(expired, None)
    while len(cache) > _CACHE_MAX_ENTRIES:
        cache.pop(min(cache.items(), key=lambda kv: kv[1][0])[0], None)


def _get_api():
    import shared.api as api_mod

    return {
        "get_core": api_mod.get_core,
        "get_downloader": api_mod.get_downloader,
        "queue_manager_dl": api_mod.queue_manager_dl,
        "start_downloader_pump": api_mod.start_downloader_pump,
        "parse_intake_item": api_mod.parse_intake_item,
    }


def _clean(value: object, max_len: int = 240) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:max_len]


def _norm(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().casefold())


def _key(title: object, artist: object) -> str:
    return f"{_norm(artist)}\x00{_norm(title)}"


def _duration(value: object) -> int | None:
    try:
        num = int(float(value))
    except (TypeError, ValueError):
        return None
    return num if num > 0 else None


def _track_dict(track) -> dict[str, Any]:
    return track.to_dict() if hasattr(track, "to_dict") else dict(track)


def _cover_from_track(track) -> str:
    return getattr(track, "cover_art_key", None) or ""


def _catalog_item(
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


def _rank(item: dict[str, Any], query: str, index: int) -> float:
    q = _norm(query)
    title = _norm(item.get("title"))
    artist = _norm(item.get("artist") or item.get("subtitle"))
    score = 0.0
    if title == q:
        score += 100
    elif title.startswith(q):
        score += 70
    elif q and q in title:
        score += 42
    if artist == q:
        score += 48
    elif artist.startswith(q):
        score += 32
    elif q and q in artist:
        score += 18
    if item.get("action_state", {}).get("in_library"):
        score += 35
    type_boost = {"library_track": 18, "track": 12, "artist": 7, "album": 5, "playlist": 4}
    score += type_boost.get(str(item.get("type")), 0)
    score += min(25.0, float(item.get("popularity") or 0) / 40000.0)
    return score - index * 0.01


def _dedupe(items: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    for idx, item in enumerate(items):
        ids = item.get("external_ids") or {}
        if item.get("track_id"):
            dedupe_key = f"library:{item['track_id']}"
        elif ids.get("isrc"):
            dedupe_key = f"isrc:{_norm(ids.get('isrc'))}"
        elif ids.get("deezer_id"):
            dedupe_key = f"deezer:{ids.get('deezer_id')}"
        elif ids.get("musicbrainz_id"):
            dedupe_key = f"mb:{ids.get('musicbrainz_id')}"
        else:
            dedupe_key = f"{item.get('type')}:{_key(item.get('title'), item.get('artist') or item.get('subtitle'))}"

        item["_rank"] = _rank(item, query, idx)
        existing = by_key.get(dedupe_key)
        if not existing or item["_rank"] > existing["_rank"]:
            by_key[dedupe_key] = item

    return [
        {k: v for k, v in item.items() if k != "_rank"}
        for item in sorted(by_key.values(), key=lambda x: x["_rank"], reverse=True)
    ]


def _local_catalog(query: str, limit: int) -> list[dict[str, Any]]:
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    q = _norm(query)
    out: list[dict[str, Any]] = []
    seen_artists: set[str] = set()
    seen_albums: set[str] = set()

    for track in tracks:
        title = getattr(track, "title", "") or ""
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        album = getattr(track, "album", "") or ""
        haystack = f"{title} {artist} {album}".casefold()
        if q and q not in haystack:
            continue
        out.append(
            _catalog_item(
                item_id=f"library:track:{track.id}",
                item_type="library_track",
                source="library",
                title=title,
                subtitle=artist,
                artist=artist,
                album=album,
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
        artist_key = _norm(artist)
        if artist_key and artist_key not in seen_artists and q in artist_key:
            seen_artists.add(artist_key)
            out.append(
                _catalog_item(
                    item_id=f"library:artist:{artist_key}",
                    item_type="artist",
                    source="library",
                    title=artist,
                    subtitle="Artist in your library",
                    artist=artist,
                    cover=_cover_from_track(track),
                    track_id=None,
                    in_library=True,
                    playable=False,
                    downloadable=False,
                    raw={"artist": artist},
                )
            )
        album_key = f"{_norm(artist)}\x00{_norm(album)}"
        if album and album_key not in seen_albums and (q in _norm(album) or q in artist_key):
            seen_albums.add(album_key)
            out.append(
                _catalog_item(
                    item_id=f"library:album:{album_key}",
                    item_type="album",
                    source="library",
                    title=album,
                    subtitle=artist,
                    artist=artist,
                    album=album,
                    cover=_cover_from_track(track),
                    in_library=True,
                    playable=False,
                    downloadable=False,
                    raw={"artist": artist, "album": album},
                )
            )
        if len(out) >= limit:
            break
    return out[:limit]


def _deezer_search(query: str, limit: int) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{_DEEZER_HOST}/search",
        params={"q": query, "limit": min(limit, 25)},
        timeout=6,
        headers={"User-Agent": "SoundsibleCatalog/1.0"},
    )
    resp.raise_for_status()
    data = resp.json()
    rows = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    seen_artists: set[str] = set()
    seen_albums: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
        title = _clean(row.get("title_short") or row.get("title"))
        artist = _clean(artist_row.get("name") or row.get("artist"))
        album = _clean(album_row.get("title"))
        if title and artist:
            deezer_id = str(row.get("id") or "")
            out.append(
                _catalog_item(
                    item_id=f"deezer:track:{deezer_id}",
                    item_type="track",
                    source="deezer",
                    title=title,
                    subtitle=artist,
                    artist=artist,
                    album=album,
                    duration=_duration(row.get("duration")),
                    cover=album_row.get("cover_xl") or album_row.get("cover_big") or album_row.get("cover_medium") or "",
                    popularity=float(row.get("rank") or 0),
                    external_ids={"deezer_id": deezer_id},
                    attribution_url=row.get("link") or "",
                    raw={"deezer_id": deezer_id},
                )
            )
        artist_id = str(artist_row.get("id") or "")
        if artist and artist_id and artist_id not in seen_artists:
            seen_artists.add(artist_id)
            out.append(
                _catalog_item(
                    item_id=f"deezer:artist:{artist_id}",
                    item_type="artist",
                    source="deezer",
                    title=artist,
                    subtitle="Artist",
                    artist=artist,
                    cover=artist_row.get("picture_xl") or artist_row.get("picture_big") or artist_row.get("picture_medium") or "",
                    external_ids={"deezer_artist_id": artist_id},
                    attribution_url=artist_row.get("link") or "",
                    downloadable=False,
                    raw={"deezer_artist_id": artist_id},
                )
            )
        album_id = str(album_row.get("id") or "")
        if album and album_id and album_id not in seen_albums:
            seen_albums.add(album_id)
            out.append(
                _catalog_item(
                    item_id=f"deezer:album:{album_id}",
                    item_type="album",
                    source="deezer",
                    title=album,
                    subtitle=artist,
                    artist=artist,
                    album=album,
                    cover=album_row.get("cover_xl") or album_row.get("cover_big") or album_row.get("cover_medium") or "",
                    external_ids={"deezer_album_id": album_id},
                    attribution_url=album_row.get("link") or "",
                    downloadable=False,
                    raw={"deezer_album_id": album_id},
                )
            )
    return out


def _musicbrainz_search(query: str, limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    per_type = max(3, min(8, limit // 3))
    for entity, item_type, params in (
        ("recording", "track", {"query": query, "limit": per_type, "fmt": "json"}),
        ("artist", "artist", {"query": query, "limit": per_type, "fmt": "json"}),
        ("release-group", "album", {"query": query, "limit": per_type, "fmt": "json", "type": "album"}),
    ):
        resp = requests.get(
            f"{_MUSICBRAINZ_HOST}/{entity}/",
            params=params,
            timeout=6,
            headers=_MUSICBRAINZ_HEADERS,
        )
        resp.raise_for_status()
        data = resp.json()
        rows = data.get(f"{entity}s") if isinstance(data, dict) else []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            mbid = _clean(row.get("id"), 80)
            if not mbid:
                continue
            if item_type == "track":
                artist_credit = row.get("artist-credit") if isinstance(row.get("artist-credit"), list) else []
                artist = _clean(artist_credit[0].get("name") if artist_credit and isinstance(artist_credit[0], dict) else "")
                title = _clean(row.get("title"))
                if not title:
                    continue
                out.append(
                    _catalog_item(
                        item_id=f"musicbrainz:track:{mbid}",
                        item_type="track",
                        source="musicbrainz",
                        title=title,
                        subtitle=artist,
                        artist=artist,
                        duration=_duration((row.get("length") or 0) / 1000 if row.get("length") else None),
                        popularity=float(row.get("score") or 0),
                        external_ids={"musicbrainz_id": mbid},
                        attribution_url=f"https://musicbrainz.org/recording/{mbid}",
                        raw={"musicbrainz_id": mbid},
                    )
                )
            elif item_type == "artist":
                name = _clean(row.get("name"))
                if name:
                    out.append(
                        _catalog_item(
                            item_id=f"musicbrainz:artist:{mbid}",
                            item_type="artist",
                            source="musicbrainz",
                            title=name,
                            subtitle=_clean(row.get("disambiguation")) or "Artist",
                            artist=name,
                            popularity=float(row.get("score") or 0),
                            external_ids={"musicbrainz_artist_id": mbid},
                            attribution_url=f"https://musicbrainz.org/artist/{mbid}",
                            downloadable=False,
                            raw={"musicbrainz_artist_id": mbid},
                        )
                    )
            else:
                title = _clean(row.get("title"))
                artist_credit = row.get("artist-credit") if isinstance(row.get("artist-credit"), list) else []
                artist = _clean(artist_credit[0].get("name") if artist_credit and isinstance(artist_credit[0], dict) else "")
                if title:
                    out.append(
                        _catalog_item(
                            item_id=f"musicbrainz:album:{mbid}",
                            item_type="album",
                            source="musicbrainz",
                            title=title,
                            subtitle=artist,
                            artist=artist,
                            album=title,
                            popularity=float(row.get("score") or 0),
                            external_ids={"musicbrainz_release_group_id": mbid},
                            attribution_url=f"https://musicbrainz.org/release-group/{mbid}",
                            downloadable=False,
                            raw={"musicbrainz_release_group_id": mbid},
                        )
                    )
    return out


def _filter_types(items: list[dict[str, Any]], wanted: set[str]) -> list[dict[str, Any]]:
    if not wanted or "all" in wanted:
        return items
    return [item for item in items if item.get("type") in wanted]


def _build_sections(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    top = items[0]["id"] if items else None
    sections: list[dict[str, Any]] = []
    if top:
        sections.append({"id": "top", "title": "Top result", "item_ids": [top]})
    for section_id, title, types in (
        ("songs", "Songs", {"library_track", "track"}),
        ("artists", "Artists", {"artist"}),
        ("albums", "Albums", {"album"}),
        ("playlists", "Playlists", {"playlist"}),
    ):
        ids = [item["id"] for item in items if item.get("type") in types and item["id"] != top][:12]
        if ids:
            sections.append({"id": section_id, "title": title, "item_ids": ids})
    return sections


def _cached_search(query: str, types: set[str], limit: int) -> tuple[dict[str, Any], bool]:
    key = f"{limit}:{','.join(sorted(types))}:{query.casefold()}"
    now = time.time()
    cached = _cache_get(_CATALOG_CACHE, key)
    if cached is not None:
        return cached, True

    items: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    providers = (
        ("library", lambda: _local_catalog(query, limit)),
        ("deezer", lambda: _deezer_search(query, limit)),
        ("musicbrainz", lambda: _musicbrainz_search(query, limit)),
    )
    for name, fn in providers:
        try:
            items.extend(fn())
        except Exception as exc:
            logger.info("Catalog provider %s failed: %s", name, exc)
            failures.append({"source": name, "error": sanitize_cli_message(str(exc))})

    ranked = _filter_types(_dedupe(items, query), types)[:limit]
    body = {
        "query": query,
        "generated_at": int(now),
        "items": ranked,
        "sections": _build_sections(ranked),
        "partial_failures": failures,
    }
    _cache_put(_CATALOG_CACHE, key, _CATALOG_CACHE_TTL_SEC, body)
    return body, False


@catalog_bp.route("/api/catalog/search", methods=["GET"])
@rate_limit("catalog_search", limit=120, window_sec=60)
def catalog_search():
    query = _clean(request.args.get("q", ""))
    if len(query) < 2:
        return jsonify({"query": query, "items": [], "sections": [], "partial_failures": [], "cached": False})
    limit = min(50, max(1, request.args.get("limit", type=int) or 30))
    types = {x.strip() for x in (request.args.get("type") or "all").split(",") if x.strip()}
    body, cached = _cached_search(query, types, limit)
    body["cached"] = cached
    return jsonify(body)


@catalog_bp.route("/api/catalog/suggest", methods=["GET"])
@rate_limit("catalog_suggest", limit=120, window_sec=60)
def catalog_suggest():
    query = _clean(request.args.get("q", ""))
    if len(query) < 2:
        return jsonify({"suggestions": []})
    suggestions: list[str] = []
    seen: set[str] = set()
    try:
        for item in _local_catalog(query, 12):
            for value in (item.get("title"), item.get("artist"), item.get("album")):
                text = _clean(value)
                if text and query.casefold() in text.casefold() and text.casefold() not in seen:
                    seen.add(text.casefold())
                    suggestions.append(text)
    except Exception:
        pass
    if len(suggestions) < 8:
        try:
            resp = requests.get(
                "http://suggestqueries.google.com/complete/search",
                params={"client": "firefox", "ds": "yt", "q": query, "oe": "utf-8"},
                timeout=2,
            )
            if resp.ok:
                data = resp.json()
                for value in data[1] if isinstance(data, list) and len(data) > 1 else []:
                    text = _clean(value)
                    if text and text.casefold() not in seen:
                        seen.add(text.casefold())
                        suggestions.append(text)
        except Exception:
            pass
    return jsonify({"suggestions": suggestions[:8]})


def _resolve_candidates(artist: str, title: str, duration_s: int | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    db = DatabaseManager()
    cached = db.get_cached_resolution(artist, title)
    if cached and cached.get("id"):
        return cached, cached.get("candidates") or [cached]

    api = _get_api()
    dl = api["get_downloader"](open_browser=False)
    raw_results = dl.downloader.search_youtube(f"{title} {artist}".strip(), max_results=8, use_ytmusic=True)
    if not raw_results:
        db.set_cached_resolution(artist, title, {"id": "", "failure_state": "not_found", "confidence": 0.0})
        return {}, []

    best, score, reason, ranked = best_candidate(artist, title, duration_s, raw_results)
    db.set_cached_resolution(
        artist,
        title,
        {
            "id": best.get("id", ""),
            "duration": best.get("duration"),
            "thumbnail": best.get("thumbnail") or f"https://img.youtube.com/vi/{best.get('id', '')}/mqdefault.jpg",
            "webpage_url": best.get("webpage_url") or f"https://www.youtube.com/watch?v={best.get('id', '')}",
            "channel": best.get("channel") or best.get("uploader") or "",
            "confidence": score,
            "confidence_reason": reason,
            "candidates": ranked,
        },
    )

    # Warm the preview stream URL cache so the upcoming
    # `/api/preview/stream/<id>` request hit the in-process cache and skips
    # the second yt-dlp resolution that the user's click would otherwise pay.
    # This pre-resolution happens here (during the explicit resolve round-trip
    # the user already tolerates); it does *not* add new state — it fills the
    # same TTL cache the playback route already uses.
    best_id = best.get("id")
    if best_id and validate_youtube_video_id(str(best_id)):
        try:
            stream_url = dl.downloader.get_stream_url(str(best_id))
            if stream_url:
                from shared.api.routes.playback import warm_preview_stream_cache

                warm_preview_stream_cache(str(best_id), stream_url)
        except Exception as warm_exc:
            logger.debug("Catalog resolve: warm stream URL cache for %s failed: %s", best_id, warm_exc)

    return {**best, "confidence": score, "confidence_reason": reason}, ranked


@catalog_bp.route("/api/catalog/resolve", methods=["POST"])
@rate_limit("catalog_resolve", limit=80, window_sec=60)
def catalog_resolve():
    data = request.get_json(silent=True) or {}
    artist = _clean(data.get("artist"))
    title = _clean(data.get("title"))
    duration_s = _duration(data.get("duration"))
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400
    try:
        best, candidates = _resolve_candidates(artist, title, duration_s)
    except Exception as exc:
        logger.warning("Catalog resolve failed: %s", exc)
        return jsonify({"status": "failed", "reason": "search_error", "candidates": []}), 502
    if not best:
        return jsonify({"status": "failed", "reason": "not_found", "candidates": []}), 404
    score = float(best.get("confidence") or 0)
    return jsonify({
        "status": "resolved",
        "video_id": best.get("id"),
        "confidence": score,
        "confidence_level": classify_confidence(score),
        "confidence_reason": best.get("confidence_reason"),
        "best": best,
        "candidates": candidates,
    })


@catalog_bp.route("/api/catalog/save", methods=["POST"])
@rate_limit("catalog_save", limit=60, window_sec=60)
def catalog_save():
    data = request.get_json(silent=True) or {}
    artist = _clean(data.get("artist"))
    title = _clean(data.get("title"))
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400
    duration_s = _duration(data.get("duration"))
    confirm_video_id = _clean(data.get("confirm_video_id"), 32) or None
    video_id = confirm_video_id
    candidates: list[dict[str, Any]] = []
    confidence = 1.0
    confidence_reason = "confirmed"

    if not video_id:
        try:
            best, candidates = _resolve_candidates(artist, title, duration_s)
        except Exception as exc:
            logger.warning("Catalog save resolve failed: %s", exc)
            return jsonify({"status": "failed", "reason": "search_error", "candidates": []}), 502
        if not best:
            return jsonify({"status": "failed", "reason": "not_found", "candidates": []}), 404
        confidence = float(best.get("confidence") or 0)
        confidence_reason = best.get("confidence_reason") or ""
        if classify_confidence(confidence) != "high":
            return jsonify({
                "status": "needs_review",
                "confidence": confidence,
                "confidence_level": classify_confidence(confidence),
                "confidence_reason": confidence_reason,
                "best": best,
                "candidates": candidates,
            })
        video_id = best.get("id")

    api = _get_api()
    item = {
        "source_type": "ytmusic_search",
        "video_id": video_id,
        "display_title": title,
        "display_artist": artist,
        "thumbnail_url": data.get("cover") or f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
        "duration_sec": duration_s,
        "metadata_evidence": {
            "title": title,
            "artist": artist,
            "catalog_item_id": data.get("catalog_item_id"),
            "source": data.get("source"),
            "external_ids": data.get("external_ids") if isinstance(data.get("external_ids"), dict) else {},
        },
    }
    parsed, err = api["parse_intake_item"](item)
    if err:
        return jsonify({"status": "failed", "reason": err, "candidates": candidates}), 400
    import hashlib
    import json as _json

    parsed["intake_source"] = parsed.get("source_type")
    parsed["intake_payload_hash"] = hashlib.sha256(
        _json.dumps(parsed, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    new_item = api["queue_manager_dl"].add(parsed)
    try:
        if not api["queue_manager_dl"].is_processing:
            api["start_downloader_pump"]()
    except Exception:
        pass
    return jsonify({
        "status": "queued",
        "queue_id": new_item.get("id"),
        "video_id": video_id,
        "confidence": confidence,
        "confidence_level": "confirmed" if confidence_reason == "confirmed" else classify_confidence(confidence),
        "confidence_reason": confidence_reason,
    })


# ──────────────────────────────────────────────────────────────────────────
# Artist & Album profile endpoints (native pages)
# ──────────────────────────────────────────────────────────────────────────


def _deezer_get(path: str, params: dict[str, Any] | None = None, timeout: int = 8) -> dict[str, Any]:
    resp = requests.get(
        f"{_DEEZER_HOST}/{path}",
        params=params or {},
        timeout=timeout,
        headers={"User-Agent": "SoundsibleCatalog/1.0"},
    )
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else {}


def _deezer_artist_search(name: str, limit: int = 10) -> list[dict[str, Any]]:
    data = _deezer_get("search/artist", {"q": name, "limit": min(limit, 25)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        artist_id = str(row.get("id") or "")
        artist_name = (row.get("name") or "").strip()
        if not artist_id or not artist_name:
            continue
        out.append({
            "deezer_id": artist_id,
            "name": artist_name,
            "picture": row.get("picture_xl") or row.get("picture_big") or row.get("picture_medium") or "",
            "nb_fans": int(row.get("nb_fan") or 0),
            "nb_album": int(row.get("nb_album") or 0),
        })
    return out


def _resolve_artist_id(name: str, deezer_id: str | None = None) -> tuple[str | None, list[dict[str, Any]]]:
    """Resolve an artist name to a Deezer artist id, returning candidates for disambiguation."""
    if deezer_id:
        return deezer_id, []

    candidates = _deezer_artist_search(name, limit=10)
    if not candidates:
        return None, []

    name_norm = _norm(name)
    exact = [c for c in candidates if _norm(c["name"]) == name_norm]
    if exact:
        exact.sort(key=lambda c: c["nb_fans"], reverse=True)
        return exact[0]["deezer_id"], exact[1:]
    # No exact match — pick most popular, return all others as candidates
    candidates.sort(key=lambda c: c["nb_fans"], reverse=True)
    return candidates[0]["deezer_id"], candidates[1:4]


def _deezer_artist_profile(artist_id: str) -> dict[str, Any]:
    data = _deezer_get(f"artist/{artist_id}")
    return {
        "name": (data.get("name") or "").strip(),
        "picture": data.get("picture_xl") or data.get("picture_big") or data.get("picture_medium") or "",
        "nb_fans": int(data.get("nb_fan") or 0),
    }


def _deezer_artist_top_tracks(artist_id: str, limit: int = 50, library_keys: set[str] | None = None) -> list[dict[str, Any]]:
    data = _deezer_get(f"artist/{artist_id}/top", {"limit": min(limit, 100)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        item = _deezer_track_to_catalog_item(row, library_keys)
        if item:
            out.append(item)
    return out


def _deezer_track_to_catalog_item(row: dict[str, Any], library_keys: set[str] | None = None) -> dict[str, Any] | None:
    artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
    album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
    title = _clean(row.get("title_short") or row.get("title"))
    artist = _clean(artist_row.get("name"))
    if not title or not artist:
        return None
    deezer_id = str(row.get("id") or "")
    in_library = False
    if library_keys is not None:
        in_library = _key(title, artist) in library_keys
    return _catalog_item(
        item_id=f"deezer:track:{deezer_id}",
        item_type="track",
        source="deezer",
        title=title,
        subtitle=artist,
        artist=artist,
        album=_clean(album_row.get("title")),
        duration=_duration(row.get("duration")),
        cover=album_row.get("cover_xl") or album_row.get("cover_big") or album_row.get("cover_medium") or "",
        popularity=float(row.get("rank") or 0),
        external_ids={"deezer_id": deezer_id},
        attribution_url=row.get("link") or "",
        in_library=in_library,
        playable=False,
        downloadable=not in_library,
        raw={"deezer_id": deezer_id},
    )


def _deezer_artist_releases(artist_id: str, limit: int = 100) -> dict[str, list[dict[str, Any]]]:
    """Fetch an artist's releases once and split them into albums vs singles/EPs.

    Deezer accepts a `type` argument on this endpoint but ignores it — every
    value returns the same mixed rows — so passing "album" and "single,ep"
    fetched the identical list twice and rendered both rails identically.
    `record_type` on each row is what actually distinguishes them.
    """
    data = _deezer_get(f"artist/{artist_id}/albums", {"limit": min(limit, 100)})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    albums: list[dict[str, Any]] = []
    singles_eps: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        album_id = str(row.get("id") or "")
        title = _clean(row.get("title"))
        if not album_id or not title:
            continue
        record_type = _norm(row.get("record_type"))
        entry = {
            "deezer_id": album_id,
            "title": title,
            "cover": row.get("cover_xl") or row.get("cover_big") or row.get("cover_medium") or "",
            "year": _extract_year(row.get("release_date")),
            "record_type": record_type or "album",
        }
        # Anything Deezer does not label as a single/EP is treated as an album so
        # an unfamiliar record_type stays visible rather than vanishing.
        if record_type in ("single", "ep"):
            singles_eps.append(entry)
        else:
            albums.append(entry)
    return {"albums": albums, "singles_eps": singles_eps}


def _gather(
    jobs: tuple[tuple[str, Any], ...],
    failures: list[dict[str, str]],
) -> dict[str, Any]:
    """Run independent fetchers concurrently under gevent, serially without it.

    A greenlet that raises stores the error on `.exception` and leaves `.value`
    as None instead of re-raising, and one that outruns `joinall`'s deadline
    leaves both unset — so failures have to be read from `.successful()` rather
    than caught around `.value`, which would silently yield None.
    """
    results: dict[str, Any] = {}
    if not _HAS_GEVENT:
        for label, fn in jobs:
            try:
                results[label] = fn()
            except Exception as exc:
                logger.info("Deezer %s fetch failed: %s", label, exc)
                failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})
        return results

    spawned = [(label, spawn(fn)) for label, fn in jobs]
    joinall([job for _, job in spawned], timeout=_DEEZER_FANOUT_TIMEOUT_SEC)
    for label, job in spawned:
        if job.successful():
            results[label] = job.value
            continue
        exc = job.exception
        reason = sanitize_cli_message(str(exc)) if exc else "timed out"
        job.kill(block=False)
        logger.info("Deezer %s fetch failed: %s", label, reason)
        failures.append({"source": "deezer", "error": reason})
    return results


def _deezer_related_artists(artist_id: str, limit: int = 20) -> list[dict[str, Any]]:
    data = _deezer_get(f"artist/{artist_id}/related", {"limit": min(limit, 50)})
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
            "picture": row.get("picture_xl") or row.get("picture_big") or row.get("picture_medium") or "",
            "nb_fans": int(row.get("nb_fan") or 0),
        })
    return out


def _deezer_album_profile(album_id: str, library_keys: set[str] | None = None) -> dict[str, Any]:
    data = _deezer_get(f"album/{album_id}")
    artist_row = data.get("artist") if isinstance(data.get("artist"), dict) else {}
    title = _clean(data.get("title"))
    artist = _clean(artist_row.get("name"))
    cover = data.get("cover_xl") or data.get("cover_big") or data.get("cover_medium") or ""
    year = _extract_year(data.get("release_date"))
    genre_names: list[str] = []
    genres = data.get("genres") if isinstance(data.get("genres"), dict) else {}
    gen_data = genres.get("data") if isinstance(genres.get("data"), list) else []
    for g in gen_data:
        if isinstance(g, dict) and g.get("name"):
            genre_names.append(str(g["name"]).strip())

    track_rows = data.get("tracks") if isinstance(data.get("tracks"), dict) else {}
    track_list = track_rows.get("data") if isinstance(track_rows.get("data"), list) else []
    tracklist: list[dict[str, Any]] = []
    for row in track_list:
        if not isinstance(row, dict):
            continue
        item = _deezer_track_to_catalog_item(row, library_keys)
        if item:
            tracklist.append(item)

    return {
        "title": title,
        "artist": artist,
        "cover": cover,
        "year": year,
        "genre": ", ".join(genre_names) if genre_names else "",
        "tracklist": tracklist,
    }


def _extract_year(release_date: Any) -> int | None:
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


def _library_tracks() -> list[Any]:
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    return list(metadata.tracks if metadata and metadata.tracks else [])


def _library_artist_keys(name: str) -> set[str]:
    """Normalized artist\x00title keys for library tracks credited to an artist.

    Callers only need these keys (to badge catalog rows as already-owned) and
    whether the set is empty, so one pass over the library answers both.
    """
    name_key = _norm(name)
    keys: set[str] = set()
    for track in _library_tracks():
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        if name_key and _norm(artist) != name_key:
            continue
        keys.add(_key(getattr(track, "title", "") or "", artist))
    return keys


def _library_album_keys(album_name: str, artist: str) -> set[str]:
    """Normalized artist\x00title keys for library tracks on a given album."""
    album_key = _norm(album_name)
    artist_key = _norm(artist)
    keys: set[str] = set()
    for track in _library_tracks():
        t_artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        t_album = getattr(track, "album", "") or ""
        if album_key and _norm(t_album) != album_key:
            continue
        if artist_key and _norm(t_artist) != artist_key:
            continue
        keys.add(_key(getattr(track, "title", "") or "", t_artist))
    return keys


def _resolve_album_deezer_id(name: str, artist: str) -> str | None:
    """Search Deezer for an album by name + artist, return best match deezer_id."""
    q = f'album:"{name}" artist:"{artist}"' if artist else f'album:"{name}"'
    data = _deezer_get("search", {"q": q, "limit": 5})
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    name_norm = _norm(name)
    for row in rows:
        if not isinstance(row, dict):
            continue
        album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
        album_title = _clean(album_row.get("title"))
        album_id = str(album_row.get("id") or "")
        if album_id and _norm(album_title) == name_norm:
            return album_id
    # Fuzzy: first result with an album id
    for row in rows:
        if not isinstance(row, dict):
            continue
        album_row = row.get("album") if isinstance(row.get("album"), dict) else {}
        album_id = str(album_row.get("id") or "")
        if album_id:
            return album_id
    return None


@catalog_bp.route("/api/catalog/artist", methods=["GET"])
@rate_limit("catalog_artist", limit=60, window_sec=60)
def catalog_artist():
    name = _clean(request.args.get("name", ""), 200)
    if len(name) < 1:
        return jsonify({"error": "name is required"}), 400
    deezer_id = _clean(request.args.get("deezer_id", ""), 32) or None

    cache_key = f"artist:{deezer_id or name.casefold()}"
    now = time.time()
    cached = _cache_get(_ARTIST_CACHE, cache_key)
    if cached is not None:
        cached["cached"] = True
        return jsonify(cached)

    library_keys = _library_artist_keys(name)

    resolved_id: str | None = None
    candidates: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}
    top_tracks: list[dict[str, Any]] = []
    albums: list[dict[str, Any]] = []
    singles_eps: list[dict[str, Any]] = []
    related: list[dict[str, Any]] = []
    resolved = False
    failures: list[dict[str, str]] = []

    try:
        resolved_id, candidates = _resolve_artist_id(name, deezer_id)
    except Exception as exc:
        logger.info("Artist resolve failed for %r: %s", name, exc)
        failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    if resolved_id:
        resolved = True
        artist_id = resolved_id
        results = _gather(
            (
                ("profile", lambda: _deezer_artist_profile(artist_id)),
                ("top", lambda: _deezer_artist_top_tracks(artist_id, 50, library_keys)),
                ("releases", lambda: _deezer_artist_releases(artist_id, 100)),
                ("related", lambda: _deezer_related_artists(artist_id, 20)),
            ),
            failures,
        )
        metadata = results.get("profile") or {}
        top_tracks = results.get("top") or []
        releases = results.get("releases") or {}
        albums = releases.get("albums") or []
        singles_eps = releases.get("singles_eps") or []
        related = results.get("related") or []

    body = {
        "name": name,
        "resolved": resolved,
        "deezer_id": resolved_id,
        "metadata": metadata,
        "candidates": candidates,
        "top_tracks": top_tracks,
        "albums": albums,
        "singles_eps": singles_eps,
        "related_artists": related,
        "in_library": bool(library_keys),
        "partial_failures": failures,
        "cached": False,
        "generated_at": int(now),
    }
    _cache_put(_ARTIST_CACHE, cache_key, _ARTIST_CACHE_TTL_SEC, body)
    return jsonify(body)


@catalog_bp.route("/api/catalog/album", methods=["GET"])
@rate_limit("catalog_album", limit=60, window_sec=60)
def catalog_album():
    name = _clean(request.args.get("name", ""), 200)
    if len(name) < 1:
        return jsonify({"error": "name is required"}), 400
    artist = _clean(request.args.get("artist", ""), 200) or None
    deezer_id = _clean(request.args.get("deezer_id", ""), 32) or None

    cache_key = f"album:{deezer_id or (name + '|' + (artist or '')).casefold()}"
    now = time.time()
    cached = _cache_get(_ALBUM_CACHE, cache_key)
    if cached is not None:
        cached["cached"] = True
        return jsonify(cached)

    library_keys = _library_album_keys(name, artist or "")

    title = name
    album_artist = artist or ""
    cover = ""
    year: int | None = None
    genre = ""
    tracklist: list[dict[str, Any]] = []
    resolved = False
    failures: list[dict[str, str]] = []

    if not deezer_id and artist:
        try:
            deezer_id = _resolve_album_deezer_id(name, artist)
        except Exception as exc:
            logger.info("Album resolve failed for %r: %s", name, exc)
            failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    if deezer_id:
        try:
            profile = _deezer_album_profile(deezer_id, library_keys)
            title = profile["title"] or title
            album_artist = profile["artist"] or album_artist
            cover = profile["cover"]
            year = profile["year"]
            genre = profile["genre"]
            tracklist = profile["tracklist"]
            resolved = True
        except Exception as exc:
            logger.info("Album profile fetch failed for %s: %s", deezer_id, exc)
            failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    body = {
        "title": title,
        "artist": album_artist,
        "cover": cover,
        "year": year,
        "genre": genre,
        "tracklist": tracklist,
        "in_library": bool(library_keys),
        "resolved": resolved,
        "partial_failures": failures,
        "cached": False,
        "generated_at": int(now),
    }
    _cache_put(_ALBUM_CACHE, cache_key, _ALBUM_CACHE_TTL_SEC, body)
    return jsonify(body)
