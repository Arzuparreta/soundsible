"""A saved song always says what it is.

Before the collection model a favourite was a bare id: a library track's
content hash, or the video id of a song hearted before it was downloaded. The
July 2026 favourites migration turned every such id into `lib:<id>` without a
title, so the entry only meant something while that exact file stayed in the
library. Deleting the file, or a video id read as a file id, left a saved song
with nothing to show, and the library listed it under its internal id.

This module puts identity and description back from local evidence only:
the library's own files and aliases, its pre-SQLite backup, the managed file
left on disk, and the YouTube metadata the engine already stored. A saved song
none of that describes is removed, because nothing can show or play it.
"""
import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from shared.url_utils import validate_youtube_video_id

logger = logging.getLogger(__name__)

#: Recorded in `collection_migrations` once every stored item is described.
MIGRATION = 'described-saved-songs'

#: A managed file's id is the SHA-256 of its bytes.
_FILE_ID = re.compile(r'[0-9a-f]{64}')
_WATCH_URL = re.compile(r'(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})')
_FILE_REFERENCES = ('lib:', 'item:', 'legacy:')
_DESCRIPTION = ('title', 'artist', 'album', 'album_artist', 'duration', 'year',
                'track_number', 'disc_number', 'thumbnail')


def admission_keys(entry: Dict[str, Any]) -> List[str]:
    keys = list(entry.get('keys') or [])
    return [f'item:{entry["item_id"]}'] + keys if entry.get('item_id') else keys


def describes_something(conn, entry: Dict[str, Any]) -> bool:
    """A title, an identity beyond library file references, or a held file.

    A song saved bare from a row that only knows its video is a contract:
    the video identifies it and a later surface fills the title. A bare
    reference to a file the library does not hold identifies nothing.
    """
    from shared.collection import admission_item
    return _identifies(entry) or admission_item(conn, admission_keys(entry)) is not None


def _identifies(entry: Dict[str, Any]) -> bool:
    """Says what it is without leaning on a stored item."""
    return bool(entry.get('title')) or any(
        not key.startswith(_FILE_REFERENCES) for key in entry.get('keys') or [])


def require_description(conn, entry: Dict[str, Any]) -> None:
    if not describes_something(conn, entry):
        raise ValueError('a saved song needs a title or a file in the library')


def _description(values: Dict[str, Any]) -> Dict[str, Any]:
    return {key: values[key] for key in _DESCRIPTION if values.get(key) not in (None, '', 0)}


