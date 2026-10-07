"""Route coverage for the preview streaming fast path:

- /api/preview/stream/<id> serves a fully cached preview straight from disk
  (no yt-dlp resolution) with the stored Content-Type,
- the proxy passes the upstream Content-Type through (it used to hardcode
  audio/mpeg while streaming mp4/webm), advertises Accept-Ranges, and tees
  full-body streams into the disk cache,
- /api/preview/prefetch validates ids and hands them to the background worker,
- stream-URL resolution is single-flighted and negatively cached, so a listener
  drumming on a preview row cannot fan out into N yt-dlp extractions.
"""

import os
import threading
import time
from types import SimpleNamespace

import pytest
from flask import Flask

from shared import preview_cache
from shared.api.routes import playback as playback_routes
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.stream_resolution import resolved_stream
from tests.test_preview_cache import _fragmented_mp4

VID = "dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _no_fill_outlives_its_test():
    yield
    # A progressive response can be read to the end before its fill commits.
    # A fill still registered would be joined by the next test's request for
    # the same id, and committed into this test's cache directory.
    deadline = time.time() + 5
    while preview_cache._fills and time.time() < deadline:
        time.sleep(0.01)
    assert not preview_cache._fills


def _patch_upstream(monkeypatch, fake_get):
    """Stand in for the pooled upstream session preview fetches go through."""
    monkeypatch.setattr(preview_cache, "upstream_session", lambda: SimpleNamespace(get=fake_get))
    monkeypatch.setattr(preview_cache, "_preview_is_decodable", lambda path: True)


def _make_runtime(tmp_path):
    preview_cache.clear_upstream_backoff()
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


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(playback_routes.playback_bp)
    return app


def _patch_api(monkeypatch):
    """Minimal _get_api stub: resolution must not be reached on cache hits."""

    def fail_downloader(open_browser=False):
        raise AssertionError("downloader must not be touched")

    monkeypatch.setattr(
        playback_routes,
        "_get_api",
        lambda: {"get_downloader": fail_downloader, "get_scope_from_request": lambda: "default"},
    )


class _FakeUpstream:
    def __init__(self, data: bytes, content_type: str, status_code: int = 200, content_range: str | None = None):
        self._data = data
        self.status_code = status_code
        self.headers = {"Content-Length": str(len(data)), "Content-Type": content_type}
        if content_range:
            self.headers["Content-Range"] = content_range

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size):
        for i in range(0, len(self._data), chunk_size):
            yield self._data[i : i + chunk_size]

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _ProgressiveUpstream(_FakeUpstream):
    def __init__(self, data: bytes, first_ready: threading.Event, release: threading.Event):
        super().__init__(
            data,
            "audio/mp4",
            status_code=206,
            content_range=f"bytes 0-{len(data) - 1}/{len(data)}",
        )
        self.first_ready = first_ready
        self.release = release

    def iter_content(self, chunk_size):
        yield self._data[:chunk_size]
        self.first_ready.set()
        self.release.wait(timeout=5)
        yield self._data[chunk_size:]


def _seed_cache(data: bytes, content_type: str) -> None:
    writer = preview_cache.open_writer(VID, content_type, len(data))
    writer.write(data)
    assert writer.commit() is True


