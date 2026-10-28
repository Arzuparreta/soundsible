"""Demand lifetime through queues, shared consumers, HTTP and real worker death."""

from concurrent.futures import CancelledError
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask

from shared import work, preview_cache
from shared.dj import session as dj_session
from shared.user_context import user_context


def test_last_owner_cancels_queued_work_and_reclaims_capacity():
    executor = work.Executor("fixture", 1, 3)
    first = work.owner("first", 1)
    second = work.owner("second", 1)
    started, release = threading.Event(), threading.Event()
    ran = []

    def occupied():
        started.set()
        assert release.wait(3)

    try:
        active = executor.submit("active", occupied, demand=first)
        assert started.wait(3)
        obsolete = executor.submit("obsolete", lambda: ran.append("obsolete"), demand=first)
        first.retain("fixture", {"active"})
        assert obsolete.cancelled()
        current = executor.submit("current", lambda: ran.append("current"), demand=second)
        release.set()
        active.result(3)
        current.result(3)
        assert ran == ["current"]
    finally:
        release.set()
        executor.pool.shutdown(wait=True)


def test_shared_work_survives_until_its_last_consumer_leaves():
    executor = work.Executor("fixture", 1)
    a, b = work.owner("a", 1), work.owner("b", 1)
    started, release = threading.Event(), threading.Event()
    calls = []

    def run():
        calls.append(1)
        with work.cancelling(release.set):
            started.set()
            assert release.wait(3)
            work.check()
            return "measured"

    try:
        one = executor.submit("song", run, demand=a)
        assert started.wait(3)
        two = executor.submit("song", run, demand=b)
        assert one is two
        a.close()
        assert not release.is_set()
        release.set()
        assert two.result(3) == "measured"
        assert calls == [1]
    finally:
        release.set()
        executor.pool.shutdown(wait=True)


def test_running_work_receives_cancellation_and_stops_before_more_io():
    executor = work.Executor("fixture", 1)
    demand = work.owner("session", 1)
    started, release = threading.Event(), threading.Event()
    subsequent = Mock()

    def run():
        with work.cancelling(release.set):
            started.set()
            assert release.wait(3)
            work.check()
            subsequent()

    try:
        result = executor.submit("request", run, demand=demand)
        assert started.wait(3)
        demand.close()
        with pytest.raises(CancelledError):
            result.result(3)
        subsequent.assert_not_called()
    finally:
        release.set()
        executor.pool.shutdown(wait=True)


def test_epochs_cannot_be_resurrected_and_other_devices_or_accounts_survive():
    old = work.owner("device", 1)
    other = work.owner("other-device", 1)
    with user_context("someone-else"):
        separate = work.owner("device", 1)
    new = work.owner("device", 2)
    assert not old.active() and new.active() and other.active() and separate.active()
    with pytest.raises(work.WorkCancelled):
        work.owner("device", 1)
    new.close()
    with pytest.raises(work.WorkCancelled):
        work.owner("device", 2)


def test_disconnected_owner_expires_and_can_renew_without_restarting_the_session():
    demand = work.owner("tab", 3)
    demand.expires = time.monotonic() - 1
    work.expire()
    assert not demand.active()
    assert work.owner("tab", 3).active()


def _app(monkeypatch):
    from shared.api.routes import auto_mode
    from shared.api.routes.discovery_bp import discovery_bp

    app = Flask(__name__)
    app.register_blueprint(discovery_bp)
    monkeypatch.setattr(
        auto_mode, "_get_api", lambda: {"get_core": lambda: (SimpleNamespace(metadata=None), None, None)}
    )
    return app.test_client(), auto_mode


def _headers(epoch=1, request_id=None):
    value = {"X-Soundsible-Work": json.dumps({"client": "browser", "epoch": epoch})}
    if request_id:
        value["X-Soundsible-Work-Request"] = request_id
    return value


def test_runway_update_drops_removed_work_and_rejects_out_of_order_revisions(monkeypatch):
    client, auto_mode = _app(monkeypatch)
    prepared = []
    monkeypatch.setattr(auto_mode, "_dj_prepare_cohort", lambda _, tracks: prepared.append([t["id"] for t in tracks]))
    endpoint = "/api/discovery/music/dj-work"
    assert client.post(endpoint, headers=_headers(), json={"revision": 2, "tracks": [{"id": "new"}]}).status_code == 200
    assert client.post(endpoint, headers=_headers(), json={"revision": 1, "tracks": [{"id": "old"}]}).status_code == 200
    assert prepared == [["new"]]
    assert client.post(endpoint, headers=_headers(), json={"active": False}).status_code == 200
    assert client.post(endpoint, headers=_headers(), json={"revision": 3, "tracks": []}).status_code == 409
    assert client.post(endpoint, headers=_headers(2), json={"revision": 0, "tracks": []}).status_code == 200


