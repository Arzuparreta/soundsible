"""Account-owned musical items, independent of their playback sources.

Only admission and migration reconcile external identities. Normal reads join
persisted item/source relations; they never rename a playlist as audio changes.
The file catalogue remains a catalogue of bytes, not the user's collection.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import uuid

from shared.library_dates import earliest, now, track_keys
from shared.library_lifecycle import serialized
from shared.url_utils import validate_youtube_video_id


def create_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS collection_items (
        id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, added_at TEXT,
        saved INTEGER NOT NULL DEFAULT 0, favourite INTEGER NOT NULL DEFAULT 0,
        favourited_at TEXT, saved_position INTEGER NOT NULL DEFAULT 0)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS collection_keys (
        key TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES collection_items(id),
        PRIMARY KEY(key, item_id))''')
    conn.execute('''CREATE INDEX IF NOT EXISTS collection_keys_item ON collection_keys(item_id)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS collection_files (
        file_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES collection_items(id))''')
    conn.execute('''CREATE INDEX IF NOT EXISTS collection_files_item ON collection_files(item_id)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS collection_sources (
        item_id TEXT NOT NULL REFERENCES collection_items(id), kind TEXT NOT NULL,
        source_id TEXT NOT NULL, PRIMARY KEY(item_id,kind,source_id))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS collection_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL)''')
    conn.execute('CREATE TABLE IF NOT EXISTS collection_migrations (name TEXT PRIMARY KEY)')
    conn.execute('CREATE INDEX IF NOT EXISTS playlist_collection_item ON playlist_tracks(track_id)')
    # Existing databases retain the portable table shape. Enforce the new
    # referential invariant on every write, without rebuilding legacy tables.
    for operation in ('INSERT', 'UPDATE'):
        conn.execute(f'''CREATE TRIGGER IF NOT EXISTS collection_playlist_{operation}
            BEFORE {operation} ON playlist_tracks WHEN
            EXISTS(SELECT 1 FROM collection_state WHERE singleton=1) AND
            NOT EXISTS(SELECT 1 FROM collection_items WHERE id=NEW.track_id)
            BEGIN SELECT RAISE(ABORT,'Playlist requires a collection item'); END''')


def ready(conn):
    return conn.execute('SELECT 1 FROM collection_state WHERE singleton=1').fetchone() is not None


def library_ready(conn):
    return ready(conn) and conn.execute("SELECT 1 FROM collection_migrations WHERE name='legacy-playlists'").fetchone() is not None


def bump(conn):
    conn.execute('UPDATE collection_state SET revision=revision+1 WHERE singleton=1')


def item_for_keys(conn, keys):
    """Resolve exact evidence only when it names one item, never first-wins.

    File and internal references are authoritative. Provider evidence is
    deliberately non-unique: two editions/files may share a video or ISRC.
    Conflicting evidence is not permission to merge people's collection rows.
    """
    keys = list(dict.fromkeys(key for key in keys if isinstance(key, str) and key))
    for key in keys:
        if key.startswith('item:'):
            row = conn.execute('SELECT id FROM collection_items WHERE id=?', (key[5:],)).fetchone()
            if row:
                return row[0]
        if key.startswith('lib:'):
            row = conn.execute('SELECT item_id FROM collection_files WHERE file_id=?', (key[4:],)).fetchone()
            if row:
                return row[0]
            previous = conn.execute('SELECT item_id FROM collection_keys WHERE key=?', (key,)).fetchall()
            if len(previous) == 1:
                return previous[0][0]
    if not keys:
        return None
    ids = {row[0] for row in conn.execute(
        f'SELECT DISTINCT item_id FROM collection_keys WHERE key IN ({",".join("?" for _ in keys)})', keys)}
    return next(iter(ids)) if len(ids) == 1 else None


def admission_item(conn, keys):
    item_id = item_for_keys(conn, keys)
    if item_id is not None:
        return item_id
    # A directly selected stream remains that stream when several different
    # file editions share its provenance. Reuse its admitted entity on retries.
    videos = [key[3:] for key in keys if key.startswith('yt:')]
    candidates = set()
    for video in videos:
        candidates.update(row[0] for row in conn.execute('''SELECT s.item_id FROM collection_sources s
            WHERE s.kind='youtube' AND s.source_id=? AND NOT EXISTS
            (SELECT 1 FROM collection_files f WHERE f.item_id=s.item_id)''', (video,)))
    return next(iter(candidates)) if len(candidates) == 1 else None


def admit(conn, entry, *, initial_id=None):
    """Admit a musical item, retaining a stable id through every source change."""
    keys = entry.get('keys') or []
    item_id = admission_item(conn, [f'item:{entry["item_id"]}'] + keys if entry.get('item_id') else keys)
    if item_id is None:
        item_id = initial_id or str(uuid.uuid4())
        conn.execute('INSERT INTO collection_items(id,snapshot,added_at) VALUES (?,?,?)',
                     (item_id, json.dumps(entry, ensure_ascii=False), entry['added_at'] if 'added_at' in entry else now()))
    else:
        row = conn.execute('SELECT snapshot,added_at,saved FROM collection_items WHERE id=?', (item_id,)).fetchone()
        snapshot = json.loads(row[0])
        if snapshot.get('unavailable') and entry.get('title'):
            snapshot.update({key: entry[key] for key in ('title', 'artist', 'duration') if key in entry})
            snapshot.pop('unavailable', None)
        from shared.collection_entries import _fill_snapshot
        _fill_snapshot(snapshot, entry)
        encoded = json.dumps(snapshot, ensure_ascii=False)
        held = row[2] or conn.execute('SELECT 1 FROM collection_files WHERE item_id=? LIMIT 1', (item_id,)).fetchone() or conn.execute(
            'SELECT 1 FROM playlist_tracks WHERE track_id=? LIMIT 1', (item_id,)).fetchone()
        date = earliest(row[1], entry.get('added_at')) if held else entry.get('added_at', now())
        if encoded != row[0] or date != row[1]:
            conn.execute('UPDATE collection_items SET snapshot=?,added_at=? WHERE id=?', (encoded, date, item_id))
    conn.executemany('INSERT OR IGNORE INTO collection_keys(key,item_id) VALUES (?,?)',
                     ((key, item_id) for key in keys))
    conn.executemany('INSERT OR IGNORE INTO collection_sources VALUES (?,?,?)',
                     ((item_id, 'youtube', key[3:]) for key in keys if key.startswith('yt:') and validate_youtube_video_id(key[3:])))
    return item_id


def reference(conn, value):
    """Compatibility boundary for old playlist/file/provider references."""
    if conn.execute('SELECT 1 FROM collection_items WHERE id=?', (value,)).fetchone():
        return value
    match = item_for_keys(conn, [f'lib:{value}'])
    if match:
        return match
    alias = conn.execute('SELECT new_track_id FROM track_id_aliases WHERE old_track_id=?', (value,)).fetchone()
    if alias:
        match = item_for_keys(conn, [f'lib:{alias[0]}'])
        if match:
            return match
    # A raw preview id is only interpreted here, on admission/migration.
    match = item_for_keys(conn, [f'yt:{value}'])
    if match:
        return match
    return admit(conn, {'keys': [f'yt:{value}'] if len(value) == 11 else [f'legacy:{value}'],
                        'title': value, 'artist': '', 'unavailable': True}, initial_id=value)


def _legacy_reference_evidence(current, db_path):
    """Strong, unique evidence from the pre-SQLite backup, read only once."""
    from shared.models import LibraryMetadata
    backup = Path(db_path).with_name('library.json.pre-sqlite.bak')
    if not backup.is_file():
        return {}
    current_ids = {track.id for track in current.tracks}
    unresolved = {
        track_id
        for track_ids in current.playlists.values()
        if isinstance(track_ids, list)
        for track_id in track_ids
        if isinstance(track_id, str) and track_id not in current_ids
    }
    if not unresolved:
        return {}

    try:
        legacy = LibraryMetadata.from_json(backup.read_text(encoding="utf-8"))
    except OSError:
        return {}

    legacy_by_id = {track.id: track for track in legacy.tracks}
    fields = ("youtube_id", "musicbrainz_id", "isrc")
    indexes: dict[str, dict[str, set[str]]] = {
        field: {} for field in fields
    }
    for track in current.tracks:
        for field in fields:
            value = getattr(track, field, None)
            if isinstance(value, str) and value.strip():
                key = value.strip() if field == "youtube_id" else value.strip().lower()
                indexes[field].setdefault(key, set()).add(track.id)

    replacements: dict[str, str] = {}
    for old_id in unresolved:
        old_track = legacy_by_id.get(old_id)
        if old_track is None:
            continue
        candidates: set[str] | None = None
        for field in fields:
            value = getattr(old_track, field, None)
            if not isinstance(value, str) or not value.strip():
                continue
            key = value.strip() if field == "youtube_id" else value.strip().lower()
            matches = indexes[field].get(key, set())
            if matches:
                candidates = set(matches) if candidates is None else candidates & matches
        if candidates is not None and len(candidates) == 1:
            replacements[old_id] = next(iter(candidates))
    return replacements


def _legacy_saved(path):
    """Read once. Keep the original JSON as restoration data, never authority."""
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding='utf-8'))
    from shared.collection_entries import _bare_entry, _stored_entry
    values = data.get('saved', data.get('favourites', []))
    if not isinstance(values, list):
        raise ValueError('Invalid legacy saved songs')
    entries = []
    for raw in values:
        entry = (_bare_entry(f'lib:{raw}') if isinstance(raw, str)
                 else _stored_entry(raw, default_favourite=str(data.get('version') or '1') < '3'))
        if entry:
            entries.append(entry)
    return entries


def update_file_snapshot(conn, track):
    """Private labels belong to the element even after its file leaves."""
    row = conn.execute('''SELECT i.id,i.snapshot FROM collection_items i
        JOIN collection_files f ON f.item_id=i.id WHERE f.file_id=?''', (track.id,)).fetchone()
    if row is None:
        return
    snapshot = json.loads(row[1])
    snapshot.update({key: value for key, value in track.to_public_dict().items()
                     if key not in {'id', 'item_id', 'added_at'} and value is not None})
    encoded = json.dumps(snapshot, ensure_ascii=False)
    if encoded != row[1]:
        conn.execute('UPDATE collection_items SET snapshot=? WHERE id=?', (encoded, row[0]))
        bump(conn)


def sync_files(conn, metadata, replacements=None):
    """Update source bindings inside the canonical library write transaction."""
    for old, new in (replacements or {}).items():
        row = conn.execute('SELECT item_id FROM collection_files WHERE file_id=?', (old,)).fetchone()
        if row:
            conn.execute('INSERT OR REPLACE INTO collection_files VALUES (?,?)', (new, row[0]))
    for track in metadata.tracks:
        keys = track_keys(track)
        bound = conn.execute('SELECT item_id FROM collection_files WHERE file_id=?', (track.id,)).fetchone()
        entry = {key: value for key, value in track.to_public_dict().items() if value is not None}
        entry['added_at'] = track.added_at
        entry['keys'] = keys
        if bound:
            entry['item_id'] = bound[0]
        elif getattr(track, 'item_id', None):
            entry['item_id'] = track.item_id
        else:
            candidate = item_for_keys(conn, keys)
            # Different file records/editions remain distinct unless an
            # acquisition explicitly carries the already known item id.
            if candidate and conn.execute('SELECT 1 FROM collection_files WHERE item_id=?', (candidate,)).fetchone():
                keys = [f'lib:{track.id}']
                entry['keys'] = keys
        # Initial file ids keep old API clients and portable manifests usable.
        # Once assigned this id NEVER follows the file's content hash again.
        item_id = admit(conn, entry, initial_id=track.item_id or track.id)
        track.item_id = item_id
        conn.execute('''INSERT INTO collection_files VALUES (?,?) ON CONFLICT(file_id)
            DO UPDATE SET item_id=excluded.item_id WHERE item_id IS NOT excluded.item_id''', (track.id, item_id))
        conn.executemany('INSERT OR IGNORE INTO collection_keys VALUES (?,?)',
                         ((key, item_id) for key in track_keys(track)))
        update_file_snapshot(conn, track)
    ids = {track.id for track in metadata.tracks}
    for (file_id,) in conn.execute('SELECT file_id FROM collection_files').fetchall():
        if file_id not in ids:
            conn.execute('DELETE FROM collection_files WHERE file_id=?', (file_id,))


def sync(conn, metadata, db_path, replacements=None):
    """One-time migration, then explicit source/playlist writes only."""
    start_changes = conn.total_changes
    migrating = not ready(conn)
    if migrating:
        conn.execute('INSERT INTO collection_state VALUES (1,0)')
    if not conn.execute("SELECT 1 FROM collection_migrations WHERE name='legacy-playlists'").fetchone():
        for old, new in _legacy_reference_evidence(metadata, db_path).items():
            conn.execute('INSERT OR IGNORE INTO track_id_aliases VALUES (?,?)', (old, new))
        conn.execute("INSERT INTO collection_migrations VALUES ('legacy-playlists')")
    sync_files(conn, metadata, replacements)
    metadata._indexes = None
    for old, new in (replacements or {}).items():
        # Explicit, proven recovery of an old orphan is a migration operation,
        # not a reason to rename an established musical item on every repair.
        orphan = conn.execute('SELECT snapshot,saved FROM collection_items WHERE id=?', (old,)).fetchone()
        target = item_for_keys(conn, [f'lib:{new}'])
        if orphan and target and target != old and not orphan[1] and json.loads(orphan[0]).get('unavailable'):
            for name, ids in metadata.playlists.items():
                metadata.playlists[name] = [target if value == old else value for value in ids]
            covers = metadata.settings.get('playlist_covers') or {}
            for name, value in covers.items():
                if value == old:
                    covers[name] = target
            conn.execute('UPDATE playlist_tracks SET track_id=? WHERE track_id=?', (target, old))
            conn.execute('INSERT OR IGNORE INTO collection_keys SELECT key,? FROM collection_keys WHERE item_id=?', (target, old))
            conn.execute('DELETE FROM collection_keys WHERE item_id=?', (old,))
            conn.execute('DELETE FROM collection_sources WHERE item_id=?', (old,))
            conn.execute('DELETE FROM collection_items WHERE id=?', (old,))
    if migrating:
        save_entries(conn, _legacy_saved(Path(db_path).with_name('favourites.json')))
    for name, ids in metadata.playlists.items():
        metadata.playlists[name] = [reference(conn, value) for value in ids]
    covers = metadata.settings.get('playlist_covers')
    if isinstance(covers, dict):
        for name, value in covers.items():
            covers[name] = reference(conn, value)
    if conn.total_changes != start_changes:
        bump(conn)


def entries(conn):
    rows = conn.execute('''SELECT id,snapshot,added_at,favourite,favourited_at
        FROM collection_items WHERE saved=1 ORDER BY saved_position''').fetchall()
    key_index = {}
    for item_id, key in conn.execute('''SELECT k.item_id,k.key FROM collection_keys k
            JOIN collection_items i ON i.id=k.item_id WHERE i.saved=1 ORDER BY k.key'''):
        key_index.setdefault(item_id, []).append(key)
    result = []
    for item_id, snapshot, added_at, favourite, favourited_at in rows:
        entry = json.loads(snapshot)
        # Source descriptors are never accepted back as identity evidence.
        entry = {key: entry[key] for key in ('title', 'artist', 'album', 'album_artist', 'thumbnail',
                 'duration', 'track_number', 'disc_number', 'year') if key in entry}
        entry.update(item_id=item_id, keys=key_index.get(item_id, []),
            added_at=added_at, favourite=bool(favourite))
        if favourited_at:
            entry['favourited_at'] = favourited_at
        result.append(entry)
    return result


def save_entries(conn, values):
    """Persist saved/favourite properties on the SAME entities as playlists."""
    retained = set()
    for position, entry in enumerate(values):
        item_id = admit(conn, entry)
        retained.add(item_id)
        entry['item_id'] = item_id
        conn.execute('''UPDATE collection_items SET saved=1,favourite=?,
            favourited_at=?,saved_position=? WHERE id=?''', (
            bool(entry.get('favourite')),
            entry.get('favourited_at'), position, item_id))
    for (item_id,) in conn.execute('SELECT id FROM collection_items WHERE saved=1').fetchall():
        if item_id not in retained:
            conn.execute('UPDATE collection_items SET saved=0,favourite=0,favourited_at=NULL WHERE id=?', (item_id,))
    bump(conn)


def attach_ids(conn, tracks):
    if not tracks:
        return tracks
    bindings = {}
    for offset in range(0, len(tracks), 500):
        ids = [track.id for track in tracks[offset:offset + 500]]
        bindings.update(conn.execute(f'SELECT file_id,item_id FROM collection_files WHERE file_id IN ({",".join("?" for _ in ids)})', ids))
    for track in tracks:
        track.item_id = bindings.get(track.id)
    return tracks


class Collection:
    """Service boundary. All callers use their bound account's library.db."""
    def __init__(self, db=None):
        if db is None:
            from shared.database import user_db
            db = user_db()
        self.db = db

    @contextmanager
    def transaction(self):
        with self.db._get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    def saved(self):
        with self.db._get_connection() as conn:
            conn.execute('BEGIN')
            try:
                return entries(conn)
            finally:
                conn.rollback()

    @serialized
    def ensure_saved_store(self):
        if self.db.has_canonical_library():
            self.db.load_library_metadata()
        with self.transaction() as conn:
            if not ready(conn):
                conn.execute('INSERT INTO collection_state VALUES (1,0)')
                save_entries(conn, _legacy_saved(self.db.db_path.with_name('favourites.json')))

    @serialized
    def write_saved(self, values):
        with self.transaction() as conn:
            save_entries(conn, values)

    def identify(self, keys):
        with self.db._get_connection() as conn:
            return item_for_keys(conn, keys)

    def revisions(self):
        with self.db._get_connection() as conn:
            row = conn.execute('''SELECT c.revision,COALESCE(l.revision,0)
                FROM collection_state c LEFT JOIN library_state l ON l.singleton=c.singleton
                WHERE c.singleton=1''').fetchone()
            return tuple(row) if row else (0, 0)

    def snapshot(self):
        """Materialize source descriptors by persisted relations, not guessing."""
        with self.db._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute('BEGIN')
            try:
                saved = entries(conn)
                rows = conn.execute('''SELECT DISTINCT i.id,i.snapshot,i.added_at FROM collection_items i
                    WHERE i.saved=1 OR EXISTS(SELECT 1 FROM collection_files f WHERE f.item_id=i.id)
                    OR EXISTS(SELECT 1 FROM playlist_tracks p WHERE p.track_id=i.id)
                    ORDER BY i.added_at DESC''').fetchall()
                files = self.db._rows_to_tracks(conn, conn.execute('''SELECT t.* FROM tracks t
                    JOIN library_tracks l ON l.track_id=t.id ORDER BY l.position''').fetchall())
                file_rows = [track.to_public_dict() for track in files]
                by_item = {}
                for track in file_rows:
                    by_item.setdefault(track['item_id'], track)
                result = []
                keys_by_item = {}
                for item_id, key in conn.execute('SELECT item_id,key FROM collection_keys'):
                    keys_by_item.setdefault(item_id, []).append(key)
                videos_by_item = {}
                for item_id, source_id in conn.execute("SELECT item_id,source_id FROM collection_sources WHERE kind='youtube' ORDER BY rowid"):
                    videos_by_item.setdefault(item_id, source_id)
                for item_id, raw, added_at in rows:
                    if item_id in by_item:
                        track = by_item[item_id]
                    else:
                        data = json.loads(raw)
                        keys = keys_by_item.get(item_id, [])
                        video = videos_by_item.get(item_id)
                        track = {key: deepcopy(data[key]) for key in (
                            'title', 'artist', 'album', 'album_artist', 'track_number', 'disc_number',
                            'year', 'duration', 'media_kind', 'podcast_feed_id', 'podcast_episode_guid',
                            'podcast_rss_url') if key in data}
                        track.update(id=video or item_id, item_id=item_id, source='preview',
                                     cover=data.get('thumbnail'), originKeys=keys,
                                     unavailable=not bool(video), title=data.get('title') or item_id,
                                     artist=data.get('artist') or '')
                    track['added_at'] = added_at
                    result.append(track)
                playlists = {}
                for name, track_id in conn.execute('''SELECT p.name,t.track_id FROM playlists p
                    LEFT JOIN playlist_tracks t ON p.name=t.playlist_name ORDER BY p.position,t.position'''):
                    playlists.setdefault(name, [])
                    if track_id is not None:
                        playlists[name].append(track_id)
                revision = conn.execute('SELECT revision FROM collection_state WHERE singleton=1').fetchone()
                state = conn.execute('SELECT revision,settings_json,podcast_subscriptions_json FROM library_state WHERE singleton=1').fetchone()
                return {'items': result, 'files': file_rows, 'saved': saved, 'playlists': playlists,
                        'revision': revision[0] if revision else 0,
                        'library_revision': state[0] if state else 0,
                        'settings': json.loads(state[1]) if state else {},
                        'podcast_subscriptions': json.loads(state[2]) if state else []}
            finally:
                conn.rollback()
