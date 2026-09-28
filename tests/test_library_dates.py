"""A song's library date is claimed once and then left alone.

The rule lives in `shared/library_dates.py`: a song's `added_at` is the moment
this account first took hold of it, and every other form the same song later
takes — a file for a saved song, an entry for a downloaded one — adopts that
date instead of minting a new one. These tests pin the rule itself and every
act a person can perform on a song that used to make its date move.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

from player.favourites_manager import FavouritesManager, library_key
from shared import library_dates
from shared.models import Track
from tests.conftest import TEST_USER_ID

SAVED_ON = "2026-07-02T10:00:00"
POOL_STAMP = "2026-09-28T11:00:00"


def _track(track_id: str, video_id: str | None = None, **overrides) -> Track:
    values = dict(
        id=track_id,
        title="I Follow Rivers",
        artist="Lykke Li",
        album="Wounded Rhymes",
        duration=284,
        file_hash=track_id,
        original_filename=f"{track_id}.m4a",
        compressed=False,
        file_size=1024,
        bitrate=320,
        format="m4a",
        youtube_id=video_id,
    )
    values.update(overrides)
    return Track(**values)


@pytest.fixture
def api(monkeypatch):
    import shared.api as api_mod

    monkeypatch.setattr(api_mod, "emit_to_user", lambda *a, **k: None)
    return api_mod


def _stored(api, track_id: str) -> Track:
    return api.get_user_core(TEST_USER_ID).library.metadata.get_track_by_id(track_id)


def _entry(manager, key: str) -> dict:
    return next(entry for entry in manager.get_entries() if key in entry["keys"])


# ── The rule's parts ──


def test_dates_are_compared_as_instants_not_as_text():
    """SQLite's own timestamps use a space where the engine writes a `T`; as text
    every one of them sorts before any engine date of the same day."""
    assert library_dates.earliest("2026-07-02T09:00:00", "2026-07-02 10:00:00") == "2026-07-02T09:00:00"
    assert library_dates.earliest("2026-07-02T10:00:00+02:00", "2026-07-02T09:00:00") == (
        "2026-07-02T10:00:00+02:00"
    )
    assert library_dates.earliest(None, "", "2026-07-02T10:00:00") == "2026-07-02T10:00:00"
    assert library_dates.earliest("not a date", "2026-07-02T10:00:00") == "2026-07-02T10:00:00"
    assert library_dates.earliest(None, "") is None


def test_track_keys_are_the_ones_the_player_matches_on():
    """Mirrors `trackKeys` in ui_web/src/lib/playbackIdentity.ts for an owned
    track — ISRCs normalised the same way, so an entry saved from a catalog row
    and the file it became meet on the same key."""
    track = _track("hash", "vid", isrc="us-um7-11-00001", musicbrainz_id="mbid")
    assert library_dates.track_keys(track) == ["lib:hash", "yt:vid", "isrc:USUM71100001", "mb:mbid"]

    episode = _track("ep", media_kind="podcast_episode", podcast_episode_guid="guid-1")
    assert library_dates.track_keys(episode) == ["pod:guid-1", "lib:ep"]


def test_a_held_song_answers_with_the_day_it_was_first_held():
    """Whatever is proposed. Holdings name a song the way the player does — by
    intersecting keys — and the oldest holding that names it decides."""
    holdings = library_dates.Holdings(
        tracks=[_track("old", "vid", added_at="2026-03-01T00:00:00")],
        entries=[{"keys": ["deezer:1", "yt:vid"], "added_at": SAVED_ON}],
    )

    assert holdings.claim(["yt:vid"], proposed="2020-01-01T00:00:00") == "2026-03-01T00:00:00"
    assert holdings.claim(["lib:other", "deezer:1"]) == SAVED_ON


def test_only_a_song_held_nowhere_is_dated_anew_and_a_batch_agrees_with_itself():
    holdings = library_dates.Holdings()

    first = holdings.claim(["isrc:X"], proposed="2025-01-01T00:00:00")
    again = holdings.claim(["isrc:X", "lib:copy"], proposed="2025-06-01T00:00:00")
    fresh = holdings.claim(["yt:new"])

    assert first == again == "2025-01-01T00:00:00"
    assert library_dates.parse(fresh) is not None


# ── Downloading ──


def test_the_pool_date_of_a_download_never_becomes_a_library_date(api):
    """The shared pool stamps a file when it lands there. That is a fact about
    the pool — another account may have put it there months ago — not about
    when this account took hold of the song."""
    pooled = _track("hash-pool", "vid-pool", added_at="2025-01-01T00:00:00")

    api.add_tracks_to_user_library([pooled])

    assert _stored(api, "hash-pool").added_at != "2025-01-01T00:00:00"


def test_a_whole_catalog_merge_keeps_the_catalog_dates(api):
    """The admin's cloud-sync merge is the one caller whose pool *is* the
    account's own catalog, and it says so."""
    pooled = _track("hash-sync", "vid-sync", added_at="2025-01-01T00:00:00")

    api.add_tracks_to_user_library([pooled], keep_source_dates=True)

    assert _stored(api, "hash-sync").added_at == "2025-01-01T00:00:00"


