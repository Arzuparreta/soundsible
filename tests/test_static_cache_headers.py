"""
Caching contract for the assets the player fetches by the hundred.

Artwork is the one served asset whose request count scales with the size of the
library: one row of a list is one cover. Served with no freshness at all, every
scroll back through a library is a revalidation round trip per row — invisible
on localhost, a stall on a phone reaching a home server over Tailscale.

The service worker file is the mirror image: it must *never* be reusable
without asking, because a cached worker is one that can no longer be replaced.
"""

import os
from unittest.mock import patch

import pytest

from shared.api import app
from shared.api.routes.playback import COVER_CACHE_SEC
from shared.runtime import configure_runtime, runtime_with_overrides


@pytest.fixture
def client():
    return app.test_client()


def _cover_response(client, cover_path):
    """GET a track cover, with the library stubbed to hand back `cover_path`."""

    class _Track:
        id = "track-1"

    class _Lib:
        def get_cover_url(self, track):
            return cover_path

    with patch(
        "shared.api.routes.playback._get_api",
        return_value={
            "get_core": lambda: (_Lib(), None, None),
            "get_track_by_id": lambda lib, track_id: _Track(),
            "is_trusted_network": lambda addr: True,
            "is_safe_path": lambda path, is_trusted=False: True,
            "WEB_UI_PATH": os.path.join(os.path.dirname(os.path.dirname(__file__)), "ui_web"),
        },
    ):
        return client.get("/api/static/cover/track-1")


def test_cover_is_cacheable_and_revalidates(client, tmp_path):
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")

    response = _cover_response(client, str(cover))

    assert response.status_code == 200
    cache_control = response.headers["Cache-Control"]
    assert f"max-age={COVER_CACHE_SEC}" in cache_control
    # Artwork belongs to one person's library: shared caches must not hold it.
    assert "private" in cache_control
    # The window can be long: a cover edited on another device no longer
    # relies on it expiring to show up elsewhere — `library_updated`'s
    # `cover_changed` flag busts every other connected client immediately.
    # This just bounds staleness for a client that missed that event.
    assert COVER_CACHE_SEC >= 3600
    # `conditional=True` is what keeps the eventual recheck a cheap 304.
    assert response.headers.get("ETag")


def test_cover_placeholder_is_cacheable(client, tmp_path):
    """The answer for every track with no artwork, so it is worth pinning."""
    response = _cover_response(client, str(tmp_path / "missing.jpg"))

    assert response.status_code == 200
    assert "max-age=" in response.headers["Cache-Control"]


def test_service_worker_is_never_stored(client, tmp_path, isolated_runtime):
    # This contract must not depend on a previous UI build having left
    # ui_web/dist behind. Point the route at the smallest valid built bundle.
    dist = tmp_path / "ui-dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (dist / "sw.js").write_text("// service worker fixture", encoding="utf-8")
    configure_runtime(runtime_with_overrides(base=isolated_runtime, ui_dist=dist))

    response = client.get("/player/sw.js")

    assert response.status_code == 200
    # A cached service worker cannot be replaced, and would go on serving an
    # old shell long after the app moved on.
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Service-Worker-Allowed"] == "/player/"


def test_hashed_assets_stay_pinned_and_icons_revalidate(client):
    """Content-hashed builds can be pinned forever; stable names cannot."""
    dist_assets = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "ui_web", "dist", "assets"
    )
    if not os.path.isdir(dist_assets):
        pytest.skip("player not built")
    hashed = next((f for f in os.listdir(dist_assets) if f.endswith(".js")), None)
    if not hashed:
        pytest.skip("no built JS bundle")

    js = client.get(f"/player/assets/{hashed}")
    assert "immutable" in js.headers["Cache-Control"]

    icon = client.get("/player/icons/icon-192.png")
    if icon.status_code == 200:
        cache_control = icon.headers["Cache-Control"]
        assert "max-age=" in cache_control
        # The manifest points at these by name, so they can never be pinned.
        assert "immutable" not in cache_control
