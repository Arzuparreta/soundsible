from types import SimpleNamespace

import pytest

import shared.api as api


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


def test_core_initialization_failure_prevents_readiness_and_server_start(
    monkeypatch, isolated_runtime
):
    ready = []
    server_starts = []
    monkeypatch.setattr(api, "migrate_legacy_app_dirs", lambda _runtime: None)
    monkeypatch.setattr(api, "ensure_runtime_directories", lambda _runtime: None)
    monkeypatch.setattr(api, "init_telemetry", lambda _runtime: None)
    monkeypatch.setattr(api, "ensure_ui_dist", lambda **_kwargs: None)
    monkeypatch.setattr(api, "_resolve_output_dir", lambda: None)
    monkeypatch.setattr(
        "shared.multiuser_migration.ensure_multiuser_layout", lambda: None
    )
    monkeypatch.setattr(
        api,
        "_initialize_admin_core",
        lambda: (_ for _ in ()).throw(RuntimeError("broken library")),
    )
    monkeypatch.setattr(
        api.socketio,
        "run",
        lambda *_args, **_kwargs: server_starts.append(True),
    )

    with pytest.raises(RuntimeError, match="API server was not started"):
        api.start_api(
            runtime_config=isolated_runtime,
            on_ready=lambda _runtime: ready.append(True),
        )

    assert ready == []
    assert server_starts == []