def test_preview_stream_serves_cached_file_without_resolution(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = b"cached-audio" * 100
    _seed_cache(data, "audio/mp4")

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert response.data == data
    assert response.headers["Content-Type"].startswith("audio/mp4")
    assert response.headers.get("Accept-Ranges") == "bytes"


def test_preview_stream_cached_file_supports_range(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 4
    _seed_cache(data, "audio/mp4")
    rows = []
    monkeypatch.setattr("shared.telemetry.emit", lambda event, row: rows.append(row))

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=100-199"}
    )

    assert response.status_code == 206
    assert response.data == data[100:200]
    segments = rows[-1]["segments"]
    assert segments["range_kind"] == "closed"
    assert segments["range_start"] == 100
    assert segments["range_end"] == 199
    assert segments["layout"] == preview_cache.SOURCE_LAYOUT


def test_cached_preview_if_range_survives_reads_and_changes_on_replacement(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 4
    _seed_cache(data, "audio/webm")
    client = _make_app().test_client()
    initial = client.get(f"/api/preview/stream/{VID}")
    validator = initial.headers["ETag"]
    assert "Last-Modified" not in initial.headers
    preview_cache.mark_served(VID)
    ranged = client.get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=100-199", "If-Range": validator})
    assert ranged.status_code == 206
    assert ranged.data == data[100:200]
    assert ranged.headers["ETag"] == validator
    assert client.get(f"/api/preview/stream/{VID}", headers={"If-None-Match": validator}).status_code == 304
    # Reacquisition after eviction publishes a new generation, even at equal size.
    preview_cache._audio_path(VID).unlink()
    _seed_cache(data[::-1], "audio/webm")
    replaced = client.get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=100-199", "If-Range": validator})
    assert replaced.status_code == 200
    assert replaced.data == data[::-1]
    assert replaced.headers["ETag"] != validator


def test_legacy_preview_has_no_recency_validator_and_still_serves_ranges(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 4
    _seed_cache(data, "audio/webm")
    metadata = preview_cache.cached_metadata(VID)
    metadata.pop("revision")
    preview_cache._write_meta(VID, metadata)
    response = _make_app().test_client().get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=100-199"})
    assert response.status_code == 206
    assert response.data == data[100:200]
    assert "ETag" not in response.headers
    assert "Last-Modified" not in response.headers


def test_cold_preview_is_acquired_once_then_served_from_disk(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = b"proxied-bytes" * 512
    seen = {}
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )

    def fake_get(url, **kwargs):
        seen["headers"] = kwargs.get("headers") or {}
        # googlevideo answers an open-ended range with a 206 covering the file.
        return _FakeUpstream(data, "audio/webm", status_code=206, content_range=f"bytes 0-{len(data) - 1}/{len(data)}")

    _patch_upstream(monkeypatch, fake_get)

    client = _make_app().test_client()
    response = client.get(f"/api/preview/stream/{VID}")

    # Acquisition is one complete upstream request. The client never receives
    # an upstream response that it would have to continue with another request.
    assert seen["headers"].get("Range") == "bytes=0-"
    assert response.status_code == 200
    assert "Content-Range" not in response.headers
    assert response.data == data
    assert response.headers["Content-Type"].startswith("audio/webm")
    assert response.headers.get("Accept-Ranges") == "bytes"

    # The complete file was committed before the response was served…
    cached = preview_cache.get_cached(VID)
    assert cached is not None
    assert cached[0].read_bytes() == data
    assert cached[1] == "audio/webm"

    # …so the next request is served from disk, never touching the resolver.
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_url_cached",
        lambda api, vid: (_ for _ in ()).throw(AssertionError("must not resolve")),
    )
    replay = client.get(f"/api/preview/stream/{VID}")
    assert replay.status_code == 200
    assert replay.data == data


def test_cold_preview_client_range_is_served_from_complete_local_file(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 8
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    _patch_upstream(monkeypatch, lambda url, **kwargs: _FakeUpstream(data, "audio/webm"))

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=500-"}
    )

    assert response.status_code == 206
    assert response.data == data[500:]
    assert preview_cache.get_cached(VID) is not None


def test_long_preview_streams_from_one_growing_local_spool(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 1024
    first_ready = threading.Event()
    release = threading.Event()
    calls = []
    url = f"http://upstream.invalid/audio?clen={len(data)}&dur=120&mime=audio%2Fmp4"
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream(url, egress="direct"),
    )
    monkeypatch.setattr(preview_cache, "_PROGRESSIVE_FAST_COMPLETE_SEC", 0.0)
    released_resources = []
    monkeypatch.setattr(
        playback_routes.request_scope,
        "release_resources",
        lambda: released_resources.append(True),
    )

    def fake_get(upstream_url, **kwargs):
        calls.append((upstream_url, kwargs["headers"]))
        return _ProgressiveUpstream(data, first_ready, release)

    _patch_upstream(monkeypatch, fake_get)
    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}",
        buffered=False,
    )

    assert first_ready.wait(timeout=2)
    assert response.status_code == 200
    assert response.headers["X-Soundsible-Playback-Cache"] == "progressive"
    assert released_resources == [True]
    status = preview_cache.preparation_status(VID).as_dict()
    assert status["state"] == "streamable"
    assert status["downloaded_bytes"] >= 65536
    assert status["total_bytes"] == len(data)
    assert status["buffered_seconds"] >= 6
    assert 0 < status["progress"] < 1

    release.set()
    assert b"".join(response.response) == data
    assert calls == [(url, {"Range": "bytes=0-"})]
    deadline = time.time() + 2
    while time.time() < deadline and preview_cache.get_cached(VID) is None:
        time.sleep(0.01)
    assert preview_cache.get_cached(VID) is not None
    # Bytes were served from the spool, so the file keeps the offsets the
    # listener was given; no flattening is even attempted.
    meta = preview_cache.cached_metadata(VID)
    assert meta["layout"] == preview_cache.SOURCE_LAYOUT
    assert "flatten_failed" not in meta
    assert preview_cache.get_cached(VID)[0].read_bytes() == data


