"""Small public control plane for live Soundsible sessions.

Audio never crosses this process. MediaMTX owns WHIP/WHEP while this service
owns active leases, signed DJ identity, synchronized program metadata and an
ephemeral plain-text chat.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room

SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{12,64}$")
STREAM_RE = re.compile(r"^live_[A-Za-z0-9_-]{16,64}$")
CHAT_MAX = 500
TITLE_MAX = 96
SIGNATURE_SKEW_SECONDS = 120
RECONNECT_GRACE_SECONDS = int(os.getenv("COMMUNITY_RECONNECT_GRACE_SECONDS", "90"))
MAX_ACTIVE_SESSIONS = int(os.getenv("COMMUNITY_MAX_ACTIVE_SESSIONS", "5"))
MAX_SESSION_LISTENERS = int(os.getenv("COMMUNITY_MAX_SESSION_LISTENERS", "100"))
MAX_TOTAL_LISTENERS = int(os.getenv("COMMUNITY_MAX_TOTAL_LISTENERS", "250"))
DB_PATH = Path(os.getenv("COMMUNITY_DB_PATH", "/data/community.db"))
ARTWORK_DIR = Path(os.getenv("COMMUNITY_ARTWORK_DIR", "/data/artwork"))
PUBLIC_URL = (os.getenv("COMMUNITY_PUBLIC_URL") or "http://localhost:8080").rstrip("/")
MEDIA_PUBLIC_URL = (os.getenv("COMMUNITY_MEDIA_URL") or f"{PUBLIC_URL}/media").rstrip("/")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("COMMUNITY_SECRET_KEY") or secrets.token_hex(32)
CORS(app, resources={r"/v1/*": {"origins": "*"}, r"/health": {"origins": "*"}})
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode=os.getenv("COMMUNITY_SOCKET_ASYNC_MODE", "gevent"),
    ping_interval=20,
    ping_timeout=25,
)

_db_lock = threading.RLock()
_nonce_lock = threading.Lock()
_nonces: dict[str, float] = {}
_programs: dict[str, dict[str, Any]] = {}
_connections: dict[str, dict[str, Any]] = {}
_host_generation: dict[str, int] = {}


def _now() -> int:
    return int(time.time())


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_body(body: Any) -> bytes:
    return json.dumps(
        body if body is not None else {},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _signature_message(method: str, path: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    digest = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{nonce}\n{method.upper()}\n{path}\n{digest}".encode("utf-8")


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _db_lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS identities (
                community_id TEXT PRIMARY KEY,
                public_key TEXT NOT NULL,
                display_name TEXT NOT NULL,
                avatar_color TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                community_id TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                stream_path TEXT NOT NULL UNIQUE,
                publish_token_hash TEXT NOT NULL,
                host_token_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                listener_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (community_id) REFERENCES identities(community_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_status_updated
            ON sessions(status, updated_at);
            """
        )
        # A process restart has no publisher sockets. Give them the ordinary
        # resume window instead of advertising stale rooms as healthy.
        conn.execute(
            "UPDATE sessions SET status = 'reconnecting', listener_count = 0, updated_at = ? "
            "WHERE status IN ('waiting', 'live')",
            (_now(),),
        )


def _cleanup_nonces() -> None:
    cutoff = time.time() - SIGNATURE_SKEW_SECONDS * 2
    for key, seen_at in list(_nonces.items()):
        if seen_at < cutoff:
            _nonces.pop(key, None)


