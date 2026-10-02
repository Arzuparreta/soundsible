import os
import socket

import pytest

from shared.service_guard import (
    _owner_from_cgroup,
    listener_pid,
    pid_owns_listener,
    service_owner,
)


@pytest.mark.skipif(os.name != "posix", reason="/proc is where the answer lives")
def test_a_process_owns_the_port_it_listens_on():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        assert pid_owns_listener(os.getpid(), port)
        assert not pid_owns_listener(-1, port)


@pytest.mark.skipif(os.name != "posix", reason="/proc is where the answer lives")
def test_listener_pid_names_the_process_holding_the_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        assert listener_pid(listener.getsockname()[1]) == os.getpid()


def test_cgroup_reading_finds_the_unit_that_owns_a_process():
    assert _owner_from_cgroup("0::/system.slice/soundsible.service\n") == (
        "soundsible.service",
        False,
    )
    # A user unit lives under user@<uid>.service, which is not the answer.
    user_unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/soundsible.service\n"
    assert _owner_from_cgroup(user_unit) == ("soundsible.service", True)
    assert _owner_from_cgroup(user_unit).stop_command() == (
        "systemctl --user stop soundsible.service"
    )
    legacy = "9:memory:/system.slice/soundsible.service\n1:name=systemd:/system.slice/soundsible.service\n"
    assert _owner_from_cgroup(legacy).unit == "soundsible.service"


def test_a_process_outside_any_unit_has_no_owner():
    assert _owner_from_cgroup("0::/user.slice/user-1000.slice/session-3.scope\n") is None
    assert _owner_from_cgroup("0::/\n") is None
    assert service_owner(-1) is None
