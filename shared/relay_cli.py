"""CLI for the supported Soundsible residential relay topology."""

from __future__ import annotations

import argparse
import concurrent.futures
import getpass
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
from urllib.request import urlopen

from shared.relay_server import is_tailscale_ipv4, serve, wait_for_tailscale_ipv4

DEFAULT_PROBES = (
    "dQw4w9WgXcQ",
    "9bZkp7q19f0",
    "kJQP7kiw5Fk",
    "fJ9rUzIMcZQ",
    "CevxZvSJLk8",
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 run.py --relay", description="Soundsible VPS relay")
    sub = parser.add_subparsers(dest="command", required=True)

    serve_parser = sub.add_parser("serve", help="Run the restricted relay")
    serve_parser.add_argument("--station", action="append", required=True, help="Allowed Station Tailscale IPv4")
    serve_parser.add_argument("--bind", default="auto", help="Relay Tailscale IPv4, or auto")
    serve_parser.add_argument("--port", type=int, default=8888)
    serve_parser.add_argument("--wait-seconds", type=float, default=120)

    install = sub.add_parser("install", help="Install and start the Linux systemd service")
    install.add_argument("--station", action="append", required=True, help="Allowed Station Tailscale IPv4")
    install.add_argument("--port", type=int, default=8888)
    install.add_argument("--user", help="Linux service user; defaults to the invoking user")
    install.add_argument("--no-start", action="store_true")

    sub.add_parser("status", help="Show systemd status and relay health")

    verify = sub.add_parser("verify", help="Benchmark resolution and Range transfer through a relay")
    verify.add_argument("--proxy", required=True, help="Relay URL, e.g. http://100.x.y.z:8888")
    verify.add_argument("--video-id", action="append", dest="video_ids")
    verify.add_argument("--json", action="store_true")
    verify.add_argument("--concurrency", type=int, default=4)
    return parser


def _unit_text(*, repo_root: Path, user: str, stations: list[str], port: int) -> str:
    station_args = " ".join(f"--station {station}" for station in stations)
    command = (
        f"/usr/bin/python3 -m shared.relay_cli serve {station_args} "
        f"--bind auto --port {port} --wait-seconds 120"
    )
    return f"""[Unit]
Description=Soundsible residential YouTube relay
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service

[Service]
Type=simple
User={user}
WorkingDirectory={repo_root}
ExecStart={command}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
UMask=0077
TasksMax=256

[Install]
WantedBy=multi-user.target
"""


def _install(args: argparse.Namespace) -> int:
    if os.name != "posix" or not Path("/run/systemd/system").exists():
        print("Relay service installation currently supports Linux systemd only.", file=sys.stderr)
        return 2
    if os.geteuid() != 0:
        print("Run relay installation with sudo.", file=sys.stderr)
        return 2
    stations = list(dict.fromkeys(args.station))
    if not all(is_tailscale_ipv4(station) for station in stations):
        print("Every --station value must be a Tailscale IPv4 address.", file=sys.stderr)
        return 2
    if not 1024 <= args.port <= 65535:
        print("Relay port must be between 1024 and 65535.", file=sys.stderr)
        return 2
    user = args.user or os.getenv("SUDO_USER") or getpass.getuser()
    repo_root = Path(__file__).resolve().parents[1]
    unit_path = Path("/etc/systemd/system/soundsible-relay.service")
    unit_path.write_text(
        _unit_text(repo_root=repo_root, user=user, stations=stations, port=args.port),
        encoding="utf-8",
    )
    unit_path.chmod(0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "soundsible-relay.service"], check=True)
    if not args.no_start:
        subprocess.run(["systemctl", "restart", "soundsible-relay.service"], check=True)
    relay_ip = wait_for_tailscale_ipv4(10)
    print(f"Installed soundsible-relay.service")
    print(f"Set on the Station: SOUNDSIBLE_YT_PROXY=http://{relay_ip}:{args.port}")
    return 0


def _status() -> int:
    result = subprocess.run(
        ["systemctl", "show", "soundsible-relay.service", "--property=ActiveState,SubState,NRestarts"],
        text=True,
        capture_output=True,
    )
    print(result.stdout.strip() or result.stderr.strip())
    return 0 if result.returncode == 0 and "ActiveState=active" in result.stdout else 1


