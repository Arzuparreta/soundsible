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
import math
import random
import re
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import Future, ThreadPoolExecutor
from difflib import SequenceMatcher
from functools import partial
from statistics import median
from typing import Any, Callable, Dict, Optional

import requests

from shared.music_identity import canonical_music_identity

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

_SPACE_RE = re.compile(r"\s+")
_ALNUM_RE = re.compile(r"[\w]", re.UNICODE)
_NETEASE_CREDIT_RE = re.compile(
    r"^\s*(作词|作曲|编曲|制作人|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|词|曲|监制|出品|统筹|策划|宣传|发行)\s*[:：]"
)
_YRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_YRC_SEG_RE = re.compile(r"\((\d+),(\d+),\d+\)([^(]*)")
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


def parse_rich_synced(value: Any) -> Optional[Dict[str, Any]]:
    """Decode a stored ``rich_synced`` JSON string or pass through a valid dict."""
    if not value:
        return None
    if isinstance(value, dict):
        data = value
    elif isinstance(value, str):
        try:
            data = json.loads(value)
        except (ValueError, TypeError):
            return None
    else:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("lines"), list) or not data["lines"]:
        return None
    return data


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
    a = set(_fold(left).split())
    b = set(_fold(right).split())
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

    if _fold(f"{canonical_artist} {canonical_title}") == _fold(f"{artist} {title}"):
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


def _lrc_red_hit(hits: Any, artist: str, title: str, duration: Optional[int]) -> Optional[Dict[str, Any]]:
    """The search hit that is this song, recorded at this length.

    Both hand-timed and AI-aligned (``byModel``) hits are accepted; manual hits
    rank strictly ahead of ``byModel`` hits when both match the recording.
    """
    ranked: list[tuple[bool, float, Dict[str, Any]]] = []
    for hit in hits if isinstance(hits, list) else []:
        if not isinstance(hit, dict) or not _ISRC_RE.match(str(hit.get("isrc") or "")):
            continue
        title_score = _similarity(title, hit.get("title"))
        artist_score = _similarity(artist, hit.get("artist"))
        if (
            title_score < _LRC_RED_MIN_TITLE
            or artist_score < _LRC_RED_MIN_ARTIST
            or _version_tokens(title) != _version_tokens(hit.get("title"))
            or not synced_timing_fits(duration, hit.get("duration"))
        ):
            continue
        ranked.append((not bool(hit.get("byModel")), title_score + artist_score, hit))
    return max(ranked, key=lambda row: (row[0], row[1]))[2] if ranked else None


