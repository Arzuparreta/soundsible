"""
Fast, confidence-gated lyrics resolution with non-blocking syllable enrichment.

Phase 1 (fast path, serves immediately):
  LRCLIB (with bounded Deezer metadata canonicalization) is asked first. When
  LRCLIB has no timed lines that fit the recording — nothing at all, plain text
  only, an "instrumental" flag, lines timed for another length, or an outage —
  lrc.red (TTML) is asked once, then NetEase (YRC/LRC) as a bounded third
  fallback.

Phase 2 (background enrichment, never blocks first render or drops coverage):
  When a track has verified text (line-synced or plain) without word/syllable
  timing yet, a dedicated zero-backlog worker looks up richer timing once:
    1. lrc.red TTML (manual preferred, AI-aligned ``byModel`` accepted)
    2. NetEase YRC (identity- and duration-verified)
    3. LyricsPlus (Apple/QQ aggregator — strictly text-verified against the
       already-verified lyrics with token Jaccard >= 0.60 so remixes and wrong
       tracks are rejected)

  Enriched timing is persisted separately in ``rich_synced`` / ``rich_source``
  so existing line LRC and OpenSubsonic serving remain untouched.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import Future, ThreadPoolExecutor
from difflib import SequenceMatcher
from functools import partial
from statistics import median
from typing import Any, Callable, Dict, Optional

import requests

from shared.lyrics_formats import (
    parse_lrc,
    parse_lyricsplus,
    parse_rich_synced,
    parse_ttml,
    parse_yrc,
    strip_netease_lrc_credits,
)
from shared.music_identity import canonical_music_identity, fold_music_text

logger = logging.getLogger(__name__)

_LRCLIB_HOST = "https://lrclib.net"
_DEEZER_HOST = "https://api.deezer.com"
_LRC_RED_HOST = "https://lrc.red"
_NETEASE_HOST = "https://music.163.com"
_LYRICSPLUS_HOST = "https://lyricsplus.prjktla.my.id"
_USER_AGENT = "Soundsible/1.0 (https://github.com/Arzuparreta/soundsible)"
# lrc.red's terms ask every client to name itself with a link and a contact
# address (https://lrc.red/api); the address is the one SECURITY.md publishes.
_LRC_RED_CONTACT = "rubenpenarubio02@gmail.com"
_LRC_RED_USER_AGENT = f"{_USER_AGENT} (contact: {_LRC_RED_CONTACT})"
_MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024

# The common path makes one LRCLIB request.  Only a genuine no-result response
# can spend the remaining budget on Deezer + one canonical LRCLIB retry.
_TOTAL_BUDGET_SEC = 9.0
_ENRICH_BUDGET_SEC = 8.0
_LRCLIB_TIMEOUT_SEC = 8.0
_DEEZER_TIMEOUT_SEC = 1.25
_MIN_FALLBACK_BUDGET_SEC = 1.0
_MIN_NETEASE_FALLBACK_BUDGET_SEC = 2.0
_MIN_MATCH_SCORE = 0.72
_MIN_TITLE_SCORE = 0.68
# "Busy, ask again in a moment" answers, retried while the budget allows.
_LRCLIB_RETRY_STATUSES = frozenset({429, 503})
_LRCLIB_DEFAULT_RETRY_SEC = 1.0
_LRCLIB_MAX_RETRY_WAIT_SEC = 2.0
_LRCLIB_RETRY_JITTER_SEC = 0.25
# What a retry needs left after its wait to be worth sending.
_LRCLIB_MIN_RETRY_REQUEST_SEC = 1.0

RESOLVER_SOURCE = "lrclib:v6"
#: Lines lrc.red supplied. Its terms ask for a credit wherever they are shown.
LRC_RED_SOURCE = "lrc.red:v6"
NETEASE_SOURCE = "netease:v6"
_CURRENT_SOURCES = frozenset({RESOLVER_SOURCE, LRC_RED_SOURCE, NETEASE_SOURCE})
#: Resolvers whose records carry a trustworthy ``synced_duration``.
_LENGTH_SOURCES = frozenset({"lrclib:v5", RESOLVER_SOURCE, LRC_RED_SOURCE, NETEASE_SOURCE})

#: Phase 2 rich-enrichment source tags.
RICH_NONE_SOURCE = "none:v1"
RICH_LRC_RED_SOURCE = "lrc.red:v1"
RICH_LRC_RED_AI_SOURCE = "lrc.red:ai:v1"
RICH_NETEASE_SOURCE = "netease:v1"
RICH_LYRICSPLUS_SOURCE = "lyricsplus:v1"
_RICH_LRC_RED_SOURCES = frozenset({RICH_LRC_RED_SOURCE, RICH_LRC_RED_AI_SOURCE})

# Two requests (a search, then the TTML) on a CDN that answers in ~0.1 s.
_LRC_RED_TIMEOUT_SEC = 3.0
_NETEASE_TIMEOUT_SEC = 2.5
_LYRICSPLUS_TIMEOUT_SEC = 3.5
# The screen the provider comparison applied before counting a candidate as
# the same song: stricter than LRCLIB's score, because loose full-text search
# also returns other songs and other versions.
_LRC_RED_MIN_TITLE = 0.80
_LRC_RED_MIN_ARTIST = 0.72
_LYRICSPLUS_MIN_JACCARD = 0.60
_LRC_RED_ENRICH_MIN_JACCARD = 0.50
_ISRC_RE = re.compile(r"^[A-Z0-9]{12}$")

_LOOKUP_WORKERS = 2
_ENRICH_WORKERS = 2

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


def _canonical_metadata(artist: str, title: str) -> tuple[str, str]:
    identity = canonical_music_identity(artist, title, channel=artist)
    return identity.artist, identity.title


def _version_tokens(value: Any) -> set[str]:
    return set(fold_music_text(value).split()) & _VERSION_TOKENS


def _similarity(left: Any, right: Any) -> float:
    a, b = fold_music_text(left), fold_music_text(right)
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


def audio_key(youtube_id: Optional[str] = None, track_id: Optional[str] = None) -> Optional[str]:
    """What a listener's lyrics offset belongs to: the audio's timeline.

    A file downloaded from a video plays the video's timeline, so both share
    the video's key and an offset set while streaming survives the download.
    """
    from shared.url_utils import validate_youtube_video_id

    if youtube_id and validate_youtube_video_id(str(youtube_id)):
        return f"yt:{youtube_id}"
    return f"lib:{track_id}" if track_id else None


def has_text(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a lyrics record holds anything to show."""
    return bool(
        record and (record.get("synced") or record.get("plain") or record.get("instrumental") or record.get("rich_synced"))
    )


