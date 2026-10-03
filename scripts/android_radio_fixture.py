"""Synthetic acquired music for the real NORMAL recommendation planner."""


def install(app, root, accounts):
    from dataclasses import replace
    from pathlib import Path
    import shutil

    from flask import jsonify, request
    from shared.api import get_user_core
    from shared.user_context import user_context

    control = {"fail_next": 0, "calls": 0}

    @app.before_request
    def fail_plan():
        if request.path != "/api/discovery/music/plan":
            return None
        control["calls"] += 1
        if control["fail_next"] > 0:
            control["fail_next"] -= 1
            return jsonify(error="temporary fixture planner failure"), 503
        return None

    @app.get("/__fixture/radio-stats")
    def radio_stats():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        return jsonify(control)

    @app.post("/__fixture/radio-seed")
    def radio_seed():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        control["fail_next"] = min(5, max(0, int((request.get_json(silent=True) or {}).get("failNext", 0))))
        control["calls"] = 0
        for name, uid in accounts.items():
            with user_context(uid):
                library = get_user_core(uid).library
                original = next(row for row in library.metadata.tracks if row.id == f"{name}-track")
                for index in range(10):
                    identity = f"{name}-radio-{index}"
                    target = Path(root) / "music/tracks" / f"{identity}.wav"
                    shutil.copyfile(Path(root) / "music/tracks" / f"{name}-track.wav", target)
                    library.metadata.add_track(
                        replace(original, id=identity, title=f"{name} radio song {index}", file_hash=identity)
                    )
                library._save_metadata()
        return jsonify(ok=True)
