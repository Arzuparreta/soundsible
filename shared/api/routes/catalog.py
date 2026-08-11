from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import copy_context
from typing import Any

import requests
from flask import Blueprint, jsonify, request

try:
    import gevent  # noqa: F401  # imported to probe availability
    from gevent import spawn, joinall
    _HAS_GEVENT = True
except ImportError:  # pragma: no cover
    _HAS_GEVENT = False

from shared import request_scope
from shared.api.memo import Memo
from shared.database import instance_db
from shared.musicbrainz import normalize_recording_mbid
from shared.providers import deezer
from shared.hardening import rate_limit
from shared.resolution_confidence import best_candidate, classify_confidence
from shared.text_utils import (
    collapse_text,
    fold_text,
    identity_key,
    match_tokens,
    normalize_text,
    sanitize_cli_message,
    strip_release_junk,
)
from shared.url_utils import validate_youtube_video_id


logger = logging.getLogger(__name__)

catalog_bp = Blueprint("catalog", __name__, url_prefix="")

_DEEZER_HOST = "https://api.deezer.com"
_MUSICBRAINZ_HOST = "https://musicbrainz.org/ws/2"
# Every distinct query/artist/album mints a cache entry, so these have to be
# bounded. They also have to be single-flight: a TTL cache only helps *after*
# the first call returns, and these misses cost a Deezer/MusicBrainz/yt-dlp
# fan-out — so two devices, or the Search route and the Now Playing panel, or a
# debounced keystroke racing its own retry, each ran the whole thing.
#
# `wait_timeout_sec` is 15, not `Memo`'s yt-dlp-sized default of 120: the
# client gives up on `/api/catalog/search` after 15s (ui_web/src/lib/api.ts), and
# a waiter blocked eight times longer than anyone is listening is just a pinned
# worker.
_CACHE_MAX_ENTRIES = 256
_CATALOG_CACHE_TTL_SEC = 180
_ARTIST_CACHE_TTL_SEC = 600
_ALBUM_CACHE_TTL_SEC = 600
_CACHE_WAIT_TIMEOUT_SEC = 15.0
_catalog_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_CATALOG_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
_artist_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_ARTIST_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
_album_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_ALBUM_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
_DEEZER_FANOUT_TIMEOUT_SEC = 12
# Deezer/MusicBrainz rows carry no video id, so playing or saving one costs a
# yt-dlp search. Two callers routinely want the same row at the same moment: the
# speculative prefetch for the top results, and the click that follows. This
# collapses them onto one search. The durable cache is SQLite
# (`get_cached_resolution`); the short TTL here only covers the in-flight window
# and the seconds right after it.
_RESOLVE_MEMO_TTL_SEC = 30
_resolve_memo: Memo[tuple[dict[str, Any], list[dict[str, Any]]]] = Memo(
    ttl_sec=_RESOLVE_MEMO_TTL_SEC,
    maxsize=128,
)
_MUSICBRAINZ_HEADERS = {
    "User-Agent": "Soundsible/1.0 (https://github.com/Arzuparreta/soundsible)",
    "Accept": "application/json",
}
_SEARCH_WORKERS = 4
# Two rows that agree on artist and title but disagree on length by more than
# this are different cuts, not duplicates.
_DEDUPE_DURATION_TOLERANCE_SEC = 10
# Per-shape budgets. The local provider used to draw tracks, artists and albums
# from one shared budget and stop at the first match past it, so a large library
# returned whatever sorted first rather than what matched best.
_LOCAL_TRACK_BUDGET = 24
_LOCAL_ENTITY_BUDGET = 8
# Section caps. These bound the response, which was previously unlimited: `limit`
# only ever sized the provider fan-out, never the payload.
_SECTION_CAPS = {"songs": 40, "artists": 20, "albums": 20, "playlists": 12}
# The query has to essentially *be* the name: 70 (title prefix) + 32 (artist
# prefix) = 102 clears this; 42 (title substring) + 48 (artist exact) = 90 does
# not.
_TOP_FLOOR = 92.0
# One type-boost tier. If the runner-up is a different type and within a type
# boost, the type boost alone decided the winner — that is not evidence.
_TOP_MARGIN = 12.0


def _scoped(key: str) -> str:
    """Namespace a cache key by account.

    These bodies blend public metadata with library state — what you own, what
    is playable for you — so one person's cached response must never be served
    to another.
    """
    from shared.user_context import current_user_id

    return f"{current_user_id() or '-'}|{key}"


def _memo_resolve(
    memo: Memo[dict[str, Any]], key: str, compute: Any
) -> tuple[dict[str, Any], bool]:
    """Account-scoped, single-flight, copy-on-read access to a cached body.

    The copy matters: callers mutate what they get back (`body["cached"] = ...`),
    and `Memo` hands out the stored object itself.
    """
    key = _scoped(key)
    hit = memo.get(key)
    if hit is not None:
        return dict(hit), True
    return dict(memo.resolve(key, compute)), False


def _get_api():
    import shared.api as api_mod

    from shared.user_context import current_user_id

    return {
        "get_core": api_mod.get_core,
        "user_id": current_user_id(),
        "get_downloader": api_mod.get_downloader,
        "queue_manager_dl": api_mod.queue_manager_dl,
        "start_downloader_pump": api_mod.start_downloader_pump,
        "parse_intake_item": api_mod.parse_intake_item,
    }


def _clean(value: object, max_len: int = 240) -> str:
    return collapse_text(value, max_len)


