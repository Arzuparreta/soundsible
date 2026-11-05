"""Trust follows the caller, not the proxy in front of the engine."""
import pytest
from flask import Flask

from shared.security import is_trusted_network, request_client_address


@pytest.mark.parametrize("address, trusted", [
    ("127.0.0.1", True),
    ("::1", True),
    ("192.168.1.5", True),
    ("10.0.0.2", True),
    ("172.17.0.1", True),
    ("100.64.0.1", True),
    ("100.101.102.103", True),
    ("100.127.255.254", True),
    ("100.1.2.3", False),
    ("81.2.69.160", False),
    ("100.128.0.1", False),
    ("::ffff:192.168.1.5", True),
    ("::ffff:8.8.8.8", False),
    ("fd7a:115c:a1e0::1", True),
    ("8.8.8.8", False),
    ("unknown", False),
    ("", False),
    (None, False),
])
def test_trusted_networks(address, trusted):
    assert is_trusted_network(address) is trusted


_app = Flask(__name__)


def _client(remote, headers=None):
    with _app.test_request_context("/", environ_base={"REMOTE_ADDR": remote}, headers=headers or {}):
        return request_client_address()


@pytest.mark.parametrize("remote, headers, client", [
    # A direct connection is its own client.
    ("192.168.1.5", {}, "192.168.1.5"),
    ("127.0.0.1", {}, "127.0.0.1"),
    # A proxy on this machine: the nearest proxy's entry decides, never the
    # entries the client could have written itself.
    ("127.0.0.1", {"X-Forwarded-For": "81.2.69.160"}, "81.2.69.160"),
    ("127.0.0.1", {"X-Forwarded-For": "192.168.1.5, 81.2.69.160"}, "81.2.69.160"),
    ("127.0.0.1", {"X-Forwarded-For": "81.2.69.160:4711"}, "81.2.69.160"),
    ("172.18.0.4", {"X-Forwarded-For": "[2001:db8::1]:4711"}, "2001:db8::1"),
    ("127.0.0.1", {"X-Forwarded-For": " , "}, ""),
    # `tailscale serve` replaces X-Forwarded-For with the tailnet peer.
    ("127.0.0.1", {"X-Forwarded-For": "100.101.102.103"}, "100.101.102.103"),
    # `tailscale funnel` is the internet whatever address it reports.
    ("127.0.0.1", {"X-Forwarded-For": "100.101.102.103", "Tailscale-Funnel-Request": "?1"}, ""),
    ("127.0.0.1", {"Forwarded": 'for=192.0.2.60;proto=https, for="[2001:db8::2]:443"'}, "2001:db8::2"),
    ("127.0.0.1", {"X-Real-IP": "81.2.69.161"}, "81.2.69.161"),
    # A proxy that names nobody is not this machine.
    ("127.0.0.1", {"X-Forwarded-Proto": "https"}, ""),
    ("127.0.0.1", {"X-Forwarded-Host": "music.example.com"}, ""),
    # Headers from the internet are never believed.
    ("81.2.69.160", {"X-Forwarded-For": "127.0.0.1"}, "81.2.69.160"),
])
def test_client_address(remote, headers, client):
    assert _client(remote, headers) == client


@pytest.fixture
def passwordless_station(isolated_runtime):
    import shared.api as api
    from shared.multiuser_migration import ensure_multiuser_layout
    from shared.users import instance_requires_login

    ensure_multiuser_layout()
    assert not instance_requires_login()
    assert isolated_runtime.advanced_mode
    return api.app.test_client()


@pytest.mark.parametrize("remote, headers, status", [
    ("127.0.0.1", {}, 200),
    ("192.168.1.5", {}, 200),
    ("127.0.0.1", {"X-Forwarded-For": "100.101.102.103"}, 200),
    ("127.0.0.1", {"X-Forwarded-For": "192.168.1.5, 81.2.69.160"}, 403),
    ("127.0.0.1", {"X-Forwarded-For": "100.101.102.103", "Tailscale-Funnel-Request": "?1"}, 403),
    ("127.0.0.1", {"X-Forwarded-Proto": "https"}, 403),
    ("100.1.2.3", {}, 403),
    ("8.8.8.8", {}, 403),
])
def test_passwordless_admin_needs_a_local_caller(passwordless_station, remote, headers, status):
    response = passwordless_station.get("/api/users", environ_base={"REMOTE_ADDR": remote}, headers=headers)
    assert response.status_code == status
