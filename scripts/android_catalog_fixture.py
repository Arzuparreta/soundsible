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
    review_albums = {"choose": "920002", "skip": "920003", "retry": "920004", "cancel": "920005"}

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
        review = next((name for name in review_albums if f"fixture review {name}" in query.lower()), None)
        if review:
            album_id = review_albums[review]
            return [catalog._catalog_item(item_id=f"deezer:album:{album_id}", item_type="album", source="deezer",
                title=f"fixture review album {review}", artist="fixture collection artist",
                external_ids={"deezer_album_id": album_id})]
        if "collection" in query.lower():
            return [
                catalog._catalog_item(item_id="deezer:artist:910001", item_type="artist", source="deezer",
                    title="fixture collection artist", artist="fixture collection artist",
                    external_ids={"deezer_artist_id": "910001"}),
                catalog._catalog_item(item_id="deezer:album:920001", item_type="album", source="deezer",
                    title="fixture collection album", artist="fixture collection artist",
                    external_ids={"deezer_album_id": "920001"}),
                *[catalog._catalog_item(item_id=f"deezer:track:{900100 + index}", item_type="track", source="deezer",
                    title=f"fixture navigation song {index}", artist="fixture collection artist",
                    external_ids={"deezer_id": str(900100 + index)}) for index in range(15)],
            ]
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
        if title.startswith("fixture review song "):
            if title.endswith("cancel"):
                sleep(5)
            identity = {"choose": "D1111111111", "skip": "B1111111111", "retry": "E1111111111", "cancel": "A1111111111"}[title.rsplit(" ", 1)[-1]]
            return [{"id": identity, "title": title + " (Live)", "artist": artist,
                     "channel": artist + " - Topic", "duration": 180}]
        if title != "fixture resolved song":
            return []
        return [{"id": "C1111111111", "title": title, "artist": artist, "channel": artist + " - Topic", "duration": 60}]

    # Only the external provider is synthetic: profile/discography routes,
    # identity normalization, saved mutations and durable job ownership stay real.
    real_deezer_get = catalog._deezer_get

    def provider(path, params=None, timeout=8):
        review = next((name for name, identity in review_albums.items() if path.startswith(f"album/{identity}")), None)
        if review:
            album_id = review_albums[review]
            artist = {"id": 910001, "name": "fixture collection artist"}
            album = {"id": int(album_id), "title": f"fixture review album {review}", "artist": artist,
                     "record_type": "album", "release_date": "2020-01-01"}
            track = {"id": int(album_id) + 1000, "title": f"fixture review song {review}", "artist": artist,
                     "duration": 60, "album": album, "track_position": 1, "disk_number": 1}
            calls.append({"provider": "deezer-profile", "path": path})
            if path.endswith("/tracks"):
                return {"data": [track], "total": 1}
            return {**album, "tracks": {"data": [track]}, "nb_tracks": 1}
        if "910001" not in path and "920001" not in path:
            return real_deezer_get(path, params, timeout)
        calls.append({"provider": "deezer-profile", "path": path})
        artist = {"id": 910001, "name": "fixture collection artist", "nb_fan": 123}
        album = {"id": 920001, "title": "fixture collection album", "artist": artist,
                 "record_type": "album", "release_date": "2020-01-01"}
        track = {"id": 900001, "title": "fixture resolved song", "artist": artist,
                 "album": album, "duration": 60, "track_position": 1, "disk_number": 1}
        if path == "artist/910001":
            return artist
        if path == "artist/910001/top":
            return {"data": [track], "total": 1}
        if path == "artist/910001/albums":
            return {"data": [album], "total": 1}
        if path == "artist/910001/related":
            return {"data": []}
        if path == "album/920001":
            return {**album, "tracks": {"data": [track]}, "nb_tracks": 1}
        if path == "album/920001/tracks":
            return {"data": [track], "total": 1}
        raise RuntimeError("Unexpected synthetic provider path")

    catalog._deezer_get = provider
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
