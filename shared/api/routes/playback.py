"""
Streaming, cover, preview, and playback queue/state routes.
"""

import logging
import os
import time

from flask import Blueprint, request, jsonify, send_file, Response, stream_with_context, redirect
from werkzeug.exceptions import HTTPException

from shared import preview_cache
from shared.api.memo import Memo
from shared.hardening import SCOPE_PLAYBACK_CONTROL, _rate_limiter, rate_limit, require_scope
from shared.path_resolver import is_scanned_track_path, resolve_local_track_path
from shared.stream_resolution import ResolvedStream, resolved_stream
from shared.url_utils import validate_youtube_video_id

logger = logging.getLogger(__name__)

playback_bp = Blueprint("playback", __name__, url_prefix="")

#: How long a browser may reuse cover art without asking again. Artwork edited
#: on another device no longer relies on this expiring to show up — the editing
#: device's `library_updated` emit now carries `cover_changed`, and every other
#: connected tab busts its own cache-buster on receipt (see `stores/index.ts`).
#: This window only bounds staleness for a client that missed that event
#: (offline, reconnect race), so it can stay long.
COVER_CACHE_SEC = 604800  # 7 days

# Note: A preview *session* is one click, but a browser opens several requests
# for it (the initial fetch plus range requests for seeks), and browsing
# previews back-to-back is normal use — so this ceiling is deliberately well
# above "one stream at a time". Disk-cache hits are not counted at all: those
# cost a `send_file` and must never be what pushes a listener over the limit.
PREVIEW_STREAM_LIMIT = 90
PREVIEW_STREAM_WINDOW_SEC = 60

# Preview stream URLs, single-flighted: resolution is a multi-second yt-dlp
# extraction, and repeated taps on the same row (or a prefetch racing the click
# it was meant to make instant) all collapse onto one call. Unresolvable ids
# get a short negative TTL so a dead video is not re-extracted on every retry
# but is also not written off for the full five minutes.
PREVIEW_STREAM_CACHE_TTL_SEC = 300  # 5 minutes
PREVIEW_STREAM_NEGATIVE_TTL_SEC = 20
_preview_stream_urls: Memo[ResolvedStream | str] = Memo(
    ttl_sec=PREVIEW_STREAM_CACHE_TTL_SEC,
    negative_ttl_sec=PREVIEW_STREAM_NEGATIVE_TTL_SEC,
    maxsize=512,
)


def _queue_snapshot(queue):
    items = [item.to_dict() for item in queue.get_all()]
    rev = queue.get_revision()
    return {
        "items": items,
        "tracks": items,
        "repeat_mode": queue.get_repeat_mode(),
        "queue_revision": rev,
    }


def _preview_stream_rate_limit(ip: str) -> bool:
    """Per-client ceiling on preview stream starts.

    This used to be a private sliding window here because the shared limiter in
    `shared.hardening` grew without bound; now that it prunes elapsed windows,
    there is one implementation.
    """
    return _rate_limiter.allow(
        f"preview_stream:{ip}", PREVIEW_STREAM_LIMIT, PREVIEW_STREAM_WINDOW_SEC
    )


def _current_egress() -> str:
    return "relay" if os.getenv("SOUNDSIBLE_YT_PROXY", "").strip() else "direct"


def _durable_stream_cache_get(video_id: str) -> ResolvedStream | None:
    """A stream URL this station already resolved, still inside its own expiry.

    The signed URL lives about six hours; the in-process memo lives five minutes
    and dies with the process. Without this step a station pays the extraction
    again after every restart, and on a relayed station that extraction is the
    most expensive thing it does.
    """
    try:
        from shared.database import instance_db

        row = instance_db().get_cached_stream_url(video_id, _current_egress())
    except Exception as exc:  # pragma: no cover — cache must never break playback
        logger.debug("API: [Preview] durable stream cache read failed for %s: %s", video_id, exc)
        return None
    if not row:
        return None
    proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    return ResolvedStream(
        url=row["url"],
        egress="relay" if row["egress"] == "relay" else "direct",
        resolved_at=float(row["resolved_at"]),
        expires_at=float(row["expires_at"]),
        proxy_url=proxy or None if row["egress"] == "relay" else None,
    )


def _durable_stream_cache_put(video_id: str, stream: ResolvedStream) -> None:
    if stream.expires_at is None:
        # No expiry in the URL means no idea how long it is good for; the
        # in-process memo's short TTL is the safe ceiling for that case.
        return
    try:
        from shared.database import instance_db

        instance_db().set_cached_stream_url(
            video_id,
            stream.url,
            stream.egress,
            stream.resolved_at,
            stream.expires_at,
        )
    except Exception as exc:  # pragma: no cover — cache must never break playback
        logger.debug("API: [Preview] durable stream cache write failed for %s: %s", video_id, exc)


def _invalidate_stream(video_id: str) -> None:
    """Forget a URL the CDN rejected, in both cache layers."""
    _preview_stream_urls.invalidate(video_id)
    try:
        from shared.database import instance_db

        instance_db().invalidate_cached_stream_url(video_id)
    except Exception as exc:  # pragma: no cover
        logger.debug("API: [Preview] durable stream cache invalidate failed for %s: %s", video_id, exc)


