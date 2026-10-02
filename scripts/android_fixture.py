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
    from PIL import Image
    from shared.artwork import artwork_store

    for name, uid in accounts.items():
        cover = root / f"{name}-cover.png"
        Image.new("RGB", (64, 64), "#c53030" if name == "member" else "#2845b4").save(cover)
        with user_context(uid):
            library = get_user_core(uid).library
            library.metadata.add_track(
                Track(
                    id=f"{name}-track",
                    title=f"{name} private song",
                    artist=f"{name} artist",
                    album=f"{name} album",
                    duration=60,
                    file_hash=f"{name}-hash",
                    original_filename="fixture.mp3",
                    file_size=0,
                    bitrate=128,
                    format="mp3",
                    cover_art_key=str(cover),
                    cover_source="local",
                )
            )
            library.metadata.create_playlist(f"{name} playlist")
            library.metadata.playlists[f"{name} playlist"] = [f"{name}-track"]
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
        if action == "revoke":
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
