"""Comprehensive tests for Smart TV device authorization routes and store."""

from __future__ import annotations

import hashlib
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, request as current_request

from shared.api.routes.pairing import pairing_bp
from shared.api.routes.tv_auth import tv_auth_bp
from shared.database import instance_db
from shared.hardening import _reset_rate_limits_for_tests as clear_rate_limits, get_request_auth_context
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.user_context import bind_user
from shared.users import create_session, create_user


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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


def _bound_app() -> Flask:
    app = Flask(__name__)
    app.register_blueprint(tv_auth_bp)
    app.register_blueprint(pairing_bp)

    @app.before_request
    def _bind():
        if current_request.cookies.get("sb_session"):
            ctx = get_request_auth_context()
            bind_user(ctx.get("user_id") if ctx else None)
        else:
            bind_user(None)

    return app


def _sign_in_cookie(client, *, username: str, role: str = "admin", password: str = "pw-12345"):
    user = create_user(username, password=password, role=role)
    token, _ = create_session(user["id"], device_name=f"{username} phone", device_type="web")
    client.set_cookie("sb_session", token)
    return user


def _csrf_headers(origin: str = "http://localhost") -> dict[str, str]:
    return {
        "X-Soundsible-CSRF": "1",
        "Origin": origin,
        "Sec-Fetch-Site": "same-origin",
    }


def test_tv_auth_happy_path_hashes_secrets_and_lists_revocable_session(tmp_path):
    reset_runtime()
    clear_rate_limits()
    _make_runtime(tmp_path)
    app = _bound_app()
    tv, phone = app.test_client(), app.test_client()
    db = instance_db()
    user = _sign_in_cookie(phone, username="alice_member", role="member")

    created = tv.post("/api/tv-auth/requests", json={"device_name": "Living Room OLED"})
    assert created.status_code == 201
    req_data = created.get_json()
    code = req_data["code"]
    handle = req_data["redemption_handle"]
    assert "-" in code
    assert "/player/#/tv-approve?code=" in req_data["approve_url"]
    assert handle not in req_data["approve_url"]

    # Persistence stores only SHA-256 hashes, never plaintext codes or handles.
    raw_code = code.replace("-", "")
    stored = db.get_tv_auth_request_by_handle_hash(_hash(handle))
    assert stored is not None
    assert stored["code_hash"] == _hash(raw_code)
    assert stored["code_hash"] != raw_code
    assert stored["handle_hash"] != handle
    assert stored["device_name"] == "Living Room OLED"
    assert stored["status"] == "pending"

    # Redeem before approval stays pending.
    premature = tv.post("/api/tv-auth/redeem", json={"redemption_handle": handle})
    assert premature.status_code == 409
    assert premature.get_json()["code"] == "pending"

    # Phone looks up and explicitly approves its own account.
    looked = phone.post("/api/tv-auth/lookup", json={"code": code.lower()}, headers=_csrf_headers())
    assert looked.status_code == 200
    assert looked.get_json()["device_name"] == "Living Room OLED"

    approved = phone.post("/api/tv-auth/approve", json={"code": code}, headers=_csrf_headers())
    assert approved.status_code == 200
    assert approved.get_json()["user"]["id"] == user["id"]

    status = tv.post("/api/tv-auth/status", json={"redemption_handle": handle})
    assert status.status_code == 200
    assert status.get_json()["status"] == "approved"

    redeemed = tv.post("/api/tv-auth/redeem", json={"redemption_handle": handle})
    assert redeemed.status_code == 201
    assert redeemed.get_json()["user"]["id"] == user["id"]
    cookie = tv.get_cookie("sb_session")
    assert cookie is not None and cookie.http_only

    # Repeated redemption is rejected atomically.
    second_redeem = tv.post("/api/tv-auth/redeem", json={"redemption_handle": handle})
    assert second_redeem.status_code == 409
    assert second_redeem.get_json()["code"] == "already_redeemed"

    # The TV session appears under /api/paired-devices and can be revoked by the phone.
    paired = phone.get("/api/paired-devices").get_json()["devices"]
    assert len(paired) == 1
    assert paired[0]["name"] == "Living Room OLED"
    token_id = paired[0]["token_id"]

    revoked = phone.post(f"/api/paired-devices/{token_id}/revoke")
    assert revoked.status_code == 200
    assert revoked.get_json()["revoked_at"] is not None
    assert phone.get("/api/paired-devices").get_json()["devices"] == []


