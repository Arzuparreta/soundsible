"""Who gets to talk to ``/rest``, and how."""

import hashlib
import json
import os
import stat

import pytest

from shared.subsonic import credentials
from shared.subsonic.envelope import (
    ERR_BAD_API_KEY,
    ERR_BAD_CREDENTIALS,
    ERR_CONFLICTING_AUTH,
    ERR_MISSING_PARAMETER,
)
from shared.users import create_user, set_disabled
from tests.subsonic_support import build, track


def _error(response) -> dict:
    body = json.loads(response.data)["subsonic-response"]
    assert body["status"] == "failed", body
    return body["error"]


def test_password_authenticates(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    assert harness.ok("ping")["version"] == "1.16.1"


def test_hex_encoded_password_authenticates(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    encoded = "enc:" + harness.secret.encode("utf-8").hex()
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json", p=encoded))
    assert json.loads(response.data)["subsonic-response"]["status"] == "ok"


def test_salted_token_authenticates(tmp_path, monkeypatch):
    """The default handshake of most clients, and the reason the secret is stored readable."""
    harness = build(tmp_path, monkeypatch, [track("t1")])
    salt = "c0ffee"
    token = hashlib.md5(f"{harness.secret}{salt}".encode("utf-8")).hexdigest()
    query = harness.auth(f="json", t=token, s=salt)
    query.pop("p")
    response = harness.client.get("/rest/ping", query_string=query)
    assert json.loads(response.data)["subsonic-response"]["status"] == "ok"


def test_api_key_authenticates(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    query = harness.auth(f="json", apiKey=harness.secret)
    query.pop("p")
    response = harness.client.get("/rest/ping", query_string=query)
    assert json.loads(response.data)["subsonic-response"]["status"] == "ok"


def test_wrong_password_is_rejected(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json", p="nope-nope-nope"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS


def test_wrong_api_key_reports_the_api_key_code(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    query = harness.auth(f="json", apiKey="not-the-key")
    query.pop("p")
    assert _error(harness.client.get("/rest/ping", query_string=query))["code"] == ERR_BAD_API_KEY


def test_missing_credentials_are_a_missing_parameter(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    query = harness.auth(f="json")
    query.pop("p")
    assert _error(harness.client.get("/rest/ping", query_string=query))["code"] == ERR_MISSING_PARAMETER


def test_token_without_salt_is_a_missing_parameter(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    query = harness.auth(f="json", t="deadbeef")
    query.pop("p")
    assert _error(harness.client.get("/rest/ping", query_string=query))["code"] == ERR_MISSING_PARAMETER


def test_two_mechanisms_at_once_are_refused(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    query = harness.auth(f="json", apiKey=harness.secret)
    assert _error(harness.client.get("/rest/ping", query_string=query))["code"] == ERR_CONFLICTING_AUTH


def test_an_account_without_a_credential_cannot_get_in(tmp_path, monkeypatch):
    """No credential means the account does not exist for this protocol."""
    harness = build(tmp_path, monkeypatch, [track("t1")], with_credential=False)
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json", p="anything"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS


def test_unknown_username_looks_exactly_like_a_wrong_password(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json", u="ghost"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS


def test_disabled_account_is_refused(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    set_disabled(harness.user["id"], True)
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS


def test_revoking_locks_the_client_out(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    assert credentials.revoke_credential(harness.user["id"]) is True
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS


def test_regenerating_replaces_the_old_secret(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    old = harness.secret
    new = credentials.create_credential(harness.user["id"])
    assert new != old
    assert _error(harness.client.get("/rest/ping", query_string=harness.auth(f="json", p=old)))
    assert json.loads(
        harness.client.get("/rest/ping", query_string=harness.auth(f="json", p=new)).data
    )["subsonic-response"]["status"] == "ok"


def test_using_the_credential_records_the_client(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    harness.ok("ping")
    status = credentials.credential_status(harness.user["id"])
    assert status["last_used_at"] is not None
    assert status["last_client"] == "pytest"


def test_status_never_exposes_the_secret(tmp_path, monkeypatch):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    status = credentials.credential_status(harness.user["id"])
    assert harness.secret not in json.dumps(status)


def test_secret_is_not_stored_in_the_clear(tmp_path, monkeypatch):
    """A copy of the database on its own must not hand over a working password."""
    harness = build(tmp_path, monkeypatch, [track("t1")])
    from shared.database import instance_db

    stored = instance_db().get_subsonic_credential(harness.user["id"])
    assert harness.secret not in stored["secret_enc"]


def test_key_file_is_owner_only(isolated_runtime):
    credentials.reset_key_cache()
    create_user("keyholder")
    credentials._load_key()
    key_path = isolated_runtime.config_dir / credentials.KEY_FILENAME
    assert key_path.exists()
    if os.name != "nt":
        assert stat.S_IMODE(key_path.stat().st_mode) == 0o600


def test_a_lost_key_invalidates_rather_than_crashes(tmp_path, monkeypatch, isolated_runtime):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    (isolated_runtime.config_dir / credentials.KEY_FILENAME).unlink()
    credentials.reset_key_cache()
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json"))
    assert _error(response)["code"] == ERR_BAD_CREDENTIALS
    assert credentials.credential_status(harness.user["id"]) is not None


@pytest.mark.parametrize("method", ["getArtists", "getAlbumList2", "stream", "getPlaylists"])
def test_no_endpoint_answers_without_credentials(tmp_path, monkeypatch, method):
    harness = build(tmp_path, monkeypatch, [track("t1")])
    response = harness.client.get(f"/rest/{method}", query_string={"f": "json", "v": "1.16.1", "c": "pytest"})
    assert _error(response)["code"] in (ERR_MISSING_PARAMETER, ERR_BAD_CREDENTIALS)


def test_repeated_failures_are_eventually_told_to_wait(tmp_path, monkeypatch):
    from shared.api.routes.subsonic import FAILED_AUTH_LIMIT

    harness = build(tmp_path, monkeypatch, [track("t1")])
    for _ in range(FAILED_AUTH_LIMIT + 1):
        harness.client.get("/rest/ping", query_string=harness.auth(f="json", p="wrong"))
    response = harness.client.get("/rest/ping", query_string=harness.auth(f="json", p="wrong"))
    assert "Too many" in _error(response)["message"]


def test_a_client_browsing_correctly_is_never_rated(tmp_path, monkeypatch):
    """Every call carries credentials; counting successes would lock out real use."""
    from shared.api.routes.subsonic import FAILED_AUTH_LIMIT

    harness = build(tmp_path, monkeypatch, [track("t1")])
    for _ in range(FAILED_AUTH_LIMIT * 3):
        assert harness.ok("ping")["status"] == "ok"


# ---------------------------------------------------------------------------
# Managing the credential from the player
# ---------------------------------------------------------------------------


@pytest.fixture
def account_client():
    """The real app, logged in as an account that owns nothing yet."""
    from shared.api import app as api_app, reset_user_cores
    from shared.hardening import _reset_rate_limits_for_tests

    credentials.reset_key_cache()
    _reset_rate_limits_for_tests()
    reset_user_cores()
    create_user("ana", password="secret123")
    client = api_app.test_client()
    assert client.post("/api/auth/login", json={"username": "ana", "password": "secret123"}).status_code == 200
    return client


def test_access_starts_unconfigured(account_client):
    body = account_client.get("/api/auth/subsonic").get_json()
    assert body["configured"] is False
    assert body["username"] == "ana"
    assert "password" not in body


def test_creating_returns_the_secret_once_and_never_again(account_client):
    created = account_client.post("/api/auth/subsonic").get_json()
    assert created["configured"] is True
    assert created["password"]

    later = account_client.get("/api/auth/subsonic").get_json()
    assert later["configured"] is True
    assert "password" not in later


def test_revoking_leaves_nothing_configured(account_client):
    account_client.post("/api/auth/subsonic")
    body = account_client.delete("/api/auth/subsonic").get_json()
    assert body["configured"] is False


def test_managing_access_requires_being_signed_in():
    from shared.api import app as api_app, reset_user_cores
    from shared.users import set_password

    reset_user_cores()
    owner = create_user("owner")
    set_password(owner["id"], "hunter22")
    create_user("other", password="secret123")

    anonymous = api_app.test_client()
    assert anonymous.get("/api/auth/subsonic").status_code == 401
    assert anonymous.post("/api/auth/subsonic").status_code == 401