def test_a_cold_mp4_the_listener_waited_for_is_served_flat(tmp_path, monkeypatch):
    """A listener who waited for the whole file never saw the source layout.

    YouTube's audio is fragmented MP4, and iOS reads such a file fragment by
    fragment before it plays: on the phone that measured a median of 31
    requests and 7.8 s, against 5 requests and 2.1 s for a flat file.
    """
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    source = tmp_path / "youtube.m4a"
    _fragmented_mp4(source)
    data = source.read_bytes()
    assert data.count(b"moof") > 1
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    _patch_upstream(
        monkeypatch,
        lambda url, **kwargs: _FakeUpstream(
            data, "audio/mp4", status_code=206, content_range=f"bytes 0-{len(data) - 1}/{len(data)}"
        ),
    )

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=0-1"})

    assert response.status_code == 206
    assert response.headers["X-Soundsible-Playback-Cache"] == "cold"
    path, _content_type = preview_cache.get_cached(VID)
    flat = path.read_bytes()
    assert flat.count(b"moof") == 0
    assert response.data == flat[:2]
    assert int(response.headers["Content-Range"].rsplit("/", 1)[1]) == len(flat)
    assert preview_cache.cached_metadata(VID)["layout"] == preview_cache.FLAT_MP4_LAYOUT


def test_a_request_arriving_during_the_commit_gets_the_committed_file(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    source = tmp_path / "youtube.m4a"
    _fragmented_mp4(source)
    data = source.read_bytes()
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    _patch_upstream(
        monkeypatch,
        lambda url, **kwargs: _FakeUpstream(
            data, "audio/mp4", status_code=206, content_range=f"bytes 0-{len(data) - 1}/{len(data)}"
        ),
    )
    committing = threading.Event()
    release = threading.Event()

    def decodable(_path):
        committing.set()
        return release.wait(timeout=5)

    def fast_complete_ends_mid_commit(self, timeout=None):
        # The route's five-second wait runs out while the commit is still
        # checking and flattening the finished file.
        assert committing.wait(timeout=5)
        threading.Timer(0.2, release.set).start()

    monkeypatch.setattr(preview_cache, "_preview_is_decodable", decodable)
    monkeypatch.setattr(preview_cache.ProgressiveHandle, "wait_for_fast_complete", fast_complete_ends_mid_commit)

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert response.headers["X-Soundsible-Playback-Cache"] == "cold"
    path, _content_type = preview_cache.get_cached(VID)
    assert response.data == path.read_bytes()
    assert response.data.count(b"moof") == 0


def test_only_a_new_playback_flattens_an_idle_source_layout(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    root = preview_cache.preview_cache_dir()
    root.mkdir(parents=True)
    path = preview_cache._audio_path(VID)
    _fragmented_mp4(path)
    preview_cache._meta_path(VID).write_text(
        f'{{"content_type": "audio/mp4", "layout": "{preview_cache.SOURCE_LAYOUT}"}}'
    )
    idle = time.time() - preview_cache._SOURCE_FLATTEN_IDLE_SEC - 60
    client = _make_app().test_client()

    os.utime(path, (idle, idle))
    inside_the_song = client.get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=1000-"})
    assert inside_the_song.status_code == 206
    assert path.read_bytes().count(b"moof") > 0

    os.utime(path, (idle, idle))
    new_playback = client.get(f"/api/preview/stream/{VID}", headers={"Range": "bytes=0-1"})
    assert new_playback.status_code == 206
    assert path.read_bytes().count(b"moof") == 0
    assert int(new_playback.headers["Content-Range"].rsplit("/", 1)[1]) == path.stat().st_size


def test_progressive_future_range_waits_locally_without_second_upstream_get(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = bytes(range(256)) * 1024
    first_ready = threading.Event()
    release = threading.Event()
    calls = []
    url = f"http://upstream.invalid/audio?clen={len(data)}&dur=120&mime=audio%2Fmp4"
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream(url, egress="direct"),
    )
    monkeypatch.setattr(preview_cache, "_PROGRESSIVE_FAST_COMPLETE_SEC", 0.0)
    _patch_upstream(
        monkeypatch,
        lambda upstream_url, **kwargs: calls.append(kwargs["headers"])
        or _ProgressiveUpstream(data, first_ready, release),
    )

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}",
        headers={"Range": "bytes=70000-80000"},
        buffered=False,
    )
    assert response.status_code == 206
    assert response.headers["Content-Range"] == f"bytes 70000-80000/{len(data)}"
    release.set()
    assert b"".join(response.response) == data[70000:80001]
    assert calls == [{"Range": "bytes=0-"}]