def _verify_station_request() -> tuple[dict[str, Any] | None, tuple[Any, int] | None]:
    public_key = (request.headers.get("X-Soundsible-Public-Key") or "").strip()
    signature = (request.headers.get("X-Soundsible-Signature") or "").strip()
    timestamp = (request.headers.get("X-Soundsible-Timestamp") or "").strip()
    nonce = (request.headers.get("X-Soundsible-Nonce") or "").strip()
    claimed_id = (request.headers.get("X-Soundsible-Community-Id") or "").strip()
    try:
        stamp = int(timestamp)
        public_raw = _b64decode(public_key)
        signature_raw = _b64decode(signature)
    except (TypeError, ValueError):
        return None, (jsonify({"error": "Invalid station signature"}), 401)
    if len(public_raw) != 32 or abs(_now() - stamp) > SIGNATURE_SKEW_SECONDS or not nonce:
        return None, (jsonify({"error": "Expired or invalid station signature"}), 401)
    expected_id = _b64url(hashlib.sha256(public_raw).digest()[:18])
    if not secrets.compare_digest(expected_id, claimed_id):
        return None, (jsonify({"error": "Community identity mismatch"}), 401)
    nonce_key = f"{claimed_id}:{nonce}"
    with _nonce_lock:
        _cleanup_nonces()
        if nonce_key in _nonces:
            return None, (jsonify({"error": "Station signature already used"}), 409)
        _nonces[nonce_key] = time.time()
    body = request.get_json(silent=True) or {}
    try:
        Ed25519PublicKey.from_public_bytes(public_raw).verify(
            signature_raw,
            _signature_message(request.method, request.path, timestamp, nonce, _canonical_body(body)),
        )
    except InvalidSignature:
        return None, (jsonify({"error": "Invalid station signature"}), 401)
    return {"community_id": claimed_id, "public_key": public_key, "body": body}, None


def _profile(body: dict[str, Any]) -> tuple[str, str | None]:
    profile = body.get("profile") if isinstance(body.get("profile"), dict) else {}
    display_name = str(profile.get("display_name") or "DJ").strip()[:48] or "DJ"
    avatar_color = str(profile.get("avatar_color") or "").strip()[:32] or None
    return display_name, avatar_color


