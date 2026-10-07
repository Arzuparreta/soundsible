import hashlib
import uuid

from flask import Flask

from shared.api.routes.pairing import pairing_bp
from shared.database import DatabaseManager, instance_db
from shared.hardening import ALL_SCOPES
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


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
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)
    return runtime


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(pairing_bp)
    return app


def _owner_token(db: DatabaseManager) -> str:
    token = "owner-secret"
    db.create_auth_token(
        str(uuid.uuid4()),
        _hash(token),
        kind="owner",
        scopes=sorted(ALL_SCOPES),
        name="owner",
        device_type="desktop-shell",
    )
    return token


def test_pairing_session_flow_claim_confirm_verify_and_revoke(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _make_app()
    client = app.test_client()
    db = instance_db()
    owner_token = _owner_token(db)

    created = client.post(
        "/api/pairing/sessions",
        json={"scopes": ["library:read", "playback:control", "download:add"]},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert created.status_code == 201
    created_body = created.get_json()
    assert created_body["status"] == "pending"
    assert created_body["code"]
    assert created_body["granted_scopes"] == ["download:add", "library:read", "playback:control"]
    assert created_body["connect"]["presentable"] is False
    assert created_body["connect"]["claim_url"] is None

    claimed = client.post(
        "/api/pairing/sessions/claim",
        json={"code": created_body["code"], "device_name": "Alice Phone", "device_type": "phone"},
    )
    assert claimed.status_code == 200
    claimed_body = claimed.get_json()
    assert claimed_body["status"] == "claimed"
    assert claimed_body["device_name"] == "Alice Phone"

    confirmed = client.post(
        f"/api/pairing/sessions/{created_body['session_id']}/confirm",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert confirmed.status_code == 201
    confirmed_body = confirmed.get_json()
    paired_token = confirmed_body["token"]
    paired_id = confirmed_body["paired_device"]["token_id"]
    assert confirmed_body["session"]["status"] == "completed"
    assert confirmed_body["paired_device"]["kind"] == "paired_device"

    verified = client.get(
        "/api/pairing/verify",
        headers={"Authorization": f"Bearer {paired_token}"},
    )
    assert verified.status_code == 200
    verify_body = verified.get_json()
    assert verify_body["valid"] is True
    assert verify_body["token"]["kind"] == "paired_device"

    devices = client.get(
        "/api/paired-devices",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert devices.status_code == 200
    device_ids = [row["token_id"] for row in devices.get_json()["devices"]]
    assert paired_id in device_ids

    revoked = client.post(
        f"/api/paired-devices/{paired_id}/revoke",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert revoked.status_code == 200
    assert revoked.get_json()["revoked_at"] is not None

    verified_after_revoke = client.get(
        "/api/pairing/verify",
        headers={"Authorization": f"Bearer {paired_token}"},
    )
    assert verified_after_revoke.status_code == 401


def test_pairing_claim_rejects_reuse_and_cancel_closes_session(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _make_app()
    client = app.test_client()
    db = instance_db()
    owner_token = _owner_token(db)

    created = client.post(
        "/api/pairing/sessions",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    code = created.get_json()["code"]
    session_id = created.get_json()["session_id"]

    first_claim = client.post(
        "/api/pairing/sessions/claim",
        json={"code": code, "device_name": "Phone 1"},
    )
    assert first_claim.status_code == 200

    second_claim = client.post(
        "/api/pairing/sessions/claim",
        json={"code": code, "device_name": "Phone 2"},
    )
    assert second_claim.status_code == 409

    cancelled = client.post(
        f"/api/pairing/sessions/{session_id}/cancel",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert cancelled.status_code == 200
    assert cancelled.get_json()["status"] == "cancelled"

    confirm_after_cancel = client.post(
        f"/api/pairing/sessions/{session_id}/confirm",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert confirm_after_cancel.status_code == 409


def test_pairing_connect_payload_and_auto_confirm_while_display_is_open(tmp_path, monkeypatch):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    runtime = RuntimeConfig(
        host=runtime.host,
        port=runtime.port,
        config_dir=runtime.config_dir,
        data_dir=runtime.data_dir,
        cache_dir=runtime.cache_dir,
        log_dir=runtime.log_dir,
        music_dir=runtime.music_dir,
        ui_dist=runtime.ui_dist,
        owner_token_file=runtime.owner_token_file,
        lan_enabled=True,
        advanced_mode=runtime.advanced_mode,
    )
    configure_runtime(runtime)
    app = _make_app()
    client = app.test_client()
    db = instance_db()
    owner_token = _owner_token(db)

    monkeypatch.setattr("shared.api.get_active_endpoints", lambda: ["192.168.1.50"])

    created = client.post(
        "/api/pairing/sessions",
        json={"auto_confirm": True, "display_active": True},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert created.status_code == 201
    created_body = created.get_json()
    assert created_body["auto_confirm"] is True
    assert created_body["display_active"] is True
    assert created_body["connect"]["presentable"] is True
    assert created_body["connect"]["suggested_base_url"] == "http://192.168.1.50:5005"
    assert created_body["connect"]["claim_url"] == "http://192.168.1.50:5005/api/pairing/sessions/claim"
    assert '"type":"soundsible_pairing"' in created_body["connect"]["qr_text"]

    auto_confirmed = client.post(
        "/api/pairing/sessions/claim",
        json={"code": created_body["code"], "device_name": "Bob Phone", "device_type": "phone"},
    )
    assert auto_confirmed.status_code == 201
    auto_body = auto_confirmed.get_json()
    assert auto_body["auto_confirmed"] is True
    assert auto_body["session"]["status"] == "completed"
    assert auto_body["paired_device"]["kind"] == "paired_device"


def test_display_close_disables_auto_confirm(tmp_path, monkeypatch):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    runtime = RuntimeConfig(
        host=runtime.host,
        port=runtime.port,
        config_dir=runtime.config_dir,
        data_dir=runtime.data_dir,
        cache_dir=runtime.cache_dir,
        log_dir=runtime.log_dir,
        music_dir=runtime.music_dir,
        ui_dist=runtime.ui_dist,
        owner_token_file=runtime.owner_token_file,
        lan_enabled=True,
        advanced_mode=runtime.advanced_mode,
    )
    configure_runtime(runtime)
    app = _make_app()
    client = app.test_client()
    db = instance_db()
    owner_token = _owner_token(db)

    monkeypatch.setattr("shared.api.get_active_endpoints", lambda: ["192.168.1.50"])

    created = client.post(
        "/api/pairing/sessions",
        json={"auto_confirm": True, "display_active": True},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    session_id = created.get_json()["session_id"]
    code = created.get_json()["code"]

    closed = client.post(
        f"/api/pairing/sessions/{session_id}/display-close",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert closed.status_code == 200
    assert closed.get_json()["display_active"] is False

    claimed = client.post(
        "/api/pairing/sessions/claim",
        json={"code": code, "device_name": "Charlie Phone"},
    )
    assert claimed.status_code == 200
    assert claimed.get_json()["status"] == "claimed"


def _bound_app():
    """The pairing blueprint behind the same per-request account binding as the engine."""
    from flask import request as current_request
    from shared.hardening import get_request_auth_context
    from shared.user_context import bind_user

    app = _make_app()

    @app.before_request
    def bind():
        if current_request.cookies.get("sb_session"):
            context = get_request_auth_context()
            bind_user(context.get("user_id") if context else None)
        else:
            bind_user(None)

    return app


def _member_session(client):
    from shared.users import create_session, create_user

    user = create_user("pairing_member", password="pairing-test")
    token, _ = create_session(user["id"], device_name="Browser")
    client.set_cookie("sb_session", token)
    return user


def test_scanning_a_shown_code_signs_that_account_in_and_is_revocable(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _bound_app()
    owner, phone = app.test_client(), app.test_client()
    db = instance_db()
    user = _member_session(owner)

    shown = owner.post("/api/pairing/sessions", json={"auto_confirm": True, "display_active": True}).get_json()
    claimed = phone.post("/api/pairing/sessions/claim", json={
        "code": shown["code"].lower(), "device_name": "Pixel 8", "device_type": "android", "credential": "session"})
    assert claimed.status_code == 201
    body = claimed.get_json()
    assert body["user"]["id"] == user["id"] and body["session"]["status"] == "completed"
    assert "token" not in body
    cookie = phone.get_cookie("sb_session")
    assert cookie is not None and cookie.http_only
    record = db.get_auth_token_by_hash(_hash(cookie.value))
    assert record["kind"] == "session" and record["user_id"] == user["id"] and record["device_type"] == "android"
    assert record["name"] == "Pixel 8"

    listed = owner.get("/api/paired-devices").get_json()["devices"]
    assert [row["token_id"] for row in listed] == [record["id"]]
    # A code is single-use, however it was claimed.
    again = app.test_client().post("/api/pairing/sessions/claim", json={
        "code": shown["code"], "device_name": "Other", "credential": "session"})
    assert again.status_code == 409

    revoked = owner.post(f"/api/paired-devices/{record['id']}/revoke")
    assert revoked.status_code == 200 and revoked.get_json()["revoked_at"] is not None
    assert db.get_auth_token(record["id"])["revoked_at"] is not None
    assert owner.get("/api/paired-devices").get_json()["devices"] == []


def test_signed_in_claim_requires_the_code_to_be_showing_and_never_consumes_it(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _bound_app()
    owner, phone = app.test_client(), app.test_client()
    _member_session(owner)

    hidden = owner.post("/api/pairing/sessions", json={"auto_confirm": True}).get_json()
    refused = phone.post("/api/pairing/sessions/claim", json={
        "code": hidden["code"], "device_name": "Pixel 8", "credential": "session"})
    assert refused.status_code == 409 and refused.get_json()["code"] == "pairing_display_required"
    assert phone.get_cookie("sb_session") is None
    assert owner.get("/api/pairing/sessions").get_json()["sessions"][0]["status"] == "pending"

    bad = phone.post("/api/pairing/sessions/claim", json={"code": hidden["code"], "device_name": "Pixel 8", "credential": "owner"})
    assert bad.status_code == 400


def test_sessions_not_minted_by_pairing_cannot_be_revoked_as_paired_devices(tmp_path):
    reset_runtime()
    _make_runtime(tmp_path)
    app = _bound_app()
    owner = app.test_client()
    _member_session(owner)
    browser = instance_db().get_auth_token_by_hash(_hash(owner.get_cookie("sb_session").value))
    assert owner.post(f"/api/paired-devices/{browser['id']}/revoke").status_code == 404
    assert owner.get("/api/paired-devices").get_json()["devices"] == []
