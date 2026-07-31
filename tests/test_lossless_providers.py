from __future__ import annotations

from dataclasses import dataclass

from shared.lossless.providers import (
    InternetArchiveProvider,
    JamendoProvider,
    USER_AGENT,
    WikimediaProvider,
    allowed_download_url,
)
from shared.models import Track


def _track() -> Track:
    return Track(
        id="track-1",
        title="Song",
        artist="Artist",
        album="Album",
        duration=180,
        file_hash="hash",
        original_filename="song.m4a",
        compressed=True,
        file_size=1,
        bitrate=128,
        format="m4a",
        youtube_id="dQw4w9WgXcQ",
    )


@dataclass
class FakeResponse:
    body: dict
    url: str = "https://example.invalid"
    headers: dict | None = None

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def test_jamendo_returns_only_downloadable_free_flac_candidates():
    session = FakeSession(
        FakeResponse(
            {
                "results": [
                    {
                        "id": "42",
                        "name": "Song",
                        "artist_name": "Artist",
                        "album_name": "Album",
                        "duration": 180,
                        "audiodownload_allowed": True,
                        "audiodownload": "https://prod-1.storage.jamendo.com/download/42/flac/",
                        "shareurl": "https://www.jamendo.com/track/42",
                        "license_ccurl": "https://creativecommons.org/licenses/by/4.0/",
                    },
                    {
                        "id": "43",
                        "audiodownload_allowed": False,
                        "audiodownload": "https://prod-1.storage.jamendo.com/download/43/flac/",
                    },
                ]
            }
        )
    )
    rows = JamendoProvider(client_id="public-app-id", session=session).search(_track())
    assert [row.source_id for row in rows] == ["42"]
    assert rows[0].format == "flac"
    _, kwargs = session.calls[0]
    assert kwargs["params"]["audiodlformat"] == "flac"
    assert "Cookie" not in kwargs["headers"]
    assert "Referer" not in kwargs["headers"]
    assert "github.com/Arzuparreta/soundsible" in kwargs["headers"]["User-Agent"]
    assert kwargs["headers"]["User-Agent"] == USER_AGENT


def test_provider_queries_use_canonical_youtube_metadata():
    session = FakeSession(FakeResponse({"results": []}))
    noisy = _track()
    noisy.artist = "Abel York"
    noisy.title = "Abel York - Where Are You | Official Music Video"

    JamendoProvider(client_id="public-app-id", session=session).search(noisy)

    _, kwargs = session.calls[0]
    assert kwargs["params"]["search"] == "Abel York Where Are You"


def test_jamendo_client_id_validation_uses_a_bounded_read_request():
    session = FakeSession(
        FakeResponse({"headers": {"status": "success", "code": 0}, "results": []})
    )

    assert JamendoProvider(client_id="private-app-id", session=session).validate()
    _, kwargs = session.calls[0]
    assert kwargs["params"]["client_id"] == "private-app-id"
    assert kwargs["params"]["limit"] == 1


def test_wikimedia_requires_original_lossless_file_and_free_license():
    session = FakeSession(
        FakeResponse(
            {
                "query": {
                    "pages": [
                        {
                            "pageid": 9,
                            "title": "File:Song.flac",
                            "imageinfo": [
                                {
                                    "mime": "audio/flac",
                                    "size": 1234,
                                    "url": "https://upload.wikimedia.org/song.flac",
                                    "descriptionurl": "https://commons.wikimedia.org/wiki/File:Song.flac",
                                    "extmetadata": {
                                        "ObjectName": {"value": "Song"},
                                        "Artist": {"value": "Artist"},
                                        "LicenseUrl": {
                                            "value": "https://creativecommons.org/licenses/by-sa/4.0/"
                                        },
                                        "Duration": {"value": "180"},
                                    },
                                }
                            ],
                        }
                    ]
                }
            }
        )
    )
    rows = WikimediaProvider(session=session).search(_track())
    assert len(rows) == 1
    assert rows[0].original is True
    assert rows[0].duration == 180


def test_internet_archive_accepts_only_original_lossless_files():
    session = FakeSession(
        FakeResponse(
            {
                "response": {
                    "docs": [
                        {
                            "identifier": "release",
                            "title": "Song",
                            "creator": "Artist",
                            "licenseurl": "https://creativecommons.org/licenses/by/4.0/",
                        }
                    ]
                }
            }
        ),
        FakeResponse(
            {
                "metadata": {
                    "title": "Album",
                    "creator": "Artist",
                    "licenseurl": "https://creativecommons.org/licenses/by/4.0/",
                },
                "files": [
                    {
                        "name": "song.flac",
                        "format": "Flac",
                        "source": "original",
                        "title": "Song",
                        "artist": "Artist",
                        "length": "3:00",
                        "size": "999",
                    },
                    {
                        "name": "derived.flac",
                        "format": "Flac",
                        "source": "derivative",
                    },
                ],
            }
        ),
    )
    rows = InternetArchiveProvider(session=session).search(_track())
    assert [row.source_id for row in rows] == ["release/song.flac"]
    assert rows[0].expected_size == 999


def test_provider_download_hosts_are_strictly_allowlisted():
    assert allowed_download_url("wikimedia", "https://upload.wikimedia.org/a.flac")
    assert allowed_download_url("internet_archive", "https://ia800.us.archive.org/a.flac")
    assert not allowed_download_url("wikimedia", "https://wikimedia.org.evil.example/a.flac")
    assert not allowed_download_url("jamendo", "http://prod.storage.jamendo.com/a.flac")
