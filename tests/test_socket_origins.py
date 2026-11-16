"""Which pages may open the real-time connection.

Engine.IO refuses a handshake whose `Origin` it does not accept; a browser
applies no CORS to WebSockets, so this is the only thing keeping an unrelated
page from listening to library, downloader and playback events.
"""

import re

import pytest

from shared.api.origins import make_socket_origin_check, rest_origins, socket_origins

LAN_PATTERNS = [re.compile(r"^https?://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$", re.IGNORECASE)]


def _environ(host="192.168.1.10:5005", remote="192.168.1.20", **extra):
    return {"HTTP_HOST": host, "REMOTE_ADDR": remote, "wsgi.url_scheme": "http", **extra}


@pytest.mark.parametrize("origin, environ, allowed", [
    # The player served by the engine itself.
    ("http://192.168.1.10:5005", _environ(), True),
    ("http://station.local:5005", _environ(host="station.local:5005"), True),
    ("HTTP://Station.Local:5005", _environ(host="station.local:5005"), True),
    # `tailscale serve` terminates TLS on this machine and forwards the host.
    ("https://station.tail1234.ts.net",
     _environ(host="127.0.0.1:5005", remote="127.0.0.1",
              HTTP_X_FORWARDED_HOST="station.tail1234.ts.net", HTTP_X_FORWARDED_PROTO="https"), True),
    # A proxy that keeps Host but says nothing about TLS.
    ("https://music.example", _environ(host="music.example", remote="127.0.0.1"), True),
    # A forwarded host is only believed from a peer on this machine, LAN or tailnet.
    ("https://evil.example",
     _environ(host="81.2.69.160:5005", remote="81.2.69.161", HTTP_X_FORWARDED_HOST="evil.example"), False),
    # The configured list, for pages on another LAN address.
    ("http://192.168.1.30:8080", _environ(), True),
    # Anything else.
    ("https://evil.example", _environ(), False),
    ("http://station.local:5006", _environ(host="station.local:5005"), False),
    ("null", _environ(), False),
    (None, _environ(), False),
    ("", _environ(), False),
])
def test_socket_origin_check(origin, environ, allowed):
    assert make_socket_origin_check(LAN_PATTERNS)(origin, environ) is allowed


def test_literal_configured_origins_match_whole_and_case_insensitively(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_SOCKET_CORS_ORIGINS", "https://Music.Example, http://10.0.0.4:5005")
    check = make_socket_origin_check(socket_origins())
    assert check("https://music.example", _environ()) is True
    assert check("http://10.0.0.4:5005", _environ()) is True
    assert check("https://music.example.evil", _environ()) is False


def test_socket_follows_the_rest_list_unless_configured(monkeypatch, isolated_runtime):
    monkeypatch.delenv("SOUNDSIBLE_SOCKET_CORS_ORIGINS", raising=False)
    monkeypatch.setenv("SOUNDSIBLE_ALLOWED_ORIGINS", "http://192.168.1.30:8080")
    assert socket_origins() == rest_origins() == ["http://192.168.1.30:8080"]


def test_loopback_engine_allows_only_localhost_pages(monkeypatch, isolated_runtime):
    monkeypatch.delenv("SOUNDSIBLE_ALLOWED_ORIGINS", raising=False)
    check = make_socket_origin_check(rest_origins())
    assert check("http://localhost:4173", _environ(host="127.0.0.1:5005")) is True
    assert check("http://192.168.1.30:8080", _environ(host="127.0.0.1:5005")) is False


@pytest.mark.parametrize("headers, status", [
    ({"Origin": "https://evil.example"}, 400),
    ({"Origin": "http://localhost"}, 200),
    # Native clients (OkHttp) send no Origin.
    ({}, 200),
])
def test_engine_refuses_the_handshake_from_another_origin(isolated_runtime, headers, status):
    import shared.api as api

    response = api.app.test_client().get(
        "/socket.io/?EIO=4&transport=polling",
        headers=headers,
        environ_base={"REMOTE_ADDR": "127.0.0.1"},
    )
    assert response.status_code == status
    if status == 400:
        assert b"Not an accepted origin" in response.data