def provider(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Who supplied a record's line/plain lyrics: ``"lrc.red"``, ``"netease"``, ``"lrclib"``, or nobody.

    Used by OpenSubsonic (which only serves line/plain text and never exposes
    ``rich_synced``), so enriching an LRCLIB row with lrc.red rich timing does
    not remove LRCLIB's line lyrics from Subsonic clients.
    """
    if not has_text(record):
        return None
    source = record.get("source")
    if source == LRC_RED_SOURCE:
        return "lrc.red"
    if source == NETEASE_SOURCE:
        return "netease"
    return "lrclib"


def display_provider(record: Optional[Dict[str, Any]], *, include_rich: bool = True) -> Optional[str]:
    """Who to credit in players that render rich timing alongside line lyrics.

    Whenever lrc.red supplied either the line lyrics or the rendered rich
    timing, returns ``"lrc.red"`` so its attribution link is shown.
    """
    if not has_text(record):
        return None
    if include_rich and parse_rich_synced(record.get("rich_synced")) is not None:
        if record.get("rich_source") in _RICH_LRC_RED_SOURCES:
            return "lrc.red"
    return provider(record)


def record_text(record: Optional[Dict[str, Any]]) -> str:
    """Plain lyric text from a record, used to text-verify enrichment candidates."""
    if not record:
        return ""
    if record.get("plain"):
        return str(record["plain"])
    if record.get("synced"):
        return "\n".join(text for _, text in parse_lrc(record["synced"]) if text)
    return ""


def _text_jaccard(left: str, right: str) -> float:
    a = set(fold_music_text(left).split())
    b = set(fold_music_text(right).split())
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def timing_fits(record: Optional[Dict[str, Any]], audio_duration: Any) -> bool:
    """Whether a record holds timed lines a recording of this length can follow.

    Besides the length the lines were timed against, a line that starts after
    the recording has ended is proof on its own that they belong to another cut.
    """
    synced = record.get("synced") if record else None
    if not synced or not synced_timing_fits(audio_duration, record.get("synced_duration")):
        return False
    try:
        audio = float(audio_duration or 0)
    except (TypeError, ValueError):
        return True
    stamps = parse_lrc(synced)
    return not (audio > 0 and stamps and stamps[-1][0] / 1000 > audio + TIMING_TOLERANCE_SEC)


def rich_timing_fits(rich: Optional[Dict[str, Any]], audio_duration: Any) -> bool:
    """Whether a ``rich_synced`` payload fits a recording of this length."""
    if not rich or not isinstance(rich.get("lines"), list) or not rich["lines"]:
        return False
    if not synced_timing_fits(audio_duration, rich.get("dur")):
        return False
    try:
        audio = float(audio_duration or 0)
    except (TypeError, ValueError):
        return True
    if audio <= 0:
        return True
    last_ms = max((int(line.get("t") or 0) for line in rich["lines"] if isinstance(line, dict)), default=0)
    return last_ms / 1000.0 <= audio + TIMING_TOLERANCE_SEC


def worth_looking_up_again(record: Optional[Dict[str, Any]], audio_duration: Any) -> bool:
    """Lyrics cached by an older resolver that the current one could improve.

    Timed lines that predate their length are looked up so the length can be
    checked; anything without timed lines that fit the recording, because
    lrc.red / NetEase may have them. Lines that already fit are left alone.
    Until the lookup lands, and if it finds nothing, what is held keeps being
    served.
    """
    if not record or record.get("source") in _CURRENT_SOURCES:
        return False
    if record.get("synced") and record.get("source") not in _LENGTH_SOURCES:
        return True
    return not timing_fits(record, audio_duration)


def worth_enriching(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a cached lyrics record should undergo once-only Phase 2 rich enrichment."""
    if not record or record.get("instrumental"):
        return False
    if not (record.get("synced") or record.get("plain")):
        return False
    if record.get("rich_synced") or record.get("rich_source"):
        return False
    return True


def store(db: Any, key: str, record: Dict[str, Any]) -> None:
    """Cache a resolved record under a track id or a metadata key."""
    rich = record.get("rich_synced")
    if isinstance(rich, dict):
        rich = json.dumps(rich, ensure_ascii=False, separators=(",", ":"))
    db.set_lyrics(
        key,
        synced=record["synced"],
        plain=record["plain"],
        instrumental=record["instrumental"],
        source=record["source"],
        synced_duration=record.get("synced_duration"),
        rich_synced=rich,
        rich_source=record.get("rich_source"),
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
    length = held.get("synced_duration") if held.get("source") in _LENGTH_SOURCES else None
    kept = {
        **held,
        "source": RESOLVER_SOURCE,
        "synced_duration": length,
        "rich_synced": held.get("rich_synced"),
        "rich_source": held.get("rich_source"),
    }
    store(db, key, kept)
    return kept


def settle_enrichment(db: Any, key: str, found: Optional[Dict[str, Any]]) -> None:
    """Persist a completed Phase 2 enrichment result without altering line LRC."""
    if found is None:
        return
    rich = found.get("rich_synced")
    if isinstance(rich, dict):
        rich = json.dumps(rich, ensure_ascii=False, separators=(",", ":"))
    db.set_lyrics_enrichment(
        key,
        rich_synced=rich,
        rich_source=found.get("rich_source") or RICH_NONE_SOURCE,
    )


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


def _retry_after_sec(resp: requests.Response) -> float:
    """How long the provider asked to be left alone, within what a listener waits."""
    try:
        wait = float(resp.headers.get("Retry-After") or _LRCLIB_DEFAULT_RETRY_SEC)
    except ValueError:
        # An HTTP-date, which LRCLIB does not send; its own default is a second.
        wait = _LRCLIB_DEFAULT_RETRY_SEC
    return min(max(wait, 0.0), _LRCLIB_MAX_RETRY_WAIT_SEC) + random.uniform(0.0, _LRCLIB_RETRY_JITTER_SEC)


def _lrclib_get(path: str, params: Dict[str, Any], timeout_sec: float = _LRCLIB_TIMEOUT_SEC) -> Optional[Any]:
    # LRCLIB sheds load globally: when its search permits run out it answers
    # 503 "ServerOverloaded" with Retry-After: 1, to everyone at once. Asking
    # again a second later almost always lands, so that wait is spent here,
    # within the same allowance, rather than shown to the listener as an outage.
    # Measured over 260 uncached searches: ~40% were shed, each attempt about
    # as likely as the one before it whatever the wait, so what helps is
    # attempts within the budget. Shorter waits found lines sooner but would
    # multiply the load on a server that has just said it is full.
    deadline = time.monotonic() + timeout_sec
    while True:
        resp = requests.get(
            f"{_LRCLIB_HOST}{path}",
            params=params,
            headers={"User-Agent": _USER_AGENT},
            timeout=_timeout_parts(deadline - time.monotonic(), 1.0),
        )
        if resp.status_code == 404:
            return None
        if resp.status_code in _LRCLIB_RETRY_STATUSES:
            wait = _retry_after_sec(resp)
            if deadline - time.monotonic() - wait >= _LRCLIB_MIN_RETRY_REQUEST_SEC:
                time.sleep(wait)
                continue
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


def _empty_record() -> Dict[str, Any]:
    return {"synced": None, "plain": None, "instrumental": False, "source": RESOLVER_SOURCE}


def _lrclib_lookup(
    artist: str,
    title: str,
    album: Optional[str],
    duration: Optional[int],
    deadline: float,
) -> Dict[str, Any]:
    """LRCLIB's answer for canonical metadata; an empty record when it has none."""
    results = _lrclib_search(artist, title, album, deadline)
    best = _pick_best(results, artist, title, album, duration)
    if best:
        return _result_to_record(best, results)

    # Deezer is deliberately not on the hot path. It only canonicalizes a
    # real LRCLIB miss and has a small timeout, so lyrics cannot monopolize
    # request capacity or interfere with downloader workers.
    if deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
        return _empty_record()

    deezer_rows = _deezer_search(artist, title, _remaining(deadline, _DEEZER_TIMEOUT_SEC))
    deezer_best = _pick_best(deezer_rows, artist, title, album, duration)
    if not deezer_best or deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
        return _empty_record()

    canonical_artist = (deezer_best.get("artist") or {}).get("name") or artist
    canonical_title = deezer_best.get("title_short") or deezer_best.get("title") or title
    canonical_album = (deezer_best.get("album") or {}).get("title") or album
    canonical_duration = deezer_best.get("duration") or duration

    # New duration/album evidence may be enough to select an existing
    # LRCLIB row, without spending another network round trip.
    rescored = _pick_best(results, canonical_artist, canonical_title, canonical_album, canonical_duration)
    if rescored:
        return _result_to_record(rescored, results)

    if fold_music_text(f"{canonical_artist} {canonical_title}") == fold_music_text(f"{artist} {title}"):
        return _empty_record()
    retry_results = _lrclib_search(canonical_artist, canonical_title, canonical_album, deadline)
    retry_best = _pick_best(retry_results, canonical_artist, canonical_title, canonical_album, canonical_duration)
    if retry_best:
        return _result_to_record(retry_best, retry_results)
    return _empty_record()


def _bounded_get(
    url: str,
    params: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    timeout_sec: float,
) -> Optional[requests.Response]:
    resp = requests.get(
        url,
        params=params,
        headers=headers,
        timeout=_timeout_parts(timeout_sec, 1.0),
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    content = getattr(resp, "content", None)
    if isinstance(content, (bytes, bytearray)) and len(content) > _MAX_PROVIDER_BODY_BYTES:
        raise ValueError("Provider response exceeds size cap")
    return resp


def _lrc_red_get(path: str, params: Optional[Dict[str, Any]], timeout_sec: float) -> Optional[requests.Response]:
    return _bounded_get(
        f"{_LRC_RED_HOST}{path}",
        params,
        {"User-Agent": _LRC_RED_USER_AGENT},
        timeout_sec,
    )


def _netease_get(path: str, params: Optional[Dict[str, Any]], timeout_sec: float) -> Optional[requests.Response]:
    return _bounded_get(
        f"{_NETEASE_HOST}{path}",
        params,
        {"User-Agent": _USER_AGENT, "Referer": f"{_NETEASE_HOST}/"},
        timeout_sec,
    )


def _lyricsplus_get(params: Dict[str, Any], timeout_sec: float) -> Optional[requests.Response]:
    return _bounded_get(
        f"{_LYRICSPLUS_HOST}/v2/lyrics/get",
        params,
        {"User-Agent": _USER_AGENT},
        timeout_sec,
    )


def _screen_hit(
    artist: str,
    title: str,
    duration: Optional[int],
    cand_artist: Any,
    cand_title: Any,
    cand_duration: Any,
) -> Optional[float]:
    """Return combined title+artist similarity if a candidate passes identity
    and duration screening, or ``None``."""
    title_score = _similarity(title, cand_title)
    if title_score < _LRC_RED_MIN_TITLE:
        return None
    artist_names = cand_artist if isinstance(cand_artist, list) else [cand_artist]
    artist_score = max((_similarity(artist, name) for name in artist_names if name), default=0.0)
    if (
        artist_score < _LRC_RED_MIN_ARTIST
        or _version_tokens(title) != _version_tokens(cand_title)
        or not synced_timing_fits(duration, cand_duration)
    ):
        return None
    return title_score + artist_score


def _lrc_red_hit(hits: Any, artist: str, title: str, duration: Optional[int]) -> Optional[Dict[str, Any]]:
    """Best matching lrc.red search hit; manual timing ranks ahead of ``byModel``."""
    ranked: list[tuple[bool, float, Dict[str, Any]]] = []
    for hit in hits if isinstance(hits, list) else []:
        if not isinstance(hit, dict) or not _ISRC_RE.match(str(hit.get("isrc") or "")):
            continue
        score = _screen_hit(artist, title, duration, hit.get("artist"), hit.get("title"), hit.get("duration"))
        if score is not None:
            ranked.append((not bool(hit.get("byModel")), score, hit))
    return max(ranked, key=lambda row: (row[0], row[1]))[2] if ranked else None


def _lrc_red_lookup(
    artist: str,
    title: str,
    duration: Optional[int],
    deadline: float,
    *,
    require_rich: bool = False,
) -> Optional[Dict[str, Any]]:
    """lrc.red's timed lines (and optional syllable/word TTML) for this recording."""
    found = _lrc_red_get("/search.json", {"q": f"{title} {artist}"}, _remaining(deadline, _LRC_RED_TIMEOUT_SEC))
    payload = found.json() if found is not None else None
    hit = _lrc_red_hit(payload.get("hits") if isinstance(payload, dict) else None, artist, title, duration)
    if not hit or deadline - time.monotonic() < 0.2:
        return None
    body = _lrc_red_get(f"/s/{hit['isrc']}.ttml", None, _remaining(deadline, _LRC_RED_TIMEOUT_SEC))
    if body is None:
        return None
    try:
        length = int(round(float(hit.get("duration")))) or None
    except (TypeError, ValueError):
        length = None
    synced, plain, rich_synced = parse_ttml(body.text, duration=length)
    if not synced or (require_rich and rich_synced is None):
        return None
    rich_source = (RICH_LRC_RED_AI_SOURCE if hit.get("byModel") else RICH_LRC_RED_SOURCE) if rich_synced else None
    record = {
        "synced": synced,
        "plain": plain,
        "instrumental": False,
        "source": LRC_RED_SOURCE,
        "synced_duration": length,
        "rich_synced": rich_synced,
        "rich_source": rich_source,
    }
    return record if timing_fits(record, duration) else None


def _netease_lookup(
    artist: str,
    title: str,
    duration: Optional[int],
    deadline: float,
    *,
    require_rich: bool = False,
) -> Optional[Dict[str, Any]]:
    """NetEase Cloud Music YRC (word-timed) and LRC fallback, identity-screened."""
    search = _netease_get(
        "/api/search/get",
        {"s": f"{title} {artist}", "type": 1, "limit": 5},
        _remaining(deadline, _NETEASE_TIMEOUT_SEC),
    )
    data = search.json() if search is not None else None
    songs = (data.get("result") or {}).get("songs") if isinstance(data, dict) and data.get("code") == 200 and isinstance(data.get("result"), dict) else None
    ranked: list[tuple[float, Dict[str, Any], Optional[int]]] = []
    for song in songs if isinstance(songs, list) else []:
        if not isinstance(song, dict) or not song.get("id"):
            continue
        names = [str(a.get("name") or "") for a in (song.get("artists") or []) if isinstance(a, dict)]
        try:
            dur_ms = float(song.get("duration") or 0)
            dur_sec = int(round(dur_ms / 1000.0)) if dur_ms > 0 else None
        except (TypeError, ValueError):
            dur_sec = None
        score = _screen_hit(artist, title, duration, [", ".join(names)] + names, song.get("name"), dur_sec)
        if score is not None:
            ranked.append((score, song, dur_sec))
    if not ranked or deadline - time.monotonic() < 0.2:
        return None
    _, song, dur_sec = max(ranked, key=lambda row: row[0])
    lyric_resp = _netease_get(
        "/api/song/lyric",
        {"id": song["id"], "lv": 1, "yv": 1, "tv": 0},
        _remaining(deadline, _NETEASE_TIMEOUT_SEC),
    )
    lyric_data = lyric_resp.json() if lyric_resp is not None else None
    if not isinstance(lyric_data, dict) or lyric_data.get("code") != 200 or lyric_data.get("nolyric"):
        return None

    yrc_text = ((lyric_data.get("yrc") or {}).get("lyric") or "") if isinstance(lyric_data.get("yrc"), dict) else ""
    if yrc_text.strip():
        synced, plain, rich_synced = parse_yrc(yrc_text, duration=dur_sec)
        if synced and (rich_synced is not None or not require_rich):
            record = {
                "synced": synced,
                "plain": plain,
                "instrumental": False,
                "source": NETEASE_SOURCE,
                "synced_duration": dur_sec,
                "rich_synced": rich_synced,
                "rich_source": RICH_NETEASE_SOURCE if rich_synced is not None else None,
            }
            if timing_fits(record, duration):
                return record

    if require_rich:
        return None

    lrc_raw = ((lyric_data.get("lrc") or {}).get("lyric") or "") if isinstance(lyric_data.get("lrc"), dict) else ""
    synced_lrc = strip_netease_lrc_credits(lrc_raw)
    stamps = parse_lrc(synced_lrc) if synced_lrc else []
    if not stamps:
        return None
    record = {
        "synced": synced_lrc,
        "plain": "\n".join(text for _, text in stamps if text) or None,
        "instrumental": False,
        "source": NETEASE_SOURCE,
        "synced_duration": dur_sec,
        "rich_synced": None,
        "rich_source": None,
    }
    return record if timing_fits(record, duration) else None


def _lyricsplus_lookup(
    artist: str,
    title: str,
    album: Optional[str],
    duration: Optional[int],
    reference_text: str,
    deadline: float,
) -> Optional[Dict[str, Any]]:
    """Best-effort LyricsPlus enrichment, accepted ONLY when text-verified
    against ``reference_text`` (token Jaccard >= 0.60) and duration-compatible."""
    if not reference_text or deadline - time.monotonic() < 0.3:
        return None
    params: Dict[str, Any] = {"title": title, "artist": artist}
    if album:
        params["album"] = album
    if duration:
        params["duration"] = int(round(float(duration)))
    resp = _lyricsplus_get(params, _remaining(deadline, _LYRICSPLUS_TIMEOUT_SEC))
    if resp is None:
        return None
    plain, rich_synced = parse_lyricsplus(resp.json())
    if not plain or rich_synced is None or not rich_timing_fits(rich_synced, duration):
        return None
    if _text_jaccard(plain, reference_text) < _LYRICSPLUS_MIN_JACCARD:
        return None
    return {"rich_synced": rich_synced, "rich_source": RICH_LYRICSPLUS_SOURCE}


def fetch_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Phase 1 fast lyrics resolution without using downloader queues or workers.

    Order: LRCLIB (with Deezer metadata fallback) -> lrc.red TTML -> NetEase.
    Returns an empty record for a confident provider-level not-found response,
    or ``None`` for network/provider errors so callers do not negative-cache a
    transient outage.
    """
    if not artist or not title:
        return None

    deadline = time.monotonic() + _TOTAL_BUDGET_SEC
    clean_artist, clean_title = _canonical_metadata(artist, title)
    record: Optional[Dict[str, Any]] = None
    try:
        record = _lrclib_lookup(clean_artist, clean_title, album, duration, deadline)
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        logger.warning("Lyrics provider failed for %s - %s: %s", artist, title, exc)
    if timing_fits(record, duration) or deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
        return record

    for name, min_budget, fn in (
        ("lrc.red", _MIN_FALLBACK_BUDGET_SEC, _lrc_red_lookup),
        ("NetEase", _MIN_NETEASE_FALLBACK_BUDGET_SEC, _netease_lookup),
    ):
        if deadline - time.monotonic() < min_budget:
            break
        try:
            hit = fn(clean_artist, clean_title, duration, deadline)
            if hit is not None:
                return hit
        except (requests.RequestException, ValueError, KeyError, TypeError, ET.ParseError) as exc:
            logger.warning("%s fallback failed for %s - %s: %s", name, artist, title, exc)
    return record


def enrich_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
    *,
    reference_text: str = "",
    existing_source: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Phase 2 non-blocking enrichment for word/syllable timing.

    Hierarchy: lrc.red TTML (manual preferred, AI ``byModel`` accepted) ->
    NetEase YRC -> LyricsPlus (strictly text-verified via Jaccard >= 0.60).
    Returns ``None`` only when every attempted provider suffered a transport
    failure so callers can retry on a later play.
    """
    if not artist or not title:
        return None
    deadline = time.monotonic() + _ENRICH_BUDGET_SEC
    clean_artist, clean_title = _canonical_metadata(artist, title)
    clean_response = False

    def try_lrc_red():
        hit = _lrc_red_lookup(clean_artist, clean_title, duration, deadline, require_rich=True)
        if not hit or not hit.get("rich_synced"):
            return None
        if reference_text and _text_jaccard(hit.get("plain") or "", reference_text) < _LRC_RED_ENRICH_MIN_JACCARD:
            return None
        return {"rich_synced": hit["rich_synced"], "rich_source": hit["rich_source"]}

    def try_netease():
        hit = _netease_lookup(clean_artist, clean_title, duration, deadline, require_rich=True)
        if not hit or not hit.get("rich_synced"):
            return None
        return {"rich_synced": hit["rich_synced"], "rich_source": hit["rich_source"] or RICH_NETEASE_SOURCE}

    def try_lyricsplus():
        return _lyricsplus_lookup(clean_artist, clean_title, album, duration, reference_text, deadline)

    steps = []
    if existing_source != LRC_RED_SOURCE:
        steps.append(("lrc.red", try_lrc_red))
    if existing_source != NETEASE_SOURCE:
        steps.append(("NetEase", try_netease))
    if reference_text:
        steps.append(("LyricsPlus", try_lyricsplus))

    for name, step in steps:
        if deadline - time.monotonic() < 0.5:
            break
        try:
            result = step()
            clean_response = True
            if result and result.get("rich_synced"):
                return result
        except (requests.RequestException, ValueError, KeyError, TypeError, ET.ParseError) as exc:
            logger.debug("%s enrichment failed for %s - %s: %s", name, artist, title, exc)

    return {"rich_synced": None, "rich_source": RICH_NONE_SOURCE} if clean_response else None


class _LyricsLookupCoordinator:
    """Bounded dedicated workers, single-flight keys, and deliberately no queue."""

    def __init__(self, workers: int = _LOOKUP_WORKERS, prefix: str = "soundsible-lyrics") -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=prefix)
        self._slots = threading.BoundedSemaphore(workers)
        self._lock = threading.Lock()
        self._jobs: dict[str, Future] = {}

    def _run(self, fn):
        try:
            return fn()
        finally:
            self._slots.release()

    def poll_or_start(
        self, key: str, fn, *, forget_when_done: bool = False, needed: Optional[Callable[[], bool]] = None,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
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

            if needed is not None and not needed():
                return "settled", None
            if not self._slots.acquire(blocking=False):
                return "busy", None
            try:
                future = self._executor.submit(self._run, fn)
            except Exception:
                self._slots.release()
                raise
            self._jobs[key] = future
        if forget_when_done:
            future.add_done_callback(partial(self._forget, key))
        return "pending", None

    def _forget(self, key: str, future: Future) -> None:
        with self._lock:
            if self._jobs.get(key) is future:
                del self._jobs[key]

    def clear_for_tests(self) -> None:
        with self._lock:
            self._jobs.clear()


_LOOKUPS = _LyricsLookupCoordinator(_LOOKUP_WORKERS, "soundsible-lyrics")
_ENRICHMENTS = _LyricsLookupCoordinator(_ENRICH_WORKERS, "soundsible-lyrics-enrich")


def _lookup_key(artist: str, title: str, album: Optional[str], duration: Optional[int]) -> str:
    clean_artist, clean_title = _canonical_metadata(artist, title)
    return "\x00".join(
        (
            RESOLVER_SOURCE,
            fold_music_text(clean_artist),
            fold_music_text(clean_title),
            fold_music_text(album),
            str(int(duration or 0)),
        )
    )


def metadata_cache_key(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
) -> str:
    """Stable, opaque cache identity for a metadata-only streaming track."""
    digest = hashlib.sha256(_lookup_key(artist, title, album, duration).encode("utf-8")).hexdigest()
    return f"metadata-lyrics:{digest}"


def _poll(
    coordinator: _LyricsLookupCoordinator,
    key: str,
    lookup: Callable[[], Optional[Dict[str, Any]]],
    on_complete: Optional[Callable[[Optional[Dict[str, Any]]], Any]] = None,
    needed: Optional[Callable[[], bool]] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    if on_complete is None:
        return coordinator.poll_or_start(key, lookup, needed=needed)

    def run_and_report():
        result = lookup()
        try:
            on_complete(result)
        except Exception as exc:
            logger.warning("Lyrics completion callback failed: %s", exc)
        return result

    return coordinator.poll_or_start(key, run_and_report, forget_when_done=True, needed=needed)


def poll_lyrics(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
    on_complete: Optional[Callable[[Optional[Dict[str, Any]]], Any]] = None,
    needed: Optional[Callable[[], bool]] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Poll/start a bounded Phase 1 background lookup."""
    return _poll(
        _LOOKUPS,
        _lookup_key(artist, title, album, duration),
        partial(fetch_lyrics, artist, title, album, duration),
        on_complete,
        needed,
    )


def poll_enrichment(
    artist: str,
    title: str,
    album: Optional[str] = None,
    duration: Optional[int] = None,
    *,
    reference_text: str = "",
    existing_source: Optional[str] = None,
    on_complete: Optional[Callable[[Optional[Dict[str, Any]]], Any]] = None,
    needed: Optional[Callable[[], bool]] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Poll/start a bounded Phase 2 background rich-timing enrichment."""
    return _poll(
        _ENRICHMENTS,
        f"enrich:v1\x00{_lookup_key(artist, title, album, duration)}",
        partial(
            enrich_lyrics,
            artist,
            title,
            album,
            duration,
            reference_text=reference_text,
            existing_source=existing_source,
        ),
        on_complete,
        needed,
    )


def _reset_lyrics_jobs_for_tests() -> None:
    _LOOKUPS.clear_for_tests()
    _ENRICHMENTS.clear_for_tests()
