"""Canonical equivalence and actual row-write budgets for incremental saves."""
from copy import deepcopy
from pathlib import Path
import runpy
import sqlite3
from types import FunctionType

import pytest

import shared.database as database
from shared.database import DatabaseManager, StaleLibraryWrite
from shared.models import LibraryMetadata, Track


def legacy_class():
    frozen = runpy.run_path(str(Path(__file__).parent / 'fixtures/library_writer_reference.py'))

    class Legacy(DatabaseManager):
        replace_library = FunctionType(frozen['replace_library'].__code__, vars(database))
        _replace_catalog_projection = staticmethod(FunctionType(frozen['_replace_catalog_projection'].__code__, vars(database)))
    Legacy.replace_library.__kwdefaults__ = frozen['replace_library'].__kwdefaults__
    return Legacy


def model(count=20):
    return LibraryMetadata(1, [Track(
        id=str(i), title=f'Track {i}', artist='Artist', artists=['Artist', 'Guest'], album='Album', duration=180,
        file_hash=str(i), original_filename=f'{i}.flac', compressed=False, file_size=1000,
        bitrate=900, format='flac', year=2000 + i, genre='Rock' if i else None,
    ) for i in range(count)], {'List': ['0', 'external', '0'], 'Empty': []}, {'nested': {'flag': True}},
        last_updated='2026-01-01T00:00:00', podcast_subscriptions=[{'id': 'feed'}],
        podcast_episode_cache={'feed': {'episodes': []}})


TABLES = ['tracks', 'library_tracks', 'artists', 'albums', 'track_artists', 'playlists',
          'playlist_tracks', 'track_user_state', 'track_id_aliases', 'library_state', 'library_info']


def persistent_rows(db):
    with db._get_connection() as conn:
        result = {}
        for table in TABLES:
            columns = [r[1] for r in conn.execute(f'PRAGMA table_info({table})') if r[1] not in {'created_at', 'updated_at', 'last_updated'}]
            result[table] = sorted([tuple(row) for row in conn.execute(f'SELECT {",".join(columns)} FROM {table}')], key=repr)
        return result


def changes(db):
    with db._get_connection() as conn:
        return {(r[0], r[1]): r[2] for r in conn.execute('SELECT name, operation, COUNT(*) FROM mutations GROUP BY name, operation')}


@pytest.mark.parametrize('change', ['same', 'title', 'technical', 'add', 'remove', 'empty', 'order', 'artists', 'album', 'year', 'kind', 'headers', 'playlist'])
def test_incremental_writer_matches_previous_contract(tmp_path, change):
    old = legacy_class()(str(tmp_path / 'old.db'))
    new = DatabaseManager(str(tmp_path / 'new.db'))
    before = model()
    for db in (old, new):
        db.replace_library(deepcopy(before))
    after = deepcopy(before)
    if change == 'title': after.tracks[0].title = 'Changed'
    elif change == 'technical':
        after.tracks[0].local_path = '/somewhere/file'
        after.tracks[0].local_mtime_ns = 123
        after.tracks[0].file_size += 1
    elif change == 'add': after.tracks.append(Track.from_dict({**after.tracks[0].to_dict(), 'id': 'new'}))
    elif change == 'remove': after.tracks.pop(0)
    elif change == 'empty': after.tracks.clear()
    elif change == 'order': after.tracks.reverse()
    elif change == 'artists': after.tracks[0].artists.reverse()
    elif change == 'album':
        after.tracks[0].album = 'Other'
        after.tracks[0].is_compilation = True
    elif change == 'year':
        after.tracks[0].year = None
        after.tracks[1].genre = 'Jazz'
    elif change == 'kind': after.tracks[0].media_kind = 'podcast_episode'
    elif change == 'headers':
        after.settings = {}
        after.podcast_subscriptions.clear()
        after.podcast_episode_cache = {'new': {'episodes': [{'id': 'episode'}]}}
    elif change == 'playlist': after.playlists = {'Empty': [], 'List': ['external', '0', 'external'], 'New': ['1']}
    assert old.replace_library(deepcopy(after), expected_revision=1) == 2
    assert new.replace_library(deepcopy(after), expected_revision=1) == 2
    assert new.load_library_metadata().to_public_dict() == old.load_library_metadata().to_public_dict()
    assert persistent_rows(new) == persistent_rows(old)


@pytest.mark.parametrize('change', ['same', 'title', 'technical', 'playlist'])
def test_no_writes_to_unchanged_rows_or_catalog(tmp_path, monkeypatch, change):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model()
    db.replace_library(value)
    # Counters live in main for this test: disk_staging restores temp_store,
    # which intentionally discards its temporary tables on the pooled handle.
    with db._get_connection() as conn:
        conn.execute('CREATE TABLE mutations (name TEXT, operation TEXT)')
        for table in TABLES:
            for operation in ('INSERT', 'UPDATE', 'DELETE'):
                conn.execute(f"CREATE TRIGGER count_{table}_{operation} AFTER {operation} ON {table} "
                             f"BEGIN INSERT INTO mutations VALUES ('{table}', '{operation}'); END")
        conn.commit()
    monkeypatch.setattr(db, '_replace_catalog_projection', lambda *_: pytest.fail('unnecessary catalog rebuild'))
    if change == 'title': value.tracks[0].title = 'Edited'
    elif change == 'technical': value.tracks[0].local_mtime_ns = 5
    elif change == 'playlist': value.playlists['List'][1] = 'other-external'
    assert db.replace_library(value, expected_revision=1) == 2
    expected = {('library_state', 'UPDATE'): 1}
    if change in {'title', 'technical'}: expected[('tracks', 'UPDATE')] = 1
    if change == 'playlist': expected[('playlist_tracks', 'UPDATE')] = 1
    assert changes(db) == expected


