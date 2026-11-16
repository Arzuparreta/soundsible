"""A socket keeps an account's private events only while its credential would
still let it connect.

Admission happens once, at the handshake. Logging out, revoking a paired
device, disabling the account or the session expiring used to leave an open
socket subscribed until it happened to reconnect.
"""

import hashlib
import uuid

import pytest

from shared.database import instance_db


def _token(user_id, *, kind="agent", scopes=("playback:control", "library:read")):
    raw = uuid.uuid4().hex
    instance_db().create_auth_token(
        str(uuid.uuid4()), hashlib.sha256(raw.encode()).hexdigest(), name="test",
        kind=kind, scopes=list(scopes), user_id=user_id,
    )
    return raw


@pytest.fixture
def station(isolated_runtime):
    import shared.api as api
    from shared.multiuser_migration import ensure_multiuser_layout
    from shared.users import create_user, get_admin_user

    ensure_multiuser_layout()
    admin = get_admin_user()
    from shared.users import set_password

    set_password(admin["id"], "admin-password-1")
    member = create_user("member", password="member-password-1")
    api._admitted_sockets.clear()
    yield api, member
    api._admitted_sockets.clear()


def _connect(api, token):
    client = api.socketio.test_client(api.app, headers={"Authorization": f"Bearer {token}"})
    assert client.is_connected()
    return client


def test_a_disabled_accounts_agent_token_is_refused(station):
    api, member = station
    from shared.users import set_disabled

    token = _token(member["id"])
    client = api.app.test_client()
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/agent/verify", headers=headers).status_code == 200
    set_disabled(member["id"], True)
    assert client.get("/api/agent/verify", headers=headers).status_code == 401


def test_an_open_socket_is_dropped_once_its_credential_is_revoked(station):
    api, member = station
    token = _token(member["id"])
    socket = _connect(api, token)
    assert api.recheck_sockets() == 0
    assert socket.is_connected()

    record = instance_db().get_auth_token_by_hash(hashlib.sha256(token.encode()).hexdigest())
    instance_db().revoke_auth_token(record["id"])

    assert api.recheck_sockets() == 1
    assert not socket.is_connected()


def test_an_open_socket_is_dropped_once_its_account_is_disabled(station):
    api, member = station
    from shared.users import set_disabled

    socket = _connect(api, _token(member["id"]))
    set_disabled(member["id"], True)

    assert api.recheck_sockets() == 1
    assert not socket.is_connected()
