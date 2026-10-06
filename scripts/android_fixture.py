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
    parser.add_argument("--audio-format", choices=("wav", "flac"), default="wav")
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

    if os.environ.get("SOUNDSIBLE_ANDROID_LIVE_FIXTURE") == "1":
        # Emulator gateway resolves to host loopback only inside this disposable engine.
        import socket
        resolve = socket.getaddrinfo
        def fixture_resolve(host, *arguments, **keywords):
            return resolve("127.0.0.1" if host == "10.0.2.2" else host, *arguments, **keywords)
        socket.getaddrinfo = fixture_resolve

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
        if args.audio_format == "flac":
            import subprocess
            encoded = audio.with_suffix(".flac")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(audio),
                            "-metadata", "title=" + name + " private song", str(encoded)], check=True)
            audio.unlink()
            audio = encoded
            from shared.audio_files import AudioProcessor
            if not AudioProcessor.embed_artwork(str(audio), str(cover)):
                raise RuntimeError("Could not embed synthetic FLAC cover")
        with user_context(uid):
            # Deterministic playback tests explicitly opt out. Product default
            # remains on; autoplay acceptance enables the real preference.
            from shared.discovery_intelligence import save_discovery_settings
            save_discovery_settings({"autoplay_enabled": False})
            library = get_user_core(uid).library
            library.metadata.add_track(
                Track(
                    id=f"{name}-track",
                    title=f"{name} private song",
                    artist=f"{name} artist",
                    album=f"{name} album",
                    duration=600,
                    file_hash=f"{name}-hash",
                    original_filename=f"fixture.{args.audio_format}",
                    file_size=audio.stat().st_size,
                    bitrate=128,
                    format=args.audio_format,
                    cover_art_key=str(cover),
                    cover_source="local",
                )
            )
            library.metadata.create_playlist(f"{name} playlist")
            library.metadata.playlists[f"{name} playlist"] = [f"{name}-track", f"{name}-track"]
            library._save_metadata()
            from shared.database import instance_db
            instance_db().set_lyrics(f"{name}-track", synced="[00:00.00]" + name + " first line\n[00:20.00]" + name + " second line", source="synthetic-android-fixture")
            from shared.lyrics import metadata_cache_key
            instance_db().set_lyrics(metadata_cache_key(f"{name} artist", f"{name} saved song", None, 600), synced="[00:20.00]Unsafe preview timing", plain=f"{name} preview words", source="synthetic-android-fixture")
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
    from android_acquisition_fixture import install as install_acquisition

    install_acquisition(app, root)
    from android_catalog_fixture import install as install_catalog

    install_catalog(app)
    from android_podcast_fixture import install as install_podcasts

    install_podcasts(app, root, accounts)
    from android_radio_fixture import install as install_radio

    install_radio(app, root, accounts)
    from android_dj_fixture import install as install_dj

    install_dj(app)

    stream_requests = []
    stream_failure = {}
    stream_cut = {}
    stream_delay = {}
    offline_body = {}
    connection_failure = {}
    socket_failure = {"enabled": False, "blocked": 0}
    socket_app = app.wsgi_app

    def socket_network(environ, start_response):
        # Engine.IO handles /socket.io before Flask before_request hooks.
        if socket_failure["enabled"] and environ.get("PATH_INFO", "").startswith("/socket.io"):
            socket_failure["blocked"] += 1
            start_response("503 Service Unavailable", [("Content-Type", "text/plain")])
            return [b"fixture socket unavailable"]
        return socket_app(environ, start_response)

    app.wsgi_app = socket_network
    artwork_mode = {}
    auth_events = []
    discovery_requests = []

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
        if request.path in ("/api/discovery/settings", "/api/discovery/profile"):
            discovery_requests.append({"path": request.path, "method": request.method, "status": response.status_code})
            del discovery_requests[:-100]
        if request.path == "/api/auth/login":
            import time
            auth_events.append({"status": response.status_code, "time": time.time()})
            del auth_events[:-100]
            # Fixture status only: never log submitted credentials or cookies.
            print(f"Android fixture {args.port}: auth_login status={response.status_code}", flush=True)
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

    @app.route("/__fixture/auth-stats")
    def auth_stats():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        return jsonify({"events": auth_events})

    @app.route("/api/android-fixture/slow")
    def slow():
        from shared.hardening import current_user

        account = current_user()
        sleep(2)
        return jsonify({"user": account})

    @app.route("/api/android-fixture/redirect")
    def redirection():
        return redirect("https://example.invalid/must-not-receive-cookie", code=302)

    @app.post("/api/android-fixture/session-expiry")
    def session_expiry():
        # Only in this disposable engine; never imported by the real server.
        data = request.get_json(silent=True) or {}
        seconds = data.get("seconds")
        if (request.remote_addr != "127.0.0.1" or data.get("fixture") != "isolated"
                or not request.cookies.get("sb_session")):
            return jsonify(error="fixture only"), 403
        if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 10:
            return jsonify(error="invalid expiry"), 400
        response = jsonify(ok=True)
        response.set_cookie("sb_session", request.cookies["sb_session"], max_age=seconds,
                            httponly=True, secure=bool(args.tls_cert), samesite="Lax")
        return response

    @app.route("/__fixture/<action>", methods=["POST"])
    def control(action):
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        if action == "reset-auth-limit":
            from shared.hardening import _rate_limiter
            with _rate_limiter._lock:
                _rate_limiter._events.pop(f"auth_login:{request.remote_addr}", None)
            return jsonify({"ok": True})
        if action == "socket-network":
            before = len(socketio.server.eio.sockets)
            data = request.get_json(silent=True) or {}
            if "enabled" in data:
                socket_failure["enabled"] = bool(data["enabled"])
            if data.get("enabled"):
                # Close the Engine.IO transport, not a namespace-level logout.
                # Subsequent handshakes fail until the fixture network recovers.
                for sid, client in list(socketio.server.eio.sockets.items()):
                    socketio.server.eio.sockets.pop(sid, None)
                    client.close(wait=False, abort=True)
            return jsonify(ok=True, clients=len(socketio.server.eio.sockets), before=before, blocked=socket_failure["blocked"])
        if action == "socket-timing":
            fast = bool((request.get_json(silent=True) or {}).get("enabled"))
            socketio.server.eio.ping_interval = 2 if fast else 25
            socketio.server.eio.ping_timeout = 3 if fast else 20
            return jsonify(ok=True)
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
        elif action == "car-collections":
            data = request.get_json() or {}
            enabled = bool(data.get("enabled"))
            with user_context(uid):
                library = get_user_core(uid).library
                prefix = "car-page-fixture-"
                library.metadata.playlists = {key: value for key, value in library.metadata.playlists.items()
                                              if not key.startswith(prefix)}
                library.metadata.podcast_subscriptions = [sub for sub in library.metadata.podcast_subscriptions
                                                          if not sub.get("id", "").startswith(prefix)]
                if enabled:
                    for index in range(405):
                        library.metadata.playlists[f"{prefix}{index}"] = []
                        library.metadata.podcast_subscriptions.append({"id": f"{prefix}{index}", "title": f"Fixture show {index}"})
                library._save_metadata()
            return jsonify(ok=True)
        elif action == "loudness-facts":
            # Measure only synthetic fixture audio with the production R128 meter
            # and store. Native acceptance receives facts through real /api/library.
            from shared.loudness.measure import measure_loudness
            from shared.loudness.store import LoudnessStore, loudness_db_path, source_stamp
            import sqlite3
            data = request.get_json() or {}
            audio = root / "music/tracks" / f"{name}-track.{args.audio_format}"
            store = LoudnessStore()
            store.get(f"{name}-hash")
            if data.get("measured", True):
                measurement = measure_loudness(audio, duration_hint=600)
                if measurement is None:
                    raise RuntimeError("Synthetic tone must have measurable programme loudness")
                store.put(f"{name}-hash", source_stamp(audio), measurement)
                if data.get("album"):
                    from dataclasses import replace
                    import shutil
                    marker = data.get("firstMarker", False)
                    if type(marker) is not bool:
                        raise ValueError("Unsupported isolated PCM marker")
                    first_frequency = data.get("firstFrequency", 440)
                    if type(first_frequency) is not int or first_frequency not in (80, 100, 440):
                        raise ValueError("Unsupported isolated PCM tone")
                    first_duration = data.get("firstDuration", 20)
                    if type(first_duration) is not int or first_duration not in (20, 90):
                        raise ValueError("Unsupported isolated PCM duration")
                    custom = marker or "firstFrequency" in data or "firstDuration" in data
                    soft = root / "music/tracks" / f"{name}-pcm-soft.{'wav' if custom else args.audio_format}"
                    if custom:
                        with wave.open(str(soft), "wb") as output:
                            output.setnchannels(1)
                            output.setsampwidth(2)
                            output.setframerate(16000)
                            tones = ((first_frequency, 4), (1320, first_duration - 4)) if marker else ((first_frequency, first_duration),)
                            for frequency, seconds in tones:
                                tone = b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * frequency * i / 16000))) for i in range(16000))
                                output.writeframes(tone * seconds)
                    else:
                        shutil.copyfile(audio, soft)
                    with user_context(uid):
                        library = get_user_core(uid).library
                        original = next(track for track in library.metadata.tracks if track.id == f"{name}-track")
                        library.metadata.add_track(replace(original, id=f"{name}-pcm-soft", title=f"{name} softer PCM song",
                            album=f"{name} PCM album", file_hash=f"{name}-pcm-soft-hash",
                            duration=first_duration if custom else original.duration, format="wav" if custom else original.format,
                            file_size=soft.stat().st_size, bitrate=256 if custom else original.bitrate,
                            original_filename=soft.name if custom else original.original_filename))
                    soft_measurement = measure_loudness(soft, duration_hint=first_duration) if custom else measurement
                    if soft_measurement is None:
                        raise RuntimeError("Marker synthetic tone must be measurable")
                    store.put(f"{name}-pcm-soft-hash", source_stamp(soft), soft_measurement)
                    second = root / "music/tracks" / f"{name}-pcm-loud.wav"
                    frequency = data.get("secondFrequency", 440)
                    rate = data.get("secondRate", 16000)
                    channels = data.get("secondChannels", 1)
                    if (type(frequency) is not int or frequency not in (440, 880, 1600, 4400)
                            or type(rate) is not int or rate not in (16000, 48000)
                            or type(channels) is not int or channels not in (1, 2)):
                        raise ValueError("Unsupported isolated PCM fixture format")
                    with wave.open(str(second), "wb") as output:
                        output.setnchannels(channels)
                        output.setsampwidth(2)
                        output.setframerate(rate)
                        tone = b"".join(struct.pack("<h", int(9000 * math.sin(2 * math.pi * frequency * i / rate))) * channels for i in range(rate))
                        output.writeframes(tone * 60)
                    second_format = data.get("secondFormat", "wav")
                    if second_format not in ("wav", "flac"):
                        raise ValueError("Unsupported isolated PCM encoding")
                    if second_format == "flac":
                        import subprocess
                        encoded = second.with_suffix(".flac")
                        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(second), str(encoded)], check=True)
                        second.unlink()
                        second = encoded
                    with user_context(uid):
                        library = get_user_core(uid).library
                        library.metadata.add_track(Track(id=f"{name}-pcm-loud", title=f"{name} louder PCM song", artist=f"{name} artist",
                            album=f"{name} PCM album", duration=60, file_hash=f"{name}-pcm-loud-hash", original_filename=f"pcm-loud.{second_format}",
                            file_size=second.stat().st_size, bitrate=rate * channels * 16 // 1000, format=second_format))
                        library._save_metadata()
                    measured_second = measure_loudness(second, duration_hint=60)
                    if measured_second is None:
                        raise RuntimeError("Second synthetic tone must be measurable")
                    store.put(f"{name}-pcm-loud-hash", source_stamp(second), measured_second)
            else:
                # Explicitly remove fixture facts to exercise the unmeasured path.
                # The root was created exclusively for this runner; no personal cache.
                with sqlite3.connect(loudness_db_path()) as database:
                    database.execute("DELETE FROM track_loudness WHERE identity IN (?, ?, ?)", (f"{name}-hash", f"{name}-pcm-soft-hash", f"{name}-pcm-loud-hash"))
            emit_to_user("library_updated", user_id=uid)
            return jsonify({"ok": True, "measured": bool(data.get("measured", True))})
        elif action == "discovery-state":
            from shared.database import user_db
            from shared.discovery_intelligence import load_discovery_settings
            with user_context(uid):
                return jsonify({"settings": load_discovery_settings(),
                                "signals": len(user_db().get_discovery_signals()),
                                "events": len(user_db().get_discovery_events()),
                                "requests": discovery_requests})
        elif action == "discovery-seed":
            from shared.discovery_intelligence import record_not_interested
            with user_context(uid):
                return jsonify({"recorded": bool(record_not_interested({"id": "fixture-learning-song", "type": "track",
                    "source": "youtube", "title": "fixture learning song", "artist": "fixture learning artist",
                    "external_ids": {"youtube_id": "F1111111111"}}))})
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
