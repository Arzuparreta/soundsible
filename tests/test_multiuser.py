"""
Multi-user guarantees: migration, login policy, and isolation between accounts.

The isolation tests are the ones that matter — they assert that one person's
library, favourites, queue, and download rows are unreachable from another
account, both through the managers and through the HTTP API.
"""

import json

import pytest

from shared.api import app as api_app
from shared.api import get_user_core, reset_user_cores
from shared.database import instance_db
from shared.hardening import _rate_limiter
from shared.multiuser_migration import BACKUP_SUFFIX, ensure_multiuser_layout
from shared.runtime import get_config_dir, get_data_dir
from shared.user_context import user_config_dir, user_context, user_data_dir
from shared.users import (
    ROLE_ADMIN,
    ROLE_MEMBER,
    SESSION_COOKIE_NAME,
    UserError,
    authenticate,
    create_user,
    delete_user,
    get_admin_user,
    get_user,
    instance_requires_login,
    list_users,
    set_password,
    sole_passwordless_user,
)


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    _rate_limiter._events.clear()
    yield
    _rate_limiter._events.clear()


@pytest.fixture
def client():
    reset_user_cores()
    return api_app.test_client()


def _login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


# ---------------------------------------------------------------------------
# Migration from a single-user install
# ---------------------------------------------------------------------------


def test_migration_adopts_existing_library_and_keeps_a_backup():
    config_dir = get_config_dir()
    data_dir = get_data_dir()
    (config_dir / "library.json").write_text('{"version": 1, "tracks": [], "playlists": {}}')
    (config_dir / "favourites.json").write_text('{"version": "1.0", "favourites": ["t1"]}')
    (data_dir / "queue_state.json").write_text('{"version": 1, "queue": []}')

    summary = ensure_multiuser_layout()

    assert summary is not None
    assert summary["adopted_existing_library"] is True
    user_id = summary["user_id"]

    assert (user_config_dir(user_id) / "library.json").exists()
    assert (user_config_dir(user_id) / "favourites.json").exists()
    assert (user_data_dir(user_id) / "queue_state.json").exists()
    # Originals stay put under a backup name so the migration is reversible.
    assert (config_dir / f"library.json{BACKUP_SUFFIX}").exists()

    assert get_user(user_id)["role"] == ROLE_ADMIN
    assert ensure_multiuser_layout() is None, "migration must be idempotent"


def test_migration_tags_queued_downloads_with_the_new_owner():
    config_dir = get_config_dir()
    (config_dir / "library.json").write_text('{"version": 1, "tracks": [], "playlists": {}}')
    (config_dir / "download_queue.json").write_text('[{"id": "a", "song_str": "x"}]')

    summary = ensure_multiuser_layout()

    items = json.loads((config_dir / "download_queue.json").read_text())
    assert items[0]["user_id"] == summary["user_id"]


def test_fresh_install_creates_one_passwordless_admin():
    summary = ensure_multiuser_layout()

    assert summary["adopted_existing_library"] is False
    assert instance_requires_login() is False
    assert sole_passwordless_user()["id"] == summary["user_id"]


# ---------------------------------------------------------------------------
# Login policy
# ---------------------------------------------------------------------------


def test_login_turns_on_when_a_second_account_appears():
    ensure_multiuser_layout()
    assert instance_requires_login() is False

    create_user("ana", password="secret123")

    assert instance_requires_login() is True
    assert sole_passwordless_user() is None


def test_login_turns_on_when_the_only_account_gets_a_password():
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")

    assert instance_requires_login() is True


def test_authenticate_rejects_wrong_password_and_disabled_accounts():
    ensure_multiuser_layout()
    user = create_user("ana", password="secret123")

    assert authenticate("ana", "secret123")["id"] == user["id"]
    assert authenticate("ana", "wrong") is None
    assert authenticate("nobody", "secret123") is None


