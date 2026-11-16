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


def _rate_key(remote, headers=None):
    from shared.security import request_rate_limit_key

    with _app.test_request_context("/", environ_base={"REMOTE_ADDR": remote}, headers=headers or {}):
        return request_rate_limit_key()


@pytest.mark.parametrize("remote, headers, key", [
    ("192.168.1.5", {}, "192.168.1.5"),
    ("81.2.69.160", {}, "81.2.69.160"),
    # Behind a proxy on this machine each client spends its own budget...
    ("127.0.0.1", {"X-Forwarded-For": "81.2.69.160"}, "81.2.69.160"),
    ("127.0.0.1", {"X-Forwarded-For": "6.6.6.6, 81.2.69.160"}, "81.2.69.160"),
    ("::1", {"X-Real-IP": "81.2.69.161"}, "81.2.69.161"),
    # ...funnel's clients included: counting is not trusting.
    ("127.0.0.1", {"X-Forwarded-For": "81.2.69.160", "Tailscale-Funnel-Request": "?1"}, "81.2.69.160"),
    # A proxy that names nobody leaves the proxy's own budget.
    ("127.0.0.1", {"X-Forwarded-Proto": "https"}, "127.0.0.1"),
    ("127.0.0.1", {}, "127.0.0.1"),
    # A LAN machine cannot pick a fresh key per request.
    ("192.168.1.5", {"X-Forwarded-For": "10.9.9.9"}, "192.168.1.5"),
    ("81.2.69.160", {"X-Forwarded-For": "10.9.9.9"}, "81.2.69.160"),
])
def test_rate_limit_key(remote, headers, key):
    assert _rate_key(remote, headers) == key


def test_proxied_clients_do_not_share_one_budget():
    from flask import jsonify
    from shared.hardening import _reset_rate_limits_for_tests, rate_limit

    app = Flask(__name__)

    @app.post("/login")
    @rate_limit("test_login", limit=1, window_sec=60)
    def login():
        return jsonify({"ok": True})

    _reset_rate_limits_for_tests()
    client = app.test_client()
    first = {"environ_base": {"REMOTE_ADDR": "127.0.0.1"}, "headers": {"X-Forwarded-For": "81.2.69.160"}}
    other = {"environ_base": {"REMOTE_ADDR": "127.0.0.1"}, "headers": {"X-Forwarded-For": "81.2.69.161"}}
    assert client.post("/login", **first).status_code == 200
    assert client.post("/login", **first).status_code == 429
    assert client.post("/login", **other).status_code == 200
    _reset_rate_limits_for_tests()


def test_agent_routes_need_a_token_even_where_the_network_is_trusted(passwordless_station):
    # Every request resolves its caller with trusted-network compatibility
    # first; the agent routes ask without it and must not inherit the owner.
    local = {"environ_base": {"REMOTE_ADDR": "127.0.0.1"}}
    assert passwordless_station.get("/api/users", **local).status_code == 200
    assert passwordless_station.get("/api/agent/verify", **local).status_code == 401
    assert passwordless_station.get("/api/pairing/verify", **local).status_code == 401
