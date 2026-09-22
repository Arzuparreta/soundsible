"""Originals survive audio optimization; serving never invents missing detail."""
import io
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image
import pytest

from shared.artwork import ArtworkStore, artwork_store, open_image
from shared.artwork_recovery import ArtworkRecovery, same_better_image


def picture(size=(1280, 720), seed=1):
    # Structured detail survives resizing and distinguishes unrelated images.
    image = Image.fromarray(np.random.default_rng(seed).integers(0, 255, (12, 16, 3), dtype=np.uint8))
    image = image.resize(size, Image.Resampling.BICUBIC)
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def resize(data, size):
    image = Image.open(io.BytesIO(data))
    image.thumbnail(size)
    out = io.BytesIO()
    image.save(out, 'JPEG', quality=82)
    return out.getvalue()


def test_original_dedup_revision_cas_and_rekey(tmp_path):
    store = ArtworkStore(tmp_path / 'data', tmp_path / 'cache')
    data = picture()
    digest = store.put(data)
    assert digest == store.put(data)
    assert len(list((store.root / 'objects').iterdir())) == 1
    store.bind('old', digest, 'youtube')
    first = store.ref('old')
    store.bind('old', digest, 'manual')
    assert not store.bind('old', digest, 'youtube', expected_revision=first['revision'])
    store.remap({'old': 'new'})
    assert Path(store.path('new')).read_bytes() == data
    assert store.path('old') == store.path('new')
    store.bind('new', None, 'none')
    assert store.path('new') is None
    assert not store.bind('new', digest, 'youtube', only_missing=True)
    reopened = ArtworkStore(store.root, store.cache)
    assert reopened.ref('new')['source'] == 'none'


def test_crop_before_resize_no_upscale_and_cached_single_generation(tmp_path, monkeypatch):
    store = ArtworkStore(tmp_path / 'data', tmp_path / 'cache')
    digest = store.put(picture((600, 338)))
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda _: store.variant(digest, 960, True), range(8)))
    assert len(set(paths)) == 1
    assert Image.open(paths[0]).size == (338, 338)
    assert Image.open(store.variant(digest, 160, True)).size == (160, 160)
    stamp = paths[0].stat().st_mtime_ns
    monkeypatch.setattr('shared.artwork.open_image', lambda _: pytest.fail('warm request decoded original'))
    assert store.variant(digest, 960, True).stat().st_mtime_ns == stamp


def test_reject_bad_image_and_variant(tmp_path):
    store = ArtworkStore(tmp_path / 'data', tmp_path / 'cache')
    with pytest.raises(OSError):
        store.put(b'not an image')
    with pytest.raises(ValueError):
        store.variant('../escape', 640)
    with pytest.raises(ValueError):
        store.variant('a' * 64, 900)


def test_match_requires_same_picture_aspect_and_more_detail():
    original = picture()
    small = resize(original, (600, 338))
    assert same_better_image(small, original)
    assert not same_better_image(original, small)
    assert not same_better_image(small, picture(seed=9))
    assert not same_better_image(small, picture((1280, 1280)))


@pytest.mark.parametrize('source', ['manual', None, 'none'])
def test_recovery_never_fetches_for_protected_art(source, monkeypatch):
    store = artwork_store()
    store.bind('song', store.put(picture((600, 338))), source)
    worker = ArtworkRecovery()
    monkeypatch.setattr(worker, 'fetch', lambda _: pytest.fail('protected artwork fetched'))
    worker.recover(SimpleNamespace(id='song', cover_source=source, youtube_id='abcdefghijk'))


def test_recovery_resumes_and_only_replaces_matching_larger_image(monkeypatch):
    store = artwork_store()
    full = picture()
    small = resize(full, (600, 338))
    store.bind('song', store.put(small), 'youtube')
    worker = ArtworkRecovery()
    calls = []
    monkeypatch.setattr(worker, 'fetch', lambda video: calls.append(video) or full)
    track = SimpleNamespace(id='song', cover_source='youtube', youtube_id='abcdefghijk')
    assert worker.recover(track)
    assert Path(store.path('song')).read_bytes() == full
    assert not ArtworkRecovery().recover(track)
    assert len(calls) == 1


def test_manual_edit_wins_during_fetch(monkeypatch):
    store = artwork_store()
    full = picture()
    store.bind('song', store.put(resize(full, (600, 338))), 'youtube')
    manual = store.put(picture(seed=9))
    worker = ArtworkRecovery()
    def fetch(_):
        store.bind('song', manual, 'manual')
        return full
    monkeypatch.setattr(worker, 'fetch', fetch)
    worker.recover(SimpleNamespace(id='song', cover_source='youtube', youtube_id='abcdefghijk'))
    assert store.ref('song')['hash'] == manual


def test_retry_budget_survives_restart(monkeypatch):
    import requests
    store = artwork_store()
    store.bind('song', store.put(picture((600, 338))), 'youtube')
    track = SimpleNamespace(id='song', cover_source='youtube', youtube_id='abcdefghijk')
    calls = []
    def failure(self, _):
        calls.append(1)
        raise requests.ConnectionError()
    monkeypatch.setattr(ArtworkRecovery, 'fetch', failure)
    for _ in range(4):
        ArtworkRecovery().recover(track)
        with store.connect() as db:
            db.execute('UPDATE recovery SET next_try=0')
    assert len(calls) == 3


