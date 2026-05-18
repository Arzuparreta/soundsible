import hashlib
import uuid

from flask import Flask, jsonify

from shared.database import DatabaseManager
from shared.hardening import (
    SCOPE_ADMIN_CONFIG,
    SCOPE_LIBRARY_READ,
    SCOPE_LIBRARY_WRITE,
    SCOPE_PLAYBACK_CONTROL,
    require_scope,
)
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _make_runtime(tmp_path, *, advanced_mode: bool) -> RuntimeConfig:
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
        advanced_mode=advanced_mode,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)
    return runtime


def _make_app():
    app = Flask(__name__)

    @app.post("/playback")
    @require_scope(SCOPE_PLAYBACK_CONTROL, allow_trusted_network=True)
    def playback():
        return jsonify({"ok": True})

    @app.post("/write")
    @require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
    def write():
        return jsonify({"ok": True})

    @app.post("/admin")
    @require_scope(SCOPE_ADMIN_CONFIG, allow_trusted_network=False)
    def admin():
        return jsonify({"ok": True})

    return app


def test_auth_token_lookup_revocation_and_expiry(tmp_path):
    db = DatabaseManager(str(tmp_path / "auth.db"))
    active_id = str(uuid.uuid4())
    expired_id = str(uuid.uuid4())
    revoked_id = str(uuid.uuid4())

    db.create_auth_token(active_id, _hash("active"), kind="agent", scopes=[SCOPE_PLAYBACK_CONTROL])
    db.create_auth_token(
        expired_id,
        _hash("expired"),
        kind="agent",
        scopes=[SCOPE_LIBRARY_READ],
        expires_at="2000-01-01 00:00:00",
    )
    db.create_auth_token(revoked_id, _hash("revoked"), kind="agent", scopes=[SCOPE_LIBRARY_READ])
    db.revoke_auth_token(revoked_id)

    active = db.get_auth_token_by_hash(_hash("active"))
    assert active is not None
    assert active["scopes"] == [SCOPE_PLAYBACK_CONTROL]
    assert db.get_auth_token_by_hash(_hash("expired")) is None
    assert db.get_auth_token_by_hash(_hash("revoked")) is None


def test_scope_enforcement_allows_only_matching_token(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path, advanced_mode=False)
    app = _make_app()
    db = DatabaseManager()
    db.create_auth_token(str(uuid.uuid4()), _hash("play"), kind="agent", scopes=[SCOPE_PLAYBACK_CONTROL])
    db.create_auth_token(str(uuid.uuid4()), _hash("read"), kind="agent", scopes=[SCOPE_LIBRARY_READ])

    client = app.test_client()

    assert client.post("/playback").status_code == 403
    assert client.post("/playback", headers={"Authorization": "Bearer read"}).status_code == 403
    assert client.post("/playback", headers={"Authorization": "Bearer play"}).status_code == 200


def test_trusted_network_compat_disabled_in_desktop_mode_and_enabled_in_advanced_mode(tmp_path):
    app = _make_app()
    client = app.test_client()

    reset_runtime()
    _make_runtime(tmp_path / "desktop", advanced_mode=False)
    assert client.post("/write").status_code == 403
    assert client.post("/playback").status_code == 403

    reset_runtime()
    _make_runtime(tmp_path / "advanced", advanced_mode=True)
    assert client.post("/write").status_code == 200
    assert client.post("/playback").status_code == 200


def test_legacy_admin_env_token_still_grants_admin_scope(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path, advanced_mode=True)
    monkeypatch.setenv("SOUNDSIBLE_ADMIN_TOKEN", "legacy-secret")
    app = _make_app()
    client = app.test_client()

    response = client.post("/admin", headers={"Authorization": "Bearer legacy-secret"})

    assert response.status_code == 200