class Evidence:
    """Local records that name a song by a file id or a video id."""

    def __init__(self, conn, db_path=None, tracks_dir=None):
        self.conn = conn
        self.db_path = Path(db_path) if db_path else None
        self._tracks_dir = tracks_dir
        self._backup = None

    def current_file(self, track_id: str) -> Optional[str]:
        """The library file this id names now, following a recorded rekey."""
        if self.conn.execute('SELECT 1 FROM collection_files WHERE file_id=?', (track_id,)).fetchone():
            return track_id
        try:
            alias = self.conn.execute('SELECT new_track_id FROM track_id_aliases WHERE old_track_id=?',
                                      (track_id,)).fetchone()
        except sqlite3.OperationalError:
            return None
        if alias and self.conn.execute('SELECT 1 FROM collection_files WHERE file_id=?', (alias[0],)).fetchone():
            return alias[0]
        return None

    def file(self, track_id: str) -> Optional[Dict[str, Any]]:
        track = self._backup_tracks().get(('id', track_id))
        if track is not None:
            return track
        return self._managed_file(track_id)

    def video(self, video_id: str) -> Optional[Dict[str, Any]]:
        track = self._backup_tracks().get(('youtube_id', video_id))
        if track is not None:
            return track
        try:
            row = self.conn.execute('''SELECT title,artist,duration,thumbnail FROM youtube_resolution_cache
                WHERE youtube_id=? ORDER BY last_updated DESC''', (video_id,)).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row and row[0]:
            return {'title': row[0], 'artist': row[1], 'duration': row[2],
                    'thumbnail': row[3], 'youtube_id': video_id}
        try:
            rows = self.conn.execute('SELECT results_json FROM related_mix_cache WHERE instr(results_json, ?) > 0',
                                     (video_id,)).fetchall()
        except sqlite3.OperationalError:
            rows = []
        for (raw,) in rows:
            try:
                results = json.loads(raw)
            except (TypeError, ValueError):
                continue
            for result in results if isinstance(results, list) else []:
                if isinstance(result, dict) and result.get('id') == video_id and result.get('title'):
                    return {'title': result['title'], 'artist': result.get('artist') or result.get('channel'),
                            'duration': result.get('duration'), 'thumbnail': result.get('thumbnail'),
                            'youtube_id': video_id}
        return None

    def _backup_tracks(self) -> Dict[Tuple[str, str], Dict[str, Any]]:
        if self._backup is not None:
            return self._backup
        self._backup = {}
        backup = self.db_path.with_name('library.json.pre-sqlite.bak') if self.db_path else None
        if backup is None or not backup.is_file():
            return self._backup
        try:
            tracks = json.loads(backup.read_text(encoding='utf-8')).get('tracks') or []
        except (OSError, ValueError, AttributeError):
            logger.warning('Could not read %s while describing saved songs', backup)
            return self._backup
        for track in tracks:
            if not isinstance(track, dict) or not track.get('title'):
                continue
            for field in ('id', 'youtube_id'):
                if isinstance(track.get(field), str) and track[field]:
                    self._backup.setdefault((field, track[field]), track)
        return self._backup

    def _managed_file(self, track_id: str) -> Optional[Dict[str, Any]]:
        """A deleted track whose file stayed behind still carries its tags."""
        if not _FILE_ID.fullmatch(track_id):
            return None
        if self._tracks_dir is None:
            from shared.path_resolver import managed_tracks_dir
            self._tracks_dir = managed_tracks_dir() or False
        if not self._tracks_dir:
            return None
        paths = sorted(Path(self._tracks_dir).glob(f'{track_id}.*'))
        if not paths:
            return None
        from shared.audio_files import AudioProcessor
        tags = AudioProcessor.read_tags(str(paths[0]))
        if not tags.get('title'):
            return None
        return dict(tags, youtube_id=_video_in_tags(paths[0]))