def test_cancelled_request_cannot_arrive_late_and_start_work(monkeypatch):
    client, _ = _app(monkeypatch)
    assert (
        client.post(
            "/api/discovery/music/dj-work", headers=_headers(), json={"cancel_request": "request-a"}
        ).status_code
        == 200
    )
    response = client.post("/api/discovery/music/dj-plan", headers=_headers(request_id="request-a"), json={})
    assert response.status_code == 409


def test_preview_commit_only_notifies_current_dj_interests(tmp_path, monkeypatch):
    from shared.dj import store

    requested = Mock()
    monkeypatch.setattr(store, "request_analysis", requested)
    path = tmp_path / "song.audio"
    path.write_bytes(b"audio")
    dj_session.preview_ready("candidate01", path)
    requested.assert_not_called()
    a, b = work.owner("dj-a", 1), work.owner("dj-b", 1)
    a.tracks = {"first": {"id": "candidate01", "source": "preview"}}
    b.tracks = {"second": {"id": "candidate01", "source": "preview"}}
    a.close()
    dj_session.preview_ready("candidate01", path)
    requested.assert_called_once_with(path, "second", duration_hint=0)


def test_cached_audio_skips_url_resolution_in_both_prefetch_lanes(tmp_path, monkeypatch):
    path = tmp_path / "cached.audio"
    path.write_bytes(b"audio")
    monkeypatch.setattr(preview_cache, "get_cached", lambda _: (path, "audio/webm"))
    resolver = Mock()
    for download in (False, True):
        preview_cache._run_prefetch_job("candidate01", resolver, None, download=download)
    resolver.assert_not_called()


def test_open_playback_reader_keeps_shared_download_alive_after_dj_exit(monkeypatch):
    executor = work.Executor("preview-download", 1)
    monkeypatch.setattr(preview_cache, "_owned_lanes", {"preview-download": executor})
    demand = work.owner("dj", 1)
    started, release = threading.Event(), threading.Event()

    def run():
        with work.cancelling(release.set):
            started.set()
            assert release.wait(3)
            work.check()
            return "complete bytes"

    try:
        result = executor.submit("candidate01", run, demand=demand)
        assert started.wait(3)
        reader = preview_cache._playback_interest("candidate01")
        demand.close()
        assert not release.is_set()
        release.set()
        assert result.result(3) == "complete bytes"
        reader.close()
    finally:
        release.set()
        executor.pool.shutdown(wait=True)


def test_real_analysis_child_is_killed_on_last_interest_and_next_job_recovers(tmp_path, monkeypatch):
    from tests.test_dj_worker import fake_worker
    from shared.dj.worker import AnalysisProcess
    from shared.dj import store

    marker = tmp_path / "started"
    command = fake_worker(f"""
        if request["path"].endswith("slow.audio"):
            from pathlib import Path
            Path({str(marker)!r}).write_text("started")
            import time
            time.sleep(60)
        return {{"analysis": {{"analysed": True, "version": {store.ANALYSER_VERSION}}}}}
    """)
    process = AnalysisProcess(command)
    monkeypatch.setattr(store, "_process", process)
    monkeypatch.setattr(store, "_unmeasurable", {})
    executor = work.Executor("dj-analysis", 1)
    slow = tmp_path / "slow.audio"
    slow.write_bytes(b"audio")
    fast = tmp_path / "fast.audio"
    fast.write_bytes(b"audio")
    a, b = work.owner("old", 1), work.owner("current", 1)
    try:
        obsolete = executor.submit("old", store.analyse_audio, slow, "old", demand=a)
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert marker.exists()
        a.close()
        with pytest.raises(CancelledError):
            obsolete.result(3)
        assert "old" not in store._unmeasurable
        result = executor.submit("current", store.analyse_audio, fast, "current", demand=b).result(3)
        assert result["analysed"]
        assert store.cached_analysis(fast, "current")["analysed"]
        assert store.cached_analysis(slow, "old") is None
    finally:
        process.cancel()
        executor.pool.shutdown(wait=True)
        process.close()


def test_changed_source_is_never_cached_under_the_new_bytes(tmp_path, monkeypatch):
    from shared.dj import store

    source = tmp_path / "song.audio"
    source.write_bytes(b"first")

    def measured(*_):
        source.write_bytes(b"replacement")
        return {"analysed": True}

    monkeypatch.setattr(store, "_measure_source", measured)
    assert not store.analyse_audio(source, "song")["analysed"]
    assert store.cached_analysis(source, "song") is None


