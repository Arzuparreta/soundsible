"""Which half of a split video title is the artist.

A YouTube title carries no structure. "Artist - Song" is the convention, so the
left side is taken as the artist and that is a guess, not a reading. Uploaders
write "Song - Artist" often enough that the guess files real tracks under the
wrong name: "I Follow Rivers - Lykke Li" lands as *artist* "I Follow Rivers",
*title* "Lykke Li", and the song is then unfindable by either.

Position cannot settle it. A catalog can: ask what a real music database calls
this recording and see which orientation it agrees with. Soundsible already
talks to Deezer for discovery, so the lookup costs one cached request.

The decision is deliberately conservative. Reversing a pair is destructive —
it renames a song — so the reversed reading has to win *clearly*, against a
catalog row that is recognisably the same recording. Anything ambiguous keeps
the positional guess, which is what happens today.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from shared.resolution_confidence import _norm, _token_overlap

logger = logging.getLogger(__name__)

#: How much better the reversed reading must score before a song is renamed.
#: Deezer answers "I Follow Rivers"/"Lykke Li" for both orientations of the
#: query, so the two readings are scored against the same row and only a real
#: gap between them means anything.
_SWAP_MARGIN = 0.34

#: Below this, the row is not recognisably this song and its opinion on
#: orientation is worth nothing.
_MIN_ROW_AGREEMENT = 0.5

#: Duration is deliberately *not* consulted.
#:
#: It looks like a safety check and is a category error. Orientation is a
#: question about names, and every cut of a recording — radio edit, remix, live
#: version, the album master — shares its artist and its base title. Searching
#: the song that prompted this module returns five Lykke Li rows at 200s, 202s,
#: 222s, 238s and 401s against a 284s upload; all five answer the orientation
#: question identically and unanimously, and a duration window rejects every
#: one of them. The names carry the decision, and `_MIN_ROW_AGREEMENT` plus
#: `_SWAP_MARGIN` are what stop a different song from answering it.


@dataclass(frozen=True)
class Orientation:
    artist: str
    title: str
    swapped: bool
    reason: str


def _row_artist(row: dict[str, Any]) -> str:
    """The artist name a Deezer row carries, however it nests it."""
    value = row.get("artist")
    if isinstance(value, dict):
        value = value.get("name")
    return str(value or "").strip()


def _pair_score(artist: str, title: str, row: dict[str, Any]) -> float:
    """How well (artist, title) matches a catalog row, 0–1."""
    row_artist = _norm(_row_artist(row))
    row_title = _norm(row.get("title_short") or row.get("title") or "")
    if not row_artist or not row_title:
        return 0.0
    return (_token_overlap(_norm(artist), row_artist) + _token_overlap(_norm(title), row_title)) / 2


def choose_orientation(
    artist: str,
    title: str,
    rows: Sequence[dict[str, Any]],
) -> Orientation:
    """Pick the orientation a catalog agrees with. Pure — no network.

    `rows` are Deezer-shaped track rows. Each is asked the same question and the
    best answer in each direction is kept, so a song whose catalog entries are
    all remixes and radio edits still answers it: they disagree about which cut
    this is and agree completely about whose song it is.

    The forward reading wins every tie, every ambiguity and every empty answer,
    because it is what the caller already believes.
    """
    forward = Orientation(artist, title, False, "positional")
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not artist or not title:
        return forward

    best_straight = 0.0
    best_reversed = 0.0
    winning_row: dict[str, Any] | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        straight = _pair_score(artist, title, row)
        reversed_ = _pair_score(title, artist, row)
        if max(straight, reversed_) < _MIN_ROW_AGREEMENT:
            continue
        best_straight = max(best_straight, straight)
        if reversed_ > best_reversed:
            best_reversed, winning_row = reversed_, row

    if best_reversed - best_straight < _SWAP_MARGIN or winning_row is None:
        return forward

    # The side that becomes the artist is the one the uploader wrote *last*, so
    # it carries whatever context they appended: "Lykke Li (La Vie d'Adèle/La
    # Vida de Adele)" is a film reference, not a band. The catalog just told us
    # this artist's name, and it earned that by matching — so use it, and keep
    # our own title, which was the clean half all along.
    catalog_artist = _row_artist(winning_row) or title

    logger.info(
        "Orientation: reading %r / %r as artist %r, title %r (catalog agreement %.2f vs %.2f)",
        artist, title, catalog_artist, artist, best_reversed, best_straight,
    )
    return Orientation(catalog_artist, artist, True, "catalog")


def resolve_orientation(
    artist: str,
    title: str,
    *,
    search: Callable[[str], Sequence[dict[str, Any]]] | None = None,
) -> Orientation:
    """`choose_orientation` with the Deezer lookup wired in.

    Never raises and never blocks acquisition: a provider that is down, slow or
    unhelpful leaves the positional reading exactly as it was.
    """
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not artist or not title:
        return Orientation(artist, title, False, "positional")

    if search is None:
        def search(query: str) -> Sequence[dict[str, Any]]:
            from shared.providers import deezer

            return deezer.rows("search", {"q": query, "limit": 5})

    # Normalised, because the raw pair is what a person typed into a video
    # title. "Lykke Li (La Vie d'Adèle/La Vida de Adele)" returns *nothing* from
    # Deezer — the parenthetical is context for the upload, not part of any
    # recording's name, and it makes the query match no catalog row at all.
    # `_norm` drops brackets, punctuation and filler words, which is exactly the
    # shape a catalog can answer.
    query = " ".join(part for part in (_norm(artist), _norm(title)) if part)
    if not query:
        return Orientation(artist, title, False, "positional")

    try:
        # One query, both readings scored against its answers: the catalog does
        # not care which order the words arrived in, so asking twice would buy
        # nothing but a second round trip.
        rows = search(query) or []
    except Exception as exc:  # pragma: no cover — orientation is best-effort
        logger.debug("Orientation lookup failed for %r / %r: %s", artist, title, exc)
        return Orientation(artist, title, False, "lookup_failed")

    return choose_orientation(artist, title, rows)
