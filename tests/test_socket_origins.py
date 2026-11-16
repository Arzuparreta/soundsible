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
    # A proxy that keeps Host and says the browser used TLS.
    ("https://music.example",
     _environ(host="music.example", remote="127.0.0.1", HTTP_X_FORWARDED_PROTO="https"), True),
    ("https://music.example:443",
     _environ(host="music.example", remote="127.0.0.1", HTTP_X_FORWARDED_PROTO="https"), True),
    # The same host on the other scheme is another origin, even behind a proxy...
    ("http://music.example",
     _environ(host="127.0.0.1:5005", remote="127.0.0.1",
              HTTP_X_FORWARDED_HOST="music.example", HTTP_X_FORWARDED_PROTO="https"), False),
    # ...and a TLS proxy that does not say so needs its address configured.
    ("https://music.example", _environ(host="music.example", remote="127.0.0.1"), False),
    # A forwarded scheme is only believed from a trusted peer.
    ("https://station.local:5005",
     _environ(host="station.local:5005", remote="81.2.69.161", HTTP_X_FORWARDED_PROTO="https"), False),
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


def test_a_wildcard_allows_every_page(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_SOCKET_CORS_ORIGINS", "*")
    assert make_socket_origin_check(socket_origins())("https://anything.example", _environ()) is True


@pytest.mark.parametrize("variable", ["SOUNDSIBLE_ALLOWED_ORIGINS", "SOUNDSIBLE_SOCKET_CORS_ORIGINS"])
def test_the_engine_starts_with_a_wildcard_origin(variable, tmp_path):
    """`*` was a valid setting for both before they shared a parser."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    env = {**os.environ, variable: "*", "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "config"),
           "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"), "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache")}
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, "-c", "import shared.api"], cwd=root, env=env,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]


def test_an_ipv6_origin_is_a_literal_not_a_character_class(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_SOCKET_CORS_ORIGINS", "http://[::1]:4173")
    check = make_socket_origin_check(socket_origins())
    assert check("http://[::1]:4173", _environ()) is True
    assert check("http://:", _environ()) is False
    assert check("http://[::1]:41730", _environ()) is False


def test_rest_cors_accepts_a_configured_ipv6_origin(monkeypatch):
    from flask import Flask
    from flask_cors import CORS

    monkeypatch.setenv("SOUNDSIBLE_ALLOWED_ORIGINS", "http://[::1]:4173")
    app = Flask(__name__)
    CORS(app, origins=rest_origins())
    app.add_url_rule("/x", "x", lambda: "ok")
    allowed = app.test_client().get("/x", headers={"Origin": "http://[::1]:4173"})
    other = app.test_client().get("/x", headers={"Origin": "http://[::2]:4173"})
    assert allowed.headers.get("Access-Control-Allow-Origin") == "http://[::1]:4173"
    assert "Access-Control-Allow-Origin" not in other.headers
