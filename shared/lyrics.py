"""
Fast, confidence-gated LRCLIB lyrics resolution.

YouTube metadata is often a video title plus a channel name rather than a
track signature.  The resolver normalizes that metadata locally, performs one
broad LRCLIB search, and scores the returned candidates.  Deezer is only used
as a short, bounded fallback when LRCLIB returns no candidates.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
import unicodedata
from concurrent.futures import Future, ThreadPoolExecutor
from difflib import SequenceMatcher
from statistics import median
from functools import partial
from typing import Any, Dict, Optional

import requests

from shared.music_identity import canonical_music_identity

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

RESOLVER_SOURCE = "lrclib:v5"

_LOOKUP_WORKERS = 2

_SPACE_RE = re.compile(r"\s+")
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


def _canonical_metadata(artist: str, title: str) -> tuple[str, str]:
    identity = canonical_music_identity(artist, title, channel=artist)
    return identity.artist, identity.title


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


#: How far a recording's length may sit from the one its lyrics were timed
#: against before the timing is doubted. LRCLIB itself matches within two
#: seconds; a cut with an intro or a coda is off by ten or more.
TIMING_TOLERANCE_SEC = 3


def _synced_duration(item: Dict[str, Any], results: Any) -> Optional[int]:
    """The running time the chosen timed lines were written against, if LRCLIB agrees on one.

    LRCLIB's durations are typed in by whoever uploads the lyrics, and the same
    timing is uploaded again and again, once per compilation it appeared on.
    Those copies vote. A length shorter than the last timed line cannot be the
    recording's, and is thrown out; of the rest, the tightest cluster speaks
    for the timing only when most of them sit in it. Copies scattered from 30 s
    to seven minutes say nothing, and nothing is better than a wrong length:
    it would mark the very recording these lines were timed for as another cut.
    """
    synced = item.get("syncedLyrics")
    if not synced:
        return None
    stamps = parse_lrc(synced)
    last_line_sec = stamps[-1][0] / 1000 if stamps else 0.0
    rows = results if isinstance(results, list) else [item]
    votes: list[float] = []
    for row in rows:
        if isinstance(row, dict) and row.get("syncedLyrics") == synced:
            try:
                value = float(row.get("duration"))
            except (TypeError, ValueError):
                continue
            if value >= last_line_sec and value > 0:
                votes.append(value)
    if not votes:
        return None
    votes.sort()
    cluster: list[float] = []
    for start, low in enumerate(votes):
        window = [value for value in votes[start:] if value - low <= 2 * TIMING_TOLERANCE_SEC]
        if len(window) > len(cluster):
            cluster = window
    if len(cluster) * 2 <= len(votes):
        return None
    return int(round(median(cluster)))


def _result_to_record(item: Dict[str, Any], results: Any = None) -> Dict[str, Any]:
    return {
        "synced": item.get("syncedLyrics") or None,
        "plain": item.get("plainLyrics") or None,
        "instrumental": bool(item.get("instrumental")),
        "source": RESOLVER_SOURCE,
        "synced_duration": _synced_duration(item, results),
    }


def has_text(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a lyrics record holds anything to show."""
    return bool(record and (record.get("synced") or record.get("plain") or record.get("instrumental")))


def predates_timing_length(record: Optional[Dict[str, Any]]) -> bool:
    """Timed lines cached by a resolver that did not record their length.

    They are looked up once more, so the length can be checked; until that
    lookup lands, and if it finds nothing, the lines already held are kept.
    """
    return bool(record and record.get("synced") and record.get("source") != RESOLVER_SOURCE)


def store(db: Any, key: str, record: Dict[str, Any]) -> None:
    """Cache a resolved record under a track id or a metadata key."""
    db.set_lyrics(
        key,
        synced=record["synced"],
        plain=record["plain"],
        instrumental=record["instrumental"],
        source=record["source"],
        synced_duration=record.get("synced_duration"),
    )


