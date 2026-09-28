"""When a song joined an account's library — the one definition, in one place.

"Recently added" is only as good as the date it sorts on, and that date used to
be decided separately by every code path that happened to write it. Downloading
a song you had saved weeks ago stamped the file with the moment the download
finished, so the song jumped to the top of the library as if it were new; the
pool's own date could leak into an account that had never held the song; and
hearting a downloaded song dated its entry with the moment of the heart. Each
of those was a reasonable local decision, and together they made the date
dance with whatever you last did to a song.

So the date is one fact with one rule:

**A song's library date is the moment this account first took hold of it.**

Holding a song takes two forms that can coexist — a saved entry
(``favourites.json``, :mod:`player.favourites_manager`) and a library track
backed by a file — and both carry that same moment in ``added_at``.

- **Written once, when the song enters the library**: saving it, hearting a song
  not yet held (which saves it), or downloading, importing or scanning a song
  not yet held.
- **Adopted, never rewritten, when an already-held song gains another form**:
  downloading a saved song, hearting a downloaded one, a scan finding the file
  of a saved song. :meth:`Holdings.claim` is the single decision point: an
  identity already held answers with the date it has been held since; only an
  identity held nowhere is given a new one.
- **Carried through everything that changes how a song is held without letting
  go of it**: marking and unmarking it, tag edits and re-keys, the optimizer's
  re-hashing, deleting the file of a saved song (the entry already holds the
  same date), a saved catalog row learning its video.
- **Released only when the last holding goes** — unsaving a song that has no
  file, deleting a file no entry holds. Coming back after that is a new arrival,
  which is exactly what "recently added" is for.

What the rule deliberately does not do is repair dates written before it
existed. A library whose dates are already wrong has no record of when those
songs really arrived, and inventing one would be a guess.

Two songs are "the same" here exactly when the player thinks they are: when
their identity keys intersect (:func:`track_keys` mirrors ``trackKeys`` in
``ui_web/src/lib/playbackIdentity.ts``). The engine and the player must agree on
this, or a download could be dated as new while the player shows it in place of
a song it believes has been there for weeks.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from shared.time_utils import utc_now_iso_naive

#: Library dates as the engine writes them (`isoformat()`, naive UTC) and as
#: SQLite's `CURRENT_TIMESTAMP` writes them (space separator, no fraction).
_FORMATS = ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S")


def now() -> str:
    """A library date for this instant."""
    return utc_now_iso_naive()


def parse(value: Any) -> Optional[datetime]:
    """A library date as a naive UTC datetime, or None when it is not one.

    Rows written by SQLite's own `CURRENT_TIMESTAMP` use a space separator and
    no microseconds, rows written by the engine use `isoformat()`, and an import
    may carry an explicit zone. All of them are read onto one timeline, so two
    dates can be compared as instants rather than as text.
    """
    if isinstance(value, datetime):
        moment = value
    else:
        text = str(value or "").strip()
        if not text:
            return None
        moment = None
        for fmt in _FORMATS:
            try:
                moment = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        if moment is None:
            try:
                moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return moment.replace(tzinfo=None)


def earliest(*dates: Optional[str]) -> Optional[str]:
    """The oldest of these library dates, compared as instants.

    Missing dates are ignored. A date that cannot be read loses to any that can;
    among unreadable ones the text decides, so the answer is still deterministic.
    """
    best: Optional[str] = None
    best_at: Optional[datetime] = None
    for date in dates:
        if not date:
            continue
        at = parse(date)
        if best is None:
            best, best_at = date, at
        elif at is not None and (best_at is None or at < best_at):
            best, best_at = date, at
        elif at is None and best_at is None and date < best:
            best = date
    return best


def _text(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _isrc(value: Any) -> Optional[str]:
    """ISRCs travel with or without separators and in either case."""
    raw = _text(value)
    return raw.replace("-", "").replace(" ", "").upper() if raw else None


def track_keys(track: Any) -> List[str]:
    """Every identity key a library track answers to.

    The owned-track half of ``trackKeys`` in
    ``ui_web/src/lib/playbackIdentity.ts``: the player resolves a saved entry to
    a file when their keys intersect, so this is the set the engine must match
    on to reach the same conclusion.
    """
    keys: List[str] = []

    def push(prefix: str, value: Optional[str]) -> None:
        if value:
            keys.append(f"{prefix}:{value}")

    is_podcast = getattr(track, "media_kind", None) == "podcast_episode" or bool(
        _text(getattr(track, "podcast_episode_guid", None))
    )
    if is_podcast:
        push("pod", _text(getattr(track, "podcast_episode_guid", None)))
        push("lib", _text(getattr(track, "id", None)))
    else:
        push("lib", _text(getattr(track, "id", None)))
        push("yt", _text(getattr(track, "youtube_id", None)))
    push("isrc", _isrc(getattr(track, "isrc", None)))
    push("mb", _text(getattr(track, "musicbrainz_id", None)))
    return keys


def held_since(keys: Iterable[str], tracks: Iterable[Any]) -> Optional[str]:
    """When the library tracks naming any of `keys` were first held, if any are.

    One pass and no index: this answers a single question (a save, a heart),
    where building :class:`Holdings` would cost the same and then be thrown away.
    """
    wanted = set(keys)
    if not wanted:
        return None
    return earliest(
        *(
            getattr(track, "added_at", None)
            for track in tracks
            if not wanted.isdisjoint(track_keys(track))
        )
    )


class Holdings:
    """Everything an account holds, indexed by identity key → held since.

    Built once per acquisition — a download landing, a folder scan — from the
    library's tracks and the saved entries, so a batch of thousands of files
    costs one pass rather than one per file. A holding names a song when their
    keys intersect, pairwise, exactly as the player matches an entry to a file;
    the oldest holding that names it is when the account took hold of it.
    """

    def __init__(self, tracks: Iterable[Any] = (), entries: Iterable[Dict[str, Any]] = ()):
        self._since: Dict[str, str] = {}
        for track in tracks:
            self._hold(track_keys(track), getattr(track, "added_at", None))
        for entry in entries:
            self._hold(entry.get("keys") or (), entry.get("added_at"))

    def _hold(self, keys: Iterable[str], date: Optional[str]) -> None:
        if not date:
            return
        for key in keys:
            self._since[key] = earliest(self._since.get(key), date) or date

    def since(self, keys: Iterable[str]) -> Optional[str]:
        """When any of these identities was first held, or None if none is."""
        return earliest(*(self._since.get(key) for key in keys))

    def claim(self, keys: Iterable[str], proposed: Optional[str] = None) -> str:
        """The date a song enters (or re-enters, in another form) the library.

        An identity already held answers with the date it has been held since —
        a download never makes a saved song new. Only an identity held nowhere
        takes `proposed` (a scanned file's mtime, an import's own record), or
        now. The claim is noted, so a second acquisition of the same song in the
        same batch agrees with the first.
        """
        keys = list(keys)
        date = self.since(keys) or proposed or now()
        self._hold(keys, date)
        return date