def test_endpoint_variants_mime_revision_and_conditional_cache(tmp_path):
    from shared.api import app
    store = artwork_store()
    digest = store.put(picture())
    store.bind('song', digest, 'youtube')
    track = SimpleNamespace(id='song', cover_source='youtube')
    lib = SimpleNamespace(get_cover_url=lambda _: store.path('song'))
    api = dict(get_core=lambda: (lib, None, None), get_track_by_id=lambda *_: track,
               is_trusted_network=lambda _: True, is_safe_path=lambda *a, **k: True, WEB_UI_PATH=str(tmp_path))
    with patch('shared.api.routes.playback._get_api', return_value=api):
        client = app.test_client()
        full = client.get('/api/static/cover/song')
        assert full.mimetype == 'image/png'
        url = f'/api/static/cover/song?size=640&fit=square&rev={digest}-1'
        response = client.get(url)
        assert response.status_code == 200
        assert response.mimetype == 'image/jpeg'
        assert Image.open(io.BytesIO(response.data)).size == (640, 640)
        assert 'immutable' in response.headers['Cache-Control']
        assert client.get(url, headers={'If-None-Match': response.headers['ETag']}).status_code == 304
        assert client.get('/api/static/cover/song?size=999').status_code == 400
        store.bind('song', store.put(picture(seed=2)), 'manual')
        stale = client.get(url)
        assert stale.status_code == 302
        assert 'immutable' not in stale.headers['Cache-Control']


def test_metadata_rewrite_keeps_original_and_final_hash_reference(tmp_path):
    from odst_tool.audio_utils import AudioProcessor
    from setup_tool.audio import AudioProcessor as EmbeddedAudio
    from mutagen.id3 import ID3, APIC
    store = artwork_store()
    path = tmp_path / 'song.mp3'
    original = picture()
    import subprocess
    from shared.ffmpeg_runtime import ffmpeg_executable
    subprocess.run([ffmpeg_executable(), '-y', '-v', 'error', '-f', 'lavfi',
                    '-i', 'sine=frequency=440:duration=0.2', str(path)], check=True)
    tags = ID3(path)
    tags.add(APIC(mime='image/jpeg', type=3, data=resize(original, (600, 338))))
    tags.save(path)
    before = AudioProcessor.calculate_hash(str(path))
    digest = store.put(original)
    store.bind(before, digest, 'embedded')
    with patch('odst_tool.audio_utils.download_image', side_effect=AssertionError('metadata must not fetch mqdefault')):
        AudioProcessor.embed_metadata(str(path), {'title': 'New title', 'artist': 'Artist'})
    after = AudioProcessor.calculate_hash(str(path))
    assert before != after
    assert store.ref(after)['hash'] == digest
    assert open_image(EmbeddedAudio.extract_cover_art(str(path))).size == (600, 338)


def test_annotation_only_reads_requested_references_in_bounded_batches(tmp_path, monkeypatch):
    from contextlib import contextmanager
    import sqlite3
    from shared.artwork import _REF_BATCH_SIZE

    store = ArtworkStore(tmp_path / "data", tmp_path / "cache")
    with store.connect() as db:
        db.execute("INSERT INTO objects VALUES ('cover', 640, 320, 'png', 10)")
        db.executemany("INSERT INTO refs VALUES (?, 'cover', 'manual', 1)",
                       [(f"song-{i}",) for i in range(10000)])
        db.execute("INSERT INTO refs VALUES (?, NULL, 'none', 2)", ("removed",))
    original_connect = store.connect
    rows_read = []
    queries = []

    @contextmanager
    def measured_connect():
        with original_connect() as db:
            # Exercise the portable variable ceiling rather than this host's
            # potentially much larger SQLite default.
            db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
            db.set_trace_callback(queries.append)

            def row_factory(cursor, row):
                rows_read.append(row[0])
                return sqlite3.Row(cursor, row)

            db.row_factory = row_factory
            yield db

    monkeypatch.setattr(store, "connect", measured_connect)
    tracks = [{"id": f"song-{i}"} for i in range(20)]
    store.annotate(tracks)
    assert len(rows_read) == 20
    assert all(t["artwork_revision"] == "cover-1" for t in tracks)
    assert len([q for q in queries if q.startswith("SELECT")]) == 1

    rows_read.clear()
    queries.clear()
    count = _REF_BATCH_SIZE * 2 + 1
    tracks = [{"id": f"song-{i}"} for i in range(count)]
    tracks += [{"id": "song-0"}, {"id": "removed"}, {"id": "missing"}, {}, {"id": None}]
    store.annotate(tracks)
    assert len(rows_read) == count + 1  # duplicate IDs are queried once
    assert len([q for q in queries if q.startswith("SELECT")]) == 3
    assert tracks[count]["artwork_revision"] == "cover-1"
    assert tracks[count + 1] == {
        "id": "removed", "artwork_revision": "none-2",
        "artwork_width": None, "artwork_height": None,
    }
    assert tracks[-3:] == [{"id": "missing"}, {}, {"id": None}]
    assert tracks[0]["artwork_width"] == 640
    assert tracks[0]["artwork_height"] == 320

    rows_read.clear()
    queries.clear()
    store.annotate([])
    store.annotate([{}, {"id": None}])
    assert not queries
    assert not rows_read