_norm = normalize_text
_key = identity_key


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


def _intent_creator(results: list[dict[str, Any]], query: str) -> str:
    """Infer one strong creator correction from the public result set.

    This is deliberately query-only: no account state, history, favourites, or
    recommendation profile is available to catalog ranking. A repeated creator
    with a one-character spelling variation is enough to recover searches such
    as ``fari`` -> ``El Fary`` without hiding the literal ``Fari`` matches.
    """
    q_tokens = [token for token in re.findall(r"[a-z0-9]+", _norm(query)) if len(token) >= 3]
    if not q_tokens:
        return ""

    counts: dict[str, tuple[int, str]] = {}
    for row in results[:10]:
        creator = _clean(row.get("artist") or row.get("channel") or row.get("uploader"))
        creator = re.sub(r"\s*-\s*topic$", "", creator, flags=re.IGNORECASE).strip()
        if not creator:
            continue
        key = _norm(creator)
        count, _ = counts.get(key, (0, creator))
        counts[key] = (count + 1, creator)
    if not counts:
        return ""

    _, (count, creator) = max(counts.items(), key=lambda entry: entry[1][0])
    if count < 2:
        return ""
    creator_tokens = re.findall(r"[a-z0-9]+", _norm(creator))
    for q_token in q_tokens:
        if any(
            q_token != token and _edit_distance_at_most_one(q_token, token)
            for token in creator_tokens
        ):
            return creator
    return ""


