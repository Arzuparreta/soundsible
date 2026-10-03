"""Disposable podcast provider edge. RSS/token/proxy/account routes remain real."""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def install(app, root: Path, accounts):
    from flask import jsonify, request
    import requests
    from shared.api import get_user_core
    from shared.user_context import user_context, require_user_id
    from shared.models import Track

    external = "https://podcasts.fixture.example"
    audio = (root / "preview.mp4").read_bytes()
    records = []
    controls = {"peek_status": 0}
    peek_requests = []
    feeds = {}
    for name, uid in accounts.items():
        url = f"{external}/{name}/feed.xml"
        feeds[f"/{name}/feed.xml"] = (
            f'''<?xml version="1.0"?><rss version="2.0"><channel><title>{name} fixture podcast</title><link>{external}</link><description>synthetic</description><item><guid>{name}-episode-guid</guid><title>{name} fixture episode</title><enclosure url="{external}/{name}/episode.mp4" type="audio/mp4" length="{len(audio)}"/></item></channel></rss>'''.encode()
        )
        with user_context(uid):
            library = get_user_core(uid).library
            library.metadata.podcast_subscriptions.append(
                {"id": f"{name}-feed", "title": f"{name} fixture podcast", "rss_url": url}
            )
            library._save_metadata()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            records.append(
                {
                    "path": self.path,
                    "range": self.headers.get("Range"),
                    "cookie_present": bool(self.headers.get("Cookie")),
                }
            )
            if self.path in feeds:
                data = feeds[self.path]
                self.send_response(200)
                self.send_header("Content-Type", "application/rss+xml")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if self.path not in [f"/{name}/episode.mp4" for name in accounts]:
                self.send_error(404)
                return
            start, end = 0, len(audio) - 1
            value = self.headers.get("Range")
            if value:
                assert value.startswith("bytes=") and "," not in value
                left, right = value[6:].split("-", 1)
                if left:
                    start = int(left)
                    end = min(end, int(right)) if right else end
                else:
                    start = max(0, len(audio) - int(right))
                if start >= len(audio) or end < start:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(audio)}")
                    self.end_headers()
                    return
            self.send_response(206 if value else 200)
            self.send_header("Content-Type", "audio/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if value:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(audio)}")
            self.end_headers()
            try:
                for offset in range(start, end + 1, 65536):
                    self.wfile.write(audio[offset : min(offset + 65536, end + 1)])
            except (BrokenPipeError, ConnectionResetError):
                pass

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    upstream_get = requests.get

    def get(url, **kwargs):
        if isinstance(url, str) and url.startswith(external + "/"):
            url = f"http://127.0.0.1:{provider.server_port}" + url[len(external) :]
        return upstream_get(url, **kwargs)

    # The sole external I/O edge is redirected; validation still sees a public URL.
    requests.get = get

    @app.before_request
    def podcast_failure():
        if request.path == "/api/podcasts/enclosure/peek":
            peek_requests.append({"status": controls["peek_status"]})
            if controls["peek_status"]:
                return jsonify({"error": "synthetic podcast preparation failure"}), controls["peek_status"]

    @app.route("/__fixture/podcast", methods=["POST"])
    def podcast_control():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        body = request.get_json() or {}
        if "peek_status" in body:
            controls["peek_status"] = int(body["peek_status"])
        if body.get("acquire_episode"):
            uid = require_user_id()
            name = next(name for name, value in accounts.items() if value == uid)
            library = get_user_core(uid).library
            track_id = f"{name}-podcast-acquired"
            path = root / "music/tracks" / (track_id + ".m4a")
            path.write_bytes(audio)
            library.metadata.add_track(
                Track(
                    id=track_id,
                    title=f"{name} fixture episode",
                    artist=f"{name} fixture podcast",
                    album="Fixture podcasts",
                    duration=600,
                    file_hash=track_id,
                    original_filename="fixture-podcast.m4a",
                    file_size=len(audio),
                    bitrate=192,
                    format="m4a",
                    media_kind="podcast_episode",
                    podcast_feed_id=f"{name}-feed",
                    podcast_episode_guid=f"{name}-episode-guid",
                    podcast_rss_url=f"{external}/{name}/feed.xml",
                )
            )
            library._save_metadata()
        return jsonify(controls)

    @app.route("/api/android-fixture/podcast-stats")
    def podcast_stats():
        return jsonify({"upstream": records, "peek_requests": peek_requests})
