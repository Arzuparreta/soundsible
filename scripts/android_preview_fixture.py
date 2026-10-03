"""Synthetic local provider for the disposable Android engine; production routes/cache stay real."""

from __future__ import annotations

import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def install(app, root: Path):
    from flask import jsonify, request
    from shared.api.routes import playback
    from shared.ffmpeg_runtime import ffmpeg_executable
    from shared.stream_resolution import resolved_stream

    samples = {}
    for suffix, codec, duration in (("mp4", "aac", 600), ("webm", "libopus", 60)):
        path = root / f"preview.{suffix}"
        command = [
            ffmpeg_executable(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=660:duration={duration}",
            "-c:a",
            codec,
        ]
        if suffix == "mp4":
            command += ["-b:a", "192k", "-movflags", "+faststart"]
        subprocess.run([*command, "-y", str(path)], check=True, timeout=30)
        samples[suffix] = path.read_bytes()
    fragmented = root / "fragmented.mp4"
    subprocess.run(
        [
            ffmpeg_executable(),
            "-v",
            "error",
            "-i",
            str(root / "preview.mp4"),
            "-c:a",
            "copy",
            "-movflags",
            "frag_keyframe+empty_moov",
            "-frag_duration",
            "1000000",
            "-y",
            str(fragmented),
        ],
        check=True,
        timeout=10,
    )
    samples["fragmented.mp4"] = fragmented.read_bytes()
    records = []
    controls = {"status": 0, "failures": 0, "retry_after": "1", "slow": False, "cut": False}
    ids = {
        "A1111111111": "mp4",
        "B1111111111": "mp4",
        "C1111111111": "webm",
        "D1111111111": "mp4",
        "E1111111111": "fragmented.mp4",
    }

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            suffix = self.path.split("?", 1)[0].lstrip("/")
            if suffix not in samples:
                self.send_error(404)
                return
            records.append(
                {
                    "range": self.headers.get("Range"),
                    "cookie_present": bool(self.headers.get("Cookie")),
                    "format": suffix,
                }
            )
            data = samples[suffix]
            self.send_response(206)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Range", f"bytes 0-{len(data) - 1}/{len(data)}")
            self.send_header("Content-Type", "audio/webm" if suffix == "webm" else "audio/mp4")
            self.end_headers()
            try:
                for offset in range(0, len(data), 65536):
                    self.wfile.write(data[offset : offset + 65536])
                    self.wfile.flush()
                    if controls["slow"]:
                        time.sleep(0.15)
            except (BrokenPipeError, ConnectionResetError):
                pass

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()

    def resolve(_api, video_id, **_kwargs):
        suffix = ids.get(video_id)
        if not suffix:
            return None  # Never fall through to a live provider.
        duration = 60 if suffix == "webm" else 600
        mime = "audio%2Fwebm" if suffix == "webm" else "audio%2Fmp4"
        return resolved_stream(
            f"http://127.0.0.1:{provider.server_port}/{suffix}?clen={len(samples[suffix])}&dur={duration}&mime={mime}",
            egress="direct",
        )

    playback._get_preview_stream_cached = resolve
    requests = []

    @app.before_request
    def preview_failure():
        if request.path.startswith("/api/preview/stream/"):
            if controls["status"] and controls["failures"] != 0:
                if controls["failures"] > 0:
                    controls["failures"] -= 1
                return (
                    jsonify({"error": "synthetic preview failure"}),
                    controls["status"],
                    {"Retry-After": controls["retry_after"]},
                )

    @app.after_request
    def preview_record(response):
        if request.path.startswith("/api/preview/stream/"):
            requests.append(
                {
                    "status": response.status_code,
                    "range": request.headers.get("Range"),
                    "cache": response.headers.get("X-Soundsible-Playback-Cache"),
                }
            )
            if controls["cut"] and response.status_code in (200, 206):
                original = response.response

                def cut_body():
                    try:
                        for chunk in original:
                            yield chunk[:1024]
                            raise RuntimeError("fixture preview cut after headers")
                    finally:
                        if hasattr(original, "close"):
                            original.close()

                response.direct_passthrough = False
                response.response = cut_body()
        return response

    @app.route("/api/android-fixture/preview-stats")
    def preview_stats():
        from shared import preview_cache

        with preview_cache._fills_lock:
            readers = {video_id: state.readers for video_id, state in preview_cache._fills.items()}
        return jsonify({"upstream": records, "requests": requests, "readers": readers})

    @app.route("/__fixture/preview", methods=["POST"])
    def preview_control():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        body = request.get_json() or {}
        for key in controls:
            if key in body:
                controls[key] = body[key]
        if body.get("clear_stats"):
            records.clear()
            requests.clear()
        return jsonify(json.loads(json.dumps(controls)))
