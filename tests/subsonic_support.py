"""Shared scaffolding for the ``/rest`` tests.

Every Subsonic test needs the same three things: an account with a credential,
a library backed by a real SQLite catalog, and a Flask app carrying only the
blueprint under test. Building that once here keeps the test files about the
protocol rather than about wiring.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional
from xml.etree import ElementTree as ET

from flask import Flask

from shared.api.routes.subsonic import subsonic_bp
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.subsonic import credentials
from shared.users import create_user

XML_NS = "{http://subsonic.org/restapi}"


def track(
    track_id: str,
    *,
    title: str = "Song",
    artist: str = "Artist",
    artists: Optional[list[str]] = None,
    album: str = "Album",
    album_artist: Optional[str] = None,
    genre: Optional[str] = "Rock",
    year: Optional[int] = 2020,
    track_number: Optional[int] = 1,
    disc_number: Optional[int] = None,
    duration: int = 180,
    bitrate: int = 320,
    fmt: str = "mp3",
    media_kind: Optional[str] = None,
    is_compilation: bool = False,
) -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        artists=artists,
        album=album,
        album_artist=album_artist,
        duration=duration,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.{fmt}",
        compressed=False,
        file_size=4096,
        bitrate=bitrate,
        format=fmt,
        year=year,
        genre=genre,
        track_number=track_number,
        disc_number=disc_number,
        is_compilation=is_compilation,
        media_kind=media_kind,
    )


class FakeLibrary:
    """Just enough library for the routes: a manifest, an index, and saving."""

    def __init__(self, metadata: LibraryMetadata, db: DatabaseManager):
        self.metadata = metadata
        self.db = db
        self.saves = 0

    def refresh_if_stale(self) -> None:
        return None

    def sync_library(self) -> bool:
        self.db.sync_from_metadata(self.metadata)
        return True

    def get_cover_url(self, _track) -> Optional[str]:
        return None

    def _save_metadata(self) -> bool:
        self.saves += 1
        self.db.sync_from_metadata(self.metadata)
        return True


class Harness:
    def __init__(self, client, library: FakeLibrary, user: dict[str, Any], secret: str):
        self.client = client
        self.library = library
        self.user = user
        self.secret = secret

    @property
    def db(self) -> DatabaseManager:
        return self.library.db

    def favourites(self):
        """This account's favourites, read the way the player reads them.

        Bound explicitly: outside a request the context holds the conftest
        user, and asking there would answer about somebody else's library.
        """
        from player.favourites_manager import FavouritesManager
        from shared.user_context import user_context

        with user_context(self.user["id"]):
            return FavouritesManager()

    def auth(self, **overrides: Any) -> dict[str, Any]:
        params = {"u": self.user["username"], "p": self.secret, "v": "1.16.1", "c": "pytest"}
        params.update(overrides)
        return params

    def get(self, method: str, **params: Any):
        """Call one Subsonic method with credentials, asking for JSON."""
        query = self.auth(f="json")
        query.update({key: value for key, value in params.items() if value is not None})
        return self.client.get(f"/rest/{method}", query_string=query)

    def json(self, method: str, **params: Any) -> dict[str, Any]:
        response = self.get(method, **params)
        assert response.status_code == 200, response.data
        return json.loads(response.data)["subsonic-response"]

    def ok(self, method: str, **params: Any) -> dict[str, Any]:
        body = self.json(method, **params)
        assert body["status"] == "ok", body
        return body

    def xml(self, method: str, **params: Any) -> ET.Element:
        query = self.auth()
        query.update({key: value for key, value in params.items() if value is not None})
        response = self.client.get(f"/rest/{method}", query_string=query)
        assert response.status_code == 200, response.data
        return ET.fromstring(response.data)


def build(
    tmp_path: Path,
    monkeypatch,
    tracks: list[Track],
    *,
    playlists: Optional[dict[str, list[str]]] = None,
    username: str = "listener",
    with_credential: bool = True,
) -> Harness:
    """An app, an account and a library holding ``tracks``."""
    from shared.hardening import _reset_rate_limits_for_tests

    credentials.reset_key_cache()
    _reset_rate_limits_for_tests()
    user = create_user(username, password="account-password")

    metadata = LibraryMetadata(version=1, tracks=list(tracks), playlists=dict(playlists or {}), settings={})
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.sync_from_metadata(metadata)
    library = FakeLibrary(metadata, db)

    from player.favourites_manager import FavouritesManager

    monkeypatch.setattr("shared.api.get_core", lambda: (library, None, None), raising=False)
    monkeypatch.setattr("shared.api.get_favourites_manager", lambda *a, **k: FavouritesManager(), raising=False)
    monkeypatch.setattr("shared.api.emit_to_user", lambda *a, **k: None, raising=False)
    monkeypatch.setattr("shared.api.is_trusted_network", lambda *a, **k: True, raising=False)

    app = Flask(__name__)
    app.register_blueprint(subsonic_bp)
    secret = credentials.create_credential(user["id"]) if with_credential else ""
    return Harness(app.test_client(), library, user, secret)
