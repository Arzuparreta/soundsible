"""Opening a podcast before following it: the browse route hands the page the
show's own details along with its episodes, because the directory result that
led there is not always around to supply them (a reload, a shared link)."""

from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

import shared.api.routes.podcasts as podcasts
from shared.models import LibraryMetadata

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>My Show</title>
    <itunes:author>Host Name</itunes:author>
    <itunes:image href="https://cdn.example.com/show.jpg" />
    <item>
      <title>Episode one</title>
      <guid>ep1</guid>
      <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1" />
    </item>
  </channel>
</rss>
"""


@pytest.fixture()
def client():
    app = Flask(__name__)
    app.register_blueprint(podcasts.podcasts_bp)
    return app.test_client()


def test_browse_returns_the_show_with_its_episodes(client):
    with patch.object(podcasts, "fetch_feed_body", return_value=FEED) as fetch:
        resp = client.get("/api/podcasts/episodes-by-url?rss_url=https://example.com/rss")
    assert resp.status_code == 200
    body = resp.get_json()
    fetch.assert_called_once_with("https://example.com/rss")
    assert body["rss_url"] == "https://example.com/rss"
    assert body["show"] == {"title": "My Show", "author": "Host Name", "image_url": "https://cdn.example.com/show.jpg"}
    assert [e["title"] for e in body["episodes"]] == ["Episode one"]


def test_browse_refuses_a_private_feed_url_without_fetching_it(client):
    with patch.object(podcasts, "fetch_feed_body") as fetch:
        resp = client.get("/api/podcasts/episodes-by-url?rss_url=http://127.0.0.1/feed")
    assert resp.status_code == 400
    fetch.assert_not_called()


def test_browse_reports_an_unreachable_feed(client):
    with patch.object(podcasts, "fetch_feed_body", side_effect=OSError("timed out")):
        resp = client.get("/api/podcasts/episodes-by-url?rss_url=https://example.com/rss")
    assert resp.status_code == 502


def test_subscribing_records_what_the_feed_says_about_the_show(client):
    lib = MagicMock()
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api = {"_ensure_lib_metadata": lambda: (lib, metadata), "socketio": None, "emit_to_user": MagicMock()}
    with patch.object(podcasts, "_get_api", return_value=api), \
            patch("shared.hardening.get_request_auth_context", return_value={"kind": "owner"}), \
            patch.object(podcasts, "fetch_feed_body", return_value=FEED):
        resp = client.post("/api/podcasts/subscribe", json={"rss_url": "https://example.com/rss"})
    assert resp.status_code == 200
    sub = resp.get_json()["subscription"]
    assert (sub["title"], sub["author"], sub["image_url"]) == ("My Show", "Host Name", "https://cdn.example.com/show.jpg")
    assert metadata.podcast_subscriptions == [sub]
    assert [e["guid"] for e in metadata.podcast_episode_cache[sub["id"]]["episodes"]] == ["ep1"]
    lib.require_saved.assert_called_once()