_WORD_STAMP = re.compile(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>")


def _line_lrc(text: str) -> list[str]:
    """Enhanced LRC as plain line LRC: the timed lines, without word stamps."""
    lines = []
    for raw in str(text or "").splitlines():
        stamps = list(_LRC_TIMESTAMP.finditer(raw))
        if not stamps or stamps[0].start() != 0:
            continue
        head = raw[: stamps[-1].end()]
        words = _SPACE_RE.sub(" ", _WORD_STAMP.sub("", raw[stamps[-1].end():])).strip()
        lines.append(f"{head}{words}")
    return lines


def _stamp_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("ms"):
        sec = float(text[:-2]) / 1000.0
    else:
        if text.endswith("s"):
            text = text[:-1]
        parts = text.split(":")
        if len(parts) > 3:
            raise ValueError("Unsupported timestamp")
        sec = sum(float(part) * (60 ** power) for power, part in enumerate(reversed(parts)))
    if not math.isfinite(sec) or sec < 0:
        raise ValueError("Invalid timestamp")
    return int(round(sec * 1000))


def _format_lrc_stamp(ms: int) -> str:
    total_cs = max(0, int(round(ms / 10.0)))
    minutes, rem = divmod(total_cs, 6000)
    seconds, centis = divmod(rem, 100)
    return f"[{minutes:02d}:{seconds:02d}.{centis:02d}]"


def _has_alnum(text: str) -> bool:
    return bool(_ALNUM_RE.search(text or ""))


def _classify_segments(lines: list[Dict[str, Any]]) -> str:
    """Return ``"syllable"``, ``"word"``, or ``"line"`` from structured lines."""
    word_segments = 0
    syllable_splits = 0
    for line in lines:
        segs = line.get("s") or []
        unique_times = {(seg["t"], seg["e"]) for seg in segs}
        if len(unique_times) >= 2:
            word_segments += len(segs)
            for idx in range(len(segs) - 1):
                t1 = segs[idx]["x"]
                t2 = segs[idx + 1]["x"]
                if (
                    t1
                    and t2
                    and not t1[-1].isspace()
                    and not t2[0].isspace()
                    and _has_alnum(t1)
                    and _has_alnum(t2)
                ):
                    syllable_splits += 1
    if syllable_splits >= 2:
        return "syllable"
    if word_segments > 0:
        return "word"
    return "line"


def _parse_ttml(body: str, duration: Optional[int] = None) -> tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """Parse TTML into ``(line_lrc, plain_text, rich_synced_or_none)``.

    Preserves syllable splits (adjacent timed ``<span>`` tags with no intervening
    whitespace) and separates ``ttm:role="x-bg"`` background vocals into their
    own lines while skipping translations and romanizations.
    """
    raw = str(body or "")
    if not raw.strip():
        return None, None, None
    upper = raw.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        raise ValueError("Unsafe XML declaration")
    root = ET.fromstring(raw)

    lrc_lines: list[str] = []
    plain_lines: list[str] = []
    rich_lines: list[Dict[str, Any]] = []

    def collect_spans(parent: ET.Element, target: list[tuple[int, int, str, str]], bg_targets: list[list[tuple[int, int, str, str]]]) -> None:
        for child in parent:
            tag = child.tag.rsplit("}", 1)[-1]
            if tag != "span":
                continue
            role = next((v for k, v in child.attrib.items() if k.endswith("role")), None)
            if role in {"x-translation", "x-roman"}:
                continue
            if role == "x-bg":
                bg_spans: list[tuple[int, int, str, str]] = []
                collect_spans(child, bg_spans, [])
                if bg_spans:
                    bg_targets.append(bg_spans)
                else:
                    b_bg = _stamp_ms(child.get("begin"))
                    e_bg = _stamp_ms(child.get("end"))
                    txt_bg = _SPACE_RE.sub(" ", "".join(child.itertext())).strip()
                    if b_bg is not None and txt_bg:
                        bg_targets.append([(b_bg, e_bg if (e_bg is not None and e_bg > b_bg) else b_bg + 2000, txt_bg, "")])
                continue
            b_ms = _stamp_ms(child.get("begin"))
            e_ms = _stamp_ms(child.get("end"))
            if b_ms is not None and e_ms is not None:
                txt = "".join(child.itertext())
                if txt.strip():
                    target.append((b_ms, max(e_ms, b_ms), txt, child.tail or ""))
            else:
                collect_spans(child, target, bg_targets)

    def spans_to_segments(spans: list[tuple[int, int, str, str]]) -> list[Dict[str, Any]]:
        segs: list[Dict[str, Any]] = []
        for idx, (b_ms, e_ms, txt, tail) in enumerate(spans):
            has_gap = bool(tail and tail.strip() == "") or (tail != "" and tail[:1].isspace())
            clean = _SPACE_RE.sub(" ", txt)
            if idx == 0:
                clean = clean.lstrip()
            if idx < len(spans) - 1 and has_gap and not clean.endswith(" "):
                clean += " "
            elif idx == len(spans) - 1:
                clean = clean.rstrip()
            if clean:
                segs.append({"t": b_ms, "e": max(e_ms, b_ms), "x": clean})
        return segs

    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "p":
            continue
        p_begin = _stamp_ms(element.get("begin"))
        p_end = _stamp_ms(element.get("end"))
        main_spans: list[tuple[int, int, str, str]] = []
        bg_groups: list[list[tuple[int, int, str, str]]] = []
        collect_spans(element, main_spans, bg_groups)

        if main_spans:
            segs = spans_to_segments(main_spans)
            line_text = _SPACE_RE.sub(" ", "".join(seg["x"] for seg in segs)).strip()
            line_start = p_begin if p_begin is not None else segs[0]["t"]
            line_end = p_end if (p_end is not None and p_end >= line_start) else max(seg["e"] for seg in segs)
            if line_text:
                lrc_lines.append(f"{_format_lrc_stamp(line_start)}{line_text}")
                plain_lines.append(line_text)
                rich_lines.append({"t": line_start, "e": max(line_end, line_start), "s": segs})
        else:
            # Line-only <p> (skip x-translation/x-roman text if nested).
            parts: list[str] = []
            if element.text:
                parts.append(element.text)
            for child in element:
                role = next((v for k, v in child.attrib.items() if k.endswith("role")), None)
                if role not in {"x-translation", "x-roman", "x-bg"}:
                    parts.append("".join(child.itertext()))
                if child.tail:
                    parts.append(child.tail)
            line_text = _SPACE_RE.sub(" ", "".join(parts)).strip()
            if p_begin is not None and line_text:
                line_end = p_end if (p_end is not None and p_end >= p_begin) else p_begin + 3000
                lrc_lines.append(f"{_format_lrc_stamp(p_begin)}{line_text}")
                plain_lines.append(line_text)
                rich_lines.append({"t": p_begin, "e": line_end, "s": [{"t": p_begin, "e": line_end, "x": line_text}]})
            elif line_text:
                plain_lines.append(line_text)

        for bg_spans in bg_groups:
            bg_segs = spans_to_segments(bg_spans)
            bg_text = _SPACE_RE.sub(" ", "".join(seg["x"] for seg in bg_segs)).strip()
            if bg_segs and bg_text:
                rich_lines.append({
                    "t": bg_segs[0]["t"],
                    "e": max(seg["e"] for seg in bg_segs),
                    "bg": True,
                    "s": bg_segs,
                })

    if not lrc_lines:
        return None, ("\n".join(plain_lines) or None), None

    rich_lines.sort(key=lambda item: (item["t"], 1 if item.get("bg") else 0))
    granularity = _classify_segments(rich_lines)
    rich_synced: Optional[Dict[str, Any]] = None
    if granularity in {"syllable", "word"}:
        rich_synced = {"granularity": granularity, "lines": rich_lines}
        if duration:
            rich_synced["dur"] = int(duration)
    return "\n".join(lrc_lines), ("\n".join(plain_lines) or None), rich_synced


def _parse_yrc(body: str, duration: Optional[int] = None) -> tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """Parse NetEase YRC into ``(line_lrc, plain_text, rich_synced_or_none)``."""
    lrc_lines: list[str] = []
    plain_lines: list[str] = []
    rich_lines: list[Dict[str, Any]] = []

    for raw in str(body or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("{"):
            continue
        match = _YRC_LINE_RE.match(line)
        if not match:
            continue
        line_start = int(match.group(1))
        line_dur = int(match.group(2))
        segs_raw = list(_YRC_SEG_RE.finditer(match.group(3)))
        if not segs_raw:
            continue
        plain_line = _SPACE_RE.sub(" ", "".join(m.group(3) for m in segs_raw)).strip()
        if not plain_line or _NETEASE_CREDIT_RE.match(plain_line):
            continue
        segs: list[Dict[str, Any]] = []
        for idx, seg_m in enumerate(segs_raw):
            seg_start = int(seg_m.group(1))
            seg_dur = int(seg_m.group(2))
            seg_text = seg_m.group(3)
            if not seg_text:
                continue
            if idx == 0:
                seg_text = seg_text.lstrip()
            if idx == len(segs_raw) - 1:
                seg_text = seg_text.rstrip()
            if seg_text:
                segs.append({"t": seg_start, "e": seg_start + max(seg_dur, 0), "x": seg_text})
        if not segs:
            continue
        lrc_lines.append(f"{_format_lrc_stamp(line_start)}{plain_line}")
        plain_lines.append(plain_line)
        rich_lines.append({
            "t": line_start,
            "e": max(line_start + line_dur, segs[-1]["e"]),
            "s": segs,
        })

    if not lrc_lines:
        return None, None, None

    rich_lines.sort(key=lambda item: item["t"])
    granularity = _classify_segments(rich_lines)
    rich_synced: Optional[Dict[str, Any]] = None
    if granularity in {"syllable", "word"}:
        rich_synced = {"granularity": granularity, "lines": rich_lines}
        if duration:
            rich_synced["dur"] = int(duration)
    return "\n".join(lrc_lines), ("\n".join(plain_lines) or None), rich_synced


def _parse_lyricsplus(payload: Any) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Parse LyricsPlus JSON into ``(plain_text, rich_synced_or_none)``."""
    if not isinstance(payload, dict):
        return None, None
    raw_lines = payload.get("lyrics")
    if not isinstance(raw_lines, list) or not raw_lines:
        return None, None

    plain_lines: list[str] = []
    rich_lines: list[Dict[str, Any]] = []
    for entry in raw_lines:
        if not isinstance(entry, dict):
            continue
        line_text = _SPACE_RE.sub(" ", str(entry.get("text") or "")).strip()
        if not line_text:
            continue
        t_ms = entry.get("time")
        dur_ms = entry.get("duration")
        if not isinstance(t_ms, (int, float)) or t_ms < 0:
            continue
        line_start = int(round(t_ms))
        line_end = line_start + int(round(dur_ms)) if isinstance(dur_ms, (int, float)) and dur_ms > 0 else line_start + 3000
        plain_lines.append(line_text)
        raw_syls = [s for s in (entry.get("syllabus") or []) if isinstance(s, dict) and s.get("text")]
        segs: list[Dict[str, Any]] = []
        for idx, syl in enumerate(raw_syls):
            st = syl.get("time")
            sd = syl.get("duration")
            sx = str(syl.get("text") or "")
            if not isinstance(st, (int, float)) or st < 0 or not sx:
                continue
            if idx == 0:
                sx = sx.lstrip()
            if idx == len(raw_syls) - 1:
                sx = sx.rstrip()
            if sx:
                s_start = int(round(st))
                s_end = s_start + (int(round(sd)) if isinstance(sd, (int, float)) and sd > 0 else 0)
                segs.append({"t": s_start, "e": max(s_end, s_start), "x": sx})
        if not segs:
            segs = [{"t": line_start, "e": line_end, "x": line_text}]
        bg = bool((entry.get("element") or {}).get("isBackground")) if isinstance(entry.get("element"), dict) else False
        item: Dict[str, Any] = {
            "t": line_start,
            "e": max(line_end, segs[-1]["e"]),
            "s": segs,
        }
        if bg:
            item["bg"] = True
        rich_lines.append(item)

    if len(rich_lines) < 2:
        return None, None

    granularity = _classify_segments(rich_lines)
    if granularity not in {"syllable", "word"}:
        return "\n".join(plain_lines), None

    meta = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    total_dur: Optional[int] = None
    if meta.get("totalDuration"):
        try:
            ms = _stamp_ms(meta["totalDuration"])
            if ms and ms > 0:
                total_dur = int(round(ms / 1000.0))
        except ValueError:
            total_dur = None

    rich_synced: Dict[str, Any] = {"granularity": granularity, "lines": rich_lines}
    if total_dur:
        rich_synced["dur"] = total_dur
    return "\n".join(plain_lines), rich_synced


def _lrc_red_lookup(
    artist: str,
    title: str,
    duration: Optional[int],
    deadline: float,
    *,
    require_rich: bool = False,
) -> Optional[Dict[str, Any]]:
    """lrc.red's timed lines (and optional syllable/word TTML) for this recording."""
    found = _lrc_red_get(
        "/search.json",
        {"q": f"{title} {artist}"},
        _remaining(deadline, _LRC_RED_TIMEOUT_SEC),
    )
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
    synced, plain, rich_synced = _parse_ttml(body.text, duration=length)
    if not synced:
        return None
    if require_rich and rich_synced is None:
        return None
    rich_source = (
        (RICH_LRC_RED_AI_SOURCE if hit.get("byModel") else RICH_LRC_RED_SOURCE)
        if rich_synced is not None
        else None
    )
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


def _netease_hit(songs: Any, artist: str, title: str, duration: Optional[int]) -> Optional[tuple[Dict[str, Any], Optional[int]]]:
    ranked: list[tuple[float, Dict[str, Any], Optional[int]]] = []
    for song in songs if isinstance(songs, list) else []:
        if not isinstance(song, dict) or not song.get("id"):
            continue
        cand_title = str(song.get("name") or "")
        artist_names = [str(a.get("name") or "") for a in (song.get("artists") or []) if isinstance(a, dict)]
        artist_score = max(
            (_similarity(artist, cand) for cand in ([", ".join(artist_names)] + artist_names) if cand),
            default=0.0,
        )
        title_score = _similarity(title, cand_title)
        try:
            dur_ms = float(song.get("duration") or 0)
            dur_sec = int(round(dur_ms / 1000.0)) if dur_ms > 0 else None
        except (TypeError, ValueError):
            dur_sec = None
        if (
            title_score < _LRC_RED_MIN_TITLE
            or artist_score < _LRC_RED_MIN_ARTIST
            or _version_tokens(title) != _version_tokens(cand_title)
            or not synced_timing_fits(duration, dur_sec)
        ):
            continue
        ranked.append((title_score + artist_score, song, dur_sec))
    if not ranked:
        return None
    _, best, dur_sec = max(ranked, key=lambda row: row[0])
    return best, dur_sec


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
    if search is None:
        return None
    data = search.json()
    if not isinstance(data, dict) or data.get("code") != 200:
        return None
    songs = (data.get("result") or {}).get("songs") if isinstance(data.get("result"), dict) else None
    matched = _netease_hit(songs, artist, title, duration)
    if not matched or deadline - time.monotonic() < 0.2:
        return None
    song, dur_sec = matched
    lyric_resp = _netease_get(
        "/api/song/lyric",
        {"id": song["id"], "lv": 1, "yv": 1, "tv": 0},
        _remaining(deadline, _NETEASE_TIMEOUT_SEC),
    )
    if lyric_resp is None:
        return None
    lyric_data = lyric_resp.json()
    if not isinstance(lyric_data, dict) or lyric_data.get("code") != 200 or lyric_data.get("nolyric"):
        return None

    yrc_text = ((lyric_data.get("yrc") or {}).get("lyric") or "") if isinstance(lyric_data.get("yrc"), dict) else ""
    if yrc_text.strip():
        synced, plain, rich_synced = _parse_yrc(yrc_text, duration=dur_sec)
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

    lrc_text = ((lyric_data.get("lrc") or {}).get("lyric") or "") if isinstance(lyric_data.get("lrc"), dict) else ""
    if not lrc_text.strip():
        return None
    filtered_lines = []
    for raw in lrc_text.splitlines():
        stamps = list(_LRC_TIMESTAMP.finditer(raw))
        if not stamps:
            continue
        content = raw[stamps[-1].end():].strip()
        if not content or _NETEASE_CREDIT_RE.match(content):
            continue
        filtered_lines.append(raw)
    if not filtered_lines:
        return None
    synced_lrc = "\n".join(filtered_lines)
    stamps = parse_lrc(synced_lrc)
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
    plain, rich_synced = _parse_lyricsplus(resp.json())
    if not plain or rich_synced is None:
        return None
    if not rich_timing_fits(rich_synced, duration):
        return None
    if _text_jaccard(plain, reference_text) < _LYRICSPLUS_MIN_JACCARD:
        return None
    return {
        "rich_synced": rich_synced,
        "rich_source": RICH_LYRICSPLUS_SOURCE,
    }


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
    record: Optional[Dict[str, Any]]
    try:
        record = _lrclib_lookup(clean_artist, clean_title, album, duration, deadline)
    except requests.RequestException as exc:
        logger.warning("Lyrics provider request failed for %s - %s: %s", artist, title, exc)
        record = None
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("Lyrics response parse error for %s - %s: %s", artist, title, exc)
        record = None
    if timing_fits(record, duration) or deadline - time.monotonic() < _MIN_FALLBACK_BUDGET_SEC:
        return record

    # LRCLIB's lines stay the answer unless lrc.red has timed lines that fit;
    # when LRCLIB could not be reached, lrc.red's are better than an outage.
    try:
        lrc_red_record = _lrc_red_lookup(clean_artist, clean_title, duration, deadline)
        if lrc_red_record is not None:
            return lrc_red_record
    except requests.RequestException as exc:
        logger.warning("lrc.red request failed for %s - %s: %s", artist, title, exc)
    except (ValueError, KeyError, TypeError, ET.ParseError) as exc:
        logger.warning("lrc.red response parse error for %s - %s: %s", artist, title, exc)

    if deadline - time.monotonic() < _MIN_NETEASE_FALLBACK_BUDGET_SEC:
        return record

    # Third fallback when both LRCLIB and lrc.red lacked fitting timed lines.
    try:
        netease_record = _netease_lookup(clean_artist, clean_title, duration, deadline)
        if netease_record is not None:
            return netease_record
    except requests.RequestException as exc:
        logger.warning("NetEase request failed for %s - %s: %s", artist, title, exc)
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("NetEase response parse error for %s - %s: %s", artist, title, exc)
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

    Hierarchy:
      1. lrc.red TTML (manual preferred, AI ``byModel`` accepted)
      2. NetEase YRC (identity- and duration-verified)
      3. LyricsPlus (Apple/QQ aggregator — strictly text-verified via Jaccard >= 0.60)

    Returns ``{"rich_synced": dict|None, "rich_source": str}`` on a clean check,
    or ``None`` if every attempted provider suffered a transport/network failure.
    """
    if not artist or not title:
        return None
    deadline = time.monotonic() + _ENRICH_BUDGET_SEC
    clean_artist, clean_title = _canonical_metadata(artist, title)
    clean_response = False

    # 1. lrc.red TTML (skip if Phase 1 already resolved via lrc.red).
    if existing_source != LRC_RED_SOURCE and deadline - time.monotonic() >= 0.5:
        try:
            hit = _lrc_red_lookup(clean_artist, clean_title, duration, deadline, require_rich=True)
            clean_response = True
            if hit and hit.get("rich_synced"):
                cand_text = hit.get("plain") or ""
                if not reference_text or _text_jaccard(cand_text, reference_text) >= _LRC_RED_ENRICH_MIN_JACCARD:
                    return {
                        "rich_synced": hit["rich_synced"],
                        "rich_source": hit["rich_source"],
                    }
        except requests.RequestException as exc:
            logger.debug("lrc.red enrichment request failed for %s - %s: %s", artist, title, exc)
        except (ValueError, KeyError, TypeError, ET.ParseError) as exc:
            logger.debug("lrc.red enrichment parse error for %s - %s: %s", artist, title, exc)

    # 2. NetEase YRC (skip if Phase 1 already resolved via NetEase).
    if existing_source != NETEASE_SOURCE and deadline - time.monotonic() >= 0.5:
        try:
            hit = _netease_lookup(clean_artist, clean_title, duration, deadline, require_rich=True)
            clean_response = True
            if hit and hit.get("rich_synced"):
                return {
                    "rich_synced": hit["rich_synced"],
                    "rich_source": hit["rich_source"] or RICH_NETEASE_SOURCE,
                }
        except requests.RequestException as exc:
            logger.debug("NetEase enrichment request failed for %s - %s: %s", artist, title, exc)
        except (ValueError, KeyError, TypeError) as exc:
            logger.debug("NetEase enrichment parse error for %s - %s: %s", artist, title, exc)

    # 3. LyricsPlus (best-effort, strictly text-verified against reference_text).
    if reference_text and deadline - time.monotonic() >= 0.5:
        try:
            hit = _lyricsplus_lookup(clean_artist, clean_title, album, duration, reference_text, deadline)
            clean_response = True
            if hit and hit.get("rich_synced"):
                return hit
        except requests.RequestException as exc:
            logger.debug("LyricsPlus enrichment request failed for %s - %s: %s", artist, title, exc)
        except (ValueError, KeyError, TypeError) as exc:
            logger.debug("LyricsPlus enrichment parse error for %s - %s: %s", artist, title, exc)

    if not clean_response:
        return None
    return {"rich_synced": None, "rich_source": RICH_NONE_SOURCE}


class _LyricsLookupCoordinator:
    """Bounded dedicated workers, single-flight keys, and deliberately no queue.

    A semaphore is acquired before submitting to ThreadPoolExecutor, so its
    internal work queue never accumulates waiting lyrics tasks. When all
    workers are occupied the API responds ``pending``/``busy`` without queuing.
    Downloader workers are entirely separate from this coordinator.
    """

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
        """``forget_when_done`` is for a lookup that reports its own result:
        nobody comes back to collect it, so it must not stay held here.

        ``needed``, asked under the lock before a new lookup starts, lets the
        caller re-check what that lookup would settle. A forgotten lookup has
        already reported, so a caller that read its state before the report
        landed sees the report here instead of starting the lookup again.
        """
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
        # Outside the lock: a lookup already finished runs its callback here.
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
    on_complete: Optional[Callable[[Optional[Dict[str, Any]]], Any]] = None,
    needed: Optional[Callable[[], bool]] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Poll/start a bounded Phase 1 background lookup.

    Status is ``complete``, ``pending``, ``busy`` or ``settled``. Busy means
    both dedicated workers are active; no server-side task was buffered.
    ``on_complete``, if this call starts the lookup, receives its record on the
    worker as soon as it lands — for a caller that will not come back to
    collect it. ``needed`` is checked before a new lookup starts; when it says
    no, nothing starts and the status is ``settled``: what the caller read is
    out of date, and it reads again.
    """
    key = _lookup_key(artist, title, album, duration)
    lookup = partial(fetch_lyrics, artist, title, album, duration)
    if on_complete is not None:
        def lookup_and_report(fetch=lookup):
            record = fetch()
            try:
                on_complete(record)
            except Exception as exc:
                logger.warning("Lyrics completion callback failed: %s", exc)
            return record

        return _LOOKUPS.poll_or_start(key, lookup_and_report, forget_when_done=True, needed=needed)
    return _LOOKUPS.poll_or_start(key, lookup, needed=needed)


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
    key = f"enrich:v1\x00{_lookup_key(artist, title, album, duration)}"
    lookup = partial(
        enrich_lyrics,
        artist,
        title,
        album,
        duration,
        reference_text=reference_text,
        existing_source=existing_source,
    )
    if on_complete is not None:
        def enrich_and_report(fetch=lookup):
            result = fetch()
            try:
                on_complete(result)
            except Exception as exc:
                logger.warning("Lyrics enrichment callback failed: %s", exc)
            return result

        return _ENRICHMENTS.poll_or_start(key, enrich_and_report, forget_when_done=True, needed=needed)
    return _ENRICHMENTS.poll_or_start(key, lookup, needed=needed)


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
    _ENRICHMENTS.clear_for_tests()
