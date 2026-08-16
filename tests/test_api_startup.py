"""What startup owes the rest of the instance.

Two failures this file exists for, both of which shipped and neither of which
announced itself:

- `start_api` warmed the admin core through `get_core()`, which answers with the
  legacy ``(library, playback, queue)`` triple. Reading ``.library`` off a tuple
  raised, one broad ``except`` swallowed it, and everything that had not run yet
  — the folder watcher, the download pump, the lossless and loudness workers,
  the Discover warm-up — silently never started.
- The server then said ``"status": "healthy"`` anyway.
"""

from types import SimpleNamespace

import pytest

import shared.api as api
from shared.api import app as api_app


@pytest.fixture
def started_api(monkeypatch, isolated_runtime):
    """Run `start_api` with everything outside its own control stubbed out.

    Returns a callable taking the admin-core initializer to install, and
    reporting whether readiness fired and whether the server was started.
    """

    def _start(initializer):
        record = {"ready": [], "served": []}
        monkeypatch.setattr(api, "migrate_legacy_app_dirs", lambda _runtime: None)
        monkeypatch.setattr(api, "ensure_runtime_directories", lambda _runtime: None)
        monkeypatch.setattr(api, "init_telemetry", lambda _runtime: None)
        monkeypatch.setattr(api, "ensure_ui_dist", lambda **_kwargs: None)
        monkeypatch.setattr(api, "_resolve_output_dir", lambda: None)
        monkeypatch.setattr(
            "shared.multiuser_migration.ensure_multiuser_layout", lambda: None
        )
        monkeypatch.setattr(api, "_initialize_admin_core", initializer)
        monkeypatch.setattr(
            api.socketio,
            "run",
            lambda *_args, **_kwargs: record["served"].append(True),
        )
        monkeypatch.setattr(api, "stop_api", lambda *_args, **_kwargs: None)
        api.start_api(
            runtime_config=isolated_runtime,
            on_ready=lambda _runtime: record["ready"].append(True),
        )
        return record

    yield _start
    api._startup_degraded_reason = None


def test_admin_warmup_uses_structured_user_core(monkeypatch):
    expected = SimpleNamespace(
        library=SimpleNamespace(config=SimpleNamespace(watch_folders=[]))
    )
    calls = []
    monkeypatch.setattr("shared.users.get_admin_user", lambda: {"id": "admin-id"})
    monkeypatch.setattr(
        api,
        "get_user_core",
        lambda user_id: calls.append(user_id) or expected,
    )

    assert api._initialize_admin_core() is expected
    assert calls == ["admin-id"]


def test_a_watcher_that_will_not_start_does_not_stop_the_instance(monkeypatch):
    """One folder stops scanning itself; the music keeps playing."""
    core = SimpleNamespace(
        library=SimpleNamespace(config=SimpleNamespace(watch_folders=["/music"]))
    )
    monkeypatch.setattr("shared.users.get_admin_user", lambda: {"id": "admin-id"})
    monkeypatch.setattr(api, "get_user_core", lambda _user_id: core)

    def _explode(*_args, **_kwargs):
        raise OSError("inotify watch limit reached")

    monkeypatch.setattr("setup_tool.watcher.LibraryWatcher", _explode)
    monkeypatch.setattr(api, "api_observer", None)

    assert api._initialize_admin_core() is core
    assert api.api_observer is None


def test_core_failure_keeps_serving_but_reports_degraded(started_api, monkeypatch):
    """A broken library is exactly when the UI that fixes it has to be up."""
    record = started_api(
        lambda: (_ for _ in ()).throw(RuntimeError("broken library"))
    )

    assert record["served"] == [True]
    assert record["ready"] == [True]
    assert "broken library" in api._startup_degraded_reason

    admin_body = api_app.test_client().get("/api/health").get_json()
    assert admin_body["status"] == "degraded"
    assert "broken library" in admin_body["degraded_detail"]

    # Whoever is asking learns *that* it is degraded. The exception text, which
    # carries paths and class names, waits until they have proved who they are.
    monkeypatch.setattr("shared.hardening.request_is_admin_user", lambda: False)
    body = api_app.test_client().get("/api/health").get_json()
    assert body["status"] == "degraded"
    assert body["degraded_reason"] == "core initialization failed"
    assert "broken library" not in repr(body)


def test_a_clean_start_reports_healthy(started_api):
    record = started_api(lambda: None)

    assert record["served"] == [True]
    assert api._startup_degraded_reason is None
    body = api_app.test_client().get("/api/health").get_json()
    assert body["status"] == "healthy"
    assert "degraded_reason" not in body


def test_health_reports_degraded_once_the_db_pool_is_actually_exhausted(isolated_runtime):
    """Before this, `/api/health` only reflected a boot-time flag: a pool
    silently drained by a connection leak (the incident this guards against)
    still reported "healthy" for as long as the process stayed up, which is
    exactly why the leak went unnoticed for days."""
    from shared.database import instance_db

    pool = instance_db()._pool
    # Building the manager itself already pins one connection to this thread
    # (see DatabaseManager._get_connection) — top the rest of the way up.
    remaining = pool._max_size - pool.stats()["created"]
    held = [pool.acquire() for _ in range(remaining)]
    try:
        body = api_app.test_client().get("/api/health").get_json()
        assert body["status"] == "degraded"
        assert body["degraded_reason"] == "database connection pool exhausted"
        assert body["db_pool"]["created"] == pool._max_size
        assert body["db_pool"]["idle"] == 0
    finally:
        for conn in held:
            pool.release(conn)