def test_abandoned_progressive_response_cancels_its_fill(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = b"z" * (256 * 1024)
    first_ready = threading.Event()
    release = threading.Event()
    url = f"http://upstream.invalid/audio?clen={len(data)}&dur=120&mime=audio%2Fmp4"
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream(url, egress="direct"),
    )
    monkeypatch.setattr(preview_cache, "_PROGRESSIVE_FAST_COMPLETE_SEC", 0.0)
    _patch_upstream(
        monkeypatch,
        lambda upstream_url, **kwargs: _ProgressiveUpstream(data, first_ready, release),
    )

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}",
        buffered=False,
    )
    assert response.headers["X-Soundsible-Playback-Cache"] == "progressive"
    response.close()
    release.set()

    deadline = time.time() + 2
    while time.time() < deadline and preview_cache.preparation_status(VID).state != "cold":
        time.sleep(0.01)
    assert preview_cache.preparation_status(VID).state == "cold"
    assert preview_cache.get_cached(VID) is None


def test_preview_refresh_keeps_each_resolutions_egress(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    relay_url = "http://100.91.167.48:8888"
    resolutions = iter(
        [
            resolved_stream("http://upstream.invalid/stale", egress="relay", proxy_url=relay_url),
            resolved_stream("http://upstream.invalid/fresh", egress="direct"),
        ]
    )
    monkeypatch.setattr(playback_routes, "_get_preview_stream_cached", lambda api, vid, **_kw: next(resolutions))
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs.get("proxies")))
        if url.endswith("/stale"):
            return _FakeUpstream(b"", "audio/mp4", status_code=403)
        return _FakeUpstream(b"fresh", "audio/mp4", status_code=206, content_range="bytes 0-4/5")

    _patch_upstream(monkeypatch, fake_get)
    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert calls == [
        ("http://upstream.invalid/stale", {"http": relay_url, "https": relay_url}),
        ("http://upstream.invalid/fresh", None),
    ]
    assert response.headers["X-Soundsible-Playback-Egress"] == "direct"


def test_fallback_url_rejection_opens_bounded_backoff(tmp_path, monkeypatch):
    """Only rejection after the independent fallback opens global backoff."""
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    resolutions = iter(
        [
            resolved_stream("http://upstream.invalid/stale", egress="direct"),
            resolved_stream("http://upstream.invalid/fresh", egress="direct"),
        ]
    )
    monkeypatch.setattr(playback_routes, "_get_preview_stream_cached", lambda api, vid, **_kw: next(resolutions))
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _FakeUpstream(b"", "audio/mp4", status_code=403)

    _patch_upstream(monkeypatch, fake_get)
    retired = []
    monkeypatch.setattr(preview_cache, "retire_upstream_session", lambda: retired.append(True))

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 503
    assert int(response.headers["Retry-After"]) > 0
    assert calls == ["http://upstream.invalid/stale", "http://upstream.invalid/fresh"]
    # Every retry gets fresh pooled connection/cookie state; this isolation is
    # deliberately not evidence for any particular external rejection cause.
    assert retired == [True, True]

    calls.clear()
    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")
    assert response.status_code == 503
    assert calls == []


