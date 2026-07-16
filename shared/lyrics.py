"""
Fast, confidence-gated LRCLIB lyrics resolution.

YouTube metadata is often a video title plus a channel name rather than a
track signature.  The resolver normalizes that metadata locally, performs one
broad LRCLIB search, and scores the returned candidates.  Deezer is only used
as a short, bounded fallback when LRCLIB returns no candidates.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from concurrent.futures import Future, ThreadPoolExecutor
from difflib import SequenceMatcher
from functools import partial
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)

_LRCLIB_HOST = "https://lrclib.net"
_DEEZER_HOST = "https://api.deezer.com"
_USER_AGENT = "Soundsible/1.0 (https://github.com/Arzuparreta/soundsible)"

# The common path makes one LRCLIB request.  Only a genuine no-result response
# can spend the remaining budget on Deezer + one canonical LRCLIB retry.
_TOTAL_BUDGET_SEC = 9.0
_LRCLIB_TIMEOUT_SEC = 8.0
_DEEZER_TIMEOUT_SEC = 1.25
_MIN_FALLBACK_BUDGET_SEC = 1.0
_MIN_MATCH_SCORE = 0.72
_MIN_TITLE_SCORE = 0.68

RESOLVER_SOURCE = "lrclib:v2"

_LOOKUP_WORKERS = 2

_BRACKET_RE = re.compile(r"\s*[\[(]([^\])]+)[\])]\s*")
_SPACE_RE = re.compile(r"\s+")
_SEPARATOR_RE = re.compile(r"\s+(?:-|–|—|:|\|)\s+")
_CHANNEL_SUFFIX_RE = re.compile(
    r"(?:\s*[-–—]\s*|\s+)?[\[(]?(?:official channel|canal oficial|official|oficial|topic|vevo)[\])]?\s*$",
    re.IGNORECASE,
)
_NOISE_TOKENS = {
    "4k",
    "audio",
    "clip",
    "full",
    "hd",
    "hq",
    "letra",
    "letras",
    "lyric",
    "lyrics",
    "music",
    "official",
    "oficial",
    "video",
    "videoclip",
}
_VERSION_TOKENS = {
    "acoustic",
    "acustico",
    "demo",
    "instrumental",
    "karaoke",
    "live",
    "mix",
    "remix",
    "remaster",
    "remastered",
}


def _fold(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return _SPACE_RE.sub(" ", text).strip()


def _strip_noise_groups(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tokens = set(_fold(match.group(1)).split())
        return " " if tokens and tokens <= _NOISE_TOKENS else match.group(0)

    return _SPACE_RE.sub(" ", _BRACKET_RE.sub(replace, value or "")).strip()


def _canonical_metadata(artist: str, title: str) -> tuple[str, str]:
    clean_artist = _CHANNEL_SUFFIX_RE.sub("", (artist or "").strip()).strip(" -–—|:")
    clean_title = _strip_noise_groups((title or "").strip())

    # YouTube commonly stores "Artist - Track" as the title while also using
    # the artist/channel in the artist field. Remove only a matching prefix.
    parts = _SEPARATOR_RE.split(clean_title, maxsplit=1)
    if len(parts) == 2:
        prefix, remainder = parts
        folded_artist = _fold(clean_artist)
        folded_prefix = _fold(_CHANNEL_SUFFIX_RE.sub("", prefix))
        if folded_artist and folded_prefix and (
            folded_artist == folded_prefix
            or folded_artist in folded_prefix
            or folded_prefix in folded_artist
        ):
            clean_title = remainder.strip()

    return clean_artist or (artist or "").strip(), clean_title or (title or "").strip()


def _version_tokens(value: Any) -> set[str]:
    return set(_fold(value).split()) & _VERSION_TOKENS


def _similarity(left: Any, right: Any) -> float:
    a, b = _fold(left), _fold(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def _duration_score(expected: Optional[int], candidate: Any) -> float:
    if not expected or candidate is None:
        return 0.6
    try:
        diff = abs(float(candidate) - float(expected))
    except (TypeError, ValueError):
        return 0.0
    if diff <= 3:
        return 1.0
    if diff <= 8:
        return 0.82
    if diff <= 15:
        return 0.55
    if diff <= 30:
        return 0.15
    return 0.0


def _candidate_score(
    artist: str,
    title: str,
    album: Optional[str],
    duration: Optional[int],
    item: Dict[str, Any],
) -> tuple[float, float]:
    candidate_title = item.get("trackName") or item.get("title_short") or item.get("title")
    candidate_artist = item.get("artistName")
    if not candidate_artist and isinstance(item.get("artist"), dict):
        candidate_artist = item["artist"].get("name")
    candidate_album = item.get("albumName")
    if not candidate_album and isinstance(item.get("album"), dict):
        candidate_album = item["album"].get("title")

    title_score = _similarity(title, candidate_title)
    artist_score = _similarity(artist, candidate_artist)
    album_score = _similarity(album, candidate_album) if album else 0.6
    duration_score = _duration_score(duration, item.get("duration"))
    score = 0.50 * title_score + 0.30 * artist_score + 0.15 * duration_score + 0.05 * album_score

    expected_versions = _version_tokens(title)
    candidate_versions = _version_tokens(candidate_title)
    if expected_versions != candidate_versions:
        score -= 0.18
    return max(0.0, score), title_score


def _result_to_record(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "synced": item.get("syncedLyrics") or None,
        "plain": item.get("plainLyrics") or None,
        "instrumental": bool(item.get("instrumental")),
        "source": RESOLVER_SOURCE,
    }


def _remaining(deadline: float, maximum: float) -> float:
    return max(0.1, min(maximum, deadline - time.monotonic()))


def _timeout_parts(total_sec: float, connect_cap: float) -> tuple[float, float]:
    """Split one wall-clock allowance between connect and response phases."""
    total_sec = max(0.2, total_sec)
    connect = min(connect_cap, total_sec * 0.3)
    return max(0.1, connect), max(0.1, total_sec - connect)


def _lrclib_get(path: str, params: Dict[str, Any], timeout_sec: float = _LRCLIB_TIMEOUT_SEC) -> Optional[Any]:
    resp = requests.get(
        f"{_LRCLIB_HOST}{path}",
        params=params,
        headers={"User-Agent": _USER_AGENT},
        timeout=_timeout_parts(timeout_sec, 1.0),
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def _deezer_search(artist: str, title: str, timeout_sec: float) -> list[Dict[str, Any]]:
    query = f'artist:"{artist}" track:"{title}"'
    resp = requests.get(
        f"{_DEEZER_HOST}/search",
        params={"q": query, "limit": 5},
        headers={"User-Agent": _USER_AGENT},
        timeout=_timeout_parts(timeout_sec, 0.75),
    )
    resp.raise_for_status()
    payload = resp.json()
    return payload.get("data", []) if isinstance(payload, dict) and isinstance(payload.get("data"), list) else []


def _pick_best(
    results: Any,
    artist: str,
    title: str,
    album: Optional[str],
    duration: Optional[int],
) -> Optional[Dict[str, Any]]:
    ranked: list[tuple[float, float, Dict[str, Any]]] = []
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict):
                score, title_score = _candidate_score(artist, title, album, duration, item)
                ranked.append((score, title_score, item))
    if not ranked:
        return None
    score, title_score, item = max(ranked, key=lambda row: row[0])
    if score < _MIN_MATCH_SCORE or title_score < _MIN_TITLE_SCORE:
        return None
    return item


def _lrclib_search(artist: str, title: str, deadline: float) -> list[Dict[str, Any]]:
    query = " ".join(part for part in (artist, title) if part).strip()
    results = _lrclib_get(
        "/api/search",
        {"q": query},
        _remaining(deadline, _LRCLIB_TIMEOUT_SEC),
    )
    return results if isinstance(results, list) else []


def fetch_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Resolve lyrics without using downloader queues or their workers.

    Returns an empty record for a confident provider-level not-found response,
    or ``None`` for network/provider errors so callers do not negative-cache a
    transient outage.
    """
    if not artist or not title:
        return None

    deadline = time.monotonic() + _TOTAL_BUDGET_SEC
    clean_artist, clean_title = _canonical_metadata(artist, title)
    try:
        results = _lrclib_search(clean_artist, clean_title, deadline)
        best = _pick_best(results, clean_artist, clean_title, album, duration)
        if best:
            return _result_to_record(best)

        # Deezer is deliberately not on the hot path. It only canonicalizes a
        # real LRCLIB miss and has a small timeout, so lyrics cannot monopolize
        # request capacity or interfere with downloader workers.
        if deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
            return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}

        deezer_rows = _deezer_search(
            clean_artist,
            clean_title,
            _remaining(deadline, _DEEZER_TIMEOUT_SEC),
        )
        deezer_best = _pick_best(deezer_rows, clean_artist, clean_title, album, duration)
        if not deezer_best or deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
            return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}

        canonical_artist = (deezer_best.get("artist") or {}).get("name") or clean_artist
        canonical_title = deezer_best.get("title_short") or deezer_best.get("title") or clean_title
        canonical_album = (deezer_best.get("album") or {}).get("title") or album
        canonical_duration = deezer_best.get("duration") or duration

        # New duration/album evidence may be enough to select an existing
        # LRCLIB row, without spending another network round trip.
        rescored = _pick_best(
            results,
            canonical_artist,
            canonical_title,
            canonical_album,
            canonical_duration,
        )
        if rescored:
            return _result_to_record(rescored)

        old_query = _fold(f"{clean_artist} {clean_title}")
        canonical_query = _fold(f"{canonical_artist} {canonical_title}")
        if canonical_query == old_query:
            return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}
        retry_results = _lrclib_search(canonical_artist, canonical_title, deadline)
        retry_best = _pick_best(
            retry_results,
            canonical_artist,
            canonical_title,
            canonical_album,
            canonical_duration,
        )
        if retry_best:
            return _result_to_record(retry_best)
        return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}
    except requests.RequestException as exc:
        logger.warning("Lyrics provider request failed for %s - %s: %s", artist, title, exc)
        return None
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("Lyrics response parse error for %s - %s: %s", artist, title, exc)
        return None


