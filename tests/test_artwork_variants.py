"""Quota, disk-only delivery, reconciliation and HTTP descriptor lifetime."""
import io
import os
from pathlib import Path
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from PIL import Image

from shared.artwork import ArtworkStore
from shared.artwork_variants import VariantCache, DEFAULT_LIMIT


def name(index):
    return f'{index:064x}-160-original-jpeg90-v1.jpg'


def cache(tmp_path, limit=100):
    result = VariantCache(tmp_path / 'cache', tmp_path / 'originals')
    result.limit = limit
    return result


def put(store, index, size=40):
    return store.open(name(index), lambda output: output.write(bytes([index % 256]) * size))


def retained(store):
    return sum(p.stat().st_size for p in store.root.glob('*.jpg') if not p.is_symlink())


def test_quota_lru_and_original_safety(tmp_path):
    c = cache(tmp_path)
    originals = tmp_path / 'originals'
    originals.mkdir()
    (originals / name(1)).write_bytes(b'original')
    put(c, 1).file.close()
    put(c, 2).file.close()
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        db.execute('UPDATE variants SET used=0 WHERE name=?', (name(1),))
        db.execute('UPDATE variants SET used=1 WHERE name=?', (name(2),))
    warm = c.open(name(1), lambda _: pytest.fail('warm generation'))
    warm.file.close()
    put(c, 3).file.close()
    assert (c.root / name(1)).exists()
    assert not (c.root / name(2)).exists()
    assert retained(c) <= 90
    assert (originals / name(1)).read_bytes() == b'original'
    put(c, 2).file.close()
    assert retained(c) <= 100


@pytest.mark.parametrize('limit,size', [(0, 40), (10, 40)])
def test_uncached_files_are_disk_backed_and_closeable(tmp_path, limit, size):
    c = cache(tmp_path, limit)
    value = put(c, 1, size)
    assert os.fstat(value.file.fileno()).st_size == size
    assert value.file.read() == b'\x01' * size
    assert retained(c) == 0
    value.file.close()
    assert value.file.closed


@pytest.mark.parametrize('raw,expected', [('0', 0), ('256', 256 * 1024**2), ('-1', DEFAULT_LIMIT), ('bad', DEFAULT_LIMIT)])
def test_configuration(tmp_path, monkeypatch, raw, expected):
    monkeypatch.setenv('SOUNDSIBLE_ARTWORK_CACHE_MB', raw)
    assert VariantCache(tmp_path / 'cache', tmp_path / 'originals').limit == expected


def test_overlap_does_not_clean_originals(tmp_path):
    c = VariantCache(tmp_path, tmp_path)
    p = tmp_path / name(1)
    p.write_bytes(b'original')
    result = put(c, 1)
    result.file.close()
    assert p.read_bytes() == b'original'
    assert not (tmp_path / 'variants.sqlite3').exists()


@pytest.mark.parametrize('failure', ['missing_index', 'corrupt_index', 'dirty', 'restart'])
def test_reconcile_legacy_or_interrupted_cache(tmp_path, failure):
    c = cache(tmp_path, 100)
    put(c, 1).file.close()
    if failure == 'missing_index': (c.root / 'variants.sqlite3').unlink()
    elif failure == 'corrupt_index': (c.root / 'variants.sqlite3').write_bytes(b'broken')
    elif failure == 'dirty':
        with sqlite3.connect(c.root / 'variants.sqlite3') as db:
            db.execute('UPDATE state SET dirty=1')
    else:
        c = cache(tmp_path, 100)
    (c.root / name(2)).write_bytes(b'2' * 60)
    (c.root / '.variant-abcdefgh').write_bytes(b'abandoned staging')
    (c.root / 'unknown.file').write_bytes(b'leave alone')
    put(c, 3).file.close()
    assert retained(c) <= 100
    assert not (c.root / '.variant-abcdefgh').exists()
    assert (c.root / 'unknown.file').read_bytes() == b'leave alone'
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        assert db.execute('SELECT bytes FROM state').fetchone()[0] == retained(c)


def test_reconcile_preserves_recorded_usage_and_does_not_follow_symlinks(tmp_path):
    c = cache(tmp_path)
    put(c, 1).file.close()
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        db.execute('UPDATE variants SET used=123')
    external = tmp_path / 'outside'
    external.write_bytes(b'outside')
    try:
        (c.root / name(2)).symlink_to(external)
    except OSError:
        pytest.skip('symlinks unavailable')
    reopened = cache(tmp_path)
    with reopened.coordinated(), reopened.index() as db:
        assert db.execute('SELECT used FROM variants WHERE name=?', (name(1),)).fetchone()[0] == 123
        assert db.execute('SELECT COUNT(*) FROM variants').fetchone()[0] == 1
    assert external.read_bytes() == b'outside'


