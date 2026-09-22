"""Verified on-disk candidates for local catalog search; no resident copies.

`library_search` holds each library track's title, artist and album already
folded exactly as the catalog ranker folds them. A search reads back only the
rows that can score above zero, in library order, and ranks those. The index is
used only when a fingerprint proves it describes the caller's in-memory model:
unsaved edits, raw SQL and other writers make it fall back to a full scan
instead of returning different results.
"""
from hashlib import blake2b
import logging
from operator import attrgetter
from pickle import Pickler
import platform
import sqlite3
import sys
import unicodedata

from shared.text_utils import fold_text, match_tokens, strip_release_junk

logger = logging.getLogger(__name__)

# Bump when stored values, triggers or the candidate filter change meaning.
# The interpreter release and its Unicode data are part of VERSION because
# casefolding, decomposition and `\w` tokenization depend on them.
INDEX_FORMAT = 1
VERSION = (f"{INDEX_FORMAT}:{sys.implementation.name}-{platform.python_version()}:"
           f"{unicodedata.unidata_version}")

# Fingerprints encode rows in chunks of this size, identically on both sides.
CHUNK = 512
_FIELDS = attrgetter("title", "artist", "album_artist", "album")
_SEARCH_FIELDS = ("id", "title", "artist", "album_artist", "album")
_COLUMNS = {
    'library_search': ('track_id', 'position', 'title', 'artist', 'album', 'loose'),
    'library_search_state': ('singleton', 'valid', 'version', 'fingerprint', 'syncing'),
}
_OBJECTS = {
    *_COLUMNS,
    *(f'library_search_tracks_{op}' for op in ('insert', 'update', 'delete')),
    *(f'library_search_order_{op}' for op in ('insert', 'update', 'delete')),
    *(f'library_search_rows_{op}' for op in ('insert', 'update', 'delete', 'position')),
}


def search_title(value: object) -> str:
    """A title as the ranker compares it."""
    return fold_text(strip_release_junk(value))


def search_text(value: object) -> str:
    """An artist or album as the ranker compares it."""
    return fold_text(value)


def _loose(text: str) -> bool:
    # The candidate filter treats query tokens as substrings of the stored text.
    # Flag any row where a ranker token is not one, rather than assume folding
    # is idempotent on every string.
    return any(token not in text for token in match_tokens(text))


def search_row(track_id, title, artist, album_artist, album) -> tuple:
    """One index row from raw stored values, mirroring `_local_catalog`."""
    title = search_title(title or "")
    artist = search_text(artist or album_artist or "")
    album = search_text(album or "")
    return track_id, title, artist, album, int(_loose(title) or _loose(artist) or _loose(album))


def _objects(conn) -> set[str]:
    names = conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')")
    return {row[0] for row in names} & _OBJECTS


