"""A saved song always says what it is, even after its file is gone."""
import json
import subprocess

import pytest

from shared.app_config import get_output_dir
from shared.collection import Collection
from shared.collection_repair import MIGRATION
from shared.database import DatabaseManager
from shared.ffmpeg_runtime import ffmpeg_executable
from shared.models import LibraryMetadata, Track


DOWNLOADED_VIDEO = 'wfaZpgXqx3c'
CACHED_VIDEO = '1W4V092Zrss'
BACKUP_VIDEO = '_ZFCPtMEX4c'
UNKNOWN_VIDEO = 'zzzzzzzzzzz'
LEFTOVER = 'a' * 64
UNKNOWN_FILE = 'b' * 64
OLD_ID = 'c' * 64
NEW_ID = 'd' * 64


def track(track_id, title, youtube_id=None):
    return Track(id=track_id, file_hash=track_id, title=title, artist='Artist', album='',
                 duration=200, original_filename='song.m4a', file_size=10, bitrate=128,
                 format='m4a', youtube_id=youtube_id)


def library(*tracks, playlists=None):
    return LibraryMetadata(version=1, tracks=list(tracks), playlists=playlists or {'Mix': []}, settings={})


def leftover_file(track_id, title, video):
    """A track whose library row was deleted while its file stayed on disk."""
    folder = get_output_dir() / 'tracks'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f'{track_id}.m4a'
    subprocess.run([
        ffmpeg_executable(), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-metadata', f'title={title}', '-metadata', 'artist=Extremoduro',
        '-metadata', f'comment=https://www.youtube.com/watch?v={video}', '-c:a', 'aac', str(path),
    ], check=True)
    return path


def evidence_on_disk(tmp_path, db):
    (tmp_path / 'library.json.pre-sqlite.bak').write_text(json.dumps({'tracks': [
        {'id': 'e' * 64, 'title': 'Necesito droga y amor', 'artist': 'Extremoduro', 'youtube_id': BACKUP_VIDEO},
    ]}))
    with db._get_connection() as conn:
        conn.execute('''INSERT INTO related_mix_cache(video_id,results_json) VALUES (?,?)''', ('seed', json.dumps([
            {'id': CACHED_VIDEO, 'title': 'Earth Song', 'artist': 'VOCES8', 'duration': 258},
        ])))
        conn.execute('INSERT INTO track_id_aliases VALUES (?,?)', (OLD_ID, NEW_ID))
        conn.commit()


def titles(snapshot):
    """Saved songs by title; a video saved bare is identified by its video."""
    saved = {entry['item_id'] for entry in snapshot['saved']}
    return sorted(row['title'] if row['id'] != UNKNOWN_VIDEO else f'yt:{UNKNOWN_VIDEO}'
                  for row in snapshot['items'] if row['item_id'] in saved)


DESCRIBED = sorted(['Held', 'Downloaded', 'Earth Song', 'Necesito droga y amor', 'Tu corazón', 'Rekeyed',
                    f'yt:{UNKNOWN_VIDEO}'])


