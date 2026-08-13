import json
import wave
from pathlib import Path
from types import SimpleNamespace

from setup_tool.scanner import LibraryScanner, ScanResult, ScannedFile
from shared.api.library_scan import LibraryScanService
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.path_resolver import path_within_roots, register_scan_roots, resolve_local_track_path

RECORDING_MBID = "b1a9c0e9-d987-4042-ae91-78d6a3267d69"


def _track(track_id: str, path: Path, *, mtime: int = 1, size: int = 10) -> Track:
    return Track(
        id=track_id,
        title=f"Song {track_id}",
        artist="Artist",
        album="Album",
        duration=120,
        file_hash=track_id,
        original_filename=path.name,
        compressed=False,
        file_size=size,
        bitrate=320,
        format=path.suffix.lstrip(".") or "mp3",
        is_local=True,
        local_path=str(path.resolve()),
        local_mtime_ns=mtime,
    )


def test_scan_is_incremental_and_skips_symlinks(tmp_path, monkeypatch):
    root = tmp_path / "music"
    root.mkdir()
    song = root / "song.mp3"
    song.write_bytes(b"audio")
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"outside")
    (root / "escape.mp3").symlink_to(outside)
    stat = song.stat()
    existing = _track("same", song, mtime=stat.st_mtime_ns, size=stat.st_size)

    monkeypatch.setattr("setup_tool.scanner.AudioProcessor.is_supported_format", lambda p: p.endswith(".mp3"))
    monkeypatch.setattr(
        "setup_tool.scanner.AudioProcessor.calculate_hash",
        lambda _p: (_ for _ in ()).throw(AssertionError("unchanged file was hashed")),
    )

    result = LibraryScanner().scan_paths([root], [existing])

    assert result.discovered == result.processed == 1
    assert result.files[0].unchanged is True
    assert result.errors == []


def test_local_scan_fields_round_trip_only_through_sqlite(tmp_path):
    song = tmp_path / "song.flac"
    song.write_bytes(b"audio")
    track = _track("hash", song, mtime=song.stat().st_mtime_ns, size=song.stat().st_size)
    metadata = LibraryMetadata(1, [track], {}, {})
    db = DatabaseManager(str(tmp_path / "library.db"))

    db.replace_library(metadata)
    restored = db.load_library_metadata().tracks[0]
    portable = json.loads(metadata.to_json())["tracks"][0]

    assert restored.local_path == str(song.resolve())
    assert restored.local_mtime_ns == song.stat().st_mtime_ns
    assert "local_path" not in portable
    assert "local_mtime_ns" not in portable


def test_scan_preserves_an_embedded_recording_mbid(tmp_path, monkeypatch):
    song = tmp_path / "song.flac"
    song.write_bytes(b"audio")
    monkeypatch.setattr("setup_tool.scanner.AudioProcessor.calculate_hash", lambda _path: "hash")
    monkeypatch.setattr(
        "setup_tool.scanner.AudioProcessor.extract_metadata",
        lambda _path: {
            "title": "A Song",
            "artist": "An Artist",
            "album": "An Album",
            "duration": 180,
            "bitrate": 900,
            "format": "flac",
            "musicbrainz_id": RECORDING_MBID,
        },
    )

    track = LibraryScanner._process_file(song, song.stat().st_size, song.stat().st_mtime_ns)
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(LibraryMetadata(1, [track], {}, {}))

    assert track.musicbrainz_id == RECORDING_MBID
    assert db.load_library_metadata().tracks[0].musicbrainz_id == RECORDING_MBID
    assert json.loads(LibraryMetadata(1, [track], {}, {}).to_json())["tracks"][0][
        "musicbrainz_id"
    ] == RECORDING_MBID


def test_changed_file_rekeys_references_and_user_state(tmp_path):
    song = tmp_path / "song.mp3"
    song.write_bytes(b"new bytes")
    old = _track("old", song, mtime=1, size=3)
    new = _track("new", song, mtime=song.stat().st_mtime_ns, size=song.stat().st_size)
    metadata = LibraryMetadata(
        1,
        [old],
        {"Mix": ["old"]},
        {"playlist_covers": {"Mix": "old"}},
    )
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(metadata)
    db.set_track_rating("old", 5)
    remapped = []
    core = SimpleNamespace(
        library=SimpleNamespace(
            db=db,
            metadata=metadata,
            _library_revision=1,
            _export_metadata=lambda _payload: None,
        ),
        favourites=SimpleNamespace(remap_library_id=lambda old_id, new_id: remapped.append((old_id, new_id))),
    )

    summary = LibraryScanService._merge_result(
        core,
        ScanResult(discovered=1, processed=1, files=[ScannedFile(str(song.resolve()), new)]),
    )
    restored = db.load_library_metadata()

    assert summary == {"added": 0, "updated": 1, "unchanged": 0}
    assert [track.id for track in restored.tracks] == ["new"]
    assert restored.playlists == {"Mix": ["new"]}
    assert restored.settings["playlist_covers"] == {"Mix": "new"}
    assert db.get_track_user_state("new")["rating"] == 5
    assert remapped == [("old", "new")]