class _LyricsLookupCoordinator:
    """Two dedicated workers, single-flight keys, and deliberately no queue.

    A semaphore is acquired before submitting to ThreadPoolExecutor, so its
    internal work queue never accumulates waiting lyrics tasks. When both
    workers are occupied the API responds ``pending`` and the client retries.
    Downloader workers are entirely separate from this coordinator.
    """

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS, thread_name_prefix="soundsible-lyrics")
        self._slots = threading.BoundedSemaphore(_LOOKUP_WORKERS)
        self._lock = threading.Lock()
        self._jobs: dict[str, Future] = {}

    def _run(self, fn):
        try:
            return fn()
        finally:
            self._slots.release()

    def poll_or_start(self, key: str, fn) -> tuple[str, Optional[Dict[str, Any]]]:
        with self._lock:
            job = self._jobs.get(key)
            if job is not None:
                if not job.done():
                    return "pending", None
                self._jobs.pop(key, None)
                try:
                    return "complete", job.result()
                except Exception as exc:
                    logger.warning("Lyrics background lookup failed: %s", exc)
                    return "complete", None

            if not self._slots.acquire(blocking=False):
                return "busy", None
            try:
                future = self._executor.submit(self._run, fn)
            except Exception:
                self._slots.release()
                raise
            self._jobs[key] = future
            return "pending", None

    def clear_for_tests(self) -> None:
        with self._lock:
            self._jobs.clear()


_LOOKUPS = _LyricsLookupCoordinator()


def _lookup_key(artist: str, title: str, album: Optional[str], duration: Optional[int]) -> str:
    clean_artist, clean_title = _canonical_metadata(artist, title)
    return "\x00".join(
        (
            RESOLVER_SOURCE,
            _fold(clean_artist),
            _fold(clean_title),
            _fold(album),
            str(int(duration or 0)),
        )
    )


def poll_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Poll/start a bounded background lookup.

    Status is ``complete``, ``pending``, or ``busy``. Busy means both dedicated
    workers are active; no server-side task was buffered.
    """
    key = _lookup_key(artist, title, album, duration)
    return _LOOKUPS.poll_or_start(key, partial(fetch_lyrics, artist, title, album, duration))


def _reset_lyrics_jobs_for_tests() -> None:
    _LOOKUPS.clear_for_tests()
