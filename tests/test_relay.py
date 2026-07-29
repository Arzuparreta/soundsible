import json
from pathlib import Path
import socket
import threading
from urllib.request import urlopen

import pytest

from shared import relay_server
from shared.relay_cli import _unit_text


def test_tailscale_address_and_destination_contract():
    assert relay_server.is_tailscale_ipv4("100.91.167.48")
    assert not relay_server.is_tailscale_ipv4("192.168.1.4")
    assert relay_server._allowed_hostname("rr1---sn.googlevideo.com")
    assert relay_server._allowed_hostname("youtubei.googleapis.com")
    assert not relay_server._allowed_hostname("googlevideo.com.attacker.invalid")
    assert not relay_server._allowed_hostname("127.0.0.1")


def test_connect_public_rejects_private_dns(monkeypatch):
    monkeypatch.setattr(
        relay_server.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.20", 443)),
        ],
    )
    with pytest.raises(OSError, match="no permitted public address"):
        relay_server._connect_public("www.youtube.com", 443)


def test_health_is_available_to_allowed_station():
    server = relay_server.RelayTCPServer(
        ("127.0.0.1", 0),
        relay_server.RelayHandler,
        allowed_clients={"127.0.0.1"},
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urlopen(f"http://127.0.0.1:{server.server_address[1]}/healthz", timeout=2) as response:
            body = json.loads(response.read())
        assert body["status"] == "healthy"
        assert body["version"] == 1
        assert body["active_connections"] >= 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def test_systemd_unit_waits_for_tailscale_and_uses_repo_entrypoint():
    unit = _unit_text(
        repo_root=Path("/opt/soundsible"),
        user="soundsible",
        stations=["100.85.98.18"],
        port=8888,
    )
    assert "After=network-online.target tailscaled.service" in unit
    assert "WorkingDirectory=/opt/soundsible" in unit
    assert "python3 -m shared.relay_cli serve" in unit
    assert "--station 100.85.98.18" in unit
    assert "Restart=on-failure" in unit
