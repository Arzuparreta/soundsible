"""
Streaming, cover, preview, and playback state routes.
"""

import json
import logging
import math
import os
import re
import time

from flask import Blueprint, request, jsonify, send_file, Response, redirect
from werkzeug.exceptions import HTTPException

from shared import preview_cache, preview_streams, request_scope
from shared.hardening import SCOPE_PLAYBACK_CONTROL, _rate_limiter, rate_limit, require_scope
from shared.path_resolver import is_scanned_track_path, resolve_local_track_path
from shared.security import request_client_address, request_rate_limit_key
from shared.stream_resolution import ResolvedStream
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

def _preview_stream_rate_limit(ip: str) -> bool:
    """Per-client ceiling on preview stream starts.

    This used to be a private sliding window here because the shared limiter in
    `shared.hardening` grew without bound; now that it prunes elapsed windows,
    there is one implementation.
    """
    return _rate_limiter.allow(
        f"preview_stream:{ip}", PREVIEW_STREAM_LIMIT, PREVIEW_STREAM_WINDOW_SEC
    )


def _get_api():
    from shared.api import is_trusted_network, is_safe_path, WEB_UI_PATH, get_playback_state, put_playback_state, get_scope_from_request
    from shared.user_cores import get_library, get_track_by_id
    from shared.realtime import socketio
    from shared.download_pump import get_downloader
    from shared.playback_state import register_device, get_registered_device, list_registered_devices
    return {
        "get_library": get_library,
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


def _emit_playback_start(api, scope: str, device_id: str, state: dict, track: dict | None = None, *, handoff: bool = False) -> None:
    payload = {"state": state}
    if handoff:
        payload["handoff"] = True
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
    return jsonify({"devices": [
        {**device, "socket_active": bool(device.get("active_sid"))}
        for device in api["list_registered_devices"](scope)
    ]})


@playback_bp.route("/api/static/stream/<track_id>", methods=["GET"])
def stream_local_track(track_id):
    started = time.perf_counter()
    api = _get_api()
    lib = api["get_library"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    path = resolve_local_track_path(track)
    if not path:
        return jsonify({"error": "No path registered"}), 404
    path = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
    if not os.path.exists(path):
        logger.warning("Stream: file for track %s is missing at %s", track_id, path)
        return jsonify({"error": "File not found"}), 404
    is_trusted = api["is_trusted_network"](request_client_address())
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
                **_range_observation(request.headers.get("Range")),
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
    except FileNotFoundError:
        # Gone between the check above and opening it: still a missing file.
        logger.warning("Stream: file for track %s vanished at %s", track_id, path)
        return jsonify({"error": "File not found"}), 404
    except Exception:
        # The message names the file's absolute path; the log keeps it.
        logger.exception("Stream: could not serve track %s from %s", track_id, path)
        return jsonify({"error": "Could not read the file"}), 500


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


def _range_observation(value: str | None) -> dict:
    """Describe one HTTP Range request without changing what Werkzeug serves."""
    if not value:
        return {"range_kind": "none"}
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip(), re.IGNORECASE)
    if not match or (not match.group(1) and not match.group(2)):
        return {"range_kind": "invalid"}
    start, end = match.groups()
    if not start:
        return {"range_kind": "suffix", "range_suffix": int(end)}
    observed = {"range_kind": "closed" if end else "open", "range_start": int(start)}
    if end:
        observed["range_end"] = int(end)
        observed["range_requested_bytes"] = max(0, int(end) - int(start) + 1)
    return observed


def _reads_from_start(value: str | None) -> bool:
    """True for a request that begins at byte 0, as a new playback does."""
    observed = _range_observation(value)
    return observed["range_kind"] == "none" or observed.get("range_start") == 0


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
    cache_was_warm = preview_streams.is_warm(video_id)
    skip_fast_path = False
    for attempt in range(2):
        resolve_started = time.monotonic()
        stream = preview_streams.resolve(api["get_downloader"], video_id, skip_fast_path=skip_fast_path)
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
        preview_streams.invalidate(video_id)
        cache_was_warm = False
        # Retry through the independent fallback resolver. In the captured
        # incident that produced an audio-only format where the fast resolver
        # had produced a muxed one; the 403 itself does not diagnose why.
        skip_fast_path = True
    return None, None, "unavailable", 0, 0


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
    metadata = preview_cache.cached_metadata(video_id)
    # mtime is LRU recency, not a content validator: mark_served touches it on
    # every read. Pin If-Range to the committed layout, including atomic remuxes.
    # Legacy entries have no validator until reacquired, but still serve ranges.
    response = send_file(
        str(path), mimetype=content_type, conditional=False,
        etag=metadata.get("revision") or False,
    )
    response.headers.pop("Last-Modified", None)
    response.make_conditional(request.environ, accept_ranges=True, complete_length=cached_bytes)
    preview_cache.mark_served(video_id)
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
            **_range_observation(request.headers.get("Range")),
            "content_length": int(response.headers.get("Content-Length") or 0),
            "file_bytes": cached_bytes,
            "format": os.path.splitext(path)[1].lower().replace(".", "") or "unknown",
            "layout": str(metadata.get("layout") or "unknown"),
            "at_ms": round(time.time() * 1000),
        },
    )