def test_legacy_ids_migrate_as_described_songs_or_not_at_all(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    evidence_on_disk(tmp_path, db)
    leftover_file(LEFTOVER, 'Tu corazón', '5c0CfZwh_lM')
    (tmp_path / 'favourites.json').write_text(json.dumps({'version': '1.0', 'favourites': [
        'held', DOWNLOADED_VIDEO, CACHED_VIDEO, BACKUP_VIDEO, UNKNOWN_VIDEO, LEFTOVER, UNKNOWN_FILE, OLD_ID,
    ]}))
    db.replace_library(library(track('held', 'Held'), track('downloaded', 'Downloaded', DOWNLOADED_VIDEO),
                               track(NEW_ID, 'Rekeyed')))

    snapshot = Collection(db).snapshot()
    assert titles(snapshot) == DESCRIBED
    assert all(entry['favourite'] for entry in snapshot['saved'])
    corazon = next(row for row in snapshot['items'] if row['title'] == 'Tu corazón')
    assert corazon['id'] == '5c0CfZwh_lM' and not corazon['unavailable']
    earth = next(row for row in snapshot['items'] if row['title'] == 'Earth Song')
    assert earth['id'] == CACHED_VIDEO and earth['artist'] == 'VOCES8'
    with db._get_connection() as conn:
        assert not conn.execute("SELECT 1 FROM collection_keys WHERE key=?", (f'lib:{CACHED_VIDEO}',)).fetchone()


def test_stored_songs_without_description_are_repaired_once(tmp_path):
    db = DatabaseManager(str(tmp_path / 'library.db'))
    metadata = library(track('held', 'Held'), track('downloaded', 'Downloaded', DOWNLOADED_VIDEO),
                       track(NEW_ID, 'Rekeyed'))
    db.replace_library(metadata)
    evidence_on_disk(tmp_path, db)
    leftover_file(LEFTOVER, 'Tu corazón', '5c0CfZwh_lM')
    # The state the July 2026 migration left: bare `lib:` ids, saved and marked.
    bare = ['held', DOWNLOADED_VIDEO, CACHED_VIDEO, BACKUP_VIDEO, UNKNOWN_VIDEO, LEFTOVER, UNKNOWN_FILE, OLD_ID, 'old-playlist-reference']
    with db._get_connection() as conn:
        for position, value in enumerate(bare):
            item_id = f'item-{position}'
            conn.execute('''INSERT INTO collection_items(id,snapshot,added_at,saved,favourite,saved_position)
                VALUES (?,?,?,1,1,?)''', (item_id, json.dumps({'keys': [f'lib:{value}']}), '2026-07-29T01:13:59', position))
            conn.execute('INSERT INTO collection_keys VALUES (?,?)', (f'lib:{value}', item_id))
        conn.execute("UPDATE collection_items SET saved=0,favourite=0 WHERE id='item-8'")
        conn.execute("INSERT INTO playlist_tracks(playlist_name,position,track_id) VALUES ('Mix',0,'item-8')")
        conn.execute('DELETE FROM collection_migrations WHERE name=?', (MIGRATION,))
        conn.commit()

    reloaded = DatabaseManager(str(tmp_path / 'library.db'))
    reloaded.load_library_metadata()
    snapshot = Collection(reloaded).snapshot()
    assert titles(snapshot) == DESCRIBED
    assert {row['item_id'] for row in snapshot['items']}.isdisjoint({'item-0', 'item-1', 'item-6', 'item-7'})
    downloaded = next(entry for entry in snapshot['saved'] if entry['title'] == 'Downloaded')
    assert downloaded['favourite']
    assert snapshot['playlists']['Mix'] == ['item-8']
    assert next(row for row in snapshot['items'] if row['item_id'] == 'item-8')['title'] == 'old-playlist-reference'
    with reloaded._get_connection() as conn:
        assert conn.execute("SELECT 1 FROM collection_migrations WHERE name=?", (MIGRATION,)).fetchone()
        assert not conn.execute("SELECT 1 FROM collection_items WHERE id='item-6'").fetchone()
        assert not conn.execute("SELECT 1 FROM collection_keys WHERE key LIKE 'lib:%' AND item_id='item-4'").fetchone()


def test_a_song_that_names_nothing_cannot_be_saved():
    from player.favourites_manager import FavouritesManager
    db = DatabaseManager()
    db.replace_library(library(track('held', 'Held')))
    manager = FavouritesManager()
    with pytest.raises(ValueError):
        manager.toggle('deleted-long-ago')
    with pytest.raises(ValueError):
        manager.toggle_saved({'keys': ['lib:deleted-long-ago']})
    assert manager.set_saved([{'keys': ['lib:deleted-long-ago']}], True) == []
    assert manager.toggle('held') is True
    manager.set_saved([{'keys': ['yt:7N3rFdE3u3Y'], 'title': 'Autorretrato'}], True)
    assert sorted(row['title'] for row in manager.get_entries()) == ['Autorretrato', 'Held']
    with pytest.raises(ValueError):
        db.replace_library(library(track('held', 'Held')), playlist_entry=('Mix', {'keys': ['lib:gone']}))
