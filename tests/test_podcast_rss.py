import feedparser
import pytest

from shared import podcast_rss
from shared.podcast_rss import fetch_feed_body, parse_feed, parse_feed_episodes, parse_feed_image


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


class _Stream:
    """A response that hands its body over a few bytes at a time and counts
    what was taken, so a test can see the read stop."""

    def __init__(self, body: bytes, chunk: int = 64):
        self.chunks = [body[i:i + chunk] for i in range(0, len(body), chunk)]
        self.taken = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size):
        for chunk in self.chunks:
            self.taken += 1
            yield chunk


def _serve(monkeypatch, body: bytes, limit: int) -> _Stream:
    stream = _Stream(body)
    monkeypatch.setattr(podcast_rss, "_MAX_FEED_BYTES", limit)
    monkeypatch.setattr(podcast_rss.requests, "get", lambda *args, **kwargs: stream)
    return stream


def test_a_feed_within_the_limit_is_read_whole(monkeypatch):
    xml = _feed(SHOW_ART, _item("ep1") + _item("ep2"))
    _serve(monkeypatch, xml, limit=len(xml))
    assert fetch_feed_body("https://example.com/rss") == (xml, False)


def test_a_feed_past_the_limit_keeps_the_episodes_that_arrived_whole(monkeypatch):
    # #250: a decade-old show's feed ran past the limit and the show opened
    # with no episodes at all.
    xml = _feed(SHOW_ART, "".join(_item(f"ep{n}") for n in range(1, 6)))
    stream = _serve(monkeypatch, xml, limit=xml.index(b"<guid>ep3</guid>"))

    body = fetch_feed_body("https://example.com/rss")

    assert body.partial
    # Closed into a whole document, so feedparser reads it once, strictly.
    assert not feedparser.parse(body.xml).bozo
    show, episodes = parse_feed(body.xml, "https://example.com/rss")
    assert show == {"title": "My Show", "author": "", "image_url": "https://cdn.example.com/show.jpg"}
    assert episodes == parse_feed_episodes(xml, "https://example.com/rss")[:2]
    # The rest of the feed is left on the server.
    assert stream.taken < len(stream.chunks)
    assert stream.closed


def test_a_feed_whose_first_episode_does_not_fit_is_refused(monkeypatch):
    xml = _feed(SHOW_ART, _item("ep1") + _item("ep2"))
    _serve(monkeypatch, xml, limit=xml.index(b"</item>"))
    with pytest.raises(ValueError, match="Feed too large"):
        fetch_feed_body("https://example.com/rss")


def test_markup_quoted_in_show_notes_is_not_where_an_episode_ends(monkeypatch):
    notes = "<description><![CDATA[<p>Mailbag</p></item><item>]]></description>"
    xml = _feed(SHOW_ART, _item("ep1", notes) + _item("ep2", notes))
    # The limit falls just past the `</item>` quoted in the second episode.
    _serve(monkeypatch, xml, limit=xml.rindex(b"<item>]]>"))

    body = fetch_feed_body("https://example.com/rss")

    first_episode_ends = xml.index(b"</item>", xml.index(b"]]>")) + len(b"</item>")
    assert body.xml == xml[:first_episode_ends] + b"</channel></rss>"
    parsed = feedparser.parse(body.xml)
    assert not parsed.bozo
    assert [e.id for e in parsed.entries] == ["ep1"]


def test_an_rss_feed_is_cut_by_its_items_whatever_else_it_names_entry(monkeypatch):
    xml = _feed("<entry>Not an episode</entry>", "".join(_item(f"ep{n}") for n in range(1, 4)))
    _serve(monkeypatch, xml, limit=xml.index(b"<guid>ep3</guid>"))

    body = fetch_feed_body("https://example.com/rss")

    assert [e["guid"] for e in parse_feed_episodes(body.xml, "https://example.com/rss")] == ["ep1", "ep2"]


ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>My Show</title>
  <entry><title>Episode 1</title><id>ep1</id>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example.com/ep1.mp3"/></entry>
  <entry><title>Episode 2</title><id>ep2</id>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example.com/ep2.mp3"/></entry>
  <entry><title>Episode 3</title><id>ep3</id>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example.com/ep3.mp3"/></entry>
</feed>
"""

# RSS 1.0 keeps its episodes beside the channel rather than inside it.
RDF = b"""<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://example.com/"><title>My Show</title></channel>
  <item rdf:about="https://example.com/ep1"><title>Episode 1</title><link>https://example.com/ep1</link></item>
  <item rdf:about="https://example.com/ep2"><title>Episode 2</title><link>https://example.com/ep2</link></item>
  <item rdf:about="https://example.com/ep3"><title>Episode 3</title><link>https://example.com/ep3</link></item>
</rdf:RDF>
"""


@pytest.mark.parametrize("xml", [ATOM, RDF], ids=["atom", "rss1"])
def test_every_feed_format_is_closed_around_its_episodes(monkeypatch, xml):
    _serve(monkeypatch, xml, limit=xml.index(b"Episode 3"))

    body = fetch_feed_body("https://example.com/rss")

    parsed = feedparser.parse(body.xml)
    assert body.partial and not parsed.bozo
    assert parsed.feed.title == "My Show"
    assert [e.title for e in parsed.entries] == ["Episode 1", "Episode 2"]
