"""Bounded failures/delays around real Core DJ placement for native acceptance."""


def install(app):
    import math
    import threading

    from flask import g, jsonify, request
    from gevent import sleep

    state = {"fail_next": 0, "delay_next": 0.0, "calls": 0, "pending": 0}
    lock = threading.Lock()
    install_network(app)

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