def test_downloading_a_saved_catalog_row_lands_as_that_saved_song(api):
    """A song saved from a Deezer row has no video id until the background
    resolve finds one, and may never get one. The download carries the entry's
    keys, so the file is dated from the save and the entry becomes the file."""
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.toggle_saved({"keys": ["cat:deezer:track:42", "deezer:42"], "title": "I Follow Rivers"},
                         added_at=SAVED_ON)
    downloaded = _track("hash-dz", "vid-dz", added_at=POOL_STAMP)

    api.add_tracks_to_user_library([downloaded], song_keys=["cat:deezer:track:42", "deezer:42"])

    assert _stored(api, "hash-dz").added_at == SAVED_ON
    entry = _entry(manager, "deezer:42")
    assert library_key("hash-dz") in entry["keys"] and "yt:vid-dz" in entry["keys"]
    assert entry["added_at"] == SAVED_ON
    assert len(manager.get_entries()) == 1


def test_a_download_through_the_queue_keeps_the_day_the_song_was_saved(isolated_runtime, monkeypatch):
    """The whole path, as it runs: the client asks to download a saved song and
    sends its identity, the pool stamps the new file, and the file joins the
    account's library as the song it already had."""
    import shared.api as api
    from shared.api.download_queue import DownloadQueueManager, parse_intake_item
    from shared.multiuser_migration import ensure_multiuser_layout
    from shared.user_context import user_context

    uid = ensure_multiuser_layout()["user_id"]
    with user_context(uid):
        api.get_favourites_manager(uid).toggle_saved(
            {"keys": ["deezer:42"], "title": "I Follow Rivers", "artist": "Lykke Li"}, added_at=SAVED_ON
        )

    audio = isolated_runtime.music_dir / "tracks/hash-q.m4a"
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b"test")
    downloaded = _track("hash-q", "abcdefghijk")

    def pool_add(track):
        # What `ODSTDownloader.commit_track` does to the object it is handed.
        track.added_at = POOL_STAMP

    fake = SimpleNamespace(
        library=SimpleNamespace(get_track_by_hash=lambda _: None, remove_track=lambda _: None),
        commit_track=pool_add,
        downloader=SimpleNamespace(process_video=lambda *a, **k: downloaded),
    )
    queue = DownloadQueueManager(isolated_runtime.config_dir / "dates.json")
    monkeypatch.setattr(api, "queue_manager_dl", queue)
    monkeypatch.setattr(api, "get_downloader", lambda *a, **k: fake)
    monkeypatch.setattr(api, "emit_to_user", lambda *a, **k: None)
    monkeypatch.setattr("shared.loudness.get_loudness_service", lambda: SimpleNamespace(measure_now=lambda _: None))
    monkeypatch.setattr("setup_tool.audio.AudioProcessor.extract_cover_art", lambda _: None)

    parsed, error = parse_intake_item({
        "source_type": "youtube_url",
        "video_id": "abcdefghijk",
        "display_title": "I Follow Rivers",
        "display_artist": "Lykke Li",
        "identity_keys": ["yt:abcdefghijk", "deezer:42"],
    })
    assert error is None
    item = queue.add(parsed, user_id=uid)
    api._process_single_queue_item(item)

    with user_context(uid):
        assert api.get_user_core(uid).library.metadata.get_track_by_id("hash-q").added_at == SAVED_ON
        assert library_key("hash-q") in _entry(api.get_favourites_manager(uid), "deezer:42")["keys"]


def test_intake_keeps_only_what_can_be_an_identity():
    from shared.api.download_queue import parse_intake_item

    parsed, _ = parse_intake_item({
        "source_type": "youtube_url",
        "video_id": "abcdefghijk",
        "identity_keys": ["yt:abcdefghijk", " deezer:1 ", "deezer:1", "", 5, "no-namespace", "x:" + "a" * 300],
    })
    assert parsed["identity_keys"] == ["yt:abcdefghijk", "deezer:1"]

    many, _ = parse_intake_item({
        "source_type": "youtube_url",
        "video_id": "abcdefghijk",
        "identity_keys": [f"cat:{n}" for n in range(40)],
    })
    assert len(many["identity_keys"]) == 16

    bare, _ = parse_intake_item({"source_type": "youtube_url", "video_id": "abcdefghijk"})
    assert "identity_keys" not in bare


# ── Marking ──


def test_hearting_a_downloaded_song_does_not_date_it_again(api):
    """The entry a heart creates for a file is the same song, held since the
    file arrived. If the file is later deleted, that entry is what the song
    falls back to — and it must not reappear at the top of the library."""
    api.add_tracks_to_user_library([_track("hash-h", "vid-h")], keep_source_dates=True)
    library_track = _stored(api, "hash-h")
    manager = api.get_favourites_manager(TEST_USER_ID)

    manager.set_favourite({"keys": ["lib:hash-h", "yt:vid-h"], "title": "I Follow Rivers"})

    entry = _entry(manager, "lib:hash-h")
    assert entry["added_at"] == library_track.added_at
    assert entry["favourited_at"]
    assert _stored(api, "hash-h").added_at == library_track.added_at