def _register_identity(verified: dict[str, Any]) -> None:
    display_name, avatar_color = _profile(verified["body"])
    now = _now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO identities
                (community_id, public_key, display_name, avatar_color, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(community_id) DO UPDATE SET
                display_name = excluded.display_name,
                avatar_color = excluded.avatar_color,
                updated_at = excluded.updated_at
            """,
            (
                verified["community_id"],
                verified["public_key"],
                display_name,
                avatar_color,
                now,
                now,
            ),
        )


def _session_row(session_id: str) -> sqlite3.Row | None:
    if not SESSION_RE.match(session_id):
        return None
    with db() as conn:
        return conn.execute(
            """
            SELECT s.*, i.display_name, i.avatar_color
            FROM sessions s JOIN identities i ON i.community_id = s.community_id
            WHERE s.id = ?
            """,
            (session_id,),
        ).fetchone()


def _public_session(row: sqlite3.Row, *, include_access: bool = False) -> dict[str, Any]:
    payload = {
        "id": row["id"],
        "status": row["status"],
        "title": row["title"],
        "host": {
            "id": row["community_id"],
            "display_name": row["display_name"],
            "avatar_color": row["avatar_color"],
        },
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "listener_count": row["listener_count"],
        "program": _programs.get(row["id"]),
        "whep_url": f"{MEDIA_PUBLIC_URL}/{row['stream_path']}/whep",
    }
    if include_access:
        payload["stream_path"] = row["stream_path"]
    return payload


def _access_payload(row: sqlite3.Row, host_token: str, publish_token: str) -> dict[str, Any]:
    payload = _public_session(row, include_access=True)
    payload.update({
        "host_token": host_token,
        "publish_token": publish_token,
        "whip_url": f"{MEDIA_PUBLIC_URL}/{row['stream_path']}/whip",
        "socket_url": PUBLIC_URL,
        "reconnect_grace_seconds": RECONNECT_GRACE_SECONDS,
    })
    return payload


def _require_session_owner(verified: dict[str, Any], session_id: str) -> sqlite3.Row | None:
    row = _session_row(session_id)
    if row is None or row["community_id"] != verified["community_id"]:
        return None
    return row


def _host_token_row(session_id: str) -> sqlite3.Row | None:
    row = _session_row(session_id)
    auth = (request.headers.get("Authorization") or "").strip()
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if row is None or not token or not secrets.compare_digest(_token_hash(token), row["host_token_hash"]):
        return None
    return row


def _purge_artwork(session_id: str) -> None:
    target = ARTWORK_DIR / session_id
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)


def _delete_expired_sessions() -> None:
    cutoff = _now() - RECONNECT_GRACE_SECONDS
    with db() as conn:
        expired = conn.execute(
            "SELECT id FROM sessions WHERE status = 'reconnecting' AND updated_at < ?",
            (cutoff,),
        ).fetchall()
        conn.executemany("DELETE FROM sessions WHERE id = ?", [(row["id"],) for row in expired])
    for row in expired:
        session_id = row["id"]
        _purge_artwork(session_id)
        _programs.pop(session_id, None)
        _host_generation.pop(session_id, None)


@app.get("/health")
def health():
    return jsonify({"status": "healthy", "service": "soundsible-community"})


@app.get("/v1/sessions")
def list_sessions():
    _delete_expired_sessions()
    with db() as conn:
        rows = conn.execute(
            """
            SELECT s.*, i.display_name, i.avatar_color
            FROM sessions s JOIN identities i ON i.community_id = s.community_id
            ORDER BY CASE s.status WHEN 'live' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
                     s.created_at DESC
            """
        ).fetchall()
    return jsonify({"sessions": [_public_session(row) for row in rows]})


@app.get("/v1/sessions/<session_id>")
def get_session(session_id: str):
    _delete_expired_sessions()
    row = _session_row(session_id)
    if row is None:
        return jsonify({"error": "Session not found"}), 404
    return jsonify({"session": _public_session(row)})


@app.get("/v1/artwork/<session_id>/<filename>")
def get_artwork(session_id: str, filename: str):
    if not SESSION_RE.match(session_id) or not re.match(r"^[A-Za-z0-9_-]{8,80}\.(webp|jpg|jpeg|png)$", filename):
        return jsonify({"error": "Artwork not found"}), 404
    return send_from_directory(
        ARTWORK_DIR / session_id,
        filename,
        max_age=3600,
        conditional=True,
    )


@app.post("/v1/sessions")
def create_session():
    verified, error = _verify_station_request()
    if error:
        return error
    assert verified is not None
    _register_identity(verified)
    body = verified["body"]
    display_name, _ = _profile(body)
    title = str(body.get("title") or f"Session by {display_name}").strip()[:TITLE_MAX]
    session_id = secrets.token_urlsafe(12)
    stream_path = f"live_{secrets.token_urlsafe(18)}"
    host_token = secrets.token_urlsafe(32)
    publish_token = secrets.token_urlsafe(32)
    now = _now()
    _delete_expired_sessions()
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM sessions WHERE community_id = ? LIMIT 1",
            (verified["community_id"],),
        ).fetchone()
        if existing is not None:
            return jsonify({
                "error": "This DJ already has an active session",
                "code": "session_already_active",
                "session_id": existing["id"],
            }), 409
        active_count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        if active_count >= MAX_ACTIVE_SESSIONS:
            return jsonify({"error": "The live directory is at capacity", "code": "session_capacity"}), 503
        conn.execute(
            """
            INSERT INTO sessions
                (id, community_id, title, status, stream_path, publish_token_hash,
                 host_token_hash, created_at, updated_at)
            VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                verified["community_id"],
                title,
                stream_path,
                _token_hash(publish_token),
                _token_hash(host_token),
                now,
                now,
            ),
        )
    row = _session_row(session_id)
    assert row is not None
    return jsonify({"session": _access_payload(row, host_token, publish_token)}), 201


@app.post("/v1/sessions/<session_id>/resume")
def resume_session(session_id: str):
    verified, error = _verify_station_request()
    if error:
        return error
    assert verified is not None
    _register_identity(verified)
    row = _require_session_owner(verified, session_id)
    if row is None:
        return jsonify({"error": "Session not found"}), 404
    if row["status"] == "reconnecting" and row["updated_at"] < _now() - RECONNECT_GRACE_SECONDS:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        _purge_artwork(session_id)
        _programs.pop(session_id, None)
        _host_generation.pop(session_id, None)
        return jsonify({"error": "Session expired"}), 410
    host_token = secrets.token_urlsafe(32)
    publish_token = secrets.token_urlsafe(32)
    next_status = "live" if session_id in _programs else "waiting"
    with db() as conn:
        conn.execute(
            """
            UPDATE sessions SET status = ?, host_token_hash = ?,
                publish_token_hash = ?, updated_at = ? WHERE id = ?
            """,
            (next_status, _token_hash(host_token), _token_hash(publish_token), _now(), session_id),
        )
    resumed = _session_row(session_id)
    assert resumed is not None
    return jsonify({"session": _access_payload(resumed, host_token, publish_token)})


