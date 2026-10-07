"""Synthetic acquired music for the real NORMAL recommendation planner."""


def install(app, root, accounts):
    from dataclasses import replace
    from pathlib import Path
    import shutil
    import threading

    from flask import jsonify, request
    from gevent import sleep
    from shared.api import get_user_core
    from shared.user_context import user_context

    control = {"fail_next": 0, "calls": 0, "delay_next": 0.0, "pending": 0, "delivered": 0, "delayed_ids": []}
    lock = threading.Lock()

    @app.before_request
    def fail_plan():
        if request.path != "/api/discovery/music/plan":
            return None
        with lock:
            control["calls"] += 1
            if control["fail_next"] > 0:
                control["fail_next"] -= 1
                return jsonify(error="temporary fixture planner failure"), 503
        return None

    @app.after_request
    def delay_computed_plan(response):
        if request.path != "/api/discovery/music/plan" or response.status_code != 200:
            return response
        with lock:
            delay = control["delay_next"]
            control["delay_next"] = 0.0
            if not delay:
                return response
            # Capture IDs only, after the production planner has computed its body.
            rows = (response.get_json(silent=True) or {}).get("items", [])
            control["delayed_ids"] = [
                row.get("track_id") or row.get("id") for row in rows[:8] if row.get("source") == "library"
            ]
            control["pending"] += 1
        try:
            sleep(delay)
        finally:
            with lock:
                control["pending"] -= 1
                control["delivered"] += 1
        return response

    @app.post("/__fixture/radio-delay")
    def radio_delay():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        value = (request.get_json(silent=True) or {}).get("seconds", 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 15:
            return jsonify(error="delay must be between zero and fifteen seconds"), 400
        with lock:
            control["delay_next"] = float(value)
        return jsonify(ok=True)

    @app.get("/__fixture/radio-stats")
    def radio_stats():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        with lock:
            return jsonify(control)

    @app.post("/__fixture/radio-seed")
    def radio_seed():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        data = request.get_json(silent=True) or {}
        with lock:
            control["fail_next"] = min(5, max(0, int((request.get_json(silent=True) or {}).get("failNext", 0))))
            control["calls"] = 0
        for name, uid in accounts.items():
            with user_context(uid):
                library = get_user_core(uid).library
                original = next(row for row in library.metadata.tracks if row.id == f"{name}-track")
                measurement = None
                if data.get("measured"):
                    from shared.loudness.measure import measure_loudness
                    measurement = measure_loudness(Path(root) / "music/tracks" / f"{name}-track.{original.format}", duration_hint=original.duration)
                    if measurement is None:
                        raise RuntimeError("Synthetic radio source must be measurable")
                for index in range(10):
                    identity = f"{name}-radio-{index}"
                    target = Path(root) / "music/tracks" / f"{identity}.{original.format}"
                    shutil.copyfile(Path(root) / "music/tracks" / f"{name}-track.{original.format}", target)
                    library.metadata.add_track(
                        replace(original, id=identity, title=f"{name} radio song {index}", file_hash=identity)
                    )
                    if measurement is not None:
                        from shared.loudness.store import LoudnessStore, source_stamp
                        LoudnessStore().put(identity, source_stamp(target), measurement)
                library._save_metadata()
        return jsonify(ok=True)
