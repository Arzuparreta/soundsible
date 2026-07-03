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

import pytest

from shared import preview_cache
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

VID = "dQw4w9WgXcQ"


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
    def __init__(self, data: bytes, content_type: str = "audio/webm"):
        self._data = data
        self.headers = {"Content-Length": str(len(data)), "Content-Type": content_type}
        self.status_code = 200

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

    monkeypatch.setattr(preview_cache.requests, "get", fake_get)
    preview_cache._download_to_cache(VID, "http://example.invalid/stream")

    cached = preview_cache.get_cached(VID)
    assert cached is not None
    path, content_type = cached
    assert content_type == "audio/webm"
    assert path.read_bytes() == data


def test_request_prefetch_dedupes_and_downloads(runtime, monkeypatch):
    data = b"q" * 2048
    monkeypatch.setattr(preview_cache.requests, "get", lambda url, **kw: _FakeResponse(data))
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