@app.patch("/v1/sessions/<session_id>")
def update_session(session_id: str):
    verified, error = _verify_station_request()
    if error:
        return error
    assert verified is not None
    _register_identity(verified)
    if _require_session_owner(verified, session_id) is None:
        return jsonify({"error": "Session not found"}), 404
    title = str(verified["body"].get("title") or "").strip()[:TITLE_MAX]
    if not title:
        return jsonify({"error": "Title is required"}), 400
    with db() as conn:
        conn.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, _now(), session_id))
    row = _session_row(session_id)
    assert row is not None
    socketio.emit("session_updated", {"session": _public_session(row)}, room=session_id)
    return jsonify({"session": _public_session(row)})


@app.post("/v1/sessions/<session_id>/artwork")
def upload_artwork(session_id: str):
    if _host_token_row(session_id) is None:
        return jsonify({"error": "Session not found"}), 404
    uploaded = request.files.get("artwork")
    if uploaded is None:
        return jsonify({"error": "Artwork is required"}), 400
    content_type = str(uploaded.mimetype or "").lower()
    extension = {
        "image/webp": "webp",
        "image/jpeg": "jpg",
        "image/png": "png",
    }.get(content_type)
    if extension is None:
        return jsonify({"error": "Unsupported artwork type"}), 415
    data = uploaded.stream.read(256 * 1024 + 1)
    if not data or len(data) > 256 * 1024:
        return jsonify({"error": "Artwork is too large"}), 413
    track_key = re.sub(r"[^A-Za-z0-9_-]", "", str(request.form.get("track_id") or ""))[:48]
    if len(track_key) < 4:
        track_key = secrets.token_urlsafe(9)
    directory = ARTWORK_DIR / session_id
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{track_key}-{secrets.token_urlsafe(5)}.{extension}"
    (directory / filename).write_bytes(data)
    return jsonify({"artwork_url": f"{PUBLIC_URL}/v1/artwork/{session_id}/{filename}"}), 201


@app.delete("/v1/sessions/<session_id>")
def end_session(session_id: str):
    verified, error = _verify_station_request()
    if error:
        return error
    assert verified is not None
    if _require_session_owner(verified, session_id) is None:
        return jsonify({"error": "Session not found"}), 404
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    _purge_artwork(session_id)
    _programs.pop(session_id, None)
    _host_generation.pop(session_id, None)
    socketio.emit("session_ended", {"session_id": session_id}, room=session_id)
    return "", 204


@app.post("/internal/media-auth")
def media_auth():
    _delete_expired_sessions()
    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "")
    path = str(data.get("path") or "")
    if not STREAM_RE.match(path):
        return "", 403
    with db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE stream_path = ?", (path,)).fetchone()
    if row is None:
        return "", 403
    if action == "read":
        return "", 204
    if action == "publish":
        token = str(data.get("token") or data.get("password") or "")
        return ("", 204) if token and secrets.compare_digest(_token_hash(token), row["publish_token_hash"]) else ("", 403)
    return "", 403


def _socket_session(auth: dict[str, Any]) -> tuple[sqlite3.Row | None, bool]:
    session_id = str(auth.get("session_id") or "")
    row = _session_row(session_id)
    if row is None:
        return None, False
    token = str(auth.get("host_token") or "")
    host = bool(token) and secrets.compare_digest(_token_hash(token), row["host_token_hash"])
    return row, host


