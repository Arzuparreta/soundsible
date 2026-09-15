"""
The one channel between the player and the desktop shell.

The shell paints its own first-run, loading and error screens. It lives at
another origin (``tauri://localhost``) from the player, so it cannot read the
player's ``localStorage``; and it is on screen *before* the engine exists, so it
cannot ask this API either. What both sides can reach is a file in the shared
config directory, which is what these routes write.

The whole colour table is stored, not just the chosen colour, so the shell never
carries a second copy of the palette.
"""

import json

import pytest

from shared.api import app as api_app
from shared.api import reset_user_cores
from shared.api.routes.config import APPEARANCE_FILENAME
from shared.hardening import _rate_limiter
from shared.runtime import get_config_dir

COLORS = {
    "light": "#f6f6f7",
    "dark": "#0c0c0e",
    "slate": "#252d38",
    "pure-black": "#000000",
    "forest-green": "#0b110d",
}


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    _rate_limiter._events.clear()
    yield
    _rate_limiter._events.clear()


@pytest.fixture
def client():
    reset_user_cores()
    return api_app.test_client()


def _put(client, payload):
    return client.put("/api/desktop/appearance", json=payload)


def test_stores_the_preference_where_the_shell_reads_it(client):
    assert _put(client, {"theme": "forest-green", "colors": COLORS}).status_code == 200

    stored = json.loads((get_config_dir() / APPEARANCE_FILENAME).read_text())
    assert stored == {"theme": "forest-green", "colors": COLORS}


def test_reads_back_what_was_written(client):
    _put(client, {"theme": "slate", "colors": COLORS})

    assert client.get("/api/desktop/appearance").get_json() == {
        "theme": "slate",
        "colors": COLORS,
    }


def test_answers_before_anything_has_been_chosen(client):
    # First launch: no file yet. The shell has to get an answer it can act on,
    # not a 404 it has to special-case.
    assert client.get("/api/desktop/appearance").get_json() == {"theme": None, "colors": {}}


def test_survives_a_file_it_did_not_write(client):
    (get_config_dir() / APPEARANCE_FILENAME).write_text("{ not json")

    assert client.get("/api/desktop/appearance").get_json() == {"theme": None, "colors": {}}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"colors": COLORS},
        {"theme": "", "colors": COLORS},
        {"theme": 5, "colors": COLORS},
        {"theme": "dark"},
        {"theme": "dark", "colors": []},
        {"theme": "dark", "colors": {"dark": 12}},
    ],
)
def test_rejects_a_table_the_shell_could_not_paint_from(client, payload):
    assert _put(client, payload).status_code == 400
    assert not (get_config_dir() / APPEARANCE_FILENAME).exists()


def test_system_is_stored_as_itself(client):
    # `system` is a preference, not a palette: the shell resolves it against the
    # desktop, so the engine must not resolve it here.
    assert _put(client, {"theme": "system", "colors": COLORS}).status_code == 200
    assert json.loads((get_config_dir() / APPEARANCE_FILENAME).read_text())["theme"] == "system"