def _edit_distance_at_most_one(left: str, right: str) -> bool:
    if left == right:
        return True
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) > len(right):
        left, right = right, left
    i = j = edits = 0
    while i < len(left) and j < len(right):
        if left[i] == right[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(left) == len(right):
            i += 1
        j += 1
    return edits + (len(right) - j) <= 1


# ── Ranking ──────────────────────────────────────────────────────────────────
# Query-only by contract (docs/ARCHITECTURE.md): nothing below may read
# favourites, listening history, or any other account signal, not even to break
# a tie. Every term is a function of the query plus the public rows the
# providers just returned.
#
# The text tiers are the load-bearing quantity. Every other term is sized to fit
# *inside* the smallest gap between two tiers, so it can reorder rows that match
# the query equally well but can never overturn a better text match.
_TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS = 100.0, 70.0, 42.0
_ARTIST_EXACT, _ARTIST_PREFIX, _ARTIST_CONTAINS = 48.0, 32.0, 18.0
# Smallest title gap 100-70 = 30. Smallest artist gap 48-32 = 16.
_TYPE_BOOST = {"library_track": 12.0, "track": 12.0, "artist": 7.0, "album": 5.0, "playlist": 4.0}

# A non-exact title keeps at least this share of its tier, so the coverage
# factor can only order rows within a tier.
_COVERAGE_FLOOR = 0.55
_POPULARITY_MAX = 8.0  # < 16, so popularity never crosses an artist tier.
_POPULARITY_NEUTRAL = _POPULARITY_MAX / 2  # cohorts that publish no metric at all.
# > (12-7) + 8: enough to beat "the track only won on type boost and views".
# < 30: not enough to promote a substring match over an exact one.
_ENTITY_INTENT_BONUS = 22.0
_CORROBORATION_BONUS = 6.0  # < 16: provider availability reorders within a tier only.
_CREATOR_INTENT_BONUS = 135.0
_INTENT_WINDOW = 8
_INTENT_ARTIST_QUORUM = 4
_INTENT_ALBUM_QUORUM = 3
_TRACK_TYPES = ("library_track", "track")

# Public, fixed tie-breaks. `_MERGE_ORDER` reproduces the provider merge order
# this endpoint has always used, in which library is last: keeping it means this
# rewrite cannot change the outcome of any existing tie. Do not move library to
# the front either — ARCHITECTURE forbids ownership as a tie-break in *both*
# directions.
_MERGE_ORDER = {"youtube": 0, "deezer": 1, "musicbrainz": 2, "library": 3}
_TYPE_ORDER = {"artist": 0, "album": 1, "library_track": 2, "track": 3, "playlist": 4}


def _coverage(q_folded: str, text_folded: str) -> float:
    """How much of the field the query accounts for, 0..1."""
    if not q_folded or not text_folded:
        return 0.0
    return min(1.0, len(q_folded) / max(len(q_folded), len(text_folded)))


def _text_score(
    q_folded: str,
    q_tokens: frozenset[str],
    value: object,
    exact: float,
    prefix: float,
    contains: float,
    *,
    apply_coverage: bool,
) -> float:
    """Score one field against the query, on the original tier scale.

    `apply_coverage` is on for titles and off for artists. A prefix match on
    ``Radio`` and one on ``Radiohead - Creep`` used to score identically, and
    titles are where provider boilerplate lives. Artist fields are short clean
    names everywhere except YouTube channels, so a length ratio carries almost
    no signal there and would only penalise bands with long names.
    """
    text = fold_text(strip_release_junk(value) if apply_coverage else value)
    if not text or not q_folded:
        return 0.0
    if text == q_folded:
        return exact
    if text.startswith(q_folded):
        tier = prefix
    elif q_folded in text:
        tier = contains
    elif q_tokens and q_tokens.issubset(set(match_tokens(text))):
        # Every query word is present, just not in that order: `rainbows in`
        # finds `In Rainbows`. Worth the same as a substring match.
        tier = contains
    else:
        return 0.0
    if not apply_coverage:
        return tier
    return tier * (_COVERAGE_FLOOR + (1.0 - _COVERAGE_FLOOR) * _coverage(q_folded, text))


def _popularity_scores(items: list[dict[str, Any]]) -> dict[str, float]:
    """Bounded popularity, ranked *within* each (source, type) cohort.

    Raw popularity is not comparable across providers: Deezer `rank` tops out at
    1e6, MusicBrainz `score` at 100, YouTube view counts are unbounded, and
    Deezer artist rows publish none at all. The absolute term this replaces
    (`min(25, popularity/40000)`) was therefore a near-binary +25 for YouTube and
    Deezer *tracks* and 0 for everything else — a flat 25-point thumb on the
    scale that alone was enough to tie an exact artist-name match.

    A cohort with no variance scores the neutral midpoint. That rule keys off the
    absence of a published metric, never off ownership: MusicBrainz artist rows
    get exactly the same treatment library rows do.
    """
    cohorts: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        cohorts.setdefault((str(item.get("source")), str(item.get("type"))), []).append(item)

    scores: dict[str, float] = {}
    for members in cohorts.values():
        values = sorted({float(item.get("popularity") or 0.0) for item in members}, reverse=True)
        if len(values) <= 1:
            for item in members:
                scores[item["id"]] = _POPULARITY_NEUTRAL
            continue
        # Dense rank, so equal popularity always scores equal — required for a
        # reproducible order.
        dense = {value: idx for idx, value in enumerate(values)}
        span = len(values) - 1
        for item in members:
            rank = dense[float(item.get("popularity") or 0.0)]
            scores[item["id"]] = _POPULARITY_MAX * (1.0 - rank / span)
    return scores


def _entity_key(item: dict[str, Any]) -> str:
    return f"{item.get('type')}\x00{fold_text(item.get('title'))}"


def _corroboration_scores(items: list[dict[str, Any]]) -> dict[str, float]:
    """Entity names independent providers agree on are more likely to be real."""
    sources: dict[str, set[str]] = {}
    for item in items:
        if item.get("type") in ("artist", "album"):
            sources.setdefault(_entity_key(item), set()).add(str(item.get("source")))
    return {
        key: _CORROBORATION_BONUS
        for key, found in sources.items()
        if len(found) >= 2
    }


def _entity_intent(
    ranked: list[dict[str, Any]], q_folded: str, q_tokens: frozenset[str]
) -> tuple[str, str]:
    """Read 'you meant the artist/album, not these songs' off the songs themselves.

    Eight Radiohead songs at the top of a `radiohead` search are eight pieces of
    public evidence that the artist page is the answer. Query-only: the vote runs
    over provider rows, and the winner still has to match the query by name — the
    quorum alone would fire on any query with one dominant artist.

    Album intent fires rarely by construction: only Deezer and library track rows
    carry an `album` field at all.
    """
    window = [item for item in ranked if item.get("type") in _TRACK_TYPES][:_INTENT_WINDOW]
    return (
        _intent_winner(window, "artist", _INTENT_ARTIST_QUORUM, q_folded, q_tokens),
        _intent_winner(window, "album", _INTENT_ALBUM_QUORUM, q_folded, q_tokens),
    )


def _intent_winner(
    window: list[dict[str, Any]],
    field: str,
    quorum: int,
    q_folded: str,
    q_tokens: frozenset[str],
) -> str:
    votes: dict[str, int] = {}
    for item in window:
        name = fold_text(item.get(field))
        if name:
            votes[name] = votes.get(name, 0) + 1
    if not votes:
        return ""
    # Ties broken by name so the winner never depends on dict ordering.
    name, count = max(votes.items(), key=lambda kv: (kv[1], kv[0]))
    if count < quorum:
        return ""
    matches = _text_score(
        q_folded, q_tokens, name, _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=False
    )
    return name if matches >= _TITLE_CONTAINS else ""


def _rank(
    item: dict[str, Any],
    query: str,
    index: int = 0,
    intent_creator: str = "",
    *,
    popularity: float = _POPULARITY_NEUTRAL,
    corroboration: float = 0.0,
    entity_intent: float = 0.0,
) -> float:
    """Score one row against the query.

    `index` is accepted and ignored. It used to subtract `index * 0.01`, which
    over a ~150-row merge drifted far enough to reorder rows whose real scores
    differed by less than 1.5 points — every small term below would have been
    partly noise. Ordering is now an explicit total order (`_sort_key`). The
    parameter stays so the neutrality regression test keeps calling this
    positionally; the cross-row terms are keyword-only with neutral defaults so
    that test still compares two rows that differ only in ownership.
    """
    q_folded = fold_text(query)
    q_tokens = frozenset(match_tokens(query))
    score = _text_score(
        q_folded, q_tokens, item.get("title"),
        _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=True,
    )
    score += _text_score(
        q_folded, q_tokens, item.get("artist") or item.get("subtitle"),
        _ARTIST_EXACT, _ARTIST_PREFIX, _ARTIST_CONTAINS, apply_coverage=False,
    )
    score += _TYPE_BOOST.get(str(item.get("type")), 0.0)
    score += popularity + corroboration + entity_intent
    if intent_creator:
        creator = fold_text(item.get("artist") or item.get("subtitle"))
        intent = fold_text(intent_creator)
        if creator == intent or creator.startswith(f"{intent} -") or intent in creator:
            score += _CREATOR_INTENT_BONUS
    return score


def _sort_key(item: dict[str, Any]) -> tuple[float, int, int, str]:
    """A total order, so the same rows always produce the same page.

    Providers finish in whatever order the network gives us, so score alone is
    not enough: the tie-breaks have to be properties of the row.
    """
    return (
        -item["_rank"],
        _MERGE_ORDER.get(str(item.get("source")), 9),
        _TYPE_ORDER.get(str(item.get("type")), 9),
        str(item.get("id") or ""),
    )


def _dedupe(
    items: list[dict[str, Any]],
    query: str,
    intent_creator: str = "",
) -> list[dict[str, Any]]:
    """Score every row, collapse the ones that are the same recording, and order.

    Two passes: the first ranks on text and per-row signals, the second applies
    the entity intent read off that first ranking. Deriving intent from the final
    order and feeding it back in would be a cycle whose fixed point depends on
    iteration order.
    """
    q_folded = fold_text(query)
    q_tokens = frozenset(match_tokens(query))
    popularity = _popularity_scores(items)
    corroboration = _corroboration_scores(items)

    for item in items:
        item["_rank"] = _rank(
            item, query, intent_creator=intent_creator,
            popularity=popularity.get(item["id"], _POPULARITY_NEUTRAL),
            corroboration=corroboration.get(_entity_key(item), 0.0),
        )
    first_pass = sorted(items, key=_sort_key)

    artist_intent, album_intent = _entity_intent(first_pass, q_folded, q_tokens)
    if artist_intent or album_intent:
        for item in items:
            name = fold_text(item.get("title"))
            wanted = artist_intent if item.get("type") == "artist" else (
                album_intent if item.get("type") == "album" else ""
            )
            if wanted and name == wanted:
                item["_rank"] += _ENTITY_INTENT_BONUS

    survivors = _collapse_duplicates(items)
    for item in survivors:
        item["_title_score"] = _text_score(
            q_folded, q_tokens, item.get("title"),
            _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=True,
        )
    return sorted(survivors, key=_sort_key)


def _dedupe_keys(item: dict[str, Any]) -> list[str]:
    """Every identity this row can be recognised by, strongest evidence first."""
    ids = item.get("external_ids") or {}
    keys: list[str] = []
    if ids.get("isrc"):
        keys.append(f"isrc:{_norm(ids.get('isrc'))}")
    if item.get("track_id"):
        keys.append(f"library:{item['track_id']}")
    for field, prefix in (
        ("deezer_id", "deezer"),
        ("musicbrainz_id", "mb"),
        ("deezer_artist_id", "deezer-artist"),
        ("musicbrainz_artist_id", "mb-artist"),
        ("deezer_album_id", "deezer-album"),
        ("musicbrainz_release_id", "mb-release"),
        ("youtube_id", "youtube"),
    ):
        if ids.get(field):
            keys.append(f"{prefix}:{ids.get(field)}")
    # YouTube titles are `Artist - Title (Official Video)` with the artist
    # repeated as the channel, so the soft key almost never matches one and the
    # parse that would make it match is the change most likely to *hide* the
    # exact row somebody was hunting for. Left out on purpose.
    if item.get("source") != "youtube":
        # `library_track` and `track` are the same shape from different places —
        # bucketing them apart is precisely what let one song be listed once per
        # provider.
        shape = "track" if item.get("type") in _TRACK_TYPES else str(item.get("type"))
        soft = f"{fold_text(item.get('artist') or item.get('subtitle'))}\x00{fold_text(strip_release_junk(item.get('title')))}"
        keys.append(f"soft:{shape}:{soft}")
    return keys


def _collapse_duplicates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per recording, merging what the other copies knew about it.

    The same song routinely arrived three times — from the library, from Deezer,
    from MusicBrainz — because a library row was keyed by its track id and so
    could never match anything else.

    The survivor and its position are chosen by score alone. Ownership only
    merges into the survivor's action state, which is exactly what ARCHITECTURE
    permits: an owned copy makes the row instantly playable, it does not move the
    row up the page.
    """
    representative: dict[str, dict[str, Any]] = {}
    groups: dict[int, list[dict[str, Any]]] = {}
    order: list[int] = []

    for item in items:
        keys = _dedupe_keys(item)
        found = next((representative[k] for k in keys if k in representative), None)
        if found is None or not _same_recording(found, item):
            groups[id(item)] = [item]
            order.append(id(item))
            for key in keys:
                representative.setdefault(key, item)
            continue
        groups[id(found)].append(item)
        for key in keys:
            representative.setdefault(key, found)

    survivors: list[dict[str, Any]] = []
    for group_id in order:
        group = groups[group_id]
        winner = min(group, key=_sort_key)
        if len(group) > 1:
            winner["_rank"] = max(row["_rank"] for row in group)
            _merge_action_state(winner, group)
        survivors.append(winner)
    return survivors


def _merge_action_state(winner: dict[str, Any], group: list[dict[str, Any]]) -> None:
    state = dict(winner.get("action_state") or {})
    for row in group:
        other = row.get("action_state") or {}
        for flag in ("in_library", "playable", "downloadable"):
            state[flag] = bool(state.get(flag)) or bool(other.get(flag))
        if not winner.get("track_id") and row.get("track_id"):
            winner["track_id"] = row["track_id"]
            winner["raw"] = row.get("raw") or winner.get("raw")
    state["needs_resolution"] = not bool(winner.get("track_id"))
    winner["action_state"] = state
    winner["alternates"] = [row["id"] for row in group if row["id"] != winner["id"]]

    # The winning presentation row is often Deezer or the local library even
    # when the matching MusicBrainz row supplied the strongest portable
    # identity. Keep one unambiguous Recording MBID across that collapse. If
    # MusicBrainz returned distinct recordings with the same visible shape,
    # attaching either one would be worse than attaching none.
    recording_mbids = {
        mbid
        for row in group
        if (
            mbid := normalize_recording_mbid(
                (row.get("external_ids") or {}).get("musicbrainz_id")
            )
        )
    }
    external_ids = dict(winner.get("external_ids") or {})
    external_ids.pop("musicbrainz_id", None)
    if len(recording_mbids) == 1:
        external_ids["musicbrainz_id"] = recording_mbids.pop()
    winner["external_ids"] = external_ids


def _same_recording(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Guard against merging two different cuts that share a title and artist.

    A three-minute studio take and a twelve-minute live version are not the same
    row. When either side has no duration there is nothing to contradict, so the
    identity keys stand on their own.
    """
    if left.get("type") in _TRACK_TYPES and right.get("type") not in _TRACK_TYPES:
        return False
    if right.get("type") in _TRACK_TYPES and left.get("type") not in _TRACK_TYPES:
        return False
    a, b = left.get("duration"), right.get("duration")
    if not a or not b:
        return True
    return abs(int(a) - int(b)) <= _DEDUPE_DURATION_TOLERANCE_SEC


def _local_catalog(query: str, limit: int) -> list[dict[str, Any]]:
    """The best local matches per shape, instead of the first N in library order.

    Two things were wrong here. Tracks, artists and albums drew on one shared
    budget and the scan stopped at the first match past it, so in a large library
    the artist you were searching for could sit behind two dozen of their own
    songs and never be emitted at all. And the match test was a substring of
    ``"title artist album"`` joined together, which matched across field
    boundaries.

    Scoring runs on the raw strings and only the winners are materialised: each
    `_catalog_item` embeds a full `track.to_dict()`, so building one per match
    would mean tens of thousands of them per keystroke on a big library.

    `limit` is accepted so this reads like the other providers, and ignored: the
    per-shape budgets below are what bound the output.
    """
    q_folded = fold_text(query)
    q_tokens = frozenset(match_tokens(query))
    scored: list[tuple[float, str, Any]] = []
    artists: dict[str, tuple[float, str, Any]] = {}
    albums: dict[str, tuple[float, str, Any]] = {}

    def score(value: object, *, coverage: bool) -> float:
        return _text_score(
            q_folded, q_tokens, value,
            _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=coverage,
        )

    for track in _library_tracks():
        title = getattr(track, "title", "") or ""
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        album = getattr(track, "album", "") or ""
        title_score = score(title, coverage=True)
        artist_score = score(artist, coverage=False)
        album_score = score(album, coverage=False)
        if not (title_score or artist_score or album_score):
            continue
        track_id = str(getattr(track, "id", ""))
        scored.append((title_score * 2 + artist_score + album_score, track_id, track))
        if artist and artist_score:
            key = fold_text(artist)
            if artist_score > artists.get(key, (0.0, "", None))[0]:
                artists[key] = (artist_score, artist, track)
        if album and (album_score or artist_score):
            key = f"{fold_text(artist)}\x00{fold_text(album)}"
            weight = max(album_score, artist_score)
            if weight > albums.get(key, (0.0, "", None))[0]:
                albums[key] = (weight, album, track)

    out: list[dict[str, Any]] = []
    best_tracks = sorted(scored, key=lambda row: (-row[0], row[1]))[:_LOCAL_TRACK_BUDGET]
    for _, _, track in best_tracks:
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            _catalog_item(
                item_id=f"library:track:{track.id}",
                item_type="library_track",
                source="library",
                title=getattr(track, "title", "") or "",
                subtitle=artist,
                artist=artist,
                album=getattr(track, "album", "") or "",
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

    for key, (_, name, track) in sorted(artists.items(), key=lambda kv: (-kv[1][0], kv[0]))[:_LOCAL_ENTITY_BUDGET]:
        out.append(
            _catalog_item(
                item_id=f"library:artist:{key}",
                item_type="artist",
                source="library",
                title=name,
                subtitle="",
                artist=name,
                cover=_cover_from_track(track),
                track_id=None,
                in_library=True,
                playable=False,
                downloadable=False,
                raw={"artist": name},
            )
        )

    for key, (_, name, track) in sorted(albums.items(), key=lambda kv: (-kv[1][0], kv[0]))[:_LOCAL_ENTITY_BUDGET]:
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            _catalog_item(
                item_id=f"library:album:{key}",
                item_type="album",
                source="library",
                title=name,
                subtitle=artist,
                artist=artist,
                album=name,
                cover=_cover_from_track(track),
                in_library=True,
                playable=False,
                downloadable=False,
                raw={"artist": artist, "album": name},
            )
        )
    # Deliberately not truncated by `limit`: the per-shape budgets above already
    # bound this at 40 rows, and slicing here would cut the entity rows off the
    # end again — the exact bug this rewrite exists to fix.
    return out


def _deezer_search(query: str, limit: int) -> list[dict[str, Any]]:
    rows = deezer.rows("search", {"q": query, "limit": min(limit, 25)}, timeout=6)
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
    """One MusicBrainz request, expanded into recording/artist/album rows.

    MusicBrainz asks clients to stay near one request per second. A recording
    search already embeds artist credits and releases, so one respectful call
    yields all three catalog shapes without the old three-request latency.
    """
    resp = requests.get(
        f"{_MUSICBRAINZ_HOST}/recording/",
        params={"query": query, "limit": min(25, max(8, limit)), "fmt": "json"},
        timeout=6,
        headers=_MUSICBRAINZ_HEADERS,
    )
    resp.raise_for_status()
    data = resp.json()
    rows = data.get("recordings") if isinstance(data, dict) else []
    if not isinstance(rows, list):
        return []

    out: list[dict[str, Any]] = []
    seen_artists: set[str] = set()
    seen_albums: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        mbid = normalize_recording_mbid(_clean(row.get("id"), 80))
        title = _clean(row.get("title"))
        credits = row.get("artist-credit") if isinstance(row.get("artist-credit"), list) else []
        credit = credits[0] if credits and isinstance(credits[0], dict) else {}
        artist_row = credit.get("artist") if isinstance(credit.get("artist"), dict) else {}
        artist = _clean(credit.get("name") or artist_row.get("name"))
        artist_id = _clean(artist_row.get("id"), 80)
        if mbid and title:
            out.append(_catalog_item(
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
            ))
        if artist and artist_id and artist_id not in seen_artists:
            seen_artists.add(artist_id)
            out.append(_catalog_item(
                item_id=f"musicbrainz:artist:{artist_id}",
                item_type="artist",
                source="musicbrainz",
                title=artist,
                subtitle=_clean(artist_row.get("disambiguation")) or "Artist",
                artist=artist,
                popularity=float(row.get("score") or 0),
                external_ids={"musicbrainz_artist_id": artist_id},
                attribution_url=f"https://musicbrainz.org/artist/{artist_id}",
                downloadable=False,
                raw={"musicbrainz_artist_id": artist_id},
            ))
        releases = row.get("releases") if isinstance(row.get("releases"), list) else []
        release = releases[0] if releases and isinstance(releases[0], dict) else {}
        album = _clean(release.get("title"))
        album_id = _clean(release.get("id"), 80)
        if album and album_id and album_id not in seen_albums:
            seen_albums.add(album_id)
            out.append(_catalog_item(
                item_id=f"musicbrainz:album:{album_id}",
                item_type="album",
                source="musicbrainz",
                title=album,
                subtitle=artist,
                artist=artist,
                album=album,
                popularity=float(row.get("score") or 0),
                external_ids={"musicbrainz_release_id": album_id},
                attribution_url=f"https://musicbrainz.org/release/{album_id}",
                downloadable=False,
                raw={"musicbrainz_release_id": album_id},
            ))
    return out


def _youtube_search(query: str, limit: int) -> list[dict[str, Any]]:
    """Fast public-video provider used by the universal catalog response."""
    dl = _get_api()["get_downloader"](open_browser=False)
    rows = dl.downloader.search_youtube(
        query,
        max_results=min(25, max(8, limit)),
        use_ytmusic=False,
        enrich_missing=False,
    )
    out: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        video_id = _clean(row.get("id") or row.get("video_id") or row.get("videoId"), 32)
        title = _clean(row.get("title"))
        artist = _clean(row.get("channel") or row.get("uploader") or row.get("artist"))
        if not video_id or not title:
            continue
        thumbnail = _clean(row.get("thumbnail"), 500)
        out.append(
            _catalog_item(
                item_id=f"youtube:track:{video_id}",
                item_type="track",
                source="youtube",
                title=title,
                subtitle=artist,
                artist=artist,
                duration=_duration(row.get("duration")),
                cover=thumbnail or f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                popularity=max(0.0, float(row.get("view_count") or 0)),
                external_ids={"youtube_id": video_id},
                attribution_url=f"https://www.youtube.com/watch?v={video_id}",
                playable=True,
                raw={
                    "id": video_id,
                    "title": title,
                    "artist": artist,
                    "duration": _duration(row.get("duration")),
                    "youtube_id": video_id,
                },
            )
        )
    return out


def _filter_types(items: list[dict[str, Any]], wanted: set[str]) -> list[dict[str, Any]]:
    if not wanted or "all" in wanted:
        return items
    return [item for item in items if item.get("type") in wanted]


def _top_result(ranked: list[dict[str, Any]]) -> str | None:
    """The one row confident enough to lead the page, or nothing at all.

    A wrong top result costs more than a missing one: it is the largest target on
    the page, and for an artist or album it navigates somewhere else entirely.
    The margin over the best row of a *different* type only applies to those two
    types, because a wrong song at the top is one tap to undo.
    """
    if not ranked:
        return None
    head = ranked[0]
    if head.get("_rank", 0.0) < _TOP_FLOOR:
        return None
    if head.get("type") not in ("artist", "album"):
        return head["id"]
    runner = next((row for row in ranked[1:] if row.get("type") != head.get("type")), None)
    if runner is not None and head["_rank"] - runner["_rank"] < _TOP_MARGIN:
        return None
    return head["id"]


def _build_sections(ranked: list[dict[str, Any]], top: str | None = None) -> list[dict[str, Any]]:
    """The page layout, decided once, here.

    The client used to re-group a rank-ordered list into a fixed songs ->
    artists -> albums order, which buried the artist page under thirty songs on
    an artist search — and the Now Playing panel had its own, opposite order.
    Section order lives on the server so every surface agrees, and so the answer
    can depend on what was actually asked for: an artist name leads with artists,
    a song title leads with songs.

    `total` is the pre-cap count, so the client can offer "see all 61" without
    asking for anything else.
    """
    canonical = ("songs", "artists", "albums", "playlists")
    specs = (
        ("songs", "rows", frozenset(_TRACK_TYPES)),
        ("artists", "grid_round", frozenset({"artist"})),
        ("albums", "grid", frozenset({"album"})),
        ("playlists", "grid", frozenset({"playlist"})),
    )
    sections: list[dict[str, Any]] = []
    for section_id, layout, types in specs:
        members = [row for row in ranked if row.get("type") in types and row["id"] != top]
        if not members:
            continue
        sections.append({
            "id": section_id,
            "layout": layout,
            "item_ids": [row["id"] for row in members[:_SECTION_CAPS[section_id]]],
            "total": len(members),
            "_best": members[0].get("_rank", 0.0),
        })
    sections.sort(key=lambda s: (-s["_best"], canonical.index(s["id"])))
    ordered = [{k: v for k, v in section.items() if k != "_best"} for section in sections]
    if top:
        ordered.insert(0, {"id": "top", "layout": "hero", "item_ids": [top], "total": 1})
    return ordered


def _public(row: dict[str, Any]) -> dict[str, Any]:
    """Strip the scoring fields the ranker hangs off each row."""
    return {k: v for k, v in row.items() if not k.startswith("_")}


def _search_uncached(query: str, types: set[str], limit: int) -> dict[str, Any]:
    now = time.time()
    items: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    providers = [
        # The library used to be scanned inline, before the fan-out, so its cost
        # was added to the network's instead of hidden behind it.
        ("library", lambda: _local_catalog(query, limit)),
        ("deezer", lambda: _deezer_search(query, limit)),
        ("musicbrainz", lambda: _musicbrainz_search(query, limit)),
    ]
    if not types or "all" in types or "track" in types or "library_track" in types:
        providers.append(("youtube", lambda: _youtube_search(query, limit)))

    provider_rows: dict[str, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=_SEARCH_WORKERS, thread_name_prefix="catalog-search") as executor:
        futures = {
            executor.submit(copy_context().run, fn): name
            for name, fn in providers
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                rows = future.result()
                provider_rows[name] = rows
            except Exception as exc:
                logger.info("Catalog provider %s failed: %s", name, exc)
                failures.append({"source": name, "error": sanitize_cli_message(str(exc))})

    # Provider completion order is timing-dependent. Merge in a fixed public
    # order so even exact score ties cannot become account/device dependent.
    for name in ("youtube", "deezer", "musicbrainz", "library"):
        items.extend(provider_rows.get(name, []))
    intent_creator = _intent_creator(provider_rows.get("youtube", []), query)
    ranked = _filter_types(_dedupe(items, query, intent_creator), types)
    top = _top_result(ranked)
    sections = _build_sections(ranked, top)
    # The response used to be unbounded — `limit` only ever sized the provider
    # fan-out — so a single search could ship a few hundred rows the UI then
    # rendered in full. Shipping exactly the rows the sections reference bounds
    # it without costing the client anything it was showing.
    keep = {item_id for section in sections for item_id in section["item_ids"]}
    return {
        "query": query,
        "interpreted_as": intent_creator or None,
        "generated_at": int(now),
        "top_result": top,
        "items": [_public(row) for row in ranked if row["id"] in keep],
        "sections": sections,
        "partial_failures": failures,
    }


def _cached_search(query: str, types: set[str], limit: int) -> tuple[dict[str, Any], bool]:
    # `v2` because the shape gained `top_result` and the sections gained
    # `layout`/`total`: a hot reload must not serve pre-migration bodies.
    key = f"v2:{limit}:{','.join(sorted(types))}:{query.casefold()}"
    return _memo_resolve(_catalog_memo, key, lambda: _search_uncached(query, types, limit))


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


def _resolve_candidates(artist: str, title: str, duration_s: int | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Map a catalog row (artist + title) to the best YouTube match.

    Cheap on a repeat: SQLite remembers every resolution forever, and concurrent
    callers for the same row share one yt-dlp search rather than each running
    their own.
    """
    db = instance_db()
    cached = db.get_cached_resolution(artist, title)
    if cached and cached.get("id"):
        return cached, cached.get("candidates") or [cached]

    key = f"{_norm(artist)}|{_norm(title)}|{duration_s or ''}"
    return _resolve_memo.resolve(key, lambda: _resolve_candidates_uncached(artist, title, duration_s))


def _resolve_candidates_uncached(
    artist: str, title: str, duration_s: int | None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    db = instance_db()
    api = _get_api()
    dl = api["get_downloader"](open_browser=False)
    raw_results = dl.downloader.search_match_candidates(artist, title, max_results=8)
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

    # Kick off stream-URL resolution for the winner in the background. The click
    # that follows this resolve almost always plays exactly this id, and the
    # playback route single-flights on the same key — so its request either
    # finds the URL already warm or joins the extraction already running,
    # instead of starting a second one. Deliberately *not* awaited: blocking the
    # resolve response on it only moves the same wait earlier in the sequence.
    best_id = best.get("id")
    if best_id and validate_youtube_video_id(str(best_id)):
        _warm_preview_stream_url(str(best_id))

    return {**best, "confidence": score, "confidence_reason": reason}, ranked


def _warm_preview_stream_url(video_id: str) -> None:
    """Queue background resolution of `video_id`'s googlevideo URL."""
    from shared import preview_cache
    from shared.api.routes.playback import _get_preview_stream_cached

    api = _get_api()
    try:
        preview_cache.request_prefetch(
            [video_id],
            download=False,
            resolver=lambda vid: _get_preview_stream_cached(api, vid),
        )
    except Exception as exc:  # pragma: no cover — best-effort warm-up
        logger.debug("Catalog resolve: could not queue stream-URL warm for %s: %s", video_id, exc)


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

    external_ids = dict(data.get("external_ids")) if isinstance(data.get("external_ids"), dict) else {}
    musicbrainz_id = normalize_recording_mbid(external_ids.get("musicbrainz_id"))
    external_ids.pop("musicbrainz_id", None)
    if musicbrainz_id:
        external_ids["musicbrainz_id"] = musicbrainz_id

    api = _get_api()
    metadata_evidence = {
        "title": title,
        "artist": artist,
        "catalog_item_id": data.get("catalog_item_id"),
        "source": data.get("source"),
        "external_ids": external_ids,
    }
    if musicbrainz_id:
        # Flatten the identity at the acquisition boundary so every downstream
        # path can consume the same trusted scalar without understanding a
        # catalog response's nested shape.
        metadata_evidence["musicbrainz_id"] = musicbrainz_id
    item = {
        "source_type": "ytmusic_search",
        "video_id": video_id,
        "display_title": title,
        "display_artist": artist,
        "thumbnail_url": data.get("cover") or f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
        "duration_sec": duration_s,
        "metadata_evidence": metadata_evidence,
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
    new_item = api["queue_manager_dl"].add(parsed, user_id=api["user_id"])
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
    """One artist page used to fire five of these, each uncached and on its own
    connection. `shared.providers.deezer` pools and caches them."""
    return deezer.get(path, params, timeout=timeout)


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
    """The bound user's tracks, loaded once per request.

    Every catalog and discovery helper that needs to know what is already owned
    used to call this, and each call re-ran the staleness check and rebuilt the
    list. One `/api/catalog/artist` did it three times over.
    """
    return request_scope.scoped("catalog_library_tracks", _load_library_tracks)


def _load_library_tracks() -> list[Any]:
    api = _get_api()
    lib, _, _ = api["get_core"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    return list(metadata.tracks if metadata and metadata.tracks else [])


def _library_key_index() -> dict[str, Any]:
    """Owned-track keys grouped by artist and by album, built in one pass.

    The lookups below are answered from these maps instead of walking the whole
    library per call, which is what made them O(library) per request.
    """
    return request_scope.scoped("catalog_library_key_index", _build_library_key_index)


def _build_library_key_index() -> dict[str, Any]:
    by_artist: dict[str, set[str]] = {}
    by_album: dict[tuple[str, str], set[str]] = {}
    everything: set[str] = set()
    for track in _library_tracks():
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        album = getattr(track, "album", "") or ""
        key = _key(getattr(track, "title", "") or "", artist)
        artist_key = _norm(artist)
        everything.add(key)
        by_artist.setdefault(artist_key, set()).add(key)
        by_album.setdefault((_norm(album), artist_key), set()).add(key)
    return {"by_artist": by_artist, "by_album": by_album, "all": everything}


def _library_artist_keys(name: str) -> set[str]:
    """Normalized artist\x00title keys for library tracks credited to an artist.

    Callers only need these keys (to badge catalog rows as already-owned) and
    whether the set is empty.
    """
    index = _library_key_index()
    name_key = _norm(name)
    if not name_key:
        return set(index["all"])
    return set(index["by_artist"].get(name_key, ()))


def _library_album_keys(album_name: str, artist: str) -> set[str]:
    """Normalized artist\x00title keys for library tracks on a given album."""
    index = _library_key_index()
    album_key = _norm(album_name)
    artist_key = _norm(artist)
    if album_key and artist_key:
        return set(index["by_album"].get((album_key, artist_key), ()))

    keys: set[str] = set()
    for (track_album, track_artist), group in index["by_album"].items():
        if album_key and track_album != album_key:
            continue
        if artist_key and track_artist != artist_key:
            continue
        keys |= group
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
    body, cached = _memo_resolve(
        _artist_memo, cache_key, lambda: _artist_profile_uncached(name, deezer_id)
    )
    body["cached"] = cached
    return jsonify(body)


def _artist_profile_uncached(name: str, deezer_id: str | None) -> dict[str, Any]:
    now = time.time()
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

    return {
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


@catalog_bp.route("/api/catalog/album", methods=["GET"])
@rate_limit("catalog_album", limit=60, window_sec=60)
def catalog_album():
    name = _clean(request.args.get("name", ""), 200)
    if len(name) < 1:
        return jsonify({"error": "name is required"}), 400
    artist = _clean(request.args.get("artist", ""), 200) or None
    deezer_id = _clean(request.args.get("deezer_id", ""), 32) or None

    cache_key = f"album:{deezer_id or (name + '|' + (artist or '')).casefold()}"
    body, cached = _memo_resolve(
        _album_memo, cache_key, lambda: _album_profile_uncached(name, artist, deezer_id)
    )
    body["cached"] = cached
    return jsonify(body)


def _album_profile_uncached(name: str, artist: str | None, deezer_id: str | None) -> dict[str, Any]:
    now = time.time()
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

    return {
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