def install(conn) -> None:
    """Create the index objects; any that were missing force a full rebuild.

    Stale rows are found through the triggers below. A table or trigger that
    had to be recreated means changes may have gone unrecorded, so no stored
    row is trusted afterwards.
    """
    existing = _objects(conn)
    for table, columns in _COLUMNS.items():
        stored = tuple(row[1] for row in conn.execute(f'PRAGMA table_info({table})'))
        if stored and stored != columns:
            # Derived data in another index format: recreate it.
            conn.execute(f'DROP TABLE {table}')
            existing.discard(table)
    conn.execute('CREATE TABLE IF NOT EXISTS library_search_state ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), valid INTEGER NOT NULL, '
                 'version TEXT NOT NULL, fingerprint TEXT NOT NULL, syncing INTEGER NOT NULL)')
    conn.execute("INSERT OR IGNORE INTO library_search_state VALUES (1, 0, '', '', 0)")
    # `position` mirrors library_tracks so a search needs no join to order rows.
    conn.execute('CREATE TABLE IF NOT EXISTS library_search ('
                 'track_id TEXT PRIMARY KEY, position INTEGER NOT NULL, title TEXT NOT NULL, '
                 'artist TEXT NOT NULL, album TEXT NOT NULL, loose INTEGER NOT NULL) WITHOUT ROWID')
    # Triggers live in the database file, so raw SQL and older engines that
    # know nothing about this index still invalidate it.
    invalidate = 'UPDATE library_search_state SET valid=0 WHERE singleton=1 AND valid=1;'
    changed = ' OR '.join(f'OLD.{name} IS NOT NEW.{name}' for name in _SEARCH_FIELDS)
    triggers = {
        'library_search_tracks_insert':
            f'AFTER INSERT ON tracks BEGIN DELETE FROM library_search WHERE track_id=NEW.id; {invalidate} END',
        'library_search_tracks_update':
            f'AFTER UPDATE OF {",".join(_SEARCH_FIELDS)} ON tracks WHEN {changed} BEGIN '
            f'DELETE FROM library_search WHERE track_id IN (OLD.id, NEW.id); {invalidate} END',
        'library_search_tracks_delete':
            f'AFTER DELETE ON tracks BEGIN DELETE FROM library_search WHERE track_id=OLD.id; {invalidate} END',
        'library_search_order_insert': f'AFTER INSERT ON library_tracks BEGIN {invalidate} END',
        # Moves only the rows whose position changed; `sync` then checks that
        # every stored position matches before trusting the index again.
        'library_search_order_update':
            'AFTER UPDATE OF track_id, position ON library_tracks '
            'WHEN OLD.track_id IS NOT NEW.track_id OR OLD.position IS NOT NEW.position BEGIN '
            f'UPDATE library_search SET position=NEW.position WHERE track_id=NEW.track_id; {invalidate} END',
        'library_search_order_delete': f'AFTER DELETE ON library_tracks BEGIN {invalidate} END',
    }
    # A missing row is refolded and a wrong position is caught by `sync`, so
    # those only invalidate. Folded values written by anything but `sync`
    # cannot be told apart from good ones: rebuild them all.
    rebuild = ('WHEN NOT (SELECT syncing FROM library_search_state WHERE singleton=1) '
               "BEGIN UPDATE library_search_state SET valid=0, version='' WHERE singleton=1; END")
    triggers.update({
        'library_search_rows_delete': f'AFTER DELETE ON library_search BEGIN {invalidate} END',
        'library_search_rows_position': f'AFTER UPDATE OF position ON library_search BEGIN {invalidate} END',
        'library_search_rows_insert': f'AFTER INSERT ON library_search {rebuild}',
        'library_search_rows_update':
            f'AFTER UPDATE OF track_id, title, artist, album, loose ON library_search {rebuild}',
    })
    for name, body in triggers.items():
        conn.execute(f'CREATE TRIGGER IF NOT EXISTS {name} {body}')
    if existing != _OBJECTS:
        conn.execute("UPDATE library_search_state SET valid=0, version='' WHERE singleton=1")


class _Digest:
    __slots__ = ('digest',)

    def __init__(self):
        self.digest = blake2b(digest_size=32)

    def write(self, data):
        self.digest.update(data)


def _encoder():
    writer = _Digest()
    encoder = Pickler(writer, protocol=5)
    encoder.fast = True  # Values, not Python object-sharing topology.
    return writer, encoder


def model_fingerprint(tracks) -> str | None:
    """The search fields of an in-memory track list, or None if not encodable.

    IDs are left out on purpose: the ranker takes them from the model, and
    matching positions depend only on these fields and their order.
    """
    writer, encoder = _encoder()
    try:
        for offset in range(0, len(tracks), CHUNK):
            encoder.dump(list(map(_FIELDS, tracks[offset:offset + CHUNK])))
    except Exception:
        return None
    return writer.digest.hexdigest()


class _Rebuild(Exception):
    """Stored index rows disagree with the library; fold them all again."""


def _stored_fingerprint(conn) -> str | None:
    """The same fingerprint over the stored library, or None if it has gaps.

    Reads every library row with its index row, so it also proves each index
    row exists and carries its track's position.
    """
    count = conn.execute('SELECT COUNT(*) FROM library_tracks').fetchone()[0]
    writer, encoder = _encoder()
    cursor = conn.cursor()
    cursor.row_factory = None
    try:
        cursor.execute('SELECT lt.position, s.position, t.title, t.artist, t.album_artist, t.album '
                       'FROM library_tracks lt JOIN tracks t ON t.id = lt.track_id '
                       'JOIN library_search s ON s.track_id = lt.track_id ORDER BY lt.position')
        expected = 0
        while rows := cursor.fetchmany(CHUNK):
            for row in rows:
                # Candidate positions index the model directly.
                if row[0] != expected:
                    return None
                if row[1] != row[0]:
                    raise _Rebuild
                expected += 1
            encoder.dump([row[2:] for row in rows])
    finally:
        cursor.close()
    # Orphans were removed, so equal counts mean every row is indexed.
    return writer.digest.hexdigest() if expected == count else None


