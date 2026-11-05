"""Bounded failures/delays around real Core DJ placement for native acceptance."""


def install(app, root=None):
    import math
    import threading

    from flask import g, jsonify, request
    from gevent import sleep

    state = {"fail_next": 0, "delay_next": 0.0, "calls": 0, "pending": 0}
    lock = threading.Lock()
    install_network(app)
    install_refinement(app)
    if root is not None:
        install_shared_tempo(app, root)

    @app.before_request
    def intercept_placement():
        if request.path != "/api/discovery/music/dj-place" or request.method != "POST":
            return None
        with lock:
            state["calls"] += 1
            if state["fail_next"]:
                state["fail_next"] -= 1
                return jsonify(error="synthetic placement failure"), 503
            g.android_dj_delay = state["delay_next"]
            state["delay_next"] = 0.0
            if g.android_dj_delay:
                state["pending"] += 1
        return None

    @app.after_request
    def delay_placement(response):
        delay = getattr(g, "android_dj_delay", 0.0)
        if delay:
            try:
                sleep(delay)
            finally:
                with lock:
                    state["pending"] -= 1
        return response

    @app.route("/__fixture/dj-editor", methods=["POST"])
    def configure():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        body = request.get_json(silent=True) or {}
        delay = float(body.get("delaySeconds", 0))
        failures = int(body.get("failNext", 0))
        if not math.isfinite(delay) or not 0 <= delay <= 5 or not 0 <= failures <= 5:
            return jsonify(error="invalid bounded fixture control"), 400
        with lock:
            state["fail_next"] = failures
            state["delay_next"] = delay
            return jsonify(state)

"""One-shot body stalls for synthetic DJ sources; retain real authenticated streaming."""


def install_network(app):
    import re
    import threading
    import time
    from flask import jsonify, request
    from gevent import sleep

    lock = threading.Lock()
    stalls = {}
    stats = {"waits": 0, "pending": 0}

    @app.route('/__fixture/dj-network', methods=['GET', 'POST'])
    def configure_network():
        if request.remote_addr != '127.0.0.1' or request.headers.get('X-Android-Fixture') != 'isolated':
            return jsonify(error='fixture only'), 403
        if request.method == 'GET':
            with lock:
                return jsonify(stats)
        body = request.get_json(silent=True) or {}
        track = body.get('track', '')
        after = body.get('afterBytes', 0)
        delay = body.get('delaySeconds', 0)
        if track not in ('member-pcm-soft', 'member-pcm-loud') or type(after) is not int or type(delay) is not int or not 0 <= after <= 600000 or not 0 <= delay <= 25:
            return jsonify(error='invalid bounded network control'), 400
        with lock:
            if delay:
                stalls[track] = {"after": after, "duration": delay, "deadline": None}
                stats["waits"] = 0
            else:
                stalls.pop(track, None)
        return jsonify(ok=True)

    @app.after_request
    def stall_source_body(response):
        if not request.path.startswith('/api/static/stream/') or response.status_code not in (200, 206):
            return response
        track = request.path.rsplit('/', 1)[-1]
        with lock:
            stall = stalls.get(track)
            if stall is not None and stall["deadline"] is not None and stall["deadline"] <= time.monotonic():
                stalls.pop(track, None)
                stall = None
        if stall is None:
            return response
        original = response.response
        match = re.match(r"bytes (\d+)-", response.headers.get('Content-Range', ''))
        start = int(match.group(1)) if match else 0

        def body():
            sent = start
            waited = False
            try:
                for chunk in original:
                    if not waited and sent + len(chunk) >= stall["after"]:
                        boundary = max(0, stall["after"] - sent)
                        if boundary:
                            yield chunk[:boundary]
                        with lock:
                            if stall["deadline"] is None:
                                stall["deadline"] = time.monotonic() + stall["duration"]
                            remaining = max(0, stall["deadline"] - time.monotonic())
                            if remaining:
                                stats["waits"] += 1
                                stats["pending"] += 1
                        if remaining:
                            try:
                                sleep(remaining)
                            finally:
                                with lock:
                                    stats["pending"] -= 1
                        waited = True
                        yield chunk[boundary:]
                    else:
                        yield chunk
                    sent += len(chunk)
            finally:
                if hasattr(original, 'close'):
                    original.close()

        response.direct_passthrough = False
        response.response = body()
        return response


def install_refinement(app):
    """Controlled pending measurements for the native HTTP retry contract."""
    import threading
    from flask import jsonify, request

    lock = threading.Lock()
    state = {"active": False, "calls": 0, "pending": 0}

    @app.route("/__fixture/dj-refinement", methods=["GET", "POST"])
    def refinement_control():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        with lock:
            if request.method == "POST":
                body = request.get_json(silent=True) or {}
                pending = body.get("pending", 0)
                if type(pending) is not int or not 0 <= pending <= 3:
                    return jsonify(error="invalid bounded refinement control"), 400
                state.update(active=bool(body.get("active", True)), calls=0, pending=pending)
            return jsonify(state)

    def transition(ready):
        return {"technique": "structural_fade" if ready else "safe_fade", "out_cue": 60,
                "in_cue": 0, "overlap_seconds": 6, "overlap_bars": 0, "playback_rate": 1,
                "confidence": 0.9 if ready else 0.18}

    @app.before_request
    def pending_refinement():
        if request.path != "/api/discovery/music/dj-transition" or request.method != "POST":
            return None
        body = request.get_json(silent=True) or {}
        if body.get("from", {}).get("id") != "member-pcm-soft":
            return None
        with lock:
            if not state["active"]:
                return None
            state["calls"] += 1
            ready = state["calls"] > state["pending"]
        return jsonify(measured=ready, transition=transition(ready))

    @app.after_request
    def cold_plan(response):
        if request.path != "/api/discovery/music/dj-plan" or response.status_code != 200:
            return response
        with lock:
            active = state["active"]
        body = request.get_json(silent=True) or {}
        if active and body.get("seed", {}).get("id") == "member-pcm-soft":
            result = response.get_json()
            for row in result.get("items", []):
                row["transition"] = transition(False)
            response.set_data(app.json.dumps(result))
        return response