@socketio.on("connect")
def socket_connect(auth):
    _delete_expired_sessions()
    auth = auth if isinstance(auth, dict) else {}
    row, host = _socket_session(auth)
    if row is None:
        return False
    guest_id = re.sub(r"[^A-Za-z0-9_-]", "", str(auth.get("guest_id") or ""))[:32]
    guest_name = re.sub(r"[\x00-\x1f<>]", "", str(auth.get("guest_name") or ""))[:32]
    if not host and (not guest_id or not guest_name):
        return False
    if not host:
        with db() as conn:
            total = conn.execute(
                "SELECT COALESCE(SUM(listener_count), 0) FROM sessions"
            ).fetchone()[0]
        if row["listener_count"] >= MAX_SESSION_LISTENERS or total >= MAX_TOTAL_LISTENERS:
            return False
    join_room(row["id"])
    _connections[request.sid] = {
        "session_id": row["id"],
        "host": host,
        "guest_id": guest_id,
        "guest_name": guest_name,
        "generation": None,
    }
    if host:
        generation = _host_generation.get(row["id"], 0) + 1
        _host_generation[row["id"]] = generation
        _connections[request.sid]["generation"] = generation
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
                ("live" if row["id"] in _programs else "waiting", _now(), row["id"]),
            )
    else:
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET listener_count = listener_count + 1, updated_at = ? WHERE id = ?",
                (_now(), row["id"]),
            )
    refreshed = _session_row(row["id"])
    if refreshed is not None:
        emit("session_snapshot", {"session": _public_session(refreshed)})
        socketio.emit(
            "presence",
            {"session_id": row["id"], "listener_count": refreshed["listener_count"]},
            room=row["id"],
        )


@socketio.on("program_event")
def program_event(payload):
    connection = _connections.get(request.sid)
    if not connection or not connection["host"] or not isinstance(payload, dict):
        return
    session_id = connection["session_id"]
    seq = payload.get("seq")
    if not isinstance(seq, int) or seq < 0:
        return
    previous = _programs.get(session_id)
    if previous and int(previous.get("seq", -1)) >= seq:
        return
    safe = {
        key: payload.get(key)
        for key in ("v", "seq", "emitted_at", "program_time", "transport", "primary", "secondary", "transition")
    }
    _programs[session_id] = safe
    with db() as conn:
        conn.execute("UPDATE sessions SET status = 'live', updated_at = ? WHERE id = ?", (_now(), session_id))
    emit("program_event", safe, room=session_id, include_self=False)


@socketio.on("chat_message")
def chat_message(payload):
    connection = _connections.get(request.sid)
    if not connection or not isinstance(payload, dict):
        return
    text = str(payload.get("text") or "").strip()
    if not text or len(text) > CHAT_MAX:
        return
    row = _session_row(connection["session_id"])
    if row is None:
        return
    if connection["host"]:
        sender = {
            "kind": "host",
            "id": row["community_id"],
            "display_name": row["display_name"],
            "avatar_color": row["avatar_color"],
        }
    else:
        sender = {
            "kind": "guest",
            "id": connection["guest_id"],
            "display_name": connection["guest_name"],
            "avatar_color": None,
        }
    emit(
        "chat_message",
        {
            "id": secrets.token_urlsafe(9),
            "session_id": row["id"],
            "sender": sender,
            "text": text,
            "sent_at": int(time.time() * 1000),
        },
        room=row["id"],
    )


def _expire_host(session_id: str, generation: int) -> None:
    socketio.sleep(RECONNECT_GRACE_SECONDS)
    if _host_generation.get(session_id) != generation:
        return
    row = _session_row(session_id)
    if row is None or row["status"] != "reconnecting":
        return
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    _purge_artwork(session_id)
    _programs.pop(session_id, None)
    socketio.emit("session_ended", {"session_id": session_id}, room=session_id)


@socketio.on("disconnect")
def socket_disconnect():
    connection = _connections.pop(request.sid, None)
    if not connection:
        return
    session_id = connection["session_id"]
    if connection["host"]:
        generation = connection["generation"]
        if generation != _host_generation.get(session_id):
            return
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET status = 'reconnecting', updated_at = ? WHERE id = ?",
                (_now(), session_id),
            )
        socketio.start_background_task(_expire_host, session_id, generation)
    else:
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET listener_count = MAX(0, listener_count - 1), updated_at = ? WHERE id = ?",
                (_now(), session_id),
            )
    row = _session_row(session_id)
    if row is not None:
        socketio.emit(
            "presence",
            {"session_id": session_id, "listener_count": row["listener_count"]},
            room=session_id,
        )


init_db()


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
