"""Route coverage for the preview streaming fast path:

- /api/preview/stream/<id> serves a fully cached preview straight from disk
  (no yt-dlp resolution) with the stored Content-Type,
- the proxy passes the upstream Content-Type through (it used to hardcode
  audio/mpeg while streaming mp4/webm), advertises Accept-Ranges, and tees
  full-body streams into the disk cache,
- /api/preview/prefetch validates ids and hands them to the background worker.
"""

from flask import Flask

from shared import preview_cache
from shared.api.routes import playback as playback_routes
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

VID = "dQw4w9WgXcQ"


def _make_runtime(tmp_path):
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
        playback_routes, "_get_preview_stream_url_cached", lambda api, vid: "http://upstream.invalid/a"
    )

    def fake_get(url, **kwargs):
        seen["headers"] = kwargs.get("headers") or {}
        # googlevideo answers an open-ended range with a 206 covering the file.
        return _FakeUpstream(data, "audio/webm", status_code=206, content_range=f"bytes 0-{len(data) - 1}/{len(data)}")

    monkeypatch.setattr(playback_routes.requests, "get", fake_get)

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
        playback_routes, "_get_preview_stream_url_cached", lambda api, vid: "http://upstream.invalid/a"
    )
    monkeypatch.setattr(
        playback_routes.requests, "get", lambda url, **kwargs: _FakeUpstream(data, "audio/webm")
    )

    response = _make_app().test_client().get(
        f"/api/preview/stream/{VID}", headers={"Range": "bytes=500-"}
    )

    assert response.status_code == 200  # fake upstream ignores ranges; passthrough
    assert preview_cache.get_cached(VID) is None  # partial body never cached


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
