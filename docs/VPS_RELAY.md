# Verified VPS relay

Some datacenter addresses are classified by YouTube as automated traffic. In
that topology Soundsible can keep the Station Engine on a VPS while resolving
and transferring YouTube media through a trusted Linux computer on the user's
Tailscale network.

This is an advanced deployment role. It is not a public proxy, a hosted
Soundsible service, or a way to expose a home network to the internet.

## Supported topology

```text
browser -> Station Engine on VPS -> Tailscale -> Soundsible relay on home PC -> YouTube
```

The resolved Googlevideo URL and its bytes always use the same egress. Cached
preview audio stays on the VPS and no longer needs the relay.

Verified v1 requirements:

- Linux and systemd on the relay and Station machines.
- Tailscale connected on both machines.
- The relay is bound only to its Tailscale IPv4.
- The Station's Tailscale IPv4 is the relay's only allowed client.

## Install

On the home PC, from its Soundsible checkout:

```bash
sudo python3 run.py --relay install --station 100.x.y.z
python3 run.py --relay status
```

Replace `100.x.y.z` with the VPS Tailscale IPv4. The installer creates and
enables `soundsible-relay.service`. It waits for `tailscaled.service` and for a
usable tailnet address instead of failing repeatedly during boot.

The installer inspects the machine before it writes anything, so it cannot take
something another project already owns:

- **The port is busy.** It refuses to install and names the process holding it.
  Pass `--port` to pick a free one. A port held by an already-running relay on
  the same port is a reinstall, not a clash, and proceeds normally.
- **`/etc/systemd/system/soundsible-relay.service` already exists and differs**
  — for instance because you edited it by hand. It stops rather than overwrite
  your file; re-run with `--force` once you have reviewed it. An identical unit
  is left alone, so repeat installs are idempotent.

The command prints the value to configure on the VPS:

```bash
SOUNDSIBLE_YT_PROXY=http://100.a.b.c:8888
```

Add it to the Station's systemd environment, make the Station wait for
`tailscaled.service`, then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart soundsible.service
```

Do not put the relay behind a public reverse proxy or open its port in the
internet firewall.

## Verify

Run the verifier on the VPS, where the relay sees the expected Station IP:

```bash
python3 run.py --relay verify --proxy http://100.a.b.c:8888
```

The verifier checks relay health, resolves multiple videos, fetches the first
256 KiB through the same egress, and exercises concurrent streams. A
machine-readable report is available with `--json`; repeat `--video-id` to use
known-good local choices.

Operational targets:

- all valid probes complete;
- resolution p95 at or below 3.5 seconds;
- first 256 KiB after resolution at or below 1 second;
- four concurrent streams without transport failures.

Use the local playback report for real listening data:

```bash
python3 scripts/playback_report.py \
  ~/.local/share/soundsible/users/USER_ID/telemetry/play-timing.jsonl
```

## Security contract

The relay enforces all of these in code:

- Tailscale IPv4 binding and Station allow-list;
- ports 80/443 only;
- YouTube, Googlevideo, ytimg and required Google API host suffixes only;
- no IP-literal destinations;
- no loopback, private, link-local, reserved or multicast DNS answers;
- no logging of signed URLs, cookies or query parameters.

`GET /healthz` is visible only to an allowed Station and returns bounded
operational counters. It contains no credentials.

## Troubleshooting and rollback

Check both ends separately:

```bash
systemctl status soundsible-relay.service
journalctl -u soundsible-relay.service -n 100 --no-pager
tailscale ping 100.x.y.z
python3 run.py --relay verify --proxy http://100.a.b.c:8888
```

If an upgrade fails, restore the previous relay service or remove
`SOUNDSIBLE_YT_PROXY` and restart the Station. Direct datacenter extraction may
remain bot-blocked, but local files and already cached previews continue to
play.