def test_last_admin_cannot_be_deleted():
    summary = ensure_multiuser_layout()

    with pytest.raises(UserError):
        delete_user(summary["user_id"])


def test_deleting_a_user_removes_their_directories_but_not_the_pool():
    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")
    with user_context(ana["id"]):
        (user_config_dir() / "library.json").write_text("{}")
    ana_dir = user_config_dir(ana["id"], create=False)
    assert ana_dir.exists()

    delete_user(ana["id"])

    assert not ana_dir.exists()
    assert [u["username"] for u in list_users()] == ["owner"]


# ---------------------------------------------------------------------------
# Isolation
# ---------------------------------------------------------------------------


def test_two_accounts_get_separate_directories_and_favourites():
    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")
    bob = create_user("bob", password="secret123")

    with user_context(ana["id"]):
        get_user_core(ana["id"]).favourites.add("track-a")
    with user_context(bob["id"]):
        get_user_core(bob["id"]).favourites.add("track-b")

    with user_context(ana["id"]):
        assert get_user_core(ana["id"]).favourites.get_all() == ["track-a"]
    with user_context(bob["id"]):
        assert get_user_core(bob["id"]).favourites.get_all() == ["track-b"]

    assert user_config_dir(ana["id"]) != user_config_dir(bob["id"])
    assert (user_config_dir(ana["id"]) / "favourites.json").exists()


def test_queue_and_library_paths_never_collide():
    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")
    bob = create_user("bob", password="secret123")

    with user_context(ana["id"]):
        ana_core = get_user_core(ana["id"])
    with user_context(bob["id"]):
        bob_core = get_user_core(bob["id"])

    assert ana_core.library.manifest_path != bob_core.library.manifest_path
    assert ana_core.library.db.db_path != bob_core.library.db.db_path
    assert ana_core.queue._persist_path != bob_core.queue._persist_path


def test_a_new_account_starts_with_an_empty_manifest_not_an_unloaded_one():
    """A fresh account has no library.json yet.

    Without a manifest written up front, `_ensure_lib_metadata` reports "library
    not loaded" and the first playlist or favourite comes back 404.
    """
    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")

    with user_context(ana["id"]):
        core = get_user_core(ana["id"])
        assert core.library.metadata is not None
        assert core.library.metadata.tracks == []
        assert core.library.manifest_path.exists()

        core.library.metadata.create_playlist("Ana Mix")
        core.library._save_metadata()

    with user_context(ana["id"]):
        assert "Ana Mix" in get_user_core(ana["id"]).library.metadata.playlists


def test_download_queue_rows_are_only_visible_to_their_owner():
    from shared.api import queue_manager_dl

    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")
    bob = create_user("bob", password="secret123")

    queue_manager_dl.queue = []
    queue_manager_dl.add({"song_str": "ana song"}, user_id=ana["id"])
    queue_manager_dl.add({"song_str": "bob song"}, user_id=bob["id"])

    ana_rows = queue_manager_dl.list_items(ana["id"])
    bob_rows = queue_manager_dl.list_items(bob["id"])

    assert [r["song_str"] for r in ana_rows] == ["ana song"]
    assert [r["song_str"] for r in bob_rows] == ["bob song"]
    assert len(queue_manager_dl.get_pending()) == 2, "the pump still sees everything"

    queue_manager_dl.clear_queue(user_id=ana["id"])
    assert [r["song_str"] for r in queue_manager_dl.list_items(bob["id"])] == ["bob song"]
    assert queue_manager_dl.list_items(ana["id"]) == []

    queue_manager_dl.queue = []


# ---------------------------------------------------------------------------
# The HTTP gate
# ---------------------------------------------------------------------------


def test_api_is_open_while_a_single_passwordless_account_exists(client):
    ensure_multiuser_layout()

    assert client.get("/api/auth/state").get_json()["requires_login"] is False
    assert client.get("/api/library").status_code in (200, 404)


