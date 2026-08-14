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

import threading
import time
from types import SimpleNamespace

from flask import Flask

from shared import preview_cache
from shared.api.routes import playback as playback_routes
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.stream_resolution import resolved_stream

VID = "dQw4w9WgXcQ"


def _patch_upstream(monkeypatch, fake_get):
    """Stand in for the pooled upstream session preview fetches go through."""
    monkeypatch.setattr(preview_cache, "upstream_session", lambda: SimpleNamespace(get=fake_get))


def _no_cache_fill(monkeypatch):
    """Isolate the proxy from the background lane that fills the disk cache.

    Serving a request and warming the cache are separate jobs; a test about
    what the proxy returns should not race a worker thread resolving the same
    id. `test_preview_stream_queues_cache_fill` covers the queuing itself.
    """
    monkeypatch.setattr(playback_routes, "_request_cache_fill", lambda api, vid: None)


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

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=100-199"}
    )

    assert response.status_code == 206
    assert response.data == data[100:200]


def test_preview_stream_proxy_passes_content_type_and_tees_to_cache(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = b"proxied-bytes" * 512
    seen = {}
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )

    def fake_get(url, **kwargs):
        seen["headers"] = kwargs.get("headers") or {}
        # googlevideo answers an open-ended range with a 206 covering the file.
        return _FakeUpstream(data, "audio/webm", status_code=206, content_range=f"bytes 0-{len(data) - 1}/{len(data)}")

    _patch_upstream(monkeypatch, fake_get)
    _no_cache_fill(monkeypatch)

    client = _make_app().test_client()
    response = client.get(f"/api/preview/stream/{VID}")

    # No client Range → bytes=0- injected upstream (throttle bypass), and the
    # upstream 206 is translated back to a plain 200 without Content-Range.
    assert seen["headers"].get("Range") == "bytes=0-"
    assert response.status_code == 200
    assert "Content-Range" not in response.headers
    assert response.data == data
    assert response.headers["Content-Type"].startswith("audio/webm")
    assert response.headers.get("Accept-Ranges") == "bytes"

    # The full stream got teed into the disk cache…
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


def test_preview_stream_proxy_does_not_tee_partial_ranges(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    data = b"tail-bytes"
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    _patch_upstream(monkeypatch, lambda url, **kwargs: _FakeUpstream(data, "audio/webm"))
    _no_cache_fill(monkeypatch)

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=500-"}
    )

    assert response.status_code == 200  # fake upstream ignores ranges; passthrough
    assert preview_cache.get_cached(VID) is None  # partial body never cached


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
    monkeypatch.setattr(playback_routes, "_get_preview_stream_cached", lambda api, vid: next(resolutions))
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs.get("proxies")))
        if url.endswith("/stale"):
            return _FakeUpstream(b"", "audio/mp4", status_code=403)
        return _FakeUpstream(b"fresh", "audio/mp4", status_code=206, content_range="bytes 0-4/5")

    _patch_upstream(monkeypatch, fake_get)
    _no_cache_fill(monkeypatch)
    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 200
    assert calls == [
        ("http://upstream.invalid/stale", {"http": relay_url, "https": relay_url}),
        ("http://upstream.invalid/fresh", None),
    ]
    assert response.headers["X-Soundsible-Playback-Egress"] == "direct"


def test_fresh_url_rejection_opens_station_backoff(tmp_path, monkeypatch):
    """A fresh signed URL failing too is a station outage, not another stale URL."""
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    resolutions = iter(
        [
            resolved_stream("http://upstream.invalid/stale", egress="direct"),
            resolved_stream("http://upstream.invalid/fresh", egress="direct"),
        ]
    )
    monkeypatch.setattr(playback_routes, "_get_preview_stream_cached", lambda api, vid: next(resolutions))
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _FakeUpstream(b"", "audio/mp4", status_code=403)

    _patch_upstream(monkeypatch, fake_get)
    _no_cache_fill(monkeypatch)

    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")

    assert response.status_code == 503
    assert int(response.headers["Retry-After"]) > 0
    assert calls == ["http://upstream.invalid/stale", "http://upstream.invalid/fresh"]

    calls.clear()
    response = _make_app().test_client().get(f"/api/preview/stream/{VID}")
    assert response.status_code == 503
    assert calls == []


def test_preview_open_range_is_bounded_upstream(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid: resolved_stream("http://upstream.invalid/audio", egress="direct"),
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
    _no_cache_fill(monkeypatch)

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    assert seen_headers == [{"Range": "bytes=0-524287"}]


def test_preview_stream_queues_cache_fill(tmp_path, monkeypatch):
    """A range request must still put the whole track on disk.

    Media elements ask for ranges and abandon them, so the inline tee almost
    never commits — which is how a long-running station ends up streaming the
    same track from the network forever. The proxy asks the background lane for
    a full copy instead, and asks for it on a partial range too.
    """
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)
    monkeypatch.setattr(
        playback_routes,
        "_get_preview_stream_cached",
        lambda api, vid: resolved_stream("http://upstream.invalid/a", egress="direct"),
    )
    _patch_upstream(monkeypatch, lambda url, **kwargs: _FakeUpstream(b"partial", "audio/webm"))
    queued = []

    def fake_request_prefetch(video_ids, *, download, resolver):
        queued.append((list(video_ids), download))
        return list(video_ids)

    monkeypatch.setattr(playback_routes.preview_cache, "request_prefetch", fake_request_prefetch)

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=500-"}
    )

    assert response.status_code == 200
    assert queued == [([VID], True)]


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

    def fake_request_prefetch(video_ids, *, download, resolver):
        calls["ids"] = list(video_ids)
        calls["download"] = download
        assert callable(resolver)
        return list(video_ids)

    monkeypatch.setattr(playback_routes.preview_cache, "request_prefetch", fake_request_prefetch)

    response = _make_app().test_client().post(
        "/api/preview/prefetch",
        json={"video_ids": [VID, "not a valid id", "zz"], "download": True},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "queued"
    assert body["queued"] == [VID]
    assert calls == {"ids": [VID], "download": True}


def test_preview_prefetch_rejects_non_list_body(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_api(monkeypatch)

    response = _make_app().test_client().post("/api/preview/prefetch", json={"video_ids": "abc"})

    assert response.status_code == 400


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

    def slow_get_stream_url(video_id):
        calls.append(video_id)
        started.set()
        release.wait(5)
        return "https://rr.googlevideo.com/one"

    downloader = SimpleNamespace(downloader=SimpleNamespace(get_stream_url=slow_get_stream_url))
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

    def failing(video_id):
        calls.append(video_id)
        return None

    downloader = SimpleNamespace(downloader=SimpleNamespace(get_stream_url=failing))
    api = {"get_downloader": lambda open_browser=False: downloader}

    try:
        assert playback_routes._get_preview_stream_url_cached(api, VID) == ""
        assert playback_routes._get_preview_stream_url_cached(api, VID) == ""
        assert calls == [VID]
        assert playback_routes.PREVIEW_STREAM_NEGATIVE_TTL_SEC < playback_routes.PREVIEW_STREAM_CACHE_TTL_SEC
    finally:
        playback_routes._preview_stream_urls.clear()
