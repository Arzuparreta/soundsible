"""
Shared test fixtures.

Every request in the running engine executes with a user bound (see the
``before_request`` hook in :mod:`shared.api`), because managers resolve their
paths through that binding. Tests exercise those managers directly, so they get
the same treatment here — plus a throwaway runtime directory, so a test never
writes into the developer's real `~/.config/soundsible`.
"""

import pytest

from shared.app_config import set_output_dir
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.user_context import bind_user, unbind_user

TEST_USER_ID = "testuser"


@pytest.fixture(autouse=True)
def isolated_runtime(tmp_path_factory, monkeypatch):
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
    for name, path in {
        "SOUNDSIBLE_CONFIG_DIR": runtime.config_dir,
        "SOUNDSIBLE_DATA_DIR": runtime.data_dir,
        "SOUNDSIBLE_CACHE_DIR": runtime.cache_dir,
        "SOUNDSIBLE_LOG_DIR": runtime.log_dir,
        "SOUNDSIBLE_MUSIC_DIR": runtime.music_dir,
        "OUTPUT_DIR": runtime.music_dir,
    }.items():
        monkeypatch.setenv(name, str(path))
    # A real API boot in a test must not start network recovery against later
    # tests' runtimes. Recovery itself is exercised with an explicit worker.
    from shared import work
    monkeypatch.setattr(work, "start_reaper", lambda: None)
    from shared.artwork_recovery import recovery
    monkeypatch.setattr(recovery, "start", lambda: None)
    # The checkout's own pre-move settings file is the developer's, not a test's.
    from shared.downloader import settings as downloader_settings
    monkeypatch.setattr(downloader_settings, "_LEGACY_PATH", root / "no-legacy-settings")
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    set_output_dir(runtime.music_dir)

    token = bind_user(TEST_USER_ID)
    try:
        yield runtime
    finally:
        work.reset_runtime()
        # A test that boots the API starts the download pump and the loudness
        # worker, and ending them is `stop_api`'s job, which such tests stub
        # out. Left running they carried on through every later test, writing
        # to whichever runtime was configured: another test's instance.db —
        # a backup test read its SQLite journal mid-write and failed the
        # v0.16.0 tag — and, between tests, the real one under $HOME.
        try:
            from shared.orchestrator import orchestrator

            orchestrator.stop_downloader_pump(wait=True)
        except Exception:
            pass
        try:
            from shared.loudness import stop_loudness_service_if_started

            stop_loudness_service_if_started()
        except Exception:
            pass
        try:
            from shared.keyfile import reset_key_cache
            from shared.scrobble import stop_scrobble_service_if_started

            # Listening sessions and the delivery thread belong to this test's
            # accounts; the key cache to this test's config directory.
            stop_scrobble_service_if_started()
            reset_key_cache()
        except Exception:
            pass
        unbind_user(token)
        from shared.user_cores import reset_user_cores

        reset_user_cores()
        try:
            from shared.telemetry import reset_telemetry

            reset_telemetry()
        except Exception:
            pass
        try:
            from shared.database import reset_database_managers

            # Managers are cached per database path; the next test gets a new
            # runtime directory, so nothing may survive pointing at this one.
            reset_database_managers()
        except Exception:
            pass
        set_output_dir(None)
        reset_runtime()


#: Engine endpoints whose successful answers must match the DJ API contract.
_CONTRACT_ROUTES = {
    "/api/discovery/music/plan": "ListeningPlanResponse",
    "/api/discovery/music/dj-plan": "DjPlanResponse",
    "/api/discovery/music/dj-place": "DjPlacementResponse",
    "/api/discovery/music/dj-repair": "DjRepairResponse",
    "/api/discovery/music/dj-transition": "DjTransitionResponse",
}


@pytest.fixture(autouse=True)
def dj_contract(monkeypatch):
    """Check every DJ answer a test produces against shared/contracts/api/dj.schema.json.

    The scenario tests already drive these routes through every branch they
    care about; validating what they get back is what keeps the schema, the web
    client's generated types and Android's parsers describing the real engine.
    """
    from urllib.parse import urlsplit

    from flask.testing import FlaskClient

    from scripts.api_contract import load, validate_response

    root = load()
    original = FlaskClient.open

    def checked(self, *args, **kwargs):
        response = original(self, *args, **kwargs)
        target = args[0] if args and isinstance(args[0], str) else kwargs.get("path", "")
        definition = _CONTRACT_ROUTES.get(urlsplit(target).path)
        # Only the engine's own routes; a test's stand-in route answers whatever it needs.
        engine = "discovery" in self.application.blueprints
        if definition and engine and response.status_code == 200 and response.is_json:
            body = response.get_json()
            if definition == "DjPlacementResponse" and "placements" in body:
                definition = "DjPlacementsResponse"
            validate_response(definition, body, root)
        return response

    monkeypatch.setattr(FlaskClient, "open", checked)
