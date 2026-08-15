"""Unit coverage for shared.preview_cache: the tee-through disk cache and the
background prefetch worker that make preview playback start fast.

The contract that matters for playback UX:
- only a *complete* byte stream is ever committed (a dropped client or a
  truncated upstream body must never poison the cache),
- one writer per video id,
- the cache stays under its size cap by evicting oldest-first,
- prefetch requests dedupe while a job is queued/in flight.
"""

import os
import threading
import time
from types import SimpleNamespace

import pytest

from shared import preview_cache
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

VID = "dQw4w9WgXcQ"


def _patch_upstream(monkeypatch, fake_get):
    """Stand in for the pooled upstream session preview fetches go through."""
    monkeypatch.setattr(preview_cache, "upstream_session", lambda: SimpleNamespace(get=fake_get))


@pytest.fixture
def runtime(tmp_path):
    reset_runtime()
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)
    yield runtime
    reset_runtime()


class _FakeResponse:
    def __init__(self, data: bytes, content_type: str = "audio/webm", status_code: int = 200):
        self._data = data
        self.headers = {"Content-Length": str(len(data)), "Content-Type": content_type}
        self.status_code = status_code

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size):
        for i in range(0, len(self._data), chunk_size):
            yield self._data[i : i + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_writer_commit_roundtrip(runtime):
    data = b"a" * 1000
    writer = preview_cache.open_writer(VID, "audio/mp4", len(data))
    assert writer is not None
    writer.write(data)
    assert writer.commit() is True

    cached = preview_cache.get_cached(VID)
    assert cached is not None
    path, content_type = cached
    assert content_type == "audio/mp4"
    assert path.read_bytes() == data


def test_incomplete_stream_is_discarded(runtime):
    writer = preview_cache.open_writer(VID, "audio/mp4", 1000)
    writer.write(b"a" * 500)  # upstream said 1000 bytes; only 500 arrived
    assert writer.commit() is False
    assert preview_cache.get_cached(VID) is None
    assert not preview_cache._part_path(VID).exists()


def test_abandon_cleans_up_and_releases_the_writer_slot(runtime):
    writer = preview_cache.open_writer(VID, "audio/mp4", 1000)
    assert preview_cache.open_writer(VID, "audio/mp4", 1000) is None  # exclusive
    writer.write(b"abc")
    writer.abandon()
    assert not preview_cache._part_path(VID).exists()
    assert preview_cache.get_cached(VID) is None
    # Slot released: a new writer can be claimed.
    retry = preview_cache.open_writer(VID, "audio/mp4", 1000)
    assert retry is not None
    retry.abandon()


def test_cached_file_refuses_new_writer(runtime):
    writer = preview_cache.open_writer(VID, "audio/mp4", 3)
    writer.write(b"abc")
    assert writer.commit() is True
    assert preview_cache.open_writer(VID, "audio/mp4", 3) is None


def test_oversized_file_is_not_cached(runtime, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_PREVIEW_CACHE_MB", "1")
    too_big = (1024 * 1024 // 4) + 1  # > 25% of the cap
    assert preview_cache.open_writer(VID, "audio/mp4", too_big) is None


def test_cache_disabled_via_env(runtime, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_PREVIEW_CACHE_MB", "0")
    assert preview_cache.open_writer(VID, "audio/mp4", 10) is None


def test_lru_eviction_removes_oldest_first(runtime, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_PREVIEW_CACHE_MB", "1")
    root = preview_cache.preview_cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for i, vid in enumerate(["aaaaaaaaaa1", "aaaaaaaaaa2", "aaaaaaaaaa3"]):
        path = root / f"{vid}{preview_cache.AUDIO_SUFFIX}"
        path.write_bytes(b"x" * (400 * 1024))
        (root / f"{vid}{preview_cache.META_SUFFIX}").write_text("{}")
        os.utime(path, (now - 100 + i, now - 100 + i))  # 1 is oldest

    preview_cache.enforce_cache_limit()  # 1200KB > 1024KB → evict the oldest

    assert not (root / f"aaaaaaaaaa1{preview_cache.AUDIO_SUFFIX}").exists()
    assert not (root / f"aaaaaaaaaa1{preview_cache.META_SUFFIX}").exists()
    assert (root / f"aaaaaaaaaa2{preview_cache.AUDIO_SUFFIX}").exists()
    assert (root / f"aaaaaaaaaa3{preview_cache.AUDIO_SUFFIX}").exists()


def test_download_to_cache_lands_complete_file(runtime, monkeypatch):
    data = b"z" * 5000

    def fake_get(url, **kwargs):
        assert kwargs.get("stream") is True
        return _FakeResponse(data)

    _patch_upstream(monkeypatch, fake_get)
    preview_cache._download_to_cache(VID, "http://example.invalid/stream")

    cached = preview_cache.get_cached(VID)
    assert cached is not None
    path, content_type = cached
    assert content_type == "audio/webm"
    assert path.read_bytes() == data


def test_download_to_cache_respects_upstream_backoff(runtime, monkeypatch):
    """Speculative fills must not keep hammering a refused upstream."""
    monkeypatch.setattr(preview_cache, "upstream_backoff_remaining", lambda: 12)
    _patch_upstream(
        monkeypatch,
        lambda url, **kwargs: pytest.fail("backoff must skip the upstream request"),
    )

    preview_cache._download_to_cache(VID, "http://example.invalid/stream")


def test_retire_upstream_session_forces_a_new_session(runtime):
    """A retired session must never be handed out again."""
    first = preview_cache.upstream_session()
    preview_cache.retire_upstream_session()
    second = preview_cache.upstream_session()
    assert second is not first


def test_download_once_retires_the_session_on_403(runtime, monkeypatch):
    """A 403 must poison neither the URL nor the pooled session forever."""
    retired = []
    monkeypatch.setattr(preview_cache, "retire_upstream_session", lambda: retired.append(True))
    _patch_upstream(monkeypatch, lambda url, **kwargs: _FakeResponse(b"", status_code=403))

    with pytest.raises(preview_cache.PreviewUpstreamRejected):
        preview_cache._download_once(VID, "http://example.invalid/stream")

    assert retired == [True]


def test_concurrent_playback_and_prefetch_share_one_whole_file_download(runtime, monkeypatch):
    """A deck and prefetch racing for one id must produce one CDN request."""
    data = b"single-flight" * 1024
    entered = threading.Event()
    release = threading.Event()
    calls = []

    class _BlockingResponse(_FakeResponse):
        def iter_content(self, chunk_size):
            entered.set()
            release.wait(timeout=5)
            yield data

    def fake_get(url, **kwargs):
        calls.append((url, kwargs["headers"]))
        return _BlockingResponse(data)

    _patch_upstream(monkeypatch, fake_get)
    results = []

    def acquire():
        results.append(preview_cache.ensure_cached(VID, "http://example.invalid/stream"))

    first = threading.Thread(target=acquire)
    second = threading.Thread(target=acquire)
    first.start()
    assert entered.wait(timeout=5)
    second.start()
    release.set()
    first.join(timeout=5)
    second.join(timeout=5)

    assert not first.is_alive()
    assert not second.is_alive()
    assert calls == [("http://example.invalid/stream", {"Range": "bytes=0-"})]
    assert len(results) == 2
    assert all(result is not None and result[0].read_bytes() == data for result in results)


def test_different_preview_ids_never_download_from_upstream_in_parallel(runtime, monkeypatch):
    """Speculative work must yield the CDN lane before another song can fetch."""
    first_id = "aaaaaaaaaa1"
    second_id = "bbbbbbbbbb2"
    first_entered = threading.Event()
    release_first = threading.Event()
    calls = []

    class _SerialResponse(_FakeResponse):
        def __init__(self, video_id: str):
            super().__init__(video_id.encode() * 100)
            self.video_id = video_id

        def iter_content(self, chunk_size):
            if self.video_id == first_id:
                first_entered.set()
                release_first.wait(timeout=5)
            yield self._data

    def fake_get(url, **kwargs):
        video_id = url.rsplit("/", 1)[-1]
        calls.append(video_id)
        return _SerialResponse(video_id)

    _patch_upstream(monkeypatch, fake_get)
    first = threading.Thread(
        target=preview_cache.ensure_cached,
        args=(first_id, f"http://example.invalid/{first_id}"),
    )
    second = threading.Thread(
        target=preview_cache.ensure_cached,
        args=(second_id, f"http://example.invalid/{second_id}"),
    )
    first.start()
    assert first_entered.wait(timeout=5)
    second.start()

    # The second caller is alive but has not reached the CDN while the first
    # complete-file transfer owns the station-wide slot.
    time.sleep(0.05)
    assert calls == [first_id]
    release_first.set()
    first.join(timeout=5)
    second.join(timeout=5)

    assert calls == [first_id, second_id]
    assert preview_cache.get_cached(first_id) is not None
    assert preview_cache.get_cached(second_id) is not None


def test_request_prefetch_dedupes_and_downloads(runtime, monkeypatch):
    data = b"q" * 2048
    _patch_upstream(monkeypatch, lambda url, **kw: _FakeResponse(data))
    release = threading.Event()

    def resolver(vid: str) -> str:
        release.wait(timeout=5)
        return "http://example.invalid/stream"

    first = preview_cache.request_prefetch([VID], download=True, resolver=resolver)
    second = preview_cache.request_prefetch([VID], download=True, resolver=resolver)
    assert first == [VID]
    assert second == []  # still queued/in flight → deduped

    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and not preview_cache.get_cached(VID):
        time.sleep(0.05)
    cached = preview_cache.get_cached(VID)
    assert cached is not None
    assert cached[0].read_bytes() == data

    # Already cached → a new download request is a no-op.
    assert preview_cache.request_prefetch([VID], download=True, resolver=resolver) == []