def test_warm_read_does_not_scan_or_touch_image_and_bounds_usage_writes(tmp_path, monkeypatch):
    c = cache(tmp_path)
    put(c, 1).file.close()
    before = (c.root / name(1)).stat().st_mtime_ns
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        used = db.execute('SELECT used FROM variants').fetchone()[0]
    monkeypatch.setattr(os, 'scandir', lambda *_: pytest.fail('warm directory scan'))
    for _ in range(20):
        c.open(name(1), lambda _: pytest.fail('warm generation')).file.close()
    assert (c.root / name(1)).stat().st_mtime_ns == before
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        assert db.execute('SELECT used FROM variants').fetchone()[0] == used
        plan = db.execute('EXPLAIN QUERY PLAN SELECT name,bytes,used FROM variants WHERE (used,name)>(?,?) '
                          'ORDER BY used,name LIMIT 100', (0, '')).fetchall()
        assert any('variants_lru' in row[3] for row in plan)


def test_failed_unlink_serves_temporary_without_exceeding_quota(tmp_path, monkeypatch):
    c = cache(tmp_path, 50)
    put(c, 1).file.close()
    original = Path.unlink

    def unlink(path, *args, **kwargs):
        if path.name == name(1): raise PermissionError('open on Windows')
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'unlink', unlink)
    result = put(c, 2)
    assert result.file.read() == b'\x02' * 40
    assert retained(c) == 40
    assert not (c.root / name(2)).exists()
    result.file.close()


def test_open_response_survives_eviction_and_parallel_writers(tmp_path):
    c = cache(tmp_path, 100)
    first = put(c, 1)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: put(c, i).file.close(), range(2, 30)))
    assert first.file.read() == b'\x01' * 40
    first.file.close()
    assert retained(c) <= 100


def test_missing_file_and_generation_failure_are_recoverable(tmp_path):
    c = cache(tmp_path)
    put(c, 1).file.close()
    (c.root / name(1)).unlink()
    with pytest.raises(RuntimeError):
        c.open(name(1), lambda _: (_ for _ in ()).throw(RuntimeError('decode')))
    put(c, 1).file.close()
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        assert db.execute('SELECT bytes FROM state').fetchone()[0] == retained(c) == 40


def test_public_revisions_and_originals_survive_variant_eviction(tmp_path):
    store = ArtworkStore(tmp_path / 'data', tmp_path / 'cache')
    output = io.BytesIO()
    Image.new('RGB', (500, 500), 'red').save(output, 'PNG')
    data = output.getvalue()
    digest = store.put(data)
    store.bind('song', digest, 'manual')
    revision = store.public_revision()
    store._variants.limit = 500
    for size in (160, 320, 640):
        value = store.open_variant(digest, size)
        assert Image.open(value.file).format == 'JPEG'
        value.file.close()
    assert store.public_revision() == revision
    assert Path(store.path('song')).read_bytes() == data


