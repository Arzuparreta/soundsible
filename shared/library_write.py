"""Transaction-local synchronization helpers; no retained metadata caches."""
from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import json
from operator import attrgetter, itemgetter

from shared.library_fingerprint import HEADER_FIELDS, TRACK_FIELDS, encoded_values
from shared.models import Track


@contextmanager
def disk_staging(conn):
    """Bound scratch pages for this write and restore the pooled connection."""
    store = conn.execute('PRAGMA temp_store').fetchone()[0]
    cache = conn.execute('PRAGMA temp.cache_size').fetchone()[0]
    conn.execute('PRAGMA temp_store=FILE')
    conn.execute('PRAGMA temp.cache_size=-512')
    try:
        yield
    finally:
        conn.execute(f'PRAGMA temp_store={store}')
        conn.execute(f'PRAGMA temp.cache_size={cache}')


@contextmanager
def staged_rows(conn, table, columns, keys, rows):
    # Names are internal constants. One helper invocation at a time per writer.
    name = '_incoming_library_rows'
    names = ','.join(columns)
    conn.execute(f'CREATE TEMP TABLE {name} AS SELECT {names} FROM {table} WHERE 0')
    try:
        conn.executemany(f'INSERT INTO {name} VALUES ({",".join("?" for _ in columns)})', rows)
        # Build after loading to avoid maintaining the scratch index per row.
        conn.execute(f'CREATE UNIQUE INDEX temp._incoming_library_key ON {name} ({",".join(keys)})')
        yield name
    finally:
        conn.execute(f'DROP TABLE IF EXISTS temp.{name}')


def sync_rows(conn, table, columns, keys, rows, *, delete_changed=False):
    """Persist only differences; stage keys/values in SQLite, not Python maps."""
    with staged_rows(conn, table, columns, keys, rows) as incoming:
        match = ' AND '.join(f'n.{k} IS {table}.{k}' for k in keys)
        values = [c for c in columns if c not in keys]
        difference = ' OR '.join(f'{table}.{c} IS NOT n.{c}' for c in values) or '0'
        conn.execute(f'DELETE FROM {table} WHERE NOT EXISTS (SELECT 1 FROM {incoming} n WHERE {match})')
        if delete_changed:
            # Ordered credits also have UNIQUE(track_id, artist_id). Remove
            # changed positions first so swapping two credits cannot collide.
            conn.execute(f'DELETE FROM {table} WHERE EXISTS (SELECT 1 FROM {incoming} n WHERE {match} AND ({difference}))')
        assignments = ','.join(f'{c}=excluded.{c}' for c in values)
        changed = ' OR '.join(f'{table}.{c} IS NOT excluded.{c}' for c in values)
        conflict = f'DO UPDATE SET {assignments} WHERE {changed}' if values else 'DO NOTHING'
        conn.execute(f'INSERT INTO {table} ({",".join(columns)}) SELECT {",".join(columns)} FROM {incoming} WHERE 1 '
                     f'ON CONFLICT({",".join(keys)}) {conflict}')


CATALOG_COLUMNS = ('artist', 'artists_json', 'album', 'album_artist', 'year', 'genre', 'is_compilation', 'media_kind')


TRACK_COLUMNS = (
    'id', 'title', 'artist', 'album', 'duration', 'file_hash', 'original_filename',
    'file_size', 'bitrate', 'format', 'cover_art_key', 'year', 'genre',
    'track_number', 'disc_number', 'disc_total', 'is_compilation', 'media_kind',
    'podcast_feed_id', 'podcast_episode_guid', 'podcast_rss_url', 'artists_json',
    'is_local', 'local_path', 'local_mtime_ns', 'musicbrainz_id', 'isrc', 'album_artist',
    'cover_source', 'metadata_modified_by_user', 'youtube_id', 'audio_quality',
    'added_at',
)


_TRACK_ATTRIBUTES = tuple('artists' if column == 'artists_json' else column for column in TRACK_COLUMNS) + ('item_id',)
_snapshot_track = attrgetter(*_TRACK_ATTRIBUTES)
_public_values = itemgetter(*(_TRACK_ATTRIBUTES.index(field) for field in TRACK_FIELDS))
_ARTISTS = _TRACK_ATTRIBUTES.index('artists')
_ADDED_AT = _TRACK_ATTRIBUTES.index('added_at')
_FILE_HASH = _TRACK_ATTRIBUTES.index('file_hash')


def sync_tracks(conn, tracks, track_ids, replacement_added_at, headers):
    """Persist and hash each track from one observation of its values."""
    columns = ','.join(TRACK_COLUMNS)
    assignments = ','.join(f'{c}=excluded.{c}' for c in TRACK_COLUMNS[1:-1])
    assignments += ',added_at=COALESCE(tracks.added_at,excluded.added_at)'
    statement = (f'INSERT INTO tracks ({columns}) VALUES ({",".join("?" for _ in TRACK_COLUMNS)}) '
                 f'ON CONFLICT(id) DO UPDATE SET {assignments}')
    catalog_indexes = [TRACK_COLUMNS.index(c) for c in CATALOG_COLUMNS]
    dirty = False
    verified = True
    proof = sha256(encoded_values((tuple(headers[name] for name in HEADER_FIELDS), len(tracks))))
    for offset in range(0, len(tracks), 500):
        batch = tracks[offset:offset + 500]
        keys = track_ids[offset:offset + 500]
        existing = {row[0]: (tuple(row[:-1]), row[-1]) for row in conn.execute(
            f'SELECT t.{columns.replace(",", ",t.")},p.hash FROM tracks t '
            'LEFT JOIN library_public_rows p ON p.id=t.id '
            f'WHERE t.id IN ({",".join("?" for _ in keys)})', keys)}
        for track, track_id in zip(batch, keys):
            values = list(_snapshot_track(track))
            if values[0] != track_id:
                raise ValueError('Track identity changed during the library save')
            old, old_hash = existing.get(track_id, (None, None))
            added_at = replacement_added_at.get(track_id) or values[_ADDED_AT]
            if old is not None:
                # The first stored date wins, even if the incoming date differs.
                added_at = old[_ADDED_AT] if old[_ADDED_AT] is not None else added_at
            track.added_at = values[_ADDED_AT] = added_at
            artists = values[_ARTISTS]
            if type(artists) is list and all(type(name) is str for name in artists):
                artists = artists.copy()
            elif artists is not None:
                artists = deepcopy(artists)
            values[_ARTISTS] = artists
            if type(track) is Track:
                encoded = encoded_values(_public_values(values))
                proof.update(encoded)
                row_hash = sha256(encoded).digest()
                if row_hash != old_hash:
                    conn.execute('INSERT INTO library_public_rows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET '
                                 'hash=excluded.hash,identity=excluded.identity',
                                 (track_id, row_hash, str(values[_FILE_HASH] or track_id or '')))
            else:
                verified = False
            values[_ARTISTS] = json.dumps(artists, ensure_ascii=False) if artists is not None else None
            incoming = tuple(values[:-1])  # item_id is stored in collection_files.
            if old != incoming:
                dirty |= old is None or any(old[i] != incoming[i] for i in catalog_indexes)
                conn.execute(statement, incoming)
    return dirty, proof.hexdigest() if verified else None
