"""Restricted residential egress relay for a Soundsible VPS.

The relay is deliberately not a general-purpose proxy.  It listens on a
Tailscale address, admits only configured Station tailnet IPs, and can connect
only to the small public-host set needed by YouTube extraction and streaming.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import select
import socket
import socketserver
import subprocess
import threading
import time
from typing import Iterable
from urllib.parse import urlsplit

LOGGER = logging.getLogger("soundsible-relay")
HEADER_LIMIT = 64 * 1024
BUFFER_SIZE = 256 * 1024
CONNECT_TIMEOUT = 15
IDLE_TIMEOUT = 300
ALLOWED_PORTS = frozenset({80, 443})
ALLOWED_SUFFIXES = (
    "youtube.com",
    "youtube-nocookie.com",
    "googlevideo.com",
    "ytimg.com",
    "googleapis.com",
)


def is_tailscale_ipv4(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return isinstance(address, ipaddress.IPv4Address) and address in ipaddress.ip_network("100.64.0.0/10")


def wait_for_tailscale_ipv4(timeout_sec: float = 120.0) -> str:
    deadline = time.monotonic() + max(1.0, timeout_sec)
    last_error = "no Tailscale IPv4 address"
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(
                ["tailscale", "ip", "-4"],
                check=True,
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in result.stdout.splitlines():
                candidate = line.strip()
                if is_tailscale_ipv4(candidate):
                    return candidate
        except (OSError, subprocess.SubprocessError) as exc:
            last_error = str(exc)
        time.sleep(1)
    raise TimeoutError(f"Tailscale address unavailable after {timeout_sec:.0f}s: {last_error}")


def _allowed_hostname(host: str) -> bool:
    normalized = host.rstrip(".").lower()
    if not normalized or ":" in normalized:
        return False
    try:
        ipaddress.ip_address(normalized)
        return False
    except ValueError:
        pass
    return any(normalized == suffix or normalized.endswith(f".{suffix}") for suffix in ALLOWED_SUFFIXES)


def _is_public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _connect_public(host: str, port: int) -> socket.socket:
    if not _allowed_hostname(host) or port not in ALLOWED_PORTS:
        raise PermissionError("destination is not allowed")
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    last_error: OSError | None = None
    for family, socktype, proto, _, sockaddr in addresses:
        if not _is_public_address(sockaddr[0]):
            continue
        candidate = socket.socket(family, socktype, proto)
        candidate.settimeout(CONNECT_TIMEOUT)
        try:
            candidate.connect(sockaddr)
            candidate.settimeout(None)
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            candidate.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            return candidate
        except OSError as exc:
            last_error = exc
            candidate.close()
    raise OSError(str(last_error or "destination has no permitted public address"))


def _read_headers(client: socket.socket) -> tuple[bytes, bytes]:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        remaining = HEADER_LIMIT - len(data)
        if remaining <= 0:
            raise ValueError("request headers exceed limit")
        chunk = client.recv(min(BUFFER_SIZE, remaining))
        if not chunk:
            raise ConnectionError("client closed before complete headers")
        data.extend(chunk)
    head, rest = bytes(data).split(b"\r\n\r\n", 1)
    return head + b"\r\n\r\n", rest


def _authority(value: str, default_port: int) -> tuple[str, int]:
    parsed = urlsplit(f"//{value}")
    if not parsed.hostname:
        raise ValueError("request has no destination host")
    return parsed.hostname, parsed.port or default_port


def _http_target(target: str, headers: bytes) -> tuple[str, int, bytes]:
    parsed = urlsplit(target)
    if parsed.hostname:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        origin = parsed.path or "/"
        if parsed.query:
            origin += f"?{parsed.query}"
        first, remainder = headers.split(b"\r\n", 1)
        method, _, version = first.split(b" ", 2)
        rewritten = b" ".join((method, origin.encode("ascii"), version)) + b"\r\n" + remainder
        return parsed.hostname, port, rewritten
    host_header = next(
        (
            line.split(b":", 1)[1].strip().decode("ascii")
            for line in headers.split(b"\r\n")
            if line.lower().startswith(b"host:")
        ),
        "",
    )
    host, port = _authority(host_header, 80)
    return host, port, headers


def _relay(client: socket.socket, remote: socket.socket) -> int:
    transferred = 0
    peers = {client: remote, remote: client}
    while peers:
        readable, _, exceptional = select.select(list(peers), [], list(peers), IDLE_TIMEOUT)
        if exceptional:
            return transferred
        if not readable:
            raise TimeoutError(f"connection idle for {IDLE_TIMEOUT}s")
        for source in readable:
            data = source.recv(BUFFER_SIZE)
            if not data:
                return transferred
            peers[source].sendall(data)
            transferred += len(data)
    return transferred


class RelayState:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.active = 0
        self.completed = 0
        self.rejected = 0
        self.bytes = 0
        self.last_error: str | None = None
        self.lock = threading.Lock()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "status": "healthy",
                "version": 1,
                "uptime_seconds": round(time.time() - self.started_at, 3),
                "active_connections": self.active,
                "completed_connections": self.completed,
                "rejected_connections": self.rejected,
                "relayed_bytes": self.bytes,
                "last_error": self.last_error,
            }


class RelayHandler(socketserver.BaseRequestHandler):
    server: "RelayTCPServer"

    def _health(self) -> None:
        body = json.dumps(self.server.state.snapshot(), separators=(",", ":")).encode()
        self.request.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )

    def handle(self) -> None:
        client_ip = self.client_address[0]
        if client_ip not in self.server.allowed_clients:
            with self.server.state.lock:
                self.server.state.rejected += 1
            LOGGER.warning("rejected client=%s", client_ip)
            return
        client = self.request
        client.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        remote: socket.socket | None = None
        target_label = "unknown"
        with self.server.state.lock:
            self.server.state.active += 1
        try:
            headers, remainder = _read_headers(client)
            first = headers.split(b"\r\n", 1)[0]
            method_raw, target_raw, _ = first.split(b" ", 2)
            method = method_raw.decode("ascii").upper()
            target = target_raw.decode("ascii")
            if method == "GET" and target in {"/healthz", "http://soundsible-relay.invalid/healthz"}:
                self._health()
                return
            if method == "CONNECT":
                host, port = _authority(target, 443)
                outbound = remainder
            elif method in {"GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"}:
                host, port, rewritten = _http_target(target, headers)
                outbound = rewritten + remainder
            else:
                client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
                return
            target_label = f"{host}:{port}"
            remote = _connect_public(host, port)
            if method == "CONNECT":
                client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if outbound:
                remote.sendall(outbound)
            transferred = _relay(client, remote)
            with self.server.state.lock:
                self.server.state.bytes += transferred
                self.server.state.completed += 1
        except (ConnectionError, OSError, PermissionError, TimeoutError, ValueError) as exc:
            with self.server.state.lock:
                self.server.state.last_error = f"{type(exc).__name__}: {exc}"[:300]
                if isinstance(exc, PermissionError):
                    self.server.state.rejected += 1
            LOGGER.warning("relay error client=%s target=%s type=%s", client_ip, target_label, type(exc).__name__)
        finally:
            with self.server.state.lock:
                self.server.state.active = max(0, self.server.state.active - 1)
            if remote is not None:
                remote.close()
            client.close()


class RelayTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, address: tuple[str, int], handler, *, allowed_clients: Iterable[str]):
        self.allowed_clients = frozenset(allowed_clients)
        self.state = RelayState()
        super().__init__(address, handler)


def serve(*, bind: str, port: int, stations: Iterable[str], wait_sec: float = 120.0) -> None:
    bind_ip = wait_for_tailscale_ipv4(wait_sec) if bind == "auto" else bind
    if not is_tailscale_ipv4(bind_ip):
        raise ValueError("relay bind must be a Tailscale IPv4 address")
    allowed = {station for station in stations if is_tailscale_ipv4(station)}
    if not allowed:
        raise ValueError("at least one valid Station Tailscale IPv4 is required")
    with RelayTCPServer((bind_ip, port), RelayHandler, allowed_clients=allowed) as server:
        LOGGER.info(
            "listening bind=%s port=%d allowed_clients=%s",
            bind_ip,
            port,
            ",".join(sorted(allowed)),
        )
        server.serve_forever(poll_interval=0.5)