def _progressive_range(range_header: str | None, total: int | None):
    """Translate one browser byte range into local spool offsets."""
    if not range_header:
        return 0, total - 1 if total else None, 200
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not match or total is None:
        return None
    raw_start, raw_end = match.groups()
    if not raw_start:
        if not raw_end or int(raw_end) <= 0:
            return None
        length = min(total, int(raw_end))
        return total - length, total - 1, 206
    start = int(raw_start)
    end = min(total - 1, int(raw_end)) if raw_end else total - 1
    if start >= total or end < start:
        return None
    return start, end, 206


def _serve_progressive_preview(video_id: str, handle: preview_cache.ProgressiveHandle):
    total = handle.total_bytes
    selected = _progressive_range(request.headers.get("Range"), total)
    if selected is None:
        handle.close()
        response = jsonify({"error": "Requested range is not available"})
        response.status_code = 416
        if total is not None:
            response.headers["Content-Range"] = f"bytes */{total}"
        return response
    start, end, status = selected
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Soundsible-Playback-Source": "preview",
        "X-Soundsible-Playback-Cache": "progressive",
        "X-Soundsible-Playback-Egress": handle.egress,
    }
    if total is not None:
        length = (end - start + 1) if end is not None else total - start
        headers["Content-Length"] = str(length)
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    response = Response(
        handle.iter_bytes(start, end),
        status=status,
        headers=headers,
        mimetype=handle.content_type,
        direct_passthrough=True,
    )
    # WSGI may close a response before the generator is ever advanced. Register
    # separately so that disconnect still drops reader interest and cancels an
    # otherwise abandoned upstream fill.
    response.call_on_close(handle.close)
    return response


