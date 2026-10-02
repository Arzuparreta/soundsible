"""Resolving a video to an audio URL that playback can fetch."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

import yt_dlp

from shared.stream_resolution import ResolvedStream, resolved_stream

from .ids import watch_url
from .web import reset_visitor_data, visitor_data
from .ytdlp import YDL_FORMAT_AUDIO_PREVIEW, Cookies, apply_network_options, force_ipv4, yt_proxy

logger = logging.getLogger(__name__)


def _extract(
    video_id: str,
    opts: Dict[str, Any],
    *,
    egress: str,
    proxy_url: Optional[str] = None,
    require_audio_only: bool = False,
) -> tuple[Optional[ResolvedStream], bool]:
    """One extraction: the stream, or None and whether the failure was hard.

    A hard failure is one no other client or cookie can fix, so the caller
    stops instead of trying the next attempt.
    """
    started = time.monotonic()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(watch_url(video_id), download=False)
    except Exception as exc:
        msg = str(exc) or exc.__class__.__name__
        if "Requested format is not available" in msg or "Sign in to confirm" in msg:
            return None, False
        logger.warning("[Preview] yt-dlp extract failed for %s: %s", video_id, msg[:300])
        return None, True
    if not isinstance(info, dict) or not info:
        return None, False
    selected = info
    url = info.get("url")
    if not isinstance(url, str) or not url:
        for collection in (info.get("requested_formats") or [], info.get("formats") or []):
            for fmt in collection:
                candidate = fmt.get("url") if isinstance(fmt, dict) else None
                if isinstance(candidate, str) and candidate:
                    url = candidate
                    selected = fmt
                    break
            if isinstance(url, str) and url:
                break
    if not isinstance(url, str) or not url:
        return None, False
    if require_audio_only and selected.get("vcodec") != "none":
        logger.info(
            "[Preview] Fast path for %s degraded to muxed format %s; using fallback clients",
            video_id,
            selected.get("format_id") or info.get("format_id") or "unknown",
        )
        return None, False
    return (
        resolved_stream(
            url,
            egress="relay" if egress == "relay" else "direct",
            proxy_url=proxy_url,
            resolution_ms=round((time.monotonic() - started) * 1000),
        ),
        False,
    )


def get_resolved_stream(
    video_id: str, cookies: Cookies, *, skip_fast_path: bool = False
) -> Optional[ResolvedStream]:
    """Resolve audio together with the network path that owns the URL.

    `skip_fast_path` is for a caller retrying after the CDN itself
    rejected a URL the fast path produced: extraction succeeds and hands
    back a signed URL, but googlevideo 403s the audio-only formats this
    station asks for when the player client behind them has no PO token
    (`android_vr` does not, for anything but 360p muxed). That rejection
    never reaches `_extract`'s except clause — it happens later, when the
    caller actually fetches bytes — so re-resolving without this flag
    would just ask the same client again and fail the same way.
    """
    from shared.ffmpeg_runtime import apply_ytdlp_ffmpeg_options

    if not video_id or not str(video_id).strip():
        return None

    base_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": YDL_FORMAT_AUDIO_PREVIEW,
        "extractor_args": {"youtube": {"player_client": ["default", "android", "ios"]}},
    }
    proxy = yt_proxy()

    # Fast path first. `android_vr` is the only client of the three below
    # whose formats survive today — the android and ios responses are
    # fetched and then discarded for want of a PO token — so asking for it
    # alone drops two round trips, and a reused session identifier drops the
    # 1 MB watch page. Measured on a relayed station: 2658 ms and 1590 KB
    # down to 1774 ms and 451 KB.
    #
    # Everything below stays as the fallback: this path leans on a session
    # identifier and a single client, and both are YouTube's to break.
    visitor = visitor_data() if not skip_fast_path else None
    if visitor:
        fast_opts: Dict[str, Any] = {
            **base_opts,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android_vr"],
                    "player_skip": ["webpage", "configs"],
                    "visitor_data": [visitor],
                }
            },
        }
        if proxy:
            fast_opts["proxy"] = proxy
        elif force_ipv4():
            fast_opts["source_address"] = "0.0.0.0"
        result, _hard_error = _extract(
            video_id,
            fast_opts,
            egress="relay" if proxy else "direct",
            proxy_url=proxy or None,
            require_audio_only=True,
        )
        if result:
            return result
        # A rejected identifier looks like a hard error; drop it so the next
        # resolution fetches a fresh one instead of failing the same way.
        reset_visitor_data()

    def direct(**extra: Any) -> Dict[str, Any]:
        # Not `apply_network_options`: that injects the configured relay and
        # would silently mislabel a direct result.
        opts = {**base_opts, **extra}
        apply_ytdlp_ffmpeg_options(opts)
        return opts

    cookie_file = cookies.usable_file()
    attempts: list[tuple[Dict[str, Any], str, Optional[str]]] = []
    # A relay is the primary path when configured. Its result retains the
    # proxy URL so every later byte follows the same egress.
    if proxy:
        attempts.append((apply_network_options({**base_opts, "proxy": proxy}), "relay", proxy))
    if cookie_file:
        attempts.append((direct(cookiefile=cookie_file, source_address="::"), "direct", None))
    attempts.append((direct(**({"source_address": "0.0.0.0"} if force_ipv4() else {})), "direct", None))
    if cookie_file:
        attempts.append((direct(cookiefile=cookie_file, source_address="0.0.0.0"), "direct", None))

    for opts, egress, proxy_url in attempts:
        result, hard_error = _extract(video_id, opts, egress=egress, proxy_url=proxy_url)
        if hard_error:
            return None
        if result:
            return result

    logger.warning("[Preview] All attempts failed for %s.", video_id)
    return None
