"""Transaction-local synchronization helpers; no retained metadata caches."""
from contextlib import contextmanager
import json


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
    'compressed', 'file_size', 'bitrate', 'format', 'cover_art_key', 'year', 'genre',
    'track_number', 'disc_number', 'disc_total', 'is_compilation', 'media_kind',
    'podcast_feed_id', 'podcast_episode_guid', 'podcast_rss_url', 'artists_json',
    'is_local', 'local_path', 'local_mtime_ns', 'musicbrainz_id', 'isrc', 'album_artist',
    'cover_source', 'metadata_modified_by_user', 'youtube_id', 'audio_quality',
    'audio_source', 'audio_source_url', 'audio_license_url', 'audio_identity_verified',
    'added_at',
)


def track_values(track, replacement_added_at):
    values = []
    for column in TRACK_COLUMNS:
        if column == 'artists_json':
            value = json.dumps(track.artists, ensure_ascii=False) if track.artists is not None else None
        elif column == 'added_at':
            value = replacement_added_at.get(track.id) or track.added_at
        else:
            value = getattr(track, column)
        values.append(value)
    return values


def sync_tracks(conn, tracks, replacement_added_at):
    """Read existing rows in batches; unchanged tracks never reach UPDATE."""
    columns = ','.join(TRACK_COLUMNS)
    assignments = ','.join(f'{c}=excluded.{c}' for c in TRACK_COLUMNS[1:-1])
    assignments += ',added_at=COALESCE(tracks.added_at,excluded.added_at)'
    statement = (f'INSERT INTO tracks ({columns}) VALUES ({",".join("?" for _ in TRACK_COLUMNS)}) '
                 f'ON CONFLICT(id) DO UPDATE SET {assignments}')
    catalog_indexes = [TRACK_COLUMNS.index(c) for c in CATALOG_COLUMNS]
    dirty = False
    for offset in range(0, len(tracks), 500):
        batch = tracks[offset:offset + 500]
        existing = {row[0]: tuple(row) for row in conn.execute(
            f'SELECT {columns} FROM tracks WHERE id IN ({",".join("?" for _ in batch)})', [t.id for t in batch])}
        for track in batch:
            incoming = track_values(track, replacement_added_at)
            old = existing.get(track.id)
            if old is not None:
                # The first stored date wins, even if the incoming date differs.
                incoming[-1] = old[-1] if old[-1] is not None else incoming[-1]
            if old != tuple(incoming):
                dirty |= old is None or any(old[i] != incoming[i] for i in catalog_indexes)
                conn.execute(statement, incoming)
    return dirty
