"""
Shared test fixtures.

Every request in the running engine executes with a user bound (see the
``before_request`` hook in :mod:`shared.api`), because managers resolve their
paths through that binding. Tests exercise those managers directly, so they get
the same treatment here — plus a throwaway runtime directory, so a test never
writes into the developer's real `~/.config/soundsible`.
"""

import pytest

from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.user_context import bind_user, unbind_user

TEST_USER_ID = "testuser"


@pytest.fixture(autouse=True)
def isolated_runtime(tmp_path_factory):
    """Point the runtime at a per-test directory and bind a user to the context."""
    root = tmp_path_factory.mktemp("soundsible")
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(root / "config").resolve(),
        data_dir=(root / "data").resolve(),
        cache_dir=(root / "cache").resolve(),
        log_dir=(root / "logs").resolve(),
        music_dir=(root / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)

    token = bind_user(TEST_USER_ID)
    try:
        yield runtime
    finally:
        unbind_user(token)
        try:
            import shared.api as api_mod

            api_mod.reset_user_cores()
        except Exception:
            pass
        try:
            from shared.telemetry import reset_telemetry

            reset_telemetry()
        except Exception:
            pass
        reset_runtime()