def test_failure_rolls_back_and_releases_staging_tables(tmp_path, monkeypatch):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model()
    db.replace_library(value)
    before = persistent_rows(db)
    original = db._replace_catalog_projection
    with db._get_connection() as conn:
        temp_mode = conn.execute('PRAGMA temp_store').fetchone()[0]
    monkeypatch.setattr(db, '_replace_catalog_projection', lambda *_: (_ for _ in ()).throw(RuntimeError('injected')))
    value.tracks[0].album = 'Changed'
    with pytest.raises(RuntimeError):
        db.replace_library(value)
    assert persistent_rows(db) == before
    with db._get_connection() as conn:
        assert conn.execute('PRAGMA temp_store').fetchone()[0] == temp_mode
        assert not conn.execute("SELECT 1 FROM sqlite_temp_master WHERE name LIKE '_incoming_library%'").fetchone()
    monkeypatch.setattr(db, '_replace_catalog_projection', original)
    assert db.replace_library(value) == 2
    with pytest.raises(StaleLibraryWrite):
        db.replace_library(value, expected_revision=1)
    assert db.get_library_revision() == 2


def test_existing_added_at_is_not_rewritten_and_surviving_state_is_untouched(tmp_path):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model(2)
    value.tracks[0].added_at = '2020-01-01'
    db.replace_library(value)
    with db._get_connection() as conn:
        conn.execute("INSERT INTO track_user_state(track_id,play_count,rating) VALUES ('0',4,5)")
        conn.commit()
    value.tracks[0].added_at = '2026-01-01'
    db.replace_library(value)
    assert db.load_library_metadata().tracks[0].added_at == '2020-01-01'
    with db._get_connection() as conn:
        assert tuple(conn.execute("SELECT play_count,rating FROM track_user_state WHERE track_id='0'").fetchone()) == (4, 5)


def test_large_manifest_uses_bounded_sql_parameters(tmp_path):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model(1100)
    with db._get_connection() as conn:
        previous = conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
    try:
        db.replace_library(value)
        value.tracks[-1].title = 'Last batch'
        value.tracks.pop(0)
        db.replace_library(value)
        with db._get_connection() as conn:
            assert conn.execute('SELECT COUNT(*) FROM tracks').fetchone()[0] == 1099
            assert conn.execute("SELECT title FROM tracks WHERE id='1099'").fetchone()[0] == 'Last batch'
    finally:
        with db._get_connection() as conn:
            conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, previous)


def test_catalog_only_timestamps_changed_entities(tmp_path):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model(2)
    value.tracks[1].artist = 'Other'
    value.tracks[1].artists = ['Other']
    value.tracks[1].album = 'Other album'
    db.replace_library(value)
    with db._get_connection() as conn:
        conn.execute("UPDATE artists SET created_at='2000-01-01 00:00:00',updated_at='2000-01-01 00:00:00'")
        conn.execute("UPDATE albums SET created_at='2000-01-01 00:00:00',updated_at='2000-01-01 00:00:00'")
        conn.commit()
    value.tracks[0].genre = 'Changed genre'
    db.replace_library(value)
    with db._get_connection() as conn:
        assert conn.execute("SELECT updated_at FROM albums WHERE title='Other album'").fetchone()[0] == '2000-01-01 00:00:00'
        assert conn.execute("SELECT updated_at FROM albums WHERE title='Album'").fetchone()[0] != '2000-01-01 00:00:00'
        assert conn.execute("SELECT COUNT(*) FROM artists WHERE updated_at!='2000-01-01 00:00:00'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM albums WHERE created_at!='2000-01-01 00:00:00'").fetchone()[0] == 0


def test_concurrent_writers_recheck_revision_inside_transaction(tmp_path):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    db = DatabaseManager(str(tmp_path / 'db'))
    value = model()
    db.replace_library(value)
    barrier = threading.Barrier(2)
    original = db.get_library_revision

    def synchronized_revision():
        result = original()
        barrier.wait(timeout=5)
        return result

    db.get_library_revision = synchronized_revision

    def write(name):
        candidate = deepcopy(value)
        candidate.tracks[0].title = name
        try:
            return db.replace_library(candidate, expected_revision=1)
        except StaleLibraryWrite:
            return 'stale'

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ['first', 'second']))
    db.get_library_revision = original
    assert sorted(results, key=str) == [2, 'stale']
    assert db.get_library_revision() == 2
    assert db.load_library_metadata().tracks[0].title in {'first', 'second'}


def test_invalid_staging_rolls_back_and_connection_can_retry(tmp_path):
    db = DatabaseManager(str(tmp_path / 'db'))
    value = model()
    db.replace_library(value)
    before = persistent_rows(db)
    invalid = deepcopy(value)
    invalid.tracks.append(deepcopy(invalid.tracks[0]))
    with pytest.raises(sqlite3.IntegrityError):
        db.replace_library(invalid, expected_revision=1)
    assert persistent_rows(db) == before
    with db._get_connection() as conn:
        assert not conn.execute("SELECT name FROM sqlite_temp_master WHERE name LIKE '_incoming_library_%'").fetchall()
    assert db.replace_library(value, expected_revision=1) == 2
