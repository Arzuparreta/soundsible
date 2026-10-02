"""Which process owns the Station Engine's port, and which systemd unit runs it.

Linux only: the answers come from /proc. Elsewhere every lookup says it
cannot tell.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import NamedTuple, Optional


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
