"""Canonical public-source verification and journals for partial HTTP deltas."""
from hashlib import sha256

from shared.sqlite_changes import install_changes, cursor, changes_since, MAX_KEYS


INVALIDATING_TABLES = ('tracks', 'library_tracks', 'library_state', 'playlists',
                       'playlist_tracks', 'track_id_aliases', 'artists', 'albums', 'track_artists')


def install(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS library_public_source ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1),valid INTEGER, fingerprint TEXT,ordering INTEGER,ordering_dirty INTEGER DEFAULT 1)')
    conn.execute("INSERT OR IGNORE INTO library_public_source VALUES (1,0,'',0,1)")
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


def sync_source(conn, metadata, order_changed):
    # Hash exactly the same bounded encoded rows that populate the index.
    # Re-reading a mutable model afterward could associate the wrong proof.
    from shared.library_fingerprint import TRACK_FIELDS, HEADER_FIELDS, encoded_values, track_values
    from shared.models import LibraryMetadata, Track
    if type(metadata) is not LibraryMetadata:
        return
    count = len(metadata.tracks)
    if conn.execute('SELECT COUNT(*) FROM library_tracks').fetchone()[0] != count:
        return
    proof = sha256(encoded_values((tuple(getattr(metadata, name) for name in HEADER_FIELDS), count)))
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
    conn.execute('UPDATE library_public_source SET valid=1,fingerprint=?,ordering=ordering+MAX(ordering_dirty,?),ordering_dirty=0 WHERE singleton=1',
                 (proof.hexdigest(), int(order_changed)))


def source(conn):
    row = conn.execute('SELECT valid,fingerprint,ordering FROM library_public_source WHERE singleton=1').fetchone()
    if row is None or not row[0]:
        return None
    return {'fingerprint': row[1], 'ordering': row[2], 'cursor': cursor(conn).to_list()}


def sync_track_source(conn, metadata, position, changes, previous_values, previous_fingerprint):
    """Reprove one declared edit without rereading/hashing every stored row.

    Substituting only the edited fields proves that the candidate, including
    all other fields of this track, headers and track ordering, derives from
    the verified pre-edit source. Both full-model passes remain mandatory.
    Call inside the revision-checked write transaction; errors roll it back.
    """
    from shared.library_fingerprint import fingerprint, encoded_values, track_values
    track = metadata.tracks[position]
    before = track.to_public_dict()
    if any(before[name] != value for name, value in changes.items()):
        raise ValueError('Candidate does not contain the declared edit')
    before.update(previous_values)
    if fingerprint(metadata, public_tracks={position: before}) != previous_fingerprint:
        raise ValueError('Track edit requires an unchanged canonical source')
    updated = fingerprint(metadata)
    values = track_values(track)
    encoded = encoded_values(values)
    conn.execute('INSERT INTO library_public_rows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET '
                 'hash=excluded.hash,identity=excluded.identity WHERE hash IS NOT excluded.hash OR identity IS NOT excluded.identity',
                 (track.id, sha256(encoded).digest(), str(track.file_hash or track.id or '')))
    conn.execute('UPDATE library_public_source SET valid=1,fingerprint=? WHERE singleton=1', (updated,))


def affected(conn, previous, expected, artwork_ids, identities):
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
        positions.update(conn.execute(
            f'SELECT track_id,position FROM library_tracks WHERE track_id IN ({",".join("?" for _ in batch)})', batch))
    removed = [key for key, first in canonical.items() if key not in positions and first != 'INSERT']
    order = ([row[0] for row in conn.execute('SELECT track_id FROM library_tracks ORDER BY position')]
             if previous['ordering'] != expected['ordering'] else None)
    return positions, removed, order