def test_rejection_retry_skips_the_fast_path(tmp_path, monkeypatch):
    """A rejection retries via the independent audio-only-capable resolver."""
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    resolutions = iter(
        [
            resolved_stream("http://upstream.invalid/rejected", egress="direct"),
            resolved_stream("http://upstream.invalid/fallback", egress="direct"),
        ]
    )
    seen_skip_fast_path = []

    def fake_resolver(api, vid, *, skip_fast_path=False):
        seen_skip_fast_path.append(skip_fast_path)
        return next(resolutions)

    monkeypatch.setattr(playback_routes, "_get_preview_stream_cached", fake_resolver)

    def fake_get(url, **kwargs):
        if url.endswith("/rejected"):
            return _FakeUpstream(b"", "audio/mp4", status_code=403)
        return _FakeUpstream(b"fresh", "audio/mp4", status_code=206, content_range="bytes 0-4/5")

    _patch_upstream(monkeypatch, fake_get)

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert response.data == b"fresh"
    assert seen_skip_fast_path == [False, True]


def test_preview_open_range_rejects_a_truncated_prefix(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/audio", egress="direct"),
    )
    seen_headers = []

    def fake_get(url, **kwargs):
        seen_headers.append(kwargs["headers"])
        return _FakeUpstream(
            b"chunk",
            "audio/mp4",
            status_code=206,
            content_range="bytes 0-4/1000000",
        )

    _patch_upstream(monkeypatch, fake_get)

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 502
    assert seen_headers == [{"Range": "bytes=0-"}]
    assert preview_cache.get_cached(VID) is None


def test_followup_browser_range_never_returns_to_upstream(tmp_path, monkeypatch):
    """The exact regression: continuing one song must not become a second CDN GET."""
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid, **_kw: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    data = b"a" * (1024 * 1024)
    upstream_calls = []

    def fake_get(url, **kwargs):
        upstream_calls.append(kwargs["headers"])
        return _FakeUpstream(data, "audio/webm", status_code=206)

    _patch_upstream(monkeypatch, fake_get)
    client = _make_app().test_client()

    first = client.get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=0-"}
    )
    second = client.get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=524288-"}
    )

    assert first.status_code == 206
    assert first.data == data
    assert second.status_code == 206
    assert second.data == data[512 * 1024 :]
    assert upstream_calls == [{"Range": "bytes=0-"}]


def test_preview_stream_cache_hit_skips_cache_fill(tmp_path, monkeypatch):
    """A disk hit must not re-queue a download of what is already on disk."""
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    root = preview_cache.preview_cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{VID}{preview_cache.AUDIO_SUFFIX}").write_bytes(b"cached")
    (root / f"{VID}{preview_cache.META_SUFFIX}").write_text('{"content_type": "audio/mp4"}')
    queued = []
    monkeypatch.setattr(
        playback_routes.preview_cache,
        "request_prefetch",
        lambda video_ids, **kw: queued.append(list(video_ids)) or [],
    )

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert response.headers["X-Soundsible-Playback-Cache"] == "disk"
    assert queued == []


