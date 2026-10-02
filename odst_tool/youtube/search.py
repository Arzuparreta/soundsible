"""Finding videos: text search, match candidates, related videos, peeks.

Every row comes back in one shape: id, title, duration, thumbnail,
webpage_url and channel, plus the song fields of `youtube_music_metadata`
(title and artist are the song, source_title the upload's own title).
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import yt_dlp

from shared.music_identity import youtube_music_metadata

from ..config import (
    DURATION_TOLERANCE_SEC,
    FORBIDDEN_KEYWORDS,
    SEARCH_STRATEGY_FALLBACK,
    SEARCH_STRATEGY_PRIMARY,
    prefer_ytmusic,
)
from .ids import is_valid_video_id, thumbnail_url, video_id_from_url, watch_url
from .web import oembed_creator
from .ytdlp import Cookies, apply_network_options

logger = logging.getLogger(__name__)


def _extract_options(**extra: Any) -> Dict[str, Any]:
    """Options for a metadata-only yt-dlp call, routed like every other call."""
    return apply_network_options({
        "quiet": True,
        "no_warnings": True,
        "extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},
        **extra,
    })


def _entries(result: Any) -> List[Dict[str, Any]]:
    if not result or "entries" not in result or result["entries"] is None:
        return []
    raw = result["entries"]
    return raw if isinstance(raw, list) else list(raw)


def music_fields(entry: Dict[str, Any], channel: str) -> Dict[str, Any]:
    """The song an extracted entry is, keeping `channel` as provenance only.

    yt-dlp's `artist`/`artists` come from YouTube's own music metadata; say so,
    so the channel is only read for a performer when the entry has none.
    """
    return youtube_music_metadata({
        **entry,
        "channel": channel,
        "artist_metadata_explicit": bool(entry.get("artist") or entry.get("artists")),
    })


def peek_video_metadata(url: str, cookies: Cookies) -> Dict[str, Any]:
    """Single extract_info (no download) to recover title/artist when embedded tags are wrong.

    Try without cookies first: browser cookie jars can make yt-dlp fail format resolution for
    metadata-only extracts ("Requested format is not available") while public URLs work anonymously.
    Fall back to cookies.txt then browser cookies for age-restricted / signed-in cases.
    """
    base = _extract_options(skip_download=True)
    attempts: List[Dict[str, Any]] = [dict(base)]
    if cookies.usable_file():
        attempts.append({**base, "cookiefile": cookies.file})
    if cookies.browser:
        attempts.append({**base, "cookiesfrombrowser": (cookies.browser, None, None, None)})
    last_err: Optional[Exception] = None
    for opts in attempts:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if isinstance(info, dict) and info:
                return info
        except Exception as e:
            last_err = e
            logger.debug("peek_video_metadata attempt failed for %s: %s", url, e)
    if last_err:
        logger.warning("peek_video_metadata failed for %s: %s", url, last_err)
    return {}


def peek_brief(url_or_id: str, cookies: Cookies) -> Optional[Dict[str, Any]]:
    """Lightweight YouTube metadata for UI (no download), in the search row shape."""
    raw = (url_or_id or "").strip()
    if not raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        url = raw
    elif is_valid_video_id(raw):
        url = watch_url(raw)
    else:
        return None
    info = peek_video_metadata(url, cookies)
    if not info:
        return None
    vid_raw = info.get("id") or video_id_from_url(url)
    vid_s = str(vid_raw).strip() if vid_raw is not None else ""
    valid = is_valid_video_id(vid_s)
    title = (info.get("track") or info.get("title") or "").strip() or "Unknown"
    thumb = (info.get("thumbnail") or "").strip()
    if not thumb and valid:
        thumb = thumbnail_url(vid_s) or ""
    webpage = (info.get("webpage_url") or "").strip()
    if valid:
        webpage = watch_url(vid_s)
    elif not webpage:
        webpage = url
    channel = str(info.get("channel") or info.get("uploader") or "").strip()
    return {
        "id": vid_s if valid else vid_raw,
        "title": title,
        "duration": int(info.get("duration") or 0),
        "thumbnail": thumb,
        "webpage_url": webpage,
        "channel": channel,
        **music_fields(info, channel),
    }


def _search_row(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not entry:
        return None
    video_id = entry.get("id")
    if not video_id:
        return None
    title = (entry.get("title") or "").strip()
    if not title or title.lower() == "unknown":
        return None
    vid_s = str(video_id).strip()
    if is_valid_video_id(vid_s):
        webpage_url = watch_url(vid_s)
    else:
        raw = (entry.get("webpage_url") or entry.get("url") or "").strip()
        if raw.startswith("http://") or raw.startswith("https://"):
            webpage_url = raw
        elif raw.startswith("/"):
            webpage_url = f"https://www.youtube.com{raw}"
        elif raw:
            webpage_url = f"https://www.youtube.com/{raw.lstrip('/')}"
        else:
            webpage_url = watch_url(vid_s)
    raw_creator = entry.get("channel") or entry.get("uploader") or entry.get("artist")
    if raw_creator is None:
        creator = ""
    elif isinstance(raw_creator, str):
        creator = raw_creator.strip()
    elif isinstance(raw_creator, (list, tuple)):
        creator = ", ".join(str(x) for x in raw_creator if x).strip()
    else:
        creator = str(raw_creator).strip()
    return {
        "id": video_id,
        "title": title,
        "duration": entry.get("duration") or 0,
        "thumbnail": entry.get("thumbnail") or thumbnail_url(video_id),
        "webpage_url": webpage_url,
        "channel": creator,
        **music_fields(entry, creator),
    }


def _enrich_missing_creators(items: List[Dict[str, Any]]) -> None:
    """Fill in the channel for rows that came back without one.

    YouTube Music's search returns ids and titles and nothing else, so
    every row needs this. It used to run a full extraction per row —
    8 rows measured 5.2 s, on top of a 0.9 s search — which is what made
    a cold resolve feel broken. The oembed endpoint answers the same
    question in a fraction of that: 8 rows in ~120 ms.

    Duration is deliberately not recovered here. oembed does not carry
    one, and the callers that actually need a duration score candidates
    against a known track — those ask `search_match_candidates`, whose
    search returns durations in the first place.
    """
    missing = [
        item
        for item in items
        if not (item.get("artist") or item.get("channel") or "").strip()
        and is_valid_video_id(str(item.get("id") or "").strip())
    ]
    if not missing:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(missing))) as executor:
        futures = {
            executor.submit(oembed_creator, str(item.get("id") or "")): item
            for item in missing
        }
        for future in as_completed(futures):
            item = futures[future]
            creator = future.result()
            if creator:
                item["artist"] = creator
                item["channel"] = creator
                item.update(youtube_music_metadata(item))


def search_youtube(
    query: str,
    cookies: Cookies,
    max_results: int = 10,
    use_ytmusic: bool = True,
    enrich_missing: bool = True,
) -> List[Dict[str, Any]]:
    """Search YouTube or YouTube Music with plain text, unfiltered.

    use_ytmusic=True: https://music.youtube.com/search?q=...#songs with
    extract_flat. Fast, but rows carry no channel (see
    `_enrich_missing_creators`). A full per-video extract was very slow (~tens
    of seconds) and often set url= relative paths that broke clients expecting
    absolute watch URLs. No cookies on this path.

    use_ytmusic=False: ytsearchN:query with extract_flat (fast; uploader present).

    Errors propagate: the caller decides whether to try the other surface.
    """
    if not query or not query.strip():
        return []
    query = query.strip()
    if use_ytmusic:
        ydl_opts = _extract_options(extract_flat=True, playlistend=max_results, ignoreerrors=True)
        search_input = f"https://music.youtube.com/search?q={quote(query)}#songs"
    else:
        ydl_opts = _extract_options(extract_flat=True, **cookies.ydl_options())
        search_input = f"ytsearch{max_results}:{query}"

    out: List[Dict[str, Any]] = []
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            entries = _entries(ydl.extract_info(search_input, download=False))
        if use_ytmusic:
            entries = entries[:max_results]
        for entry in entries:
            item = _search_row(entry)
            if item is not None:
                out.append(item)
        if use_ytmusic and enrich_missing:
            _enrich_missing_creators(out)
    except Exception as e:
        logger.warning("YouTube search error (use_ytmusic=%s): %s", use_ytmusic, e)
        raise
    return out


def search_match_candidates(
    artist: str, title: str, cookies: Cookies, max_results: int = 8
) -> List[Dict[str, Any]]:
    """Candidates to score against a track we already know.

    Deliberately the plain YouTube surface rather than the configured browse
    source. Scoring weighs title, channel and duration, and YouTube Music's
    search carries none of the last two: recovering them costs a full
    extraction per candidate — 5.2 s for eight — while plain search returns
    all three in one 0.9 s call. The ranking YouTube Music would add is
    redundant here anyway, because `best_candidate` re-ranks every result
    against the artist, title and duration we already hold.
    """
    query = f"{title} {artist}".strip()
    if not query:
        return []
    rows = search_youtube(
        query,
        cookies,
        max_results=max_results,
        use_ytmusic=False,
        enrich_missing=False,
    )
    # Matching scores the upload itself — its official/lyrics/version
    # markers — so it gets the title as uploaded, not the song title.
    return [{**row, "title": row.get("source_title") or row.get("title")} for row in rows]


def _related_row(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not entry:
        return None
    video_id = entry.get("id")
    if not video_id:
        return None
    channel = entry.get("channel") or entry.get("uploader") or ""
    return {
        "id": video_id,
        "title": (entry.get("title") or "").strip() or "Unknown",
        "duration": entry.get("duration") or 0,
        "thumbnail": entry.get("thumbnail") or thumbnail_url(video_id),
        "webpage_url": entry.get("url") or entry.get("webpage_url") or watch_url(video_id),
        "channel": channel,
        **music_fields(entry, channel),
    }


def get_related_videos(
    seed_video_id: str,
    cookies: Cookies,
    max_results: int = 25,
    enrich: bool = True,
) -> List[Dict[str, Any]]:
    """Related videos for a seed, in the search row shape.

    Order of attempts:
      1. RD mix playlist (flat extraction) — one yt-dlp call, deterministic,
         matches YouTube's official "Radio" mix for the seed. No fan-out.
      2. A search by the seed's own title and artist. `enrich=False` skips
         the creator fan-out, which can add several seconds.
      3. RD mix without flat extraction (full per-entry extract) — last resort.
    """
    if not is_valid_video_id(seed_video_id):
        return []

    def _try_extract(ydl_opts: dict, url: str) -> List[Dict[str, Any]]:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(url, download=False)
        if not result or "entries" not in result:
            logger.debug(
                "[Discover] get_related_videos: no entries in result (keys: %s)",
                list(result.keys()) if result else "None",
            )
            return []
        rows = (_related_row(entry) for entry in _entries(result)[:max_results])
        return [row for row in rows if row is not None]

    base_opts = _extract_options(socket_timeout=12, **cookies.ydl_options())
    mix_url = f"{watch_url(seed_video_id)}&list=RD{seed_video_id}&start_radio=1"

    try:
        results = _try_extract({**base_opts, "extract_flat": "in_playlist", "noplaylist": False}, mix_url)
        if results:
            return results
    except Exception as e:
        logger.debug("[Discover] get_related_videos RD flat failed: %s", e)

    try:
        info = peek_video_metadata(watch_url(seed_video_id), cookies)
        if info:
            title = str(info.get("track") or info.get("title") or "").strip()
            raw_artist = info.get("artist") or info.get("channel") or info.get("uploader") or ""
            if isinstance(raw_artist, (list, tuple)):
                artist = ", ".join(str(x) for x in raw_artist if x)
            else:
                artist = str(raw_artist).strip() if isinstance(raw_artist, str) else ""
            query = f"{title} {artist}".strip()
            if query:
                results = search_youtube(
                    query,
                    cookies,
                    max_results=max_results,
                    use_ytmusic=prefer_ytmusic(),
                    enrich_missing=enrich,
                )
                results = [r for r in results if str(r.get("id", "")) != seed_video_id]
                if results:
                    return results
    except Exception as e:
        logger.debug("[Discover] get_related_videos search fallback failed: %s", e)

    try:
        results = _try_extract({**base_opts, "noplaylist": False}, mix_url)
        if results:
            return results
    except Exception as e:
        logger.debug("[Discover] get_related_videos RD full failed: %s", e)

    return []


def _is_valid_match(video_info: Dict[str, Any], metadata: Dict[str, Any]) -> tuple[bool, float]:
    """Check if a video is a valid match using word intersection."""
    title = video_info.get("title", "").lower()

    target_duration = metadata.get("duration_sec", 0)
    if target_duration > 0:
        if abs(video_info.get("duration", 0) - target_duration) > DURATION_TOLERANCE_SEC:
            return False, 0.0

    for keyword in FORBIDDEN_KEYWORDS:
        if keyword in title and keyword not in metadata["title"].lower():
            return False, 0.0

    # Most of the query's meaningful words must appear in the video title.
    query_words = set(re.findall(r"\w+", f"{metadata['artist']} {metadata['title']}".lower()))
    query_words -= {"a", "the", "of", "and", "official", "audio", "video", "music"}
    if not query_words:
        return True, 1.0
    match_ratio = len(query_words & set(re.findall(r"\w+", title))) / len(query_words)
    if match_ratio >= 0.5:
        return True, match_ratio
    return False, 0.0


def find_track(metadata: Dict[str, Any], cookies: Cookies) -> Optional[Dict[str, Any]]:
    """The best search result for an artist and title, or None."""
    queries = [
        SEARCH_STRATEGY_PRIMARY.format(artist=metadata["artist"], title=metadata["title"]),
        SEARCH_STRATEGY_FALLBACK.format(artist=metadata["artist"], title=metadata["title"]),
    ]
    ydl_opts = _extract_options(extract_flat=True, **cookies.ydl_options())
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        for query in queries:
            try:
                results = ydl.extract_info(f"ytsearch5:{query}", download=False)
                if not results or "entries" not in results:
                    continue
                best_match = None
                highest_score = 0
                for entry in results["entries"]:
                    if not entry:
                        continue
                    is_valid, score = _is_valid_match(entry, metadata)
                    if is_valid and score > highest_score:
                        highest_score = score
                        best_match = entry
                if best_match:
                    logger.debug("Found match: %s (Score: %.2f)", best_match.get("title"), highest_score)
                    return best_match
            except Exception as e:
                logger.warning("Search error for %s: %s", query, e)
    return None
