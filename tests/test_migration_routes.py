import hashlib
import json
import uuid
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from shared.api.routes.migration import migration_bp
from shared.api.routes.playback import playback_bp
from shared.database import DatabaseManager
from shared.hardening import SCOPE_LIBRARY_READ, SCOPE_LIBRARY_WRITE, SCOPE_PLAYBACK_CONTROL
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import init_telemetry, reset_telemetry


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _make_runtime(tmp_path) -> RuntimeConfig:
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    return runtime


def _sample_track(suffix: str) -> Track:
    return Track(
        id=f"id-{suffix}",
        title=f"Song {suffix}",
        artist="Artist Unit",
        album="Album Unit",
        duration=120,
        file_hash=f"hash-{suffix}",
        original_filename=f"{suffix}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def _agent_read(db: DatabaseManager) -> str:
    token = "agent-read"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="agent",
        scopes=[SCOPE_LIBRARY_READ],
        name="read",
        device_type="test",
    )
    return token


def _agent_write(db: DatabaseManager) -> str:
    token = "agent-write"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="agent",
        scopes=[SCOPE_LIBRARY_WRITE],
        name="write",
        device_type="test",
    )
    return token


def _agent_play(db: DatabaseManager) -> str:
    token = "agent-play"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="agent",
        scopes=[SCOPE_PLAYBACK_CONTROL],
        name="play",
        device_type="test",
    )
    return token


@pytest.fixture(autouse=True)
def _reset():
    reset_runtime()
    reset_telemetry()
    yield
    reset_telemetry()
    reset_runtime()


def test_migration_preview_requires_auth(tmp_path):
    _make_runtime(tmp_path)
    app = Flask(__name__)
    app.register_blueprint(migration_bp)
    client = app.test_client()
    res = client.post("/api/migration/preview", json={"format": "spotify_json", "text": "{}"})
    assert res.status_code == 403


def test_migration_preview_happy_path(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    app = Flask(__name__)
    app.register_blueprint(migration_bp)
    client = app.test_client()
    db = DatabaseManager()
    read_tok = _agent_read(db)

    a = _sample_track("a")
    meta = LibraryMetadata(version=1, tracks=[a], playlists={}, settings={})
    mock_lib = MagicMock()
    mock_lib.metadata = meta
    mock_lib.refresh_if_stale = MagicMock()

    export = {
        "tracks": {
            "items": [
                {
                    "track": {
                        "name": a.title,
                        "artists": [{"name": a.artist}],
                        "album": {"name": a.album},
                    }
                }
            ]
        }
    }

    with patch("shared.api.routes.migration._get_core_lib", return_value=mock_lib):
        res = client.post(
            "/api/migration/preview",
            json={"format": "spotify_json", "text": json.dumps(export)},
            headers={"Authorization": f"Bearer {read_tok}"},
        )
    assert res.status_code == 200
    body = res.get_json()
    assert body["stats"]["total"] == 1
    assert body["stats"]["matched"] == 1
    assert body["matches"][0]["matched_track_id"] == a.id


def test_migration_import_playlist_writes_metadata(tmp_path):
    _make_runtime(tmp_path)
    app = Flask(__name__)
    app.register_blueprint(migration_bp)
    client = app.test_client()
    db = DatabaseManager()
    write_tok = _agent_write(db)

    a = _sample_track("a")
    b = _sample_track("b")
    meta = LibraryMetadata(version=1, tracks=[a, b], playlists={}, settings={})
    mock_lib = MagicMock()
    mock_lib.metadata = meta
    mock_lib.refresh_if_stale = MagicMock()
    mock_lib._save_metadata = MagicMock()

    with patch("shared.api.routes.migration._get_core_lib", return_value=mock_lib):
        with patch("shared.api.socketio") as sio:
            res = client.post(
                "/api/migration/import-playlist",
                json={"playlist_name": "Imported", "track_ids": [a.id, b.id]},
                headers={"Authorization": f"Bearer {write_tok}"},
            )
    assert res.status_code == 200
    assert "Imported" in meta.playlists
    assert meta.playlists["Imported"] == [a.id, b.id]
    mock_lib._save_metadata.assert_called_once()
    sio.emit.assert_called_once()


def test_play_timing_endpoint_writes_jsonl(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_TELEMETRY_ENABLED", raising=False)
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)
    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()
    db = DatabaseManager()
    play_tok = _agent_play(db)

    res = client.post(
        "/api/playback/play-timing",
        json={
            "track_id": "tid",
            "device_id": "dev",
            "phase": "first_audio",
            "segments": {"user_click_to_audio_ms": 120},
        },
        headers={"Authorization": f"Bearer {play_tok}"},
    )
    assert res.status_code == 200
    log = (runtime.data_dir / "telemetry" / "play-timing.jsonl").read_text(encoding="utf-8").strip()
    row = json.loads(log.splitlines()[-1])
    assert row["event"] == "play_timing"
    assert row["segments"]["user_click_to_audio_ms"] == 120
