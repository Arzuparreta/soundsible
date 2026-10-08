"""Disposable synthetic provider bytes; the actual downloader pipeline and queue remain real."""


def install(app, root):
    from pathlib import Path
    import threading
    import time
    import uuid

    from flask import jsonify, request
    from shared.downloader.youtube_downloader import YouTubeDownloader
    from shared.downloader.youtube.ids import video_id_from_url

    lock = threading.Lock()
    # `hold` keeps a started download running until the test lets it go, so a
    # test can see the running state however slowly the runner renders it.
    control = {"fail_next": 0, "delay": 2.0, "hold": False, "attempts": 0, "active": 0}

    @app.route("/__fixture/acquisition", methods=["GET", "POST"])
    def acquisition_control():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        with lock:
            if request.method == "POST":
                payload = request.get_json(silent=True) or {}
                control["fail_next"] = max(0, min(5, int(payload.get("failNext", 0))))
                control["delay"] = max(0, min(5, float(payload.get("delaySeconds", 2))))
                control["hold"] = bool(payload.get("hold", False))
            return jsonify(control)

    def synthetic_audio(self, url, progress_callback=None):
        identity = video_id_from_url(url)
        if identity not in {"A1111111111", "B1111111111", "C1111111111", "D1111111111", "E1111111111"}:
            raise RuntimeError("Synthetic acquisition provider only")
        with lock:
            control["attempts"] += 1
            fail = control["fail_next"] > 0
            if fail:
                control["fail_next"] -= 1
            delay = control["delay"]
            control["active"] += 1
        suffix = "webm" if identity == "C1111111111" else "mp4"
        source = Path(root) / f"preview.{suffix}"
        target = self.temp_dir / f"synthetic-{uuid.uuid4().hex}.{suffix}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        try:
            if fail:
                raise RuntimeError("Synthetic acquisition failure; retry remains a real queue action")
            released_by = time.monotonic() + 60
            while time.monotonic() < released_by:
                with lock:
                    if not control["hold"]:
                        break
                time.sleep(0.05)
            total = source.stat().st_size
            with source.open("rb") as input_file, target.open("wb") as output:
                done = 0
                while chunk := input_file.read(max(1, (total + 7) // 8)):
                    output.write(chunk)
                    done += len(chunk)
                    if progress_callback:
                        progress_callback({"phase": "downloading", "percent": done * 90 / total, "total_bytes": total})
                    time.sleep(delay / 8)
            return target
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        finally:
            with lock:
                control["active"] -= 1

    # Replace only acquisition of remote provider bytes. process_video, tags,
    # AudioProcessor/store_track, hash, queue checkpoint and library commit run normally.
    YouTubeDownloader._download_audio = synthetic_audio
