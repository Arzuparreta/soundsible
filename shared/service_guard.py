"""Small systemd preflight/readiness checks for the Station Engine.

This module intentionally depends only on the standard library plus
``shared.runtime``. It must be able to explain a port collision before the
full application (and its optional dependencies) starts importing.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import NamedTuple, Optional
from urllib.error import URLError
from urllib.request import urlopen

from shared.runtime import RuntimeConfig


def _connect_host(host: str) -> str:
    return "127.0.0.1" if host in {"", "0.0.0.0", "::"} else host


def _listener_inodes(port: int) -> set[str]:
    target = f"{port:04X}"
    inodes: set[str] = set()
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        try:
            lines = table.read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":
                continue
            if fields[1].rsplit(":", 1)[-1].upper() == target:
                inodes.add(fields[9])
    return inodes


def _process_socket_inodes(pid: int) -> set[str]:
    sockets: set[str] = set()
    try:
        # ``Path.iterdir`` is lazy: opening a protected fd directory raises on
        # first iteration, outside the old try block, on hardened CI hosts.
        descriptors = list((Path("/proc") / str(pid) / "fd").iterdir())
    except OSError:
        return sockets
    for descriptor in descriptors:
        try:
            target = os.readlink(descriptor)
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            sockets.add(target[8:-1])
    return sockets


def pid_owns_listener(pid: int, port: int) -> bool:
    """Whether ``pid`` owns a listening socket on ``port`` (Linux /proc)."""
    if pid <= 0:
        return False
    listeners = _listener_inodes(port)
    return bool(listeners and listeners & _process_socket_inodes(pid))


def listener_pid(port: int) -> Optional[int]:
    """PID listening on ``port``, or None when /proc cannot say (Linux only)."""
    listeners = _listener_inodes(port)
    if not listeners:
        return None
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return None
    for proc in entries:
        if not proc.name.isdigit():
            continue
        pid = int(proc.name)
        if listeners & _process_socket_inodes(pid):
            return pid
    return None


def _process_command(pid: int) -> str:
    try:
        return (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
    except OSError:
        return ""


class ServiceOwner(NamedTuple):
    """The systemd unit a process belongs to, and how to address it."""

    unit: str
    user_scope: bool

    def stop_command(self) -> str:
        if self.user_scope:
            return f"systemctl --user stop {self.unit}"
        return f"sudo systemctl stop {self.unit}"


def _owner_from_cgroup(cgroup: str) -> Optional[ServiceOwner]:
    """Read a unit out of /proc/<pid>/cgroup, for v1 and v2 layouts.

    The last ``.service`` component is the unit that actually owns the
    process: a user unit lives under ``user@<uid>.service``, which is a
    service of its own and must not be mistaken for the answer. Anything
    else — a login session, a plain shell — is nobody's unit.
    """
    for line in cgroup.splitlines():
        path = line.rsplit(":", 1)[-1]
        units = [part for part in path.split("/") if part.endswith(".service")]
        if not units:
            continue
        unit = units[-1]
        if unit.startswith("user@"):
            continue
        return ServiceOwner(unit=unit, user_scope="/user@" in path)
    return None


def service_owner(pid: int) -> Optional[ServiceOwner]:
    """The systemd unit running ``pid``, when there is one (Linux only)."""
    if pid <= 0 or not sys.platform.startswith("linux"):
        return None
    try:
        cgroup = (Path("/proc") / str(pid) / "cgroup").read_text(encoding="utf-8")
    except OSError:
        return None
    return _owner_from_cgroup(cgroup)


def _listener_details(port: int) -> str:
    pid = listener_pid(port)
    if pid is None:
        return "unknown process"
    command = _process_command(pid)
    return f"PID {pid}{f' ({command})' if command else ''}"


def preflight(runtime: RuntimeConfig) -> int:
    """Fail immediately when another process already owns the configured port."""
    host = _connect_host(runtime.host)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        occupied = probe.connect_ex((host, runtime.port)) == 0
    if not occupied:
        return 0
    print(
        f"Soundsible cannot start: {host}:{runtime.port} is already owned by "
        f"{_listener_details(runtime.port)}.",
        file=sys.stderr,
    )
    return 1


def wait_ready(runtime: RuntimeConfig, *, pid: int, timeout: float) -> int:
    """Wait for health and verify systemd's main process owns the listener."""
    host = _connect_host(runtime.host)
    url = f"http://{host}:{runtime.port}/api/health"
    deadline = time.monotonic() + timeout
    last_error = "engine did not answer"
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=1.0) as response:
                payload = json.loads(response.read())
            if payload.get("status") == "healthy":
                if sys.platform.startswith("linux") and not pid_owns_listener(pid, runtime.port):
                    last_error = f"health answered, but PID {pid} does not own port {runtime.port}"
                else:
                    return 0
        except (OSError, URLError, ValueError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(0.2)
    print(f"Soundsible failed its startup check: {last_error}.", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Soundsible systemd startup guard")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("preflight")
    ready = subparsers.add_parser("ready")
    ready.add_argument("--pid", type=int, required=True)
    ready.add_argument("--timeout", type=float, default=30.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    runtime = RuntimeConfig.default()
    if args.command == "preflight":
        return preflight(runtime)
    return wait_ready(runtime, pid=args.pid, timeout=args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
