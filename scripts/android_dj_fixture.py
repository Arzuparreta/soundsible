"""Bounded failures/delays around real Core DJ placement for native acceptance."""


def install(app):
    import math
    import threading

    from flask import g, jsonify, request
    from gevent import sleep

    state = {"fail_next": 0, "delay_next": 0.0, "calls": 0, "pending": 0}
    lock = threading.Lock()

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
