#!/usr/bin/env python3
"""Disposable REAL engine for Android integration. Never points at user data.

Run in its own process: PYTHONPATH=. .venv/bin/python scripts/android_fixture.py
  --root /tmp/android-fixture-unique --port 5097 [--passwordless]
Synthetic accounts/password: owner / android-test; member / android-test.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--passwordless", action="store_true")
    parser.add_argument("--run-id", default="manual-fixture")
    parser.add_argument("--tls-cert", type=Path)
    parser.add_argument("--tls-key", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    # A new directory is mandatory. An accidental developer directory is refused.
    root.mkdir(parents=True, exist_ok=False)
    for key, folder in {
        "SOUNDSIBLE_CONFIG_DIR": "config",
        "SOUNDSIBLE_DATA_DIR": "data",
        "SOUNDSIBLE_CACHE_DIR": "cache",
        "SOUNDSIBLE_LOG_DIR": "logs",
        "SOUNDSIBLE_MUSIC_DIR": "music",
        "OUTPUT_DIR": "music",
    }.items():
        path = root / folder
        path.mkdir(exist_ok=True)
        os.environ[key] = str(path)
    os.environ["SOUNDSIBLE_ADVANCED_MODE"] = "true"
    os.environ["SOUNDSIBLE_HOST"] = "127.0.0.1"
    os.environ["SOUNDSIBLE_PORT"] = str(args.port)
    os.environ.pop("SOUNDSIBLE_ADMIN_TOKEN", None)
    os.environ.pop("SOUNDSIBLE_OWNER_TOKEN_FILE", None)

    from flask import jsonify, request, redirect
    from gevent import sleep
    from shared.runtime import RuntimeConfig, configure_runtime

    configure_runtime(RuntimeConfig.default())
    from shared.multiuser_migration import ensure_multiuser_layout
    from shared.users import create_user, set_password, revoke_user_sessions
    from shared.api import app, socketio, get_user_core, emit_to_user
    from shared.models import Track
    from shared.user_context import user_context

    owner = ensure_multiuser_layout()["user_id"]
    accounts = {"owner": owner}
    if not args.passwordless:
        set_password(owner, "android-test")
        accounts["member"] = create_user("member", password="android-test")["id"]
    import math
    import struct
    import wave

    from PIL import Image
    from shared.artwork import artwork_store

    for name, uid in accounts.items():
        cover = root / f"{name}-cover.png"
        Image.new("RGB", (64, 64), "#c53030" if name == "member" else "#2845b4").save(cover)
        audio = root / "music/tracks" / f"{name}-track.wav"
        audio.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(
                b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000))
                * 600
            )
        with user_context(uid):
            library = get_user_core(uid).library
            library.metadata.add_track(
                Track(
                    id=f"{name}-track",
                    title=f"{name} private song",
                    artist=f"{name} artist",
                    album=f"{name} album",
                    duration=600,
                    file_hash=f"{name}-hash",
                    original_filename="fixture.wav",
                    file_size=audio.stat().st_size,
                    bitrate=128,
                    format="wav",
                    cover_art_key=str(cover),
                    cover_source="local",
                )
            )
            library.metadata.create_playlist(f"{name} playlist")
            library.metadata.playlists[f"{name} playlist"] = [f"{name}-track", f"{name}-track"]
            library._save_metadata()
            store = artwork_store()
            store.bind(f"{name}-track", store.put(cover.read_bytes()), "manual")
            get_user_core(uid).favourites.toggle_saved(
                {
                    "keys": ["yt:" + ("A1111111111" if name == "owner" else "B1111111111")],
                    "title": f"{name} saved song",
                    "artist": f"{name} artist",
                    "thumbnail": f"/api/static/cover/{name}-track?size=thumb",
                }
            )

    from android_preview_fixture import install

    install(app, root)
    from android_catalog_fixture import install as install_catalog

    install_catalog(app)

    stream_requests = []
    stream_failure = {}
    stream_cut = {}
    stream_delay = {}
    offline_body = {}
    connection_failure = {}
    artwork_mode = {}

    @app.before_request
    def audio_failure():
        if connection_failure.get("enabled") and request.path.startswith("/api/"):
            return jsonify({"error": "fixture API failure"}), connection_failure.get("status", 503)
        if request.path.startswith("/api/static/cover/"):
            name = request.path.rsplit("/", 1)[-1].split("-", 1)[0]
            if artwork_mode.get(name) == "slow":
                sleep(2)
        if request.path.startswith("/api/static/stream/"):
            name = request.path.rsplit("/", 1)[-1].split("-", 1)[0]
            mode = offline_body.get(name)
            if mode == "oversize":
                return app.response_class(
                    b"not audio",
                    status=200,
                    headers={"Content-Length": str(600 * 1024 * 1024)},
                    content_type="audio/wav",
                )
            if mode == "invalid":
                return app.response_class(b"not audio", status=200, content_type="audio/wav")
            if stream_delay.get(name):
                sleep(5)
            if stream_failure.get(name):
                return jsonify({"error": "synthetic audio failure"}), stream_failure[name]

    @app.after_request
    def record_range(response):
        if request.path.startswith("/api/static/cover/") and response.status_code == 200:
            name = request.path.rsplit("/", 1)[-1].split("-", 1)[0]
            mode = artwork_mode.get(name)
            if mode == "missing":
                return app.response_class(b"", status=404)
            if mode == "invalid":
                return app.response_class(b"not an image", mimetype="image/png")
            if mode == "large":
                return app.response_class(b"x" * (2 * 1024 * 1024 + 1), mimetype="image/png")
        if request.path.startswith("/api/static/stream/"):
            name = request.path.rsplit("/", 1)[-1].split("-", 1)[0]
            if offline_body.get(name) == "oversize":
                response.headers["Content-Length"] = str(600 * 1024 * 1024)
            stream_requests.append(
                {"path": request.path, "range": request.headers.get("Range"), "status": response.status_code}
            )
            name = request.path.rsplit("/", 1)[-1].split("-", 1)[0]
            if stream_cut.get(name) and response.status_code in (200, 206):
                original = response.response

                def cut_body():
                    try:
                        for chunk in original:
                            yield chunk[:1024]
                            raise RuntimeError("fixture stream cut after headers")
                    finally:
                        if hasattr(original, "close"):
                            original.close()

                response.direct_passthrough = False
                response.response = cut_body()
        return response

    @app.route("/api/android-fixture/audio-stats")
    def audio_stats():
        return jsonify({"requests": stream_requests[-100:], "total": len(stream_requests)})

    @app.route(f"/__fixture/ready/{args.run_id}")
    def ready():
        return jsonify({"fixture": args.run_id})

    @app.route("/api/android-fixture/slow")
    def slow():
        from shared.hardening import current_user

        account = current_user()
        sleep(2)
        return jsonify({"user": account})

    @app.route("/api/android-fixture/redirect")
    def redirection():
        return redirect("https://example.invalid/must-not-receive-cookie", code=302)

    @app.route("/__fixture/<action>", methods=["POST"])
    def control(action):
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        name = (request.get_json(silent=True) or {}).get("account", "member")
        uid = accounts[name]
        if action == "artwork":
            artwork_mode[name] = (request.get_json() or {}).get("mode", "")
        elif action == "audio-failure":
            stream_failure[name] = int((request.get_json() or {}).get("status", 0))
        elif action == "offline-body":
            offline_body[name] = (request.get_json() or {}).get("mode", "")
        elif action == "stream-delay":
            stream_delay[name] = bool((request.get_json() or {}).get("enabled"))
        elif action == "stream-cut":
            stream_cut[name] = bool((request.get_json() or {}).get("enabled"))
        elif action == "connection-failure":
            connection_failure["enabled"] = bool((request.get_json() or {}).get("enabled"))
            connection_failure["status"] = int((request.get_json() or {}).get("status", 503))
        elif action == "revoke":
            revoke_user_sessions(uid)
        elif action == "event":
            emit_to_user("library_updated", user_id=uid)
        elif action == "append":
            with user_context(uid):
                library = get_user_core(uid).library
                library.metadata.add_track(
                    Track(
                        id=f"{name}-second",
                        title=f"{name} event song",
                        artist=f"{name} artist",
                        album=f"{name} album",
                        duration=60,
                        file_hash=f"{name}-second-hash",
                        original_filename="fixture2.mp3",
                        file_size=0,
                        bitrate=128,
                        format="mp3",
                    )
                )
                library._save_metadata()
            emit_to_user("library_updated", user_id=uid)
        else:
            return jsonify({"error": "unknown action"}), 400
        return jsonify({"ok": True})

    tls = {"certfile": str(args.tls_cert), "keyfile": str(args.tls_key)} if args.tls_cert and args.tls_key else {}
    socketio.run(app, host="127.0.0.1", port=args.port, log_output=False, **tls)


if __name__ == "__main__":
    main()
