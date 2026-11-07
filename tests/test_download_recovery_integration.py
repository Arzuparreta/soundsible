from types import SimpleNamespace

import pytest

from shared.api.download_queue import DownloadQueueManager
from shared.models import Track
from shared.multiuser_migration import ensure_multiuser_layout
from shared.user_context import user_context


def prepared(runtime):
    track = Track(id='prepared', title='Prepared', artist='Artist', album='Album', duration=1,
                  file_hash='prepared', original_filename='prepared.flac',
                  file_size=4, bitrate=1, format='flac')
    path = runtime.music_dir / 'tracks/prepared.flac'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'test')
    return track


@pytest.mark.parametrize('committed', [False, True])
def test_worker_recovers_checkpoint_without_acquisition(isolated_runtime, monkeypatch, committed):
    import shared.api as api
    uid = ensure_multiuser_layout()['user_id']
    track = prepared(isolated_runtime)
    queue = DownloadQueueManager(isolated_runtime.config_dir / 'integration.json')
    item = queue.add({'song_str': 'https://youtube.com/watch?v=abcdefghijk'}, user_id=uid)
    claim = queue.claim(item['id'])
    queue.checkpoint(item['id'], claim['attempt'], track.to_dict())
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    if committed:
        with user_context(uid):
            api.add_tracks_to_user_library([track], operation_id=item['id'])
            lib = api.get_user_core(uid).library
            lib.metadata.remove_track(track.id)
            lib.require_saved()
    queue.initialize(recover=True)
    monkeypatch.setattr(api, 'queue_manager_dl', queue)
    fake = SimpleNamespace(
        library=SimpleNamespace(get_track_by_hash=lambda _: None),
        commit_track=lambda _: None,
        downloader=SimpleNamespace(process_video=lambda *a, **k: pytest.fail('download repeated')),
    )
    monkeypatch.setattr(api, 'get_downloader', lambda *a, **k: fake)
    monkeypatch.setattr('shared.loudness.get_loudness_service', lambda: SimpleNamespace(measure_now=lambda _: None))
    monkeypatch.setattr('shared.audio_files.AudioProcessor.extract_cover_art', lambda _: None)
    api._process_single_queue_item(queue.get_pending()[0])
    assert queue.queue == []
    actual = api.get_user_core(uid).library.db.get_track(track.id)
    assert (actual is None) == committed


def test_cancel_during_acquisition_prevents_library_commit(isolated_runtime, monkeypatch):
    import shared.api as api
    uid = ensure_multiuser_layout()['user_id']
    track = prepared(isolated_runtime)
    queue = DownloadQueueManager(isolated_runtime.config_dir / 'integration.json')
    item = queue.add({'song_str': 'manual test'}, user_id=uid)
    def acquire(*args, **kwargs):
        queue.remove_item(item['id'], user_id=uid)
        return track
    fake = SimpleNamespace(downloader=SimpleNamespace(process_query=acquire))
    monkeypatch.setattr(api, 'queue_manager_dl', queue)
    monkeypatch.setattr(api, 'get_downloader', lambda *a, **k: fake)
    api._process_single_queue_item(item)
    assert queue.queue == []
    assert api.get_user_core(uid).library.db.get_track(track.id) is None


@pytest.mark.parametrize('interruption', ['crash', 'sqlite'])
@pytest.mark.parametrize('rekey', [False, True])
def test_artwork_intent_replays_after_membership_commit_without_redownload(isolated_runtime, monkeypatch, interruption, rekey):
    import sqlite3
    import shared.api as api
    from shared import artwork_sources
    uid = ensure_multiuser_layout()['user_id']
    track = prepared(isolated_runtime)
    track.youtube_id = 'abcdefghijk'
    with user_context(uid):
        receipt = artwork_sources.selection(track.youtube_id, 'deezer:track:1',
            'https://cdn-images.dzcdn.net/images/cover/' + 'a' * 32 + '/1000x1000-000000-80-0-0.jpg')
    queue = DownloadQueueManager(isolated_runtime.config_dir / 'integration.json')
    item = queue.add({'song_str': 'https://youtube.com/watch?v=abcdefghijk',
                      'metadata_evidence': {'artwork_selection': receipt}}, user_id=uid)
    claimed = queue.claim(item['id'])
    claimed = queue.checkpoint(item['id'], claimed['attempt'], track.to_dict())
    fake = SimpleNamespace(commit_track=lambda _: None,
                           downloader=SimpleNamespace(process_video=lambda *a, **k: pytest.fail('download repeated')))
    monkeypatch.setattr(api, 'queue_manager_dl', queue)
    monkeypatch.setattr(api, 'get_downloader', lambda *a, **k: fake)
    monkeypatch.setattr(api, 'emit_to_user', lambda *a, **k: None)
    monkeypatch.setattr('shared.audio_files.AudioProcessor.extract_cover_art', lambda _: None)
    monkeypatch.setattr('shared.loudness.get_loudness_service', lambda: SimpleNamespace(measure_now=lambda _: None))
    schedule = artwork_sources.schedule_selection
    class Crash(BaseException):
        pass
    def fail(*a, **k):
        assert api.get_user_core(uid).library.db.has_library_operation(item['id'])
        raise Crash() if interruption == 'crash' else sqlite3.OperationalError('busy')
    monkeypatch.setattr(artwork_sources, 'schedule_selection', fail)
    if interruption == 'crash':
        with pytest.raises(Crash):
            api._process_single_queue_item(claimed)
        queue.initialize(recover=True)
    else:
        api._process_single_queue_item(claimed)
        assert queue.retry_failed(item['id'], user_id=uid)
    if rekey:
        with user_context(uid):
            lib = api.get_user_core(uid).library
            changed = Track.from_dict(track.to_dict())
            changed.id = 'rekeyed'
            lib.metadata.tracks = [changed]
            lib.db.replace_library(lib.metadata, id_replacements={track.id: changed.id})
            track = changed
    monkeypatch.setattr(artwork_sources, 'schedule_selection', schedule)
    api._process_single_queue_item(queue.get_pending()[0])
    assert queue.queue == []
    with user_context(uid):
        assert set(artwork_sources.pending_selections()) == {track.id}
        assert api.get_user_core(uid).library.db.get_track(track.id)
