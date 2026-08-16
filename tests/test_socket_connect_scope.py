"""`on_socket_connect` must return its pooled DB connection when it's done.

Socket.IO 'connect' events never pass through Flask's before_request/
teardown_request, so before this handler was wrapped in
`request_scope.request_scope()`, any connection acquired while resolving auth
(`get_request_auth_context`, `instance_requires_login`) had nowhere to be
released to — `request_scope.on_end` is a no-op outside a scope — and leaked
from the pool permanently. Every routine socket reconnect (phone sleep/wake,
tab refocus, a network blip) burned one of the pool's 16 slots for good; see
`shared.database.ConnectionPool`.
"""

from unittest.mock import patch

from shared.api import app, on_socket_connect
from shared.database import instance_db


def test_on_socket_connect_returns_its_pool_connection():
    # Room-joining needs a real Socket.IO dispatch context (request.sid);
    # this test is only about the DB connection the handler acquires while
    # resolving auth, so the room join itself is stubbed out.
    with patch("shared.api._join_user_room_for_socket"):
        with app.test_request_context("/socket.io/"):
            on_socket_connect()

    stats = instance_db().pool_stats()
    assert stats["created"] >= 1, "connect handler never touched the instance DB"
    assert stats["idle"] == stats["created"], (
        "connect handler leaked a connection out of the pool: "
        f"{stats['created'] - stats['idle']} still checked out"
    )