def test_scanned_path_must_stay_inside_registered_root(tmp_path, monkeypatch):
    root = tmp_path / "music"
    root.mkdir()
    song = root / "song.mp3"
    song.write_bytes(b"audio")
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"outside")
    register_scan_roots([root])
    monkeypatch.setattr("shared.app_config.get_output_dir", lambda: tmp_path / "managed")

    assert path_within_roots(song, [root]) is True
    assert resolve_local_track_path(_track("scan", song)) == str(song.resolve())
    assert path_within_roots(outside, [root]) is False
    assert resolve_local_track_path(_track("outside", outside)) is None


def test_scan_http_contract_starts_and_polls_same_user(tmp_path, monkeypatch):
    from flask import Flask
    from shared.api.library_scan import library_scan_service
    from shared.api.routes import library as routes

    music = tmp_path / "music"
    music.mkdir()
    fake_library = SimpleNamespace(config=SimpleNamespace(watch_folders=[str(music)]))
    monkeypatch.setattr(routes, "_get_api", lambda: {"get_core": lambda: (fake_library, None, None)})
    monkeypatch.setattr(library_scan_service, "resolve_roots", lambda _lib, _path=None: [music])
    monkeypatch.setattr(
        library_scan_service,
        "start",
        lambda user_id, _roots: {**LibraryScanService().status(user_id), "scan_id": "scan", "state": "queued"},
    )
    monkeypatch.setattr(
        library_scan_service,
        "status",
        lambda user_id: {**LibraryScanService().status(user_id), "scan_id": "scan", "state": "scanning"},
    )
    app = Flask(__name__)

    with app.test_request_context(
        "/api/library/scan", method="POST", json={}, environ_base={"REMOTE_ADDR": "127.0.0.1"}
    ):
        response, code = routes.start_library_scan()
        assert code == 202
        assert response.get_json()["state"] == "queued"
    with app.test_request_context(
        "/api/library/scan", method="GET", environ_base={"REMOTE_ADDR": "127.0.0.1"}
    ):
        response = routes.library_scan_status()
        assert response.get_json()["state"] == "scanning"


def test_start_is_idempotent_while_a_user_scan_is_active(tmp_path, monkeypatch):
    submitted = []
    monkeypatch.setattr(
        "shared.api.library_scan.orchestrator.submit_background",
        lambda *args: submitted.append(args),
    )
    service = LibraryScanService()

    first = service.start("listener", [tmp_path])
    second = service.start("listener", [tmp_path])

    assert first["scan_id"] == second["scan_id"]
    assert first["state"] == second["state"] == "queued"
    assert len(submitted) == 1


def test_requested_scan_folder_is_limited_to_configured_roots(tmp_path):
    root = tmp_path / "music"
    child = root / "album"
    child.mkdir(parents=True)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    library = SimpleNamespace(config=SimpleNamespace(watch_folders=[str(root)]))
    service = LibraryScanService()

    assert service.resolve_roots(library, str(child)) == [child.resolve()]
    try:
        service.resolve_roots(library, str(outside))
    except ValueError as exc:
        assert "outside" in str(exc)
    else:
        raise AssertionError("outside folder was accepted")


def test_real_wav_scan_survives_sqlite_reload_and_streams_a_range(tmp_path, monkeypatch):
    from flask import Flask
    from shared.api.routes import playback

    root = tmp_path / "music"
    root.mkdir()
    song = root / "tone.wav"
    with wave.open(str(song), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * 8000)

    result = LibraryScanner().scan_paths([root], [])
    assert result.discovered == 1
    assert result.errors == []
    db = DatabaseManager(str(tmp_path / "library.db"))
    db.replace_library(LibraryMetadata(1, [result.files[0].track], {}, {}))
    restored = db.load_library_metadata()
    register_scan_roots([root])
    library = SimpleNamespace(metadata=restored)
    monkeypatch.setattr(
        playback,
        "_get_api",
        lambda: {
            "get_core": lambda: (library, None, None),
            "get_track_by_id": lambda lib, track_id: next(
                (track for track in lib.metadata.tracks if track.id == track_id), None
            ),
            "is_trusted_network": lambda _addr: True,
            "is_safe_path": lambda _path, is_trusted=False: is_trusted,
        },
    )
    app = Flask(__name__)
    app.register_blueprint(playback.playback_bp)

    response = app.test_client().get(
        f"/api/static/stream/{restored.tracks[0].id}", headers={"Range": "bytes=0-99"}
    )

    assert response.status_code == 206
    assert len(response.data) == 100
    assert response.headers["Cache-Control"] == "private, no-cache"
