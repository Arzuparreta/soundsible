"""The pieces the routes are built from, tested without a request."""

import json
from xml.etree import ElementTree as ET

import pytest

from shared.lyrics import parse_lrc
from shared.subsonic import serialize
from shared.subsonic.envelope import (
    ERR_NOT_FOUND,
    TEXT_KEY,
    SubsonicError,
    envelope,
    respond_xml,
)
from tests.subsonic_support import XML_NS, build, track


# ---------------------------------------------------------------------------
# Envelope
# ---------------------------------------------------------------------------


def test_envelope_reports_a_failure_without_a_result():
    body = envelope(error=SubsonicError(ERR_NOT_FOUND))
    assert body["status"] == "failed"
    assert body["error"]["code"] == ERR_NOT_FOUND
    assert "artists" not in body


def test_xml_writes_scalars_as_attributes_and_dicts_as_children():
    root = ET.fromstring(respond_xml(envelope({"album": {"name": "Debut", "year": 1993}})).data)
    album = root.find(f"{XML_NS}album")
    assert album.attrib == {"name": "Debut", "year": "1993"}


def test_xml_repeats_an_element_per_list_entry():
    payload = {"genres": {"genre": [{TEXT_KEY: "Rock"}, {TEXT_KEY: "Pop"}]}}
    root = ET.fromstring(respond_xml(envelope(payload)).data)
    assert [node.text for node in root.iter(f"{XML_NS}genre")] == ["Rock", "Pop"]


def test_xml_writes_a_list_of_scalars_as_repeated_text_elements():
    payload = {"ext": {"versions": [1, 2]}}
    root = ET.fromstring(respond_xml(envelope(payload)).data)
    assert [node.text for node in root.iter(f"{XML_NS}versions")] == ["1", "2"]


def test_booleans_are_lowercase_in_xml_and_real_in_json(tmp_path, monkeypatch):
    root = ET.fromstring(respond_xml(envelope({"license": {"valid": True}})).data)
    assert root.find(f"{XML_NS}license").attrib["valid"] == "true"

    harness = build(tmp_path, monkeypatch, [track("t1")])
    assert harness.ok("getLicense")["license"]["valid"] is True


def test_json_renames_the_text_key_to_value(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1", genre="Jazz")])
    body = harness.ok("getGenres")
    assert body["genres"]["genre"][0]["value"] == "Jazz"
    assert TEXT_KEY not in json.dumps(body)


# ---------------------------------------------------------------------------
# Ids
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("ar-abc", ("artist", "abc")),
        ("al-abc", ("album", "abc")),
        ("tr-abc", ("track", "abc")),
        ("abc", (None, "abc")),
    ],
)
def test_ids_say_what_they_name(value, expected):
    assert serialize.parse_id(value) == expected


def test_prefixes_round_trip():
    assert serialize.parse_id(serialize.album_id("x")) == ("album", "x")
    assert serialize.parse_id(serialize.artist_id("x")) == ("artist", "x")
    assert serialize.parse_id(serialize.track_id("x")) == ("track", "x")


def test_a_recording_mbid_is_exposed_to_opensubsonic_clients():
    recording_mbid = "b1a9c0e9-d987-4042-ae91-78d6a3267d69"
    entry = track("t1")
    entry.musicbrainz_id = recording_mbid

    assert serialize.song(entry)["musicBrainzId"] == recording_mbid


# ---------------------------------------------------------------------------
# Names and paths
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,letter",
    [("The Beatles", "B"), ("Björk", "B"), ("los Planetas", "P"), ("4 Non Blondes", "#"), ("", "#")],
)
def test_index_letter_ignores_articles(name, letter):
    assert serialize.index_letter(name) == letter


def test_a_slash_in_a_title_cannot_escape_the_synthetic_path():
    entry = track("t1", title="AC/DC Tribute", album="Live/Dead", artist="Someone")
    path = serialize.synthetic_path(entry, "Someone")
    assert path.count("/") == 2
    assert "AC_DC" in path


def test_a_track_without_a_number_still_gets_a_name():
    entry = track("t1", title="Untitled", track_number=None)
    assert serialize.synthetic_path(entry, "Artist").endswith("Untitled.mp3")


# ---------------------------------------------------------------------------
# ReplayGain
# ---------------------------------------------------------------------------


def test_replay_gain_is_the_distance_from_the_reference():
    gain = serialize.replay_gain((-23.0, -1.0))
    assert gain["trackGain"] == pytest.approx(5.0)
    assert gain["trackPeak"] == pytest.approx(0.891251, abs=1e-5)


def test_no_measurement_means_no_field():
    assert serialize.replay_gain(None) is None


def test_a_measured_track_carries_replay_gain_to_the_client(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    monkeypatch.setattr(
        "shared.api.routes.subsonic._measurements", lambda: {"hash-t1": (-14.0, -0.5)}
    )
    song = harness.ok("getSong", id="tr-t1")["song"]
    assert song["replayGain"]["trackGain"] == pytest.approx(-4.0)


def test_unreadable_measurements_do_not_break_a_listing(tmp_path, monkeypatch):
    """Levelling is an enhancement; it must never cost somebody their library."""
    harness = build(tmp_path, monkeypatch, [track("t1")])

    def explode():
        raise RuntimeError("no store")

    monkeypatch.setattr("shared.loudness.LoudnessStore", explode)
    assert harness.ok("getSong", id="tr-t1")["song"]["id"] == "tr-t1"


# ---------------------------------------------------------------------------
# Lyrics
# ---------------------------------------------------------------------------


def test_lrc_parses_stamps_into_milliseconds():
    assert parse_lrc("[00:12.50]Hello\n[01:02.05]World") == [
        (12500, "Hello"),
        (62050, "World"),
    ]


def test_a_line_with_several_stamps_becomes_several_lines():
    assert parse_lrc("[00:01.00][00:31.00]Chorus") == [(1000, "Chorus"), (31000, "Chorus")]


def test_lines_without_a_stamp_are_skipped():
    assert parse_lrc("[ar:Someone]\n[00:01.00]Only this") == [(1000, "Only this")]


def test_millisecond_precision_is_kept():
    assert parse_lrc("[00:00.123]x") == [(123, "x")]


def test_structured_lyrics_come_back_timed(tmp_path, monkeypatch):
    from shared.database import instance_db

    harness = build(tmp_path, monkeypatch, [track("t1", title="Song")])
    instance_db().set_lyrics(
        "t1", synced="[00:01.00]First\n[00:05.00]Second", plain="First\nSecond", instrumental=False, source="test"
    )
    structured = harness.ok("getLyricsBySongId", id="tr-t1")["lyricsList"]["structuredLyrics"][0]
    assert structured["synced"] is True
    assert [line["start"] for line in structured["line"]] == [1000, 5000]


def test_plain_lyrics_come_back_untimed(tmp_path, monkeypatch):
    from shared.database import instance_db

    harness = build(tmp_path, monkeypatch, [track("t1")])
    instance_db().set_lyrics("t1", synced=None, plain="Just words", instrumental=False, source="test")
    structured = harness.ok("getLyricsBySongId", id="tr-t1")["lyricsList"]["structuredLyrics"][0]
    assert structured["synced"] is False
    assert structured["line"][0]["value"] == "Just words"


def test_no_lyrics_is_an_empty_list_not_an_error(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    assert harness.ok("getLyricsBySongId", id="tr-t1")["lyricsList"] == {}
