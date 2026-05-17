import json

from shared.database import DatabaseManager
from shared.desktop_runtime import (
    OWNER_TOKEN_KIND,
    clear_runtime_state,
    ensure_owner_token,
    load_runtime_state,
    stop_owned_desktop_engine,
    write_runtime_state,
)
from shared.hardening import ALL_SCOPES
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _make_runtime(tmp_path) -> RuntimeConfig:
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=49152,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)
    configure_runtime(runtime)
    return runtime


def test_ensure_owner_token_rotates_to_single_owner_token(tmp_path):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    db = DatabaseManager()

    runtime, token = ensure_owner_token(runtime)
    assert token
    assert runtime.owner_token_file is not None
    assert runtime.owner_token_file.exists()
    assert runtime.owner_token_file.read_text() == token

    first_records = [row for row in db.list_auth_tokens(kind=OWNER_TOKEN_KIND) if row["revoked_at"] is None]
    assert len(first_records) == 1
    assert set(first_records[0]["scopes"]) == set(ALL_SCOPES)

    runtime, second_token = ensure_owner_token(runtime)
    assert second_token != token

    second_records = db.list_auth_tokens(kind=OWNER_TOKEN_KIND)
    active = [row for row in second_records if row["revoked_at"] is None]
    revoked = [row for row in second_records if row["revoked_at"] is not None]
    assert len(active) == 1
    assert len(revoked) >= 1


def test_runtime_state_round_trip_and_clear(tmp_path):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    runtime, _ = ensure_owner_token(runtime)

    state = write_runtime_state(runtime, version="0.0.0-test")
    loaded = load_runtime_state(runtime.config_dir)

    assert loaded is not None
    assert loaded["pid"] == state["pid"]
    assert loaded["base_url"] == "http://127.0.0.1:49152"
    assert loaded["version"] == "0.0.0-test"
    assert loaded["owner_token_file"] == str(runtime.owner_token_file)

    clear_runtime_state(runtime)
    assert load_runtime_state(runtime.config_dir) is None


def test_stop_owned_desktop_engine_cleans_stale_state(tmp_path):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    state_path = runtime.config_dir / "desktop-engine-state.json"
    state_path.write_text(json.dumps({"pid": 999999, "mode": "desktop-engine"}))

    ok, message = stop_owned_desktop_engine(runtime.config_dir)

    assert ok is True
    assert "not running" in message.lower()
    assert not state_path.exists()
