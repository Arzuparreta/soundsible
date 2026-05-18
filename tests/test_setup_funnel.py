import hashlib
import importlib.util
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

from flask import Flask

import pytest

from shared.api.routes.playback import playback_bp
from shared.api.routes.setup import setup_bp
from shared.database import DatabaseManager
from shared.hardening import ALL_SCOPES, SCOPE_PLAYBACK_CONTROL
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.setup_session import reset_sessions_for_tests
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


def _owner_token(db: DatabaseManager) -> str:
    token = "owner-setup"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="owner",
        scopes=sorted(ALL_SCOPES),
        name="owner",
        device_type="desktop-shell",
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


def _parse_setup_events(runtime: RuntimeConfig) -> list[dict]:
    p = runtime.data_dir / "telemetry" / "setup-events.jsonl"
    if not p.is_file():
        return []
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]


@pytest.fixture(autouse=True)
def _reset_setup_funnel():
    reset_sessions_for_tests()
    reset_telemetry()
    reset_runtime()
    yield
    reset_sessions_for_tests()
    reset_telemetry()
    reset_runtime()


def test_setup_session_and_music_dir_steps_emit(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    app = Flask(__name__)
    app.register_blueprint(setup_bp)
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    res = client.post("/api/setup/session", json={}, headers={"Authorization": f"Bearer {owner}"})
    assert res.status_code == 200
    sid = res.get_json()["setup_session_id"]

    chosen = tmp_path / "chosen_lib"
    post = client.post(
        "/api/setup/music-dir",
        json={"music_dir": str(chosen), "setup_session_id": sid},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert post.status_code == 200

    events = _parse_setup_events(runtime)
    types = [e["event"] for e in events]
    assert "setup_session_started" in types
    assert "setup_music_dir_saved" in types
    assert "setup_step_completed" in types
    assert any(e.get("step") == "music_dir" for e in events if e["event"] == "setup_step_completed")


def test_setup_error_emitted_on_bad_path(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    app = Flask(__name__)
    app.register_blueprint(setup_bp)
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    res = client.post("/api/setup/session", json={}, headers={"Authorization": f"Bearer {owner}"})
    sid = res.get_json()["setup_session_id"]

    post = client.post(
        "/api/setup/music-dir",
        json={"music_dir": "/proc/../etc/passwd", "setup_session_id": sid},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert post.status_code == 400
    events = _parse_setup_events(runtime)
    assert any(e.get("event") == "setup_error" for e in events)


def test_play_track_emits_setup_first_play(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    track = _sample_track("x")
    meta = LibraryMetadata(version=1, tracks=[track], playlists={}, settings={})
    mock_lib = MagicMock()
    mock_lib.metadata = meta

    def get_core():
        engine = MagicMock()
        mock_lib.get_track_url = MagicMock(return_value="/tmp/fake.mp3")
        return mock_lib, engine, None

    fake_api = {
        "get_core": get_core,
        "get_track_by_id": lambda lib, tid: track if tid == track.id else None,
    }

    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()
    db = DatabaseManager()
    play_tok = _agent_play(db)

    sid = str(uuid.uuid4())

    with patch("shared.api.routes.playback._get_api", return_value=fake_api):
        res = client.post(
            "/api/playback/play",
            json={"track_id": track.id, "setup_session_id": sid},
            headers={"Authorization": f"Bearer {play_tok}"},
        )
    assert res.status_code == 200

    events = _parse_setup_events(runtime)
    fp = [e for e in events if e.get("event") == "setup_first_play"]
    assert len(fp) == 1
    assert fp[0].get("setup_session_id") == sid
    assert "elapsed_ms_since_session" in fp[0]


def test_setup_gate_rollup_summarize():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("setup_gate_rollup", root / "scripts" / "setup_gate_rollup.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    sid = str(uuid.uuid4())
    events = [
        {"v": 1, "event": "setup_session_started", "ts": 100, "setup_session_id": sid},
        {
            "v": 1,
            "event": "setup_first_play",
            "ts": 200,
            "setup_session_id": sid,
            "elapsed_ms_since_session": 60_000,
        },
    ]
    out = mod.summarize(events)
    assert out["sessions_with_setup_session_started"] == 1
    assert out["sessions_first_play_within_10min"] == 1
    assert out["success_rate_vs_started_sessions"] == 1.0
    assert out["median_elapsed_ms_first_play"] == 60_000


def test_setup_gate_rollup_date_window():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("setup_gate_rollup", root / "scripts" / "setup_gate_rollup.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    sid_old = str(uuid.uuid4())
    sid_new = str(uuid.uuid4())
    events = [
        {"v": 1, "event": "setup_session_started", "ts": 100, "setup_session_id": sid_old},
        {"v": 1, "event": "setup_session_started", "ts": 500, "setup_session_id": sid_new},
        {
            "v": 1,
            "event": "setup_first_play",
            "ts": 600,
            "setup_session_id": sid_new,
            "elapsed_ms_since_session": 90_000,
        },
    ]
    filtered = mod.filter_events_by_ts(events, since_ts=400, until_ts=700)
    out = mod.summarize(filtered)
    assert out["sessions_with_setup_session_started"] == 1
    assert out["sessions_first_play_within_10min"] == 1
    assert out["median_elapsed_ms_first_play"] == 90_000


def test_setup_gate_rollup_cli(tmp_path):
    root = Path(__file__).resolve().parents[1]
    log_dir = tmp_path / "telemetry"
    log_dir.mkdir(parents=True)
    sid = str(uuid.uuid4())
    line = json.dumps(
        {"v": 1, "event": "setup_session_started", "ts": 1, "setup_session_id": sid},
        separators=(",", ":"),
    )
    (log_dir / "setup-events.jsonl").write_text(line + "\n", encoding="utf-8")

    import subprocess

    r = subprocess.run(
        [sys.executable, str(root / "scripts" / "setup_gate_rollup.py"), "--setup-events", str(log_dir / "setup-events.jsonl")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 0
    assert "setup_session_started" in r.stdout


def test_setup_session_second_post_does_not_duplicate_started(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    app = Flask(__name__)
    app.register_blueprint(setup_bp)
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    r1 = client.post("/api/setup/session", json={}, headers={"Authorization": f"Bearer {owner}"})
    sid = r1.get_json()["setup_session_id"]
    client.post(
        "/api/setup/session",
        json={"setup_session_id": sid},
        headers={"Authorization": f"Bearer {owner}"},
    )
    events = _parse_setup_events(runtime)
    assert sum(1 for e in events if e.get("event") == "setup_session_started") == 1


def test_setup_first_play_endpoint(tmp_path):
    runtime = _make_runtime(tmp_path)
    init_telemetry(runtime)

    app = Flask(__name__)
    app.register_blueprint(setup_bp)
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    r0 = client.post("/api/setup/session", json={}, headers={"Authorization": f"Bearer {owner}"})
    sid = r0.get_json()["setup_session_id"]

    r1 = client.post(
        "/api/setup/first-play",
        json={"setup_session_id": sid, "track_id": "trk"},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert r1.status_code == 200
    assert r1.get_json()["emitted"] is True

    r2 = client.post(
        "/api/setup/first-play",
        json={"setup_session_id": sid, "track_id": "trk"},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert r2.get_json()["emitted"] is False

    events = _parse_setup_events(runtime)
    assert sum(1 for e in events if e.get("event") == "setup_first_play") == 1
