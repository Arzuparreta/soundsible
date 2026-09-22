"""Socket auth must leave all database connections available for the next event.

Socket.IO connect events bypass Flask's before_request/teardown_request hooks.
Their database work must return its loans without relying on those hooks.
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