def _insert_missing(conn) -> None:
    """Fold only rows the triggers removed or that were never indexed."""
    cursor = conn.cursor()
    cursor.row_factory = None
    select = ('SELECT lt.track_id, lt.position, t.title, t.artist, t.album_artist, t.album '
              'FROM library_tracks lt JOIN tracks t ON t.id = lt.track_id '
              'WHERE {} NOT EXISTS (SELECT 1 FROM library_search s WHERE s.track_id = lt.track_id) '
              'ORDER BY lt.track_id LIMIT ?')
    rows = cursor.execute(select.format(''), (CHUNK,)).fetchall()
    while rows:
        conn.executemany('INSERT INTO library_search VALUES (?, ?, ?, ?, ?, ?)',
                         [(track_id, position, *search_row(track_id, *values)[1:])
                          for track_id, position, *values in rows])
        rows = cursor.execute(select.format('lt.track_id > ? AND'), (rows[-1][0], CHUNK)).fetchall()
    cursor.close()


def _repair(conn) -> str | None:
    conn.execute('DELETE FROM library_search WHERE track_id NOT IN (SELECT track_id FROM library_tracks)')
    _insert_missing(conn)
    return _stored_fingerprint(conn)


def sync(conn) -> None:
    """Bring the index up to date inside the caller's write transaction.

    Never raises: the index is disposable, the canonical write around it is
    not. A failure leaves it invalid, and searches scan the library instead.
    """
    conn.execute('SAVEPOINT library_search')
    try:
        if _objects(conn) != _OBJECTS:
            install(conn)
        valid, version = conn.execute(
            'SELECT valid, version FROM library_search_state WHERE singleton=1').fetchone()
        if valid != 1 or version != VERSION:
            conn.execute('UPDATE library_search_state SET syncing=1 WHERE singleton=1')
            try:
                if version != VERSION:
                    raise _Rebuild
                fingerprint = _repair(conn)
            except _Rebuild:
                conn.execute('DELETE FROM library_search')
                fingerprint = _repair(conn)
            if fingerprint is not None:
                conn.execute('UPDATE library_search_state SET valid=1, version=?, fingerprint=? WHERE singleton=1',
                             (VERSION, fingerprint))
            conn.execute('UPDATE library_search_state SET syncing=0 WHERE singleton=1')
    except Exception:
        logger.exception('Local search index could not be updated; searches will scan the library')
        conn.execute('ROLLBACK TO library_search')
        try:
            conn.execute('UPDATE library_search_state SET valid=0 WHERE singleton=1')
        except sqlite3.Error:
            pass
    finally:
        conn.execute('RELEASE library_search')


def _candidate_query(q_folded: str, q_tokens: frozenset[str]) -> tuple[str, list[str]]:
    """Rows with any field the ranker can score above zero.

    A positive score needs the folded query inside the field (exact, prefix
    and contains tiers) or every query token among the field's tokens. Tokens
    of rows that are not `loose` are substrings of the stored text, so testing
    them as substrings keeps every such row. `instr` compares UTF-8 at
    character boundaries, which is Python's `in` for these strings.
    """
    tokens = [] if q_tokens == {q_folded} else sorted(q_tokens)

    def field(column: str) -> str:
        condition = f'instr(s.{column}, ?1) > 0'
        if tokens:
            every = ' AND '.join(f'instr(s.{column}, ?{i}) > 0' for i in range(2, len(tokens) + 2))
            condition = f'({condition} OR ({every}))'
        return condition

    where = ' OR '.join(field(column) for column in ('title', 'artist', 'album'))
    sql = ('SELECT position, title, artist, album FROM library_search s '
           f'WHERE s.loose OR {where} ORDER BY position')
    return sql, [q_folded, *tokens]


def candidates(conn, tracks, q_folded: str, q_tokens: frozenset[str]):
    """Library-ordered `(position, title, artist, album)` rows, or None.

    Call inside a read transaction so the state and the rows share one
    snapshot. None means the index cannot be proven to describe `tracks`.
    """
    state = conn.execute(
        'SELECT valid, version, fingerprint FROM library_search_state WHERE singleton=1').fetchone()
    if state is None or state[0] != 1 or state[1] != VERSION:
        return None
    if model_fingerprint(tracks) != state[2]:
        return None
    if not q_folded:
        return iter(())
    sql, params = _candidate_query(q_folded, q_tokens)
    cursor = conn.cursor()
    cursor.row_factory = None
    return cursor.execute(sql, params)
