"""Canonical public-source verification and journals for partial HTTP deltas."""
from hashlib import sha256

from shared.sqlite_changes import install_changes, cursor, changes_since, MAX_KEYS


INVALIDATING_TABLES = ('tracks', 'library_tracks', 'library_state', 'playlists',
                       'playlist_tracks', 'track_id_aliases', 'artists', 'albums', 'track_artists')


def install(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS library_public_source ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1),valid INTEGER, fingerprint TEXT,ordering INTEGER,ordering_dirty INTEGER DEFAULT 1)')
    conn.execute("INSERT OR IGNORE INTO library_public_source VALUES (1,0,'',0,1)")
    # The header hash of the source with that fingerprint. Its own table, so
    # an older engine opening this database never sees an unexpected column;
    # one that saves leaves a stale fingerprint here. The reader can still
    # verify headers against a served base of the same canonical fingerprint.
    conn.execute('CREATE TABLE IF NOT EXISTS library_public_headers ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1),fingerprint TEXT,hash TEXT)')
    conn.execute('CREATE TABLE IF NOT EXISTS library_public_rows (id TEXT PRIMARY KEY,hash BLOB,identity TEXT)')
    conn.execute('CREATE INDEX IF NOT EXISTS library_public_identity ON library_public_rows(identity)')
    install_changes(conn, (('library_public_rows', 'track', 'id'),))
    for table in INVALIDATING_TABLES:
        for operation in ('INSERT', 'UPDATE', 'DELETE'):
            mutation = ('UPDATE library_public_source SET valid=0,ordering_dirty=1 '
                        'WHERE singleton=1 AND (valid=1 OR ordering_dirty=0);'
                        if table == 'library_tracks' else
                        'UPDATE library_public_source SET valid=0 WHERE singleton=1 AND valid=1;')
            conn.execute(f'CREATE TRIGGER IF NOT EXISTS invalidate_public_{table}_{operation} '
                         f'AFTER {operation} ON {table} BEGIN {mutation} END')


def sync_source(conn, metadata, order_changed, headers):
    """Prove the committed source inside the caller's write transaction.

    `headers` is the detached `public_headers()` snapshot the caller also
    persisted, so the proof, the header hash and the stored headers are the
    same values. Track rows are hashed exactly as they populate the index:
    re-reading a mutable model afterwards could associate the wrong proof.
    """
    from shared.library_fingerprint import (TRACK_FIELDS, HEADER_FIELDS, encoded_values, header_digest,
                                            record, track_values)
    from shared.models import LibraryMetadata, Track
    if type(metadata) is not LibraryMetadata:
        return
    count = len(metadata.tracks)
    if conn.execute('SELECT COUNT(*) FROM library_tracks').fetchone()[0] != count:
        return
    proof = sha256(encoded_values((tuple(headers[name] for name in HEADER_FIELDS), count)))
    conn.execute('DELETE FROM library_public_rows WHERE id NOT IN (SELECT track_id FROM library_tracks)')
    for offset in range(0, count, 500):
        batch = metadata.tracks[offset:offset + 500]
        stored = {row[0]: (row[1], row[2]) for row in conn.execute(
            'SELECT lt.track_id,lt.position,p.hash FROM library_tracks lt '
            'LEFT JOIN library_public_rows p ON p.id=lt.track_id '
            f'WHERE lt.track_id IN ({",".join("?" for _ in batch)})', [t.id for t in batch])}
        for position, track in enumerate(batch, offset):
            track_id = track.id
            previous = stored.get(track_id)
            if type(track) is not Track or previous is None or previous[0] != position:
                return
            values = track_values(track)
            if values[TRACK_FIELDS.index("id")] != track_id:
                return
            encoded = encoded_values(values)
            proof.update(encoded)
            value = sha256(encoded).digest()
            if previous[1] != value:
                conn.execute('INSERT INTO library_public_rows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET '
                             'hash=excluded.hash,identity=excluded.identity',
                             (track_id, value, str(values[TRACK_FIELDS.index("file_hash")] or track_id or '')))
    conn.execute('UPDATE library_public_source SET valid=1,fingerprint=?,'
                 'ordering=ordering+MAX(ordering_dirty,?),ordering_dirty=0 WHERE singleton=1',
                 (proof.hexdigest(), int(order_changed)))
    conn.execute('INSERT OR REPLACE INTO library_public_headers VALUES (1,?,?)',
                 (proof.hexdigest(), header_digest(headers)))
    # Readers then need not hash this exact model again to know it. If the
    # transaction rolls back the hint is merely unused: it never matches a
    # committed fingerprint that describes other content.
    record(metadata, proof.hexdigest())


