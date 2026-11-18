"""Catalog search: one ranked answer from the library, Deezer, MusicBrainz and YouTube.

Also the account-scoped caches and the library key index the catalog routes
read. `shared/api/routes/catalog.py` only parses requests and answers.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import copy_context
from functools import lru_cache
from heapq import nsmallest
from typing import Any

import requests


from shared import request_scope
from shared.deezer_catalog import (
    catalog_item,
    deezer_track_raw,
    duration_seconds,
)
from shared.memo import Memo
from shared.download_pump import get_downloader, queue_manager_dl, start_downloader_pump
from shared.download_queue import parse_intake_item
from shared.user_context import current_user_id
from shared.user_cores import get_library
from shared.database import DatabaseManager
from shared.library_search import search_text, search_title
from shared.musicbrainz import normalize_recording_mbid
from shared.music_identity import youtube_music_metadata
from shared.providers import deezer
from shared.text_utils import (
    collapse_text,
    fold_text,
    identity_key,
    match_tokens,
    normalize_text,
    sanitize_cli_message,
    strip_release_junk,
)

logger = logging.getLogger(__name__)


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
catalog_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_CATALOG_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
artist_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_ARTIST_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
album_memo: Memo[dict[str, Any]] = Memo(
    ttl_sec=_ALBUM_CACHE_TTL_SEC, maxsize=_CACHE_MAX_ENTRIES, wait_timeout_sec=_CACHE_WAIT_TIMEOUT_SEC
)
DEEZER_FANOUT_TIMEOUT_SEC = 12
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


def memo_resolve(
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


def engine_api():
    return {
        "get_library": get_library,
        "user_id": current_user_id(),
        "get_downloader": get_downloader,
        "queue_manager_dl": queue_manager_dl,
        "start_downloader_pump": start_downloader_pump,
        "parse_intake_item": parse_intake_item,
    }


def clean(value: object, max_len: int = 240) -> str:
    return collapse_text(value, max_len)


norm = normalize_text
_key = identity_key






def _track_dict(track) -> dict[str, Any]:
    return track.to_dict() if hasattr(track, "to_dict") else dict(track)


def _cover_from_track(track) -> str:
    from urllib.parse import quote
    return f"/api/static/cover/{quote(str(track.id), safe='')}"




def _intent_creator(results: list[dict[str, Any]], query: str) -> str:
    """Infer one strong creator correction from the public result set.

    This is deliberately query-only: no account state, history, favourites, or
    recommendation profile is available to catalog ranking. A repeated creator
    with a one-character spelling variation is enough to recover searches such
    as ``fari`` -> ``El Fary`` without hiding the literal ``Fari`` matches.
    """
    q_tokens = [token for token in re.findall(r"[a-z0-9]+", norm(query)) if len(token) >= 3]
    if not q_tokens:
        return ""

    counts: dict[str, tuple[int, str]] = {}
    for row in results[:10]:
        creator = clean(row.get("artist") or row.get("channel") or row.get("uploader"))
        creator = re.sub(r"\s*-\s*topic$", "", creator, flags=re.IGNORECASE).strip()
        if not creator:
            continue
        key = norm(creator)
        count, _ = counts.get(key, (0, creator))
        counts[key] = (count + 1, creator)
    if not counts:
        return ""

    _, (count, creator) = max(counts.items(), key=lambda entry: entry[1][0])
    if count < 2:
        return ""
    creator_tokens = re.findall(r"[a-z0-9]+", norm(creator))
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
# Query-only by contract (docs/internal/ARCHITECTURE.md): nothing below may read
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


def text_score(
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
    text = search_title(value) if apply_coverage else search_text(value)
    return score_folded(q_folded, q_tokens, text, exact, prefix, contains, apply_coverage=apply_coverage)


def score_folded(
    q_folded: str,
    q_tokens: frozenset[str],
    text: str,
    exact: float,
    prefix: float,
    contains: float,
    *,
    apply_coverage: bool,
) -> float:
    """`text_score` for a field that is already folded.

    The local search index stores exactly these folded texts, and its
    candidate filter (`shared.library_search`) must keep every row this can
    score above zero.
    """
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
    matches = text_score(
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
    score = text_score(
        q_folded, q_tokens, item.get("title"),
        _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=True,
    )
    score += text_score(
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

    survivors = collapse_duplicates(items)
    for item in survivors:
        item["_title_score"] = text_score(
            q_folded, q_tokens, item.get("title"),
            _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=True,
        )
    return sorted(survivors, key=_sort_key)


def _dedupe_keys(item: dict[str, Any]) -> list[str]:
    """Every identity this row can be recognised by, strongest evidence first."""
    ids = item.get("external_ids") or {}
    keys: list[str] = []
    if ids.get("isrc"):
        keys.append(f"isrc:{norm(ids.get('isrc'))}")
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


def collapse_duplicates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
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


def local_catalog(query: str, limit: int) -> list[dict[str, Any]]:
    """The best local matches per shape, instead of the first N in library order.

    Two things were wrong here. Tracks, artists and albums drew on one shared
    budget and the scan stopped at the first match past it, so in a large library
    the artist you were searching for could sit behind two dozen of their own
    songs and never be emitted at all. And the match test was a substring of
    ``"title artist album"`` joined together, which matched across field
    boundaries.

    Candidates come from the on-disk search index (`shared.library_search`)
    when its fingerprint proves it describes this exact model; otherwise, as
    with unsaved edits, every track is scanned. Both feed the same ranker and
    selection, so the result and its order do not depend on which was used.

    Repeated entity scores are reused within each request (bounded LRU), and a stable
    top-k selection retains only the winning track candidates. Entity maps
    still retain one representative per matching artist/album for deduplication.
    Only the winners are materialised: each
    `catalog_item` embeds a full `track.to_dict()`, so building one per match
    would mean tens of thousands of them per keystroke on a big library.

    `limit` is accepted so this reads like the other providers, and ignored: the
    per-shape budgets below are what bound the output.
    """
    q_folded = fold_text(query)
    q_tokens = frozenset(match_tokens(query))
    if not q_folded:
        # Every field scores zero against an empty folded query.
        return []
    tracks = library_tracks()

    def score(text: str, *, coverage: bool) -> float:
        return score_folded(
            q_folded, q_tokens, text,
            _TITLE_EXACT, _TITLE_PREFIX, _TITLE_CONTAINS, apply_coverage=coverage,
        )

    # Entity scores are cached per request, so they cannot retain tracks or
    # serve stale metadata after edits, and bounded even for a library of
    # entirely distinct names. Titles are usually unique: caching them would
    # displace reusable entity fields.
    def scanned():
        @lru_cache(maxsize=4096)
        def entity(value: str) -> tuple[str, float]:
            key = search_text(value)
            return key, score(key, coverage=False)

        for track in tracks:
            title = getattr(track, "title", "") or ""
            artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
            album = getattr(track, "album", "") or ""
            title_score = score(search_title(title), coverage=True)
            artist_key, artist_score = entity(artist)
            album_key, album_score = entity(album)
            if title_score or artist_score or album_score:
                yield track, title_score, artist_score, album_score, artist_key, album_key

    def indexed(rows):
        @lru_cache(maxsize=4096)
        def entity(key: str) -> float:
            return score(key, coverage=False)

        for position, title, artist_key, album_key in rows:
            title_score = score(title, coverage=True)
            artist_score = entity(artist_key)
            album_score = entity(album_key)
            # The filter keeps a superset: a token found inside a longer word,
            # or a `loose` row, can still score zero here.
            if title_score or artist_score or album_score:
                yield tracks[position], title_score, artist_score, album_score, artist_key, album_key

    def select(rows):
        artists: dict[str, tuple[float, str, Any]] = {}
        albums: dict[str, tuple[float, str, Any]] = {}

        def candidates():
            for order, row in enumerate(rows):
                track, title_score, artist_score, album_score, artist_key, album_key = row
                # `order` breaks equal (score, id) pairs by library order, as a
                # stable key-based selection would, without a key call per row.
                yield (-(title_score * 2 + artist_score + album_score), str(getattr(track, "id", "")), order, track)
                if not (artist_score or album_score):
                    continue
                artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
                album = getattr(track, "album", "") or ""
                if artist and artist_score:
                    if artist_score > artists.get(artist_key, (0.0, "", None))[0]:
                        artists[artist_key] = (artist_score, artist, track)
                if album and (album_score or artist_score):
                    key = f"{artist_key}\x00{album_key}"
                    weight = max(album_score, artist_score)
                    if weight > albums.get(key, (0.0, "", None))[0]:
                        albums[key] = (weight, album, track)

        return nsmallest(_LOCAL_TRACK_BUDGET, candidates()), artists, albums

    selection = None
    search_db = getattr(tracks, "search_db", None)
    if search_db is not None:
        try:
            with search_db.library_search_candidates(tracks, q_folded, q_tokens) as rows:
                if rows is not None:
                    selection = select(indexed(rows))
        except (sqlite3.Error, UnicodeError) as exc:
            # Partial maps are discarded; the scan below starts from scratch.
            logger.debug("Local search index unavailable, scanning the library: %s", exc)
            selection = None
    if selection is None:
        selection = select(scanned())
    best_tracks, artists, albums = selection

    out: list[dict[str, Any]] = []
    for *_, track in best_tracks:
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            catalog_item(
                item_id=f"library:track:{track.id}",
                item_type="library_track",
                source="library",
                title=getattr(track, "title", "") or "",
                subtitle=artist,
                artist=artist,
                album=getattr(track, "album", "") or "",
                duration=duration_seconds(getattr(track, "duration", None)),
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

    for key, (_, name, track) in nsmallest(_LOCAL_ENTITY_BUDGET, artists.items(), key=lambda kv: (-kv[1][0], kv[0])):
        out.append(
            catalog_item(
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

    for key, (_, name, track) in nsmallest(_LOCAL_ENTITY_BUDGET, albums.items(), key=lambda kv: (-kv[1][0], kv[0])):
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        out.append(
            catalog_item(
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
        title = clean(row.get("title_short") or row.get("title"))
        artist = clean(artist_row.get("name") or row.get("artist"))
        album = clean(album_row.get("title"))
        if title and artist:
            deezer_id = str(row.get("id") or "")
            out.append(
                catalog_item(
                    item_id=f"deezer:track:{deezer_id}",
                    item_type="track",
                    source="deezer",
                    title=title,
                    subtitle=artist,
                    artist=artist,
                    album=album,
                    duration=duration_seconds(row.get("duration")),
                    cover=deezer.image(album_row, "cover"),
                    popularity=float(row.get("rank") or 0),
                    external_ids={"deezer_id": deezer_id},
                    attribution_url=row.get("link") or "",
                    raw=deezer_track_raw(deezer_id, artist_row, album_row),
                )
            )
        artist_id = str(artist_row.get("id") or "")
        if artist and artist_id and artist_id not in seen_artists:
            seen_artists.add(artist_id)
            out.append(
                catalog_item(
                    item_id=f"deezer:artist:{artist_id}",
                    item_type="artist",
                    source="deezer",
                    title=artist,
                    subtitle="Artist",
                    artist=artist,
                    cover=deezer.image(artist_row, "picture"),
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
                catalog_item(
                    item_id=f"deezer:album:{album_id}",
                    item_type="album",
                    source="deezer",
                    title=album,
                    subtitle=artist,
                    artist=artist,
                    album=album,
                    cover=deezer.image(album_row, "cover"),
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
        mbid = normalize_recording_mbid(clean(row.get("id"), 80))
        title = clean(row.get("title"))
        credits = row.get("artist-credit") if isinstance(row.get("artist-credit"), list) else []
        credit = credits[0] if credits and isinstance(credits[0], dict) else {}
        artist_row = credit.get("artist") if isinstance(credit.get("artist"), dict) else {}
        artist = clean(credit.get("name") or artist_row.get("name"))
        artist_id = clean(artist_row.get("id"), 80)
        if mbid and title:
            out.append(catalog_item(
                item_id=f"musicbrainz:track:{mbid}",
                item_type="track",
                source="musicbrainz",
                title=title,
                subtitle=artist,
                artist=artist,
                duration=duration_seconds((row.get("length") or 0) / 1000 if row.get("length") else None),
                popularity=float(row.get("score") or 0),
                external_ids={"musicbrainz_id": mbid},
                attribution_url=f"https://musicbrainz.org/recording/{mbid}",
                raw={"musicbrainz_id": mbid},
            ))
        if artist and artist_id and artist_id not in seen_artists:
            seen_artists.add(artist_id)
            out.append(catalog_item(
                item_id=f"musicbrainz:artist:{artist_id}",
                item_type="artist",
                source="musicbrainz",
                title=artist,
                subtitle=clean(artist_row.get("disambiguation")) or "Artist",
                artist=artist,
                popularity=float(row.get("score") or 0),
                external_ids={"musicbrainz_artist_id": artist_id},
                attribution_url=f"https://musicbrainz.org/artist/{artist_id}",
                downloadable=False,
                raw={"musicbrainz_artist_id": artist_id},
            ))
        releases = row.get("releases") if isinstance(row.get("releases"), list) else []
        release = releases[0] if releases and isinstance(releases[0], dict) else {}
        album = clean(release.get("title"))
        album_id = clean(release.get("id"), 80)
        if album and album_id and album_id not in seen_albums:
            seen_albums.add(album_id)
            out.append(catalog_item(
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
    dl = engine_api()["get_downloader"](open_browser=False)
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
        video_id = clean(row.get("id") or row.get("video_id") or row.get("videoId"), 32)
        music = youtube_music_metadata(row)
        title = clean(music["title"])
        artist = clean(music["artist"])
        if not video_id or not title:
            continue
        thumbnail = clean(row.get("thumbnail"), 500)
        out.append(
            catalog_item(
                item_id=f"youtube:track:{video_id}",
                item_type="track",
                source="youtube",
                title=title,
                subtitle=artist,
                artist=artist,
                duration=duration_seconds(row.get("duration")),
                cover=thumbnail or f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                popularity=max(0.0, float(row.get("view_count") or 0)),
                external_ids={"youtube_id": video_id},
                attribution_url=f"https://www.youtube.com/watch?v={video_id}",
                playable=True,
                raw={
                    "id": video_id,
                    **music,
                    "title": title,
                    "artist": artist,
                    "duration": duration_seconds(row.get("duration")),
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
        ("library", lambda: local_catalog(query, limit)),
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


def cached_search(query: str, types: set[str], limit: int) -> tuple[dict[str, Any], bool]:
    # `v2` because the shape gained `top_result` and the sections gained
    # `layout`/`total`: a hot reload must not serve pre-migration bodies.
    key = f"v2:{limit}:{','.join(sorted(types))}:{query.casefold()}"
    return memo_resolve(catalog_memo, key, lambda: _search_uncached(query, types, limit))




class LibraryTracks(list):
    """The bound library's tracks and the database whose search index may cover them.

    Tying the database to this exact list keeps a monkeypatched or synthetic
    track list from ever being checked against somebody else's index.
    """

    __slots__ = ("search_db",)


def library_tracks() -> list[Any]:
    """The bound user's tracks, loaded once per request.

    Every catalog and discovery helper that needs to know what is already owned
    used to call this, and each call re-ran the staleness check and rebuilt the
    list. One `/api/catalog/artist` did it three times over.
    """
    return request_scope.scoped("catalog_library_tracks", _load_library_tracks)


def _load_library_tracks() -> list[Any]:
    api = engine_api()
    lib = api["get_library"]()
    try:
        lib.refresh_if_stale()
    except Exception:
        pass
    metadata = getattr(lib, "metadata", None)
    tracks = LibraryTracks(metadata.tracks if metadata and metadata.tracks else [])
    db = getattr(lib, "db", None)
    tracks.search_db = db if isinstance(db, DatabaseManager) else None
    return tracks


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
    for track in library_tracks():
        artist = getattr(track, "artist", "") or getattr(track, "album_artist", "") or ""
        album = getattr(track, "album", "") or ""
        key = _key(getattr(track, "title", "") or "", artist)
        artist_key = fold_text(artist)
        everything.add(key)
        by_artist.setdefault(artist_key, set()).add(key)
        by_album.setdefault((fold_text(album), artist_key), set()).add(key)
    return {"by_artist": by_artist, "by_album": by_album, "all": everything}


def library_artist_keys(name: str) -> set[str]:
    """Owned-track keys for library tracks credited to an artist, however either
    side spells its diacritics.

    Callers only need these keys (to badge catalog rows as already-owned) and
    whether the set is empty.
    """
    index = _library_key_index()
    name_key = fold_text(name)
    if not name_key:
        return set(index["all"])
    return set(index["by_artist"].get(name_key, ()))


def library_album_keys(album_name: str, artist: str) -> set[str]:
    """Normalized artist\x00title keys for library tracks on a given album."""
    index = _library_key_index()
    album_key = fold_text(album_name)
    artist_key = fold_text(artist)
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
