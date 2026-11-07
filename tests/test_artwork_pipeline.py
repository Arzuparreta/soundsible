"""Contracts at the image/network/account/process boundaries, without real accounts."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

from PIL import Image
import pytest

from shared.artwork import artwork_store
from shared.artwork_sources import adopt, observe, observed, safe_image_url, selection, verify
from shared.artwork_worker import ImageProcess, transform
from shared.downloader.youtube.artwork import candidates, thumbnail
from shared.user_context import user_context

VIDEO = 'abcdefghijk'
URL = 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg'
CATALOG = 'https://cdn-images.dzcdn.net/images/cover/' + 'a' * 32 + '/1000x1000-000000-80-0-0.jpg'


def picture(size=(480, 360), color='red'):
    output = io.BytesIO()
    Image.new('RGB', size, color).save(output, 'PNG')
    return output.getvalue()


def test_search_uses_existing_candidates_without_network_and_ignores_alternate_frames():
    rows = {'thumbnails': [{'url': URL, 'width': 720, 'height': 404},
                           {'url': URL.replace('maxresdefault', '1'), 'width': 1920, 'height': 1080},
                           {'url': URL.replace('maxresdefault', 'hqdefault'), 'width': 360, 'height': 202},
                           {'url': URL.replace('maxresdefault', 'sddefault')} ]}
    assert thumbnail(rows, 'fallback') == URL
    assert len(candidates(rows)) == 2
    assert candidates(rows)[0]['verified'] is False
    assert candidates({'thumbnails': [{'url': URL, 'width': float('inf'), 'height': 720}]}) == []


@pytest.mark.parametrize('url', [
    'http://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg',
    'https://i.ytimg.com.evil.test/vi/abcdefghijk/maxresdefault.jpg',
    'https://user:secret@i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg',
    'https://i.ytimg.com:444/vi/abcdefghijk/maxresdefault.jpg',
    'https://i.ytimg.com/vi/zyxwvutsrqp/maxresdefault.jpg',
    'https://127.0.0.1/private',
])
def test_no_arbitrary_proxy_authority(url):
    assert not safe_image_url(url, video_id=VIDEO)


def test_selection_is_bound_to_account_video_and_cannot_be_forged():
    receipt = selection(VIDEO, 'deezer:track:1', CATALOG)
    assert verify(receipt, VIDEO) == CATALOG
    assert verify(receipt, 'zyxwvutsrqp') is None
    assert verify(receipt[:-1] + ('0' if receipt[-1] != '0' else '1'), VIDEO) is None
    with user_context('another'):
        assert verify(receipt, VIDEO) is None


def test_two_accounts_share_objects_but_not_manual_choices_or_tombstones():
    store = artwork_store()
    shared = store.put(picture())
    manual = store.put(picture(color='blue'))
    store.bind('song', shared, 'youtube')
    with user_context('alice'):
        store.bind_override('song', manual, 'manual')
        assert store.effective_ref('song')['hash'] == manual
    with user_context('bob'):
        assert store.effective_ref('song')['hash'] == shared
        store.bind_override('song', None, 'none')
        assert store.effective_path('song') is None
    with user_context('alice'):
        assert store.effective_ref('song')['hash'] == manual
    assert store.ref('song')['hash'] == shared
    with user_context('bob'):
        store.remap({'song': 'rekeyed'})
        assert store.effective_ref('rekeyed')['source'] == 'none'


def test_personal_rekey_never_copies_another_accounts_overrides_or_receipts():
    from shared.artwork_sources import schedule_selection, pending_selections
    store = artwork_store()
    store.bind('new', store.put(picture()), 'youtube')
    with user_context('bob'):
        store.bind_override('old', store.put(picture(color='blue')), 'manual')
        token = selection(VIDEO, 'deezer:track:1', CATALOG)
        schedule_selection('old', VIDEO, token)
    with user_context('alice'):
        store.remap({'old': 'new'})
    with user_context('bob'):
        assert store.effective_ref('new')['source'] == 'youtube'
        assert set(pending_selections()) == {'old'}


def test_rekeyed_receipt_is_retired_when_incoming_video_differs():
    from shared.artwork_sources import schedule_selection, pending_selections
    token = selection(VIDEO, 'deezer:track:1', CATALOG)
    schedule_selection('old', VIDEO, token)
    artwork_store().remap({'old': 'new'})
    assert not adopt('new', 'zyxwvutsrqp', token)
    assert pending_selections({'new'}, video_ids={'new': 'zyxwvutsrqp'}) == {}
    with artwork_store().connect() as db:
        assert db.execute('SELECT count(*) FROM selections').fetchone()[0] == 0


def test_manual_edit_wins_over_late_catalog_download(monkeypatch):
    store = artwork_store()
    store.bind('song', store.put(picture()), 'youtube')
    token = selection(VIDEO, 'deezer:track:1', CATALOG)
    def image(_, **kwargs):
        store.bind_override('song', None, 'none')
        return picture(color='green')
    monkeypatch.setattr('shared.artwork_sources.fetch_image', image)
    assert not adopt('song', VIDEO, token)
    assert store.effective_ref('song')['source'] == 'none'


def test_candidate_observations_survive_store_reopen_and_ignore_arbitrary_urls():
    observe(VIDEO, [{'url': URL, 'width': 1280, 'height': 720}])
    assert observed(VIDEO)[0]['url'] == URL
    observe(VIDEO, [{'url': 'https://evil.test/private', 'width': 4000, 'height': 4000}])
    assert observed(VIDEO)[0]['url'] == URL


def test_optional_source_observation_never_waits_for_a_busy_writer():
    import sqlite3
    store = artwork_store()
    observe(VIDEO, [{'url': URL, 'width': 1280, 'height': 720}])
    with store.connect() as busy:
        busy.execute('BEGIN IMMEDIATE')
        start = time.monotonic()
        # The resolver catches this optional cache failure and returns audio.
        with pytest.raises(sqlite3.OperationalError, match='locked'):
            observe(VIDEO, [{'url': URL, 'width': 1920, 'height': 1080}])
        assert time.monotonic() - start < .2


def test_canonical_variants_reuse_identical_bytes_and_hot_path_needs_no_sql(monkeypatch):
    store = artwork_store()
    digest = store.put(picture())
    results = [store.open_variant(digest, size, True) for size in (640, 960, 1280)]
    try:
        assert len({r.etag for r in results}) == 1
        assert len({r.file.read() for r in results}) == 1
    finally:
        for r in results:
            r.file.close()
    monkeypatch.setattr(store, 'connect', lambda: pytest.fail('warm hit queried SQLite'))
    hot = store.open_variant(digest, 960, True)
    hot.file.close()


def test_real_image_child_matches_transform_and_recovers_after_a_hang(tmp_path):
    source = tmp_path / 'source.png'
    source.write_bytes(picture())
    expected = tmp_path / 'expected.jpg'
    transform(source, expected, 320, True)
    worker = ImageProcess(timeout=5, idle=.1)
    try:
        output = io.BytesIO()
        worker.render(source, output, 320, True)
        assert output.getvalue() == expected.read_bytes()
        # Idle shutdown closes/reaps rather than retaining decoded images.
        process = worker.process
        worker.close()


        assert process.poll() is not None
        worker.command = [sys.executable, '-c', 'import time; time.sleep(30)']
        worker.timeout = .15
        with pytest.raises(OSError, match='deadline'):
            worker.render(source, io.BytesIO(), 320, True)
        assert worker.process is None
        worker.command = None
        worker.timeout = 5
        worker.render(source, io.BytesIO(), 320, True)
    finally:
        worker.close()


@pytest.mark.parametrize('reply', ['flood', 'late'])
def test_real_image_child_reaps_its_reader_after_invalid_or_late_replies(tmp_path, reply):
    script = ("import sys;sys.stdout.write('{}\\n'*1000);sys.stdout.flush()"
              if reply == 'flood' else
              "import sys,time,json;r=json.loads(sys.stdin.readline());time.sleep(.5);print(json.dumps({'ok':True,'id':r['id']}),flush=True)")
    child = ImageProcess(command=[sys.executable, '-c', script], timeout=.25)
    try:
        with pytest.raises(OSError):
            child.render(tmp_path / 'unused.png', io.BytesIO(), 160, False)
        assert child.process is None and child.reader is None
    finally:
        child.close()


def test_downloader_deadline_includes_silent_child_and_unterminated_output():
    from shared.process_runner import run
    for code in ('import time; time.sleep(30)',
                 "import sys,time; sys.stdout.write('x'*2000000);sys.stdout.flush();time.sleep(30)"):
        start = time.monotonic()
        with pytest.raises(subprocess.TimeoutExpired):
            run([sys.executable, '-c', code], deadline=start + .25)
        assert time.monotonic() - start < 5
    code, output = run([sys.executable, '-c', "print('x'*2000000)"], deadline=time.monotonic() + 5)
    assert code == 0
    assert len(output.encode()) <= 65540


def test_visitor_failure_is_cooled_and_a_changed_relay_does_not_reuse_it(monkeypatch):
    from shared.downloader.youtube import web
    import requests
    web.reset_visitor_data()
    calls = []
    def timeout(*a, **k):
        calls.append(1)
        raise requests.Timeout()
    monkeypatch.setattr(web.requests, 'get', timeout)
    for _ in range(3):
        assert web.visitor_data() is None
    assert len(calls) == 1
    monkeypatch.setenv('SOUNDSIBLE_YT_PROXY', 'http://relay-b.invalid')
    assert web.visitor_data() is None
    assert len(calls) == 2
    web.reset_visitor_data()


def test_rejecting_an_old_visitor_never_queues_behind_network_renewal():
    from shared.downloader.youtube import web
    web.reset_visitor_data()
    web._visitor_data_cache.update(value='old', egress=web.yt_proxy())
    web._visitor_data_lock.acquire()
    try:
        start = time.monotonic()
        web.reject_visitor_data('old')
        assert time.monotonic() - start < .1
        web._visitor_data_cache.update(value='new')
    finally:
        web._visitor_data_lock.release()
    web.reject_visitor_data('old')
    assert web._visitor_data_cache['value'] == 'new'
    web.reset_visitor_data()


def test_catalog_replay_is_leased_and_completion_is_atomic(monkeypatch):
    store = artwork_store()
    token = selection(VIDEO, 'deezer:track:1', CATALOG)
    calls = []
    def download(_, **kwargs):
        calls.append(1)
        # A concurrent/reentrant replay cannot claim the same attempt.
        assert not adopt('song', VIDEO, token)
        return picture(color='green')
    monkeypatch.setattr('shared.artwork_sources.fetch_image', download)
    assert adopt('song', VIDEO, token)
    assert not adopt('song', VIDEO, token)
    assert len(calls) == 1
    with store.connect() as db:
        row = db.execute('SELECT attempts,lease FROM selections WHERE track_id=?', ('song',)).fetchone()
    assert tuple(row) == (-1, None)
    assert store.effective_ref('song')['source'] == 'catalog'


def test_old_selection_cannot_publish_or_reschedule_a_newer_choice(monkeypatch):
    from shared.artwork_sources import schedule_selection
    old = selection(VIDEO, 'deezer:track:1', CATALOG)
    new = selection(VIDEO, 'deezer:track:2', CATALOG.replace('a'*32, 'b'*32))
    def download(_, **kwargs):
        schedule_selection('song', VIDEO, new)
        return picture()
    monkeypatch.setattr('shared.artwork_sources.fetch_image', download)
    assert not adopt('song', VIDEO, old)
    with artwork_store().connect() as db:
        row = db.execute('SELECT token,next_try FROM selections WHERE track_id=?', ('song',)).fetchone()
    assert tuple(row) == (new, 0)
    assert artwork_store().effective_ref('song') is None


def test_orphans_do_not_starve_later_selections_and_remap_copies_pending_intent():
    from shared.artwork_sources import pending_selections, schedule_selection
    token = selection(VIDEO, 'deezer:track:1', CATALOG)
    for i in range(12):
        schedule_selection(f'a-orphan-{i}', VIDEO, token)
    schedule_selection('z-valid', VIDEO, token)
    assert set(pending_selections({'z-valid'})) == {'z-valid'}
    artwork_store().remap({'z-valid': 'rekeyed'})
    assert set(pending_selections({'rekeyed'})) == {'rekeyed'}


def test_effective_tombstone_prevents_legacy_embedded_fallback(tmp_path, monkeypatch):
    from player.cover_manager import CoverFetchManager
    store = artwork_store()
    store.bind('song', store.put(picture()), 'youtube')
    store.bind_override('song', None, 'none')
    monkeypatch.setattr('player.cover_manager.DEFAULT_CACHE_DIR', str(tmp_path))
    manager = CoverFetchManager()
    try:
        assert manager.extract_now(SimpleNamespace(id='song', cover_source='youtube'), '/missing.mp3') is None
        assert manager.extract_now(SimpleNamespace(id='song', cover_source='none'), '/missing.mp3') is None
    finally:
        manager.executor.shutdown()


def test_transient_transform_failure_is_not_a_cacheable_placeholder(tmp_path, monkeypatch):
    from shared.api import app
    store = artwork_store()
    store.bind('song', store.put(picture()), 'youtube')
    track = SimpleNamespace(id='song', cover_source='youtube')
    monkeypatch.setattr(store, 'open_variant', lambda *args: (_ for _ in ()).throw(OSError('busy')))
    monkeypatch.setattr('shared.api.routes.playback._get_api', lambda: {
        'get_core': lambda: (SimpleNamespace(get_cover_url=lambda _: store.path('song')), None, None),
        'get_track_by_id': lambda *_: track,
        'WEB_UI_PATH': str(tmp_path),
    })
    response = app.test_client().get('/api/static/cover/song?size=640')
    assert response.status_code == 503
    assert 'no-store' in response.headers['Cache-Control']
    assert response.headers['Retry-After'] == '2'


def test_staging_reconciliation_preserves_live_lease_and_removes_crash_leftovers(tmp_path):
    from shared.artwork_staging import staging, reconcile
    with staging(tmp_path) as target:
        target.write_bytes(b'partial')
        reconcile(tmp_path)
        assert target.exists()
    orphan = tmp_path / '.job-orphan'
    orphan.mkdir()
    (orphan / 'lease').write_bytes(b'0')
    (orphan / 'result.jpg').write_bytes(b'partial')
    reconcile(tmp_path)
    assert not orphan.exists()


def test_worker_deadline_already_includes_time_waiting_in_other_locks(tmp_path):
    worker = ImageProcess(timeout=5)
    worker.lock.acquire()
    start = time.monotonic()
    try:
        with pytest.raises(OSError, match='queue deadline'):
            worker.render(tmp_path / 'source', io.BytesIO(), 320, True, deadline=start + .1)
        assert time.monotonic() - start < 1
    finally:
        worker.lock.release()
        worker.close()


def test_acquisition_cancel_probe_stops_silent_child_promptly():
    from shared.process_runner import run, acquisition_scope, AcquisitionCancelled
    start = time.monotonic()
    with acquisition_scope(lambda: time.monotonic() - start > .1):
        with pytest.raises(AcquisitionCancelled):
            run([sys.executable, '-c', 'import time;time.sleep(30)'], deadline=start + 30)
    assert time.monotonic() - start < 2


def test_repair_processes_share_cancellation_and_the_earliest_budget():
    from shared.library_repair import _run
    from shared.process_runner import acquisition_scope, AcquisitionCancelled, media_budget
    start = time.monotonic()
    with acquisition_scope(lambda: time.monotonic() - start > .1):
        with pytest.raises(AcquisitionCancelled):
            _run([sys.executable, '-c', 'import time;time.sleep(30)'])
    assert time.monotonic() - start < 2
    @media_budget(.3)
    def remux():
        _run([sys.executable, '-c', 'import time;time.sleep(.15)'])
        _run([sys.executable, '-c', 'import time;time.sleep(30)'])
    start = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        remux()
    assert time.monotonic() - start < 2


def test_quota_lock_wait_is_cooperative_and_obeys_the_complete_deadline(tmp_path):
    script = r'''
from gevent import monkey
monkey.patch_all()
import gevent, os, subprocess, sys, time
from pathlib import Path
from shared.artwork_variants import VariantCache, VariantDeadline
root = Path(sys.argv[1])
root.mkdir()
locker = """import os,sys,time
f=open(sys.argv[1], 'w+b');f.write(b'0');f.flush();f.seek(0)
if os.name=='nt':
 import msvcrt;msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
