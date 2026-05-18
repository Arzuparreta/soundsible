import hashlib
import uuid

from flask import Flask

from shared.api.routes.setup import setup_bp
from shared.database import DatabaseManager
from shared.hardening import ALL_SCOPES
from shared.runtime import RuntimeConfig, configure_runtime, get_runtime_config, reset_runtime


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


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(setup_bp)
    return app


def _owner_token(db: DatabaseManager) -> str:
    token = "owner-music"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="owner",
        scopes=sorted(ALL_SCOPES),
        name="owner",
        device_type="desktop-shell",
    )
    return token


def test_get_music_dir_requires_admin(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _make_app()
    client = app.test_client()
    res = client.get("/api/setup/music-dir")
    assert res.status_code == 403


def test_get_and_post_music_dir_persists_and_updates_runtime(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    reset_runtime()
    _make_runtime(tmp_path)
    app = _make_app()
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    chosen = tmp_path / "chosen_lib"
    assert not chosen.exists()

    res = client.get(
        "/api/setup/music-dir",
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["effective_source"] == "default"
    assert body["env_override"] is False

    post = client.post(
        "/api/setup/music-dir",
        json={"music_dir": str(chosen)},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert post.status_code == 200
    assert chosen.is_dir()
    prefs = (tmp_path / "cfg" / "music_dir.json").read_text()
    assert str(chosen.resolve()) in prefs
    assert get_runtime_config().music_dir == chosen.resolve()

    res2 = client.get(
        "/api/setup/music-dir",
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert res2.status_code == 200
    assert res2.get_json()["music_dir"] == str(chosen.resolve())


def test_post_music_dir_rejects_unsafe_path(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_MUSIC_DIR", raising=False)
    reset_runtime()
    _make_runtime(tmp_path)
    app = _make_app()
    client = app.test_client()
    db = DatabaseManager()
    owner = _owner_token(db)

    post = client.post(
        "/api/setup/music-dir",
        json={"music_dir": "/proc/../etc/passwd"},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert post.status_code == 400
