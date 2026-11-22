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
    from flask import request

    with patch("shared.api.join_room"):
        with app.test_request_context("/socket.io/"):
            request.sid = "pool-socket"
            on_socket_connect()

    stats = instance_db().pool_stats()
    assert stats["created"] >= 1, "connect handler never touched the instance DB"
    assert stats["idle"] == stats["created"], (
        "connect handler leaked a connection out of the pool: "
        f"{stats['created'] - stats['idle']} still checked out"
    )


def test_playback_registration_uses_socket_account_and_restores_context():
    from flask import request
    from shared.api import on_playback_register
    from shared.user_context import current_user_id

    previous_user = current_user_id()
    fake_row = {"device_id": "android-device", "device_type": "android", "online": True}
    with app.test_request_context('/socket.io/'):
        request.sid = 'android-socket'
        with patch('shared.api._resolve_request_user_id', return_value='member-id'), \
                patch('shared.api.register_socket_instance', return_value=(fake_row, None)) as reg, \
                patch('shared.api.emit_device_updated') as emit_updated:
            on_playback_register({
                'device_id': 'android-device',
                'device_type': 'android',
                'form_factor': 'phone',
                'instance_id': 'inst-1',
                'protocol': 1,
                'commands': ['transport.play'],
            })
        reg.assert_called_once_with(
            'member-id',
            'android-device',
            'android-socket',
            device_name=None,
            device_type='android',
            form_factor='phone',
            instance_id='inst-1',
            protocol=1,
            commands=['transport.play'],
        )
        emit_updated.assert_called_once_with('member-id', fake_row)
        assert current_user_id() == previous_user


def test_playback_registration_ignores_socket_without_account():
    from shared.api import on_playback_register

    with app.test_request_context('/socket.io/'):
        with patch('shared.api._resolve_request_user_id', return_value=None), \
                patch('shared.api.register_socket_instance') as reg:
            on_playback_register({'device_id': 'unowned-device'})
        reg.assert_not_called()
