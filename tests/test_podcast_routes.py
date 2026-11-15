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


def test_subscribing_keeps_the_feeds_artwork_over_a_directory_thumbnail(client):
    lib = MagicMock()
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api = {"_ensure_lib_metadata": lambda: (lib, metadata), "socketio": None, "emit_to_user": MagicMock()}
    thumbnail = "https://is1-ssl.mzstatic.com/image/thumb/x.jpg/100x100bb.png"
    with patch.object(podcasts, "_get_api", return_value=api), \
            patch("shared.hardening.get_request_auth_context", return_value={"kind": "owner"}), \
            patch.object(podcasts, "check_feed", return_value=FeedCheck(FeedPage(FEED, None), {})):
        sub = client.post("/api/podcasts/subscribe", json={
            "rss_url": "https://example.com/rss", "image_url": thumbnail}).get_json()["subscription"]
        bare = client.post("/api/podcasts/subscribe", json={
            "rss_url": "https://example.com/bare", "image_url": thumbnail}).get_json()["subscription"]
    assert sub["image_url"] == "https://cdn.example.com/show.jpg"
    assert bare["image_url"] == "https://cdn.example.com/show.jpg"
    with patch.object(podcasts, "_get_api", return_value=api), \
            patch("shared.hardening.get_request_auth_context", return_value={"kind": "owner"}), \
            patch.object(podcasts, "check_feed", return_value=FeedCheck(
                FeedPage(FEED.replace(b'<itunes:image href="https://cdn.example.com/show.jpg" />', b""), None), {})):
        artless = client.post("/api/podcasts/subscribe", json={
            "rss_url": "https://example.com/artless", "image_url": thumbnail}).get_json()["subscription"]
    # A feed without artwork leaves the directory's as the only one there is.
    assert artless["image_url"] == thumbnail


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
    show, episodes = podcasts.parse_feed(feed, "https://example.com/rss")
    metadata.podcast_episode_cache["feed"] = podcasts._cached_episodes(episodes, None, looked, show["image_url"])
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
    with patch.object(podcasts, "parse_feed") as parse:
        resp, _ = _open(client, api, FeedCheck(None, {"etag": '"v1"'}))
    parse.assert_not_called()
    lib.require_saved.assert_not_called()
    assert resp.get_json()["changed"] is False
    assert [e["guid"] for e in resp.get_json()["episodes"]] == ["ep1"]
    assert metadata.podcast_episode_cache["feed"] == kept


def test_a_feed_without_validators_that_sends_the_same_page_is_not_parsed_again(client):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata)
    with patch.object(podcasts, "parse_feed") as parse:
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


def test_a_show_followed_with_a_thumbnail_takes_the_feeds_artwork_on_its_next_read(client):
    # Kept before the cache recorded the show's artwork: the feed is read in
    # full once, even though its validators say nothing changed.
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    api, lib = _kept_show(metadata, validators={"etag": '"v1"'})
    del metadata.podcast_episode_cache["feed"]["show_image"]
    metadata.podcast_subscriptions[0]["image_url"] = "https://is1-ssl.mzstatic.com/x.jpg/100x100bb.png"
    resp, check = _open(client, api, FeedCheck(FeedPage(FEED, None), {"etag": '"v1"'}))
    check.assert_called_once_with("https://example.com/rss", None)
    assert resp.get_json()["subscription"]["image_url"] == "https://cdn.example.com/show.jpg"
    assert metadata.podcast_episode_cache["feed"]["show_image"] == "https://cdn.example.com/show.jpg"
    api["emit_to_user"].assert_called_once_with("library_updated")
    lib.require_saved.assert_called_once()
    # From then on an unchanged feed is an unchanged feed again.
    podcasts._checked.clear()
    _, again = _open(client, api, FeedCheck(None, {"etag": '"v1"'}))
    again.assert_called_once_with("https://example.com/rss", {"etag": '"v1"'})
    api["emit_to_user"].assert_called_once()


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


def _jpeg(width, height):
    from io import BytesIO

    from PIL import Image

    out = BytesIO()
    Image.new("RGB", (width, height), (200, 40, 40)).save(out, "JPEG")
    return out.getvalue()


def _size(body):
    from io import BytesIO

    from PIL import Image

    return Image.open(BytesIO(body)).size


SMALL_JPEG = _jpeg(32, 32)


def _image_response(status=200, kind="image/jpeg", body=SMALL_JPEG, headers=None):
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.status_code = status
    resp.is_redirect = status in (301, 302, 303, 307, 308)
    resp.headers = {"Content-Type": kind, **(headers or {})}
    resp.iter_content.side_effect = lambda **_: iter([body])
    return resp


@pytest.fixture()
def artwork_cache(tmp_path):
    from shared import podcast_artwork
    from shared.artwork_variants import VariantCache

    cache = VariantCache(tmp_path / "cache", tmp_path / "data")
    podcast_artwork._failures.clear()
    with patch.object(podcast_artwork, "_cache", return_value=cache):
        yield cache
    podcast_artwork._failures.clear()


def _publisher(*responses):
    from shared import podcast_artwork

    return patch.object(podcast_artwork.requests, "get", side_effect=list(responses))