def test_two_simultaneous_tvs_denial_cancel_and_wrong_code(tmp_path):
    reset_runtime()
    clear_rate_limits()
    _make_runtime(tmp_path)
    app = _bound_app()
    tv1, tv2, phone = app.test_client(), app.test_client(), app.test_client()
    user_b = _sign_in_cookie(phone, username="bob_admin", role="admin")

    r1 = tv1.post("/api/tv-auth/requests", json={"device_name": "Bedroom TV"}).get_json()
    r2 = tv2.post("/api/tv-auth/requests", json={"device_name": "Living Room TV"}).get_json()
    assert r1["code"] != r2["code"]
    assert r1["redemption_handle"] != r2["redemption_handle"]

    # Wrong code fails cleanly.
    bad = phone.post("/api/tv-auth/lookup", json={"code": "ZZZZ-2222"}, headers=_csrf_headers())
    assert bad.status_code == 404

    # Deny TV1.
    deny = phone.post("/api/tv-auth/deny", json={"code": r1["code"]}, headers=_csrf_headers())
    assert deny.status_code == 200
    assert deny.get_json()["status"] == "denied"
    assert tv1.post("/api/tv-auth/redeem", json={"redemption_handle": r1["redemption_handle"]}).status_code == 409

    # TV2 cancels before approval -> lookup sees not_pending and approve rejects.
    cancel = tv2.post("/api/tv-auth/cancel", json={"redemption_handle": r2["redemption_handle"]})
    assert cancel.status_code == 200
    assert cancel.get_json()["status"] == "cancelled"
    assert phone.post("/api/tv-auth/approve", json={"code": r2["code"]}, headers=_csrf_headers()).status_code == 409

    # Re-create request on TV2 and approve to verify account binding stays clean.
    r3 = tv2.post("/api/tv-auth/requests", json={"device_name": "Living Room TV"}).get_json()
    ok = phone.post("/api/tv-auth/approve", json={"code": r3["code"]}, headers=_csrf_headers())
    assert ok.status_code == 200
    redeemed = tv2.post("/api/tv-auth/redeem", json={"redemption_handle": r3["redemption_handle"]})
    assert redeemed.status_code == 201
    assert redeemed.get_json()["user"]["id"] == user_b["id"]


def test_tv_auth_expiry_csrf_and_cross_origin_checks(tmp_path):
    reset_runtime()
    clear_rate_limits()
    _make_runtime(tmp_path)
    app = _bound_app()
    tv, phone = app.test_client(), app.test_client()
    db = instance_db()
    _sign_in_cookie(phone, username="carol", role="member")

    # Requires authenticated phone + same-origin + CSRF header.
    created = tv.post("/api/tv-auth/requests", json={"device_name": "Den TV"}).get_json()
    no_csrf = phone.post("/api/tv-auth/approve", json={"code": created["code"]})
    assert no_csrf.status_code == 403

    cross_site = phone.post(
        "/api/tv-auth/approve",
        json={"code": created["code"]},
        headers={"X-Soundsible-CSRF": "1", "Sec-Fetch-Site": "cross-site"},
    )
    assert cross_site.status_code == 403

    bad_origin = phone.post(
        "/api/tv-auth/approve",
        json={"code": created["code"]},
        headers={"X-Soundsible-CSRF": "1", "Origin": "https://evil.example"},
    )
    assert bad_origin.status_code == 403

    anon = app.test_client().post("/api/tv-auth/approve", json={"code": created["code"]}, headers=_csrf_headers())
    assert anon.status_code == 401

    # Force request expiry in DB and confirm lookup/status/redeem observe expired.
    with db._get_connection() as conn:
        conn.execute(
            "UPDATE tv_auth_requests SET expires_at = datetime('now', '-5 minutes') WHERE handle_hash = ?",
            (_hash(created["redemption_handle"]),),
        )
    st = tv.post("/api/tv-auth/status", json={"redemption_handle": created["redemption_handle"]})
    assert st.status_code == 200
    assert st.get_json()["status"] == "expired"
    assert tv.post("/api/tv-auth/redeem", json={"redemption_handle": created["redemption_handle"]}).status_code == 410
    assert phone.post("/api/tv-auth/lookup", json={"code": created["code"]}, headers=_csrf_headers()).status_code == 410


def test_tv_auth_concurrent_approval_and_atomic_redeem(tmp_path):
    reset_runtime()
    clear_rate_limits()
    _make_runtime(tmp_path)
    db = instance_db()
    alice = create_user("alice", role="member")
    bob = create_user("bob", role="admin")

    code_hash = _hash("ABCD2345")
    handle_hash = _hash("handle-secret")
    db.create_tv_auth_request(
        str(uuid.uuid4()),
        code_hash=code_hash,
        handle_hash=handle_hash,
        device_name="Concurrency TV",
        expires_at="2099-01-01 00:00:00",
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(db.approve_tv_auth_request_by_code_hash, code_hash, user_id=alice["id"])
        f2 = pool.submit(db.approve_tv_auth_request_by_code_hash, code_hash, user_id=bob["id"])
        winners = [r for r in (f1.result(), f2.result()) if r is not None]
    assert len(winners) == 1

    with ThreadPoolExecutor(max_workers=2) as pool:
        r1 = pool.submit(db.consume_tv_auth_request_by_handle_hash, handle_hash)
        r2 = pool.submit(db.consume_tv_auth_request_by_handle_hash, handle_hash)
        consumed = [r for r in (r1.result(), r2.result()) if r is not None]
    assert len(consumed) == 1


def test_tv_auth_rate_limits(tmp_path):
    reset_runtime()
    clear_rate_limits()
    _make_runtime(tmp_path)
    app = _bound_app()
    tv = app.test_client()

    statuses = [
        tv.post("/api/tv-auth/requests", json={"device_name": f"TV {i}"}).status_code
        for i in range(16)
    ]
    assert all(code == 201 for code in statuses[:15])
    assert statuses[15] == 429