def test_the_legacy_library_id_heart_adopts_the_file_date_too(api):
    downloaded = _track("hash-l", "vid-l", added_at="2026-01-01T00:00:00")
    api.add_tracks_to_user_library([downloaded], keep_source_dates=True)
    manager = api.get_favourites_manager(TEST_USER_ID)

    manager.add("hash-l")

    assert _entry(manager, "lib:hash-l")["added_at"] == "2026-01-01T00:00:00"


def test_marking_and_unmarking_a_saved_song_leaves_its_date_alone(tmp_path, monkeypatch):
    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    manager = FavouritesManager()
    manager.toggle_saved({"keys": ["yt:vid"], "title": "Song"}, added_at=SAVED_ON)

    assert manager.set_favourite({"keys": ["yt:vid"]}) is True
    marked = _entry(manager, "yt:vid")
    assert marked["added_at"] == SAVED_ON and marked["favourited_at"]

    assert manager.set_favourite({"keys": ["yt:vid"]}) is False
    unmarked = _entry(manager, "yt:vid")
    assert unmarked["added_at"] == SAVED_ON and "favourited_at" not in unmarked


def test_a_client_cannot_date_a_new_entry(tmp_path, monkeypatch):
    """The engine is the clock. A payload's date is ignored; only an importer
    that knows when a song was acquired elsewhere may propose one."""
    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    manager = FavouritesManager()

    manager.toggle_saved({"keys": ["yt:a"], "added_at": "1999-01-01T00:00:00"})
    manager.set_favourite({"keys": ["yt:b"], "added_at": "1999-01-01T00:00:00",
                           "favourited_at": "1999-01-01T00:00:00"})

    for key in ("yt:a", "yt:b"):
        assert not _entry(manager, key)["added_at"].startswith("1999")
    assert not _entry(manager, "yt:b")["favourited_at"].startswith("1999")


# ── Everything else that touches a saved song ──


def test_learning_a_video_already_downloaded_dates_the_entry_from_the_file(api):
    """A Deezer row saved today that resolves to a video downloaded in spring is
    a song this account has held since spring."""
    api.add_tracks_to_user_library([_track("hash-s", "vid-s", added_at="2026-04-01T00:00:00")],
                                   keep_source_dates=True)
    manager = api.get_favourites_manager(TEST_USER_ID)
    manager.toggle_saved({"keys": ["deezer:7"], "title": "I Follow Rivers"})

    assert manager.update_keys(["deezer:7"], ["yt:vid-s"]) is True

    assert _entry(manager, "deezer:7")["added_at"] == "2026-04-01T00:00:00"


def test_a_reload_never_invents_a_date(tmp_path, monkeypatch):
    """An entry written before dates existed has no record of when it was
    saved. Stamping it with the moment the file was read would move it on every
    restart of the engine."""
    import json

    monkeypatch.setattr("player.favourites_manager.user_config_dir", lambda: tmp_path)
    (tmp_path / "favourites.json").write_text(json.dumps({
        "version": "3.0",
        "saved": [
            {"keys": ["yt:undated"], "title": "Old"},
            {"keys": ["yt:dated"], "title": "Kept", "added_at": SAVED_ON, "favourite": True,
             "favourited_at": "2026-08-01T00:00:00"},
        ],
    }))

    first = FavouritesManager()
    first.toggle_saved({"keys": ["yt:new"], "title": "New"})
    again = FavouritesManager()

    assert _entry(again, "yt:undated")["added_at"] is None
    assert _entry(again, "yt:dated")["added_at"] == SAVED_ON
    assert _entry(again, "yt:dated")["favourited_at"] == "2026-08-01T00:00:00"


def test_a_scanned_file_of_a_saved_song_keeps_the_save(tmp_path):
    """Pointing Soundsible at a folder that holds a song you saved last month
    gives that song a file; it does not move it to the file's mtime."""
    import os

    from setup_tool.scanner import ScanResult, ScannedFile
    from shared.api.library_scan import LibraryScanService
    from shared.database import DatabaseManager
    from shared.models import LibraryMetadata

    song = tmp_path / "rivers.m4a"
    song.write_bytes(b"bytes")
    os.utime(song, (1751450527, 1751450527))  # 2025-07-02
    scanned = _track("scanned", None, isrc="US-UM7-11-00001", is_local=True,
                     local_path=str(song.resolve()), local_mtime_ns=song.stat().st_mtime_ns)
    metadata = LibraryMetadata(1, [], {}, {})
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(metadata)
    core = SimpleNamespace(
        library=SimpleNamespace(db=db, metadata=metadata, _library_revision=1,
                                _export_metadata=lambda _payload: None),
        favourites=SimpleNamespace(
            remap_library_id=lambda old_id, new_id: None,
            get_entries=lambda: [{"keys": ["isrc:USUM71100001", "deezer:42"], "added_at": SAVED_ON}],
        ),
    )

    LibraryScanService._merge_result(
        core, ScanResult(discovered=1, processed=1, files=[ScannedFile(str(Path(song).resolve()), scanned)])
    )

    assert db.load_library_metadata().tracks[0].added_at == SAVED_ON