else:
 import fcntl;fcntl.flock(f.fileno(),fcntl.LOCK_EX)
print('READY',flush=True);time.sleep(10)
"""
p = subprocess.Popen([sys.executable,'-c',locker,str(root/'.quota.lock')],stdout=subprocess.PIPE)
try:
 assert p.stdout.readline().strip()==b'READY'
 cache=VariantCache(root,root.parent/'originals')
 start=time.monotonic();ticks=[]
 gevent.spawn_later(.02,lambda:ticks.append(time.monotonic()-start))
 try:
  cache.open('a'*64+'-160-original-jpeg90-v1.jpg',lambda _: (_ for _ in ()).throw(AssertionError('generated after deadline')),deadline=start+.15)
  raise AssertionError('deadline ignored')
 except VariantDeadline:
  pass
 assert time.monotonic()-start<.5
 assert ticks and ticks[0]<.12,ticks
finally:
 p.kill();p.wait(timeout=5);p.stdout.close()
'''
    subprocess.run([sys.executable, '-c', script, str(tmp_path / 'cache')], check=True, timeout=10)


def test_packaged_entrypoint_dispatches_artwork_worker(tmp_path):
    source = tmp_path / 'source.png'
    source.write_bytes(picture())
    target = tmp_path / 'out.jpg'
    root = Path(__file__).resolve().parents[1]
    # Windows build jobs use the actual frozen sidecar, local runs the entrypoint.
    binary = os.environ.get('SOUNDSIBLE_ENGINE_BIN')
    command = [str((root / binary).resolve())] if binary else [sys.executable, str(root / 'soundsible_engine.py')]
    child = subprocess.Popen([*command, '--artwork-worker'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    child.stdin.write((json.dumps({'source': str(source), 'target': str(target), 'size': 160, 'square': True}) + '\n').encode())
    child.stdin.flush()
    try:
        assert json.loads(child.stdout.readline()) == {'ok': True}
        assert Image.open(target).size == (160, 160)
        child.stdin.write((json.dumps({'source': 'http://127.0.0.1/private', 'target': str(target),
                                      'operation': 'fetch'}) + '\n').encode())
        child.stdin.flush()
        # The packaged HTTP module must load and reject the reference before
        # doing I/O, rather than fail with a missing frozen import.
        assert json.loads(child.stdout.readline()) == {'ok': False, 'error': 'ValueError'}
    finally:
        child.stdin.close()
        assert child.wait(timeout=5) == 0
        child.stdout.close()
    assert not target.exists()  # EOF also cleans the child's last staging file


@pytest.mark.parametrize('cancel', [False, True])
def test_http_transport_stops_blocked_dns_and_leaves_no_reader(tmp_path, monkeypatch, cancel):
    import threading
    import requests
    from shared import artwork_sources as sources
    from shared.artwork_worker import http_worker
    marker = tmp_path / 'dns-started'
    command = f'''import socket,time
from pathlib import Path
def blocked(*a,**k):
 Path({str(marker)!r}).touch();time.sleep(30)
socket.getaddrinfo=blocked
from shared.artwork_worker import main
main()
'''
    http_worker.close()
    monkeypatch.setattr(http_worker, 'command', [sys.executable, '-c', command])
    monkeypatch.setattr(sources, 'IMAGE_DEADLINE_SEC', 2)
    stop = threading.Event()
    # Cancel only after DNS has actually started, including on a slow host.
    def cancel_when_started():
        for _ in range(300):
            if marker.exists():
                stop.set()
                return
            if stop.wait(.01):
                return
    watcher = threading.Thread(target=cancel_when_started) if cancel else None
    if watcher:
        watcher.start()
    start = time.monotonic()
    try:
        with pytest.raises(requests.Timeout):
            sources.fetch_image(URL, video_id=VIDEO, stop=stop)
        assert marker.exists()
        assert time.monotonic() - start < 4
        assert http_worker.process is None and http_worker.reader is None
        assert not list((artwork_store().cache / '.image-http').glob('.job-*'))
    finally:
        stop.set()
        if watcher:
            watcher.join(timeout=1)
        http_worker.close()


def test_http_transport_rejects_saturation_without_an_attempt_or_contact(monkeypatch):
    from shared.artwork_sources import fetch_image, ArtworkDeferred
    from shared.artwork_worker import http_worker
    assert http_worker.slots.acquire(blocking=False)
    try:
        with pytest.raises(ArtworkDeferred) as failure:
            fetch_image(URL, video_id=VIDEO)
        assert not failure.value.contacted
    finally:
        http_worker.slots.release()


def test_http_transport_never_serializes_variant_transforms(tmp_path, monkeypatch):
    import threading
    import requests
    from shared import artwork_sources as sources
    from shared.artwork_worker import http_worker
    marker = tmp_path / 'blocked'
    command = f'''import socket,time
from pathlib import Path
def blocked(*a,**k):
 Path({str(marker)!r}).touch();time.sleep(30)
socket.getaddrinfo=blocked
from shared.artwork_worker import main
main()
'''
    http_worker.close()
    monkeypatch.setattr(http_worker, 'command', [sys.executable, '-c', command])
    source = tmp_path / 'original.png'
    source.write_bytes(picture())
    transformer = ImageProcess(timeout=5)
    stop, errors = threading.Event(), []
    def fetch():
        try:
            sources.fetch_image(URL, video_id=VIDEO, stop=stop)
        except requests.Timeout:
            errors.append('cancelled')
    thread = threading.Thread(target=fetch)
    try:
        transformer.render(source, io.BytesIO(), 320, True)
        thread.start()
        until = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < until:
            time.sleep(.01)
        assert marker.exists()
        start = time.monotonic()
        output = io.BytesIO()
        transformer.render(source, output, 640, True)
        assert output.getvalue() and time.monotonic() - start < 2
    finally:
        stop.set()
        thread.join(timeout=3)
        http_worker.close()
        transformer.close()
    assert not thread.is_alive() and errors == ['cancelled']


def test_http_transport_parent_death_preserves_writer_until_watchdog_exit(tmp_path):
    from shared.artwork_staging import reconcile
    root, marker = tmp_path / 'staging', tmp_path / 'writer-pid'
    child_code = f'''import os,time
from pathlib import Path
from shared import artwork_http
def blocked(url,target,video_id=None):
 Path(target).write_bytes(b'partial');Path({str(marker)!r}).write_text(str(os.getpid()));time.sleep(20)
artwork_http.fetch=blocked
from shared.artwork_worker import main
main()
'''
    parent_code = f'''from shared.artwork_worker import ImageProcess
worker=ImageProcess(command={[sys.executable, '-c', child_code]!r},timeout=1.5,pending=1)
worker.render({URL!r},None,0,False,operation='fetch',staging_dir={str(root)!r})
'''
    parent = subprocess.Popen([sys.executable, '-c', parent_code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        until = time.monotonic() + 5
        while not marker.exists() and parent.poll() is None and time.monotonic() < until:
            time.sleep(.01)
        assert marker.exists()
        parent.kill()
        parent.wait(timeout=5)
        reconcile(root)
        assert list(root.glob('.job-*/result.jpg'))  # child still owns it
        time.sleep(1.8)
        reconcile(root)
        assert not list(root.glob('.job-*'))
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=5)


@pytest.mark.parametrize('phase', ['body', 'headers'])
def test_real_http_trickle_respects_absolute_image_budget(tmp_path, monkeypatch, phase):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    import requests
    from shared import artwork_sources as sources
    from shared.artwork_worker import http_worker
    class Slow(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            if self.path == '/fast':
                data = picture()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if phase == 'headers':
                try:
                    self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                    for _ in range(100):
                        self.wfile.write(b'x')
                        self.wfile.flush()
                        time.sleep(.02)
                    self.wfile.write(b'\r\n\r\n')
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self.send_response(200)
            self.end_headers()
            try:
                for _ in range(100):
                    self.wfile.write(b'x')
                    self.wfile.flush()
                    time.sleep(.02)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(sources, 'safe_image_url', lambda *a, **k: True)
    http_worker.close()
    # The production allowlist remains strict in both processes. Only this
    # explicit child command substitutes a loopback provider for the test.
    monkeypatch.setattr(http_worker, 'command', [sys.executable, '-c',
        'from shared import artwork_sources as s;s.safe_image_url=lambda *a,**k: True;'
        'from shared.artwork_worker import main;main()'])
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:9')
    try:
        assert sources.fetch_image(f'http://127.0.0.1:{server.server_port}/fast') == picture()
        monkeypatch.setattr(sources, 'IMAGE_DEADLINE_SEC', .15)
        start = time.monotonic()
        with pytest.raises(requests.Timeout):
            sources.fetch_image(f'http://127.0.0.1:{server.server_port}/image')
        assert time.monotonic() - start < 1
        assert http_worker.process is None
    finally:
        http_worker.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_source_429_persists_pause_without_more_requests(monkeypatch):
    from shared import artwork_sources as sources
    from shared.artwork_worker import http_worker
    calls = []
    def response(*a, **k):
        calls.append(1)
        return {'status': 429, 'retry_after': '3600', 'data': b''}
    monkeypatch.setattr(http_worker, 'render', response)
    for _ in range(3):
        with pytest.raises(sources.ArtworkDeferred) as failure:
            sources.fetch_image(URL, video_id=VIDEO)
        assert failure.value.seconds > 3500
    assert len(calls) == 1


def test_downloader_kills_a_descendant_even_when_its_parent_has_exited(tmp_path):
    from shared.process_runner import run, acquisition_scope, AcquisitionCancelled
    marker = tmp_path / 'escaped.txt'
    descendant = f"import time;from pathlib import Path;print('READY',flush=True);time.sleep(1);Path({str(marker)!r}).write_text('escaped')"
    parent = f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{descendant!r}])"
    ready = []
    def progress(line):
        if line == 'READY':
            ready.append(time.monotonic())
    # A startup timeout could pass without ever spawning the descendant on a
    # slow Windows runner. Wait for its handshake before cancelling the tree.
    with acquisition_scope(lambda: bool(ready) and time.monotonic() - ready[0] > .1):
        with pytest.raises(AcquisitionCancelled):
            run([sys.executable, '-c', parent], deadline=time.monotonic() + 10, on_line=progress)
    assert ready
    time.sleep(1.1)
    assert not marker.exists()