def test_artwork_is_fetched_by_the_engine_without_a_referer(client, artwork_cache):
    # esRadio's image host answers 403 to a browser that names Soundsible in
    # its Referer, and every cover in the app is a CSS background.
    with _publisher(_image_response()) as get:
        resp = client.get("/api/podcasts/artwork?url=https://s1.example.com//show.jpg",
                          headers={"Referer": "http://127.0.0.1:5005/player/"})
    assert resp.status_code == 200
    assert resp.mimetype == "image/jpeg" and _size(resp.data) == (32, 32)
    assert resp.headers["Cache-Control"] == "private, max-age=604800"
    assert get.call_args.args == ("https://s1.example.com//show.jpg",)
    assert "Referer" not in get.call_args.kwargs["headers"]


def test_artwork_goes_by_its_bytes_not_by_the_label_its_host_gives_it(client, artwork_cache):
    # Anchor's CDN labels its JPEGs `image/jpg`; COPE serves show artwork as
    # `application/octet-stream`. Both were refused, and neither show had a cover.
    for n, label in enumerate(("image/jpg", "application/octet-stream", "binary/octet-stream", "")):
        with _publisher(_image_response(kind=label)):
            resp = client.get(f"/api/podcasts/artwork?url=https://cdn.example.com/{n}.jpg")
        assert resp.status_code == 200, label


def test_artwork_is_raster_images_only(client, artwork_cache):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    refused = (_image_response(kind="image/svg+xml", body=svg), _image_response(body=b"<html><body>Not found</body></html>"),
               _image_response(body=b"\xff\xd8\xff" + b"0" * 64), _image_response(404),
               _image_response(headers={"Content-Length": str(64 * 1024 * 1024)}))
    for n, answer in enumerate(refused):
        with _publisher(answer):
            assert client.get(f"/api/podcasts/artwork?url=https://cdn.example.com/{n}").status_code == 404
    with _publisher() as get:
        assert client.get("/api/podcasts/artwork?url=http://10.0.0.1/a.jpg").status_code == 400
        assert client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size=200").status_code == 400
    get.assert_not_called()


def test_artwork_redirects_are_checked_like_the_first_url(client, artwork_cache):
    redirect = _image_response(302, headers={"Location": "http://127.0.0.1/admin.png"})
    with _publisher(redirect) as get:
        resp = client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg")
    assert resp.status_code == 404
    get.assert_called_once()
    followed = _image_response(302, headers={"Location": "/real.jpg"})
    with _publisher(followed, _image_response()) as get:
        assert client.get("/api/podcasts/artwork?url=https://cdn.example.com/b.jpg").status_code == 200
    assert get.call_args.args == ("https://cdn.example.com/real.jpg",)


def test_artwork_comes_at_the_size_asked_for(client, artwork_cache):
    with _publisher(_image_response(body=_jpeg(3000, 1500))):
        rows = client.get("/api/podcasts/artwork?url=https://cdn.example.com/huge.jpg&size=160")
        unsized = client.get("/api/podcasts/artwork?url=https://cdn.example.com/huge.jpg")
        largest = client.get("/api/podcasts/artwork?url=https://cdn.example.com/huge.jpg&size=1280")
        square = client.get("/api/podcasts/artwork?url=https://cdn.example.com/huge.jpg&size=640&fit=square")
    assert _size(rows.data) == (160, 80)
    assert _size(unsized.data) == (640, 320)
    assert _size(largest.data) == (1280, 640)
    assert _size(square.data) == (640, 640)


def test_artwork_is_fetched_from_its_publisher_once(client, artwork_cache):
    # Every size is drawn from the one copy the engine fetched; a second
    # device, or a browser whose cache was cleared, costs the publisher nothing.
    with _publisher(_image_response(body=_jpeg(1400, 1400))) as get:
        for size in ("160", "320", "640", "160", "1280", "640"):
            assert client.get(f"/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size={size}").status_code == 200
    get.assert_called_once()


def test_artwork_a_publisher_does_not_have_is_not_asked_for_again_at_once(client, artwork_cache):
    with _publisher(_image_response(404)) as get:
        for _ in range(3):
            resp = client.get("/api/podcasts/artwork?url=https://cdn.example.com/gone.jpg")
            assert resp.status_code == 404
            assert resp.headers["Cache-Control"] == "private, max-age=900"
    get.assert_called_once()


def test_artwork_that_could_not_be_reached_is_tried_again(client, artwork_cache):
    import requests

    with _publisher(requests.ConnectionError("reset"), _image_response()) as get:
        first = client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg")
        assert first.status_code == 503 and first.headers["Cache-Control"] == "private, no-store"
        assert client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg").status_code == 200
    assert get.call_count == 2


def test_artwork_is_drawn_again_once_it_is_old(client, artwork_cache):
    import os

    from shared import podcast_artwork

    with _publisher(_image_response(body=_jpeg(40, 40))):
        client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size=160")
    old = podcast_artwork.time.time() - podcast_artwork.FRESH_SEC - 60
    for path in artwork_cache.root.glob("*-podcast-v1.jpg"):
        os.utime(path, (old, old))
    with _publisher(_image_response(body=_jpeg(80, 80))) as get:
        resp = client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size=160")
    get.assert_called_once()
    assert _size(resp.data) == (80, 80)


def test_artwork_a_browser_already_has_is_not_sent_again(client, artwork_cache):
    with _publisher(_image_response()):
        first = client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size=160")
    again = client.get("/api/podcasts/artwork?url=https://cdn.example.com/a.jpg&size=160",
                       headers={"If-None-Match": first.headers["ETag"]})
    assert again.status_code == 304 and not again.data
