#!/usr/bin/env python3
"""TLS terminator in front of the plain-HTTP Android fixture engine.

The engine never serves TLS itself in production: it listens on plain HTTP
behind `tailscale serve`, Caddy or another reverse proxy. This process plays
that proxy for the `https://10.0.2.2:5099` fixture. It terminates TLS with the
ephemeral certificate from `android_test_tls.py`, adds the headers such a proxy
sends (`X-Forwarded-For`, `-Proto`, `-Host`, replacing any the client wrote)
to every request head, and otherwise relays bytes unchanged both ways:
responses, request bodies, and everything after a websocket upgrade. When
either side closes or fails, both connections are closed.

Run: python scripts/android_tls_proxy.py --port 5099 --upstream 15099 --cert server.pem --key server-key.pem
"""

from __future__ import annotations

import argparse
import asyncio
import ssl

HEAD_LIMIT = 64 * 1024
FORWARDED = (b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host")


async def _copy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, size: int | None = None) -> None:
    """Relay `size` bytes, or everything until EOF when `size` is None."""
    while size is None or size > 0:
        chunk = await reader.read(65536 if size is None else min(size, 65536))
        if not chunk:
            if size is None:
                return
            raise ConnectionError("body ended early")
        writer.write(chunk)
        await writer.drain()
        if size is not None:
            size -= len(chunk)


async def _requests(client: asyncio.StreamReader, upstream: asyncio.StreamWriter, peer: str) -> None:
    """Forward request heads with proxy headers, their bodies, then raw bytes after an upgrade."""
    while True:
        try:
            head = await client.readuntil(b"\r\n\r\n")
        except asyncio.IncompleteReadError as error:
            if error.partial:
                raise ConnectionError("request head ended early") from None
            return
        request_line, *fields = head[:-4].split(b"\r\n")
        headers = {}
        kept = []
        for field in fields:
            name, _, value = field.partition(b":")
            key = name.strip().lower()
            headers[key] = value.strip()
            if key not in FORWARDED:
                kept.append(field)
        kept += [
            b"X-Forwarded-For: " + peer.encode(),
            b"X-Forwarded-Proto: https",
            b"X-Forwarded-Host: " + headers.get(b"host", b""),
        ]
        upstream.write(b"\r\n".join([request_line, *kept]) + b"\r\n\r\n")
        await upstream.drain()
        if b"upgrade" in headers.get(b"connection", b"").lower():
            await _copy(client, upstream)
            return
        if b"chunked" in headers.get(b"transfer-encoding", b"").lower():
            while True:
                line = await client.readuntil(b"\r\n")
                upstream.write(line)
                size = int(line.split(b";", 1)[0], 16)
                if size == 0:
                    while (trailer := await client.readuntil(b"\r\n")) != b"\r\n":
                        upstream.write(trailer)
                    upstream.write(b"\r\n")
                    break
                await _copy(client, upstream, size + 2)
            await upstream.drain()
        elif b"content-length" in headers:
            await _copy(client, upstream, int(headers[b"content-length"]))


async def _serve(client: asyncio.StreamReader, client_writer: asyncio.StreamWriter, upstream_port: int) -> None:
    peer = client_writer.get_extra_info("peername")[0]
    try:
        upstream, upstream_writer = await asyncio.open_connection("127.0.0.1", upstream_port)
    except OSError:
        client_writer.close()
        return
    pumps = [
        asyncio.ensure_future(_requests(client, upstream_writer, peer)),
        asyncio.ensure_future(_copy(upstream, client_writer)),
    ]
    try:
        # Whichever direction ends first, by EOF or error, ends the connection.
        await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for pump in pumps:
            pump.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
        for writer in (upstream_writer, client_writer):
            writer.close()
        for writer in (upstream_writer, client_writer):
            try:
                await writer.wait_closed()
            except (OSError, ssl.SSLError):
                pass


async def _main(args: argparse.Namespace) -> None:
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(args.cert, args.key)
    context.set_alpn_protocols(["http/1.1"])
    server = await asyncio.start_server(
        lambda reader, writer: _serve(reader, writer, args.upstream),
        "127.0.0.1",
        args.port,
        ssl=context,
        limit=HEAD_LIMIT,
    )
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--upstream", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    main()