@playback_bp.route("/api/preview/stream/<video_id>", methods=["GET"])
def preview_stream_proxy(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400

    # Fully cached preview: serve straight from disk (instant, seekable). Checked
    # before the rate limit on purpose — a disk hit costs nothing upstream, so
    # replaying a cached preview must never be what trips the ceiling.
    cached = preview_cache.get_cached(
        video_id,
        from_start=_reads_from_start(request.headers.get("Range")),
    )
    if cached:
        return _serve_cached_preview(video_id, cached)

    if not _preview_stream_rate_limit(request_rate_limit_key()):
        return jsonify({"error": "Too many requests"}), 429

    retry_after = preview_cache.upstream_backoff_remaining()
    if retry_after:
        response = jsonify({"error": "Preview upstream temporarily unavailable"})
        response.status_code = 503
        response.headers["Retry-After"] = str(retry_after)
        return response

    # One open-ended upstream transfer writes a local spool. Ordinary songs keep
    # the complete-file fast path; a proven sustainable long transfer may be
    # read from that same growing file. Browser ranges never reach the CDN.
    if preview_cache.cache_limit_bytes() > 0:
        try:
            stream = preview_streams.resolve(api["get_downloader"], video_id)
            if stream is None:
                return jsonify({"error": "Preview unavailable"}), 502

            def refresh(vid: str):
                preview_streams.invalidate(vid)
                return preview_streams.resolve(api["get_downloader"], vid, skip_fast_path=True)

            handle = preview_cache.start_progressive(
                video_id,
                stream,
                refresh_resolver=refresh,
            )
            # Authentication/resolution are finished. Do not pin a pooled DB
            # connection while five seconds of network budget or the response
            # body's future bytes are pending.
            request_scope.release_resources()
            handle.wait_for_fast_complete()
        except Exception as exc:
            logger.warning("API: [Preview acquisition] Error for %s: %s", video_id, exc)
            return jsonify({"error": "Preview unavailable"}), 502
        acquired = preview_cache.get_cached(video_id)
        if acquired is None and not handle.pin_source_layout():
            # The whole file arrived and its commit has begun, which may
            # flatten it. Serve the committed file, not the spool's layout.
            if not handle.wait_until_done():
                handle.close()
                return jsonify({"error": "Preview unavailable"}), 502
            acquired = preview_cache.get_cached(video_id)
        if acquired:
            handle.close()
            return _serve_cached_preview(
                video_id,
                acquired,
                cache_state="cold",
                egress=handle.egress,
            )
        if handle.done:
            handle.close()
            retry_after = preview_cache.upstream_backoff_remaining()
            if retry_after:
                response = jsonify({"error": "Preview upstream temporarily unavailable"})
                response.status_code = 503
                response.headers["Retry-After"] = str(retry_after)
                return response
            return jsonify({"error": "Preview unavailable"}), 502
        return _serve_progressive_preview(video_id, handle)

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

        request_scope.release_resources()
        response = Response(
            iter_chunks(),
            status=status_code,
            headers=response_headers,
            mimetype=content_type,
            direct_passthrough=True,
        )
        response.call_on_close(resp.close)
        return response
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
        return preview_streams.resolve(api["get_downloader"], vid)

    def refresh_resolver(vid: str) -> ResolvedStream | None:
        preview_streams.invalidate(vid)
        return preview_streams.resolve(api["get_downloader"], vid, skip_fast_path=True)

    from shared.dj.session import scoped
    def enqueue():
        from shared import work
        allowed = getattr(work.current(), "preview_keys", None)
        selected = video_ids if allowed is None else [vid for vid in video_ids if vid in allowed]
        return preview_cache.request_prefetch(
            selected, download=download, resolver=resolver,
            refresh_resolver=refresh_resolver if download else None,
        )
    queued = scoped(enqueue)()
    if not isinstance(queued, list):
        return queued
    preparation = {
        video_id: _preparation_with_artwork(video_id)
        for video_id in video_ids
    }
    return jsonify({"status": "queued", "queued": queued, "preparation": preparation})


@playback_bp.route("/api/preview/interest", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("preview_interest", limit=120, window_sec=60)
def preview_interest():
    from shared.dj.session import scoped
    from shared import work
    @scoped
    def update():
        data = request.get_json(silent=True) or {}
        ids = data.get("video_ids")
        revision = data.get("revision")
        if not isinstance(ids, list) or len(ids) > 64 or type(revision) is not int:
            return jsonify({"error": "invalid interest"}), 400
        demand = work.current()
        if revision >= getattr(demand, "interest_revision", -1):
            demand.interest_revision = revision
            keys = {str(vid) for vid in ids if validate_youtube_video_id(str(vid))}
            demand.preview_keys = keys
            demand.retain("preview-download", keys)
            demand.retain("preview-resolve", keys)
        return jsonify({})
    return update()


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
    if request.headers.get("X-Soundsible-Work"):
        from shared.dj.session import scoped
        return scoped(lambda: _preview_status_body(video_ids))()
    return _preview_status_body(video_ids)


def _preparation_with_artwork(video_id):
    result = preview_cache.preparation_status(video_id).as_dict()
    try:
        from shared.artwork_sources import observed
        values = observed(video_id)
        if values:
            result['artwork'] = values[0]
    except Exception:
        logger.debug('Optional preview artwork unavailable', exc_info=True)
    return result


def _preview_status_body(video_ids):
    return jsonify({
        "preparation": {
            video_id: _preparation_with_artwork(video_id)
            for video_id in video_ids
        }
    })


@playback_bp.route("/api/preview/cancel/<video_id>", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("preview_cancel", limit=60, window_sec=60)
def preview_cancel(video_id):
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    return jsonify({"cancelled": preview_cache.cancel_progressive(video_id)})


@playback_bp.route("/api/preview/stream-url/<video_id>", methods=["GET"])
def get_preview_stream_url(video_id):
    api = _get_api()
    if not validate_youtube_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    if not _preview_stream_rate_limit(request_rate_limit_key()):
        return jsonify({"error": "Too many requests"}), 429
    try:
        url = preview_streams.resolved_url(api["get_downloader"], video_id)
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
    lib = api["get_library"]()
    # An id this engine has never heard of used to be a 404 with a JSON body,
    # which is a strange answer to give an <img>. A saved-but-not-downloaded
    # song is exactly that id — it lives in the saved snapshot, not in the
    # library — and any caller that builds a cover URL from a bare id (the
    # head-unit rows in `routes/car.py`, say) hits it. Fall through to the
    # placeholder below instead: an image request gets an image.
    track = api["get_track_by_id"](lib, track_id)
    from player.cover_manager import CoverFetchManager

    manager = CoverFetchManager.get_instance()
    from shared.artwork import SIZES, artwork_store
    from PIL import Image
    store = artwork_store()
    size = request.args.get("size")
    fit = request.args.get("fit", "original")
    if size not in (None, "thumb", *(str(n) for n in SIZES)) or fit not in ("original", "square"):
        return jsonify({"error": "Invalid artwork variant"}), 400
    ref = store.effective_ref(track_id) if track else None
    removed = track and (getattr(track, "cover_source", None) == "none" or (ref and ref["source"] == "none"))
    path = None if removed else (lib.get_cover_url(track) if track else None)
    if track and not path and not removed:
        try:
            path = manager.extract_now(track, resolve_local_track_path(track))
        except Exception as exc:
            logger.warning("[Cover] Failed for %s: %s", track_id, exc)
    try:
        if path and os.path.isfile(path):
            # Only local legacy extraction is allowed in the request path. A master
            # generated here is durable; future variants never re-parse the audio.
            if not store.effective_ref(track_id):
                if not api["is_safe_path"](path, is_trusted=api["is_trusted_network"](request_client_address())):
                    return jsonify({"error": "Unauthorized path"}), 403
                with open(path, "rb") as handle:
                    store.bind(track_id, store.put(handle.read()), getattr(track, "cover_source", None), only_missing=True)
            ref = store.effective_ref(track_id)
            if ref and ref["hash"]:
                revision = f"{ref['hash']}-{ref['revision']}"
                requested_revision = request.args.get("rev")
                if requested_revision and requested_revision != revision:
                    from urllib.parse import urlencode
                    params = request.args.to_dict()
                    params['rev'] = revision
                    response = redirect(request.path + '?' + urlencode(params), code=302)
                    response.headers['Cache-Control'] = 'private, no-cache'
                    return response
                # The hash/revision and bytes must describe one snapshot even
                # if another request edits the account choice right now.
                path = str(store.root / 'objects' / ref['hash'])
                if size:
                    variant = store.open_variant(ref['hash'], 320 if size == 'thumb' else int(size), fit == 'square')
                    try:
                        response = send_file(variant.file, mimetype='image/jpeg', conditional=False,
                                             etag=variant.etag, last_modified=variant.modified)
                        response.content_length = variant.size
                        response.make_conditional(request.environ, accept_ranges=True, complete_length=variant.size)
                        response.call_on_close(variant.file.close)
                        if request.method == 'HEAD' or response.status_code == 304:
                            variant.file.close()
                    except BaseException:
                        variant.file.close()
                        raise
                else:
                    with Image.open(path) as artwork:
                        mimetype = Image.MIME.get(artwork.format, 'application/octet-stream')
                    response = send_file(path, mimetype=mimetype, conditional=True)
                response.headers['Cache-Control'] = (
                    'private, max-age=31536000, immutable' if requested_revision == revision
                    else 'private, no-cache'
                )
                return response
    except (OSError, ValueError) as exc:
        logger.warning("[Cover] Unreadable artwork for %s: %s", track_id, exc)
        response = jsonify({'error': 'Artwork temporarily unavailable'})
        response.status_code = 503
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['Retry-After'] = '2'
        return response
    placeholder = os.path.join(api["WEB_UI_PATH"], "assets/icons/icon-192.png")
    if os.path.exists(placeholder):
        response = send_file(placeholder, mimetype="image/png", conditional=True)
        # The URL names a track, not the shipped icon; its answer can change
        # after recovery or when the next account logs into this browser.
        response.headers['Cache-Control'] = 'private, max-age=0, no-cache'
        return response
    return jsonify({"error": "Cover not ready"}), 404


@playback_bp.route("/api/playback/state", methods=["GET"])
def playback_get_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    exclude_device = request.args.get("exclude_device") or None
    state = api["get_playback_state"](scope, exclude_device_id=exclude_device)
    if not state:
        return "", 204
    return jsonify(state)


@playback_bp.route("/api/playback/trace", methods=["POST"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
@rate_limit("playback_trace", limit=90, window_sec=60)
def playback_trace():
    import json

    from shared.playback_trace import MAX_BODY, save_batch, validate_batch
    from shared.telemetry import is_telemetry_enabled, user_telemetry_dir
    from shared.user_context import current_user_id

    # Enforce a bounded body even for chunked/unknown-length requests.
    if request.content_length is not None and request.content_length > MAX_BODY:
        return jsonify({"error": "trace too large"}), 413
    raw = request.stream.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        return jsonify({"error": "trace too large"}), 413
    try:
        batch = validate_batch(json.loads(raw), current_user_id())
    except (ValueError, TypeError):
        return jsonify({"error": "invalid playback trace"}), 400
    enabled = is_telemetry_enabled()
    if enabled:
        try:
            save_batch(batch, user_telemetry_dir())
        except Exception:
            logger.exception("Playback trace persistence failed")
            return jsonify({"error": "trace storage unavailable"}), 503
    return jsonify({"id": batch["id"], "enabled": enabled})


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
            # Stable programme-output and Media Session projection. These are
            # declarations and booleans only; no metadata or audio leaves the
            # browser.
            "output_mode": 32,
            "output_event": 32,
            "media_session_state": 32,
            "sync_reason": 32,
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


def _observe_for_scrobbling(state: dict) -> None:
    """Let scrobbling read what a device says it is playing.

    Only a device's own publication is read — never the state a handoff or an
    agent writes on a device's behalf, which is an instruction, not something
    anybody has heard yet. Publishing playback state must not fail because a
    scrobbling service is misconfigured.
    """
    from shared.user_context import current_user_id

    user_id = current_user_id()
    if not user_id or not isinstance(state, dict):
        return
    try:
        from shared.scrobble import get_scrobble_service

        get_scrobble_service().observe(user_id, state)
    except Exception:
        logger.exception("API: scrobbling could not read a playback publication")


@playback_bp.route("/api/playback/state", methods=["PUT"])
@require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
def playback_put_state():
    api = _get_api()
    scope = api["get_scope_from_request"]()
    data = request.json or {}
    api["put_playback_state"](scope, data)
    _observe_for_scrobbling(data)
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
        lib = api["get_library"]()
        track = api["get_track_by_id"](lib, target_state.get("track_id"))
        if track:
            track_payload = track.to_dict()
    except Exception as e:
        logger.debug("API: handoff track payload lookup failed: %s", e)
    if not track_payload and isinstance(target_state.get("track"), dict):
        track_payload = target_state["track"]

    _emit_playback_start(api, scope, to_device_id, target_state, track=track_payload, handoff=True)
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


def _remote_track(value):
    """Bound a portable element. Only normal player source resolvers may fetch audio."""
    if not isinstance(value, dict) or len(json.dumps(value).encode("utf-8")) > 32768:
        raise ValueError("track must be an object of at most 32 KiB")
    track_id = value.get("id")
    if not isinstance(track_id, str) or not track_id.strip() or len(track_id) > 512:
        raise ValueError("track.id required (at most 512 characters)")
    if value.get("source") not in (None, "local", "preview"):
        raise ValueError("Unsupported track source")
    # File paths, tokens, URLs resolved on the sender and queue/session ownership
    # never travel. Local metadata is read from the library instead.
    track = {"id": track_id}
    for key in (
        "title", "artist", "album", "album_artist", "cover", "youtube_id",
        "media_kind", "podcast_episode_guid", "podcast_enclosure_url", "podcast_feed_id",
        "podcast_rss_url", "deezer_artist_id", "deezer_album_id", "canonical_identity",
        "source_title", "source_artist", "discovery_youtube_id", "playback_source_kind",
    ):
        field = value.get(key)
        if field is not None:
            if not isinstance(field, str) or len(field) > 4096:
                raise ValueError(f"Invalid track.{key}")
            track[key] = field
    for key in ("duration", "track_number", "disc_number", "year"):
        field = value.get(key)
        if field is not None:
            if isinstance(field, bool) or not isinstance(field, (int, float)) or not math.isfinite(field) or field < 0:
                raise ValueError(f"Invalid track.{key}")
            track[key] = field
    for key in ("originKeys", "artists"):
        field = value.get(key)
        if field is not None:
            if not isinstance(field, list) or len(field) > 64 or any(not isinstance(item, str) or len(item) > 512 for item in field):
                raise ValueError(f"Invalid track.{key}")
            track[key] = field
    if isinstance(value.get("artist_is_channel"), bool):
        track["artist_is_channel"] = value["artist_is_channel"]
    if value.get("source") != "preview":
        return track
    track["source"] = "preview"
    if track.get("media_kind") == "podcast_episode" or track.get("podcast_episode_guid"):
        from shared.podcast_rss import assert_safe_http_url
        if not track.get("podcast_enclosure_url"):
            raise ValueError("Podcast enclosure URL required")
        assert_safe_http_url(track["podcast_enclosure_url"])
        track["media_kind"] = "podcast_episode"
    elif value.get("pendingResolve") is not None:
        pending = value["pendingResolve"]
        if not isinstance(pending, dict) or any(
            not isinstance(pending.get(key), str) or not pending[key].strip() or len(pending[key]) > limit
            for key, limit in (("catalogItemId", 512), ("artist", 4096), ("title", 4096))
        ):
            raise ValueError("Invalid pending catalogue reference")
        track["pendingResolve"] = {key: pending[key] for key in ("catalogItemId", "artist", "title")}
        if "duration" in track:
            track["pendingResolve"]["duration"] = track["duration"]
    else:
        video_id = track.get("youtube_id") or track_id
        if not validate_youtube_video_id(video_id):
            raise ValueError("Invalid YouTube video id")
        # Both web and native preview resolvers use the playable id as the id.
        track["id"] = video_id
        track["youtube_id"] = video_id
    return track


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
            **(api["get_playback_state"](scope, device_id=device_id) or {}),
            "is_playing": False,
            "device_id": device_id,
            "device_name": target.get("device_name"),
        })
    elif command == "play":
        raw_id = data.get("track_id") or ""
        if not isinstance(raw_id, str):
            return jsonify({"error": "track_id must be a string"}), 400
        track_id = raw_id.strip()
        descriptor = None
        if "track" in data:
            try:
                descriptor = _remote_track(data["track"])
                if track_id and track_id != data["track"]["id"]:
                    raise ValueError("track_id must match track.id")
                position = float(data.get("position_sec") or 0)
                if not math.isfinite(position) or not 0 <= position <= 604800:
                    raise ValueError("Invalid position_sec")
            except (TypeError, ValueError, OverflowError) as error:
                return jsonify({"error": str(error)}), 400
            track_id = descriptor["id"]
        state = api["get_playback_state"](scope, device_id=device_id) or api["get_playback_state"](scope)
        if descriptor and descriptor.get("source") == "preview":
            target_state = {
                "track_id": track_id, "track": descriptor,
                "position_sec": position, "is_playing": True,
                "device_id": device_id, "device_name": target.get("device_name"),
                "session": None,
            }
        elif track_id:
            lib = api["get_library"]()
            track = api["get_track_by_id"](lib, track_id)
            if track:
                target_state = {
                    "track_id": track_id,
                    "track": track.to_dict(),
                    "position_sec": float(data.get("position_sec") or 0),
                    "is_playing": True,
                    "device_id": device_id,
                    "device_name": target.get("device_name"),
                    "session": None,
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