def _get_preview_stream_cached(
    api, video_id: str, *, skip_fast_path: bool = False
) -> ResolvedStream | None:
    """Resolve a preview stream URL, at most once per video id at a time.

    Three layers, cheapest first: the in-process memo, the durable SQLite cache
    (good for the URL's full six hours, across restarts and every listener on
    the station), then the yt-dlp extraction. Concurrent callers for the same id
    — repeated taps, a range request landing while the first fetch is still
    resolving, a prefetch racing a click — share one extraction rather than each
    paying for their own.

    `skip_fast_path` is for a retry right after the CDN rejected a URL the
    fast path just produced — see `get_resolved_stream`. The caller is
    expected to have already invalidated the rejected URL from both cache
    layers, so `durable` below will not just hand the same dead URL back.
    """

    def resolve() -> ResolvedStream | str:
        durable = _durable_stream_cache_get(video_id)
        if durable is not None:
            return durable
        dl = api["get_downloader"](open_browser=False)
        resolver = getattr(dl.downloader, "get_resolved_stream", None)
        if callable(resolver):
            stream = resolver(video_id, skip_fast_path=skip_fast_path) or ""
        else:
            url = dl.downloader.get_stream_url(video_id) or ""
            if not url:
                return ""
            proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
            stream = resolved_stream(
                url,
                egress="relay" if proxy else "direct",
                proxy_url=proxy or None,
            )
        if isinstance(stream, ResolvedStream):
            _durable_stream_cache_put(video_id, stream)
        return stream

    try:
        value = _preview_stream_urls.resolve(video_id, resolve)
        return value if isinstance(value, ResolvedStream) else None
    except TimeoutError:
        logger.warning("API: [Preview] Timed out waiting on in-flight resolution for %s", video_id)
        return None


def _get_preview_stream_url_cached(api, video_id: str) -> str:
    """Compatibility helper for catalog and older tests."""
    resolved = _get_preview_stream_cached(api, video_id)
    return resolved.url if resolved else ""


def warm_preview_stream_cache(
    video_id: str,
    url: str,
    ttl_sec: int = PREVIEW_STREAM_CACHE_TTL_SEC,
    *,
    egress: str | None = None,
) -> None:
    """Warm the in-process preview URL cache from another route.

    Catalog/discovery resolve knows the best video_id before the user clicks the
    preview, and during that resolve it can resolve the googlevideo URL itself
    (the same `extract_info` already runs there). Pre-filling this cache here
    eliminates the second yt-dlp call that the upcoming `/api/preview/stream/<id>`
    request would otherwise perform. Pure internal optimization — no new state,
    no client contract change, no extra cache layer.
    """
    if not video_id or not isinstance(url, str) or not url:
        return
    proxy = os.getenv("SOUNDSIBLE_YT_PROXY", "").strip()
    selected_egress = egress if egress in {"direct", "relay"} else ("relay" if proxy else "direct")
    stream = resolved_stream(
        url,
        egress="relay" if selected_egress == "relay" else "direct",
        proxy_url=proxy or None,
    )
    _preview_stream_urls.put(video_id, stream, ttl_sec=min(ttl_sec, stream.cache_ttl(ttl_sec)))
    _durable_stream_cache_put(video_id, stream)


def _get_api():
    from shared.api import (
        get_core,
        get_track_by_id,
        socketio,
        get_downloader,
        is_trusted_network,
        is_safe_path,
        WEB_UI_PATH,
        get_playback_state,
        put_playback_state,
        get_scope_from_request,
    )
    from shared.playback_state import register_device, get_registered_device, list_registered_devices
    return {
        "get_core": get_core,
        "get_track_by_id": get_track_by_id,
        "socketio": socketio,
        "get_downloader": get_downloader,
        "is_trusted_network": is_trusted_network,
        "is_safe_path": is_safe_path,
        "WEB_UI_PATH": WEB_UI_PATH,
        "get_playback_state": get_playback_state,
        "put_playback_state": put_playback_state,
        "get_scope_from_request": get_scope_from_request,
        "register_device": register_device,
        "get_registered_device": get_registered_device,
        "list_registered_devices": list_registered_devices,
    }


def _playback_room(scope: str, device_id: str) -> str:
    return f"playback:{scope}:{device_id}"


def _emit_playback_stop(api, scope: str, device_id: str) -> None:
    api["socketio"].emit("playback_stop_requested", {}, room=_playback_room(scope, device_id))


def _emit_playback_start(api, scope: str, device_id: str, state: dict, track: dict | None = None) -> None:
    payload = {"state": state}
    if track:
        payload["track"] = track
    api["socketio"].emit("playback_start_requested", payload, room=_playback_room(scope, device_id))


def _emit_playback_previous(api, scope: str, device_id: str) -> None:
    api["socketio"].emit("playback_previous_requested", {}, room=_playback_room(scope, device_id))


