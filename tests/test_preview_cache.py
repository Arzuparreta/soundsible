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
import json
from pathlib import Path
import subprocess
import threading
import time
from types import SimpleNamespace

import pytest

from shared import preview_cache
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.ffmpeg_runtime import ffmpeg_executable

VID = "dQw4w9WgXcQ"


def _fragmented_mp4(path: Path) -> None:
    subprocess.run(
        [
            ffmpeg_executable(), "-y", "-v", "error",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1.25",
            "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration", "200000",
            "-f", "mp4", str(path),
        ],
        check=True,
    )


def _packet_hashes(path: Path) -> list[str]:
    ffprobe = str(Path(ffmpeg_executable()).with_name("ffprobe"))
    result = subprocess.run(
        [
            ffprobe, "-v", "error", "-select_streams", "a:0",
            "-show_packets", "-show_entries", "packet=data_hash",
            "-show_data_hash", "md5", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return [packet["data_hash"] for packet in json.loads(result.stdout)["packets"]]


def _probe(path: Path) -> dict:
    ffprobe = str(Path(ffmpeg_executable()).with_name("ffprobe"))
    result = subprocess.run(
        [
            ffprobe, "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,duration", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)["streams"][0]


def _patch_upstream(monkeypatch, fake_get):
    """Stand in for the pooled upstream session preview fetches go through."""
    monkeypatch.setattr(preview_cache, "upstream_session", lambda: SimpleNamespace(get=fake_get))
    monkeypatch.setattr(preview_cache, "_preview_is_decodable", lambda path: True)


@pytest.fixture
def runtime(tmp_path):
    reset_runtime()
    preview_cache.clear_upstream_backoff()
    with preview_cache._preparation_lock:
        preview_cache._preparation_failures.clear()
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
    with preview_cache._preparation_lock:
        preview_cache._preparation_failures.clear()
    preview_cache.clear_upstream_backoff()
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


def test_mp4_commit_flattens_fragments_without_reencoding(runtime, tmp_path):
    source = tmp_path / "fragmented.mp4"
    _fragmented_mp4(source)
    original_packets = _packet_hashes(source)
    original_probe = _probe(source)
    raw = source.read_bytes()
    assert raw.count(b"mdat") > 1

    writer = preview_cache.open_writer(VID, "audio/mp4", len(raw))
    assert writer is not None
    writer.write(raw)
    assert writer.commit(preview_cache._preview_is_decodable) is True

    cached = preview_cache.get_cached(VID)
    assert cached is not None
    path, content_type = cached
    assert content_type == "audio/mp4"
    assert path.read_bytes().count(b"mdat") == 1
    # Packet hashes are the encoded AAC payload. Equality proves `-c copy`
    # changed only the MP4 container, not one frame of the audio stream.
    assert _packet_hashes(path) == original_packets
    normalized_probe = _probe(path)
    assert normalized_probe["codec_name"] == original_probe["codec_name"] == "aac"
    assert float(normalized_probe["duration"]) == pytest.approx(float(original_probe["duration"]), abs=0.001)
    assert preview_cache.cached_metadata(VID)["layout"] == preview_cache.FLAT_MP4_LAYOUT


def test_legacy_mp4_normalizes_once_for_concurrent_readers(runtime, monkeypatch):
    root = preview_cache.preview_cache_dir()
    root.mkdir(parents=True)
    path = preview_cache._audio_path(VID)
    path.write_bytes(b"fragmented")
    preview_cache._meta_path(VID).write_text('{"content_type":"audio/mp4"}')
    calls = []

    def normalize(source, video_id):
        calls.append((source, video_id))
        time.sleep(0.05)
        output = root / "normalized.tmp"
        output.write_bytes(b"flat")
        return output

    monkeypatch.setattr(preview_cache, "_remux_flat_mp4", normalize)
    results = []
    threads = [threading.Thread(target=lambda: results.append(preview_cache.get_cached(VID))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert len(calls) == 1
    assert len(results) == 2
    assert path.read_bytes() == b"flat"
    assert preview_cache.cached_metadata(VID)["layout"] == preview_cache.FLAT_MP4_LAYOUT


def test_failed_mp4_normalization_keeps_playable_source_and_is_not_retried(runtime, monkeypatch):
    root = preview_cache.preview_cache_dir()
    root.mkdir(parents=True)
    path = preview_cache._audio_path(VID)
    path.write_bytes(b"source")
    preview_cache._meta_path(VID).write_text('{"content_type":"audio/mp4"}')
    calls = []
    monkeypatch.setattr(preview_cache, "_remux_flat_mp4", lambda *_args: calls.append(True) or None)

    assert preview_cache.get_cached(VID) == (path, "audio/mp4")
    assert path.read_bytes() == b"source"
    assert preview_cache.cached_metadata(VID)["layout"] == preview_cache.SOURCE_LAYOUT
    assert preview_cache.get_cached(VID) == (path, "audio/mp4")
    assert calls == [True]


def test_new_mp4_commit_falls_back_to_the_valid_source(runtime, monkeypatch):
    monkeypatch.setattr(preview_cache, "_remux_flat_mp4", lambda *_args: None)
    writer = preview_cache.open_writer(VID, "audio/mp4", 6)
    assert writer is not None
    writer.write(b"source")

    assert writer.commit(lambda _path: True) is True
    path, content_type = preview_cache.get_cached(VID)
    assert path.read_bytes() == b"source"
    assert content_type == "audio/mp4"
    assert preview_cache.cached_metadata(VID)["layout"] == preview_cache.SOURCE_LAYOUT


def test_incomplete_stream_is_discarded(runtime):
    writer = preview_cache.open_writer(VID, "audio/mp4", 1000)
    writer.write(b"a" * 500)  # upstream said 1000 bytes; only 500 arrived
    assert writer.commit() is False
    assert preview_cache.get_cached(VID) is None
    assert not preview_cache._part_path(VID).exists()


def test_completed_but_undecodable_stream_is_discarded(runtime):
    writer = preview_cache.open_writer(VID, "audio/mp4", 3)
    assert writer is not None
    writer.write(b"bad")

    assert writer.commit(lambda path: False) is False
    assert preview_cache.get_cached(VID) is None


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


def test_preparation_status_distinguishes_work_from_ready_bytes(runtime):
    assert preview_cache.preparation_status(VID).state == "cold"
    with preview_cache._pending_lock:
        preview_cache._pending.add((VID, True))
    try:
        assert preview_cache.preparation_status(VID).state == "pending"
    finally:
        with preview_cache._pending_lock:
            preview_cache._pending.discard((VID, True))

    writer = preview_cache.open_writer(VID, "audio/mp4", 3)
    assert writer is not None
    writer.write(b"abc")
    assert writer.commit()
    assert preview_cache.preparation_status(VID).state == "ready"


def test_preparation_failure_has_a_bounded_retry_window(runtime):
    preview_cache._record_preparation_failure(VID, "upstream_rejected", 30)
    status = preview_cache.preparation_status(VID)
    assert status.state == "unavailable"
    assert status.reason == "upstream_rejected"
    assert 1 <= status.retry_after <= 30


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


def test_acquisition_refreshes_one_rejected_url_before_declaring_outage(runtime, monkeypatch):
    calls = []
    retired = []

    def fake_get(url, **kwargs):
        calls.append(url)
        if url.endswith("/rejected"):
            return _FakeResponse(b"", status_code=403)
        return _FakeResponse(b"fresh-audio")

    _patch_upstream(monkeypatch, fake_get)
    monkeypatch.setattr(preview_cache, "retire_upstream_session", lambda: retired.append(True))
    refreshes = []

    cached, stream = preview_cache.acquire_cached(
        VID,
        lambda _vid: "http://example.invalid/rejected",
        refresh_resolver=lambda vid: refreshes.append(vid) or "http://example.invalid/fresh",
    )

    assert cached is not None
    assert stream is not None and stream.url.endswith("/fresh")
    assert calls == ["http://example.invalid/rejected", "http://example.invalid/fresh"]
    assert refreshes == [VID]
    assert retired == [True]
    assert preview_cache.upstream_backoff_remaining() == 0


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
    assert preview_cache.preparation_status(VID).state == "pending"

    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and not preview_cache.get_cached(VID):
        time.sleep(0.05)
    cached = preview_cache.get_cached(VID)
    assert cached is not None
    assert cached[0].read_bytes() == data
    assert preview_cache.preparation_status(VID).state == "ready"

    # Already cached → a new download request is a no-op.
    assert preview_cache.request_prefetch([VID], download=True, resolver=resolver) == []


def test_background_prefetch_uses_the_same_rejection_refresh_as_playback(runtime, monkeypatch):
    video_id = "fallback001"
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        if url.endswith("/fast"):
            return _FakeResponse(b"", status_code=403)
        return _FakeResponse(b"verified-audio")

    _patch_upstream(monkeypatch, fake_get)
    refreshed = []
    queued = preview_cache.request_prefetch(
        [video_id],
        download=True,
        resolver=lambda _vid: "http://example.invalid/fast",
        refresh_resolver=lambda vid: refreshed.append(vid) or "http://example.invalid/fallback",
    )

    assert queued == [video_id]
    deadline = time.time() + 5
    while time.time() < deadline and preview_cache.preparation_status(video_id).state == "pending":
        time.sleep(0.05)

    assert preview_cache.preparation_status(video_id).state == "ready"
    assert calls == ["http://example.invalid/fast", "http://example.invalid/fallback"]
    assert refreshed == [video_id]
