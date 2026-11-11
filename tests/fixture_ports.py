"""A port for a subprocess that will only bind it much later.

The Android fixture engines are started with `--port N` and spend up to a
minute encoding and measuring audio before they listen on it. Asking the
kernel for a free port (`bind(("127.0.0.1", 0))`), closing it and passing the
number on leaves that whole minute for something else to be given the same
port: under `pytest -n 4` another worker's probe, server or outgoing
connection was, and the engine died with `Address already in use`.

These ports come from below Linux's ephemeral range (32768–60999), which the
kernel never hands out on its own, and from a block per xdist worker, so no
two workers can pick the same one.
"""
from __future__ import annotations

import itertools
import os
import re
import socket

_BLOCK = 200
_FIRST = 21000
_next = itertools.count()


def late_bound_port() -> int:
    worker = int(re.sub(r"\D", "", os.environ.get("PYTEST_XDIST_WORKER", "")) or 0)
    base = _FIRST + worker * _BLOCK
    for _ in range(_BLOCK):
        port = base + next(_next) % _BLOCK
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError(f"No free port in {base}-{base + _BLOCK - 1}")
