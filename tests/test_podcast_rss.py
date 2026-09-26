from shared.podcast_rss import parse_feed, parse_feed_episodes, parse_feed_image

import feedparser


def _feed(channel_extra: str = "", items: str = "") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>My Show</title>
    {channel_extra}
    {items}
  </channel>
</rss>
""".encode()


def _item(guid: str, extra: str = "") -> str:
    return f"""
    <item>
      <title>Episode {guid}</title>
      <guid>{guid}</guid>
      <enclosure url="https://cdn.example.com/{guid}.mp3" type="audio/mpeg" length="1" />
      {extra}
    </item>
    """


SHOW_ART = '<itunes:image href="https://cdn.example.com/show.jpg" />'


def test_episode_without_art_inherits_the_show_cover():
    episodes = parse_feed_episodes(_feed(SHOW_ART, _item("ep1")), "https://example.com/rss")
    assert [e["image"] for e in episodes] == ["https://cdn.example.com/show.jpg"]


def test_episode_art_wins_over_the_show_cover():
    xml = _feed(SHOW_ART, _item("ep1", '<itunes:image href="https://cdn.example.com/ep1.jpg" />'))
    episodes = parse_feed_episodes(xml, "https://example.com/rss")
    assert [e["image"] for e in episodes] == ["https://cdn.example.com/ep1.jpg"]


def test_media_thumbnail_counts_as_episode_art():
    xml = _feed(SHOW_ART, _item("ep1", '<media:thumbnail url="https://cdn.example.com/thumb.jpg" />'))
    episodes = parse_feed_episodes(xml, "https://example.com/rss")
    assert [e["image"] for e in episodes] == ["https://cdn.example.com/thumb.jpg"]


def test_relative_artwork_resolves_against_the_feed_url():
    xml = _feed('<itunes:image href="/art/show.png" />', _item("ep1"))
    episodes = parse_feed_episodes(xml, "https://example.com/feeds/rss.xml")
    assert [e["image"] for e in episodes] == ["https://example.com/art/show.png"]


def test_unsafe_artwork_is_dropped_rather_than_handed_to_the_downloader():
    # The Station fetches this URL when the episode is downloaded, so a feed
    # cannot use its artwork to point the engine at the loopback interface.
    xml = _feed(
        '<itunes:image href="http://127.0.0.1:8080/admin.png" />',
        _item("ep1", '<itunes:image href="javascript:alert(1)" />'),
    )
    episodes = parse_feed_episodes(xml, "https://example.com/rss")
    assert [e["image"] for e in episodes] == [""]


def test_show_cover_reads_itunes_and_plain_rss_images():
    itunes_only = feedparser.parse(_feed(SHOW_ART)).feed
    assert parse_feed_image(itunes_only) == "https://cdn.example.com/show.jpg"

    rss_only = feedparser.parse(
        _feed("<image><url>https://cdn.example.com/rss.jpg</url><title>My Show</title>"
              "<link>https://example.com</link></image>")
    ).feed
    assert parse_feed_image(rss_only) == "https://cdn.example.com/rss.jpg"

    assert parse_feed_image(feedparser.parse(_feed()).feed) == ""
    assert parse_feed_image(None) == ""


def test_one_parse_yields_the_show_and_its_episodes():
    xml = _feed(SHOW_ART + "<itunes:author>Host Name</itunes:author>", _item("ep1") + _item("ep2"))
    show, episodes = parse_feed(xml, "https://example.com/rss")
    assert show == {"title": "My Show", "author": "Host Name", "image_url": "https://cdn.example.com/show.jpg"}
    assert [e["guid"] for e in episodes] == ["ep1", "ep2"]
    assert episodes == parse_feed_episodes(xml, "https://example.com/rss")


def test_show_without_an_author_is_credited_to_its_subtitle():
    # The same fallback a subscription records, so a show opened from the
    # directory reads the same before and after it is followed.
    show, _ = parse_feed(_feed("<itunes:subtitle>A weekly show</itunes:subtitle>"), "https://example.com/rss")
    assert show["author"] == "A weekly show"
    show, _ = parse_feed(_feed(), "https://example.com/rss")
    assert show == {"title": "My Show", "author": "", "image_url": ""}