def test_preview_prefetch_queues_valid_ids(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    calls = {}

    def fake_request_prefetch(video_ids, *, download, resolver, refresh_resolver=None):
        calls["ids"] = list(video_ids)
        calls["download"] = download
        assert callable(resolver)
        calls["refresh"] = callable(refresh_resolver)
        return list(video_ids)

    monkeypatch.setattr(playback_routes.preview_cache, "request_prefetch", fake_request_prefetch)
    monkeypatch.setattr(
        playback_routes.preview_cache,
        "preparation_status",
        lambda video_id: preview_cache.PreparationStatus("pending"),
    )

    response = _make_app().test_client().post(
        "/api/preview/prefetch",
        json={"video_ids": [VID, "not a valid id", "zz"], "download": True},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "queued"
    assert body["queued"] == [VID]
    assert body["preparation"] == {VID: {"state": "pending"}}
    assert calls == {"ids": [VID], "download": True, "refresh": True}


def test_preview_prefetch_rejects_non_list_body(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)

    response = _make_app().test_client().post("/api/preview/prefetch", json={"video_ids": "abc"})

    assert response.status_code == 400


def test_preview_status_reports_truthful_batch_state(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    monkeypatch.setattr(
        playback_routes.preview_cache,
        "preparation_status",
        lambda video_id: preview_cache.PreparationStatus(
            "unavailable", "upstream_backoff", 12
        ),
    )

    response = _make_app().test_client().post(
        "/api/preview/status",
        json={"video_ids": [VID, "invalid"]},
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "preparation": {
            VID: {
                "state": "unavailable",
                "reason": "upstream_backoff",
                "retry_after": 12,
            }
        }
    }


def test_warm_preview_stream_cache_fills_ttl_entry():
    """Catalog/discovery resolve warms the in-process preview URL cache so the
    next /api/preview/stream/<id> request cannot pay the yt-dlp resolution."""
    playback_routes._preview_stream_urls.clear()
    try:
        assert playback_routes._preview_stream_urls.get(VID) is None
        playback_routes.warm_preview_stream_cache(VID, "https://rr.googlevideo.com/warmed")
        warmed = playback_routes._preview_stream_urls.get(VID)
        assert warmed is not None
        assert warmed.url == "https://rr.googlevideo.com/warmed"
    finally:
        playback_routes._preview_stream_urls.clear()


def test_preview_stream_url_resolution_is_single_flight(monkeypatch):
    """Ten taps on the same preview must cost one yt-dlp extraction, not ten.

    The resolution is seconds long, so the window where a naive TTL cache still
    reads as a miss is exactly the window a user drums their finger in.
    """
    playback_routes._preview_stream_urls.clear()
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow_resolve(video_id, *, skip_fast_path=False):
        calls.append(video_id)
        started.set()
        release.wait(5)
        return resolved_stream("https://rr.googlevideo.com/one", egress="direct")

    downloader = SimpleNamespace(downloader=SimpleNamespace(get_resolved_stream=slow_resolve))
    api = {"get_downloader": lambda open_browser=False: downloader}

    results: list[str] = []

    def call():
        results.append(playback_routes._get_preview_stream_url_cached(api, VID))

    threads = [threading.Thread(target=call) for _ in range(10)]
    threads[0].start()
    assert started.wait(5), "leader never entered resolution"
    for thread in threads[1:]:
        thread.start()
    # Give the waiters a moment to pile onto the in-flight call before it returns.
    time.sleep(0.05)
    release.set()
    for thread in threads:
        thread.join(5)

    try:
        assert calls == [VID]
        assert results == ["https://rr.googlevideo.com/one"] * 10
    finally:
        playback_routes._preview_stream_urls.clear()


def test_preview_stream_url_failure_is_negatively_cached(monkeypatch):
    """An unresolvable id is remembered briefly so a retry storm cannot turn
    into a yt-dlp storm — but not for as long as a success."""
    playback_routes._preview_stream_urls.clear()
    calls = []

    def failing(video_id, *, skip_fast_path=False):
        calls.append(video_id)
        return None

    downloader = SimpleNamespace(downloader=SimpleNamespace(get_resolved_stream=failing))
    api = {"get_downloader": lambda open_browser=False: downloader}

    try:
        assert playback_routes._get_preview_stream_url_cached(api, VID) == ""
        assert playback_routes._get_preview_stream_url_cached(api, VID) == ""
        assert calls == [VID]
        assert playback_routes.PREVIEW_STREAM_NEGATIVE_TTL_SEC < playback_routes.PREVIEW_STREAM_CACHE_TTL_SEC
    finally:
        playback_routes._preview_stream_urls.clear()
