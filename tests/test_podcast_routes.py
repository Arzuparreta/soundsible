"""Opening a podcast before following it: the browse route hands the page the
show's own details along with its episodes, because the directory result that
led there is not always around to supply them (a reload, a shared link)."""

from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

import shared.api.routes.podcasts as podcasts
from shared.models import LibraryMetadata
from shared.podcast_rss import FeedPage

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
    with patch.object(podcasts, "fetch_feed_body", return_value=FeedPage(FEED, None)) as fetch:
        resp = client.get("/api/podcasts/episodes-by-url?rss_url=https://example.com/rss")
    assert resp.status_code == 200
    body = resp.get_json()
    fetch.assert_called_once_with("https://example.com/rss", 0)
    assert body["rss_url"] == "https://example.com/rss"
    assert body["show"] == {"title": "My Show", "author": "Host Name", "image_url": "https://cdn.example.com/show.jpg"}
    assert [e["title"] for e in body["episodes"]] == ["Episode one"]
    assert body["next"] is None


def test_browse_reads_a_long_feed_a_page_at_a_time(client):
    # #250: the page offers the rest of a feed too long to read at once, and
    # hands back where it left off to get it.
    with patch.object(podcasts, "fetch_feed_body", return_value=FeedPage(FEED, 1292)) as fetch:
        first = client.get("/api/podcasts/episodes-by-url?rss_url=https://example.com/rss").get_json()
        client.get(f"/api/podcasts/episodes-by-url?rss_url=https://example.com/rss&after={first['next']}")
        client.get("/api/podcasts/episodes-by-url?rss_url=https://example.com/rss&after=-3")
    assert first["next"] == 1292
    assert [call.args for call in fetch.call_args_list] == [
        ("https://example.com/rss", 0),
        ("https://example.com/rss", 1292),
        ("https://example.com/rss", 0),
    ]


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
            patch.object(podcasts, "fetch_feed_body", return_value=FeedPage(FEED, None)):
        resp = client.post("/api/podcasts/subscribe", json={"rss_url": "https://example.com/rss"})
    assert resp.status_code == 200
    sub = resp.get_json()["subscription"]
    assert (sub["title"], sub["author"], sub["image_url"]) == ("My Show", "Host Name", "https://cdn.example.com/show.jpg")
    assert metadata.podcast_subscriptions == [sub]
    assert [e["guid"] for e in metadata.podcast_episode_cache[sub["id"]]["episodes"]] == ["ep1"]
    assert metadata.podcast_episode_cache[sub["id"]]["next"] is None
    lib.require_saved.assert_called_once()


def _followed(metadata):
    metadata.podcast_subscriptions = [{"id": "feed", "title": "My Show", "rss_url": "https://example.com/rss"}]
    return {"_ensure_lib_metadata": lambda: (MagicMock(), metadata), "socketio": None, "emit_to_user": MagicMock()}


def test_a_followed_show_remembers_where_its_feed_goes_on(client):
    # The cached list is what the page shows for the next half hour, so it
    # still offers the rest the fresh one did.
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    with patch.object(podcasts, "_get_api", return_value=_followed(metadata)), \
            patch.object(podcasts, "fetch_feed_body", return_value=FeedPage(FEED, 1292)) as fetch:
        fresh = client.get("/api/podcasts/feeds/feed/episodes").get_json()
        cached = client.get("/api/podcasts/feeds/feed/episodes").get_json()
    fetch.assert_called_once_with("https://example.com/rss")
    assert metadata.podcast_episode_cache["feed"]["next"] == 1292
    for body in (fresh, cached):
        assert [e["guid"] for e in body["episodes"]] == ["ep1"]
        assert body["next"] == 1292


def test_a_followed_show_offers_what_its_cache_leaves_out(client):
    # The cache keeps a show's first 500 episodes. They used to be all a
    # followed show listed once cached; now the rest of the feed follows them.
    items = "".join(
        f"<item><title>Episode {n}</title><guid>ep{n}</guid>"
        f'<enclosure url="https://cdn.example.com/ep{n}.mp3" type="audio/mpeg" length="1" /></item>'
        for n in range(1, 503)
    )
    feed = FEED.replace(b"</channel>", items.encode() + b"</channel>")
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    with patch.object(podcasts, "_get_api", return_value=_followed(metadata)), \
            patch.object(podcasts, "fetch_feed_body", return_value=FeedPage(feed, None)):
        fresh = client.get("/api/podcasts/feeds/feed/episodes").get_json()
        cached = client.get("/api/podcasts/feeds/feed/episodes").get_json()
    assert (len(fresh["episodes"]), fresh["next"]) == (503, None)
    assert (len(cached["episodes"]), cached["next"]) == (500, 500)