# Outgoing and incoming PCM fixture songs become click tracks at 120 and
# 132 BPM: they meet at 125.71 BPM, each deck 4.76 % from normal speed,
# beyond what the incoming deck alone may stretch (9.1 %).
SHARED_TEMPO = {"out_bpm": 120, "in_bpm": 132, "first": 0.25, "out_tone": 1000, "in_tone": 3000}
# The same clicks with the incoming deck alone moving (as before shared tempo).
ONE_DECK_BPM = 126


def shared_tempo_plan(split=True):
    """The plan the engine sends a split client for this pair (shared/dj/timing.py)."""
    in_bpm = SHARED_TEMPO["in_bpm"] if split else ONE_DECK_BPM
    out_beat, in_beat = 60 / SHARED_TEMPO["out_bpm"], 60 / in_bpm
    relation = SHARED_TEMPO["out_bpm"] / in_bpm
    return {"technique": "bass_swap", "out_cue": SHARED_TEMPO["first"] + 48 * out_beat,
            "in_cue": round(SHARED_TEMPO["first"] + 4 * in_beat, 6), "overlap_seconds": 8, "overlap_bars": 4,
            "playback_rate": round(relation, 6), "out_playback_rate": round(2 / (1 + relation), 6) if split else 1.0,
            **({"out_rate_ramp": {"lead_seconds": 15.0, "seconds": 8.0}} if split else {}),
            "confidence": 0.9, "score": 0.8, "fallback": False,
            "sync": {"phase_tolerance_ms": 5, "out_period": out_beat, "in_period": in_beat}}


def write_clicks(path, bpm, tone):
    """Rewrite a fixture WAV in its own format: a quiet bed and 4 ms tone kicks."""
    import math
    import struct
    import wave

    with wave.open(str(path), "rb") as source:
        rate, channels, frames = source.getframerate(), source.getnchannels(), source.getnframes()
    samples = [int(300 * math.sin(2 * math.pi * tone / 8 * i / rate)) for i in range(frames)]
    burst = round(0.004 * rate)
    beat = SHARED_TEMPO["first"]
    while beat < frames / rate - 0.1:
        start = round(beat * rate)
        for i in range(burst):
            window = math.sin(math.pi * i / burst) ** 2
            samples[start + i] = int(16000 * window * math.sin(2 * math.pi * tone * i / rate))
        beat += 60 / bpm
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"".join(struct.pack("<h", value) * channels for value in samples))


def install_shared_tempo(app, root):
    import threading
    from pathlib import Path

    from flask import jsonify, request

    lock = threading.Lock()
    state = {"active": False, "split": True, "split_requests": 0, "other_requests": 0, "plans": []}
    tracks = Path(root) / "music/tracks"

    @app.route("/__fixture/dj-shared-tempo", methods=["GET", "POST"])
    def shared_tempo_control():
        if request.remote_addr != "127.0.0.1" or request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify(error="fixture only"), 403
        with lock:
            if request.method == "POST":
                body = request.get_json(silent=True) or {}
                active, split = bool(body.get("active", True)), body.get("split", True)
                if type(split) is not bool:
                    return jsonify(error="invalid shared-tempo control"), 400
                if active:
                    # The PCM album must already exist (loudness-facts).
                    write_clicks(tracks / "member-pcm-soft.wav", SHARED_TEMPO["out_bpm"], SHARED_TEMPO["out_tone"])
                    write_clicks(tracks / "member-pcm-loud.wav", SHARED_TEMPO["in_bpm"] if split else ONE_DECK_BPM,
                                 SHARED_TEMPO["in_tone"])
                state.update(active=active, split=split, split_requests=0, other_requests=0, plans=[])
            return jsonify({**state, "plan": shared_tempo_plan(state["split"]), "tones": SHARED_TEMPO})

    def owned(body):
        return state["active"] and (body.get("seed") or body.get("from") or {}).get("id") == "member-pcm-soft"

    @app.before_request
    def shared_tempo_refinement():
        if request.path != "/api/discovery/music/dj-transition" or request.method != "POST":
            return None
        if not owned(request.get_json(silent=True) or {}):
            return None
        return jsonify(measured=True, transition=shared_tempo_plan(state["split"]))

    @app.after_request
    def shared_tempo_route(response):
        if request.path != "/api/discovery/music/dj-plan":
            return response
        body = request.get_json(silent=True) or {}
        with lock:
            if state["active"]:
                # Every route request, for a failure message that explains itself.
                state["plans"] = (state["plans"] + [{"status": response.status_code,
                    "seed": (body.get("seed") or {}).get("id")}])[-8:]
            if response.status_code != 200 or not owned(body):
                return response
            state["split_requests" if request.headers.get("X-Soundsible-Dj-Rates") == "split" else "other_requests"] += 1
        result = response.get_json()
        for row in result.get("items", []):
            if row.get("id") == "member-pcm-loud":
                row["transition"] = shared_tempo_plan(state["split"])
        response.set_data(app.json.dumps(result))
        return response
