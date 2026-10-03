"""Opening a podcast before following it: the browse route hands the page the
show's own details along with its episodes, because the directory result that
led there is not always around to supply them (a reload, a shared link)."""

from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

import shared.api.routes.podcasts as podcasts
from shared.models import LibraryMetadata
from shared.podcast_rss import FeedCheck, FeedPage

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


@pytest.fixture(autouse=True)
def _nothing_looked_at_yet():
    podcasts._checked.clear()
    yield
    podcasts._checked.clear()


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
            patch.object(podcasts, "check_feed", return_value=FeedCheck(FeedPage(FEED, None), {"etag": '"v1"'})):
        resp = client.post("/api/podcasts/subscribe", json={"rss_url": "https://example.com/rss"})
    assert resp.status_code == 200
    sub = resp.get_json()["subscription"]
    assert (sub["title"], sub["author"], sub["image_url"]) == ("My Show", "Host Name", "https://cdn.example.com/show.jpg")
    assert metadata.podcast_subscriptions == [sub]
    assert [e["guid"] for e in metadata.podcast_episode_cache[sub["id"]]["episodes"]] == ["ep1"]
    assert metadata.podcast_episode_cache[sub["id"]]["next"] is None
    assert metadata.podcast_episode_cache[sub["id"]]["validators"] == {"etag": '"v1"'}
    lib.require_saved.assert_called_once()


def _followed(metadata):
    metadata.podcast_subscriptions = [{"id": "feed", "title": "My Show", "rss_url": "https://example.com/rss"}]
    return {"_ensure_lib_metadata": lambda: (MagicMock(), metadata), "socketio": None, "emit_to_user": MagicMock()}


def test_a_followed_show_remembers_where_its_feed_goes_on(client):
    # The cached list is what the page shows at once, so it still offers the
    # rest the fresh one did.
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    with patch.object(podcasts, "_get_api", return_value=_followed(metadata)), \
            patch.object(podcasts, "check_feed", return_value=FeedCheck(FeedPage(FEED, 1292), {})) as fetch:
        fresh = client.get("/api/podcasts/feeds/feed/episodes").get_json()
        cached = client.get("/api/podcasts/feeds/feed/episodes?cached=1").get_json()
    fetch.assert_called_once_with("https://example.com/rss", None)
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
            patch.object(podcasts, "check_feed", return_value=FeedCheck(FeedPage(feed, None), {})):
        fresh = client.get("/api/podcasts/feeds/feed/episodes").get_json()
        cached = client.get("/api/podcasts/feeds/feed/episodes?cached=1").get_json()
    assert (len(fresh["episodes"]), fresh["next"]) == (503, None)
    assert (len(cached["episodes"]), cached["next"]) == (500, 500)


NEWER = FEED.replace(b"<item>", b"""<item>
      <title>Episode two</title>
      <guid>ep2</guid>
      <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg" length="1" />
    </item>
    <item>""", 1)


def _kept_show(metadata, feed=FEED, validators=None):
    """A followed show whose feed was read before the engine started, so the
    next open is the first look at it since."""
    looked = FeedCheck(FeedPage(feed, None), validators or {})
    metadata.podcast_episode_cache["feed"] = podcasts._cached_episodes(
        podcasts.parse_feed_episodes(feed, "https://example.com/rss"), None, looked)
    lib = MagicMock()
    api = _followed(metadata)
    api["_ensure_lib_metadata"] = lambda: (lib, metadata)
    return api, lib


def _open(client, api, looked=None, query="", error=None):
    with patch.object(podcasts, "_get_api", return_value=api), \
            patch.object(podcasts, "check_feed", return_value=looked, side_effect=error) as check:
        resp = client.get(f"/api/podcasts/feeds/feed/episodes{query}")
    return resp, check


def test_opening_a_show_finds_the_episode_published_since_it_was_last_read(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata, validators={"etag": '"v1"'})
    resp, check = _open(client, api, FeedCheck(FeedPage(NEWER, None), {"etag": '"v2"'}))
    body = resp.get_json()
    # The feed is asked only for what changed since the read it remembers.
    check.assert_called_once_with("https://example.com/rss", {"etag": '"v1"'})
    assert [e["guid"] for e in body["episodes"]] == ["ep2", "ep1"]
    assert body["changed"] is True
    assert metadata.podcast_episode_cache["feed"]["validators"] == {"etag": '"v2"'}
    lib.require_saved.assert_called_once()