def test_processes_share_admission_lock_and_quota(tmp_path):
    import subprocess
    import sys
    c = cache(tmp_path, 100)
    code = '''
import sys
from pathlib import Path
from shared.artwork_variants import VariantCache
c=VariantCache(Path(sys.argv[1])/'cache',Path(sys.argv[1])/'originals')
c.limit=100
for i in range(int(sys.argv[2]),int(sys.argv[2])+12):
 name=f'{i:064x}-160-original-jpeg90-v1.jpg'
 result=c.open(name,lambda output:output.write(b'x'*40))
 assert len(result.file.read())==40
 result.file.close()
'''
    processes = [subprocess.Popen([sys.executable, '-c', code, str(tmp_path), str(start)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for start in (1, 30, 60)]
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, stdout + stderr
    assert retained(c) <= 100
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        assert db.execute('SELECT bytes FROM state').fetchone()[0] == retained(c)


@pytest.fixture
def endpoint(tmp_path, monkeypatch):
    from flask import Flask
    from shared.api.routes import playback
    import shared.artwork
    store = ArtworkStore(tmp_path / 'originals', tmp_path / 'cache')
    output = io.BytesIO()
    Image.new('RGB', (640, 500), 'blue').save(output, 'PNG')
    digest = store.put(output.getvalue())
    store.bind('song', digest, 'manual')
    api = dict(get_core=lambda: (SimpleNamespace(get_cover_url=lambda _: store.path('song')), None, None),
               get_track_by_id=lambda *_: SimpleNamespace(id='song', cover_source='manual'),
               is_safe_path=lambda *a, **k: True, is_trusted_network=lambda _: True, WEB_UI_PATH=str(tmp_path))
    monkeypatch.setattr(shared.artwork, 'artwork_store', lambda: store)
    monkeypatch.setattr(playback, '_get_api', lambda: api)
    app = Flask(__name__)
    app.register_blueprint(playback.playback_bp)
    opened = []
    original = store.open_variant

    def tracked(*args, **kwargs):
        value = original(*args, **kwargs)
        opened.append(value.file)
        return value

    monkeypatch.setattr(store, 'open_variant', tracked)
    yield app.test_client(), store, opened, f'/api/static/cover/song?size=320&rev={digest}-1'
    for handle in opened: handle.close()


@pytest.mark.parametrize('limit', [0, DEFAULT_LIMIT])
def test_http_metadata_ranges_conditionals_and_descriptor_closure(endpoint, limit):
    client, store, opened, url = endpoint
    store._variants.limit = limit
    full = client.get(url)
    body = full.data
    etag = full.headers['ETag']
    assert full.status_code == 200 and full.mimetype == 'image/jpeg'
    assert int(full.headers['Content-Length']) == len(body)
    assert 'immutable' in full.headers['Cache-Control']
    full.close()
    assert opened[-1].closed
    head = client.head(url)
    assert head.status_code == 200 and not head.data
    assert int(head.headers['Content-Length']) == len(body)
    assert opened[-1].closed
    conditional = client.get(url, headers={'If-None-Match': etag})
    assert conditional.status_code == 304 and not conditional.data
    assert opened[-1].closed
    partial = client.get(url, headers={'Range': 'bytes=5-20'})
    assert partial.status_code == 206 and partial.data == body[5:21]
    partial.close()
    assert opened[-1].closed
    invalid = client.get(url, headers={'Range': 'bytes=99999999-'})
    assert invalid.status_code == 416 and opened[-1].closed


def test_http_response_and_validator_survive_cleanup(endpoint):
    client, store, opened, url = endpoint
    response = client.get(url, buffered=False)
    etag = response.headers['ETag']
    assert not opened[-1].closed
    store._variants.limit = 0
    # Active response still owns an open descriptor after the cleanup.
    with store._variants.coordinated(), store._variants.index() as db:
        store._variants.evict(db)
    assert Image.open(io.BytesIO(response.data)).size == (320, 250)
    response.close()
    assert opened[-1].closed
    assert client.get(url, headers={'If-None-Match': etag}).status_code == 304
    interrupted = client.get(url, buffered=False)
    interrupted.close()
    assert opened[-1].closed


def test_bookkeeping_failure_serves_temporary_without_retaining(tmp_path, monkeypatch):
    c = cache(tmp_path)
    monkeypatch.setattr(c, '_connect_index', lambda: (_ for _ in ()).throw(sqlite3.OperationalError('locked')))
    value = put(c, 1)
    assert value.file.read() == b'\x01' * 40
    value.file.close()
    assert retained(c) == 0


def test_interrupted_publication_is_reconciled_on_retry(tmp_path, monkeypatch):
    c = cache(tmp_path)
    original = os.replace

    def replace_then_fail(source, target):
        original(source, target)
        raise OSError('interrupted after rename')

    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', replace_then_fail)
        value = put(c, 1)
        assert value.file.read() == b'\x01' * 40
        value.file.close()
    result = c.open(name(1), lambda _: pytest.fail('recovery regenerated published bytes'))
    result.file.close()
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        assert db.execute('SELECT bytes,dirty FROM state').fetchone() == (40, 0)
    assert not list(c.root.glob('.variant-*'))


def test_index_cannot_direct_cleanup_outside_variant_names(tmp_path):
    c = cache(tmp_path)
    put(c, 1).file.close()
    outside = tmp_path / 'precious'
    outside.write_bytes(b'original')
    with sqlite3.connect(c.root / 'variants.sqlite3') as db:
        db.execute('INSERT INTO variants VALUES(?,?,?)', ('../precious', 1000, 0))
        db.execute('UPDATE state SET bytes=bytes+1000')
    put(c, 2).file.close()
    assert outside.read_bytes() == b'original'
