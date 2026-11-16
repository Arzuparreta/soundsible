"""A saved catalog row is given a playable identity in the background."""

from shared.api.routes import library
import threading

from shared.user_context import current_user_id


def test_the_background_resolution_runs_as_the_account_that_saved_it(monkeypatch):
    seen = {}

    def resolve(get_downloader, artist, title, duration):
        # A downloader built on first use reads the bound account's library.
        seen["user"] = current_user_id()
        return {"id": "abcdefghijk"}, []

    class Manager:
        def update_keys(self, keys, new):
            seen["keys"] = (keys, new)
            return True

    jobs = []
    monkeypatch.setattr(library.catalog_resolution, "resolve_candidates", resolve)
    monkeypatch.setattr("shared.user_cores.get_favourites_manager", lambda *a, **k: Manager())
    monkeypatch.setattr("shared.realtime.emit_to_user", lambda *a, **k: None)
    monkeypatch.setattr("shared.orchestrator.orchestrator.submit_background", lambda name, fn: jobs.append(fn))
    owner = current_user_id()

    library._schedule_favourite_resolve({"keys": ["deezer:1"], "artist": "Artist", "title": "Song", "duration": 200})
    # The job runs on a worker thread, where nobody is bound.
    worker = threading.Thread(target=jobs[0])
    worker.start()
    worker.join(5)

    assert seen["user"] == owner
    assert seen["keys"] == (["deezer:1"], ["yt:abcdefghijk"])
