"""Synthetic catalog providers; production search, resolution and saved routes remain real."""

from __future__ import annotations


def install(app):
    from flask import jsonify, request
    from gevent import sleep
    from shared.api.routes import catalog
    from shared.downloader.youtube_downloader import YouTubeDownloader

    controls = {"partial": True, "delay": False, "status": 0}
    calls = []
    requests = []

    def direct(query, _limit):
        calls.append({"provider": "youtube", "query": query})
        if "fixture" not in query.lower():
            return []
        return [
            catalog._catalog_item(
                item_id="youtube:track:A1111111111",
                item_type="track",
                source="youtube",
                title="fixture direct song",
                artist="fixture artist",
                duration=600,
                playable=True,
                raw={"id": "A1111111111", "artist": "fixture artist", "artist_is_channel": False},
            )
        ]

    def recording(query, _limit):
        calls.append({"provider": "deezer", "query": query})
        if controls["delay"] and "slow" in query.lower():
            sleep(2)
        if "fixture" not in query.lower():
            return []
        return [
            catalog._catalog_item(
                item_id="deezer:track:900001",
                item_type="track",
                source="deezer",
                title="fixture resolved song",
                artist="fixture artist",
                duration=60,
                external_ids={"deezer_id": "900001"},
            )
        ]

    def musicbrainz(query, _limit):
        if controls["partial"] and "fixture" in query.lower():
            raise RuntimeError("synthetic catalog provider unavailable")
        return []

    def candidates(_self, artist, title, max_results=8):
        calls.append({"provider": "resolution", "artist": artist, "title": title})
        if title != "fixture resolved song":
            return []
        return [{"id": "C1111111111", "title": title, "artist": artist, "channel": artist + " - Topic", "duration": 60}]

    catalog._youtube_search = direct
    catalog._deezer_search = recording
    catalog._musicbrainz_search = musicbrainz
    YouTubeDownloader.search_match_candidates = candidates

    @app.before_request
    def failure():
        if request.path == "/api/catalog/search" and controls["status"]:
            return jsonify({"error": "synthetic catalog failure"}), controls["status"]

    @app.after_request
    def record(response):
        if request.path.startswith("/api/catalog/") or request.path == "/api/library/saved/set":
            requests.append({"path": request.path, "status": response.status_code})
        return response

    @app.route("/api/android-fixture/catalog-stats")
    def stats():
        return jsonify({"calls": calls, "requests": requests})

    @app.route("/__fixture/catalog", methods=["POST"])
    def catalog_control():
        if request.headers.get("X-Android-Fixture") != "isolated":
            return jsonify({"error": "fixture only"}), 403
        data = request.get_json(silent=True) or {}
        for key in controls:
            if key in data:
                controls[key] = data[key]
        return jsonify({"ok": True})