def test_a_feed_that_has_not_changed_costs_no_parse_and_no_write(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata, validators={"etag": '"v1"'})
    kept = dict(metadata.podcast_episode_cache["feed"])
    with patch.object(podcasts, "parse_feed_episodes") as parse:
        resp, _ = _open(client, api, FeedCheck(None, {"etag": '"v1"'}))
    parse.assert_not_called()
    lib.require_saved.assert_not_called()
    assert resp.get_json()["changed"] is False
    assert [e["guid"] for e in resp.get_json()["episodes"]] == ["ep1"]
    assert metadata.podcast_episode_cache["feed"] == kept


def test_a_feed_without_validators_that_sends_the_same_page_is_not_parsed_again(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata)
    with patch.object(podcasts, "parse_feed_episodes") as parse:
        resp, _ = _open(client, api, FeedCheck(FeedPage(FEED, None), {}))
    parse.assert_not_called()
    lib.require_saved.assert_not_called()
    assert resp.get_json()["changed"] is False


def test_a_show_reopened_within_the_minute_is_not_looked_at_again(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, _ = _kept_show(metadata)
    _open(client, api, FeedCheck(None, {}))
    _, again = _open(client, api, FeedCheck(None, {}))
    again.assert_not_called()
    podcasts._checked["feed"] -= podcasts._RECHECK_SEC
    _, later = _open(client, api, FeedCheck(None, {}))
    later.assert_called_once()


def test_the_cached_answer_never_goes_to_the_feed(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, _ = _kept_show(metadata)
    resp, check = _open(client, api, query="?cached=1")
    check.assert_not_called()
    assert [e["guid"] for e in resp.get_json()["episodes"]] == ["ep1"]


def test_refreshing_reads_the_whole_feed_however_recently_it_was_read(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, _ = _kept_show(metadata, validators={"etag": '"v1"'})
    _open(client, api, FeedCheck(None, {"etag": '"v1"'}))
    resp, check = _open(client, api, FeedCheck(FeedPage(NEWER, None), {"etag": '"v2"'}), query="?refresh=1")
    check.assert_called_once_with("https://example.com/rss", None)
    assert [e["guid"] for e in resp.get_json()["episodes"]] == ["ep2", "ep1"]


def test_a_failed_read_is_not_kept_as_a_fresh_one(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata)
    kept = dict(metadata.podcast_episode_cache["feed"])
    resp, _ = _open(client, api, error=OSError("timed out"))
    assert resp.status_code == 200
    assert [e["guid"] for e in resp.get_json()["episodes"]] == ["ep1"]
    assert metadata.podcast_episode_cache["feed"] == kept
    lib.require_saved.assert_not_called()
    # Asked for by hand, the failure is reported rather than papered over.
    refreshed, _ = _open(client, api, error=OSError("timed out"), query="?refresh=1")
    assert refreshed.status_code == 502


def test_enclosure_proxy_closes_upstream_on_reader_cancel(client):
    upstream = MagicMock()
    upstream.status_code = 206
    upstream.headers = {"Content-Type": "audio/mp4", "Content-Range": "bytes 0-9/20", "Content-Length": "10"}
    upstream.iter_content.return_value = iter([b"12345", b"67890"])
    with (
        patch.object(
            podcasts, "decode_enclosure_stream_token", return_value={"enclosure_url": "https://example.com/episode"}
        ),
        patch.object(podcasts.requests, "get", return_value=upstream) as get,
    ):
        response = client.get(
            "/api/podcasts/stream/token", headers={"Range": "bytes=0-9", "Cookie": "engine-secret"}, buffered=False
        )
        assert response.status_code == 206
        assert response.headers["Content-Range"] == "bytes 0-9/20"
        assert next(response.response) == b"12345"
        response.close()
    upstream.close.assert_called()
    assert get.call_args.kwargs["headers"] == {
        "User-Agent": "SoundsiblePodcast/1.0",
        "Accept": "audio/*,*/*",
        "Range": "bytes=0-9",
    }


def test_enclosure_proxy_closes_failed_upstream(client):
    upstream = MagicMock()
    upstream.raise_for_status.side_effect = OSError("provider refused")
    with (
        patch.object(
            podcasts, "decode_enclosure_stream_token", return_value={"enclosure_url": "https://example.com/episode"}
        ),
        patch.object(podcasts.requests, "get", return_value=upstream),
    ):
        assert client.get("/api/podcasts/stream/token").status_code == 502
    upstream.close.assert_called_once()