def settle_upgrade(db: Any, key: str, held: Dict[str, Any], found: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Store the answer to a once-only upgrade lookup; returns what to serve.

    A record with something in it replaces what was held. An empty one keeps
    the held lines but marks them looked up, so a song the provider no longer
    knows is not looked up again on every play.
    """
    if has_text(found):
        store(db, key, found)
        return found
    kept = {**held, "source": RESOLVER_SOURCE, "synced_duration": None}
    store(db, key, kept)
    return kept


def synced_timing_fits(audio_duration: Any, synced_duration: Any) -> bool:
    """Whether timed lines can follow a recording of this length.

    The same song is published in cuts of different lengths — a music video
    with a spoken intro, a radio edit — and LRCLIB's timing belongs to one of
    them. Unknown on either side is not evidence of a mismatch.
    """
    try:
        audio, synced = float(audio_duration or 0), float(synced_duration or 0)
    except (TypeError, ValueError):
        return True
    if audio <= 0 or synced <= 0:
        return True
    return abs(audio - synced) <= TIMING_TOLERANCE_SEC


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
    # A plain query: Deezer's field syntax (`artist:"…" track:"…"`) now
    # answers nothing for songs it holds, which left this fallback silent.
    # The rows are scored against artist and title before anything is used.
    query = f"{artist} {title}"
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


def _lrclib_search(
    artist: str,
    title: str,
    album: Optional[str],
    deadline: float,
) -> list[Dict[str, Any]]:
    # LRCLIB's broad ``q`` search can be dramatically slower than its
    # structured index (and, in practice, may time out while the same exact
    # record answers in a few hundred milliseconds). Keep the normalized
    # metadata separate so the provider can use that index.
    params: Dict[str, Any] = {
        "artist_name": artist,
        "track_name": title,
    }
    if album:
        params["album_name"] = album
    results = _lrclib_get(
        "/api/search",
        params,
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
        results = _lrclib_search(clean_artist, clean_title, album, deadline)
        best = _pick_best(results, clean_artist, clean_title, album, duration)
        if best:
            return _result_to_record(best, results)

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
            return _result_to_record(rescored, results)

        old_query = _fold(f"{clean_artist} {clean_title}")
        canonical_query = _fold(f"{canonical_artist} {canonical_title}")
        if canonical_query == old_query:
            return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}
        retry_results = _lrclib_search(
            canonical_artist,
            canonical_title,
            canonical_album,
            deadline,
        )
        retry_best = _pick_best(
            retry_results,
            canonical_artist,
            canonical_title,
            canonical_album,
            canonical_duration,
        )
        if retry_best:
            return _result_to_record(retry_best, retry_results)
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


def metadata_cache_key(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> str:
    """Stable, opaque cache identity for a metadata-only streaming track.

    Preview ids are transport identities and may change, but the normalized
    signature used to resolve the lyrics is stable. Hashing also avoids
    persisting user-supplied metadata verbatim as a SQLite primary key.
    """
    digest = hashlib.sha256(_lookup_key(artist, title, album, duration).encode("utf-8")).hexdigest()
    return f"metadata-lyrics:{digest}"


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


_LRC_TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def parse_lrc(text: str) -> list[tuple[int, str]]:
    """LRC text as ``(offset in milliseconds, line)``, in time order.

    The player parses this in the browser; a client that speaks a protocol with
    timed lyrics needs the same reading server-side. One line may carry several
    stamps — that is how an LRC file writes a repeated chorus — so each becomes
    its own entry.
    """
    lines: list[tuple[int, str]] = []
    for raw in str(text or "").splitlines():
        stamps = list(_LRC_TIMESTAMP.finditer(raw))
        if not stamps:
            continue
        content = raw[stamps[-1].end():].strip()
        for stamp in stamps:
            minutes, seconds, fraction = stamp.groups()
            # Two digits after the separator are hundredths, three are millis.
            millis = int((fraction or "0").ljust(3, "0")[:3]) if fraction else 0
            lines.append((int(minutes) * 60_000 + int(seconds) * 1000 + millis, content))
    return sorted(lines, key=lambda entry: entry[0])


def _reset_lyrics_jobs_for_tests() -> None:
    _LOOKUPS.clear_for_tests()