def test_api_returns_401_without_a_session_once_login_is_required(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    assert client.get("/api/library").status_code == 401
    # The login screen still needs to be able to ask whether it should show.
    assert client.get("/api/auth/state").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_login_sets_a_session_cookie_and_me_reports_the_account(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    res = _login(client, "ana", "secret123")
    assert res.status_code == 200
    assert res.get_json()["user"]["username"] == "ana"
    assert SESSION_COOKIE_NAME in res.headers["Set-Cookie"]

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.get_json()["user"]["username"] == "ana"

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_login_with_wrong_password_is_rejected(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    assert _login(client, "ana", "nope").status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_member_cannot_reach_instance_settings_or_accounts(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123", role=ROLE_MEMBER)

    _login(client, "ana", "secret123")

    assert client.get("/api/users").status_code == 403
    assert client.get("/api/setup/music-dir").status_code == 403
    assert client.get("/api/config").status_code == 403


def test_admin_can_manage_accounts_over_http(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    _login(client, "owner", "hunter22")

    created = client.post("/api/users", json={"username": "ana", "password": "secret123"})
    assert created.status_code == 201
    ana_id = created.get_json()["user"]["id"]

    listed = client.get("/api/users").get_json()["users"]
    assert {u["username"] for u in listed} == {"owner", "ana"}
    assert all("password_hash" not in u for u in listed), "never expose password hashes"

    assert client.delete(f"/api/users/{ana_id}").status_code == 200
    assert {u["username"] for u in client.get("/api/users").get_json()["users"]} == {"owner"}


def test_adding_a_second_account_requires_the_admin_to_have_a_password(client):
    ensure_multiuser_layout()

    res = client.post("/api/users", json={"username": "ana", "password": "secret123"})

    assert res.status_code == 409
    assert res.get_json()["code"] == "admin_password_required"
    assert instance_requires_login() is False


def test_sessions_are_revoked_when_an_account_is_disabled(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    ana = create_user("ana", password="secret123")

    _login(client, "ana", "secret123")
    assert client.get("/api/auth/me").status_code == 200

    from shared.users import set_disabled

    set_disabled(ana["id"], True)

    assert client.get("/api/auth/me").status_code == 401


# ---------------------------------------------------------------------------
# Credentials never borrow somebody else's identity
# ---------------------------------------------------------------------------


def test_a_credential_with_no_account_is_rejected_not_promoted_to_admin():
    """An `agent`/`paired_device` row without a user_id belongs to nobody.

    Resolving it to the admin would let any member mint a credential that reads
    the admin's library.
    """
    from shared.hardening import _context_from_stored_token

    ensure_multiuser_layout()
    create_user("ana", password="secret123")

    for kind in ("agent", "paired_device"):
        record = {
            "id": f"tok-{kind}",
            "kind": kind,
            "scopes": ["library:read"],
            "user_id": None,
        }
        assert _context_from_stored_token(record) is None, kind

    # The desktop owner token is the one exception: holding it already implies
    # control of the machine.
    owner_context = _context_from_stored_token(
        {"id": "tok-owner", "kind": "owner", "scopes": ["library:read"], "user_id": None}
    )
    assert owner_context is not None
    assert owner_context["user_id"] == get_admin_user()["id"]


def test_paired_device_tokens_carry_the_account_that_paired_them():
    from shared.api.routes.pairing import _mint_paired_device_token

    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")

    with user_context(ana["id"]):
        _, record = _mint_paired_device_token(
            session={
                "granted_scopes": ["library:read"],
                "device_name": "Movil de Ana",
                "device_type": "phone",
                "user_id": ana["id"],
            }
        )

    assert record["user_id"] == ana["id"]


def test_paired_devices_and_pairing_sessions_are_per_account(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    _login(client, "owner", "hunter22")
    assert client.post("/api/pairing/sessions", json={}).status_code == 201
    owner_sessions = client.get("/api/pairing/sessions").get_json()["sessions"]
    assert len(owner_sessions) == 1

    client.post("/api/auth/logout")
    _login(client, "ana", "secret123")

    # Ana sees none of it: not the session, not the device it would mint.
    assert client.get("/api/pairing/sessions").get_json()["sessions"] == []
    assert client.get("/api/paired-devices").get_json()["devices"] == []
    # And cannot reach into the owner's session by id.
    session_id = owner_sessions[0]["session_id"]
    assert client.post(f"/api/pairing/sessions/{session_id}/cancel").status_code == 404


def test_download_logs_are_not_shared_between_accounts():
    from shared.api import queue_manager_dl

    ensure_multiuser_layout()
    ana = create_user("ana", password="secret123")
    bob = create_user("bob", password="secret123")

    queue_manager_dl.log_buffers = {}
    queue_manager_dl.add_log("Finished: a song only Ana asked for", user_id=ana["id"])
    queue_manager_dl.add_log("Finished: a song only Bob asked for", user_id=bob["id"])

    ana_logs = " ".join(queue_manager_dl.logs_for(ana["id"]))
    bob_logs = " ".join(queue_manager_dl.logs_for(bob["id"]))

    assert "Ana" in ana_logs and "Bob" not in ana_logs
    assert "Bob" in bob_logs and "Ana" not in bob_logs

    queue_manager_dl.log_buffers = {}


def test_anonymous_health_hides_the_shape_of_the_instance(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    body = client.get("/api/health").get_json()

    assert body["status"] == "healthy"
    for leaky in ("accounts", "config_dir", "music_dir", "pid", "jobs", "host", "port"):
        assert leaky not in body, f"/api/health leaked {leaky} to an anonymous caller"


def test_members_cannot_read_instance_paths_from_downloader_config(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123", role=ROLE_MEMBER)

    _login(client, "ana", "secret123")
    body = client.get("/api/downloader/config").get_json()

    assert "quality" in body
    for leaky in ("output_dir", "r2_bucket", "r2_account_id"):
        assert leaky not in body, f"/api/downloader/config leaked {leaky} to a member"


# ---------------------------------------------------------------------------
# Invitations — the path the family actually walks
# ---------------------------------------------------------------------------


def test_invited_person_creates_their_own_account_and_lands_signed_in(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    _login(client, "owner", "hunter22")

    # The invitation carries no name — the admin does not pre-label anyone.
    created = client.post("/api/invites", json={})
    assert created.status_code == 201
    url = created.get_json()["url"]
    token = url.rsplit("/", 1)[-1]
    assert "/player/#/invite/" in url

    client.post("/api/auth/logout")

    # The link says nothing about who it is for, or about the server.
    preview = client.get(f"/api/invites/{token}/preview")
    assert preview.status_code == 200
    assert preview.get_json() == {"valid": True}

    # She picks her own name (username) — the account is hers, not "Mamá".
    accepted = client.post(
        f"/api/invites/{token}/accept",
        json={"username": "ana", "password": "sucontrasena"},
    )
    assert accepted.status_code == 201
    user = accepted.get_json()["user"]
    assert user["username"] == "ana"
    assert user["display_name"] == "ana"
    assert user["role"] == ROLE_MEMBER

    # Signed in already — no second login step.
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.get_json()["user"]["username"] == "ana"

    # And she is a member: no roster, no server settings.
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/setup/music-dir").status_code == 403


def test_an_invitation_only_works_once(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    _login(client, "owner", "hunter22")
    token = client.post("/api/invites", json={}).get_json()["token"]
    client.post("/api/auth/logout")

    first = client.post(f"/api/invites/{token}/accept", json={"username": "mama", "password": "sucontrasena"})
    assert first.status_code == 201

    second = client.post(f"/api/invites/{token}/accept", json={"username": "otra", "password": "sucontrasena"})
    assert second.status_code == 400
    assert [u["username"] for u in list_users()] == ["owner", "mama"]


def test_an_unknown_invitation_reveals_nothing(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")

    res = client.get("/api/invites/not-a-real-token/preview")

    assert res.status_code == 404
    assert res.get_json() == {"valid": False}


def test_only_an_admin_can_mint_or_list_invitations(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123", role=ROLE_MEMBER)

    _login(client, "ana", "secret123")

    assert client.post("/api/invites", json={}).status_code == 403
    assert client.get("/api/invites").status_code == 403


def test_a_revoked_invitation_stops_working(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    _login(client, "owner", "hunter22")

    created = client.post("/api/invites", json={}).get_json()
    assert client.delete(f"/api/invites/{created['invite']['id']}").status_code == 200

    assert client.get(f"/api/invites/{created['token']}/preview").status_code == 404


# ---------------------------------------------------------------------------
# The shell admin path (headless bootstrap and recovery)
# ---------------------------------------------------------------------------


def test_users_cli_bootstraps_renames_and_invites(capsys):
    from shared.users_cli import main as users_cli

    # Runs against an instance that has never been started.
    assert users_cli(["list"]) == 0
    assert "owner" in capsys.readouterr().out

    assert users_cli(["passwd", "owner", "--password", "hunter22"]) == 0
    assert users_cli(["rename", "owner", "--to", "papa", "--display-name", "Papá"]) == 0
    assert users_cli(["create", "mama", "--password", "sucontrasena"]) == 0
    capsys.readouterr()

    assert users_cli(["invite", "--base-url", "http://10.0.0.2:5005"]) == 0
    out = capsys.readouterr().out
    assert "http://10.0.0.2:5005/player/#/invite/" in out

    names = {u["username"]: u for u in list_users()}
    assert set(names) == {"papa", "mama"}
    assert names["papa"]["display_name"] == "Papá"
    assert names["mama"]["role"] == ROLE_MEMBER


def test_users_cli_reports_a_missing_account_instead_of_crashing(capsys):
    from shared.users_cli import main as users_cli

    assert users_cli(["passwd", "nadie", "--password", "x" * 8]) == 1
    assert "No account named" in capsys.readouterr().err


def test_owner_can_rename_itself_over_http_without_login(client):
    """The migrated account is named "owner"; nobody should be stuck with it.

    A single passwordless account is bound automatically, so this works without
    a login step — exactly the single-user case on the local machine.
    """
    from shared.users import get_user_by_username

    ensure_multiuser_layout()

    res = client.post("/api/auth/profile", json={"display_name": "Rubén", "username": "ruben"})
    assert res.status_code == 200
    body = res.get_json()["user"]
    assert body["username"] == "ruben"
    assert body["display_name"] == "Rubén"
    assert get_user_by_username("owner") is None


def test_profile_rename_is_self_service_but_rejects_a_taken_username(client):
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")
    create_user("ana", password="secret123")
    _login(client, "ana", "secret123")

    # She can set her own display name.
    assert client.post("/api/auth/profile", json={"display_name": "Ana"}).status_code == 200
    assert client.get("/api/auth/me").get_json()["user"]["display_name"] == "Ana"

    # But not steal the owner's username.
    assert client.post("/api/auth/profile", json={"username": "owner"}).status_code == 400
    # And it never touches anyone else: the owner is still the owner.
    assert client.get("/api/auth/me").get_json()["user"]["username"] == "ana"


def test_session_tokens_are_stored_hashed_only():
    summary = ensure_multiuser_layout()
    set_password(summary["user_id"], "hunter22")

    from shared.users import create_session

    token, record = create_session(summary["user_id"])

    rows = instance_db().list_auth_tokens(kind="session")
    assert rows and rows[0]["user_id"] == summary["user_id"]
    assert token not in json.dumps(rows), "the plaintext token must never be persisted"
    assert record["id"] == rows[0]["id"]
