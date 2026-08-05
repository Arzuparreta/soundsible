import argparse
import json
from pathlib import Path
import socket
import threading
from urllib.request import urlopen

import pytest

from shared import relay_server
from shared import relay_cli
from shared.relay_cli import _unit_text, describe_listener, installed_port


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


def _install_args(tmp_path: Path, **overrides) -> argparse.Namespace:
    defaults = {
        "station": ["100.85.98.18"],
        "port": 8888,
        "user": "soundsible",
        "no_start": True,
        "force": False,
    }
    return argparse.Namespace(**{**defaults, **overrides})


@pytest.fixture
def install_env(tmp_path, monkeypatch):
    """Make _install believe it runs as root on systemd, writing into tmp_path."""
    unit_path = tmp_path / "soundsible-relay.service"
    monkeypatch.setattr(relay_cli, "RELAY_UNIT_PATH", unit_path)
    monkeypatch.setattr(relay_cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(relay_cli, "_systemd_available", lambda: True)
    monkeypatch.setattr(relay_cli, "_unit_is_active", lambda unit=relay_cli.RELAY_UNIT: False)
    monkeypatch.setattr(relay_cli, "describe_listener", lambda port: None)
    monkeypatch.setattr(relay_cli.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(relay_cli, "wait_for_tailscale_ipv4", lambda timeout: "100.85.98.18")
    return unit_path


def test_install_refuses_a_port_another_process_owns(install_env, monkeypatch, capsys):
    monkeypatch.setattr(relay_cli, "describe_listener", lambda port: "jupyter-notebook")
    assert relay_cli._install(_install_args(install_env.parent)) == 2
    assert "already in use by jupyter-notebook" in capsys.readouterr().err
    assert not install_env.exists()


def test_install_proceeds_when_the_port_is_ours_already(install_env, monkeypatch):
    monkeypatch.setattr(relay_cli, "_unit_is_active", lambda unit=relay_cli.RELAY_UNIT: True)
    monkeypatch.setattr(relay_cli, "installed_port", lambda: 8888)
    monkeypatch.setattr(relay_cli, "describe_listener", lambda port: "soundsible relay")
    assert relay_cli._install(_install_args(install_env.parent)) == 0


def test_install_will_not_clobber_a_foreign_unit_file(install_env, capsys):
    install_env.write_text("[Service]\nExecStart=/usr/bin/true\n", encoding="utf-8")
    assert relay_cli._install(_install_args(install_env.parent)) == 2
    assert "already exists and differs" in capsys.readouterr().err
    assert "ExecStart=/usr/bin/true" in install_env.read_text(encoding="utf-8")


def test_install_replaces_a_foreign_unit_file_with_force(install_env):
    install_env.write_text("[Service]\nExecStart=/usr/bin/true\n", encoding="utf-8")
    assert relay_cli._install(_install_args(install_env.parent, force=True)) == 0
    assert "shared.relay_cli serve" in install_env.read_text(encoding="utf-8")


def test_install_is_idempotent_when_the_unit_already_matches(install_env):
    assert relay_cli._install(_install_args(install_env.parent)) == 0
    first = install_env.read_text(encoding="utf-8")
    assert relay_cli._install(_install_args(install_env.parent)) == 0
    assert install_env.read_text(encoding="utf-8") == first


def test_describe_listener_reports_free_and_taken_ports():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        port = taken.getsockname()[1]
        assert describe_listener(port) is not None
    assert describe_listener(port) is None


def test_describe_listener_does_not_call_a_privileged_port_a_conflict():
    """Binding port 1 fails on permissions, not ownership; that is not a clash."""
    assert describe_listener(1) is None


def test_installed_port_reads_the_unit_and_tolerates_a_missing_file(tmp_path):
    unit = tmp_path / "unit"
    assert installed_port(unit) is None
    unit.write_text(_unit_text(repo_root=tmp_path, user="u", stations=["100.1.1.1"], port=9999))
    assert installed_port(unit) == 9999