def source(conn):
    row = conn.execute('SELECT s.valid,s.fingerprint,s.ordering,h.hash,EXISTS(SELECT 1 FROM library_tracks) '
                       'FROM library_public_source s '
                       'LEFT JOIN library_public_headers h ON h.fingerprint=s.fingerprint '
                       'WHERE s.singleton=1').fetchone()
    if row is None or not row[0]:
        return None
    return {'fingerprint': row[1], 'ordering': row[2], 'headers': row[3], 'tracks': bool(row[4]),
            'cursor': cursor(conn).to_list()}


def sync_track_source(conn, metadata, position, changes, previous_values, previous_fingerprint):
    """Reprove one declared edit without rereading/hashing every stored row.

    Substituting only the edited fields proves that the candidate, including
    all other fields of this track, headers and track ordering, derives from
    the verified pre-edit source. Both proofs and the row/header hashes use
    the same detached values for the edited row and headers.
    Call inside the revision-checked write transaction; errors roll it back.
    """
    from shared.library_fingerprint import header_digest, public_row_digest, record, track_edit_fingerprints
    tracks = metadata.tracks
    headers = metadata.public_headers()
    after = tracks[position].to_public_dict()
    if any(after[name] != value for name, value in changes.items()):
        raise ValueError('Candidate does not contain the declared edit')
    before, updated = track_edit_fingerprints(headers, tracks, position, after | previous_values, after)
    if before != previous_fingerprint:
        raise ValueError('Track edit requires an unchanged canonical source')
    conn.execute('INSERT INTO library_public_rows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET '
                 'hash=excluded.hash,identity=excluded.identity WHERE hash IS NOT excluded.hash OR identity IS NOT excluded.identity',
                 (after['id'], public_row_digest(after), str(after['file_hash'] or after['id'] or '')))
    conn.execute('UPDATE library_public_source SET valid=1,fingerprint=? WHERE singleton=1', (updated,))
    # The check above proved these headers are the committed ones. Writing
    # their hash also gives a database upgraded before it had one its deltas.
    conn.execute('INSERT OR REPLACE INTO library_public_headers VALUES (1,?,?)',
                 (updated, header_digest(headers)))
    record(metadata, updated)


def affected(conn, previous, expected, artwork_ids, identities):
    """Changes from `previous` to the committed `expected` source, or None.

    Returns `(positions, removed, order)`: each affected current track id maps
    to its committed position and row hash, so a caller can check the rows it
    sends without hashing the rest of the library.
    """
    from shared.sqlite_changes import Cursor
    if source(conn) != expected:
        return None
    events = changes_since(conn, Cursor.parse(previous['cursor']), Cursor.parse(expected['cursor']))
    if events is None:
        return None
    canonical = {key: operation for kind, key, operation in events}
    ids = set(canonical) | set(artwork_ids)
    identities = list(identities)
    for offset in range(0, len(identities), 500):
        batch = identities[offset:offset + 500]
        ids.update(row[0] for row in conn.execute(
            f'SELECT id FROM library_public_rows WHERE identity IN ({",".join("?" for _ in batch)}) LIMIT ?',
            [*batch, MAX_KEYS + 1]))
        if len(ids) > MAX_KEYS:
            return None
    if len(ids) > MAX_KEYS:
        return None
    positions = {}
    keys = list(ids)
    for offset in range(0, len(keys), 500):
        batch = keys[offset:offset + 500]
        positions.update((track_id, (position, digest)) for track_id, position, digest in conn.execute(
            'SELECT lt.track_id,lt.position,p.hash FROM library_tracks lt '
            'LEFT JOIN library_public_rows p ON p.id=lt.track_id '
            f'WHERE lt.track_id IN ({",".join("?" for _ in batch)})', batch))
    removed = [key for key, first in canonical.items() if key not in positions and first != 'INSERT']
    order = ([row[0] for row in conn.execute('SELECT track_id FROM library_tracks ORDER BY position')]
             if previous['ordering'] != expected['ordering'] else None)
    return positions, removed, order