@playback_bp.route("/api/devices/register", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def register_playback_device():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device = api["register_device"](
        scope,
        device_id=data.get("device_id"),
        device_name=data.get("device_name"),
        device_type=data.get("device_type"),
    )
    return jsonify({
        "status": "registered",
        "device": device,
        "room": _playback_room(scope, device["device_id"]),
    })


@playback_bp.route("/api/devices", methods=["GET"])
def list_playback_devices():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    return jsonify({"devices": api["list_registered_devices"](scope)})


@playback_bp.route("/api/static/stream/<track_id>", methods=["GET"])
def stream_local_track(track_id):
    started = time.perf_counter()
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    path = resolve_local_track_path(track)
    if not path:
        return jsonify({"error": "No path registered"}), 404
    path = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
    if not os.path.exists(path):
        return jsonify({"error": f"File not found: {path}"}), 404
    is_trusted = api["is_trusted_network"](request.remote_addr)
    if not api["is_safe_path"](path, is_trusted=is_trusted):
        return jsonify({"error": "Unauthorized path access"}), 403
    ext = os.path.splitext(path)[1].lower().replace(".", "")
    mimetypes = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "flac": "audio/flac", "ogg": "audio/ogg", "wav": "audio/wav"}
    try:
        file_bytes = os.path.getsize(path)
        # The media client owns range selection.  Rewriting an open-ended range
        # into application-sized slices made every proxy round trip part of the
        # decoder's critical path and, for files with large embedded artwork,
        # routinely ended the first response before the first audio frame.  A
        # normal conditional send is already progressive streaming: Werkzeug
        # answers the exact byte range requested and the client may abandon or
        # resume it whenever it needs to.
        response = send_file(path, mimetype=mimetypes.get(ext, "audio/mpeg"), conditional=True)
        # A downloaded track is content-addressed — the file on disk is named
        # after its own hash — so the bytes behind one id never change, exactly
        # as for a cached preview. Without this `send_file` sends `no-cache`,
        # which sends the player back over the network for a file it already has
        # every single time it is played. On a LAN that is free; from outside it
        # is several round trips in front of a song that is sitting on disk.
        response.headers["Cache-Control"] = (
            "private, no-cache"
            if is_scanned_track_path(track, path)
            else "private, max-age=86400"
        )
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Range")
        response.headers.add("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        response.headers["X-Soundsible-Playback-Source"] = "local"
        response.headers["X-Soundsible-Playback-Egress"] = "direct"
        # The local path used to report nothing at all, so every downloaded
        # track read back as a client-side number with no server half to compare
        # it against — which is exactly the shape of "it takes seconds to start"
        # that cannot be attributed to anything.
        return _report_stream_response(
            response,
            track_id=track_id,
            source_kind="local",
            cache_state="disk",
            egress="direct",
            segments={
                "open_ms": round((time.perf_counter() - started) * 1000, 1),
                "ranged": bool(request.headers.get("Range")),
                # What was promised, not what reached the listener: the client
                # can abandon the response mid-flight and routinely does. Named
                # for what it is so it is not read as bytes on the wire.
                "content_length": int(response.headers.get("Content-Length") or 0),
                "file_bytes": file_bytes,
                "format": ext or "unknown",
                # A whole-second `ts` cannot show the gap between the requests a
                # player makes for one track, which is the interesting part.
                "at_ms": round(time.time() * 1000),
            },
        )
    except HTTPException:
        # A range past the end of the file is a 416, and Werkzeug already built
        # it. Swallowing it into a 500 told the player the track was broken
        # rather than that the ask was, and a media element believes that.
        raise
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _report_stream_response(
    response,
    *,
    track_id: str,
    source_kind: str,
    cache_state: str,
    egress: str,
    segments: dict,
):
    """Report response metadata without wrapping the file iterable.

    Counting body chunks disabled the WSGI file-wrapper fast path and put Python
    in the hot path of every audio byte.  The browser already reports audible
    starts, stalls and failures; this server event is deliberately limited to
    facts known before delivery begins.
    """
    from shared.link_quality import classify_scope

    scope = classify_scope(request.remote_addr)
    _emit_stream_timing(
        attempt_id=_clean_attempt_id(),
        track_id=track_id,
        cache_state=cache_state,
        egress=egress,
        source_kind=source_kind,
        segments={**segments, "scope": scope},
    )
    return response


def _clean_attempt_id() -> str | None:
    value = request.args.get("attempt_id", "").strip()
    if not value or len(value) > 128:
        return None
    return value


def _emit_stream_timing(
    *,
    attempt_id: str | None,
    track_id: str,
    cache_state: str,
    egress: str,
    segments: dict[str, int | float | bool],
    source_kind: str = "preview",
) -> None:
    # No attempt id is the normal case now: it used to ride the stream URL,
    # which made every play a fresh cache key and re-fetched music the browser
    # already had. The report joins these to the client's rows on the track and
    # the clock instead — see `scripts/playback_report.py`.
    from shared.telemetry import emit

    emit(
        "play_timing",
        {
            "v": 2,
            "event": "play_timing",
            "ts": int(time.time()),
            "attempt_id": attempt_id or "",
            "track_id": track_id[:128],
            "phase": "server_stream_ready",
            "source_kind": source_kind,
            "cache_state": cache_state,
            "egress": egress,
            "segments": segments,
        },
    )


def _preview_upstream(api, video_id: str, headers: dict[str, str]):
    """Open a direct fallback stream when persistent caching is disabled."""
    cache_was_warm = isinstance(_preview_stream_urls.get(video_id), ResolvedStream)
    skip_fast_path = False
    for attempt in range(2):
        resolve_started = time.monotonic()
        stream = _get_preview_stream_cached(api, video_id, skip_fast_path=skip_fast_path)
        resolve_ms = round((time.monotonic() - resolve_started) * 1000)
        if not stream:
            return None, None, "unavailable", resolve_ms, 0
        upstream_started = time.monotonic()
        # Pooled on purpose: a browser fetches audio as a series of ranges, and
        # a fresh TCP+TLS handshake per range is ~330 ms of silence each time.
        response = preview_cache.upstream_session().get(
            stream.url,
            stream=True,
            headers=headers,
            timeout=(5, 90),
            proxies=stream.requests_proxies(),
        )
        ttfb_ms = round((time.monotonic() - upstream_started) * 1000)
        if response.status_code in {403, 410}:
            preview_cache.retire_upstream_session()
        if response.status_code not in {403, 410} or attempt == 1:
            if response.status_code in {403, 410}:
                preview_cache.open_upstream_backoff(video_id, response.status_code)
            else:
                preview_cache.clear_upstream_backoff()
            return (
                response,
                stream,
                "url_warm" if cache_was_warm and attempt == 0 else "cold",
                resolve_ms,
                ttfb_ms,
            )
        response.close()
        _invalidate_stream(video_id)
        cache_was_warm = False
        # Retry through the independent fallback resolver. In the captured
        # incident that produced an audio-only format where the fast resolver
        # had produced a muxed one; the 403 itself does not diagnose why.
        skip_fast_path = True
    return None, None, "unavailable", 0, 0


def _acquire_preview(api, video_id: str):
    """Acquire one complete file, refreshing one rejected signed URL.

    `preview_cache.ensure_cached` is the concurrency boundary: a staged deck,
    an active request and background prefetch all join the same transfer.
    """
    cache_was_warm = isinstance(_preview_stream_urls.get(video_id), ResolvedStream)
    started = time.monotonic()

    def resolve(vid: str):
        return _get_preview_stream_cached(api, vid)

    def refresh(vid: str):
        nonlocal cache_was_warm
        _invalidate_stream(vid)
        cache_was_warm = False
        return _get_preview_stream_cached(api, vid, skip_fast_path=True)

    try:
        cached, stream = preview_cache.acquire_cached(
            video_id,
            resolve,
            refresh_resolver=refresh,
        )
    except preview_cache.PreviewUpstreamRejected:
        cached, stream = None, None
    elapsed_ms = round((time.monotonic() - started) * 1000)
    return (
        cached,
        stream,
        "url_warm" if cache_was_warm and cached else "cold",
        0,
        elapsed_ms,
    )


def _serve_cached_preview(
    video_id: str,
    cached,
    *,
    cache_state: str = "disk",
    egress: str = "direct",
    server_ready_ms: int = 0,
):
    """Serve one committed preview with the client's exact range semantics."""
    path, content_type = cached
    cached_bytes = 0
    try:
        cached_bytes = os.path.getsize(path)
    except OSError:
        pass
    response = send_file(str(path), mimetype=content_type, conditional=True)
    response.headers["Cache-Control"] = "private, max-age=86400"
    response.headers["X-Soundsible-Playback-Source"] = "preview"
    response.headers["X-Soundsible-Playback-Cache"] = cache_state
    response.headers["X-Soundsible-Playback-Egress"] = egress
    return _report_stream_response(
        response,
        track_id=video_id,
        source_kind="preview",
        cache_state=cache_state,
        egress=egress,
        segments={
            "server_ready_ms": server_ready_ms,
            "content_length": int(response.headers.get("Content-Length") or 0),
            "file_bytes": cached_bytes,
            "format": os.path.splitext(path)[1].lower().replace(".", "") or "unknown",
            "at_ms": round(time.time() * 1000),
        },
    )


@playback_bp.route("/api/preview/stream/<video_id>", methods=["GET"])
def preview_stream_proxy(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400

    # Fully cached preview: serve straight from disk (instant, seekable). Checked
    # before the rate limit on purpose — a disk hit costs nothing upstream, so
    # replaying a cached preview must never be what trips the ceiling.
    cached = preview_cache.get_cached(video_id)
    if cached:
        return _serve_cached_preview(video_id, cached)

    if not _preview_stream_rate_limit(request.remote_addr or "unknown"):
        return jsonify({"error": "Too many requests"}), 429

    retry_after = preview_cache.upstream_backoff_remaining()
    if retry_after:
        response = jsonify({"error": "Preview upstream temporarily unavailable"})
        response.status_code = 503
        response.headers["Retry-After"] = str(retry_after)
        return response

    # Acquire the complete track before exposing any of it to a media element.
    # This is deliberately synchronous for a cold miss: one upstream transfer
    # costs about a second, while sending the first 512 KiB immediately made the
    # browser ask googlevideo again mid-song. The incident captured on
    # 2026-08-15 was exact: the first slice sounded for 1.96 s, the next slice
    # was rejected, and Auto treated every 503 in the cooldown as another dead
    # song. A staged deck, active playback and prefetch now share this one fill.
    if preview_cache.cache_limit_bytes() > 0:
        try:
            acquired, stream, cache_state, resolve_ms, download_ms = _acquire_preview(api, video_id)
        except Exception as exc:
            logger.warning("API: [Preview acquisition] Error for %s: %s", video_id, exc)
            return jsonify({"error": "Preview unavailable"}), 502
        if acquired and stream:
            return _serve_cached_preview(
                video_id,
                acquired,
                cache_state=cache_state,
                egress=stream.egress,
                server_ready_ms=resolve_ms + download_ms,
            )
        retry_after = preview_cache.upstream_backoff_remaining()
        if retry_after:
            response = jsonify({"error": "Preview upstream temporarily unavailable"})
            response.status_code = 503
            response.headers["Retry-After"] = str(retry_after)
            return response
        # Cache-enabled playback has one contract: a complete, decoder-checked
        # file. Falling through to the compatibility proxy here would silently
        # bypass that verdict and hand the media element the same unverified
        # upstream resource the runway just rejected.
        return jsonify({"error": "Preview unavailable"}), 502

    # Explicitly disabling the disk cache keeps a compatibility path. It uses
    # one open-ended upstream response for normal playback; never split a cold
    # song into CDN ranges again.
    try:
        range_header = request.headers.get("Range")
        # googlevideo throttles DASH URLs fetched *without* a Range header to
        # roughly realtime; an open-ended bytes=0- is served at full speed.
        # Browsers always send a Range, but direct/no-Range clients would
        # crawl — so inject one and translate the upstream 206 back to a 200.
        req_headers = {"Range": range_header or "bytes=0-"}
        resp, stream, cache_state, resolve_ms, upstream_ttfb_ms = _preview_upstream(
            api,
            video_id,
            req_headers,
        )
        if resp is None or stream is None:
            return jsonify({"error": "Preview unavailable"}), 502
        if resp.status_code in {403, 410}:
            resp.close()
            retry_after = preview_cache.upstream_backoff_remaining() or 1
            response = jsonify({"error": "Preview upstream temporarily unavailable"})
            response.status_code = 503
            response.headers["Retry-After"] = str(retry_after)
            return response
        resp.raise_for_status()
        content_length = resp.headers.get("Content-Length")
        content_range = resp.headers.get("Content-Range")
        content_type = resp.headers.get("Content-Type") or "audio/mpeg"
        status_code = resp.status_code
        if range_header is None and status_code == 206:
            # The client never asked for a range; hide the injected one.
            status_code = 200
            content_range = None
        response_headers = {
            "Content-Type": content_type,
            "Accept-Ranges": "bytes",
            "X-Soundsible-Playback-Source": "preview",
            "X-Soundsible-Playback-Cache": cache_state,
            "X-Soundsible-Playback-Egress": stream.egress,
        }
        if content_range:
            response_headers["Content-Range"] = content_range
        if content_length:
            response_headers["Content-Length"] = content_length

        _emit_stream_timing(
            attempt_id=_clean_attempt_id(),
            track_id=video_id,
            cache_state=cache_state,
            egress=stream.egress,
            segments={
                "resolve_ms": resolve_ms,
                "upstream_ttfb_ms": upstream_ttfb_ms,
            },
        )

        def iter_chunks():
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                # A media element abandons ranges constantly. Closing here is
                # what returns the connection to the pool instead of stranding
                # it — without this the pool drains and every later range pays
                # for a new handshake again.
                resp.close()

        return Response(
            stream_with_context(iter_chunks()),
            status=status_code,
            headers=response_headers,
            mimetype=content_type,
            direct_passthrough=True,
        )
    except Exception as e:
        logger.warning("API: [Preview stream] Error for %s: %s", video_id, e)
        return jsonify({"error": "Preview unavailable"}), 502


@playback_bp.route("/api/preview/prefetch", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("preview_prefetch", limit=60, window_sec=60)
def preview_prefetch():
    """Warm previews before the user clicks play.

    Body: {"video_ids": [...], "download": bool}. Resolution (yt-dlp) always
    runs in the background worker; with download=true the audio itself is
    also fetched into the disk cache (used for the next track in the queue).
    Returns immediately, but includes the current preparation state so callers
    never have to confuse accepted work with playable bytes.
    """
    api = _get_api()
    data = request.get_json(silent=True) or {}
    raw_ids = data.get("video_ids")
    if not isinstance(raw_ids, list):
        return jsonify({"error": "video_ids must be a list"}), 400
    video_ids = [str(v) for v in raw_ids if validate_youtube_video_id(str(v))][:8]
    if not video_ids:
        return jsonify({"status": "queued", "queued": [], "preparation": {}})
    download = bool(data.get("download"))

    def resolver(vid: str) -> ResolvedStream | None:
        return _get_preview_stream_cached(api, vid)

    def refresh_resolver(vid: str) -> ResolvedStream | None:
        _invalidate_stream(vid)
        return _get_preview_stream_cached(api, vid, skip_fast_path=True)

    queued = preview_cache.request_prefetch(
        video_ids,
        download=download,
        resolver=resolver,
        refresh_resolver=refresh_resolver if download else None,
    )
    preparation = {
        video_id: preview_cache.preparation_status(video_id).as_dict()
        for video_id in video_ids
    }
    return jsonify({"status": "queued", "queued": queued, "preparation": preparation})


@playback_bp.route("/api/preview/status", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("preview_status", limit=120, window_sec=60)
def preview_status():
    """Report whether complete preview files are actually playable from disk."""
    data = request.get_json(silent=True) or {}
    raw_ids = data.get("video_ids")
    if not isinstance(raw_ids, list):
        return jsonify({"error": "video_ids must be a list"}), 400
    video_ids = [str(v) for v in raw_ids if validate_youtube_video_id(str(v))][:8]
    return jsonify({
        "preparation": {
            video_id: preview_cache.preparation_status(video_id).as_dict()
            for video_id in video_ids
        }
    })


@playback_bp.route("/api/preview/stream-url/<video_id>", methods=["GET"])
def get_preview_stream_url(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request.remote_addr or "unknown"):
        return jsonify({"error": "Too many requests"}), 429
    try:
        url = _get_preview_stream_url_cached(api, video_id)
        if not url:
            return jsonify({"error": "Stream URL unavailable"}), 404
        return jsonify({"url": url})
    except Exception as exc:
        logger.warning("API: [Preview stream-url] Error for %s: %s", video_id, exc)
        return jsonify({"error": "Preview unavailable"}), 502


@playback_bp.route("/api/preview/cover/<video_id>", methods=["GET"])
def preview_cover_redirect(video_id):
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    return redirect(f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg", code=302)


@playback_bp.route("/api/static/cover/<track_id>", methods=["GET"])
def get_track_cover(track_id):
    api = _get_api()
    lib, _, _ = api["get_core"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    from player.cover_manager import CoverFetchManager

    manager = CoverFetchManager.get_instance()
    path = lib.get_cover_url(track)
    if not path:
        try:
            path = manager.extract_now(track, resolve_local_track_path(track))
        except Exception as e:
            logger.warning("[Cover] Failed for %s: %s", track_id, e)
    # List/grid rows ask for the resized variant instead of the (often
    # multi-MB) embedded original. Generated alongside the original whenever
    # it's freshly extracted; for a cover cached before thumbnails existed,
    # this backfills it once from the already-cached original — no re-parse
    # of the audio file, same lazy pattern as the fallback above.
    if request.args.get("size") == "thumb" and path and os.path.exists(path):
        thumb_path = manager.get_cached_thumb_path(track_id) or manager.extract_thumb_now(track_id, path)
        if thumb_path:
            path = thumb_path
    if path and os.path.exists(path):
        is_trusted = api["is_trusted_network"](request.remote_addr)
        if not api["is_safe_path"](path, is_trusted=is_trusted):
            return jsonify({"error": "Unauthorized path"}), 403
        response = send_file(path, mimetype="image/jpeg", conditional=True)
        # Artwork is the most-requested thing in the app: one row of a library
        # list is one cover, so scrolling a few thousand tracks and scrolling
        # back is thousands of requests. Without a max-age every one of them is
        # a revalidation round trip — cheap on localhost, painful on a phone
        # over Tailscale, where six-connection limits turn it into a stall.
        #
        # The window can stay long because artwork edits no longer rely on it
        # expiring: the editing device bumps its own cache-buster immediately,
        # and every other connected device gets a `library_updated` socket
        # event carrying `cover_changed`, busting theirs too (see
        # `_mark_track_metadata_updated` and `stores/index.ts`'s listener). This
        # header only bounds staleness for a client that missed that event.
        response.headers["Cache-Control"] = f"private, max-age={COVER_CACHE_SEC}"
        return response
    placeholder = os.path.join(api["WEB_UI_PATH"], "assets/icons/icon-192.png")
    if os.path.exists(placeholder):
        response = send_file(placeholder, mimetype="image/png", conditional=True)
        # A shipped asset that never changes — and the answer for every track
        # with no artwork at all, so it is worth pinning hard.
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response
    return jsonify({"error": "Cover not ready"}), 404


@playback_bp.route("/api/playback/queue", methods=["GET"])
def get_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    return jsonify(_queue_snapshot(queue))


@playback_bp.route("/api/playback/shuffle", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def shuffle_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    queue.shuffle()
    return jsonify({"status": "success", "queue_revision": queue.get_revision()})


@playback_bp.route("/api/playback/repeat", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def set_playback_repeat():
    api = _get_api()
    _, _, queue = api["get_core"]()
    data = request.json
    mode = data.get("mode", "off")
    queue.set_repeat_mode(mode)
    return jsonify({"status": "success", "mode": mode, "queue_revision": queue.get_revision()})


@playback_bp.route("/api/playback/queue", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def add_to_playback_queue():
    api = _get_api()
    lib, _, queue = api["get_core"]()
    data = request.json or {}
    if "track_id" in data:
        track = api["get_track_by_id"](lib, data["track_id"])
        if track:
            queue.add_library_track(track)
            return jsonify({"status": "success", "size": queue.size(), "queue_revision": queue.get_revision()})
        return jsonify({"error": "Track not found"}), 404
    if "preview" in data:
        preview = data["preview"]
        # Podcast preview: enclosure_url present and no video_id
        enclosure_url = preview.get("enclosure_url")
        video_id = preview.get("video_id") or preview.get("id")
        if enclosure_url and not video_id:
            title = preview.get("title") or "Unknown"
            artist = preview.get("artist") or ""
            duration = int(preview.get("duration") or preview.get("duration_sec") or 0)
            thumbnail = preview.get("thumbnail") or None
            album = preview.get("album") or None
            episode_id = preview.get("episode_id") or f"pcast_{preview.get('podcast_feed_id') or 'unknown'}_{preview.get('podcast_episode_guid') or 'unknown'}"
            queue.add_podcast_preview(
                episode_id=str(episode_id),
                title=title,
                artist=artist,
                duration=max(0, duration),
                thumbnail=thumbnail,
                enclosure_url=str(enclosure_url),
                podcast_feed_id=preview.get("podcast_feed_id") or None,
                podcast_episode_guid=preview.get("podcast_episode_guid") or None,
                podcast_rss_url=preview.get("podcast_rss_url") or None,
                album=album,
            )
            return jsonify({"status": "success", "size": queue.size(), "queue_revision": queue.get_revision()})
        if not video_id or not validate_youtube_video_id(str(video_id)):
            return jsonify({"error": "Invalid or missing video_id"}), 400
        title = preview.get("title") or "Unknown"
        artist = preview.get("artist") or ""
        duration = int(preview.get("duration") or preview.get("duration_sec") or 0)
        thumbnail = preview.get("thumbnail") or None
        library_track_id = preview.get("library_track_id") or None
        album = preview.get("album") or None
        queue.add_preview(
            video_id=str(video_id),
            title=title,
            artist=artist,
            duration=max(0, duration),
            thumbnail=thumbnail,
            library_track_id=library_track_id,
            album=album,
        )
        return jsonify({"status": "success", "size": queue.size(), "queue_revision": queue.get_revision()})
    return jsonify({"error": "Missing track_id or preview"}), 400


@playback_bp.route("/api/playback/queue/<int:index>", methods=["DELETE"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def remove_from_playback_queue(index):
    api = _get_api()
    _, _, queue = api["get_core"]()
    if queue.remove(index):
        return jsonify({"status": "success", "queue_revision": queue.get_revision()})
    return jsonify({"error": "Index out of range"}), 400


@playback_bp.route("/api/playback/queue/track/<track_id>", methods=["DELETE"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def remove_track_id_from_playback_queue(track_id):
    api = _get_api()
    _, _, queue = api["get_core"]()
    removed_count = queue.remove_by_id(track_id)
    if removed_count:
        return jsonify({"status": "success", "removed_count": removed_count, "queue_revision": queue.get_revision()})
    return jsonify({"error": "Track not in queue"}), 404


@playback_bp.route("/api/playback/queue/move", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def move_in_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    data = request.json
    from_index = data.get("from_index")
    to_index = data.get("to_index")
    if from_index is not None and to_index is not None and queue.move(from_index, to_index):
        return jsonify({"status": "success", "queue_revision": queue.get_revision()})
    return jsonify({"error": "Invalid indices"}), 400


@playback_bp.route("/api/playback/queue", methods=["DELETE"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def clear_playback_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    queue.clear()
    return jsonify({"status": "success", "queue_revision": queue.get_revision()})


@playback_bp.route("/api/playback/next", methods=["GET"])
def get_next_from_queue():
    api = _get_api()
    _, _, queue = api["get_core"]()
    item = queue.get_next()
    if item:
        return jsonify(item.to_dict())
    return jsonify(None)


@playback_bp.route("/api/playback/play", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def play_track():
    api = _get_api()
    lib, engine, _ = api["get_core"]()
    data = request.json or {}
    track_id = data.get("track_id")
    setup_session_id = (data.get("setup_session_id") or "").strip() or None
    track = api["get_track_by_id"](lib, track_id)
    if track and engine:
        url = lib.get_track_url(track)
        engine.play(url, track)
        resolved = resolve_local_track_path(track)
        source = "local" if (resolved and url == resolved) else "remote"
        if setup_session_id:
            from shared.setup_session import try_emit_setup_first_play

            try_emit_setup_first_play(
                setup_session_id,
                track_id=str(track_id) if track_id is not None else None,
            )
        return jsonify({"status": "playing", "track": track.title, "source": source})
    return jsonify({"error": "Track not found or engine not ready"}), 404


@playback_bp.route("/api/playback/toggle", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def toggle_playback():
    api = _get_api()
    _, engine, _ = api["get_core"]()
    if engine:
        engine.pause()
        return jsonify({"status": "toggled", "is_playing": engine.is_playing})
    return jsonify({"error": "Engine not ready"}), 500


@playback_bp.route("/api/playback/state", methods=["GET"])
def playback_get_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    exclude_device = request.args.get("exclude_device") or None
    state = api["get_playback_state"](scope, exclude_device_id=exclude_device)
    if not state:
        return "", 204
    return jsonify(state)


@playback_bp.route("/api/playback/play-timing", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("playback_play_timing", limit=120, window_sec=60)
def playback_play_timing():
    """Local-only latency segments for Phase 2 baseline (see docs/TELEMETRY_PRIVACY.md)."""
    from shared.telemetry import emit

    data = request.get_json(silent=True) or {}
    segments = data.get("segments")
    if segments is not None and not isinstance(segments, dict):
        return jsonify({"error": "segments must be an object"}), 400

    track_id = data.get("track_id")
    device_id = data.get("device_id")
    phase = data.get("phase")
    requested_version = data.get("v")
    version = 2 if requested_version == 2 else 1

    payload = {
        "v": version,
        "event": "play_timing",
        "ts": int(time.time()),
    }
    if isinstance(track_id, str) and track_id.strip():
        payload["track_id"] = track_id.strip()[:128]
    if isinstance(device_id, str) and device_id.strip():
        payload["device_id"] = device_id.strip()[:128]
    if isinstance(phase, str) and phase.strip():
        payload["phase"] = phase.strip()[:64]
    if version == 2:
        string_fields = {
            "attempt_id": 128,
            "source_kind": 32,
            "cache_state": 32,
            "trigger": 64,
            "queue_lane": 32,
            "terminal_state": 32,
            "egress": 32,
            "failure_reason": 64,
            # Web Audio context state and standalone-vs-browser, so a silent
            # player can be told apart from a suspended audio session after the
            # fact instead of being guessed at.
            "context_state": 32,
            "display_mode": 32,
            # Whole-program transport around a two-deck handoff. These make a
            # Bluetooth command distinguishable from an in-app tap without
            # recording any media or user content.
            "transport_action": 32,
            "transport_origin": 32,
            "mix_phase": 32,
        }
        for key, max_len in string_fields.items():
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                payload[key] = value.strip()[:max_len]
    if isinstance(segments, dict):
        clean = {}
        for k, v in list(segments.items())[:32]:
            if not isinstance(k, str) or len(k) > 64:
                continue
            if isinstance(v, bool):
                clean[k[:64]] = v
            elif isinstance(v, (int, float)):
                numeric = float(v)
                if k.endswith("_ms") and not 0 <= numeric <= 300_000:
                    continue
                if ("count" in k or k.endswith("_retries")) and not 0 <= numeric <= 10_000:
                    continue
                if not -1_000_000_000 <= numeric <= 1_000_000_000:
                    continue
                clean[k[:64]] = int(numeric) if numeric.is_integer() else round(numeric, 3)
        payload["segments"] = clean

    emit("play_timing", payload)
    return jsonify({"status": "ok"})


@playback_bp.route("/api/playback/state", methods=["PUT"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def playback_put_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    api["put_playback_state"](scope, data)
    return jsonify({"status": "ok"})


@playback_bp.route("/api/playback/handoff", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def playback_handoff():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    from_device_id = (data.get("from_device_id") or "").strip()
    to_device_id = (data.get("to_device_id") or "").strip()
    if not from_device_id or not to_device_id:
        return jsonify({"error": "from_device_id and to_device_id required"}), 400
    if from_device_id == to_device_id:
        return jsonify({"error": "from_device_id and to_device_id must differ"}), 400

    state = api["get_playback_state"](scope, device_id=from_device_id)
    if not state or not state.get("track_id"):
        return jsonify({"error": "No active playback state for source device"}), 404

    target_device = api["get_registered_device"](scope, to_device_id)
    if not target_device:
        return jsonify({"error": "Target device not found", "device_id": to_device_id}), 404
    target_state = {
        **state,
        "device_id": to_device_id,
        "device_name": target_device.get("device_name") or state.get("device_name"),
        "is_playing": True,
    }
    api["put_playback_state"](scope, target_state)
    _emit_playback_stop(api, scope, from_device_id)

    track_payload = None
    try:
        lib, _, _ = api["get_core"]()
        track = api["get_track_by_id"](lib, target_state.get("track_id"))
        if track:
            track_payload = track.to_dict()
    except Exception as e:
        logger.debug("API: handoff track payload lookup failed: %s", e)
    if not track_payload and isinstance(target_state.get("track"), dict):
        track_payload = target_state["track"]

    _emit_playback_start(api, scope, to_device_id, target_state, track=track_payload)
    response = {
        "status": "sent",
        "from_device_id": from_device_id,
        "to_device_id": to_device_id,
        "state": target_state,
    }
    if not target_device.get("active_sid"):
        response["warning"] = "Device appears offline (no active socket)"
    return jsonify(response)


@playback_bp.route("/api/playback/notify-stop", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def playback_notify_stop():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device_id = data.get("device_id")
    if not device_id:
        return jsonify({"error": "device_id required"}), 400
    _emit_playback_stop(api, scope, device_id)
    return jsonify({"status": "sent"})


@playback_bp.route("/api/playback/remote-command", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def playback_remote_command():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    device_id = (data.get("device_id") or "").strip()
    command = (data.get("command") or "").strip().lower()

    if not device_id or command not in {"pause", "play", "next", "previous", "seek"}:
        return jsonify({"error": "device_id and command (pause, play, next, previous, seek) required"}), 400

    target = api["get_registered_device"](scope, device_id)
    if not target:
        return jsonify({"error": "Target device not found", "device_id": device_id}), 404

    room = _playback_room(scope, device_id)

    if command == "pause":
        _emit_playback_stop(api, scope, device_id)
        api["put_playback_state"](scope, {
            "is_playing": False,
            "device_id": device_id,
            "device_name": target.get("device_name"),
        })
    elif command == "play":
        track_id = (data.get("track_id") or "").strip()
        state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
        if track_id:
            lib, engine, queue = api["get_core"]()
            track = api["get_track_by_id"](lib, track_id)
            if track:
                queue.consume_head_if_id(track_id)
                target_state = {
                    "track_id": track_id,
                    "track": track.to_dict(),
                    "position_sec": float(data.get("position_sec") or 0),
                    "is_playing": True,
                    "device_id": device_id,
                    "device_name": target.get("device_name"),
                }
            elif state and state.get("track_id") == track_id:
                target_state = {
                    **state,
                    "device_id": device_id,
                    "device_name": target.get("device_name") or state.get("device_name"),
                    "is_playing": True,
                }
            else:
                return jsonify({"error": "Track not found for target device"}), 404
        elif not state or not state.get("track_id"):
            return jsonify({"error": "No playback state available for target device"}), 404
        else:
            target_state = {
                **state,
                "device_id": device_id,
                "device_name": target.get("device_name") or state.get("device_name"),
                "is_playing": True,
            }
        api["put_playback_state"](scope, target_state)
        track_payload = target_state.get("track") if isinstance(target_state.get("track"), dict) else None
        _emit_playback_start(api, scope, device_id, target_state, track=track_payload)
    elif command == "next":
        api["socketio"].emit("playback_next_requested", {}, room=room)
    elif command == "previous":
        _emit_playback_previous(api, scope, device_id)
    else:
        raw = data.get("position_sec")
        if raw is None:
            return jsonify({"error": "position_sec required for seek"}), 400
        try:
            position_sec = float(raw)
        except (TypeError, ValueError):
            return jsonify({"error": "position_sec must be a number"}), 400
        if position_sec < 0:
            return jsonify({"error": "position_sec must be >= 0"}), 400
        state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
        if not state or not state.get("track_id"):
            return jsonify({"error": "No playback state available for target device"}), 404
        target_state = {
            **state,
            "device_id": device_id,
            "device_name": target.get("device_name") or state.get("device_name"),
            "position_sec": position_sec,
        }
        api["put_playback_state"](scope, target_state)
        api["socketio"].emit("playback_seek_requested", {"position_sec": position_sec}, room=room)

    warning = None
    if not target.get("active_sid"):
        warning = "Device appears offline (no active socket)"
    response = {
        "status": "sent",
        "command": command,
        "device_id": device_id,
    }
    if command == "seek":
        response["position_sec"] = position_sec
    if warning:
        response["warning"] = warning
    return jsonify(response)


@playback_bp.route("/api/playback/link", methods=["GET"])
@rate_limit("playback_link", limit=120, window_sec=60)
def playback_link_quality():
    """How fast the music is reaching this listener, and from where.

    Read from the audio already delivered — there is no probe traffic here. A
    null `kbps` means nothing measurable has been served yet, which the player
    must show as "not measured" rather than as zero.
    """
    from shared.link_quality import snapshot
    from shared.user_context import current_user_id

    return jsonify(snapshot(current_user_id()))