def _probe(proxy: str, video_id: str) -> dict:
    try:
        import requests
        import yt_dlp
    except ImportError as exc:
        return {"video_id": video_id, "status": "dependency_error", "error": str(exc)}
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "format": "bestaudio/best",
        "socket_timeout": 15,
        "proxy": proxy,
        "extractor_args": {"youtube": {"player_client": ["default", "android", "ios"]}},
    }
    started = time.monotonic()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        resolved_at = time.monotonic()
        stream_url = info.get("url") if isinstance(info, dict) else None
        if not stream_url:
            raise RuntimeError("no stream URL")
        received = 0
        with requests.get(
            stream_url,
            stream=True,
            headers={"Range": "bytes=0-262143"},
            proxies={"http": proxy, "https": proxy},
            timeout=(5, 20),
        ) as response:
            headers_at = time.monotonic()
            response.raise_for_status()
            for chunk in response.iter_content(65536):
                received += len(chunk)
                if received >= 262144:
                    break
        ended = time.monotonic()
        return {
            "video_id": video_id,
            "status": "ok",
            "resolve_ms": round((resolved_at - started) * 1000),
            "first_headers_ms": round((headers_at - resolved_at) * 1000),
            "first_256k_ms": round((ended - headers_at) * 1000),
            "bytes": received,
        }
    except Exception as exc:
        return {
            "video_id": video_id,
            "status": "failed",
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "error": type(exc).__name__,
        }


def _percentile(values: list[int], ratio: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * ratio))]


def _verify(args: argparse.Namespace) -> int:
    proxy = args.proxy.rstrip("/")
    health_url = f"{proxy}/healthz"
    try:
        with urlopen(health_url, timeout=5) as response:
            health = json.loads(response.read())
    except Exception as exc:
        report = {"status": "failed", "health": {"status": "failed", "error": type(exc).__name__}}
        print(json.dumps(report, indent=2) if args.json else f"Relay health failed: {type(exc).__name__}")
        return 1
    video_ids = list(dict.fromkeys(args.video_ids or DEFAULT_PROBES))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(8, args.concurrency))) as pool:
        probes = list(pool.map(lambda video_id: _probe(proxy, video_id), video_ids))
    good = [probe for probe in probes if probe["status"] == "ok"]
    resolve_p95 = _percentile([row["resolve_ms"] for row in good], 0.95)
    first_256k_p95 = _percentile(
        [row["first_headers_ms"] + row["first_256k_ms"] for row in good],
        0.95,
    )
    aggregate_mbps = round(
        sum((row["bytes"] * 8) / max(1, row["first_headers_ms"] + row["first_256k_ms"]) / 1000 for row in good),
        2,
    )
    gates = {
        "all_probes": len(good) == len(video_ids),
        "resolve_p95_ms": resolve_p95 is not None and resolve_p95 <= 3500,
        "first_256k_p95_ms": first_256k_p95 is not None and first_256k_p95 <= 1000,
        "aggregate_mbps": aggregate_mbps >= 4,
    }
    report = {
        "status": "passed" if all(gates.values()) else "failed",
        "health": health,
        "probes": probes,
        "gates": gates,
        "summary": {
            "successful": len(good),
            "total": len(video_ids),
            "resolve_p50_ms": round(statistics.median([row["resolve_ms"] for row in good])) if good else None,
            "resolve_p95_ms": resolve_p95,
            "first_256k_p95_ms": first_256k_p95,
            "aggregate_mbps": aggregate_mbps,
        },
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        summary = report["summary"]
        print(
            f"Relay {report['status']}: {summary['successful']}/{summary['total']} probes, "
            f"resolve p95={summary['resolve_p95_ms']}ms, first 256KiB p95={summary['first_256k_p95_ms']}ms, "
            f"aggregate={summary['aggregate_mbps']}Mbps"
        )
    return 0 if report["status"] == "passed" else 1


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "serve":
        logging_level = os.getenv("SOUNDSIBLE_RELAY_LOG_LEVEL", "INFO").upper()
        import logging

        logging.basicConfig(level=getattr(logging, logging_level, logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
        try:
            serve(bind=args.bind, port=args.port, stations=args.station, wait_sec=args.wait_seconds)
        except KeyboardInterrupt:
            return 0
        return 0
    if args.command == "install":
        return _install(args)
    if args.command == "status":
        return _status()
    if args.command == "verify":
        return _verify(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