def _video_in_tags(path: Path) -> Optional[str]:
    """yt-dlp writes the watch URL into the comment tag."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(str(path))
    except Exception:
        return None
    for value in (getattr(audio, 'tags', None) or {}).values():
        match = _WATCH_URL.search(str(value))
        if match:
            return match.group(1)
    return None


def describe(entry: Dict[str, Any], evidence: Evidence) -> Tuple[Dict[str, Any], List[str]]:
    """Correct an entry's keys and fill its description from local evidence.

    Returns the entry and the keys it should no longer carry: a video id that
    was stored as a file id is a video, never a file.
    """
    keys: List[str] = []
    wrong: List[str] = []
    has_file = False
    for key in entry.get('keys') or []:
        value = key[4:] if key.startswith('lib:') else None
        if value is None:
            keys.append(key)
            continue
        current = evidence.current_file(value)
        if current is not None:
            keys.extend([key, f'lib:{current}'])
            has_file = True
        elif validate_youtube_video_id(value) and not _FILE_ID.fullmatch(value):
            keys.append(f'yt:{value}')
            wrong.append(key)
        else:
            keys.append(key)
    described = dict(entry, keys=list(dict.fromkeys(keys)))
    if not described.get('title') and not has_file:
        for key in list(described['keys']):
            if key.startswith('lib:'):
                found = evidence.file(key[4:])
            elif key.startswith('yt:'):
                found = evidence.video(key[3:])
            else:
                found = None
            if found:
                for field, value in _description(found).items():
                    described.setdefault(field, value)
                video = found.get('youtube_id')
                if isinstance(video, str) and validate_youtube_video_id(video) and f'yt:{video}' not in described['keys']:
                    described['keys'].append(f'yt:{video}')
                break
    return described, wrong


def describe_legacy(conn, values: List[Dict[str, Any]], evidence: Evidence) -> List[Dict[str, Any]]:
    """Legacy saved songs, each either described or dropped with a record of it."""
    kept = []
    for entry in values:
        described, _ = describe(entry, evidence)
        if describes_something(conn, described):
            kept.append(described)
        else:
            logger.warning('Dropped legacy saved song %s: nothing on this machine describes it', entry.get('keys'))
    return kept


def repair(conn, metadata, evidence: Evidence) -> bool:
    """Describe, merge or remove every stored item that has neither a file nor a title."""
    from shared.collection import admit, item_for_keys
    changed = False
    rows = conn.execute('''SELECT id,snapshot FROM collection_items i
        WHERE NOT EXISTS(SELECT 1 FROM collection_files f WHERE f.item_id=i.id)''').fetchall()
    for item_id, raw in rows:
        if json.loads(raw).get('title'):
            continue
        keys = [row[0] for row in conn.execute('SELECT key FROM collection_keys WHERE item_id=? ORDER BY key', (item_id,))]
        described, wrong = describe({'keys': keys}, evidence)
        target = _file_item(conn, described['keys'], evidence)
        learned = [key for key in described['keys'] if key not in keys]
        if target is None and learned:
            target = item_for_keys(conn, learned)
        if target is not None and target != item_id:
            _merge(conn, metadata, item_id, target, wrong)
            logger.info('Saved song %s is %s: merged', item_id, target)
        elif _identifies(described):
            admit(conn, dict(described, item_id=item_id))
            conn.executemany('DELETE FROM collection_keys WHERE key=? AND item_id=?', ((key, item_id) for key in wrong))
            logger.info('Saved song %s described as %r', item_id, described.get('title') or described['keys'])
        elif conn.execute('SELECT 1 FROM playlist_tracks WHERE track_id=? LIMIT 1', (item_id,)).fetchone():
            # A playlist slot keeps its place, named as `reference()` names an
            # unknown playlist id: by the id the playlist held.
            label = next((key.split(':', 1)[1] for key in keys if key.startswith(('lib:', 'legacy:'))), item_id)
            conn.execute('UPDATE collection_items SET snapshot=? WHERE id=?', (json.dumps(
                {'keys': keys, 'title': label, 'artist': '', 'unavailable': True}, ensure_ascii=False), item_id))
            logger.warning('Playlist song %s has no description; labelled %s', item_id, label)
        else:
            _delete(conn, item_id)
            logger.warning('Removed saved song %s %s: nothing on this machine describes it', item_id, keys)
        changed = True
    return changed


def _file_item(conn, keys: List[str], evidence: Evidence) -> Optional[str]:
    """The item that holds a file one of these keys names."""
    for key in keys:
        current = evidence.current_file(key[4:]) if key.startswith('lib:') else None
        if current is not None:
            return conn.execute('SELECT item_id FROM collection_files WHERE file_id=?', (current,)).fetchone()[0]
    return None


def _merge(conn, metadata, old: str, target: str, wrong: List[str]) -> None:
    saved, favourite, favourited_at, position = conn.execute(
        'SELECT saved,favourite,favourited_at,saved_position FROM collection_items WHERE id=?', (old,)).fetchone()
    if saved:
        conn.execute('''UPDATE collection_items SET favourite=MAX(favourite,?),
            favourited_at=COALESCE(favourited_at,?),
            saved_position=CASE WHEN saved=1 THEN saved_position ELSE ? END, saved=1 WHERE id=?''',
                     (favourite, favourited_at, position, target))
    conn.execute('UPDATE playlist_tracks SET track_id=? WHERE track_id=?', (target, old))
    for name, ids in metadata.playlists.items():
        metadata.playlists[name] = [target if value == old else value for value in ids]
    covers = metadata.settings.get('playlist_covers')
    if isinstance(covers, dict):
        for name, value in covers.items():
            if value == old:
                covers[name] = target
    if not conn.execute('SELECT 1 FROM collection_user_state WHERE item_id=?', (target,)).fetchone():
        conn.execute('UPDATE collection_user_state SET item_id=? WHERE item_id=?', (target, old))
    conn.execute(f'''INSERT OR IGNORE INTO collection_keys(key,item_id) SELECT key,? FROM collection_keys
        WHERE item_id=? AND key NOT IN ({",".join("?" for _ in wrong) or "''"})''', (target, old, *wrong))
    conn.execute('INSERT OR IGNORE INTO collection_sources SELECT ?,kind,source_id FROM collection_sources WHERE item_id=?',
                 (target, old))
    _delete(conn, old)


def _delete(conn, item_id: str) -> None:
    for table in ('collection_keys', 'collection_sources', 'collection_user_state'):
        conn.execute(f'DELETE FROM {table} WHERE item_id=?', (item_id,))
    conn.execute('DELETE FROM collection_items WHERE id=?', (item_id,))