def test_gevent_cancellation_interrupts_network_and_preserves_the_next_job():
    from tests.test_dj_worker import run_python

    result = run_python(
        """
        from shared.cooperative import patch_process
        patch_process()
        import gevent
        from gevent.event import Event
        from concurrent.futures import CancelledError
        from shared import work
        executor = work.Executor("network", 1)
        demand = work.owner("session", 1)
        started = Event()
        def network():
            started.set()
            gevent.sleep(60)
            raise AssertionError("obsolete network call completed")
        future = executor.submit("old", network, demand=demand)
        assert started.wait(2)
        demand.close()
        try:
            future.result(2)
            raise AssertionError("not cancelled")
        except CancelledError:
            pass
        nested_started = Event()
        from concurrent.futures import ThreadPoolExecutor
        def metadata():
            nested_started.set()
            gevent.sleep(60)
        def parallel_provider():
            with ThreadPoolExecutor(2) as provider:
                provider.submit(work.context_call(metadata)).result()
        nested_owner = work.owner("nested", 1)
        nested = executor.submit("nested", parallel_provider, demand=nested_owner)
        assert nested_started.wait(2)
        nested_owner.close()
        try:
            nested.result(2)
            raise AssertionError("nested provider was not cancelled")
        except CancelledError:
            pass
        # Reused executor greenlets must not receive a delayed old interrupt.
        fresh = work.owner("session", 2)
        for number in range(20):
            assert executor.submit(str(number), lambda: (gevent.sleep(.001), "ok")[1], demand=fresh).result(2) == "ok"
        executor.pool.shutdown()
    """,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_related_extraction_is_shared_across_dj_and_discover_and_cached_once(monkeypatch):
    from shared import related_work

    db = Mock()
    db.get_related_mix.return_value = None
    monkeypatch.setattr(related_work, "instance_db", lambda: db)
    executor = work.Executor("related", 1)
    monkeypatch.setattr(related_work, "executor", executor)
    started, release = threading.Event(), threading.Event()

    def extract():
        started.set()
        assert release.wait(3)
        work.check()
        return [{"id": "related0001"}]

    dj = work.owner("dj", 1)
    try:
        with work.using(dj):
            first = related_work.submit("candidate01", extract)
        assert started.wait(3)
        second = related_work.submit("candidate01", Mock(side_effect=AssertionError("duplicate provider call")))
        assert first is second
        dj.close()
        release.set()
        assert second.result(3) == [{"id": "related0001"}]
        db.set_related_mix.assert_called_once_with("candidate01", [{"id": "related0001"}])
    finally:
        release.set()
        executor.pool.shutdown()


def test_finished_http_plan_releases_unused_metadata_without_harming_other_clients(monkeypatch):
    app = Flask(__name__)
    executor = work.Executor("metadata", 1)
    started, release = threading.Event(), threading.Event()
    futures = []

    @app.post("/plan")
    @dj_session.scoped
    def plan():
        def metadata():
            with work.cancelling(release.set):
                started.set()
                release.wait(3)
                work.check()

        futures.append(executor.submit("unused", metadata))
        assert started.wait(3)
        return {"items": []}

    try:
        client = app.test_client()
        assert client.post("/plan", headers=_headers(request_id="plan-a")).status_code == 200
        with pytest.raises(CancelledError):
            futures[0].result(3)
        assert client.post("/plan", headers=_headers(request_id="plan-a")).status_code == 409
    finally:
        release.set()
        executor.pool.shutdown()


def test_warming_retry_keeps_same_seed_alive_but_changed_route_cancels_it():
    app = Flask(__name__)
    executor = work.Executor("related", 1)
    started, release = threading.Event(), threading.Event()
    futures = []

    @app.post("/plan")
    @dj_session.scoped
    def plan():
        from flask import request

        seed = request.json["seed"]

        def extract():
            with work.cancelling(release.set):
                started.set()
                release.wait(3)
                work.check()

        futures.append(executor.submit(seed, extract))
        assert started.wait(3)
        return {"warming": True}

    try:
        client = app.test_client()
        for request_id in ("first", "retry"):
            assert (
                client.post("/plan", headers=_headers(request_id=request_id), json={"seed": "same"}).status_code == 200
            )
        assert futures[0] is futures[1]
        assert not release.is_set()
        # An explicit session replacement retires pending metadata as well.
        work.owner("browser", 2)
        with pytest.raises(CancelledError):
            futures[0].result(3)
    finally:
        release.set()
        executor.pool.shutdown()
