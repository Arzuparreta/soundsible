from types import SimpleNamespace

import pytest

from shared.api.download_queue import DownloadQueueManager
from shared.models import Track
from shared.multiuser_migration import ensure_multiuser_layout
from shared.user_context import user_context


def prepared(runtime):
    track = Track(id='prepared', title='Prepared', artist='Artist', album='Album', duration=1,
                  file_hash='prepared', original_filename='prepared.flac', compressed=False,
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
        add_track=lambda _: None, save_library=lambda: None,
        downloader=SimpleNamespace(process_video=lambda *a, **k: pytest.fail('download repeated')),
    )
    monkeypatch.setattr(api, 'get_downloader', lambda *a, **k: fake)
    monkeypatch.setattr('shared.loudness.get_loudness_service', lambda: SimpleNamespace(measure_now=lambda _: None))
    monkeypatch.setattr('setup_tool.audio.AudioProcessor.extract_cover_art', lambda _: None)
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
    fake = SimpleNamespace(downloader=SimpleNamespace(process_track=acquire))
    monkeypatch.setattr(api, 'queue_manager_dl', queue)
    monkeypatch.setattr(api, 'get_downloader', lambda *a, **k: fake)
    api._process_single_queue_item(item)
    assert queue.queue == []
    assert api.get_user_core(uid).library.db.get_track(track.id) is None
